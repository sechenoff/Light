"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

import { apiFetch } from "../../../src/lib/api";
import { pluralize } from "../../../src/lib/format";
import { toast } from "../../../src/components/ToastProvider";
import {
  addHoursToDatetimeLocal,
  datetimeLocalToISO,
  defaultPickupDatetimeLocal,
  formatRentalDurationDetails,
  pickupFromSearchParam,
  returnFromSearchParam,
} from "../../../src/lib/rentalTime";

import { ClientProjectCard } from "../../../src/components/bookings/create/ClientProjectCard";
import { DatesCard } from "../../../src/components/bookings/create/DatesCard";
import { EquipmentCard } from "../../../src/components/bookings/create/EquipmentCard";
import { CommentCard } from "../../../src/components/bookings/create/CommentCard";
import { SummaryPanel } from "../../../src/components/bookings/create/SummaryPanel";
import type {
  AvailabilityRow,
  CatalogRowAdjustment,
  CatalogSelectedItem,
  OffCatalogItem,
  GafferReviewApiResponse,
  QuoteResponse,
  ValidationCheck,
} from "../../../src/components/bookings/create/types";

function BookingNewPage() {
  const router = useRouter();
  const sp = useSearchParams();

  const startParam = sp.get("start");
  const endParam = sp.get("end");

  const [clientName, setClientName] = useState("");
  const [projectName, setProjectName] = useState("");
  const [bookingComment, setBookingComment] = useState("");
  const [discountPercent, setDiscountPercent] = useState(0);

  const [pickupLocal, setPickupLocal] = useState(() =>
    pickupFromSearchParam(startParam, defaultPickupDatetimeLocal()),
  );
  const [returnLocal, setReturnLocal] = useState(() =>
    returnFromSearchParam(endParam, pickupFromSearchParam(startParam, defaultPickupDatetimeLocal())),
  );

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
  const [selected, setSelected] = useState<Map<string, CatalogSelectedItem>>(new Map());
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [offCatalogItems, setOffCatalogItems] = useState<OffCatalogItem[]>([]);
  const [adjustments, setAdjustments] = useState<Map<string, CatalogRowAdjustment>>(new Map());

  // Search + tabs
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTab, setActiveTab] = useState<string>("all");

  // AI flow
  const [gafferText, setGafferText] = useState("");
  const [parsing, setParsing] = useState(false);
  const [parsed, setParsed] = useState(false);
  const [parseResolved, setParseResolved] = useState(0);
  const [parseTotal, setParseTotal] = useState(0);
  const [unmatchedFromAi, setUnmatchedFromAi] = useState<string[]>([]);
  const [successBannerDismissed, setSuccessBannerDismissed] = useState(false);

  // Quote
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [loadingQuote, setLoadingQuote] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // ── Catalog fetch (on dates change) ──
  useEffect(() => {
    if (!pickupISO || !returnISO) return;
    let cancelled = false;
    setCatalogLoading(true);
    const params = new URLSearchParams({ start: pickupISO, end: returnISO });
    apiFetch<{ rows: AvailabilityRow[] }>(`/api/availability?${params}`)
      .then((res) => {
        if (cancelled) return;
        setCatalog(res.rows);
        // Compute adjustments and next selected state together (H1/H2)
        // selectedRef holds the current selected snapshot captured below.
        const newAdj = new Map<string, CatalogRowAdjustment>();
        const newSelectedEntries: Array<[string, CatalogSelectedItem]> = [];
        const toDelete: string[] = [];
        // NOTE: selectedRef.current is updated synchronously before each render via the ref below
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
    return () => {
      cancelled = true;
    };
  }, [pickupISO, returnISO]);

  // ── Derived ──
  // C1: only catalog items go to the API (backend schema requires equipmentId)
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

  // ── Debounced quote ──
  useEffect(() => {
    if (!clientName.trim() || apiItems.length === 0 || !pickupISO || !returnISO) {
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
        };
        const data = await apiFetch<QuoteResponse>("/api/bookings/quote", { method: "POST", body: JSON.stringify(body) });
        if (!cancelled) setQuote(data);
      } catch {
        if (!cancelled) setQuote(null);
      } finally {
        if (!cancelled) setLoadingQuote(false);
      }
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [clientName, projectName, pickupISO, returnISO, discountPercent, apiItems]);

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

      const resolvedItems: Array<{
        equipmentId: string;
        name: string;
        category: string;
        quantity: number;
        dailyPrice: string;
        availableQuantity: number;
      }> = [];
      const unmatched: string[] = [];

      for (const item of res.items) {
        if (item.match.kind === "resolved") {
          resolvedItems.push({
            equipmentId: item.match.equipmentId,
            name: item.match.catalogName,
            category: item.match.category,
            quantity: item.quantity,
            dailyPrice: item.match.rentalRatePerShift,
            availableQuantity: item.match.availableQuantity,
          });
        } else if (item.match.kind === "needsReview" && item.match.candidates.length > 0) {
          const top = item.match.candidates[0];
          resolvedItems.push({
            equipmentId: top.equipmentId,
            name: top.catalogName,
            category: top.category,
            quantity: item.quantity,
            dailyPrice: top.rentalRatePerShift,
            availableQuantity: top.availableQuantity,
          });
        } else {
          unmatched.push(item.gafferPhrase || item.interpretedName);
        }
      }

      setSelected((prev) => {
        const next = new Map(prev);
        for (const r of resolvedItems) {
          next.set(r.equipmentId, {
            equipmentId: r.equipmentId,
            name: r.name,
            category: r.category,
            quantity: Math.min(r.quantity, r.availableQuantity),
            dailyPrice: r.dailyPrice,
            availableQuantity: r.availableQuantity,
          });
        }
        return next;
      });

      setUnmatchedFromAi(unmatched);
      setParseResolved(resolvedItems.length);
      setParseTotal(res.items.length);
      setSuccessBannerDismissed(false);
      // Auto-reset the input: user sees the green banner, and the field is
      // ready for the next query (typed search or a new paste). Also clear
      // searchQuery so the catalog isn't stuck filtered by the just-parsed
      // gaffer text.
      setGafferText("");
      setSearchQuery("");
      setParsed(false);
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

  function handleDismissSuccess() {
    setSuccessBannerDismissed(true);
  }

  function handleIgnoreUnmatched() {
    setUnmatchedFromAi([]);
  }

  function handleAddOffCatalog(phrase: string) {
    const tempId = `off-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setOffCatalogItems((prev) => [...prev, { tempId, name: phrase, quantity: 1 }]);
    setUnmatchedFromAi((prev) => prev.filter((p) => p !== phrase));
  }

  // ── Save / submit ──
  async function saveDraft(): Promise<string | null> {
    setSubmitting(true);
    try {
      // C1: off-catalog items appended to comment — backend doesn't accept items without equipmentId
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
      };
      // C2: response shape is { booking: { id } }, not { id }
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

  return (
    <div>
      <header className="sticky top-0 z-20 flex items-center justify-between border-b border-border bg-surface px-8 py-3 shadow-xs">
        <div className="flex items-center gap-3 text-[13px]">
          <Link href="/bookings" className="text-accent-bright hover:underline">← Брони</Link>
          <span className="text-ink-3">/ Новая бронь</span>
          <span className="rounded-full border border-border bg-surface-muted px-2 py-0.5 text-[10px] text-ink-3">Черновик</span>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1280px] grid-cols-[minmax(0,1fr)_320px] items-start gap-5 px-8 py-7">
        <div className="flex flex-col gap-3.5">
          <ClientProjectCard
            clientName={clientName}
            projectName={projectName}
            onClientNameChange={setClientName}
            onProjectNameChange={setProjectName}
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
          />

          <div className="flex items-center justify-between rounded-md border border-border bg-surface px-5 py-3 shadow-xs">
            <label className="text-[13px] text-ink-2">Скидка, %</label>
            <input
              type="number"
              min="0"
              max="100"
              value={discountPercent}
              onChange={(e) => setDiscountPercent(Number(e.target.value))}
              className="w-20 rounded border border-border px-2 py-1 text-right font-mono"
            />
          </div>

          <CommentCard value={bookingComment} onChange={setBookingComment} />
        </div>

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
          onSubmitForApproval={handleSubmitForApproval}
          onSaveDraft={handleSaveDraftClick}
          canSubmit={canSubmit}
          selectedItems={selected}
          offCatalogItems={offCatalogItems}
        />
      </div>
    </div>
  );
}

export default function BookingNewPageWrapper() {
  return (
    <Suspense fallback={<div>Загрузка...</div>}>
      <BookingNewPage />
    </Suspense>
  );
}
