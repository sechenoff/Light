"use client";

import { formatMoneyRub } from "@/lib/format";

// «Журнал изменений» — финансовые события брони (фаза 4.10, вынос из
// bookings/[id]/page.tsx, поведение 1:1).

export type FinanceEventSummary = {
  id: string;
  eventType: string;
  createdAt: string;
  statusFrom?: string | null;
  statusTo?: string | null;
  amountDelta?: string | null;
};

export function BookingJournalSection({
  financeEvents,
}: {
  financeEvents: FinanceEventSummary[] | null | undefined;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface shadow-xs overflow-hidden">
      <div className="p-3 border-b border-border bg-surface-subtle">
        <p className="eyebrow">Журнал изменений</p>
      </div>
      <div className="max-h-[280px] overflow-auto">
        {(financeEvents ?? []).map((ev) => (
          <div key={ev.id} className="px-3 py-2 border-b border-border text-sm flex items-center justify-between gap-2">
            <div>
              <div className="font-medium text-ink">{ev.eventType}</div>
              <div className="text-xs text-ink-3">{new Date(ev.createdAt).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })}</div>
            </div>
            <div className="text-right text-xs text-ink-2">
              {ev.statusFrom || ev.statusTo ? `${ev.statusFrom ?? "—"} → ${ev.statusTo ?? "—"}` : ""}
              {ev.amountDelta ? <div className="mono-num">{formatMoneyRub(ev.amountDelta)}</div> : null}
            </div>
          </div>
        ))}
        {(financeEvents ?? []).length === 0 ? (
          <div className="px-3 py-4 text-sm text-ink-3">Пока нет событий.</div>
        ) : null}
      </div>
    </div>
  );
}
