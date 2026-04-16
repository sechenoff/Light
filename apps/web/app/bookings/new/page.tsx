"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

import { apiFetch } from "../../../src/lib/api";
import { formatMoneyRub, pluralize } from "../../../src/lib/format";
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
  InputMode,
  EquipmentTableItem,
  GafferReviewApiItem,
  GafferReviewApiResponse,
  GafferCandidate,
  QuoteResponse,
  AvailabilityRow,
  ValidationCheck,
  ParseResultCounts,
} from "../../../src/components/bookings/create/types";

function apiItemToTableItem(item: GafferReviewApiItem): EquipmentTableItem {
  const m = item.match;
  return {
    id: item.id,
    gafferPhrase: item.gafferPhrase,
    interpretedName: item.interpretedName,
    quantity: item.quantity,
    match: m,
    unitPrice: m.kind === "resolved" ? m.rentalRatePerShift : null,
    lineTotal: null,
  };
}

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

  // Equipment items — single source of truth
  const [items, setItems] = useState<EquipmentTableItem[]>([]);

  // Gaffer AI
  const [gafferText, setGafferText] = useState("");
  const [inputMode, setInputMode] = useState<InputMode>("ai");
  const [gafferParsing, setGafferParsing] = useState(false);
  const [gafferError, setGafferError] = useState<string | null>(null);
  const [parseResultCounts, setParseResultCounts] = useState<ParseResultCounts | null>(null);

  // Quote
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [loadingQuote, setLoadingQuote] = useState(false);

  // Submission
  const [submitting, setSubmitting] = useState(false);

  // Resolved items for API calls
  const resolvedItems = useMemo(
    () =>
      items
        .filter((it) => it.match.kind === "resolved")
        .map((it) => ({
          equipmentId: (it.match as Extract<typeof it.match, { kind: "resolved" }>).equipmentId,
          quantity: it.quantity,
        })),
    [items],
  );

  // Local price computation for when quote is not yet loaded
  const localSubtotal = useMemo(() => {
    return items
      .filter((it) => it.match.kind === "resolved")
      .reduce((acc, it) => {
        const price = it.unitPrice ? Number(it.unitPrice) : 0;
        return acc + price * it.quantity * shifts;
      }, 0);
  }, [items, shifts]);

  const clampedDiscount = Math.max(0, Math.min(100, discountPercent || 0));
  const localDiscount = (localSubtotal * clampedDiscount) / 100;
  const localTotal = localSubtotal - localDiscount;

  // Validation checks
  const checks = useMemo<ValidationCheck[]>(() => {
    const list: ValidationCheck[] = [];
    const unmatched = items.filter((i) => i.match.kind === "unmatched").length;
    const needsReview = items.filter((i) => i.match.kind === "needsReview").length;
    if (items.length > 0 && unmatched === 0 && needsReview === 0) {
      list.push({ type: "ok", label: "Все позиции распознаны", detail: "" });
    }
    if (needsReview > 0) {
      list.push({
        type: "warn",
        label: `${needsReview} позиций требуют уточнения`,
        detail: "выберите вариант из предложенных",
      });
    }
    if (unmatched > 0) {
      list.push({
        type: "warn",
        label: `${unmatched} позиций не распознано`,
        detail: "найдите в каталоге или удалите",
      });
    }
    return list;
  }, [items]);

  const canSubmit = Boolean(
    clientName.trim() && resolvedItems.length > 0 && pickupISO && returnISO && !submitting,
  );

  // Debounced server-side quote
  useEffect(() => {
    if (!clientName.trim() || resolvedItems.length === 0 || !pickupISO || !returnISO) {
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
          items: resolvedItems,
        };
        const data = await apiFetch<QuoteResponse>("/api/bookings/quote", {
          method: "POST",
          body: JSON.stringify(body),
        });
        if (!cancelled) setQuote(data);
      } catch {
        if (!cancelled) setQuote(null);
      } finally {
        if (!cancelled) setLoadingQuote(false);
      }
    }, 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [clientName, projectName, pickupISO, returnISO, discountPercent, resolvedItems]);

  // ── Callbacks ────────────────────────────────────────────────────────────────

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

  async function handleParse() {
    setGafferParsing(true);
    setGafferError(null);
    try {
      const res = await apiFetch<GafferReviewApiResponse>(
        "/api/bookings/parse-gaffer-review",
        {
          method: "POST",
          body: JSON.stringify({
            requestText: gafferText.trim(),
            startDate: pickupISO,
            endDate: returnISO,
          }),
        },
      );
      if (res.items.length === 0) {
        setGafferError(res.message ?? "AI не распознал позиции");
        return;
      }
      const newItems = res.items.map(apiItemToTableItem);
      setItems(newItems);
      setParseResultCounts({
        resolved: newItems.filter((i) => i.match.kind === "resolved").length,
        needsReview: newItems.filter((i) => i.match.kind === "needsReview").length,
        unmatched: newItems.filter((i) => i.match.kind === "unmatched").length,
      });
    } catch (err: any) {
      setGafferError(err?.message ?? "Ошибка AI");
    } finally {
      setGafferParsing(false);
    }
  }

  function handlePasteClear() {
    setGafferText("");
    setGafferError(null);
    setParseResultCounts(null);
  }

  function handleQuantityChange(itemId: string, qty: number) {
    setItems((prev) => prev.map((it) => (it.id === itemId ? { ...it, quantity: Math.max(1, qty) } : it)));
  }

  function handleDeleteItem(itemId: string) {
    setItems((prev) => prev.filter((it) => it.id !== itemId));
  }

  function handleSelectCandidate(itemId: string, candidate: GafferCandidate) {
    setItems((prev) =>
      prev.map((it) =>
        it.id === itemId
          ? {
              ...it,
              match: {
                kind: "resolved",
                equipmentId: candidate.equipmentId,
                catalogName: candidate.catalogName,
                category: candidate.category,
                availableQuantity: candidate.availableQuantity,
                rentalRatePerShift: candidate.rentalRatePerShift,
                confidence: candidate.confidence,
              },
              unitPrice: candidate.rentalRatePerShift,
            }
          : it,
      ),
    );
  }

  function handleSkipItem(itemId: string) {
    setItems((prev) => prev.filter((it) => it.id !== itemId));
  }

  function handleSelectFromCatalog(
    itemId: string,
    equipment: AvailabilityRow,
    saveAlias: boolean,
  ) {
    const item = items.find((it) => it.id === itemId);
    const gafferPhrase = item?.gafferPhrase;

    setItems((prev) =>
      prev.map((it) =>
        it.id === itemId
          ? {
              ...it,
              match: {
                kind: "resolved" as const,
                equipmentId: equipment.equipmentId,
                catalogName: equipment.name,
                category: equipment.category,
                availableQuantity: equipment.availableQuantity,
                rentalRatePerShift: equipment.rentalRatePerShift,
                confidence: 1,
              },
              unitPrice: equipment.rentalRatePerShift,
            }
          : it,
      ),
    );

    if (saveAlias && gafferPhrase) {
      apiFetch("/api/admin/slang-learning/propose", {
        method: "POST",
        body: JSON.stringify({
          rawPhrase: gafferPhrase,
          proposedEquipmentId: equipment.equipmentId,
          proposedEquipmentName: equipment.name,
          confidence: 1,
          contextJson: JSON.stringify({ source: "manual_unmatched_learning" }),
        }),
      }).catch(() => {});
    }
  }

  const searchCatalog = useCallback(async (query: string): Promise<AvailabilityRow[]> => {
    if (!pickupISO || !returnISO) return [];
    const params = new URLSearchParams({ start: pickupISO, end: returnISO, search: query });
    const data = await apiFetch<{ rows: AvailabilityRow[] }>(`/api/availability?${params}`);
    return data.rows;
  }, [pickupISO, returnISO]);

  function handleAddManual() {
    const id = `manual-${Date.now()}`;
    setItems((prev) => [
      ...prev,
      {
        id,
        gafferPhrase: "",
        interpretedName: "Новая позиция",
        quantity: 1,
        match: { kind: "unmatched" },
        unitPrice: null,
        lineTotal: null,
      },
    ]);
  }

  function handleCatalogAdd(equipment: AvailabilityRow) {
    // If equipment already in items, increment qty
    const existing = items.find(
      (it) => it.match.kind === "resolved" && it.match.equipmentId === equipment.equipmentId,
    );
    if (existing) {
      setItems((prev) =>
        prev.map((it) => (it.id === existing.id ? { ...it, quantity: it.quantity + 1 } : it)),
      );
      return;
    }
    // Add new resolved item
    const id = `catalog-${equipment.equipmentId}-${Date.now()}`;
    setItems((prev) => [
      ...prev,
      {
        id,
        gafferPhrase: equipment.name,
        interpretedName: equipment.name,
        quantity: 1,
        match: {
          kind: "resolved" as const,
          equipmentId: equipment.equipmentId,
          catalogName: equipment.name,
          category: equipment.category,
          availableQuantity: equipment.availableQuantity,
          rentalRatePerShift: equipment.rentalRatePerShift,
          confidence: 1,
        },
        unitPrice: equipment.rentalRatePerShift,
        lineTotal: null,
      },
    ]);
  }

  function handleCatalogQuantityChange(equipmentId: string, qty: number) {
    if (qty <= 0) {
      // Remove item
      setItems((prev) =>
        prev.filter(
          (it) => !(it.match.kind === "resolved" && it.match.equipmentId === equipmentId),
        ),
      );
      return;
    }
    setItems((prev) =>
      prev.map((it) =>
        it.match.kind === "resolved" && it.match.equipmentId === equipmentId
          ? { ...it, quantity: qty }
          : it,
      ),
    );
  }

  function handleQuickSearchSelect(equipment: AvailabilityRow) {
    handleCatalogAdd(equipment);
  }

  async function saveDraft() {
    if (!pickupISO || !returnISO || !clientName.trim() || resolvedItems.length === 0) return;
    setSubmitting(true);
    try {
      const body = {
        client: { name: clientName.trim(), phone: null, email: null, comment: null },
        projectName: projectName.trim() || "Проект",
        startDate: pickupISO,
        endDate: returnISO,
        comment: bookingComment || null,
        discountPercent: discountPercent || 0,
        items: resolvedItems,
      };
      const res = await apiFetch<{ booking: { id: string } }>("/api/bookings/draft", {
        method: "POST",
        body: JSON.stringify(body),
      });
      router.push(`/bookings/${res.booking.id}`);
    } catch (err: any) {
      toast.error(err?.message ?? "Ошибка сохранения");
    } finally {
      setSubmitting(false);
    }
  }

  async function submitForApproval() {
    if (!pickupISO || !returnISO || !clientName.trim() || resolvedItems.length === 0) return;
    setSubmitting(true);
    try {
      const body = {
        client: { name: clientName.trim(), phone: null, email: null, comment: null },
        projectName: projectName.trim() || "Проект",
        startDate: pickupISO,
        endDate: returnISO,
        comment: bookingComment || null,
        discountPercent: discountPercent || 0,
        items: resolvedItems,
      };
      const res = await apiFetch<{ booking: { id: string } }>("/api/bookings/draft", {
        method: "POST",
        body: JSON.stringify(body),
      });
      await apiFetch(`/api/bookings/${res.booking.id}/submit-for-approval`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      router.push(`/bookings/${res.booking.id}`);
    } catch (err: any) {
      toast.error(err?.message ?? "Ошибка отправки");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      {/* Sticky top bar */}
      <div className="flex justify-between items-center px-8 py-3 bg-surface border-b border-border sticky top-0 z-10">
        <div className="flex items-center gap-2.5 text-[13px]">
          <Link href="/bookings" className="text-ink-2 hover:text-ink">
            ← Брони
          </Link>
          <span className="text-ink-3">/</span>
          <span className="text-ink font-medium">Новая бронь</span>
          <span className="font-mono text-[11.5px] text-ink-3 px-2 py-0.5 bg-surface-muted border border-border rounded ml-1">
            #—
          </span>
          <span className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-2 px-2.5 py-0.5 bg-surface-muted border border-border rounded-full ml-2">
            <span className="w-1.5 h-1.5 rounded-full bg-ink-3" />
            Черновик
          </span>
        </div>
        <div className="flex gap-1.5">
          <Link
            href="/bookings"
            className="rounded px-3.5 py-[7px] text-[12.5px] font-medium text-ink-2 hover:text-ink"
          >
            Отмена
          </Link>
          <button
            type="button"
            onClick={saveDraft}
            disabled={submitting}
            className="rounded px-3.5 py-[7px] text-[12.5px] font-medium border border-border-strong bg-surface hover:bg-surface-muted disabled:opacity-50"
          >
            Сохранить черновик
          </button>
          <button
            type="button"
            onClick={submitForApproval}
            disabled={submitting || !canSubmit}
            className="rounded px-3.5 py-[7px] text-[12.5px] font-medium bg-ink text-white hover:bg-black disabled:opacity-50"
          >
            Отправить на согласование →
          </button>
        </div>
      </div>

      <div className="max-w-[1280px] mx-auto px-8 py-7">
        {/* Hero */}
        <div className="flex justify-between items-end mb-6 gap-8">
          <div>
            <h1 className="text-[28px] font-semibold tracking-tight leading-tight">
              Новая бронь
            </h1>
            <p className="text-[13.5px] text-ink-2 max-w-[560px] mt-1">
              Клиент, даты, список оборудования. Можно вставить текст от гаффера — AI распознает
              позиции и подтянет цены.
            </p>
          </div>
        </div>

        {/* 2-column grid */}
        <div className="grid grid-cols-[minmax(0,1fr)_320px] gap-5 items-start">
          <div className="flex flex-col gap-3.5">
            <ClientProjectCard
              clientName={clientName}
              onClientNameChange={setClientName}
              projectName={projectName}
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
              items={items}
              shifts={shifts}
              totalAmount={quote ? Number(quote.totalAfterDiscount) : localTotal}
              inputMode={inputMode}
              onInputModeChange={setInputMode}
              text={gafferText}
              onTextChange={setGafferText}
              onParse={handleParse}
              onClear={handlePasteClear}
              isParsing={gafferParsing}
              error={gafferError}
              resultCounts={parseResultCounts}
              onQuantityChange={handleQuantityChange}
              onDelete={handleDeleteItem}
              onSelectCandidate={handleSelectCandidate}
              onSkipItem={handleSkipItem}
              onSelectFromCatalog={handleSelectFromCatalog}
              searchCatalog={searchCatalog}
              pickupISO={pickupISO}
              returnISO={returnISO}
              onCatalogAdd={handleCatalogAdd}
              onCatalogQuantityChange={handleCatalogQuantityChange}
              onQuickSearchSelect={handleQuickSearchSelect}
            />
            {/* Discount */}
            <div className="bg-surface border border-border rounded-md shadow-xs overflow-hidden mb-3.5 px-5 py-3 flex items-center gap-3">
              <label className="text-[11.5px] text-ink-2 whitespace-nowrap">Скидка, %</label>
              <input
                type="number"
                min={0}
                max={100}
                className="w-20 rounded border border-border-strong px-2 py-1.5 text-[13.5px] text-ink bg-surface font-mono text-right focus:outline-none focus:border-accent-bright focus:ring-[3px] focus:ring-accent-soft"
                value={discountPercent}
                onChange={(e) => setDiscountPercent(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
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
            itemCount={resolvedItems.length}
            shifts={shifts}
            isLoadingQuote={loadingQuote}
            checks={checks}
            onSubmitForApproval={submitForApproval}
            onSaveDraft={saveDraft}
            canSubmit={canSubmit}
          />
        </div>
      </div>
    </>
  );
}

export default function BookingNewPageWrapper() {
  return (
    <Suspense fallback={<div className="p-8 text-ink-3">Загрузка...</div>}>
      <BookingNewPage />
    </Suspense>
  );
}
