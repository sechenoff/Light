"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

import { apiFetch } from "../../lib/api";
import { pluralize } from "../../lib/format";
import { toast } from "../ToastProvider";
import {
  addHoursToDatetimeLocal,
  datetimeLocalToISO,
  defaultPickupDatetimeLocal,
  formatRentalDurationDetails,
  pickupFromSearchParam,
  returnFromSearchParam,
} from "../../lib/rentalTime";

import { ClientProjectCard } from "./create/ClientProjectCard";
import { DatesCard } from "./create/DatesCard";
import { EquipmentCard } from "./create/EquipmentCard";
import { TransportCard } from "./create/TransportCard";
import { CommentCard } from "./create/CommentCard";
import { DiscountCard } from "./create/DiscountCard";
import { SummaryPanel } from "./create/SummaryPanel";
import { computeTransportPriceClient } from "./create/transportClientCalc";
import type {
  AvailabilityRow,
  CatalogRowAdjustment,
  CatalogSelectedItem,
  OffCatalogItem,
  GafferReviewApiResponse,
  QuoteResponse,
  ValidationCheck,
  PendingReviewItem,
  VehicleRow,
} from "./create/types";

// ─── BookingDetail type (shape returned by GET /api/bookings/:id) ────────────

export type BookingDetail = {
  id: string;
  displayName?: string;
  status: "DRAFT" | "PENDING_APPROVAL" | "CONFIRMED" | "ISSUED" | "RETURNED" | "CANCELLED";
  rejectionReason?: string | null;
  projectName: string;
  startDate: string;
  endDate: string;
  comment: string | null;
  discountPercent: string | null;
  expectedPaymentDate?: string | null;
  // Transport fields (serialized from Prisma — Decimal → string)
  vehicleId?: string | null;
  vehicleWithGenerator?: boolean;
  vehicleShiftHours?: string | null;
  vehicleSkipOvertime?: boolean;
  vehicleKmOutsideMkad?: number | null;
  vehicleTtkEntry?: boolean;
  client: { id: string; name: string; phone: string | null; email?: string | null };
  items: Array<{
    id: string;
    equipmentId: string;
    quantity: number;
    equipment: {
      id: string;
      name: string;
      category: string;
      brand: string | null;
      model: string | null;
      rentalRatePerShift: string;
    };
  }>;
};

// ─── Props ───────────────────────────────────────────────────────────────────

export type BookingFormProps = {
  mode: "create" | "edit";
  initialBooking?: BookingDetail;
  bookingId?: string;
};

// ─── Helper: ISO → datetime-local string ─────────────────────────────────────

function isoToDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ─── Inner component (uses useSearchParams, must be wrapped in Suspense) ─────

