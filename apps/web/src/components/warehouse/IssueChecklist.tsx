"use client";

/**
 * ISSUE checklist — the operator's «выдача» screen (post-Task-14 UX).
 *
 * UX shape (per user's words 2026-05-22):
 *  - Each row has an unbounded stepper `[−] N [+]` (no `/M` separator).
 *    `min=0`, `max = bi.quantity + bi.addCap` — operator can bump a 10-bag row
 *    up to 12 without opening «+ Добор».
 *  - No per-row commit buttons («Выдать N» / «Не выдаём»). The stepper IS the
 *    state — value === intended actual quantity.
 *  - Visual diff vs `originalQuantity`:
 *      N === origQty (or N === bi.quantity when origQty=0) → neutral
 *      N <  origQty                                        → «−X» amber
 *      N >  origQty                                        → «+X» emerald
 *      N === 0                                             → row dimmed
 *  - Sticky live finance block at viewport bottom:
 *      Согласовано       <main_original>
 *      Снято на выдаче  −<removal>      (only if N < origQty for some row)
 *      Дополнительно   +<addon_actual>  (only if N > origQty for some row)
 *      ────────────
 *      Итого             <final_amount>
 *      [ Готово, выдать ]
 *  - «Готово, выдать» bundles deltas into `issuanceAdjustments` (only rows
 *    where intended ≠ bi.quantity) and POSTs /complete in one shot — no
 *    intermediate сверка screen.
 *  - «+ Добор» (top-right chip) opens AddonSearch — but the picker hides
 *    rows whose equipmentId is already in the booking (operator should use
 *    the stepper instead).
 *
 * The phase machine is `checklist → submitting → result` — сверка is dropped
 * because the live finance block makes it redundant («лишние движения и
 * лишние нажатия мышкой» — the user's exact complaint about pre-Task-14 UX).
 *
 * Data: `useScanSession` (already wired upstream by page.tsx — operation ISSUE).
 *  - The hook provides the canonical checklist state (items + per-unit metadata).
 *  - Per-bookingItem intended quantities are held in local state and applied
 *    batched at `/complete` time as `issuanceAdjustments`.
 *  - Pre-scanned units (`unit.checked === true`) are not surfaced — backend
 *    enforces `ADJUSTMENT_CONFLICTS_WITH_SCANS` if a reduction conflicts with
 *    them, and we render that 409 inline (same as the pre-Task-14 wiring).
 */

import { useEffect, useMemo, useState } from "react";
import { useScanSession } from "./useScanSession";
import { AddonSearch } from "./AddonSearch";
import type {
  ChecklistItem,
  ChecklistState,
  IssuanceAdjustment,
} from "./types";
import { formatRub } from "../../lib/format";
import { scanApi } from "./api";
import { isScanApiError } from "./types";
import type { CompleteResult } from "./types";
import { IssueResultView } from "./IssueResultView";

/** «#» + последние 6 символов id брони, в верхнем регистре (как в BookingList). */
function displayNo(id: string): string {
  return "#" + id.slice(-6).toUpperCase();
}

interface CategoryGroup {
  category: string;
  items: ChecklistItem[];
}

type IssuePhase = "checklist" | "submitting" | "result";

/** Stable category grouping in first-seen order (server already sorts items). */
function groupByCategory(items: ChecklistItem[]): CategoryGroup[] {
  const order: string[] = [];
  const map = new Map<string, ChecklistItem[]>();
  for (const item of items) {
    const key = item.category || "Без категории";
    if (!map.has(key)) {
      map.set(key, []);
      order.push(key);
    }
    map.get(key)!.push(item);
  }
  return order.map((category) => ({
    category,
    items: map.get(category)!,
  }));
}

// ── Live finance ────────────────────────────────────────────────────────────

