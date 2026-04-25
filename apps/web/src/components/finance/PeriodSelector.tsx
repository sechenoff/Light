"use client";

import { PERIOD_LABELS, PERIOD_OPTIONS, type PeriodKey } from "../../lib/periodUtils";

interface Props {
  value: PeriodKey;
  onChange: (period: PeriodKey) => void;
}

export function PeriodSelector({ value, onChange }: Props) {
  return (
    <div className="flex items-center gap-1 bg-surface-subtle border border-border rounded p-1">
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
