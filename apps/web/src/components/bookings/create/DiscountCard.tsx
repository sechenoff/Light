"use client";

type Props = {
  value: number;
  onChange: (v: number) => void;
};

export function DiscountCard({ value, onChange }: Props) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-border bg-surface px-4 py-3 shadow-xs">
      <label className="text-[13px] font-medium text-ink">Скидка на оборудование</label>
      <div className="flex items-center gap-1.5">
        <input
          type="number"
          min="0"
          max="100"
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-16 rounded border border-border px-2 py-1 text-right font-mono text-[13px] focus:outline-none focus:border-accent-bright"
        />
        <span className="text-[13px] text-ink-2">%</span>
      </div>
    </div>
  );
}
