"use client";

import type { CountSplit, ProblemDraft, ProblemReason } from "./types";

/**
 * Один ряд COUNT-mode позиции в чек-листе возврата.
 *
 * Состояние НЕ хранится внутри компонента: split, repairComment, problem —
 * приходят как props. Родитель (ReturnChecklist в T6) держит OutcomeMap и
 * прокидывает обновления через onIncrement / onDecrement / onAcceptAll /
 * onRepairCommentChange / onProblemPatch.
 *
 * Контракт:
 * - три кнопки-действия «Принять 1 / Ремонт 1 / Проблема 1» (h-10, ≥40px touch);
 * - три «пилюли» с обратимостью клика → onDecrement(bucket);
 * - inline-панель ремонта при split.repair ≥ 1;
 * - inline-панель проблемы при split.problem ≥ 1;
 * - shortcut «Принять всё»: первый клик по «Принять 1» при pending===totalQty
 *   вызывает onAcceptAll() вместо onIncrement('accepted').
 */
interface Props {
  name: string;
  totalQty: number;
  split: CountSplit;
  repairComment: string;
  problem: ProblemDraft;
  disabled: boolean;
  onIncrement: (bucket: "accepted" | "repair" | "problem") => void;
  onDecrement: (bucket: "accepted" | "repair" | "problem") => void;
  onAcceptAll: () => void;
  onRepairCommentChange: (s: string) => void;
  onProblemPatch: (patch: Partial<ProblemDraft>) => void;
}

const REASON_LABEL: Record<ProblemReason, string> = {
  LEFT_ON_SITE: "Оставлен на площадке",
  LOST: "Потерян",
  DESTROYED: "Сломан безвозвратно",
  STOLEN: "Украден",
};

