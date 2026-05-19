"use client";

/**
 * RETURN checklist — the operator's per-unit «приёмка» (3-outcome) screen.
 *
 * Visual source of truth: docs/mockups/warehouse-scan/01-return-checklist.html
 *  - «✓ Принять всё разом» primary bar → category groups → per-unit row with
 *    the 3-segment control (✓ Принято / 🔧 Ремонт / ✗ Проблема) → inline
 *    expanded AMBER RepairPanel / ROSE ProblemPanel → sticky
 *    «Завершить приёмку →» footer. NEVER a barcode — name + «прибор N из M».
 *  - On success: a canon RESULT view (counts + a rose warning if anything
 *    failed) with a «Готово» action back to the bookings list.
 *
 * Data: `useScanSession` (operation RETURN). Loading/error/empty canon+Russian.
 *  - UNIT items: one row per unit. The outcome is local state OWNED here
 *    (`outcomes` map). ACCEPTED also marks the unit returned via the hook's
 *    optimistic `check` (server-authoritative, per-id in-flight guard — we do
 *    NOT bypass it). REPAIR/PROBLEM are sent in the single `/complete` POST.
 *  - COUNT items: server is client-managed (`checkedQty: 0`, no `units[]`);
 *    all-or-nothing accept, tracked locally — mirrors IssueChecklist + the
 *    checklistService COUNT semantics. COUNT lines can only be ACCEPTED.
 *
 * Panels are CONTROLLED — this component owns the comment / reason / date in
 * the `outcomes` map and feeds them down, so it can validate "comment required
 * per flagged row" BEFORE the POST.
 *
 * ⚠ expectedBackDate WIRE-FORMAT TRAP (cross-task, Task 7.1 review Issue #1):
 * ProblemPanel emits a bare `YYYY-MM-DD`. The backend Zod for
 * `problemUnits[].expectedBackDate` is `z.string().datetime()` — it REQUIRES
 * full ISO-8601 and REJECTS a bare date. THIS component owns the conversion:
 * `new Date(`${d}T00:00:00.000Z`).toISOString()`, applied ONLY when
 * `reason === "LEFT_ON_SITE"` and a date is present; the field is omitted
 * otherwise.
 *
 * NOTE: there is NO `invoiceNeedsReissue` in the response (removed in Task
 * 2.2) — we do not reference it.
 */

import { useEffect, useMemo, useState } from "react";
import { useScanSession } from "./useScanSession";
import { scanApi } from "./api";
import { UnitRow } from "./UnitRow";
import { RepairPanel } from "./RepairPanel";
import { ProblemPanel } from "./ProblemPanel";
import { isScanApiError } from "./types";
import type {
  ChecklistItem,
  ChecklistState,
  CompletePayload,
  CompleteResult,
  ProblemReason,
  ProblemUnitInput,
  RepairUnitInput,
  ReturnOutcome,
} from "./types";
import { pluralize } from "../../lib/format";

// ── Local outcome state ──────────────────────────────────────────────────────

interface ProblemDraft {
  reason: ProblemReason | null;
  comment: string;
  /** Bare `YYYY-MM-DD` (raw <input type="date">), null unless LEFT_ON_SITE. */
  expectedBackDate: string | null;
}

interface UnitOutcome {
  outcome: ReturnOutcome;
  /** Present (controlled) when outcome === "REPAIR". */
  repairComment?: string;
  /** Present (controlled) when outcome === "PROBLEM". */
  problem?: ProblemDraft;
}

type OutcomeMap = Record<string, UnitOutcome>;

interface CategoryGroup {
  category: string;
  items: ChecklistItem[];
}

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
  return order.map((category) => ({ category, items: map.get(category)! }));
}

/** Every UNIT unit id across the checklist (one row each). */
function allUnitIds(state: ChecklistState): string[] {
  const ids: string[] = [];
  for (const item of state.items) {
    if (item.trackingMode === "UNIT" && item.units) {
      for (const u of item.units) ids.push(u.unitId);
    }
  }
  return ids;
}

