"use client";

type DatesCardProps = {
  pickupLocal: string;
  returnLocal: string;
  onPickupChange: (v: string) => void;
  onReturnChange: (v: string) => void;
  durationTag: string | null;
  durationDetail: string | null;
};

export function DatesCard({
  pickupLocal,
  returnLocal,
  onPickupChange,
  onReturnChange,
  durationTag,
  durationDetail,
}: DatesCardProps) {
  return (
    <div className="bg-surface border border-border rounded-md shadow-xs overflow-hidden mb-3.5">
      <div className="px-5 py-3 border-b border-border bg-surface-muted">
        <h3 className="eyebrow text-ink">2. Когда</h3>
      </div>
      <div className="p-5">
        <div className="grid grid-cols-[1fr_16px_1fr] gap-2 items-center">
          <input
            type="datetime-local"
            className="w-full rounded border border-border-strong px-3 py-2 text-[13.5px] text-ink bg-surface focus:outline-none focus:border-accent-bright focus:ring-[3px] focus:ring-accent-soft"
            value={pickupLocal}
            onChange={(e) => onPickupChange(e.target.value)}
          />
          <div className="text-center text-ink-3 font-mono text-sm">→</div>
          <input
            type="datetime-local"
            className="w-full rounded border border-border-strong px-3 py-2 text-[13.5px] text-ink bg-surface focus:outline-none focus:border-accent-bright focus:ring-[3px] focus:ring-accent-soft"
            value={returnLocal}
            onChange={(e) => onReturnChange(e.target.value)}
          />
        </div>
        {(durationTag || durationDetail) && (
          <div className="mt-2 flex items-center gap-2.5 text-[11.5px] text-ink-2">
            {durationTag && (
              <span className="px-2 py-0.5 bg-accent-soft text-accent rounded font-mono text-[11px]">
                {durationTag}
              </span>
            )}
            {durationDetail && <span>{durationDetail}</span>}
          </div>
        )}
      </div>
    </div>
  );
}