interface LiveFinance {
  /** state.mainOriginalAfterDiscount — pre-session «Согласовано». */
  mainOriginal: number;
  /**
   * Actual MAIN subtotal at intended quantities (capped at `originalQuantity`
   * per row), discount applied. Anything above origQty becomes addon, not main.
   */
  mainActual: number;
  /** Addon subtotal (intended − originalQuantity) per row, discount applied. */
  addonActual: number;
  /** max(0, mainOriginal − mainActual) — what shows as «Снято на выдаче». */
  removalAmount: number;
  /** mainActual + addonActual — bottom-line «Итого». */
  finalAmount: number;
  /** True when ≥ one row has intended < originalQuantity. */
  hasRemovals: boolean;
  /** True when ≥ one row has intended > originalQuantity. */
  hasAddons: boolean;
}

/**
 * Pure live-finance calc.
 *
 * NB: this is intentionally not Prisma-Decimal — display only. The server is
 * authoritative on commit (`/complete` recomputes finance via
 * recomputeBookingFinance + recomputeAddonEstimate). Any rounding drift we
 * show in the sticky block is fixed once the operator presses «Готово».
 */
export function computeLiveFinance(
  state: ChecklistState,
  intendedQty: Map<string, number>,
): LiveFinance {
  const shifts = state.shifts > 0 ? state.shifts : 1;
  const discount = Number(state.discountPercent ?? "0") / 100;
  let mainSubtotal = 0;
  let addonSubtotal = 0;
  let hasRemovals = false;
  let hasAddons = false;
  for (const item of state.items) {
    const intended = intendedQty.get(item.bookingItemId) ?? item.quantity;
    const rate = Number(item.rentalRatePerShift ?? "0");
    if (intended < item.originalQuantity) hasRemovals = true;
    if (intended > item.originalQuantity) hasAddons = true;
    if (intended <= 0 || rate <= 0) continue;
    const mainPortion = Math.min(intended, item.originalQuantity);
    const addonPortion = Math.max(0, intended - item.originalQuantity);
    mainSubtotal += rate * shifts * mainPortion;
    addonSubtotal += rate * shifts * addonPortion;
  }
  const mainActual = mainSubtotal * (1 - discount);
  const addonActual = addonSubtotal * (1 - discount);
  const mainOriginal = Number(state.mainOriginalAfterDiscount ?? "0");
  const removalAmount = Math.max(0, mainOriginal - mainActual);
  const finalAmount = mainActual + addonActual;
  return {
    mainOriginal,
    mainActual,
    addonActual,
    removalAmount,
    finalAmount,
    hasRemovals,
    hasAddons,
  };
}

// ── Stepper-row ──────────────────────────────────────────────────────────────

/**
 * One booking-item row inside the ISSUE checklist (post-Task-14 unbounded
 * stepper). The stepper is the ONLY control on the row — no commit button.
 *
 * Visual diff is rendered as a tiny inline pill next to the equipment name:
 *  - «+X» emerald when N > origQty
 *  - «−X» amber  when N < origQty
 *  - nothing      when N === origQty (the neutral case)
 *  - row body dims when N === 0 («не выдаём» semantic, but without a button)
 *
 * Touch targets ≥40px (h-10) on the +/− controls — same as the pre-Task-14 UI.
 */
