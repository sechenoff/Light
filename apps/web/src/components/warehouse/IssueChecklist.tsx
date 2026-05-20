"use client";

/**
 * ISSUE checklist — the operator's per-unit "выдача" screen.
 *
 * Visual source of truth: mockup `03-issue-and-desktop.html`
 *  - block 2 (mobile): «✓ Выдать всё разом» primary bar → category groups →
 *    per-row 2-segment control → «＋ Добор» dashed bar → sticky
 *    «Завершить выдачу» footer. NEVER a barcode — name + «прибор N из M».
 *  - block 4 (desktop, right pane): a heading line «Чек-лист выдачи · N / M ✓»
 *    with an inline «＋ Добор» chip, wider rows, same logic.
 *
 * Data: `useScanSession` (already wired upstream by page.tsx — operation ISSUE).
 *  - UNIT items: one row per unit; outcome persisted via the hook's optimistic
 *    `check` / `uncheck` (server-authoritative on tap-confirm, per-id in-flight
 *    guard). «выдано» → check(unitId); back to neutral → uncheck(unitId).
 *  - COUNT items: the server is client-managed (always `checkedQty: 0`, no
 *    `units[]`). All-or-nothing per line, tracked in local state — consistent
 *    with how `checklistService` treats COUNT.
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
import { UnitRow } from "./UnitRow";
import { AddonSearch } from "./AddonSearch";
import type { IssueValue } from "./UnitRow";
import type { ChecklistItem, ChecklistState } from "./types";
import { pluralize } from "../../lib/format";
import { scanApi } from "./api";
import type { CompleteResult, SummaryResult } from "./types";
import { IssueResultView } from "./IssueResultView";

/** «#» + последние 6 символов id брони, в верхнем регистре (как в BookingList). */
function displayNo(id: string): string {
  return "#" + id.slice(-6).toUpperCase();
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

/** Checked-progress «N / M» across UNIT units + locally-issued COUNT lines. */
function computeProgress(
  state: ChecklistState,
  countIssued: ReadonlySet<string>,
): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const item of state.items) {
    if (item.trackingMode === "UNIT" && item.units) {
      total += item.units.length;
      done += item.units.filter((u) => u.checked).length;
    } else {
      total += 1;
      if (countIssued.has(item.bookingItemId)) done += 1;
    }
  }
  return { done, total };
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
  const { state, loading, error, openSession, check, uncheck, refresh } =
    session;

  // COUNT lines are client-managed (no per-unit ids server-side).
  const [countIssued, setCountIssued] = useState<Set<string>>(new Set());
  // Inline Добор catalog search.
  const [addonOpen, setAddonOpen] = useState(false);
  // Disables «Завершить» momentarily while the bulk action fans out.
  const [bulkBusy, setBulkBusy] = useState(false);

  // ── Outcome state for the сверка (Phase 2 wires the UI / Phase 3 the submit). ──
  // COUNT lines explicitly marked ✗ (different from "untouched"); mirrors
  // countIssued.
  const [countWithheld, setCountWithheld] = useState<Set<string>>(new Set());
  // UNIT units explicitly marked ✗ (WITHHELD).
  const [withheldUnits, setWithheldUnits] = useState<Set<string>>(new Set());
  // bookingItemIds of доборы added with acknowledgedConflict=true.
  const [conflictAddons, setConflictAddons] = useState<Set<string>>(new Set());

  // ── Phase machine (lives inside this component — no outer step). ─────────────
  const [phase, setPhase] = useState<IssuePhase>("checklist");
  const [summary, setSummary] = useState<SummaryResult | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
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

  const progress = useMemo(
    () => (state ? computeProgress(state, countIssued) : { done: 0, total: 0 }),
    [state, countIssued],
  );

  function setCount(bookingItemId: string, next: IssueValue) {
    setCountIssued((prev) => {
      const n = new Set(prev);
      if (next === "ISSUED") n.add(bookingItemId);
      else n.delete(bookingItemId);
      return n;
    });
    setCountWithheld((prev) => {
      const n = new Set(prev);
      if (next === "WITHHELD") n.add(bookingItemId);
      else n.delete(bookingItemId);
      return n;
    });
  }

  // «Выдать всё разом» — mark every UNIT unit ✓ (the hook's per-id guard
  // dedupes concurrent toggles) and every COUNT line issued.
  async function issueAll() {
    if (!state || bulkBusy) return;
    setBulkBusy(true);
    try {
      const allCountIds = state.items
        .filter((i) => i.trackingMode !== "UNIT" || !i.units)
        .map((i) => i.bookingItemId);
      setCountIssued(new Set(allCountIds));
      setCountWithheld(new Set());
      setWithheldUnits(new Set());

      const pending: Promise<void>[] = [];
      for (const item of state.items) {
        if (item.trackingMode !== "UNIT" || !item.units) continue;
        for (const u of item.units) {
          if (!u.checked) {
            pending.push(check(u.unitId).catch(() => undefined));
          }
        }
      }
      await Promise.all(pending);
    } finally {
      setBulkBusy(false);
    }
  }

  function handleUnitChange(unitId: string, next: IssueValue) {
    // Three-way: ISSUED ⇒ persist via hook, WITHHELD ⇒ ✗-set,
    // null ⇒ clear both (server-side uncheck + local ✗-set delete).
    if (next === "ISSUED") {
      setWithheldUnits((prev) => {
        if (!prev.has(unitId)) return prev;
        const n = new Set(prev);
        n.delete(unitId);
        return n;
      });
      void check(unitId).catch(() => undefined);
      return;
    }
    if (next === "WITHHELD") {
      // Make sure it's NOT checked server-side either.
      void uncheck(unitId).catch(() => undefined);
      setWithheldUnits((prev) => {
        if (prev.has(unitId)) return prev;
        const n = new Set(prev);
        n.add(unitId);
        return n;
      });
      return;
    }
    // null — neutral.
    setWithheldUnits((prev) => {
      if (!prev.has(unitId)) return prev;
      const n = new Set(prev);
      n.delete(unitId);
      return n;
    });
    void uncheck(unitId).catch(() => undefined);
  }

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
          onClick={issueAll}
          disabled={bulkBusy}
          aria-label="Выдать всё разом — отметить все позиции выданными"
          className="mb-3 block w-full rounded-lg bg-accent-bright px-4 py-3 text-center text-sm font-semibold text-white transition-colors hover:opacity-95 disabled:opacity-60"
        >
          ✓ Выдать всё разом
        </button>

        {groups.map((group) => (
          <section key={group.category} className="mb-1">
            <p className="eyebrow px-1.5 pb-1 pt-2">{group.category}</p>
            <div className="space-y-1.5">
              {group.items.map((item) => {
                if (item.trackingMode === "UNIT" && item.units) {
                  const total = item.units.length;
                  return item.units.map((u, idx) => {
                    const value: IssueValue = u.checked
                      ? "ISSUED"
                      : withheldUnits.has(u.unitId)
                        ? "WITHHELD"
                        : null;
                    return (
                      <UnitRow
                        key={u.unitId}
                        name={item.equipmentName}
                        ordinalLabel={`прибор ${idx + 1} из ${total}`}
                        mode="ISSUE"
                        value={value}
                        onChange={(next) => handleUnitChange(u.unitId, next)}
                        disabled={bulkBusy}
                      />
                    );
                  });
                }
                // COUNT line — all-or-nothing, ×N quantity label.
                const value: IssueValue = countIssued.has(item.bookingItemId)
                  ? "ISSUED"
                  : countWithheld.has(item.bookingItemId)
                    ? "WITHHELD"
                    : null;
                return (
                  <UnitRow
                    key={item.bookingItemId}
                    name={item.equipmentName}
                    ordinalLabel={`×${item.quantity}`}
                    mode="ISSUE"
                    value={value}
                    onChange={(next) => setCount(item.bookingItemId, next)}
                    disabled={bulkBusy}
                  />
                );
              })}
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
          onClick={() => onComplete?.()}
          disabled={bulkBusy}
          aria-label={`Завершить выдачу — ${projectName || "бронь"}`}
          className="block w-full rounded-lg bg-accent px-4 py-3 text-center text-sm font-semibold text-white transition-colors hover:opacity-95 disabled:opacity-60"
        >
          Завершить выдачу →
        </button>
        {/* TODO(Task 7/8): wire issue completion (POST /complete) — this only
            advances the flow; completion semantics live in the summary task. */}
      </div>
    </div>
  );
}