function BookingFormInner({ mode, initialBooking, bookingId }: BookingFormProps) {
  const router = useRouter();
  const sp = useSearchParams();

  const isEdit = mode === "edit";

  // ── Search params (only used in create mode) ──
  const startParam = isEdit ? null : sp.get("start");
  const endParam = isEdit ? null : sp.get("end");

  // ── Client / project ──
  const [clientName, setClientName] = useState(
    isEdit ? (initialBooking?.client.name ?? "") : "",
  );
  const [projectName, setProjectName] = useState(
    isEdit ? (initialBooking?.projectName ?? "") : "",
  );
  const [bookingComment, setBookingComment] = useState(
    isEdit ? (initialBooking?.comment ?? "") : "",
  );
  const [discountPercent, setDiscountPercent] = useState(
    isEdit ? Number(initialBooking?.discountPercent ?? "0") : 50,
  );

  // ── Dates ──
  const [pickupLocal, setPickupLocal] = useState(() => {
    if (isEdit && initialBooking) return isoToDatetimeLocal(initialBooking.startDate);
    return pickupFromSearchParam(startParam, defaultPickupDatetimeLocal());
  });
  const [returnLocal, setReturnLocal] = useState(() => {
    if (isEdit && initialBooking) return isoToDatetimeLocal(initialBooking.endDate);
    return returnFromSearchParam(endParam, pickupFromSearchParam(startParam, defaultPickupDatetimeLocal()));
  });

  const pickupISO = useMemo(() => datetimeLocalToISO(pickupLocal), [pickupLocal]);
  const returnISO = useMemo(() => datetimeLocalToISO(returnLocal), [returnLocal]);

  const rentalDuration = useMemo(() => {
    if (!pickupISO || !returnISO) return null;
    const s = new Date(pickupISO);
    const e = new Date(returnISO);
    if (e.getTime() <= s.getTime()) return null;
    return formatRentalDurationDetails(s, e);
  }, [pickupISO, returnISO]);

  const shifts = rentalDuration?.shifts ?? 1;
  const durationTag = rentalDuration ? `${shifts} ${pluralize(shifts, "день", "дня", "дней")}` : null;
  const durationDetail = rentalDuration?.labelShort ?? null;

  // ── Catalog-first state ──
  const [catalog, setCatalog] = useState<AvailabilityRow[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);

  // Build initial selected map from booking items when editing
  const [selected, setSelected] = useState<Map<string, CatalogSelectedItem>>(() => {
    if (!isEdit || !initialBooking) return new Map();
    const m = new Map<string, CatalogSelectedItem>();
    for (const it of initialBooking.items) {
      m.set(it.equipmentId, {
        equipmentId: it.equipmentId,
        name: it.equipment.name,
        category: it.equipment.category,
        quantity: it.quantity,
        dailyPrice: it.equipment.rentalRatePerShift,
        availableQuantity: 9999, // Will be updated when catalog loads
      });
    }
    return m;
  });
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const [offCatalogItems, setOffCatalogItems] = useState<OffCatalogItem[]>([]);
  const [adjustments, setAdjustments] = useState<Map<string, CatalogRowAdjustment>>(new Map());

  // Search + tabs
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTab, setActiveTab] = useState<string>("all");

  // AI flow (always starts at defaults — no AI state carries over in edit mode)
  const [gafferText, setGafferText] = useState("");
  const [parsing, setParsing] = useState(false);
  const [parsed, setParsed] = useState(false);
  const [parseResolved, setParseResolved] = useState(0);
  const [parseTotal, setParseTotal] = useState(0);
  const [unmatchedFromAi, setUnmatchedFromAi] = useState<string[]>([]);
  const [successBannerDismissed, setSuccessBannerDismissed] = useState(false);

  // Review panel
  const [pendingReview, setPendingReview] = useState<PendingReviewItem[]>([]);

  // Quote
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [loadingQuote, setLoadingQuote] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Transport — initialized from booking when editing
  const [vehicles, setVehicles] = useState<VehicleRow[]>([]);
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(
    isEdit ? (initialBooking?.vehicleId ?? null) : null,
  );
  const [withGenerator, setWithGenerator] = useState(
    isEdit ? (initialBooking?.vehicleWithGenerator ?? false) : false,
  );
  const [shiftHours, setShiftHours] = useState(
    isEdit && initialBooking?.vehicleShiftHours
      ? Math.ceil(Number(initialBooking.vehicleShiftHours))
      : 12,
  );
  // In edit mode: user already set shiftHours — prevent auto-derive from dates overriding them
  const [shiftHoursDirty, setShiftHoursDirty] = useState(isEdit);
  const [skipOvertime, setSkipOvertime] = useState(
    isEdit ? (initialBooking?.vehicleSkipOvertime ?? false) : false,
  );
  const [kmOutsideMkad, setKmOutsideMkad] = useState(
    isEdit ? (initialBooking?.vehicleKmOutsideMkad ?? 0) : 0,
  );
  const [ttkEntry, setTtkEntry] = useState(
    isEdit ? (initialBooking?.vehicleTtkEntry ?? false) : false,
  );

  // ── Vehicles fetch (once on mount) ──
  useEffect(() => {
    let cancelled = false;
    apiFetch<{ vehicles: VehicleRow[] }>("/api/vehicles")
      .then((res) => { if (!cancelled) setVehicles(res.vehicles); })
      .catch(() => { if (!cancelled) setVehicles([]); });
    return () => { cancelled = true; };
  }, []);

  // ── Auto-update shiftHours from rentalDuration if not dirty ──
  useEffect(() => {
    if (!shiftHoursDirty && rentalDuration) {
      const hours = Math.ceil(rentalDuration.totalHours);
      setShiftHours(Math.max(1, hours));
    }
  }, [rentalDuration, shiftHoursDirty]);

  // ── Catalog fetch (on dates change) ──
  useEffect(() => {
    if (!pickupISO || !returnISO) return;
    let cancelled = false;
    setCatalogLoading(true);
    const params = new URLSearchParams({ start: pickupISO, end: returnISO });
    // In edit mode, exclude current booking from availability calculation
    if (isEdit && bookingId) params.set("excludeBookingId", bookingId);
    apiFetch<{ rows: AvailabilityRow[] }>(`/api/availability?${params}`)
      .then((res) => {
        if (cancelled) return;
        setCatalog(res.rows);
        const newAdj = new Map<string, CatalogRowAdjustment>();
        const newSelectedEntries: Array<[string, CatalogSelectedItem]> = [];
        const toDelete: string[] = [];
        for (const [id, sel] of selectedRef.current) {
          const latest = res.rows.find((r) => r.equipmentId === id);
          if (!latest) {
            toDelete.push(id);
            continue;
          }
          const newAvail = Math.max(0, latest.availableQuantity);
          if (newAvail === 0) {
            newSelectedEntries.push([id, { ...sel, availableQuantity: 0, dailyPrice: latest.rentalRatePerShift }]);
            newAdj.set(id, { kind: "unavailable" });
          } else if (newAvail < sel.quantity) {
            newSelectedEntries.push([id, { ...sel, quantity: newAvail, availableQuantity: newAvail, dailyPrice: latest.rentalRatePerShift }]);
            newAdj.set(id, { kind: "clampedDown", previousQty: sel.quantity, newQty: newAvail });
          } else {
            newSelectedEntries.push([id, { ...sel, availableQuantity: newAvail, dailyPrice: latest.rentalRatePerShift }]);
          }
        }
        setSelected((prev) => {
          const next = new Map(prev);
          for (const id of toDelete) next.delete(id);
          for (const [id, v] of newSelectedEntries) next.set(id, v);
          return next;
        });
        setAdjustments(newAdj);
      })
      .catch(() => {
        if (!cancelled) setCatalog([]);
      })
      .finally(() => {
        if (!cancelled) setCatalogLoading(false);
      });
    return () => { cancelled = true; };
  }, [pickupISO, returnISO, isEdit, bookingId]);

  // ── Derived ──
  const apiItems = useMemo(
    () => Array.from(selected.values()).map((s) => ({ equipmentId: s.equipmentId, quantity: s.quantity })),
    [selected],
  );

  const localSubtotal = useMemo(() => {
    let sum = 0;
    for (const s of selected.values()) sum += Number(s.dailyPrice) * s.quantity * shifts;
    return sum;
  }, [selected, shifts]);

  const clampedDiscount = Math.max(0, Math.min(100, discountPercent || 0));
  const localDiscount = (localSubtotal * clampedDiscount) / 100;
  const localTotal = localSubtotal - localDiscount;

  const checks = useMemo<ValidationCheck[]>(() => {
    const list: ValidationCheck[] = [];
    if (selected.size > 0 && offCatalogItems.length === 0 && unmatchedFromAi.length === 0) {
      list.push({ type: "ok", label: "Все позиции распознаны", detail: "" });
    }
    if (unmatchedFromAi.length > 0) {
      list.push({ type: "warn", label: `${unmatchedFromAi.length} не распознано`, detail: "добавьте вручную или проигнорируйте" });
    }
    if (offCatalogItems.length > 0) {
      list.push({ type: "tip", label: `${offCatalogItems.length} вне каталога`, detail: "позиции сохранятся с ручным описанием" });
    }
    return list;
  }, [selected, offCatalogItems, unmatchedFromAi]);

  const canSubmit = Boolean(
    clientName.trim() && (selected.size > 0 || offCatalogItems.length > 0) && pickupISO && returnISO && !submitting,
  );

  const transportPayload = useMemo(() => {
    if (!selectedVehicleId) return null;
    return {
      vehicleId: selectedVehicleId,
      withGenerator,
      shiftHours,
      skipOvertime,
      kmOutsideMkad,
      ttkEntry,
    };
  }, [selectedVehicleId, withGenerator, shiftHours, skipOvertime, kmOutsideMkad, ttkEntry]);

  const localTransport = useMemo(() => {
    if (!selectedVehicleId) return null;
    const vehicle = vehicles.find((v) => v.id === selectedVehicleId);
    if (!vehicle) return null;
    return computeTransportPriceClient({
      vehicle,
      withGenerator,
      shiftHours,
      skipOvertime,
      kmOutsideMkad,
      ttkEntry,
    });
  }, [selectedVehicleId, vehicles, withGenerator, shiftHours, skipOvertime, kmOutsideMkad, ttkEntry]);

  // ── Debounced quote ──
  useEffect(() => {
    const hasSomething = apiItems.length > 0 || transportPayload !== null;
    if (!clientName.trim() || !hasSomething || !pickupISO || !returnISO) {
      setQuote(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoadingQuote(true);
      try {
        const body = {
          client: { name: clientName.trim() },
          projectName: projectName.trim() || "Проект",
          startDate: pickupISO,
          endDate: returnISO,
          discountPercent: discountPercent || 0,
          items: apiItems,
          transport: transportPayload,
        };
        const data = await apiFetch<QuoteResponse>("/api/bookings/quote", { method: "POST", body: JSON.stringify(body) });
        if (!cancelled) setQuote(data);
      } catch {
        if (!cancelled) setQuote(null);
      } finally {
        if (!cancelled) setLoadingQuote(false);
      }
    }, 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [clientName, projectName, pickupISO, returnISO, discountPercent, apiItems, transportPayload]);

  // ── Date handlers ──
  function handlePickupChange(v: string) {
    setPickupLocal(v);
    setReturnLocal((prev) => {
      const pu = new Date(v);
      const re = new Date(prev);
      if (Number.isNaN(pu.getTime())) return prev;
      if (re.getTime() <= pu.getTime()) return addHoursToDatetimeLocal(v, 24);
      return prev;
    });
  }

  function handleReturnChange(v: string) {
    setReturnLocal(v);
  }

  // ── Catalog selection handlers ──
  function handleAdd(row: AvailabilityRow) {
    if (row.availableQuantity <= 0) return;
    setSelected((prev) => {
      const next = new Map(prev);
      const existing = next.get(row.equipmentId);
      if (existing) {
        if (existing.quantity >= existing.availableQuantity) return prev;
        next.set(row.equipmentId, { ...existing, quantity: existing.quantity + 1 });
      } else {
        next.set(row.equipmentId, {
          equipmentId: row.equipmentId,
          name: row.name,
          category: row.category,
          quantity: 1,
          dailyPrice: row.rentalRatePerShift,
          availableQuantity: row.availableQuantity,
        });
      }
      return next;
    });
  }

  function clearAdjustment(equipmentId: string) {
    setAdjustments((prev) => {
      if (!prev.has(equipmentId)) return prev;
      const next = new Map(prev);
      next.delete(equipmentId);
      return next;
    });
  }

  function handleChangeQty(equipmentId: string, newQty: number) {
    clearAdjustment(equipmentId);
    setSelected((prev) => {
      const next = new Map(prev);
      const existing = next.get(equipmentId);
      if (!existing) return prev;
      const clamped = Math.max(0, Math.min(newQty, existing.availableQuantity));
      if (clamped === 0) {
        next.delete(equipmentId);
      } else {
        next.set(equipmentId, { ...existing, quantity: clamped });
      }
      return next;
    });
  }

  function handleRemove(equipmentId: string) {
    clearAdjustment(equipmentId);
    setSelected((prev) => {
      const next = new Map(prev);
      next.delete(equipmentId);
      return next;
    });
  }

  function handleChangeOffCatalogQty(tempId: string, newQty: number) {
    setOffCatalogItems((prev) =>
      prev.map((it) => (it.tempId === tempId ? { ...it, quantity: Math.max(1, newQty) } : it)),
    );
  }

  function handleRemoveOffCatalog(tempId: string) {
    setOffCatalogItems((prev) => prev.filter((it) => it.tempId !== tempId));
  }

  // ── AI handlers ──
  async function handleParse() {
    if (!pickupISO || !returnISO) return;
    setParsing(true);
    try {
      const res = await apiFetch<GafferReviewApiResponse>("/api/bookings/parse-gaffer-review", {
        method: "POST",
        body: JSON.stringify({ requestText: gafferText.trim(), startDate: pickupISO, endDate: returnISO }),
      });
      const reviewItems: PendingReviewItem[] = res.items.map((it) => ({
        reviewId: it.id,
        gafferPhrase: it.gafferPhrase,
        interpretedName: it.interpretedName,
        quantity: it.quantity,
        match: it.match,
      }));
      setPendingReview(reviewItems);
      setGafferText("");
      setSearchQuery("");
      setParsed(false);
      setParseResolved(0);
      setParseTotal(0);
      setUnmatchedFromAi([]);
      setSuccessBannerDismissed(true);
    } catch (err: unknown) {
      toast.error((err as { message?: string })?.message ?? "Ошибка AI");
    } finally {
      setParsing(false);
    }
  }

  function handleClear() {
    setGafferText("");
    setSearchQuery("");
    setParsed(false);
    setUnmatchedFromAi([]);
    setParseResolved(0);
    setParseTotal(0);
    setSuccessBannerDismissed(false);
  }

  function handleDismissSuccess() { setSuccessBannerDismissed(true); }
  function handleIgnoreUnmatched() { setUnmatchedFromAi([]); }

  function handleAddOffCatalog(phrase: string) {
    const tempId = `off-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setOffCatalogItems((prev) => [...prev, { tempId, name: phrase, quantity: 1 }]);
    setUnmatchedFromAi((prev) => prev.filter((p) => p !== phrase));
  }

  // ── Review panel handlers ──
  function handleReviewConfirm(
    reviewId: string,
    equipment: {
      equipmentId: string;
      name: string;
      category: string;
      rentalRatePerShift: string;
      availableQuantity: number;
    },
    quantity: number,
  ) {
    const item = pendingReview.find((p) => p.reviewId === reviewId);
    if (!item) return;
    setSelected((prev) => {
      const next = new Map(prev);
      const clamped = Math.max(1, Math.min(quantity, equipment.availableQuantity));
      next.set(equipment.equipmentId, {
        equipmentId: equipment.equipmentId,
        name: equipment.name,
        category: equipment.category,
        quantity: clamped,
        dailyPrice: equipment.rentalRatePerShift,
        availableQuantity: equipment.availableQuantity,
      });
      return next;
    });
    apiFetch("/api/admin/slang-learning/propose", {
      method: "POST",
      body: JSON.stringify({
        rawPhrase: item.gafferPhrase || item.interpretedName,
        proposedEquipmentId: equipment.equipmentId,
        proposedEquipmentName: equipment.name,
        confidence: 0.95,
        contextJson: JSON.stringify({ source: "booking_review", reviewId }),
      }),
    }).catch(() => { /* non-blocking */ });
    setPendingReview((prev) => prev.filter((p) => p.reviewId !== reviewId));
  }

  function handleReviewOffCatalog(reviewId: string) {
    const item = pendingReview.find((p) => p.reviewId === reviewId);
    if (!item) return;
    const tempId = `off-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setOffCatalogItems((prev) => [...prev, { tempId, name: item.interpretedName || item.gafferPhrase, quantity: item.quantity }]);
    setPendingReview((prev) => prev.filter((p) => p.reviewId !== reviewId));
  }

  function handleReviewSkip(reviewId: string) {
    setPendingReview((prev) => prev.filter((p) => p.reviewId !== reviewId));
  }

  function handleReviewSkipAll() { setPendingReview([]); }

  // ── Save / submit (mode-aware) ──

  // Create mode: save as draft (returns new booking id)
  async function saveDraft(): Promise<string | null> {
    setSubmitting(true);
    try {
      const offCatalogSuffix =
        offCatalogItems.length > 0
          ? "\n\nВне каталога:\n" + offCatalogItems.map((o) => `— ${o.name} × ${o.quantity}`).join("\n")
          : "";
      const finalComment = (bookingComment.trim() + offCatalogSuffix).trim() || undefined;
      const body = {
        client: { name: clientName.trim() },
        projectName: projectName.trim() || "Проект",
        startDate: pickupISO,
        endDate: returnISO,
        discountPercent: discountPercent || 0,
        comment: finalComment,
        items: apiItems,
        transport: transportPayload,
      };
      const res = await apiFetch<{ booking: { id: string } }>("/api/bookings/draft", { method: "POST", body: JSON.stringify(body) });
      toast.success("Черновик сохранён");
      return res.booking.id;
    } catch (err: unknown) {
      toast.error((err as { message?: string })?.message ?? "Ошибка сохранения");
      return null;
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSaveDraftClick() {
    const id = await saveDraft();
    if (id) router.push(`/bookings/${id}`);
  }

  async function handleSubmitForApproval() {
    const id = await saveDraft();
    if (!id) return;
    try {
      await apiFetch(`/api/bookings/${id}/submit-for-approval`, { method: "POST" });
      toast.success("Отправлено на согласование");
      router.push(`/bookings/${id}`);
    } catch (err: unknown) {
      toast.error((err as { message?: string })?.message ?? "Ошибка отправки");
    }
  }

  // Edit mode: PATCH existing booking
  async function handleSaveEdit() {
    if (!bookingId || !pickupISO || !returnISO) return;
    setSubmitting(true);
    try {
      const offCatalogSuffix =
        offCatalogItems.length > 0
          ? "\n\nВне каталога:\n" + offCatalogItems.map((o) => `— ${o.name} × ${o.quantity}`).join("\n")
          : "";
      const finalComment = (bookingComment.trim() + offCatalogSuffix).trim() || null;
      const body = {
        client: { name: clientName.trim() },
        projectName: projectName.trim() || "Проект",
        startDate: pickupISO,
        endDate: returnISO,
        discountPercent: clampedDiscount,
        comment: finalComment,
        items: apiItems,
        transport: transportPayload,
      };
      await apiFetch(`/api/bookings/${bookingId}`, { method: "PATCH", body: JSON.stringify(body) });
      toast.success("Изменения сохранены");
      router.push(`/bookings/${bookingId}`);
    } catch (err: unknown) {
      toast.error((err as { message?: string })?.message ?? "Не удалось сохранить изменения");
    } finally {
      setSubmitting(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const breadcrumb = isEdit ? (
    <>
      <Link href={`/bookings/${bookingId}`} className="text-accent-bright hover:underline">
        ← Бронь #{bookingId?.slice(-6)}
      </Link>
      <span className="text-ink-3">/ Редактирование</span>
    </>
  ) : (
    <>
      <Link href="/bookings" className="text-accent-bright hover:underline">← Брони</Link>
      <span className="text-ink-3">/ Новая бронь</span>
      <span className="rounded-full border border-border bg-surface-muted px-2 py-0.5 text-[10px] text-ink-3">Черновик</span>
    </>
  );

  const headerTitle = isEdit
    ? `Редактирование брони${initialBooking?.client.name ? ` — ${initialBooking.client.name}` : ""}`
    : "Новая бронь";

  return (
    <div>
      <header className="sticky top-0 z-20 flex items-center justify-between border-b border-border bg-surface px-8 py-3 shadow-xs">
        <div className="flex items-center gap-3 text-[13px]">
          {breadcrumb}
        </div>
        {isEdit && (
          <div className="text-sm font-medium text-ink">{headerTitle}</div>
        )}
      </header>

      <div className="mx-auto grid max-w-[1280px] grid-cols-[minmax(0,1fr)_320px] items-start gap-5 px-8 py-7">
        {/* Left column: Client, Dates, Equipment, Comment */}
        <div className="flex flex-col gap-3.5">
          <ClientProjectCard
            clientName={clientName}
            projectName={projectName}
            onClientNameChange={setClientName}
            onProjectNameChange={setProjectName}
            clientReadOnly={isEdit}
          />
          <DatesCard
            pickupLocal={pickupLocal}
            returnLocal={returnLocal}
            onPickupChange={handlePickupChange}
            onReturnChange={handleReturnChange}
            durationTag={durationTag}
            durationDetail={durationDetail}
          />

          <EquipmentCard
            catalog={catalog}
            catalogLoading={catalogLoading}
            selected={selected}
            offCatalogItems={offCatalogItems}
            adjustments={adjustments}
            gafferText={gafferText}
            onGafferTextChange={setGafferText}
            parsing={parsing}
            parsed={parsed}
            parseResolved={parseResolved}
            parseTotal={parseTotal}
            unmatchedFromAi={unmatchedFromAi}
            successBannerDismissed={successBannerDismissed}
            onParse={handleParse}
            onClear={handleClear}
            onDismissSuccess={handleDismissSuccess}
            onIgnoreUnmatched={handleIgnoreUnmatched}
            onAddOffCatalog={handleAddOffCatalog}
            onAdd={handleAdd}
            onChangeQty={handleChangeQty}
            onRemove={handleRemove}
            onChangeOffCatalogQty={handleChangeOffCatalogQty}
            onRemoveOffCatalog={handleRemoveOffCatalog}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            activeTab={activeTab}
            onActiveTabChange={setActiveTab}
            shifts={shifts}
            pendingReview={pendingReview}
            pickupISO={pickupISO ?? ""}
            returnISO={returnISO ?? ""}
            onReviewConfirm={handleReviewConfirm}
            onReviewOffCatalog={handleReviewOffCatalog}
            onReviewSkip={handleReviewSkip}
            onReviewSkipAll={handleReviewSkipAll}
          />

          <CommentCard value={bookingComment} onChange={setBookingComment} />
        </div>

        {/* Right column: Discount, Summary, Transport */}
        <div className="sticky top-20 flex max-h-[calc(100vh-6rem)] flex-col gap-3.5 self-start overflow-y-auto pr-1">
          <DiscountCard value={discountPercent} onChange={setDiscountPercent} />
          <SummaryPanel
            quote={quote}
            localSubtotal={localSubtotal}
            localDiscount={localDiscount}
            localTotal={localTotal}
            discountPercent={discountPercent}
            itemCount={selected.size + offCatalogItems.length}
            shifts={shifts}
            isLoadingQuote={loadingQuote}
            checks={checks}
            onSubmitForApproval={isEdit ? undefined : handleSubmitForApproval}
            onSaveDraft={isEdit ? undefined : handleSaveDraftClick}
            onSaveEdit={isEdit ? handleSaveEdit : undefined}
            canSubmit={canSubmit}
            selectedItems={selected}
            offCatalogItems={offCatalogItems}
            selectedVehicleName={selectedVehicleId ? (vehicles.find(v => v.id === selectedVehicleId)?.name ?? null) : null}
            localTransport={localTransport}
            onRemoveItem={handleRemove}
            onRemoveOffCatalog={handleRemoveOffCatalog}
            mode={mode}
            submitting={submitting}
            cancelHref={isEdit ? `/bookings/${bookingId}` : undefined}
          />
          <TransportCard
            vehicles={vehicles}
            selectedVehicleId={selectedVehicleId}
            onChangeVehicle={setSelectedVehicleId}
            withGenerator={withGenerator}
            onChangeGenerator={setWithGenerator}
            shiftHours={shiftHours}
            onChangeShiftHours={(h) => { setShiftHours(h); setShiftHoursDirty(true); }}
            skipOvertime={skipOvertime}
            onChangeSkipOvertime={setSkipOvertime}
            kmOutsideMkad={kmOutsideMkad}
            onChangeKm={setKmOutsideMkad}
            ttkEntry={ttkEntry}
            onChangeTtk={setTtkEntry}
            breakdown={quote?.transport ?? localTransport}
          />
        </div>
      </div>
    </div>
  );
}

// ─── Public export (wraps inner in Suspense for useSearchParams) ──────────────

export function BookingForm(props: BookingFormProps): JSX.Element {
  return (
    <Suspense fallback={<div className="p-8 text-center text-ink-3">Загрузка…</div>}>
      <BookingFormInner {...props} />
    </Suspense>
  );
}
