"use client";

/**
 * Per-unit return row (variant D from the 2026-05-23 mockup session).
 *
 * Replaces CountSplitRow for COUNT-mode positions on /warehouse/scan?RETURN.
 *
 * UX shape:
 *  - Header: equipment name + ×N + bucket-pills (✓ 3, 🔧 1, ✗ 0).
 *  - Grid of N numbered chips. Each chip cycles status on tap:
 *      пусто → ✓ принят → 🔧 ремонт → ✗ проблема → пусто
 *  - When a chip is in 🔧 or ✗, a per-unit inline card appears below
 *    the chip strip with a dedicated textarea (and, for problems, a
 *    reason picker + expectedBackDate).
 *  - «✓ Принять все» bulk-action sets every chip to ACCEPTED.
 *  - Accepted chips are compact (1 character). Unaccepted ones stay
 *    expanded inline. This keeps a ×10 row tight when everything is OK.
 *
 * Pure / controlled — parent owns `units` state. Touch targets ≥ 40px.
 * Russian aria-labels on every interactive element; emoji decorative.
 *
 * Backend contract: payload builder in ReturnChecklist emits ONE entry
 * per non-accepted unit (quantity:1 each, own comment). Backend's
 * `INVALID_SPLIT` validation groups by bookingItemId and sums — so as
 * long as accepted+repair+problem ≤ totalQty, the multi-entry path is fine.
 */

import type { ProblemDraft, ProblemReason } from "./types";

export type UnitStatus = "PENDING" | "ACCEPTED" | "REPAIR" | "PROBLEM";

export interface UnitSlot {
  /** 1-based index within the row, used for display labels («#1»). */
  index: number;
  status: UnitStatus;
  /** Comment for this specific unit when status is REPAIR. */
  repairComment: string;
  /** Problem draft for this specific unit when status is PROBLEM. */
  problem: ProblemDraft;
}

const REASON_LABEL: Record<ProblemReason, string> = {
  LEFT_ON_SITE: "Оставлен на площадке",
  LOST: "Потерян",
  DESTROYED: "Сломан безвозвратно",
  STOLEN: "Украден",
};

/** Cycle order: PENDING → ACCEPTED → REPAIR → PROBLEM → PENDING. */
function nextStatus(s: UnitStatus): UnitStatus {
  switch (s) {
    case "PENDING":
      return "ACCEPTED";
    case "ACCEPTED":
      return "REPAIR";
    case "REPAIR":
      return "PROBLEM";
    case "PROBLEM":
      return "PENDING";
  }
}

function statusLabel(s: UnitStatus): string {
  return s === "ACCEPTED"
    ? "принят"
    : s === "REPAIR"
      ? "в ремонт"
      : s === "PROBLEM"
        ? "проблема"
        : "ожидает";
}

interface Props {
  name: string;
  totalQty: number;
  /** Length === totalQty; one slot per physical unit. */
  units: UnitSlot[];
  disabled: boolean;
  /**
   * Cycle the unit's status by 1 step in the order PENDING → ACCEPTED → REPAIR
   * → PROBLEM → PENDING. Parent handles the actual state mutation.
   */
  onCycle: (unitIndex: number) => void;
  /** Bulk-accept all units of this row (sets every slot to ACCEPTED). */
  onAcceptAll: () => void;
  onRepairCommentChange: (unitIndex: number, comment: string) => void;
  onProblemPatch: (unitIndex: number, patch: Partial<ProblemDraft>) => void;
  /** Row-level error message (e.g. «Заполните комментарий ремонта»). */
  rowError?: string | null;
}

