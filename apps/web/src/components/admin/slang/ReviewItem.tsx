"use client";

import type { SlangCandidate } from "./types";

type Props = {
  candidate: SlangCandidate;
  checked: boolean;
  onCheck: (id: string) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onEdit: (id: string) => void;
  acting: string | null; // id of candidate being acted on
};

function ConfidenceBadge({ value }: { value: number }) {
  const cls =
    value >= 0.7
      ? "bg-emerald-soft text-emerald"
      : value >= 0.3
        ? "bg-amber-soft text-amber"
        : "bg-rose-soft text-rose";
  return (
    <span className={`mono-num text-[11px] px-1.5 py-0.5 rounded ${cls}`}>
      {value.toFixed(2)}
    </span>
  );
}

export function ReviewItem({ candidate, checked, onCheck, onApprove, onReject, onEdit, acting }: Props) {
  const isActing = acting === candidate.id;
  const hasEquipment = !!candidate.proposedEquipmentId;

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 border-b border-border last:border-b-0 hover:bg-surface-muted transition-colors">
      <input
        type="checkbox"
        checked={checked}
        onChange={() => onCheck(candidate.id)}
        className="w-4 h-4 accent-accent shrink-0"
      />

      <div className="flex items-center gap-2.5 flex-1 min-w-0">
        <span className="font-mono text-[13px] text-ink bg-amber-soft px-2 py-0.5 rounded border border-amber-border whitespace-nowrap truncate max-w-[200px]">
          {candidate.rawPhrase}
        </span>
        <span className="text-ink-3 text-sm shrink-0">→</span>
        <div className="min-w-0">
          {hasEquipment ? (
            <p className="text-sm font-medium text-ink truncate">
              {candidate.proposedEquipmentName}
            </p>
          ) : (
            <p className="text-sm text-ink-3 italic">
              Не определено <span className="text-xs">· нужно указать вручную</span>
            </p>
          )}
        </div>
        <ConfidenceBadge value={candidate.confidence} />
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        <button
          onClick={() => onEdit(candidate.id)}
          disabled={isActing}
          title={hasEquipment ? "Изменить связь" : "Указать оборудование"}
          aria-label={hasEquipment ? "Изменить связь" : "Указать оборудование"}
          className="w-7 h-7 rounded-md border border-border bg-surface text-sm flex items-center justify-center hover:bg-accent-soft hover:border-accent transition-colors disabled:opacity-50"
        >
          ✎
        </button>
        {hasEquipment && (
          <button
            onClick={() => onApprove(candidate.id)}
            disabled={isActing}
            title="Подтвердить"
            aria-label="Подтвердить"
            className="w-7 h-7 rounded-md border border-border bg-surface text-sm flex items-center justify-center hover:bg-emerald-soft hover:border-emerald-border transition-colors disabled:opacity-50"
          >
            ✓
          </button>
        )}
        <button
          onClick={() => onReject(candidate.id)}
          disabled={isActing}
          title="Отклонить"
          aria-label="Отклонить"
          className="w-7 h-7 rounded-md border border-border bg-surface text-sm flex items-center justify-center hover:bg-rose-soft hover:border-rose-border transition-colors disabled:opacity-50"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
