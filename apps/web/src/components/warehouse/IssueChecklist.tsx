"use client";

/**
 * ISSUE checklist — the operator's "выдача" screen.
 *
 * Visual source of truth: mockup `03-issue-and-desktop.html`
 *  - block 2 (mobile): «✓ Выдать всё разом» primary bar → category groups →
 *    per-bookingItem row with stepper [−] N [+] / M and a «Выдать N» /
 *    «Не выдаём» button → «＋ Добор» dashed bar → sticky «Завершить выдачу»
 *    footer. NEVER a barcode — name + «было ×M» eyebrow.
 *  - block 4 (desktop, right pane): a heading line «Чек-лист выдачи · N / M ✓»
 *    with an inline «＋ Добор» chip, wider rows, same logic.
 *
 * Per-row state machine (Task 11):
 *  - editable: stepper + «Выдать N» (or «Не выдаём» at N=0) primary button.
 *  - committed: status badge («Выдано N / M» / «Не выдаём») + «Изменить» link
 *    that rolls back to editable.
 *  - Global «✓ Выдать всё разом» commits every uncommitted row at its current
 *    intended quantity (default N = M).
 *
 * Data: `useScanSession` (already wired upstream by page.tsx — operation ISSUE).
 *  - The hook provides the canonical checklist state (items + per-unit metadata).
 *  - Per-bookingItem intended quantities are held in local state and applied
 *    batched at `/complete` time as `issuanceAdjustments` (Task 12 / spec
 *    `docs/superpowers/specs/2026-05-21-issue-stock-cap-and-unit-removal-design.md`).
 *  - Pre-scanned units (`unit.checked === true`) are not surfaced in v1 — the
 *    backend enforces `ADJUSTMENT_CONFLICTS_WITH_SCANS` and the inline 409
 *    handling lives in Task 12.
 *
 * Seams:
 *  - Добор → `AddonSearch` (Task 6.2). The «＋ Добор» action opens an inline
 *    catalog search with a soft availability warning; on add we `refresh()`
 *    the session so the new добор appears in this list.
 *  - «Завершить выдачу» → `onComplete` (Task 7/8 summary/complete wiring). We do
 *    NOT POST /complete here — we only advance the flow.
 */

import { useEffect, useMemo, useState } from "react";
import { useScanSession } from "./useScanSession";
import { AddonSearch } from "./AddonSearch";
import type { AddonEstimateView, ChecklistItem, ChecklistState } from "./types";
import { formatRub, pluralize } from "../../lib/format";
import { scanApi } from "./api";
import type { CompleteResult, SummaryResult } from "./types";
import { IssueResultView } from "./IssueResultView";

/** «#» + последние 6 символов id брони, в верхнем регистре (как в BookingList). */
function displayNo(id: string): string {
  return "#" + id.slice(-6).toUpperCase();
}

/** Human label for the unit status that blocks issuance. */
function statusLabel(status: string): string {
  switch (status) {
    case "MAINTENANCE":
      return "в ремонте";
    case "MISSING":
      return "в Потеряшках";
    case "RETIRED":
      return "списан";
    case "ISSUED":
      return "уже выдан";
    default:
      return status.toLowerCase();
  }
}

function StatRow({
  variant,
  label,
  value,
}: {
  variant: "ok" | "neutral" | "warn" | "bad";
  label: string;
  value: number;
}) {
  const cls =
    variant === "ok"
      ? "border-emerald-border bg-emerald-soft text-emerald"
      : variant === "warn"
        ? "border-amber-border bg-amber-soft text-amber"
        : variant === "bad"
          ? "border-rose-border bg-rose-soft text-rose"
          : "border-border bg-surface text-ink";
  return (
    <div
      className={`mx-3 flex items-center justify-between rounded-lg border px-3 py-2 text-[13px] ${cls}`}
    >
      <span>{label}</span>
      <span className="mono-num font-semibold">{value}</span>
    </div>
  );
}

