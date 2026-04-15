"use client";

import { useEffect, useState } from "react";
import { useRequireRole } from "../../../src/hooks/useRequireRole";
import { apiFetch } from "../../../src/lib/api";
import { formatRub } from "../../../src/lib/format";
import type { UserRole } from "../../../src/lib/auth";

const ALLOWED: UserRole[] = ["SUPER_ADMIN"];

const CATEGORY_LABELS: Record<string, string> = {
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

const CATEGORY_COLORS: Record<string, string> = {
  TRANSPORT: "#0f766e",
  EQUIPMENT: "#1d4ed8",
  CONTRACTORS: "#7c3aed",
  STAFF: "#a16207",
  RENT: "#9f1239",
  REPAIR: "#b45309",
  PAYROLL: "#047857",
  PURCHASE: "#1e40af",
  OTHER: "#334155",
};

interface BreakdownItem {
  category: string;
  total: string;
  count: number;
}

interface ExpenseItem {
  id: string;
  category: string;
  description: string | null;
  name: string;
  amount: string;
  expenseDate: string;
  approved: boolean;
  createdBy: string | null;
  bookingId: string | null;
  linkedRepairId: string | null;
  booking: { id: string; projectName: string } | null;
}

interface ExpensesResponse {
  items: ExpenseItem[];
  total: number;
}

// ── Donut chart ───────────────────────────────────────────────────────────────

function DonutChart({ breakdown }: { breakdown: BreakdownItem[] }) {
  const total = breakdown.reduce((s, r) => s + Number(r.total), 0);
  if (total === 0) return <div className="text-sm text-ink-3 text-center py-8">Нет данных</div>;

  const SIZE = 120;
  const R = 44;
  const CX = SIZE / 2;
  const CY = SIZE / 2;
  const circumference = 2 * Math.PI * R;

  let offset = 0;
  const segments = breakdown.map((row) => {
    const pct = Number(row.total) / total;
    const dash = pct * circumference;
    const gap = circumference - dash;
    const seg = { ...row, dash, gap, offset };
    offset += dash;
    return seg;
  });

  return (
    <div className="flex gap-4 items-center">
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className="shrink-0">
        <circle cx={CX} cy={CY} r={R} fill="none" stroke="#f4f4f5" strokeWidth={16} />
        {segments.map((s) => (
          <circle
            key={s.category}
            cx={CX}
            cy={CY}
            r={R}
            fill="none"
            stroke={CATEGORY_COLORS[s.category] ?? "#334155"}
            strokeWidth={16}
            strokeDasharray={`${s.dash} ${s.gap}`}
            strokeDashoffset={-s.offset}
            transform={`rotate(-90 ${CX} ${CY})`}
          />
        ))}
        <text x={CX} y={CY} textAnchor="middle" dominantBaseline="central" fontSize="10" fill="#52525b" fontFamily="IBM Plex Mono">
          {formatRub(total)}
        </text>
      </svg>
      <div className="space-y-1 flex-1">
        {breakdown.slice(0, 6).map((r) => (
          <div key={r.category} className="flex items-center gap-2 text-xs">
            <span
              className="inline-block w-2.5 h-2.5 rounded-sm shrink-0"
              style={{ background: CATEGORY_COLORS[r.category] ?? "#334155" }}
            />
            <span className="text-ink-2">{CATEGORY_LABELS[r.category] ?? r.category}</span>
            <span className="mono-num text-ink ml-auto">{formatRub(r.total)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

interface BookingOption {
  id: string;
  projectName: string;
  startDate: string;
  client: { name: string };
}

// ── Add expense modal ─────────────────────────────────────────────────────────

function AddExpenseModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 16));
  const [category, setCategory] = useState("OTHER");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [documentUrl, setDocumentUrl] = useState("");
  const [linkedBookingId, setLinkedBookingId] = useState("");
  const [bookings, setBookings] = useState<BookingOption[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    apiFetch<{ bookings: BookingOption[] }>("/api/bookings?status=CONFIRMED,ISSUED&limit=100")
      .then((r) => setBookings(r.bookings ?? []))
      .catch(() => {});
  }, []);

  const handleSubmit = async () => {
    if (!amount || !description) { setError("Заполните обязательные поля"); return; }
    setSaving(true);
    setError("");
    try {
      await apiFetch("/api/expenses", {
        method: "POST",
        body: JSON.stringify({
          date: new Date(date).toISOString(),
          category,
          amount: Number(amount),
          description,
          documentUrl: documentUrl || undefined,
          linkedBookingId: linkedBookingId || undefined,
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
        <h2 className="text-lg font-semibold text-ink mb-4">Добавить расход</h2>
        <div className="space-y-3">
          <div>
            <label className="eyebrow block mb-1">Дата</label>
            <input type="datetime-local" className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink"
              value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <label className="eyebrow block mb-1">Категория</label>
            <select className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink"
              value={category} onChange={(e) => setCategory(e.target.value)}>
              {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="eyebrow block mb-1">Сумма *</label>
            <input type="number" className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink"
              value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
          </div>
          <div>
            <label className="eyebrow block mb-1">Описание *</label>
            <input className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink"
              value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div>
            <label className="eyebrow block mb-1">Документ (URL)</label>
            <input className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink"
              value={documentUrl} onChange={(e) => setDocumentUrl(e.target.value)} placeholder="https://…" />
          </div>
          <div>
            <label className="eyebrow block mb-1">Бронирование (необязательно)</label>
            <select
              className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink"
              value={linkedBookingId}
              onChange={(e) => setLinkedBookingId(e.target.value)}
            >
              <option value="">— не указано —</option>
              {bookings.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.client.name} — {b.projectName} — {new Date(b.startDate).toLocaleDateString("ru-RU")}
                </option>
              ))}
            </select>
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

// ── Main page ─────────────────────────────────────────────────────────────────

function monthStart(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01T00:00:00.000Z`;
}

function monthEnd(d: Date): string {
  const e = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
  return e.toISOString();
}

export default function ExpensesPage() {
  const { authorized, loading } = useRequireRole(ALLOWED);
  const [month, setMonth] = useState(() => new Date());
  const [breakdown, setBreakdown] = useState<BreakdownItem[]>([]);
  const [expenses, setExpenses] = useState<ExpenseItem[]>([]);
  const [showModal, setShowModal] = useState(false);

  const fetchAll = async () => {
    if (!authorized) return;
    const from = monthStart(month);
    const to = monthEnd(month);
    const [brk, exp] = await Promise.all([
      apiFetch<BreakdownItem[]>(`/api/finance/expenses-breakdown?from=${from}&to=${to}`),
      apiFetch<ExpensesResponse>(`/api/expenses?from=${from}&to=${to}&limit=200`),
    ]);
    setBreakdown(brk);
    setExpenses(exp.items);
  };

  useEffect(() => { fetchAll(); }, [authorized, month]);

  const handleDelete = async (id: string) => {
    if (!confirm("Удалить расход?")) return;
    await apiFetch(`/api/expenses/${id}`, { method: "DELETE" });
    await fetchAll();
  };

  const prevMonth = () => setMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1));
  const nextMonth = () => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1));

  const monthStr = month.toLocaleString("ru-RU", { month: "long", year: "numeric" });

  if (loading || !authorized) return null;

  return (
    <div className="space-y-6 pb-10">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="eyebrow">Финансы</p>
          <h1 className="text-2xl font-semibold text-ink mt-1">Расходы</h1>
        </div>
        <button onClick={() => setShowModal(true)}
          className="px-4 py-2 text-sm bg-accent text-white rounded hover:bg-accent-bright">
          + Добавить расход
        </button>
      </div>

      {/* Month selector */}
      <div className="flex items-center gap-3">
        <button onClick={prevMonth} className="p-2 border border-border rounded hover:bg-surface-subtle">‹</button>
        <span className="text-sm font-medium text-ink capitalize">{monthStr}</span>
        <button onClick={nextMonth} className="p-2 border border-border rounded hover:bg-surface-subtle">›</button>
      </div>

      {/* Donut + category list */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-surface border border-border rounded-lg p-4 shadow-xs">
          <p className="eyebrow mb-3">По категориям</p>
          <DonutChart breakdown={breakdown} />
          <p className="text-xs text-ink-3 mt-2">Учтены только одобренные расходы</p>
        </div>
        <div className="bg-surface border border-border rounded-lg p-4 shadow-xs">
          <p className="eyebrow mb-3">Детализация</p>
          <div className="space-y-2">
            {breakdown.map((r) => (
              <div key={r.category} className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  <span className="inline-block w-2 h-2 rounded-full" style={{ background: CATEGORY_COLORS[r.category] ?? "#334155" }} />
                  <span className="text-ink">{CATEGORY_LABELS[r.category] ?? r.category}</span>
                  <span className="text-ink-3 text-xs">({r.count} шт.)</span>
                </div>
                <span className="mono-num text-ink font-medium">{formatRub(r.total)}</span>
              </div>
            ))}
            {breakdown.length === 0 && <p className="text-sm text-ink-3">Нет расходов</p>}
          </div>
        </div>
      </div>

      {/* Transactions table */}
      <div className="bg-surface border border-border rounded-lg shadow-xs overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-surface-subtle">
              <th className="text-left px-4 py-3 text-ink-2 font-medium">Дата</th>
              <th className="text-left px-4 py-3 text-ink-2 font-medium">Категория</th>
              <th className="text-left px-4 py-3 text-ink-2 font-medium">Описание</th>
              <th className="text-left px-4 py-3 text-ink-2 font-medium">Связь</th>
              <th className="text-left px-4 py-3 text-ink-2 font-medium">Статус</th>
              <th className="text-right px-4 py-3 text-ink-2 font-medium">Сумма</th>
              <th className="w-16" />
            </tr>
          </thead>
          <tbody>
            {expenses.map((e) => (
              <tr key={e.id} className="border-b border-border hover:bg-surface-subtle">
                <td className="px-4 py-3 mono-num text-xs text-ink-2">
                  {new Date(e.expenseDate).toLocaleDateString("ru-RU")}
                </td>
                <td className="px-4 py-3 text-ink-2">
                  {CATEGORY_LABELS[e.category] ?? e.category}
                </td>
                <td className="px-4 py-3 text-ink">{e.description ?? e.name}</td>
                <td className="px-4 py-3 text-ink-3 text-xs">
                  {e.booking?.projectName ?? (e.linkedRepairId ? "Ремонт" : "—")}
                </td>
                <td className="px-4 py-3">
                  {e.approved ? (
                    <span className="text-xs bg-emerald-soft text-emerald px-2 py-0.5 rounded-full">Одобрен</span>
                  ) : (
                    <span className="text-xs bg-amber-soft text-amber px-2 py-0.5 rounded-full">На проверке</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right mono-num font-medium text-ink">
                  {formatRub(e.amount)}
                </td>
                <td className="px-4 py-3 text-center">
                  <button onClick={() => handleDelete(e.id)} className="text-xs text-rose hover:underline">
                    Удалить
                  </button>
                </td>
              </tr>
            ))}
            {expenses.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-ink-3 text-sm">
                  Нет расходов за этот месяц
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showModal && (
        <AddExpenseModal
          onClose={() => setShowModal(false)}
          onCreated={async () => { setShowModal(false); await fetchAll(); }}
        />
      )}
    </div>
  );
}
