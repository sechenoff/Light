"use client";

type DatesCardProps = {
  pickupLocal: string;
  returnLocal: string;
  onPickupChange: (v: string) => void;
  onReturnChange: (v: string) => void;
  durationTag: string | null;
  durationDetail: string | null;
};

function combine(date: string, time: string): string {
  if (!date && !time) return "";
  return `${date}T${time}`;
}

const INPUT_CLS =
  "w-full rounded border border-border-strong px-3 py-2 text-[13.5px] text-ink bg-surface focus:outline-none focus:border-accent-bright focus:ring-[3px] focus:ring-accent-soft";

export function DatesCard({
  pickupLocal,
  returnLocal,
  onPickupChange,
  onReturnChange,
  durationTag,
  durationDetail,
}: DatesCardProps) {
  const [pickupDate, pickupTime] = pickupLocal ? pickupLocal.split("T") : ["", ""];
  const [returnDate, returnTime] = returnLocal ? returnLocal.split("T") : ["", ""];

  return (
    <div className="bg-surface border border-border rounded-md shadow-xs overflow-hidden mb-3.5">
      <div className="px-5 py-3 border-b border-border bg-surface-muted">
        <h3 className="eyebrow text-ink">2. Когда</h3>
      </div>
      <div className="p-5">
        <div className="grid grid-cols-[72px_1fr_1fr] gap-x-3 gap-y-2 items-center">
          {/* Column headers */}
          <div />
          <span className="eyebrow text-ink-3">Дата</span>
          <span className="eyebrow text-ink-3">Время</span>

          {/* Выдача row */}
          <span className="text-[12.5px] text-ink-2">Выдача</span>
          <input
            type="date"
            className={INPUT_CLS}
            value={pickupDate ?? ""}
            onChange={(e) => onPickupChange(combine(e.target.value, pickupTime ?? ""))}
          />
          <input
            type="time"
            className={INPUT_CLS}
            value={pickupTime ?? ""}
            onChange={(e) => onPickupChange(combine(pickupDate ?? "", e.target.value))}
          />

          {/* Возврат row */}
          <span className="text-[12.5px] text-ink-2">Возврат</span>
          <input
            type="date"
            className={INPUT_CLS}
            value={returnDate ?? ""}
            onChange={(e) => onReturnChange(combine(e.target.value, returnTime ?? ""))}
          />
          <input
            type="time"
            className={INPUT_CLS}
            value={returnTime ?? ""}
            onChange={(e) => onReturnChange(combine(returnDate ?? "", e.target.value))}
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