/** Compact «первые 5 + ... и ещё K» list under a stat row. */
function DetailList({
  variant,
  items,
}: {
  variant: "neutral" | "warn" | "bad";
  items: string[];
}) {
  if (items.length === 0) return null;
  const head = items.slice(0, 5);
  const rest = items.length - head.length;
  const cls =
    variant === "bad"
      ? "border-rose-border text-rose"
      : variant === "warn"
        ? "border-amber-border text-amber"
        : "border-border text-ink-2";
  return (
    <div
      className={`mx-3 mt-1 rounded-lg border border-dashed bg-surface px-2.5 py-2 text-[11px] leading-snug ${cls}`}
    >
      {head.map((line, i) => (
        <p key={i}>{line}</p>
      ))}
      {rest > 0 && (
        <p className="mt-1 opacity-80">
          …и ещё {rest}
        </p>
      )}
    </div>
  );
}

interface CategoryGroup {
  category: string;
  items: ChecklistItem[];
}

type IssuePhase = "checklist" | "summary" | "submitting" | "result";

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

/**
 * Checked-progress «N / M» across booking items, post-Task-11.
 *
 * `done` is the count of *committed* rows (rows the operator has finalised via
 * «Выдать N» / «Не выдаём» / «Выдать всё разом»). `total` is one-per-bookingItem
 * since each line shows a single stepper, regardless of trackingMode.
 *
 * `isExtra` доборы count too — they're committed via the same per-row UI.
 */
function computeProgress(
  state: ChecklistState,
  committedRows: ReadonlySet<string>,
): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const item of state.items) {
    total += 1;
    if (committedRows.has(item.bookingItemId)) done += 1;
  }
  return { done, total };
}

/**
 * One booking-item row inside the ISSUE checklist (post-Task-11).
 *
 * Editable state: `[−] N [+] / M` stepper + a single primary-CTA button. The
 * button reads «Выдать N» (blue/accent) when N>0, «Не выдаём» (rose) when N=0.
 * Clicking the button commits the row.
 *
 * Committed state: a status badge («Выдано N / M» emerald / «Не выдаём» rose)
 * + a text-link «Изменить» that rolls back to editable. This matches the
 * brainstorming mockup spec («количество единиц с левой и с правой, плюс и
 * минус, и кнопка "выдать"»).
 *
 * Visual conventions stay aligned with the rest of the warehouse surface:
 * `border-border` / `bg-surface` / semantic accents only. Touch targets ≥40px
 * (h-10) on the controls.
 *
 * Pure / controlled: every state mutation goes through the parent's helpers.
 */