function IssueRow({
  item,
  intended,
  onBump,
  onSet,
}: {
  item: ChecklistItem;
  intended: number;
  onBump: (delta: number) => void;
  onSet: (value: number) => void;
}) {
  // origQty=0 ⇒ the line is itself a добор from a prior session; treat
  // bi.quantity (current) as the reference so the operator doesn't see
  // a misleading «+10» on every fresh row.
  const refQty = item.originalQuantity > 0 ? item.originalQuantity : item.quantity;
  const maxN = item.quantity + item.addCap;
  const N = intended;
  const delta = N - refQty;
  const dimmed = N === 0;

  let diffPill: React.ReactNode = null;
  if (delta > 0) {
    diffPill = (
      <span
        aria-label={`Добавлено сверх ${refQty}: ${delta}`}
        className="ml-1 inline-flex items-center rounded-full border border-emerald-border bg-emerald-soft px-1.5 py-0.5 text-[10px] font-semibold text-emerald"
      >
        +{delta}
      </span>
    );
  } else if (delta < 0) {
    diffPill = (
      <span
        aria-label={`Снято от ${refQty}: ${Math.abs(delta)}`}
        className="ml-1 inline-flex items-center rounded-full border border-amber-border bg-amber-soft px-1.5 py-0.5 text-[10px] font-semibold text-amber"
      >
        −{Math.abs(delta)}
      </span>
    );
  }

  return (
    <div
      className={`flex items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-2 lg:px-3 lg:py-2.5 ${
        dimmed ? "opacity-60" : ""
      }`}
    >
      <div className="min-w-0 flex-1">
        <div
          className={`flex flex-wrap items-center gap-x-1 text-[13px] leading-tight ${
            dimmed ? "line-through text-ink-3" : "text-ink"
          }`}
        >
          <span className="truncate">{item.equipmentName}</span>
          {diffPill}
        </div>
        <div className="mt-0.5 truncate text-[11px] text-ink-3">
          было ×{refQty}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={() => onBump(-1)}
          disabled={N <= 0}
          aria-label={`Уменьшить количество — ${item.equipmentName}`}
          className="flex h-10 w-10 items-center justify-center rounded border border-border bg-surface text-lg font-semibold leading-none text-ink-2 transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
        >
          −
        </button>
        <input
          type="number"
          inputMode="numeric"
          value={N}
          onChange={(e) => {
            const raw = e.target.value;
            onSet(raw === "" ? 0 : Number(raw));
          }}
          min={0}
          max={maxN}
          aria-label={`Количество к выдаче — ${item.equipmentName}`}
          className="mono-num h-10 w-12 rounded border border-border bg-surface text-center text-[13px] font-semibold text-ink outline-none focus:border-accent-bright"
        />
        <button
          type="button"
          onClick={() => onBump(+1)}
          disabled={N >= maxN}
          aria-label={`Увеличить количество — ${item.equipmentName}`}
          className="flex h-10 w-10 items-center justify-center rounded border border-border bg-surface text-lg font-semibold leading-none text-ink-2 transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
        >
          +
        </button>
      </div>
    </div>
  );
}

// ── Sticky live finance ──────────────────────────────────────────────────────

