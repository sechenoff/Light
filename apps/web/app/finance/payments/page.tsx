"use client";

import { useEffect, useState } from "react";
import { useRequireRole } from "../../../src/hooks/useRequireRole";
import { apiFetch } from "../../../src/lib/api";
import { formatRub } from "../../../src/lib/format";
import { FinanceTabNav } from "../../../src/components/finance/FinanceTabNav";
import type { UserRole } from "../../../src/lib/auth";

const ALLOWED: UserRole[] = ["SUPER_ADMIN"];

const METHOD_LABELS: Record<string, string> = {
  CASH: "Наличные",
  BANK_TRANSFER: "Перевод",
  CARD: "Карта",
  OTHER: "Прочее",
};

const SHORT_MONTHS = ["Янв", "Фев", "Мар", "Апр", "Май", "Июн", "Июл", "Авг", "Сен", "Окт", "Ноя", "Дек"];

// ── Types ─────────────────────────────────────────────────────────────────────

interface CalendarDay {
  expected: string;
  received: string;
}

interface PaymentItem {
  id: string;
  amount: string;
  method: string | null;
  paymentMethod: string;
  receivedAt: string | null;
  paymentDate: string | null;
  note: string | null;
  booking: {
    id: string;
    projectName: string;
    client: { id: string; name: string };
  } | null;
}