export function UnitGridRow({
  name,
  totalQty,
  units,
  disabled,
  onCycle,
  onAcceptAll,
  onRepairCommentChange,
  onProblemPatch,
  rowError,
}: Props) {
  const accepted = units.filter((u) => u.status === "ACCEPTED").length;
  const repair = units.filter((u) => u.status === "REPAIR").length;
  const problem = units.filter((u) => u.status === "PROBLEM").length;
  const pending = totalQty - accepted - repair - problem;

  const allAccepted = accepted === totalQty;
  const hasIssue = repair > 0 || problem > 0;

  let railClass = "border-l-4 border-transparent";
  if (problem > 0) railClass = "border-l-4 border-rose";
  else if (repair > 0) railClass = "border-l-4 border-amber";
  else if (allAccepted) railClass = "border-l-4 border-emerald";

  let bgClass = "bg-surface";
  if (problem > 0) bgClass = "bg-rose-soft/30";
  else if (repair > 0) bgClass = "bg-amber-soft/30";
  else if (allAccepted) bgClass = "bg-emerald-soft/30";

  return (
    <div className={`rounded-lg border border-border p-3 ${railClass} ${bgClass}`}>
      {/* Header — name + bucket pills + bulk-accept */}
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-ink">{name}</div>
          <div className="mt-0.5 text-[11px] text-ink-3">
            ×{totalQty}
            {pending > 0 ? ` · осталось пометить ${pending}` : ""}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {accepted > 0 && (
            <span
              aria-label={`Принято ${accepted}`}
              className="rounded-full bg-emerald-soft px-2 py-0.5 text-[11px] font-semibold text-emerald"
            >
              <span aria-hidden="true">✓</span> {accepted}
            </span>
          )}
          {repair > 0 && (
            <span
              aria-label={`В ремонт ${repair}`}
              className="rounded-full bg-amber-soft px-2 py-0.5 text-[11px] font-semibold text-amber"
            >
              <span aria-hidden="true">🔧</span> {repair}
            </span>
          )}
          {problem > 0 && (
            <span
              aria-label={`Проблема ${problem}`}
              className="rounded-full bg-rose-soft px-2 py-0.5 text-[11px] font-semibold text-rose"
            >
              <span aria-hidden="true">✗</span> {problem}
            </span>
          )}
          {!allAccepted && !hasIssue && (
            <button
              type="button"
              onClick={onAcceptAll}
              disabled={disabled}
              aria-label={`Принять все ${totalQty} шт «${name}» без замечаний`}
              className="h-8 rounded border border-emerald-border bg-surface px-2 text-[11px] font-semibold text-emerald hover:bg-emerald-soft disabled:opacity-40"
            >
              ✓ Все
            </button>
          )}
        </div>
      </div>

      {/* Unit chips grid */}
      <div className="flex flex-wrap gap-1.5">
        {units.map((u) => {
          const isPending = u.status === "PENDING";
          const isAccepted = u.status === "ACCEPTED";
          const isRepair = u.status === "REPAIR";
          const isProblem = u.status === "PROBLEM";

          let chipClass =
            "border-border-strong bg-surface text-ink-2 hover:bg-surface-muted";
          if (isAccepted)
            chipClass = "border-emerald bg-emerald text-white hover:opacity-95";
          else if (isRepair)
            chipClass = "border-amber bg-amber text-white hover:opacity-95";
          else if (isProblem)
            chipClass = "border-rose bg-rose text-white hover:opacity-95";

          return (
            <button
              key={u.index}
              type="button"
              onClick={() => onCycle(u.index)}
              disabled={disabled}
              aria-label={`«${name}» юнит #${u.index} — ${statusLabel(u.status)}. Тап циклит статус.`}
              className={`flex h-10 min-w-[40px] items-center justify-center gap-1 rounded-md border-2 px-2 text-[12px] font-semibold transition-colors disabled:opacity-50 ${chipClass}`}
            >
              <span className="font-mono">{u.index}</span>
              {isPending && (
                <span aria-hidden="true" className="text-[10px] opacity-60">
                  ○
                </span>
              )}
              {isAccepted && <span aria-hidden="true">✓</span>}
              {isRepair && <span aria-hidden="true">🔧</span>}
              {isProblem && <span aria-hidden="true">✗</span>}
            </button>
          );
        })}
      </div>

      {/* Per-unit inline cards for REPAIR / PROBLEM */}
      {units
        .filter((u) => u.status === "REPAIR" || u.status === "PROBLEM")
        .map((u) => (
          <div
            key={u.index}
            className={`mt-2 rounded-md border-l-4 px-3 py-2 text-[12px] ${
              u.status === "REPAIR"
                ? "border-amber bg-amber-soft/50"
                : "border-rose bg-rose-soft/50"
            }`}
          >
            <div className="mb-1.5 flex items-center justify-between">
              <span
                className={`text-[11px] font-semibold ${
                  u.status === "REPAIR" ? "text-amber" : "text-rose"
                }`}
              >
                <span aria-hidden="true">
                  {u.status === "REPAIR" ? "🔧" : "✗"}
                </span>{" "}
                «{name}» юнит #{u.index} —{" "}
                {u.status === "REPAIR" ? "ремонт" : "проблема"}
              </span>
            </div>

            {u.status === "REPAIR" && (
              <textarea
                value={u.repairComment}
                onChange={(e) =>
                  onRepairCommentChange(u.index, e.target.value)
                }
                disabled={disabled}
                aria-label={`Комментарий ремонта — юнит #${u.index} «${name}»`}
                rows={2}
                className="w-full rounded border border-border-strong bg-surface px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-amber"
                placeholder="Что сломано, что починить"
              />
            )}

            {u.status === "PROBLEM" && (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-2">
                  <select
                    value={u.problem.reason ?? ""}
                    onChange={(e) =>
                      onProblemPatch(u.index, {
                        reason: (e.target.value ||
                          null) as ProblemReason | null,
                      })
                    }
                    disabled={disabled}
                    aria-label={`Причина проблемы — юнит #${u.index} «${name}»`}
                    className="rounded border border-border bg-surface px-2 py-1 text-[12px]"
                  >
                    <option value="">— причина —</option>
                    <option value="LOST">{REASON_LABEL.LOST}</option>
                    <option value="DESTROYED">{REASON_LABEL.DESTROYED}</option>
                    <option value="STOLEN">{REASON_LABEL.STOLEN}</option>
                    <option value="LEFT_ON_SITE">
                      {REASON_LABEL.LEFT_ON_SITE}
                    </option>
                  </select>
                  {u.problem.reason === "LEFT_ON_SITE" && (
                    <input
                      type="date"
                      value={u.problem.expectedBackDate ?? ""}
                      onChange={(e) =>
                        onProblemPatch(u.index, {
                          expectedBackDate: e.target.value || null,
                        })
                      }
                      disabled={disabled}
                      aria-label={`Дата ожидаемого возврата — юнит #${u.index} «${name}»`}
                      className="rounded border border-border bg-surface px-2 py-1 text-[12px]"
                    />
                  )}
                </div>
                <textarea
                  value={u.problem.comment}
                  onChange={(e) =>
                    onProblemPatch(u.index, { comment: e.target.value })
                  }
                  disabled={disabled}
                  aria-label={`Комментарий проблемы — юнит #${u.index} «${name}»`}
                  rows={2}
                  className="w-full rounded border border-border-strong bg-surface px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-rose"
                  placeholder="Что случилось"
                />
              </div>
            )}
          </div>
        ))}

      {rowError && (
        <p
          role="alert"
          className="mt-2 rounded-md border border-rose-border bg-rose-soft px-2.5 py-1.5 text-[12px] text-rose"
        >
          {rowError}
        </p>
      )}
    </div>
  );
}
