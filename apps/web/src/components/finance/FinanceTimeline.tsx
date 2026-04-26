"use client";

import { useState } from "react";
import { apiFetch } from "../../lib/api";
import { formatRub } from "../../lib/format";

// ── Types ─────────────────────────────────────────────────────────────────────

type TimelineEvent =
  | { type: "INVOICE_ISSUED"; at: string; invoiceId: string; number: string; total: string; kind: string }
  | { type: "INVOICE_VOIDED"; at: string; invoiceId: string; number: string; reason: string | null }
  | { type: "PAYMENT_RECEIVED"; at: string; paymentId: string; amount: string; method: string; invoiceId: string | null }
  | { type: "PAYMENT_VOIDED"; at: string; paymentId: string; amount: string; reason: string | null }
  | { type: "REFUND_ISSUED"; at: string; refundId: string; amount: string; method: string; reason: string }
  | { type: "EXPENSE_LOGGED"; at: string; expenseId: string; category: string; amount: string; description: string | null }
  | { type: "CREDIT_NOTE_APPLIED"; at: string; creditNoteId: string; amount: string };

// ── Helpers ───────────────────────────────────────────────────────────────────

const INVOICE_KIND_LABEL: Record<string, string> = {
  FULL: "Полный",
  DEPOSIT: "Депозит",
  BALANCE: "Остаток",
  CORRECTION: "Коррекция",
};

const PAYMENT_METHOD_LABEL: Record<string, string> = {
  CASH: "Наличные",
  CARD: "Карта",
  BANK_TRANSFER: "Перевод",
  OTHER: "Другое",
};

const EXPENSE_CATEGORY_LABEL: Record<string, string> = {
  TRANSPORT: "Транспорт",
  EQUIPMENT: "Оборудование",
  CONTRACTORS: "Подрядчики",
  STAFF: "Персонал",
  RENT: "Аренда",
  REPAIR: "Ремонт",
  PAYROLL: "Зарплата",
  PURCHASE: "Закупки",
  OTHER: "Прочее",
};

function formatEventDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface EventRowProps {
  event: TimelineEvent;
}

function EventRow({ event }: EventRowProps) {
  let icon = "•";
  let primary = "";
  let secondary: string | null = null;
  let tone: "emerald" | "rose" | "amber" | "slate" | "ink-3" = "ink-3";

  switch (event.type) {
    case "INVOICE_ISSUED":
      icon = "📄";
      tone = "slate";
      primary = `Выпущен счёт ${event.number} · ${INVOICE_KIND_LABEL[event.kind] ?? event.kind} · ${formatRub(event.total)} ₽`;
      break;
    case "INVOICE_VOIDED":
      icon = "❌";
      tone = "rose";
      primary = `Аннулирован счёт ${event.number}`;
      secondary = event.reason ? `причина: ${event.reason}` : null;
      break;
    case "PAYMENT_RECEIVED":
      icon = "✅";
      tone = "emerald";
      primary = `Получен платёж ${formatRub(event.amount)} ₽ · ${PAYMENT_METHOD_LABEL[event.method] ?? event.method}${event.invoiceId ? " · к счёту" : ""}`;
      break;
    case "PAYMENT_VOIDED":
      icon = "⚠️";
      tone = "amber";
      primary = `Аннулирован платёж ${formatRub(event.amount)} ₽`;
      secondary = event.reason ? event.reason : null;
      break;
    case "REFUND_ISSUED":
      icon = "↩️";
      tone = "amber";
      primary = `Возврат ${formatRub(event.amount)} ₽ · ${PAYMENT_METHOD_LABEL[event.method] ?? event.method}`;
      secondary = event.reason ?? null;
      break;
    case "EXPENSE_LOGGED":
      icon = "💸";
      tone = "rose";
      primary = `Расход ${EXPENSE_CATEGORY_LABEL[event.category] ?? event.category} ${formatRub(event.amount)} ₽${event.description ? ` — ${event.description}` : ""}`;
      break;
    case "CREDIT_NOTE_APPLIED":
      icon = "🎫";
      tone = "slate";
      primary = `Кредит-нота ${formatRub(event.amount)} ₽ применена`;
      break;
  }

  const toneClassMap: Record<string, string> = {
    emerald: "text-emerald",
    rose: "text-rose",
    amber: "text-amber",
    slate: "text-ink-2",
    "ink-3": "text-ink-3",
  };
  const toneClass = toneClassMap;

  return (
    <div className="flex gap-3 py-2.5 border-b border-dashed border-border last:border-0">
      <span className="text-base flex-shrink-0 w-6 text-center leading-tight pt-0.5">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className={`text-[13px] font-medium ${toneClass[tone]}`}>{primary}</p>
        {secondary && (
          <p className="text-[11.5px] text-ink-3 mt-0.5">{secondary}</p>
        )}
        <p className="text-[11px] text-ink-3 mt-0.5">{formatEventDate(event.at)}</p>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface FinanceTimelineProps {
  bookingId: string;
}

export function FinanceTimeline({ bookingId }: FinanceTimelineProps) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<TimelineEvent[] | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleToggle() {
    const next = !open;
    setOpen(next);
    // Lazy-load on first expansion
    if (next && events === null) {
      setLoading(true);
      try {
        const data = await apiFetch<TimelineEvent[]>(`/api/bookings/${bookingId}/finance-timeline`);
        setEvents(data);
      } catch {
        setEvents([]);
      } finally {
        setLoading(false);
      }
    }
  }

  return (
    <div className="rounded-lg border border-border bg-surface shadow-xs overflow-hidden mb-4">
      {/* Header — toggles section */}
      <button
        type="button"
        onClick={handleToggle}
        aria-expanded={open}
        className="w-full flex items-center justify-between p-3 border-b border-border bg-surface-subtle text-left hover:bg-surface-subtle/80 transition-colors"
      >
        <p className="eyebrow">Хронология денег</p>
        <span className={`text-ink-3 text-[12px] transition-transform ${open ? "rotate-90" : ""}`}>▸</span>
      </button>

      {open && (
        <div className="p-3">
          {loading ? (
            <div className="animate-pulse space-y-2">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="h-8 bg-surface-subtle rounded" />
              ))}
            </div>
          ) : events === null || events.length === 0 ? (
            <p className="text-sm text-ink-3 py-2">Финансовых событий пока нет.</p>
          ) : (
            <div>
              {events.map((ev, idx) => (
                <EventRow key={`${ev.type}-${ev.at}-${idx}`} event={ev} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