function LiveFinanceBlock({
  finance,
  onSubmit,
  submitting,
}: {
  finance: LiveFinance;
  onSubmit: () => void;
  submitting: boolean;
}) {
  return (
    <div className="space-y-1 text-[13px] text-ink">
      <div className="flex items-baseline justify-between">
        <span className="text-ink-2">Согласовано</span>
        <span className="mono-num">{formatRub(finance.mainOriginal)}</span>
      </div>
      {finance.hasRemovals && finance.removalAmount > 0 && (
        <div className="flex items-baseline justify-between">
          <span className="text-amber">Снято на выдаче</span>
          <span className="mono-num text-amber">
            −{formatRub(finance.removalAmount)}
          </span>
        </div>
      )}
      {finance.hasAddons && finance.addonActual > 0 && (
        <div className="flex items-baseline justify-between">
          <span className="text-emerald">Дополнительно</span>
          <span className="mono-num text-emerald">
            +{formatRub(finance.addonActual)}
          </span>
        </div>
      )}
      <div className="!mt-2 border-t border-border pt-2" />
      <div className="flex items-baseline justify-between">
        <span className="font-semibold">Итого</span>
        <span className="mono-num text-[18px] font-semibold">
          {formatRub(finance.finalAmount)}
        </span>
      </div>
      <button
        type="button"
        onClick={onSubmit}
        disabled={submitting}
        aria-label="Готово, выдать — оформить выдачу с текущими количествами"
        className="!mt-3 block w-full rounded-lg bg-accent px-4 py-3 text-center text-[14px] font-semibold text-white transition-colors hover:opacity-95 disabled:opacity-60"
      >
        {submitting ? "Оформляем…" : "Готово, выдать →"}
      </button>
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

export function IssueChecklist({
  sessionId,
  projectName,
  onBack,
  onComplete,
}: {
  sessionId: string;
  projectName: string;
  onBack: () => void;
  /** Advance to the next page (e.g. back to the bookings list). */
  onComplete?: () => void;
}) {
  const session = useScanSession();
  const { state, loading, error, openSession, refresh } = session;

  // Inline Добор catalog search.
  const [addonOpen, setAddonOpen] = useState(false);

  // ── Per-row intended quantities (the only piece of UI state). ────────────
  // `intendedQty` defaults each bookingItem to bi.quantity (current). When the
  // operator bumps + past bi.quantity the value can go up to bi.quantity+addCap.
  const [intendedQty, setIntendedQty] = useState<Map<string, number>>(
    () => new Map(),
  );
  // bookingItemIds of доборы added with acknowledgedConflict=true.
  const [conflictAddons, setConflictAddons] = useState<Set<string>>(new Set());

  // Seed `intendedQty` from `state.items` once the checklist arrives. New
  // items (доборы added mid-session) get their default bi.quantity; we never
  // clobber a value the operator has already chosen.
  useEffect(() => {
    if (!state) return;
    setIntendedQty((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const item of state.items) {
        if (!next.has(item.bookingItemId)) {
          next.set(item.bookingItemId, item.quantity);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [state]);

  // ── Phase machine (no сверка — straight checklist → submitting → result). ──
  const [phase, setPhase] = useState<IssuePhase>("checklist");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<CompleteResult | null>(null);

  // Bind the hook to the session opened upstream; cancellation-safe.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await openSession(sessionId, "ISSUE");
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, openSession]);

  const groups = useMemo(
    () => (state ? groupByCategory(state.items) : []),
    [state],
  );

  // ── Per-row helpers. ─────────────────────────────────────────────────────
  function getIntended(biId: string): number {
    return intendedQty.get(biId) ?? 0;
  }

  function setRowQty(biId: string, value: number) {
    setIntendedQty((m) => {
      const next = new Map(m);
      const item = state?.items.find((i) => i.bookingItemId === biId);
      if (!item) return m;
      const maxN = item.quantity + item.addCap;
      const clamped = Math.max(0, Math.min(maxN, Math.floor(value)));
      next.set(biId, clamped);
      return next;
    });
  }

  function bumpRowQty(biId: string, delta: number) {
    setRowQty(biId, getIntended(biId) + delta);
  }

  // ── Live finance (recomputes on every stepper change). ───────────────────
  const finance = useMemo<LiveFinance>(() => {
    if (!state) {
      return {
        mainOriginal: 0,
        mainActual: 0,
        addonActual: 0,
        removalAmount: 0,
        finalAmount: 0,
        hasRemovals: false,
        hasAddons: false,
      };
    }
    return computeLiveFinance(state, intendedQty);
  }, [state, intendedQty]);

  // ── equipmentIds already in the booking — used to filter AddonSearch. ─────
  const existingEquipmentIds = useMemo(() => {
    if (!state) return new Set<string>();
    const ids = new Set<string>();
    for (const item of state.items) {
      if (item.equipmentId) ids.add(item.equipmentId);
    }
    return ids;
  }, [state]);

  // ── Counts for the result screen (no сверка → we compute summary directly). ─
  const counts = useMemo(() => {
    if (!state) return { issuedUnits: 0, addons: 0 };
    let issuedUnits = 0;
    let addons = 0;
    for (const item of state.items) {
      if (item.isExtra) {
        addons += 1;
        continue;
      }
      const intended = intendedQty.get(item.bookingItemId) ?? item.quantity;
      issuedUnits += Math.max(0, intended);
    }
    return { issuedUnits, addons };
  }, [state, intendedQty]);

  function handleAddonClick() {
    setAddonOpen(true);
  }

  function handleAddonAdded(bookingItemId: string, hadConflict: boolean) {
    if (hadConflict) {
      setConflictAddons((prev) => {
        if (prev.has(bookingItemId)) return prev;
        const n = new Set(prev);
        n.add(bookingItemId);
        return n;
      });
    }
    void refresh();
  }

  // ── States ──────────────────────────────────────────────────────────────────

  if (loading && !state) {
    return (
      <div className="space-y-2 px-2.5 py-3">
        <div className="h-[46px] animate-pulse rounded-lg bg-surface-subtle" />
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="h-[52px] animate-pulse rounded-lg border border-border bg-surface"
          />
        ))}
      </div>
    );
  }

  if (error && !state) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-4 py-12">
        <div className="w-full max-w-[420px] rounded-lg border border-rose-border bg-rose-soft px-4 py-3 text-center text-sm text-rose">
          {error.message || "Не удалось загрузить чек-лист"}
        </div>
        <button
          type="button"
          onClick={onBack}
          className="mt-4 rounded border border-border bg-surface px-4 py-2 text-sm font-medium text-ink transition-colors hover:bg-surface-muted"
        >
          ← К списку броней
        </button>
      </div>
    );
  }

  if (state && state.items.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-4 py-16 text-center">
        <p className="text-sm text-ink-3">
          В этой брони нет позиций для выдачи
        </p>
        <button
          type="button"
          onClick={onBack}
          className="mt-4 rounded border border-border bg-surface px-4 py-2 text-sm font-medium text-ink transition-colors hover:bg-surface-muted"
        >
          ← К списку броней
        </button>
      </div>
    );
  }

  if (!state) return null;

  /**
   * Build `issuanceAdjustments` from rows whose intended quantity differs from
   * the BookingItem's current quantity. NB: with the unbounded stepper, the
   * intended quantity may be GREATER than bi.quantity (inline-добор) — the
   * backend's /complete endpoint accepts that path (U2 commit) and increases
   * BookingItem.quantity atomically (см. spec
   * `docs/superpowers/specs/2026-05-21-issue-stock-cap-and-unit-removal-design.md`).
   *
   * Rows where intended === bi.quantity are omitted — the backend recomputes
   * MAIN only when there's an actual change, so we keep the payload minimal.
   */
  function buildIssuanceAdjustments(): IssuanceAdjustment[] {
    if (!state) return [];
    const adjustments: IssuanceAdjustment[] = [];
    for (const item of state.items) {
      const intended = intendedQty.get(item.bookingItemId);
      if (intended === undefined) continue;
      if (intended !== item.quantity) {
        adjustments.push({
          bookingItemId: item.bookingItemId,
          actualQuantity: intended,
        });
      }
    }
    return adjustments;
  }

  async function submitToComplete() {
    if (phase === "submitting") return;
    setSubmitError(null);
    setPhase("submitting");
    const adjustments = buildIssuanceAdjustments();
    const payload =
      adjustments.length > 0 ? { issuanceAdjustments: adjustments } : {};
    try {
      const res = await scanApi.complete(sessionId, payload);
      setResult(res);
      setPhase("result");
    } catch (err: unknown) {
      // 409 ADJUSTMENT_CONFLICTS_WITH_SCANS: an operator-supplied adjustment
      // tried to release units that are already scanned. Surface the server
      // message inline and reset the conflicting row's intended quantity back
      // to bi.quantity so the operator can edit it again.
      if (
        isScanApiError(err) &&
        err.status === 409 &&
        err.code === "ADJUSTMENT_CONFLICTS_WITH_SCANS"
      ) {
        const d = err.details as
          | { bookingItemId?: string }
          | null
          | undefined;
        if (d?.bookingItemId) {
          const conflictingItem = state?.items.find(
            (i) => i.bookingItemId === d.bookingItemId,
          );
          if (conflictingItem) {
            setIntendedQty((m) => {
              const next = new Map(m);
              next.set(conflictingItem.bookingItemId, conflictingItem.quantity);
              return next;
            });
          }
        }
        setSubmitError(err.message);
        setPhase("checklist");
        return;
      }
      // 409 ADDON_OVER_STOCK: an inline-добор delta exceeded physical stock.
      // Reset that row to bi.quantity so the operator can pick a smaller bump.
      if (
        isScanApiError(err) &&
        err.status === 409 &&
        err.code === "ADDON_OVER_STOCK"
      ) {
        const d = err.details as
          | { bookingItemId?: string }
          | null
          | undefined;
        if (d?.bookingItemId) {
          const conflictingItem = state?.items.find(
            (i) => i.bookingItemId === d.bookingItemId,
          );
          if (conflictingItem) {
            setIntendedQty((m) => {
              const next = new Map(m);
              next.set(conflictingItem.bookingItemId, conflictingItem.quantity);
              return next;
            });
          }
        }
        setSubmitError(err.message);
        setPhase("checklist");
        return;
      }
      const msg = isScanApiError(err) ? err.message : "Сеть недоступна";
      setSubmitError(msg);
      setPhase("checklist");
    }
  }

  // ── Phase: result («Выдача оформлена[ с замечаниями]») ───────────────────────
  if (phase === "result" && result) {
    return (
      <IssueResultView
        result={result}
        bookingId={state.bookingId}
        projectName={projectName}
        issuedCount={counts.issuedUnits}
        addonsCount={counts.addons}
        substitutedCount={result.substitutedItems?.length ?? 0}
        onDone={() => onComplete?.()}
      />
    );
  }

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <div className="flex-1 px-2.5 pb-4 pt-3 lg:px-4">
        {/* Desktop heading line with «+ Добор» chip. */}
        <div className="mb-2 hidden items-center gap-3 px-1 lg:flex">
          <h2 className="text-[15px] font-semibold text-ink">
            Чек-лист выдачи
          </h2>
          <button
            type="button"
            onClick={handleAddonClick}
            aria-label="Добор — добавить артикул не из заявки"
            className="ml-auto rounded border border-dashed border-accent-bright px-2.5 py-1 text-xs font-semibold text-accent-bright transition-colors hover:bg-accent-soft"
          >
            ＋ Добор
          </button>
        </div>

        {/* Mobile «+ Добор» chip — keeps the dashed-bar affordance from the mockup. */}
        <button
          type="button"
          onClick={handleAddonClick}
          aria-label="Добор — добавить артикул не из заявки"
          className="mb-3 block w-full rounded-lg border-[1.5px] border-dashed border-accent-bright bg-surface px-4 py-2.5 text-center text-sm font-semibold text-accent-bright transition-colors hover:bg-accent-soft lg:hidden"
        >
          ＋ Добор (артикул не из заявки)
        </button>

        {groups.map((group) => (
          <section key={group.category} className="mb-1">
            <p className="eyebrow px-1.5 pb-1 pt-2">{group.category}</p>
            <div className="space-y-1.5">
              {group.items.map((item) => (
                <IssueRow
                  key={item.bookingItemId}
                  item={item}
                  intended={getIntended(item.bookingItemId)}
                  onBump={(delta) => bumpRowQty(item.bookingItemId, delta)}
                  onSet={(value) => setRowQty(item.bookingItemId, value)}
                />
              ))}
            </div>
          </section>
        ))}

        {/* Hint for conflict доборы surfaced post-add (we list them so the
            audit info isn't silently lost between adding and committing). */}
        {conflictAddons.size > 0 && (
          <div className="mt-3 rounded-lg border border-amber-border bg-amber-soft px-3 py-2 text-[12px] text-amber">
            <span aria-hidden="true">⚠ </span>
            {conflictAddons.size === 1
              ? "Один добор добавлен с конфликтом — зафиксируется в аудите."
              : `${conflictAddons.size} доборов добавлены с конфликтом — зафиксируются в аудите.`}
          </div>
        )}

        {submitError && (
          <div
            role="alert"
            className="mt-3 rounded-lg border border-rose-border bg-rose-soft px-3 py-2 text-[12px] text-rose"
          >
            Не получилось завершить выдачу: {submitError}
          </div>
        )}

        {addonOpen && (
          <AddonSearch
            sessionId={sessionId}
            bookingId={state.bookingId}
            bookingNo={state.bookingId ? displayNo(state.bookingId) : undefined}
            existingEquipmentIds={existingEquipmentIds}
            onAdded={handleAddonAdded}
            onClose={() => setAddonOpen(false)}
          />
        )}
      </div>

      {/*
        Sticky live finance block — sits at the bottom of the viewport on
        mobile (fixed-ish via `sticky bottom-0`) and at the bottom of the
        flex column on desktop. The block renders even when finance is all
        zeros (e.g. DRAFT booking with no MAIN) so «Готово, выдать» is
        always reachable.
      */}
      <div className="sticky bottom-0 border-t border-border bg-surface px-3 py-3 lg:px-5">
        <LiveFinanceBlock
          finance={finance}
          onSubmit={() => void submitToComplete()}
          submitting={phase === "submitting"}
        />
      </div>
    </div>
  );
}