export function CountSplitRow({
  name,
  totalQty,
  split,
  repairComment,
  problem,
  disabled,
  onIncrement,
  onDecrement,
  onAcceptAll,
  onRepairCommentChange,
  onProblemPatch,
}: Props) {
  const pending = totalQty - split.accepted - split.repair - split.problem;
  const noPending = pending <= 0;
  const allAccepted = split.accepted === totalQty;
  const hasRepair = split.repair >= 1;
  const hasProblem = split.problem >= 1;

  let railClass = "border-l-4 border-transparent";
  if (hasProblem) railClass = "border-l-4 border-rose";
  else if (hasRepair) railClass = "border-l-4 border-amber";
  else if (allAccepted) railClass = "border-l-4 border-emerald";

  let bgClass = "bg-surface";
  if (hasProblem) bgClass = "bg-rose-soft/30";
  else if (hasRepair) bgClass = "bg-amber-soft/30";
  else if (allAccepted) bgClass = "bg-emerald-soft/30";

  function handleAcceptClick() {
    if (pending === totalQty) onAcceptAll();
    else onIncrement("accepted");
  }

  return (
    <div className={`rounded-lg border border-border p-3 ${railClass} ${bgClass}`}>
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-ink">{name}</div>
          <div className="mt-0.5 text-[11px] text-ink-3">
            осталось пометить {pending} из {totalQty}
          </div>
        </div>
        <div className="flex shrink-0 gap-1">
          {split.accepted > 0 && (
            <button
              type="button"
              onClick={() => onDecrement("accepted")}
              disabled={disabled}
              aria-label={`Снять отметку «Принято» — ${name}`}
              className="rounded-full bg-emerald-soft px-2 py-0.5 text-[11px] font-semibold text-emerald hover:opacity-80 disabled:opacity-40"
            >
              <span aria-hidden="true">✓ </span>
              {split.accepted}
            </button>
          )}
          {split.repair > 0 && (
            <button
              type="button"
              onClick={() => onDecrement("repair")}
              disabled={disabled}
              aria-label={`Снять отметку «Ремонт» — ${name}`}
              className="rounded-full bg-amber-soft px-2 py-0.5 text-[11px] font-semibold text-amber hover:opacity-80 disabled:opacity-40"
            >
              <span aria-hidden="true">🔧 </span>
              {split.repair}
            </button>
          )}
          {split.problem > 0 && (
            <button
              type="button"
              onClick={() => onDecrement("problem")}
              disabled={disabled}
              aria-label={`Снять отметку «Проблема» — ${name}`}
              className="rounded-full bg-rose-soft px-2 py-0.5 text-[11px] font-semibold text-rose hover:opacity-80 disabled:opacity-40"
            >
              <span aria-hidden="true">✗ </span>
              {split.problem}
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={handleAcceptClick}
          disabled={disabled || noPending}
          aria-label={`Принять 1 шт — ${name}`}
          className="h-10 rounded border border-emerald-border bg-emerald px-3 text-[12px] font-semibold text-white hover:opacity-90 disabled:opacity-40"
        >
          <span aria-hidden="true">✓ </span>
          Принять 1
        </button>
        <button
          type="button"
          onClick={() => onIncrement("repair")}
          disabled={disabled || noPending}
          aria-label={`В ремонт 1 шт — ${name}`}
          className="h-10 rounded border border-amber-border bg-surface px-3 text-[12px] font-semibold text-amber hover:bg-amber-soft disabled:opacity-40"
        >
          <span aria-hidden="true">🔧 </span>
          Ремонт 1
        </button>
        <button
          type="button"
          onClick={() => onIncrement("problem")}
          disabled={disabled || noPending}
          aria-label={`Проблема 1 шт — ${name}`}
          className="h-10 rounded border border-rose-border bg-surface px-3 text-[12px] font-semibold text-rose hover:bg-rose-soft disabled:opacity-40"
        >
          <span aria-hidden="true">✗ </span>
          Проблема 1
        </button>
      </div>

      {hasRepair && (
        <div className="mt-3 border-t border-border pt-3">
          <label
            htmlFor={`count-split-repair-comment-${name}`}
            className="mb-1 block text-[11px] font-semibold text-amber"
          >
            <span aria-hidden="true">🔧 </span>
            Комментарий ремонта (на все {split.repair} шт)
          </label>
          <textarea
            id={`count-split-repair-comment-${name}`}
            value={repairComment}
            onChange={(e) => onRepairCommentChange(e.target.value)}
            disabled={disabled}
            aria-label="Комментарий ремонта"
            rows={2}
            placeholder="Что сломано, что починить"
            className="w-full rounded border border-border-strong bg-surface px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-amber disabled:opacity-50"
          />
        </div>
      )}

      {hasProblem && (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          <div className="text-[11px] font-semibold text-rose">
            <span aria-hidden="true">✗ </span>
            Проблема (на все {split.problem} шт)
          </div>
          <div className="flex flex-wrap gap-2">
            <select
              value={problem.reason ?? ""}
              onChange={(e) =>
                onProblemPatch({
                  reason: (e.target.value || null) as ProblemReason | null,
                })
              }
              disabled={disabled}
              aria-label="Причина проблемы"
              className="rounded border border-border bg-surface px-2 py-1 text-[12px] text-ink disabled:opacity-50"
            >
              <option value="">— причина —</option>
              <option value="LOST">{REASON_LABEL.LOST}</option>
              <option value="DESTROYED">{REASON_LABEL.DESTROYED}</option>
              <option value="STOLEN">{REASON_LABEL.STOLEN}</option>
              <option value="LEFT_ON_SITE">{REASON_LABEL.LEFT_ON_SITE}</option>
            </select>
            {problem.reason === "LEFT_ON_SITE" && (
              <input
                type="date"
                value={problem.expectedBackDate ?? ""}
                onChange={(e) =>
                  onProblemPatch({ expectedBackDate: e.target.value || null })
                }
                disabled={disabled}
                aria-label="Дата ожидаемого возврата"
                className="rounded border border-border bg-surface px-2 py-1 text-[12px] text-ink disabled:opacity-50"
              />
            )}
          </div>
          <textarea
            value={problem.comment}
            onChange={(e) => onProblemPatch({ comment: e.target.value })}
            disabled={disabled}
            aria-label="Комментарий проблемы"
            rows={2}
            placeholder="Что случилось"
            className="w-full rounded border border-border-strong bg-surface px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-rose disabled:opacity-50"
          />
        </div>
      )}
    </div>
  );
}
