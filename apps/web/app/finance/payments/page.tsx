"use client";

import { useEffect, useState } from "react";
import { useRequireRole } from "../../../src/hooks/useRequireRole";
import { apiFetch } from "../../../src/lib/api";
import { formatRub } from "../../../src/lib/format";
import type { UserRole } from "../../../src/lib/auth";

const ALLOWED: UserRole[] = ["SUPER_ADMIN"];

const METHOD_LABELS: Record<string, string> = {
  CASH: "Наличные",
  BANK_TRANSFER: "Перевод",
  CARD: "Карта",
  OTHER: "Прочее",
};

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
  // Monday-start: 0 = Monday
  const day = new Date(d.getFullYear(), d.getMonth(), 1).getDay();
  return (day + 6) % 7;
}

function toYMD(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ── Calendar cell ──────────────────────────────────────────────────────────────

function DayCell({ day, entry }: { day: number; entry?: CalendarDay }) {
  const hasExpected = entry && Number(entry.expected) > 0;
  const hasReceived = entry && Number(entry.received) > 0;
  const isFullyReceived = hasExpected && hasReceived && Number(entry.received) >= Number(entry.expected);
  const isPartial = hasExpected && hasReceived && Number(entry.received) < Number(entry.expected);
  const isExpectedOnly = hasExpected && !hasReceived;

  let bg = "";
  if (isFullyReceived) bg = "bg-emerald-soft border-emerald-border";
  else if (isPartial) bg = "bg-amber-soft border-amber-border";
  else if (isExpectedOnly) bg = "bg-amber-soft/50 border-amber-border/50";

  return (
    <div className={`border rounded p-1 min-h-[56px] ${bg || "border-border"}`}>
      <span className="mono-num text-xs text-ink-2 font-medium">{day}</span>
      {entry && (
        <div className="mt-0.5 space-y-0.5">
          {hasExpected && (
            <p className="eyebrow text-[9px] text-amber">ОЖД: {formatRub(entry.expected)}</p>
          )}
          {hasReceived && (
            <p className="eyebrow text-[9px] text-emerald">ПОЛ: {formatRub(entry.received)}</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Add payment modal ─────────────────────────────────────────────────────────

interface BookingOption {
  id: string;
  projectName: string;
  startDate: string;
  client: { name: string };
}

function AddPaymentModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [bookingId, setBookingId] = useState("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("CASH");
  const [receivedAt, setReceivedAt] = useState(() => new Date().toISOString().slice(0, 16));
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [bookings, setBookings] = useState<BookingOption[]>([]);

  useEffect(() => {
    apiFetch<{ bookings: BookingOption[] }>("/api/bookings?status=CONFIRMED,ISSUED&limit=100")
      .then((r) => setBookings(r.bookings ?? []))
      .catch(() => {});
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
            <select
              className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink"
              value={bookingId}
              onChange={(e) => setBookingId(e.target.value)}
            >
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
            <input
              type="number"
              className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
            />
          </div>
          <div>
            <label className="eyebrow block mb-1">Способ оплаты</label>
            <select
              className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink"
              value={method}
              onChange={(e) => setMethod(e.target.value)}
            >
              {Object.entries(METHOD_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="eyebrow block mb-1">Дата получения</label>
            <input
              type="datetime-local"
              className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink"
              value={receivedAt}
              onChange={(e) => setReceivedAt(e.target.value)}
            />
          </div>
          <div>
            <label className="eyebrow block mb-1">Примечание</label>
            <textarea
              className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink resize-none"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-rose">{error}</p>}
          <div className="flex gap-2 justify-end pt-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm border border-border rounded text-ink-2 hover:bg-surface-subtle"
            >
              Отмена
            </button>
            <button
              onClick={handleSubmit}
              disabled={saving}
              className="px-4 py-2 text-sm bg-accent text-white rounded hover:bg-accent-bright disabled:opacity-50"
            >
              {saving ? "Сохранение…" : "Добавить"}
            </button>
          </div>
        </div>
      </div>
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

  const fetchAll = async () => {
    if (!authorized) return;
    const monthStr = startOfMonth(month);
    const endDate = endOfMonth(month);
    const [cal, pay] = await Promise.all([
      apiFetch<Record<string, CalendarDay>>(`/api/finance/payments-calendar?month=${monthStr}`),
      apiFetch<PaymentsResponse>(`/api/payments?from=${monthStr}T00:00:00.000Z&to=${endDate.toISOString()}&limit=200`),
    ]);
    setCalendar(cal);
    setPayments(pay.items);
  };

  useEffect(() => { fetchAll(); }, [authorized, month]);

  const prevMonth = () => setMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1));
  const nextMonth = () => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1));

  const handleDelete = async (id: string) => {
    if (!confirm("Удалить платёж?")) return;
    await apiFetch(`/api/payments/${id}`, { method: "DELETE" });
    await fetchAll();
  };

  if (loading || !authorized) return null;

  // Build calendar grid
  const totalDays = daysInMonth(month);
  const firstDow = firstDayOfWeek(month);
  const cells: Array<{ day: number | null; key: string }> = [];
  for (let i = 0; i < firstDow; i++) cells.push({ day: null, key: `empty-${i}` });
  for (let d = 1; d <= totalDays; d++) {
    cells.push({
      day: d,
      key: toYMD(new Date(month.getFullYear(), month.getMonth(), d)),
    });
  }

  return (
    <div className="space-y-6 pb-10">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="eyebrow">Финансы</p>
          <h1 className="text-2xl font-semibold text-ink mt-1">Платежи</h1>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="px-4 py-2 text-sm bg-accent text-white rounded hover:bg-accent-bright"
        >
          + Добавить платёж
        </button>
      </div>

      {/* Month selector */}
      <div className="flex items-center gap-3">
        <button onClick={prevMonth} aria-label="Предыдущий месяц" className="p-2 border border-border rounded hover:bg-surface-subtle">‹</button>
        <span className="text-sm font-medium text-ink capitalize">{monthLabel(month)}</span>
        <button onClick={nextMonth} aria-label="Следующий месяц" className="p-2 border border-border rounded hover:bg-surface-subtle">›</button>
      </div>

      {/* Calendar heatmap */}
      <div className="bg-surface border border-border rounded-lg p-4 shadow-xs">
        <div className="grid grid-cols-7 gap-1 mb-1">
          {["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((d) => (
            <div key={d} className="text-center text-xs text-ink-3 font-medium py-1">{d}</div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {cells.map((c) =>
            c.day === null ? (
              <div key={c.key} />
            ) : (
              <DayCell key={c.key} day={c.day} entry={calendar[c.key]} />
            )
          )}
        </div>
      </div>

      {/* Payments list */}
      <div className="bg-surface border border-border rounded-lg shadow-xs overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-surface-subtle">
              <th className="text-left px-4 py-3 text-ink-2 font-medium">Дата</th>
              <th className="text-left px-4 py-3 text-ink-2 font-medium">Клиент</th>
              <th className="text-left px-4 py-3 text-ink-2 font-medium">Проект</th>
              <th className="text-left px-4 py-3 text-ink-2 font-medium">Способ</th>
              <th className="text-right px-4 py-3 text-ink-2 font-medium">Сумма</th>
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

      {showModal && (
        <AddPaymentModal
          onClose={() => setShowModal(false)}
          onCreated={async () => { setShowModal(false); await fetchAll(); }}
        />
      )}
    </div>
  );
}
