"use client";

type CommentCardProps = {
  value: string;
  onChange: (value: string) => void;
};

export function CommentCard({ value, onChange }: CommentCardProps) {
  return (
    <div className="bg-surface border border-border rounded-md shadow-xs overflow-hidden">
      <div className="px-5 py-3 border-b border-border bg-surface-muted flex items-center justify-between">
        <h3 className="eyebrow text-ink">4. Для руководителя</h3>
        <span className="text-[11px] text-ink-3 italic">опционально</span>
      </div>
      <div className="p-5">
        <label className="flex justify-between text-[11.5px] text-ink-2 mb-1.5">
          <span>Зачем эта бронь и что важно знать</span>
        </label>
        <textarea
          className="w-full min-h-[64px] resize-y rounded border border-border-strong px-3 py-2.5 text-[13.5px] text-ink bg-surface leading-relaxed focus:outline-none focus:border-accent-bright focus:ring-[3px] focus:ring-accent-soft"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Постоянный клиент, торгуется по свету..."
        />
      </div>
    </div>
  );
}
