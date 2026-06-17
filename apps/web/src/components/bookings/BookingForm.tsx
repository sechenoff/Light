"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

import { apiFetch } from "../../lib/api";
import { pluralize } from "../../lib/format";
import { toMoscowDateString, addDays } from "../../lib/moscowDate";
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
import { computeTransportListClient } from "./create/transportClientCalc";
import { AddCustomItemModal } from "./create/AddCustomItemModal";
import type {
  AvailabilityRow,
  CatalogRowAdjustment,
  CatalogSelectedItem,
  CustomItem,
  OffCatalogItem,
  GafferReviewApiResponse,
  QuoteResponse,
  ValidationCheck,
  PendingReviewItem,
  VehicleRow,
  SelectedVehicle,
  TransportBreakdown,
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
  skipPartialDay?: boolean;
  expectedPaymentDate?: string | null;
  // Transport — multi-vehicle. New bookings use `vehicles[]`; legacy single
  // columns kept for back-compat with old bookings created pre-multi-vehicle.
  vehicles?: Array<{
    vehicleId: string;
    vehicle?: { id: string; name: string; slug: string } | null;
    withGenerator: boolean;
    shiftHours: string | null;
    skipOvertime: boolean;
    kmOutsideMkad: number | null;
    ttkEntry: boolean;
    subtotalRub: string | null;
  }>;
  vehicleId?: string | null;
  vehicleWithGenerator?: boolean;
  vehicleShiftHours?: string | null;
  vehicleSkipOvertime?: boolean;
  vehicleKmOutsideMkad?: number | null;
  vehicleTtkEntry?: boolean;
  client: { id: string; name: string; phone: string | null; email?: string | null };
  items: Array<{
    id: string;
    equipmentId: string | null;
    quantity: number;
    customName: string | null;
    customUnitPrice: string | null;
    customCategory: string | null;
    equipment: {
      id: string;
      name: string;
      category: string;
      brand: string | null;
      model: string | null;
      rentalRatePerShift: string;
    } | null;
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
  // «Не считать вторые сутки» — прощать хвост ≤ 4 ч сверх целых суток.
  const [skipPartialDay, setSkipPartialDay] = useState<boolean>(
    isEdit && initialBooking ? Boolean(initialBooking.skipPartialDay) : false,
  );
  // Отслеживаем смену именно этого флага, чтобы пересчитать смету мгновенно
  // (без debounce) при клике по чекбоксу.
  const prevSkipPartialRef = useRef(skipPartialDay);
  // Возврат тронут вручную → не перетираем авто-+24ч на смене выдачи.
  // create: старт false (первый выбор выдачи ставит +24ч; если возврат уже
  // введён вручную и валиден — сохраняется, иначе чинится +24ч). edit: старт
  // true (сохранённый возврат брони не трогаем при правке выдачи).
  const returnTouchedRef = useRef(isEdit);

  const pickupISO = useMemo(() => datetimeLocalToISO(pickupLocal), [pickupLocal]);
  const returnISO = useMemo(() => datetimeLocalToISO(returnLocal), [returnLocal]);

  const rentalDuration = useMemo(() => {
    if (!pickupISO || !returnISO) return null;
    const s = new Date(pickupISO);
    const e = new Date(returnISO);
    if (e.getTime() <= s.getTime()) return null;
    return formatRentalDurationDetails(s, e, skipPartialDay);
  }, [pickupISO, returnISO, skipPartialDay]);

  const shifts = rentalDuration?.shifts ?? 1;
  const durationTag = rentalDuration ? `${shifts} ${pluralize(shifts, "день", "дня", "дней")}` : null;
  const durationDetail = rentalDuration?.labelShort ?? null;

  // ── Catalog-first state ──
  const [catalog, setCatalog] = useState<AvailabilityRow[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);

  // Build initial selected map from booking items when editing (catalog items only)
  const [selected, setSelected] = useState<Map<string, CatalogSelectedItem>>(() => {
    if (!isEdit || !initialBooking) return new Map();
    const m = new Map<string, CatalogSelectedItem>();
    for (const it of initialBooking.items) {
      if (it.equipmentId == null) continue; // skip custom items
      if (!it.equipment) continue;
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

  // Custom (non-catalog) items — initialized from booking items without equipmentId
  const [customItems, setCustomItems] = useState<CustomItem[]>(() => {
    if (!isEdit || !initialBooking) return [];
    return initialBooking.items
      .filter((it) => it.equipmentId == null)
      .map((it) => ({
        tempId: `custom-${it.id}`,
        name: it.customName ?? "",
        unitPrice: Number(it.customUnitPrice ?? 0),
        quantity: it.quantity,
      }));
  });
  const [customModalOpen, setCustomModalOpen] = useState(false);

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

  // Transport — multi-vehicle. Init from initialBooking.vehicles[] if present,
  // else from legacy single vehicle* columns (back-compat with old bookings).
  const [vehicles, setVehicles] = useState<VehicleRow[]>([]);
  const [selectedVehicles, setSelectedVehicles] = useState<SelectedVehicle[]>(() => {
    if (!isEdit || !initialBooking) return [];
    if (initialBooking.vehicles && initialBooking.vehicles.length > 0) {
      return initialBooking.vehicles.map((v) => ({
        vehicleId: v.vehicleId,
        withGenerator: v.withGenerator,
        shiftHours: v.shiftHours ? Math.ceil(Number(v.shiftHours)) : 12,
        skipOvertime: v.skipOvertime,
        kmOutsideMkad: v.kmOutsideMkad ?? 0,
        ttkEntry: v.ttkEntry,
      }));
    }
    if (initialBooking.vehicleId) {
      return [
        {
          vehicleId: initialBooking.vehicleId,
          withGenerator: initialBooking.vehicleWithGenerator ?? false,
          shiftHours: initialBooking.vehicleShiftHours
            ? Math.ceil(Number(initialBooking.vehicleShiftHours))
            : 12,
          skipOvertime: initialBooking.vehicleSkipOvertime ?? false,
          kmOutsideMkad: initialBooking.vehicleKmOutsideMkad ?? 0,
          ttkEntry: initialBooking.vehicleTtkEntry ?? false,
        },
      ];
    }
    return [];
  });
  // Vehicles whose shiftHours the user manually set — excluded from
  // auto-derive-from-dates. In edit mode, all initial vehicles are "dirty".
  const shiftHoursDirtyRef = useRef<Set<string>>(
    new Set(isEdit ? selectedVehicles.map((s) => s.vehicleId) : []),
  );

  // ── expectedPaymentDate — пользовательское значение (опционально) ──
  // Пустая строка = использовать default из настроек организации
  const [expectedPaymentDateLocal, setExpectedPaymentDateLocal] = useState<string>(() => {
    if (isEdit && initialBooking?.expectedPaymentDate) {
      // F1: use toMoscowDateString to avoid 1-day backward drift on edit-save cycles
      return toMoscowDateString(new Date(initialBooking.expectedPaymentDate));
    }
    return "";
  });

  // F3: fetch org settings for dynamic placeholder
  const [defaultPaymentTermsDays, setDefaultPaymentTermsDays] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiFetch<{ defaultPaymentTermsDays?: number }>("/api/settings/organization")
      .then((res) => { if (!cancelled) setDefaultPaymentTermsDays(res.defaultPaymentTermsDays ?? 0); })
      .catch(() => { if (!cancelled) setDefaultPaymentTermsDays(0); });
    return () => { cancelled = true; };
  }, []);

  // ── Vehicles fetch (once on mount) ──
  useEffect(() => {
    let cancelled = false;
    apiFetch<{ vehicles: VehicleRow[] }>("/api/vehicles")
      .then((res) => { if (!cancelled) setVehicles(res.vehicles); })
      .catch(() => { if (!cancelled) setVehicles([]); });
    return () => { cancelled = true; };
  }, []);

  // ── Auto-update each non-dirty vehicle's shiftHours from rentalDuration ──
  useEffect(() => {
    if (!rentalDuration) return;
    const hours = Math.max(1, Math.ceil(rentalDuration.totalHours));
    setSelectedVehicles((prev) => {
      let changed = false;
      const next = prev.map((s) => {
        if (shiftHoursDirtyRef.current.has(s.vehicleId)) return s;
        if (s.shiftHours === hours) return s;
        changed = true;
        return { ...s, shiftHours: hours };
      });
      return changed ? next : prev;
    });
  }, [rentalDuration]);

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
    for (const c of customItems) sum += c.unitPrice * c.quantity;
    return sum;
  }, [selected, shifts, customItems]);

  const clampedDiscount = Math.max(0, Math.min(100, discountPercent || 0));
  const localDiscount = (localSubtotal * clampedDiscount) / 100;
  const localTotal = localSubtotal - localDiscount;

  const checks = useMemo<ValidationCheck[]>(() => {
    const list: ValidationCheck[] = [];
    if (selected.size > 0 && offCatalogItems.length === 0 && customItems.length === 0 && unmatchedFromAi.length === 0) {
      list.push({ type: "ok", label: "Все позиции распознаны", detail: "" });
    }
    if (unmatchedFromAi.length > 0) {
      list.push({ type: "warn", label: `${unmatchedFromAi.length} не распознано`, detail: "добавьте вручную или проигнорируйте" });
    }
    if (offCatalogItems.length > 0) {
      list.push({ type: "tip", label: `${offCatalogItems.length} вне каталога`, detail: "позиции сохранятся с ручным описанием" });
    }
    if (customItems.length > 0) {
      list.push({ type: "tip", label: `${customItems.length} ${pluralize(customItems.length, "произвольная позиция", "произвольные позиции", "произвольных позиций")}`, detail: "услуги, расходники, субаренда" });
    }
    return list;
  }, [selected, offCatalogItems, customItems, unmatchedFromAi]);

  const canSubmit = Boolean(
    clientName.trim() && (selected.size > 0 || offCatalogItems.length > 0 || customItems.length > 0) && pickupISO && returnISO && !submitting,
  );

  // Default shiftHours for a newly-toggled vehicle = current rental duration.
  const defaultShiftHours = rentalDuration
    ? Math.max(1, Math.ceil(rentalDuration.totalHours))
    : 12;

  function handleToggleVehicle(vehicleId: string, checked: boolean) {
    setSelectedVehicles((prev) => {
      if (checked) {
        if (prev.some((s) => s.vehicleId === vehicleId)) return prev;
        return [
          ...prev,
          {
            vehicleId,
            withGenerator: false,
            shiftHours: defaultShiftHours,
            skipOvertime: false,
            kmOutsideMkad: 0,
            ttkEntry: false,
          },
        ];
      }
      shiftHoursDirtyRef.current.delete(vehicleId);
      return prev.filter((s) => s.vehicleId !== vehicleId);
    });
  }

  function handlePatchVehicle(vehicleId: string, patch: Partial<SelectedVehicle>) {
    if (patch.shiftHours !== undefined) shiftHoursDirtyRef.current.add(vehicleId);
    setSelectedVehicles((prev) =>
      prev.map((s) => (s.vehicleId === vehicleId ? { ...s, ...patch } : s)),
    );
  }

  // Stable key so the quote effect only refires when transport actually changes.
  const transportKey = useMemo(
    () => JSON.stringify(selectedVehicles),
    [selectedVehicles],
  );

  // Payload for quote/draft/export: array of per-vehicle configs, or null.
  const transportPayload = useMemo<SelectedVehicle[] | null>(
    () => (selectedVehicles.length > 0 ? selectedVehicles : null),
    // transportKey captures deep changes; selectedVehicles ref is enough here
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [transportKey],
  );

  // Local per-vehicle breakdowns + subtotal (instant feedback before quote).
  const localTransport = useMemo(() => {
    if (selectedVehicles.length === 0) return null;
    return computeTransportListClient(selectedVehicles, vehicles);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transportKey, vehicles]);

  // breakdownByVehicleId: prefer server quote, fall back to local calc.
  const breakdownByVehicleId = useMemo<Record<string, TransportBreakdown>>(() => {
    const map: Record<string, TransportBreakdown> = {};
    const source = quote?.transport ?? localTransport?.breakdowns ?? [];
    for (const b of source) map[b.vehicleId] = b;
    return map;
  }, [quote, localTransport]);

  // ── Debounced quote ──
  useEffect(() => {
    const hasSomething = apiItems.length > 0 || customItems.length > 0 || transportPayload !== null;
    if (!clientName.trim() || !hasSomething || !pickupISO || !returnISO) {
      setQuote(null);
      return;
    }
    let cancelled = false;
    // Тоггл чекбокса «не считать вторые сутки» — дискретное действие:
    // пересчитываем смету мгновенно (без debounce). Печать (скидка, qty
    // и т.п.) по-прежнему debounce 500 мс, чтобы не спамить /quote.
    const skipChanged = prevSkipPartialRef.current !== skipPartialDay;
    prevSkipPartialRef.current = skipPartialDay;
    const debounceMs = skipChanged ? 0 : 500;
    const timer = setTimeout(async () => {
      setLoadingQuote(true);
      try {
        const items = [
          ...apiItems,
          ...customItems.map((c) => ({
            customName: c.name,
            customUnitPrice: c.unitPrice,
            quantity: c.quantity,
          })),
        ];
        const body = {
          client: { name: clientName.trim() },
          projectName: projectName.trim() || "Проект",
          startDate: pickupISO,
          endDate: returnISO,
          discountPercent: discountPercent || 0,
          skipPartialDay,
          items,
          transport: transportPayload,
        };
        const data = await apiFetch<QuoteResponse>("/api/bookings/quote", { method: "POST", body: JSON.stringify(body) });
        if (!cancelled) setQuote(data);
      } catch {
        if (!cancelled) setQuote(null);
      } finally {
        if (!cancelled) setLoadingQuote(false);
      }
    }, debounceMs);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [clientName, projectName, pickupISO, returnISO, discountPercent, skipPartialDay, apiItems, customItems, transportPayload]);

  // ── Date handlers ──
  function handlePickupChange(v: string) {
    setPickupLocal(v);
    setReturnLocal((prev) => {
      const pu = new Date(v);
      if (Number.isNaN(pu.getTime())) return prev;
      // По умолчанию бронь 24-часовая: возврат = выдача + 24 ч.
      // Если пользователь уже правил возврат вручную — не перетираем,
      // но всё равно не даём возврату оказаться раньше выдачи.
      if (!returnTouchedRef.current) return addHoursToDatetimeLocal(v, 24);
      const re = new Date(prev);
      if (Number.isNaN(re.getTime()) || re.getTime() <= pu.getTime()) {
        return addHoursToDatetimeLocal(v, 24);
      }
      return prev;
    });
  }

  function handleReturnChange(v: string) {
    returnTouchedRef.current = true;
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

  // ── Custom item handlers ──
  function handleAddCustom(payload: { name: string; unitPrice: number; quantity: number }) {
    const tempId = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setCustomItems((prev) => [...prev, { tempId, ...payload }]);
  }

  function handleChangeCustomQty(tempId: string, qty: number) {
    setCustomItems((prev) =>
      prev.map((it) => (it.tempId === tempId ? { ...it, quantity: Math.max(1, qty) } : it)),
    );
  }

  function handleRemoveCustom(tempId: string) {
    setCustomItems((prev) => prev.filter((it) => it.tempId !== tempId));
  }

  // ── AI handlers ──
  async function handleParse() {
    // Без дат AI-парсинг не запускаем — startDate/endDate нужны для расчёта
    // числа смен и матчинга по доступности. Раньше тут был silent return,
    // и пользователь жал «Распознать» без эффекта, думая что AI сломан.
    // Теперь показываем понятный toast + скроллим к полю дат.
    if (!pickupISO || !returnISO) {
      toast.error("Сначала укажите даты съёмки — выдача и возврат");
      if (typeof document !== "undefined") {
        const el =
          document.getElementById("booking-pickup-datetime") ||
          document.querySelector('input[type="datetime-local"]');
        if (el) {
          (el as HTMLElement).scrollIntoView({ behavior: "smooth", block: "center" });
          (el as HTMLInputElement).focus?.();
        }
      }
      return;
    }
    if (!gafferText.trim()) {
      toast.error("Поле заявки пустое — вставьте текст от гафера");
      return;
    }
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
      const items = [
        ...apiItems,
        ...customItems.map((c) => ({
          customName: c.name,
          customUnitPrice: c.unitPrice,
          quantity: c.quantity,
        })),
      ];
      const body = {
        client: { name: clientName.trim() },
        projectName: projectName.trim() || "Проект",
        startDate: pickupISO,
        endDate: returnISO,
        discountPercent: discountPercent || 0,
        skipPartialDay,
        comment: finalComment,
        items,
        transport: transportPayload,
        // Если пользователь оставил поле пустым — не передаём (backend вычислит default)
        ...(expectedPaymentDateLocal
          ? { expectedPaymentDate: new Date(`${expectedPaymentDateLocal}T00:00:00+03:00`).toISOString() }
          : {}),
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
      router.push(`/bookings/${id}`);
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
      const items = [
        ...apiItems,
        ...customItems.map((c) => ({
          customName: c.name,
          customUnitPrice: c.unitPrice,
          quantity: c.quantity,
        })),
      ];
      const body = {
        client: { name: clientName.trim() },
        projectName: projectName.trim() || "Проект",
        startDate: pickupISO,
        endDate: returnISO,
        discountPercent: clampedDiscount,
        skipPartialDay,
        comment: finalComment,
        items,
        transport: transportPayload,
        // null = сбросить до auto-default; строка = пользовательский выбор
        expectedPaymentDate: expectedPaymentDateLocal
          ? new Date(`${expectedPaymentDateLocal}T00:00:00+03:00`).toISOString()
          : null,
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
      <header className="sticky top-0 z-20 flex items-center justify-between border-b border-border bg-surface px-4 md:px-8 py-3 shadow-xs">
        <div className="flex items-center gap-3 text-[13px]">
          {breadcrumb}
        </div>
        {isEdit && (
          <div className="text-sm font-medium text-ink">{headerTitle}</div>
        )}
      </header>

      <div className="mx-auto grid max-w-[1280px] grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] items-start gap-5 px-4 py-5 md:px-8 md:py-7">
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
            skipPartialDay={skipPartialDay}
            onSkipPartialDayChange={setSkipPartialDay}
          />

          <EquipmentCard
            catalog={catalog}
            catalogLoading={catalogLoading}
            selected={selected}
            offCatalogItems={offCatalogItems}
            customItems={customItems}
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
            onChangeCustomQty={handleChangeCustomQty}
            onRemoveCustom={handleRemoveCustom}
            onOpenCustomModal={() => setCustomModalOpen(true)}
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

          {/* Срок оплаты */}
          <div className="bg-surface border border-border rounded-lg p-4">
            <label className="eyebrow block mb-1">Срок оплаты</label>
            <input
              type="date"
              className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink"
              value={expectedPaymentDateLocal}
              onChange={(e) => setExpectedPaymentDateLocal(e.target.value)}
            />
            {/* F3: dynamic placeholder showing computed default date */}
            {!expectedPaymentDateLocal && returnISO && defaultPaymentTermsDays !== null && (() => {
              const endDate = new Date(returnISO);
              const defaultDate = addDays(endDate, defaultPaymentTermsDays);
              const defaultStr = toMoscowDateString(defaultDate);
              const [y, m, d] = defaultStr.split("-");
              const ddMm = `${d}.${m}.${y}`;
              return (
                <p className="text-xs text-ink-3 mt-1">
                  {defaultPaymentTermsDays === 0
                    ? `по умолчанию: совпадает с днём сдачи (${ddMm})`
                    : `по умолчанию: через ${defaultPaymentTermsDays} дн. после сдачи (${ddMm})`}
                </p>
              );
            })()}
            {(!returnISO || expectedPaymentDateLocal) && (
              <p className="text-xs text-ink-3 mt-1">
                Оставь пустым для default-значения из настроек организации
              </p>
            )}
          </div>
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
            itemCount={selected.size + offCatalogItems.length + customItems.length}
            shifts={shifts}
            isLoadingQuote={loadingQuote}
            checks={checks}
            onSubmitForApproval={isEdit ? undefined : handleSubmitForApproval}
            onSaveDraft={isEdit ? undefined : handleSaveDraftClick}
            onSaveEdit={isEdit ? handleSaveEdit : undefined}
            canSubmit={canSubmit}
            selectedItems={selected}
            offCatalogItems={offCatalogItems}
            customItems={customItems}
            transportBreakdowns={localTransport?.breakdowns ?? []}
            onRemoveItem={handleRemove}
            onRemoveOffCatalog={handleRemoveOffCatalog}
            onRemoveCustom={handleRemoveCustom}
            mode={mode}
            submitting={submitting}
            cancelHref={isEdit ? `/bookings/${bookingId}` : undefined}
          />
          <TransportCard
            vehicles={vehicles}
            selected={selectedVehicles}
            onToggleVehicle={handleToggleVehicle}
            onPatchVehicle={handlePatchVehicle}
            breakdownByVehicleId={breakdownByVehicleId}
          />
        </div>
      </div>

      {/* Custom item modal */}
      <AddCustomItemModal
        isOpen={customModalOpen}
        onClose={() => setCustomModalOpen(false)}
        onAdd={handleAddCustom}
      />
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