function IssueRow({
  item,
  intended,
  committed,
  onBump,
  onSet,
  onCommit,
  onUncommit,
}: {
  item: ChecklistItem;
  intended: number;
  committed: boolean;
  onBump: (delta: number) => void;
  onSet: (value: number) => void;
  onCommit: () => void;
  onUncommit: () => void;
}) {
  const M = item.quantity;
  const N = intended;
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-2 lg:px-3 lg:py-2.5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] leading-tight text-ink">
          {item.equipmentName}
        </div>
        <div className="mt-0.5 truncate text-[11px] text-ink-3">
          было ×{M}
        </div>
      </div>

      {!committed ? (
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
              // Empty string clears to 0 — matches user expectation when
              // selecting & deleting the value.
              onSet(raw === "" ? 0 : Number(raw));
            }}
            min={0}
            max={M}
            aria-label={`Количество к выдаче — ${item.equipmentName}`}
            className="mono-num h-10 w-12 rounded border border-border bg-surface text-center text-[13px] font-semibold text-ink outline-none focus:border-accent-bright"
          />
          <button
            type="button"
            onClick={() => onBump(+1)}
            disabled={N >= M}
            aria-label={`Увеличить количество — ${item.equipmentName}`}
            className="flex h-10 w-10 items-center justify-center rounded border border-border bg-surface text-lg font-semibold leading-none text-ink-2 transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            +
          </button>
          <span className="text-[11px] text-ink-3">/ {M}</span>
          <button
            type="button"
            onClick={onCommit}
            aria-label={
              N === 0
                ? `Не выдаём — ${item.equipmentName}`
                : `Выдать ${N} шт — ${item.equipmentName}`
            }
            className={`h-10 shrink-0 rounded px-3 text-[12px] font-semibold text-white transition-colors hover:opacity-95 ${
              N === 0 ? "bg-rose" : "bg-accent-bright"
            }`}
          >
            {N === 0 ? "Не выдаём" : `Выдать ${N}`}
          </button>
        </div>
      ) : (
        <div className="flex shrink-0 items-center gap-2">
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
              N === 0
                ? "border border-rose-border bg-rose-soft text-rose"
                : "border border-emerald-border bg-emerald-soft text-emerald"
            }`}
          >
            {N === 0 ? "Не выдаём" : `Выдано ${N} / ${M}`}
          </span>
          <button
            type="button"
            onClick={onUncommit}
            aria-label={`Изменить количество для выдачи — ${item.equipmentName}`}
            className="text-[11px] text-ink-3 underline transition-colors hover:text-ink hover:no-underline"
          >
            Изменить
          </button>
        </div>
      )}
    </div>
  );
}

export function IssueChecklist({
  sessionId,
  projectName,
  onBack,
  onComplete,
}: {
  sessionId: string;
  projectName: string;
  onBack: () => void;
  /** Advance to the summary step (Task 7/8 wires the actual completion). */
  onComplete?: () => void;
}) {
  const session = useScanSession();
  const { state, loading, error, openSession, refresh } = session;

  // Inline Добор catalog search.
  const [addonOpen, setAddonOpen] = useState(false);

  // ── Per-row state machine (Task 11: stepper + commit/uncommit). ─────────────
  // `intendedQty` is the operator's intended actualQuantity per booking item;
  // default = bi.quantity (M). Bounded to [0, M] by `setRowQty`.
  // For доборы (isExtra), default also = bi.quantity (the picker already
  // capped at addCap when the добор was added).
  const [intendedQty, setIntendedQty] = useState<Map<string, number>>(
    () => new Map(),
  );
  // Rows for which the operator has committed an intent («Выдать N» /
  // «Не выдаём»). Uncommitted rows still show the stepper; committed rows
  // show a status badge + «Изменить» rollback link.
  const [committedRows, setCommittedRows] = useState<Set<string>>(new Set());
  // bookingItemIds of доборы added with acknowledgedConflict=true.
  const [conflictAddons, setConflictAddons] = useState<Set<string>>(new Set());

  // Seed `intendedQty` from `state.items` once the checklist arrives. New
  // items (доборы added mid-session) get their default M; we never clobber a
  // value the operator has already chosen.
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

  // ── Phase machine (lives inside this component — no outer step). ─────────────
  const [phase, setPhase] = useState<IssuePhase>("checklist");
  const [summary, setSummary] = useState<SummaryResult | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<CompleteResult | null>(null);
  // ADDON Estimate fetched in parallel with summary when entering сверка.
  const [addonEstimate, setAddonEstimate] = useState<AddonEstimateView | null>(
    null,
  );

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

  const progress = useMemo(
    () =>
      state
        ? computeProgress(state, committedRows)
        : { done: 0, total: 0 },
    [state, committedRows],
  );

  // ── Per-row helpers (Task 11). ─────────────────────────────────────────────
  function getIntended(biId: string): number {
    return intendedQty.get(biId) ?? 0;
  }

  function setRowQty(biId: string, value: number) {
    setIntendedQty((m) => {
      const next = new Map(m);
      const original =
        state?.items.find((i) => i.bookingItemId === biId)?.quantity ?? 0;
      const clamped = Math.max(0, Math.min(original, Math.floor(value)));
      next.set(biId, clamped);
      return next;
    });
  }

  function bumpRowQty(biId: string, delta: number) {
    setRowQty(biId, getIntended(biId) + delta);
  }

  function commitRow(biId: string) {
    setCommittedRows((s) => {
      if (s.has(biId)) return s;
      const next = new Set(s);
      next.add(biId);
      return next;
    });
  }

  function uncommitRow(biId: string) {
    setCommittedRows((s) => {
      if (!s.has(biId)) return s;
      const next = new Set(s);
      next.delete(biId);
      return next;
    });
  }

  /**
   * Commit every uncommitted row at its current intended quantity (default M).
   * The label «✓ Выдать всё разом» suggests bulk-issue, but per the v1 spec we
   * preserve any operator-chosen N — including N=0 (Не выдаём) — so an operator
   * who set one row to 0 and then taps «Выдать всё разом» does not have their
   * decision silently overridden back to M.
   */
  function commitAll() {
    if (!state) return;
    setCommittedRows(new Set(state.items.map((i) => i.bookingItemId)));
  }

  /**
   * Derived counters for the сверка («N / M в брони + K доборов» summary).
   *
   * Conventions match the pre-Task-11 shape so the summary screen renders
   * unchanged: `issuedUnits` accumulates UNIT-mode actual quantities,
   * `issuedLines` accumulates COUNT-mode committed lines, `withheld` is the
   * **unit-equivalent** count of pulled units (M − N for UNIT, M for COUNT
   * when N=0). Uncommitted rows fall into the «без отметки» warning bucket.
   */
  const counts = useMemo(() => {
    if (!state) {
      return {
        issuedUnits: 0,
        issuedLines: 0,
        withheld: 0,
        addons: 0,
        addonsWithConflict: 0,
        untouchedUnitLines: [] as string[],
        untouchedCountLines: [] as string[],
        addonConflictLines: [] as string[],
      };
    }
    let issuedUnits = 0;
    let issuedLines = 0;
    let withheld = 0;
    let addons = 0;
    let addonsWithConflict = 0;
    const untouchedUnitLines: string[] = [];
    const untouchedCountLines: string[] = [];
    const addonConflictLines: string[] = [];

    for (const item of state.items) {
      if (item.isExtra) {
        addons += 1;
        if (conflictAddons.has(item.bookingItemId)) {
          addonsWithConflict += 1;
          addonConflictLines.push(
            `${item.equipmentName} — выдан под ответственность`,
          );
        }
        // Addons are counted in their own «＋ Доборы» row — do NOT double-count
        // their units/quantity into issuedUnits/issuedLines.
        continue;
      }
      const M = item.trackingMode === "UNIT" && item.units
        ? item.units.length
        : item.quantity;
      const committed = committedRows.has(item.bookingItemId);
      if (!committed) {
        if (item.trackingMode === "UNIT" && item.units) {
          untouchedUnitLines.push(`${item.equipmentName} · ×${M}`);
        } else {
          untouchedCountLines.push(`${item.equipmentName} · ×${M}`);
        }
        continue;
      }
      const N = Math.max(0, Math.min(M, intendedQty.get(item.bookingItemId) ?? M));
      if (item.trackingMode === "UNIT" && item.units) {
        issuedUnits += N;
        withheld += M - N;
      } else {
        if (N > 0) issuedLines += 1;
        // For COUNT lines, the «withheld» counter tracks unit-equivalent
        // pulled quantity. Removing (M − N) is meaningful when M > 1.
        if (M - N > 0) withheld += M - N;
      }
    }

    return {
      issuedUnits,
      issuedLines,
      withheld,
      addons,
      addonsWithConflict,
      untouchedUnitLines,
      untouchedCountLines,
      addonConflictLines,
    };
  }, [state, committedRows, intendedQty, conflictAddons]);

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
    // Re-fetch checklist state so the freshly added добор shows up in the
    // list (the hook's per-id guard / refreshBlocked keeps this safe vs any
    // in-flight check/uncheck).
    void refresh();
  }

  useEffect(() => {
    if (phase !== "summary") return;
    let cancelled = false;
    setSummaryError(null);
    scanApi
      .getSummary(sessionId)
      .then((s) => {
        if (cancelled) return;
        setSummary(s);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg =
          err && typeof err === "object" && "message" in err
            ? String((err as { message: unknown }).message)
            : "Не удалось загрузить сверку";
        setSummaryError(msg);
      });
    return () => {
      cancelled = true;
    };
  }, [phase, sessionId]);

  // Parallel fetch: ADDON Estimate (доб-смета) when entering сверка. Failure is
  // soft — we simply don't render the «Доб-смета» block (the summary screen is
  // still actionable without it). Cancellation-safe via `cancelled` flag.
  useEffect(() => {
    if (phase !== "summary") return;
    if (!state?.bookingId) return;
    const bookingId = state.bookingId;
    let cancelled = false;
    scanApi
      .getAddonEstimate(bookingId)
      .then((r) => {
        if (cancelled) return;
        setAddonEstimate(r.addon);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.warn("getAddonEstimate failed:", err);
        setAddonEstimate(null);
      });
    return () => {
      cancelled = true;
    };
  }, [phase, state?.bookingId]);

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

  async function submitToComplete() {
    if (phase !== "summary") return;
    setSubmitError(null);
    setPhase("submitting");
    try {
      const res = await scanApi.complete(sessionId, {});
      setResult(res);
      setPhase("result");
    } catch (err: unknown) {
      const msg =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : "Сеть недоступна";
      setSubmitError(msg);
      setPhase("summary");
    }
  }

  // ── Phase: result («Выдача оформлена[ с замечаниями]») ───────────────────────
  if (phase === "result" && result) {
    return (
      <IssueResultView
        result={result}
        bookingId={state.bookingId}
        projectName={projectName}
        issuedCount={counts.issuedUnits + counts.issuedLines}
        addonsCount={counts.addons}
        substitutedCount={result.substitutedItems?.length ?? 0}
        onDone={() => onComplete?.()}
      />
    );
  }

  // ── Phase: summary («Сверка») / submitting (POST in flight) ────────────────
  if (phase === "summary" || phase === "submitting") {
    const issuedTotal = counts.issuedUnits + counts.issuedLines;
    const readyTotal = issuedTotal + counts.addons; // emerald badge: «N из M в брони + K доборов»
    // «из M в брони» — суммарное число СКАНИРУЕМЫХ строк в брони без доборов:
    // каждый UNIT-юнит = 1, каждая COUNT-позиция = 1. Это та же единица
    // измерения что и в числителе (readyTotal), а заодно совпадает с моком
    // («из 26 в брони + 2 добора» где 26 — все юниты + count-строки).
    // Раньше тут было `items.filter(!isExtra).length` — то есть число
    // BookingItem-ов, что приводило к читаемому «4 из 3 в брони» при
    // одном UNIT-айтеме с тремя юнитами + одной COUNT-строкой.
    const expectedM = state.items.reduce((sum, i) => {
      if (i.isExtra) return sum;
      if (i.trackingMode === "UNIT" && i.units) return sum + i.units.length;
      return sum + 1; // COUNT-позиция считается как одна «строка к выдаче».
    }, 0);
    const reserved = summary?.reservedButUnavailable ?? [];

    return (
      <div className="flex min-h-full flex-1 flex-col">
        <div className="flex-1 px-3 pb-4 pt-3 lg:px-5">
          <div className="mx-auto w-full max-w-[460px]">
            {/* Emerald badge ─ «Готово к выдаче» */}
            <div className="rounded-lg border border-emerald-border bg-emerald-soft px-4 py-4 text-center">
              <p className="eyebrow text-emerald">Готово к выдаче</p>
              <p className="mono-num mt-1 text-[34px] font-semibold leading-none text-emerald">
                {readyTotal}
              </p>
              <p className="mt-1 text-[12px] text-emerald">
                из {expectedM} в брони
                {counts.addons > 0 ? ` + ${counts.addons} доборов` : ""}
              </p>
            </div>

            {summaryError && (
              <div
                role="alert"
                className="mt-3 rounded-lg border border-rose-border bg-rose-soft px-3 py-2 text-[12px] text-rose"
              >
                {summaryError}
              </div>
            )}

            {/* Stat rows */}
            <div className="mt-3 space-y-1.5">
              <StatRow variant="ok" label="✓ Выдаём" value={issuedTotal} />
              {counts.addons > 0 && (
                <StatRow variant="ok" label="＋ Доборы" value={counts.addons} />
              )}
              {counts.withheld > 0 && (
                <StatRow
                  variant="neutral"
                  label="✗ Не выдаём"
                  value={counts.withheld}
                />
              )}
              {counts.untouchedUnitLines.length +
                counts.untouchedCountLines.length >
                0 && (
                <>
                  <StatRow
                    variant="warn"
                    label="⚠ Без отметки — пропустим"
                    value={
                      counts.untouchedUnitLines.length +
                      counts.untouchedCountLines.length
                    }
                  />
                  <DetailList
                    variant="warn"
                    items={[
                      ...counts.untouchedUnitLines,
                      ...counts.untouchedCountLines,
                    ]}
                  />
                </>
              )}
              {reserved.length > 0 && (
                <>
                  <StatRow
                    variant="bad"
                    label="⛔ Резерв недоступен"
                    value={reserved.length}
                  />
                  <DetailList
                    variant="bad"
                    items={reserved.map(
                      (r) =>
                        `${r.equipmentName} · ${r.ordinalLabel} → ${statusLabel(r.status)}`,
                    )}
                  />
                </>
              )}
              {counts.addonsWithConflict > 0 && (
                <>
                  <StatRow
                    variant="neutral"
                    label="＋ Доборы с предупреждением"
                    value={counts.addonsWithConflict}
                  />
                  <DetailList
                    variant="warn"
                    items={counts.addonConflictLines}
                  />
                </>
              )}
            </div>

            {addonEstimate && addonEstimate.lines.length > 0 && (
              <div className="mt-4 rounded-lg border border-border bg-surface px-3 py-3">
                <div className="eyebrow mb-2">Доб-смета</div>
                <ul className="space-y-1">
                  {addonEstimate.lines.map((l, i) => (
                    <li
                      key={i}
                      className="flex justify-between text-[13px] text-ink"
                    >
                      <span className="truncate">
                        {l.name}{" "}
                        <span className="text-ink-3">×{l.quantity}</span>
                      </span>
                      <span className="mono-num">{formatRub(l.lineSum)}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-2 border-t border-border pt-2 text-[12px] text-ink-2">
                  <div className="flex justify-between">
                    <span>Итого:</span>
                    <span className="mono-num">
                      {formatRub(addonEstimate.subtotal)}
                    </span>
                  </div>
                  {addonEstimate.discountPercent &&
                    Number(addonEstimate.discountPercent) > 0 && (
                      <div className="flex justify-between">
                        <span>
                          Скидка {addonEstimate.discountPercent}% (как в
                          основной):
                        </span>
                        <span className="mono-num">
                          −{formatRub(addonEstimate.discountAmount)}
                        </span>
                      </div>
                    )}
                  <div className="flex justify-between font-semibold text-ink">
                    <span>К доплате:</span>
                    <span className="mono-num">
                      {formatRub(addonEstimate.totalAfterDiscount)}
                    </span>
                  </div>
                </div>
                <a
                  href={`/api/addon-estimates/${state.bookingId}/export/pdf`}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-block text-[12px] text-accent underline hover:no-underline"
                  aria-label="Открыть PDF доб-сметы"
                >
                  Открыть PDF доб-сметы →
                </a>
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
          </div>
        </div>

        {/* Sticky footer */}
        <div className="sticky bottom-0 flex gap-2 border-t border-border bg-surface px-3 py-3 lg:px-5">
          <button
            type="button"
            onClick={() => setPhase("checklist")}
            className="shrink-0 rounded-lg border border-border bg-surface px-3 py-3 text-[13px] font-medium text-ink-2 transition-colors hover:bg-surface-muted"
          >
            ← К чек-листу
          </button>
          <button
            type="button"
            onClick={() => void submitToComplete()}
            disabled={phase === "submitting"}
            aria-label="Подтвердить выдачу"
            className="flex-1 rounded-lg bg-accent px-4 py-3 text-center text-[13px] font-semibold text-white transition-colors hover:opacity-95 disabled:opacity-60"
          >
            Подтвердить выдачу →
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <div className="flex-1 px-2.5 pb-4 pt-3 lg:px-4">
        {/* Desktop heading line with progress + inline Добор chip. */}
        <div className="mb-2 hidden items-center gap-3 px-1 lg:flex">
          <h2 className="text-[15px] font-semibold text-ink">
            Чек-лист выдачи
          </h2>
          <span className="mono-num text-sm text-accent-bright">
            {progress.done} / {progress.total} ✓
          </span>
          <button
            type="button"
            onClick={handleAddonClick}
            aria-label="Добор — добавить артикул не из заявки"
            className="ml-auto rounded border border-dashed border-accent-bright px-2.5 py-1 text-xs font-semibold text-accent-bright transition-colors hover:bg-accent-soft"
          >
            ＋ Добор
          </button>
        </div>

        {/* «Выдать всё разом» — primary bar (mockup block 2 .bar.acc). */}
        <button
          type="button"
          onClick={commitAll}
          aria-label="Выдать всё разом — зафиксировать все строки в текущих количествах"
          className="mb-3 block w-full rounded-lg bg-accent-bright px-4 py-3 text-center text-sm font-semibold text-white transition-colors hover:opacity-95"
        >
          ✓ Выдать всё разом
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
                  committed={committedRows.has(item.bookingItemId)}
                  onBump={(delta) => bumpRowQty(item.bookingItemId, delta)}
                  onSet={(value) => setRowQty(item.bookingItemId, value)}
                  onCommit={() => commitRow(item.bookingItemId)}
                  onUncommit={() => uncommitRow(item.bookingItemId)}
                />
              ))}
            </div>
          </section>
        ))}

        {/* «＋ Добор» dashed bar (mockup block 2 .bar.add). */}
        <button
          type="button"
          onClick={handleAddonClick}
          aria-label="Добор — добавить артикул не из заявки"
          className="mt-3 block w-full rounded-lg border-[1.5px] border-dashed border-accent-bright bg-surface px-4 py-2.5 text-center text-sm font-semibold text-accent-bright transition-colors hover:bg-accent-soft"
        >
          ＋ Добор (артикул не из заявки)
        </button>

        {addonOpen && (
          <AddonSearch
            sessionId={sessionId}
            bookingId={state.bookingId}
            bookingNo={state.bookingId ? displayNo(state.bookingId) : undefined}
            onAdded={handleAddonAdded}
            onClose={() => setAddonOpen(false)}
          />
        )}
      </div>

      {/* Sticky «Завершить выдачу» footer (mockup .ph-bottom). */}
      <div className="sticky bottom-0 border-t border-border bg-surface px-2.5 py-3 lg:px-4">
        <button
          type="button"
          onClick={() => setPhase("summary")}
          aria-label={`Завершить выдачу — ${projectName || "бронь"}`}
          className="block w-full rounded-lg bg-accent px-4 py-3 text-center text-sm font-semibold text-white transition-colors hover:opacity-95"
        >
          Завершить выдачу →
        </button>
      </div>
    </div>
  );
}
