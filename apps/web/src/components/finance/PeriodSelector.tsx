"use client";

import { PERIOD_LABELS, PERIOD_OPTIONS, type PeriodKey } from "../../lib/periodUtils";

interface Props {
  value: PeriodKey;
  onChange: (period: PeriodKey) => void;
}

export function PeriodSelector({ value, onChange }: Props) {
  return (
    // C-MED3: overflow-x-auto + flex-nowrap prevents period pills wrapping on mobile
    <div className="flex items-center gap-1 bg-surface-subtle border border-border rounded p-1 overflow-x-auto flex-nowrap">
      {PERIOD_OPTIONS.map((key) => (
        <button
          key={key}
          onClick={() => onChange(key)}
          className={`px-2.5 py-1 text-xs font-medium rounded-sm transition-colors ${
            value === key
              ? "bg-surface text-ink shadow-xs"
              : "text-ink-2 hover:text-ink"
          }`}
        >
          {PERIOD_LABELS[key]}
        </button>
      ))}
    </div>
  );
}