/** COUNT-line bookingItemIds (no per-unit ids server-side). */
function allCountLineIds(state: ChecklistState): string[] {
  return state.items
    .filter((i) => i.trackingMode !== "UNIT" || !i.units)
    .map((i) => i.bookingItemId);
}

/**
 * ISO-8601 upgrade for the backend Zod (`z.string().datetime()`).
 * Bare `YYYY-MM-DD` → midnight-UTC ISO. Returns undefined when the date is
 * absent or not a clean calendar date (defensive — never POST a bad value).
 */
function toIsoDatetime(bareDate: string | null | undefined): string | undefined {
  if (!bareDate) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(bareDate)) return undefined;
  const d = new Date(`${bareDate}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

// ── Component ────────────────────────────────────────────────────────────────

export function ReturnChecklist({
  sessionId,
  projectName,
  onBack,
  onDone,
}: {
  sessionId: string;
  projectName: string;
  onBack: () => void;
  /** Back to the bookings list after a completed приёмка. */
  onDone?: () => void;
}) {
  const session = useScanSession();
  const { state, loading, error, openSession, check } = session;

  // Per-unit outcome map — OWNED here (panels are controlled).
  const [outcomes, setOutcomes] = useState<OutcomeMap>({});
  // COUNT lines accepted locally (no server unit ids).
  const [countAccepted, setCountAccepted] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Per-row validation messages (keyed by unit id) + a summary line.
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [validationSummary, setValidationSummary] = useState<string | null>(
    null,
  );
  // Completion result → switches the whole panel to the RESULT view.
  const [result, setResult] = useState<CompleteResult | null>(null);

  // Bind the hook to the upstream-opened session; cancellation-safe.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await openSession(sessionId, "RETURN");
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

  const unitIds = useMemo(() => (state ? allUnitIds(state) : []), [state]);

  // ── Outcome mutations ──────────────────────────────────────────────────────

  function clearRowError(unitId: string) {
    setRowErrors((prev) => {
      if (!(unitId in prev)) return prev;
      const next = { ...prev };
      delete next[unitId];
      return next;
    });
  }

  function setUnitOutcome(unitId: string, next: ReturnOutcome) {
    clearRowError(unitId);
    setOutcomes((prev) => {
      const existing = prev[unitId];
      if (next === "REPAIR") {
        return {
          ...prev,
          [unitId]: {
            outcome: "REPAIR",
            repairComment: existing?.repairComment ?? "",
          },
        };
      }
      if (next === "PROBLEM") {
        return {
          ...prev,
          [unitId]: {
            outcome: "PROBLEM",
            problem:
              existing?.problem ??
              ({ reason: null, comment: "", expectedBackDate: null } as ProblemDraft),
          },
        };
      }
      // ACCEPTED — drop any repair/problem draft for this unit.
      return { ...prev, [unitId]: { outcome: "ACCEPTED" } };
    });

    // ACCEPTED also marks the unit returned through the hook's optimistic
    // `check` (per-id in-flight guard — we never bypass it).
    if (next === "ACCEPTED") {
      void check(unitId).catch(() => undefined);
    }
  }

  function setRepairComment(unitId: string, comment: string) {
    clearRowError(unitId);
    setOutcomes((prev) => {
      const ex = prev[unitId];
      if (!ex || ex.outcome !== "REPAIR") return prev;
      return { ...prev, [unitId]: { ...ex, repairComment: comment } };
    });
  }

  function patchProblem(unitId: string, patch: Partial<ProblemDraft>) {
    clearRowError(unitId);
    setOutcomes((prev) => {
      const ex = prev[unitId];
      if (!ex || ex.outcome !== "PROBLEM") return prev;
      const base: ProblemDraft = ex.problem ?? {
        reason: null,
        comment: "",
        expectedBackDate: null,
      };
      return {
        ...prev,
        [unitId]: { ...ex, problem: { ...base, ...patch } },
      };
    });
  }

  function setCountLine(bookingItemId: string, accepted: boolean) {
    setCountAccepted((prev) => {
      const next = new Set(prev);
      if (accepted) next.add(bookingItemId);
      else next.delete(bookingItemId);
      return next;
    });
  }

  // «Принять всё разом» — every UNIT unit ACCEPTED (hook guard dedupes) and
  // every COUNT line accepted. Mirrors IssueChecklist.issueAll.
  async function acceptAll() {
    if (!state || bulkBusy || submitting) return;
    setBulkBusy(true);
    try {
      setCountAccepted(new Set(allCountLineIds(state)));
      setOutcomes((prev) => {
        const next: OutcomeMap = { ...prev };
        for (const id of allUnitIds(state)) next[id] = { outcome: "ACCEPTED" };
        return next;
      });
      setRowErrors({});
      setValidationSummary(null);

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

  // ── Validation + completion ────────────────────────────────────────────────

  function validate(): boolean {
    if (!state) return false;
    const errs: Record<string, string> = {};

    for (const id of unitIds) {
      const o = outcomes[id];
      if (!o) {
        errs[id] = "Выберите исход: принято, ремонт или проблема";
        continue;
      }
      if (o.outcome === "REPAIR") {
        if (!o.repairComment || o.repairComment.trim() === "") {
          errs[id] = "Опишите, что сломалось";
        }
      } else if (o.outcome === "PROBLEM") {
        const p = o.problem;
        if (!p || !p.reason) {
          errs[id] = "Выберите причину проблемы";
        } else if (!p.comment || p.comment.trim() === "") {
          errs[id] = "Добавьте комментарий к проблеме";
        }
      }
    }

    setRowErrors(errs);
    const count = Object.keys(errs).length;
    if (count > 0) {
      setValidationSummary(
        `Не заполнено ${count} ${pluralize(count, "позиция", "позиции", "позиций")} — проверьте отмеченные строки`,
      );
      return false;
    }
    setValidationSummary(null);
    return true;
  }

  function buildPayload(): CompletePayload {
    const repairUnits: RepairUnitInput[] = [];
    const problemUnits: ProblemUnitInput[] = [];

    for (const id of unitIds) {
      const o = outcomes[id];
      if (!o) continue;
      if (o.outcome === "REPAIR") {
        // urgency intentionally omitted — backend defaults NORMAL.
        repairUnits.push({
          equipmentUnitId: id,
          comment: (o.repairComment ?? "").trim(),
        });
      } else if (o.outcome === "PROBLEM" && o.problem && o.problem.reason) {
        const entry: ProblemUnitInput = {
          equipmentUnitId: id,
          reason: o.problem.reason,
          comment: o.problem.comment.trim(),
        };
        // ISO conversion ONLY for LEFT_ON_SITE with a date present; the
        // backend Zod rejects a bare YYYY-MM-DD (z.string().datetime()).
        if (o.problem.reason === "LEFT_ON_SITE") {
          const iso = toIsoDatetime(o.problem.expectedBackDate);
          if (iso) entry.expectedBackDate = iso;
        }
        problemUnits.push(entry);
      }
      // ACCEPTED units are already reflected by the hook's check() calls —
      // they are NOT sent in repair/problem arrays.
    }

    const payload: CompletePayload = {};
    if (repairUnits.length > 0) payload.repairUnits = repairUnits;
    if (problemUnits.length > 0) payload.problemUnits = problemUnits;
    return payload;
  }

  async function handleComplete() {
    if (submitting || bulkBusy) return;
    setSubmitError(null);
    if (!validate()) return;
    setSubmitting(true);
    try {
      const payload = buildPayload();
      const res = await scanApi.complete(sessionId, payload);
      setResult(res);
    } catch (err: unknown) {
      setSubmitError(
        isScanApiError(err)
          ? err.message
          : "Не удалось завершить приёмку — попробуйте ещё раз",
      );
    } finally {
      setSubmitting(false);
    }
  }

  // ── RESULT view ────────────────────────────────────────────────────────────

  if (result) {
    const acceptedCount =
      result.scannedCount -
      (result.createdRepairIds?.length ?? 0) -
      (result.createdProblemItemIds?.length ?? 0);
    const repairCount = result.createdRepairIds?.length ?? 0;
    const problemCount = result.createdProblemItemIds?.length ?? 0;
    const failed = [
      ...(result.failedBrokenUnits ?? []),
      ...(result.failedProblemUnits ?? []),
    ];

    return (
      <div className="flex min-h-full flex-1 flex-col">
        <div className="flex-1 px-3 pb-6 pt-5 lg:px-5">
          <div className="mx-auto w-full max-w-[460px]">
            <div className="rounded-lg border border-emerald-border bg-emerald-soft px-4 py-4 text-center">
              <p className="text-3xl leading-none" aria-hidden="true">
                ✓
              </p>
              <h2 className="mt-2 text-[17px] font-semibold text-ink">
                Приёмка завершена
              </h2>
              <p className="mt-1 text-[13px] text-ink-2">
                {projectName || "Бронь"}
              </p>
            </div>

            <dl className="mt-3 space-y-1.5">
              <div className="flex items-center justify-between rounded-lg border border-border bg-surface px-3 py-2.5">
                <dt className="text-[13px] text-ink-2">Принято</dt>
                <dd className="mono-num text-[15px] font-semibold text-emerald">
                  {Math.max(0, acceptedCount)}
                </dd>
              </div>
              <div className="flex items-center justify-between rounded-lg border border-border bg-surface px-3 py-2.5">
                <dt className="text-[13px] text-ink-2">На ремонт</dt>
                <dd className="mono-num text-[15px] font-semibold text-amber">
                  {repairCount}
                  <span className="ml-1 text-[11px] font-normal text-ink-3">
                    (карточек: {repairCount})
                  </span>
                </dd>
              </div>
              <div className="flex items-center justify-between rounded-lg border border-border bg-surface px-3 py-2.5">
                <dt className="text-[13px] text-ink-2">В «Потеряшки»</dt>
                <dd className="mono-num text-[15px] font-semibold text-rose">
                  {problemCount}
                  <span className="ml-1 text-[11px] font-normal text-ink-3">
                    (заявок: {problemCount})
                  </span>
                </dd>
              </div>
            </dl>

            {failed.length > 0 && (
              <div
                role="alert"
                className="mt-3 rounded-lg border border-rose-border bg-rose-soft px-3 py-3"
              >
                <p className="text-[13px] font-semibold text-rose">
                  Не удалось обработать {failed.length}{" "}
                  {pluralize(failed.length, "единицу", "единицы", "единиц")} —
                  проверьте вручную
                </p>
                <ul className="mt-1.5 space-y-1">
                  {failed.map((f) => (
                    <li
                      key={`${f.unitId}-${f.reason}`}
                      className="text-[12px] leading-snug text-rose"
                    >
                      • {f.reason}: {f.error}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>

        <div className="sticky bottom-0 border-t border-border bg-surface px-3 py-3 lg:px-5">
          <button
            type="button"
            onClick={() => (onDone ? onDone() : onBack())}
            aria-label="Готово — вернуться к списку броней"
            className="block w-full rounded-lg bg-accent px-4 py-3 text-center text-sm font-semibold text-white transition-colors hover:opacity-95"
          >
            Готово
          </button>
        </div>
      </div>
    );
  }

  // ── Loading / error / empty ────────────────────────────────────────────────

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
          {error.message || "Не удалось загрузить чек-лист приёмки"}
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
          В этой брони нет позиций для приёмки
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

  const interactionsDisabled = bulkBusy || submitting;

  // ── Main checklist ─────────────────────────────────────────────────────────

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <div className="flex-1 px-2.5 pb-4 pt-3 lg:px-4">
        {/* Desktop heading (analog of mockup block 4 right pane). */}
        <div className="mb-2 hidden items-center gap-3 px-1 lg:flex">
          <h2 className="text-[15px] font-semibold text-ink">
            Чек-лист приёмки
          </h2>
        </div>

        {/* «Принять всё разом» — primary bar (mockup .ph-acceptall). */}
        <button
          type="button"
          onClick={acceptAll}
          disabled={interactionsDisabled}
          aria-label="Принять всё разом — отметить все позиции принятыми"
          className="mb-3 block w-full rounded-lg bg-accent-bright px-4 py-3 text-center text-sm font-semibold text-white transition-colors hover:opacity-95 disabled:opacity-60"
        >
          ✓ Принять всё разом
        </button>

        {groups.map((group) => (
          <section key={group.category} className="mb-1">
            <p className="eyebrow px-1.5 pb-1 pt-2">{group.category}</p>
            <div className="space-y-1.5">
              {group.items.map((item) => {
                if (item.trackingMode === "UNIT" && item.units) {
                  const total = item.units.length;
                  return item.units.map((u, idx) => {
                    const o = outcomes[u.unitId];
                    const rowError = rowErrors[u.unitId];
                    return (
                      <div key={u.unitId} className="space-y-1.5">
                        <UnitRow
                          name={item.equipmentName}
                          ordinalLabel={`прибор ${idx + 1} из ${total}`}
                          mode="RETURN"
                          value={o?.outcome ?? null}
                          onChange={(next) =>
                            setUnitOutcome(u.unitId, next)
                          }
                          disabled={interactionsDisabled}
                        />

                        {o?.outcome === "REPAIR" && (
                          <RepairPanel
                            sessionId={sessionId}
                            unitId={u.unitId}
                            comment={o.repairComment ?? ""}
                            onCommentChange={(s) =>
                              setRepairComment(u.unitId, s)
                            }
                            disabled={interactionsDisabled}
                          />
                        )}

                        {o?.outcome === "PROBLEM" && (
                          <ProblemPanel
                            reason={o.problem?.reason ?? null}
                            onReasonChange={(r) =>
                              patchProblem(u.unitId, { reason: r })
                            }
                            comment={o.problem?.comment ?? ""}
                            onCommentChange={(s) =>
                              patchProblem(u.unitId, { comment: s })
                            }
                            expectedBackDate={
                              o.problem?.expectedBackDate ?? null
                            }
                            onExpectedBackDateChange={(d) =>
                              patchProblem(u.unitId, { expectedBackDate: d })
                            }
                            disabled={interactionsDisabled}
                          />
                        )}

                        {rowError && (
                          <p
                            role="alert"
                            className="rounded-md border border-rose-border bg-rose-soft px-2.5 py-1.5 text-[12px] text-rose"
                          >
                            {rowError}
                          </p>
                        )}
                      </div>
                    );
                  });
                }
                // COUNT line — accept-only, ×N quantity label.
                const accepted = countAccepted.has(item.bookingItemId);
                return (
                  <UnitRow
                    key={item.bookingItemId}
                    name={item.equipmentName}
                    ordinalLabel={`×${item.quantity}`}
                    mode="RETURN"
                    value={accepted ? "ACCEPTED" : null}
                    onChange={(next) =>
                      setCountLine(
                        item.bookingItemId,
                        next === "ACCEPTED",
                      )
                    }
                    disabled={interactionsDisabled}
                  />
                );
              })}
            </div>
          </section>
        ))}
      </div>

      {/* Sticky «Завершить приёмку →» footer (mockup .ph-bottom). */}
      <div className="sticky bottom-0 border-t border-border bg-surface px-2.5 py-3 lg:px-4">
        {validationSummary && (
          <p
            role="alert"
            className="mb-2 rounded-md border border-rose-border bg-rose-soft px-3 py-2 text-[12px] text-rose"
          >
            {validationSummary}
          </p>
        )}
        {submitError && (
          <p
            role="alert"
            className="mb-2 rounded-md border border-rose-border bg-rose-soft px-3 py-2 text-[12px] text-rose"
          >
            {submitError}
          </p>
        )}
        <button
          type="button"
          onClick={handleComplete}
          disabled={interactionsDisabled}
          aria-label={`Завершить приёмку — ${projectName || "бронь"}`}
          className="block w-full rounded-lg bg-accent px-4 py-3 text-center text-sm font-semibold text-white transition-colors hover:opacity-95 disabled:opacity-60"
        >
          {submitting ? "Завершаем…" : "Завершить приёмку →"}
        </button>
      </div>
    </div>
  );
}