interface PaymentsResponse {
  items: PaymentItem[];
  total: number;
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function startOfMonth(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

function monthLabel(d: Date): string {
  return d.toLocaleString("ru-RU", { month: "long", year: "numeric" });
}

function daysInMonth(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

function firstDayOfWeek(d: Date): number {
  const day = new Date(d.getFullYear(), d.getMonth(), 1).getDay();
  return (day + 6) % 7;
}

function toYMD(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatDateCard(dateStr: string | null) {
  if (!dateStr) return { day: "—", month: "" };
  const d = new Date(dateStr);
  return {
    day: String(d.getDate()).padStart(2, "0"),
    month: SHORT_MONTHS[d.getMonth()] ?? "",
  };
}

function formatAmountShort(val: number): string {
  if (val >= 1000000) return `${Math.round(val / 1000)}к`;
  if (val >= 1000) return `${Math.round(val / 1000)}к`;
  return String(Math.round(val));
}

// ── Calendar cell ──────────────────────────────────────────────────────────────

type CellLevel = "" | "lvl-1" | "lvl-2" | "lvl-3" | "expected" | "overdue";

function getCellLevel(entry: CalendarDay | undefined, dateStr: string): CellLevel {
  if (!entry) return "";
  const received = Number(entry.received);
  const expected = Number(entry.expected);
  const now = new Date();
  const cellDate = new Date(dateStr);
  const isPast = cellDate < now;

  if (received > 0) {
    if (received >= 500000) return "lvl-3";
    if (received >= 100000) return "lvl-2";
    return "lvl-1";
  }
  if (expected > 0) {
    if (isPast) return "overdue";
    return "expected";
  }
  return "";
}

const CELL_CLASS: Record<CellLevel, string> = {
  "": "bg-surface-subtle",
  "lvl-1": "bg-emerald-soft",
  "lvl-2": "bg-emerald-soft border border-emerald-border",
  "lvl-3": "bg-emerald-border",
  "expected": "bg-amber-soft",
  "overdue": "bg-rose-soft border border-rose-border",
};

const CELL_AMT_CLASS: Record<CellLevel, string> = {
  "": "text-ink-3",
  "lvl-1": "text-ink",
  "lvl-2": "text-ink",
  "lvl-3": "text-emerald",
  "expected": "text-amber",
  "overdue": "text-rose",
};

// ── Add payment modal ─────────────────────────────────────────────────────────

interface BookingOption {
  id: string;
  projectName: string;
  startDate: string;
  client: { name: string };
}

function AddPaymentModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [bookingId, setBookingId] = useState("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("CASH");
  const [receivedAt, setReceivedAt] = useState(() => new Date().toISOString().slice(0, 16));
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [bookings, setBookings] = useState<BookingOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ bookings: BookingOption[] }>("/api/bookings?status=CONFIRMED,ISSUED&limit=100")
      .then((r) => { if (!cancelled) setBookings(r.bookings ?? []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const handleSubmit = async () => {
    if (!bookingId || !amount) { setError("Заполните обязательные поля"); return; }
    setSaving(true);
    setError("");
    try {
      await apiFetch("/api/payments", {
        method: "POST",
        body: JSON.stringify({
          bookingId,
          amount: Number(amount),
          method,
          receivedAt: new Date(receivedAt).toISOString(),
          note: note || undefined,
        }),
      });
      onCreated();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Ошибка");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-surface rounded-lg p-6 w-full max-w-md shadow-xl">
        <h2 className="text-lg font-semibold text-ink mb-4">Добавить платёж</h2>
        <div className="space-y-3">
          <div>
            <label className="eyebrow block mb-1">Бронирование *</label>
            <select className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink"
              value={bookingId} onChange={(e) => setBookingId(e.target.value)}>
              <option value="">— выберите бронирование —</option>
              {bookings.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.client.name} — {b.projectName} — {new Date(b.startDate).toLocaleDateString("ru-RU")}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="eyebrow block mb-1">Сумма *</label>
            <input type="number" className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink"
              value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
          </div>
          <div>
            <label className="eyebrow block mb-1">Способ оплаты</label>
            <select className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink"
              value={method} onChange={(e) => setMethod(e.target.value)}>
              {Object.entries(METHOD_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="eyebrow block mb-1">Дата получения</label>
            <input type="datetime-local" className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink"
              value={receivedAt} onChange={(e) => setReceivedAt(e.target.value)} />
          </div>
          <div>
            <label className="eyebrow block mb-1">Примечание</label>
            <textarea className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink resize-none"
              rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          {error && <p className="text-sm text-rose">{error}</p>}
          <div className="flex gap-2 justify-end pt-2">
            <button onClick={onClose} className="px-4 py-2 text-sm border border-border rounded text-ink-2 hover:bg-surface-subtle">
              Отмена
            </button>
            <button onClick={handleSubmit} disabled={saving}
              className="px-4 py-2 text-sm bg-accent text-white rounded hover:bg-accent-bright disabled:opacity-50">
              {saving ? "Сохранение…" : "Добавить"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Pay row ────────────────────────────────────────────────────────────────────

function PayRow({
  dateStr,
  clientName,
  meta,
  pillLabel,
  pillClass,
  amount,
  isToday,
}: {
  dateStr: string | null;
  clientName: string;
  meta: string;
  pillLabel: string;
  pillClass: string;
  amount: string;
  isToday?: boolean;
}) {
  const dc = formatDateCard(dateStr);
  return (
    <div
      className="grid items-center gap-3 px-3.5 py-2.5 border-b border-border last:border-0"
      style={{ gridTemplateColumns: "44px 1fr auto auto" }}
    >
      <div
        className={`text-center rounded py-1 ${isToday ? "bg-amber-soft" : "bg-surface-subtle"}`}
        style={{ fontFamily: "IBM Plex Sans Condensed, sans-serif" }}
      >
        <p className={`text-[16px] font-bold leading-none ${isToday ? "text-amber" : "text-ink"}`}>{dc.day}</p>
        <p className="text-[9.5px] uppercase tracking-[0.06em] text-ink-3 mt-0.5">{dc.month}</p>
      </div>
      <div>
        <p className="text-[13px] font-medium text-ink">{clientName}</p>
        <p className="text-[11px] text-ink-2 mt-0.5">{meta}</p>
      </div>
      <span
        className={`text-[10px] font-semibold px-[7px] py-0.5 rounded-full uppercase tracking-[0.04em] ${pillClass}`}
        style={{ fontFamily: "IBM Plex Sans Condensed, sans-serif" }}
      >
        {pillLabel}
      </span>
      <p className="mono-num font-semibold text-[13px] text-right">{formatRub(amount)}</p>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function PaymentsPage() {
  const { authorized, loading } = useRequireRole(ALLOWED);
  const [month, setMonth] = useState(() => new Date());
  const [calendar, setCalendar] = useState<Record<string, CalendarDay>>({});
  const [payments, setPayments] = useState<PaymentItem[]>([]);
  const [showModal, setShowModal] = useState(false);

  const fetchAll = async (cancelled: { v: boolean }) => {
    if (!authorized) return;
    const monthStr = startOfMonth(month);
    const endDate = endOfMonth(month);
    const [cal, pay] = await Promise.all([
      apiFetch<Record<string, CalendarDay>>(`/api/finance/payments-calendar?month=${monthStr}`),
      apiFetch<PaymentsResponse>(`/api/payments?from=${monthStr}T00:00:00.000Z&to=${endDate.toISOString()}&limit=200`),
    ]);
    if (!cancelled.v) {
      setCalendar(cal);
      setPayments(pay.items);
    }
  };

  useEffect(() => {
    const cancelled = { v: false };
    fetchAll(cancelled);
    return () => { cancelled.v = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authorized, month]);

  const handleDelete = async (id: string) => {
    if (!confirm("Удалить платёж?")) return;
    await apiFetch(`/api/payments/${id}`, { method: "DELETE" });
    const cancelled = { v: false };
    await fetchAll(cancelled);
  };

  const prevMonth = () => setMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1));
  const nextMonth = () => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1));

  if (loading || !authorized) return null;

  // Calendar grid
  const totalDays = daysInMonth(month);
  const firstDow = firstDayOfWeek(month);
  const cells: Array<{ day: number | null; key: string; isOther?: boolean }> = [];
  // Previous month cells
  const prevMonthEnd = new Date(month.getFullYear(), month.getMonth(), 0);
  for (let i = firstDow - 1; i >= 0; i--) {
    cells.push({ day: prevMonthEnd.getDate() - i, key: `prev-${i}`, isOther: true });
  }
  for (let d = 1; d <= totalDays; d++) {
    cells.push({ day: d, key: toYMD(new Date(month.getFullYear(), month.getMonth(), d)) });
  }
  // Fill to complete last row
  const remaining = (7 - (cells.length % 7)) % 7;
  for (let d = 1; d <= remaining; d++) {
    cells.push({ day: d, key: `next-${d}`, isOther: true });
  }

  const today = toYMD(new Date());

  // Split payments into received (has receivedAt) and upcoming
  const received = payments
    .filter((p) => p.receivedAt)
    .sort((a, b) => (b.receivedAt ?? "").localeCompare(a.receivedAt ?? ""))
    .slice(0, 5);
  const upcoming = payments
    .filter((p) => !p.receivedAt && p.paymentDate)
    .sort((a, b) => (a.paymentDate ?? "").localeCompare(b.paymentDate ?? ""))
    .slice(0, 5);

  const totalReceived = payments.filter((p) => p.receivedAt).reduce((s, p) => s + Number(p.amount), 0);
  const totalExpected = payments.filter((p) => !p.receivedAt).reduce((s, p) => s + Number(p.amount), 0);

  return (
    <div className="pb-10">
      <FinanceTabNav />

      <div className="px-7 py-5">
        {/* Header */}
        <div className="flex justify-between items-end mb-4 pb-3.5 border-b border-border">
          <div>
            <h1 className="text-[22px] font-semibold text-ink tracking-tight">Поступления</h1>
            <p className="text-xs text-ink-2 mt-0.5">
              За {monthLabel(month).toLowerCase()} получено{" "}
              <strong className="mono-num text-emerald">{formatRub(totalReceived)}</strong>
              {" · ожидается ещё "}
              <strong className="mono-num text-amber">{formatRub(totalExpected)}</strong>
            </p>
          </div>
          <div className="flex gap-2">
            <div className="flex items-center gap-1.5 bg-surface-subtle border border-border rounded p-1">
              {["Неделя", "Месяц", "Квартал"].map((lbl) => (
                <button
                  key={lbl}
                  className={`px-2.5 py-1 text-xs font-medium rounded-sm transition-colors ${
                    lbl === "Месяц" ? "bg-surface text-ink shadow-xs" : "text-ink-2 hover:text-ink"
                  }`}
                >
                  {lbl}
                </button>
              ))}
            </div>
            <button
              onClick={() => setShowModal(true)}
              className="px-3.5 py-1.5 text-xs font-medium bg-accent text-white rounded border border-accent hover:bg-accent-bright"
            >
              + Отметить оплату
            </button>
          </div>
        </div>

        {/* Calendar heatmap */}
        <div className="bg-surface border border-border rounded-[6px] overflow-hidden shadow-xs mb-4">
          <div className="flex justify-between items-center px-4 py-3.5 border-b border-border">
            <div className="flex items-center gap-3">
              <button onClick={prevMonth} aria-label="Предыдущий месяц" className="p-1.5 border border-border rounded hover:bg-surface-subtle text-ink-2">‹</button>
              <h3 className="text-[13.5px] font-semibold text-ink capitalize">
                Календарь платежей — {monthLabel(month)}
              </h3>
              <button onClick={nextMonth} aria-label="Следующий месяц" className="p-1.5 border border-border rounded hover:bg-surface-subtle text-ink-2">›</button>
            </div>
          </div>

          <div className="px-5 pt-4">
            {/* Day-of-week header */}
            <div className="grid grid-cols-7 gap-[3px] mb-[3px]">
              {["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((d) => (
                <div key={d} className="text-center text-[10px] text-ink-3 uppercase tracking-[0.06em]" style={{ fontFamily: "IBM Plex Sans Condensed, sans-serif" }}>
                  {d}
                </div>
              ))}
            </div>
            {/* Grid */}
            <div className="grid grid-cols-7 gap-[3px]">
              {cells.map((c) => {
                if (c.isOther) {
                  return (
                    <div
                      key={c.key}
                      className="aspect-square rounded-sm bg-surface-subtle opacity-30 text-[10px] text-ink-3 p-[3px] font-mono"
                    >
                      <span>{c.day}</span>
                    </div>
                  );
                }
                const level = getCellLevel(calendar[c.key], c.key);
                const isToday = c.key === today;
                const amt = calendar[c.key]
                  ? Number(calendar[c.key].received) || Number(calendar[c.key].expected)
                  : 0;
                return (
                  <div
                    key={c.key}
                    className={`aspect-square rounded-sm p-[3px] text-[10px] flex flex-col justify-between font-mono
                      ${CELL_CLASS[level]}
                      ${isToday ? "outline outline-2 outline-accent outline-offset-[-1px] z-[1]" : ""}
                    `}
                  >
                    <span className="text-ink-3">{c.day}</span>
                    {amt > 0 && (
                      <span className={`text-[9px] font-semibold text-right ${CELL_AMT_CLASS[level]}`}>
                        {formatAmountShort(amt)}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Legend */}
          <div className="flex gap-3.5 text-[11px] text-ink-2 px-5 py-3 border-t border-border mt-3">
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-3 h-3 rounded-sm bg-emerald-border" />
              Поступило
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-3 h-3 rounded-sm bg-amber-soft border border-amber-border" />
              Ожидается
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-3 h-3 rounded-sm bg-rose-soft border border-rose-border" />
              Просрочка
            </span>
          </div>
        </div>

        {/* Two-column: expected / received */}
        <div className="grid grid-cols-2 gap-4 mb-5">
          {/* Upcoming */}
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-[0.08em] text-ink-2 mb-2.5 px-1">Ожидается на этой неделе</h4>
            <div className="bg-surface border border-border rounded-[6px] overflow-hidden shadow-xs">
              {upcoming.length === 0 ? (
                <p className="px-4 py-4 text-sm text-ink-3">Нет ожидаемых платежей</p>
              ) : (
                upcoming.map((p) => {
                  const payDate = p.paymentDate;
                  const isTodayRow = payDate ? new Date(payDate).toDateString() === new Date().toDateString() : false;
                  return (
                    <PayRow
                      key={p.id}
                      dateStr={payDate}
                      clientName={p.booking?.client.name ?? "—"}
                      meta={p.booking?.projectName ?? "—"}
                      pillLabel="ожидаем"
                      pillClass="bg-amber-soft text-amber border border-amber-border"
                      amount={p.amount}
                      isToday={isTodayRow}
                    />
                  );
                })
              )}
            </div>
          </div>

          {/* Received */}
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-[0.08em] text-ink-2 mb-2.5 px-1">Поступило недавно</h4>
            <div className="bg-surface border border-border rounded-[6px] overflow-hidden shadow-xs">
              {received.length === 0 ? (
                <p className="px-4 py-4 text-sm text-ink-3">Нет поступлений</p>
              ) : (
                received.map((p) => (
                  <PayRow
                    key={p.id}
                    dateStr={p.receivedAt}
                    clientName={p.booking?.client.name ?? "—"}
                    meta={p.booking?.projectName ?? "—"}
                    pillLabel="зачислено"
                    pillClass="bg-emerald-soft text-emerald border border-emerald-border"
                    amount={p.amount}
                  />
                ))
              )}
            </div>
          </div>
        </div>

        {/* Full payments table */}
        <div className="bg-surface border border-border rounded-[6px] shadow-xs overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-subtle">
                <th className="text-left px-4 py-3 eyebrow">Дата</th>
                <th className="text-left px-4 py-3 eyebrow">Клиент</th>
                <th className="text-left px-4 py-3 eyebrow">Проект</th>
                <th className="text-left px-4 py-3 eyebrow">Способ</th>
                <th className="text-right px-4 py-3 eyebrow">Сумма</th>
                <th className="w-16" />
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => {
                const date = p.receivedAt ?? p.paymentDate;
                return (
                  <tr key={p.id} className="border-b border-border hover:bg-surface-subtle">
                    <td className="px-4 py-3 text-ink-2 mono-num text-xs">
                      {date ? new Date(date).toLocaleDateString("ru-RU") : "—"}
                    </td>
                    <td className="px-4 py-3 text-ink">{p.booking?.client.name ?? "—"}</td>
                    <td className="px-4 py-3 text-ink-2 text-xs">{p.booking?.projectName ?? "—"}</td>
                    <td className="px-4 py-3 text-ink-2">
                      {METHOD_LABELS[p.method ?? p.paymentMethod] ?? p.paymentMethod}
                    </td>
                    <td className="px-4 py-3 text-right mono-num font-medium text-ink">
                      {formatRub(p.amount)}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <button
                        onClick={() => handleDelete(p.id)}
                        aria-label="Удалить платёж"
                        className="text-xs text-rose hover:underline"
                      >
                        Удалить
                      </button>
                    </td>
                  </tr>
                );
              })}
              {payments.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-ink-3 text-sm">
                    Нет платежей за этот месяц
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showModal && (
        <AddPaymentModal
          onClose={() => setShowModal(false)}
          onCreated={async () => {
            setShowModal(false);
            const cancelled = { v: false };
            await fetchAll(cancelled);
          }}
        />
      )}
    </div>
  );
}
