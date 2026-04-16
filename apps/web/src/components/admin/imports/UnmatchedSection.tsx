"use client";

import type { UnmatchedRow } from "./types";

type Props = {
  rows: UnmatchedRow[];
  onRebind: (rowId: string) => void;
};

export function UnmatchedSection({ rows, onRebind }: Props) {
  if (rows.length === 0) return null;

  return (
    <div className="mt-6 rounded-lg border border-amber-border bg-amber-soft px-4 py-3">
      <div className="eyebrow mb-3 text-amber">⚠️ Не сопоставлено ({rows.length})</div>
      <div className="space-y-2">
        {rows.map((row) => (
          <div
            key={row.id}
            className="flex items-center justify-between gap-3 rounded border border-amber-border bg-surface px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-ink-1">{row.sourceName}</div>
              {row.sourcePrice && (
                <div className="text-xs text-ink-3 mono-num">{row.sourcePrice} ₽</div>
              )}
            </div>
            <button
              type="button"
              onClick={() => onRebind(row.id)}
              className="shrink-0 text-xs text-accent hover:underline"
            >
              Привязать к каталогу →
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
