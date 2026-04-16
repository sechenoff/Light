"use client";

import { useEffect, useState } from "react";
import { useRequireRole } from "../../../src/hooks/useRequireRole";
import { apiFetch } from "../../../src/lib/api";
import { formatRub } from "../../../src/lib/format";
import { FinanceTabNav } from "../../../src/components/finance/FinanceTabNav";
import type { UserRole } from "../../../src/lib/auth";

const ALLOWED: UserRole[] = ["SUPER_ADMIN"];

// ── Category mappings ──────────────────────────────────────────────────────────

type GroupKey = "repair" | "rent" | "purchase" | "payroll" | "other";

const CATEGORY_GROUP: Record<string, GroupKey> = {
  REPAIR: "repair",
  RENT: "rent",
  EQUIPMENT: "purchase",
  PURCHASE: "purchase",
  PAYROLL: "payroll",
  STAFF: "payroll",
  CONTRACTORS: "other",
  TRANSPORT: "other",
  OTHER: "other",
};

const GROUP_META: Record<GroupKey, { label: string; color: string; tailwind: string }> = {
  repair:   { label: "Ремонт",                 color: "var(--color-rose)",    tailwind: "text-rose" },
  rent:     { label: "Аренда и склад",          color: "var(--color-slate)",   tailwind: "text-slate" },
  purchase: { label: "Закупка оборудования",    color: "var(--color-accent)",  tailwind: "text-accent" },
  payroll:  { label: "Зарплата и подряды",      color: "var(--color-amber)",   tailwind: "text-amber" },
  other:    { label: "Логистика и прочее",      color: "var(--color-emerald)", tailwind: "text-emerald" },
};

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

// ── Types ─────────────────────────────────────────────────────────────────────

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

// ── Donut chart (CSS conic-gradient) ─────────────────────────────────────────

interface GroupedData {
  key: GroupKey;
  total: number;
  count: number;
  pct: number;
}

function groupBreakdown(breakdown: BreakdownItem[]): GroupedData[] {
  const map: Partial<Record<GroupKey, { total: number; count: number }>> = {};
  for (const item of breakdown) {
    const gk = CATEGORY_GROUP[item.category] ?? "other";
    if (!map[gk]) map[gk] = { total: 0, count: 0 };
    map[gk]!.total += Number(item.total);
    map[gk]!.count += item.count;
  }
  const total = Object.values(map).reduce((s, v) => s + (v?.total ?? 0), 0);
  return (["repair", "rent", "purchase", "payroll", "other"] as GroupKey[])
    .filter((k) => map[k])
    .map((k) => ({
      key: k,
      total: map[k]!.total,
      count: map[k]!.count,
      pct: total > 0 ? Math.round((map[k]!.total / total) * 100) : 0,
    }));
}

// Map Tailwind color tokens to CSS custom property values for conic-gradient
const COLOR_MAP: Record<GroupKey, string> = {
  repair:   "#9f1239",  // rose
  rent:     "#334155",  // slate
  purchase: "#1e3a8a",  // accent
  payroll:  "#a16207",  // amber
  other:    "#047857",  // emerald
};

function DonutChart({
  grouped,
  total,
  opCount,
}: {
  grouped: GroupedData[];
  total: number;
  opCount: number;
}) {
  if (total === 0)
    return <div className="w-40 h-40 rounded-full bg-surface-subtle flex items-center justify-center text-sm text-ink-3">Нет данных</div>;

  // Build conic-gradient stops
  let acc = 0;
  const stops = grouped.map((g) => {
    const start = acc;
    acc += g.pct;
    return `${COLOR_MAP[g.key]} ${start}% ${acc}%`;
  });
  const gradient = `conic-gradient(${stops.join(", ")})`;

  return (
    <div className="relative w-40 h-40 mx-auto">
      {/* Outer donut ring */}
      <div
        className="w-40 h-40 rounded-full"
        style={{ background: gradient }}
      />
      {/* Hole */}
      <div className="absolute inset-[28px] rounded-full bg-surface" />
      {/* Center text */}
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center z-[1]">
        <p className="eyebrow text-ink-2">Всего</p>
        <p className="mono-num text-[17px] font-semibold text-ink leading-tight">{formatRub(total)}</p>
        <p className="eyebrow text-ink-2 mt-0.5">{opCount} операций</p>
      </div>
    </div>
  );
}

// ── Add expense modal ─────────────────────────────────────────────────────────

interface BookingOption {
  id: string;
  projectName: string;
  startDate: string;
  client: { name: string };
}

function AddExpenseModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
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
    let cancelled = false;
    apiFetch<{ bookings: BookingOption[] }>("/api/bookings?status=CONFIRMED,ISSUED&limit=100")
      .then((r) => { if (!cancelled) setBookings(r.bookings ?? []); })
      .catch(() => {});
    return () => { cancelled = true; };
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
            <select className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink"
              value={linkedBookingId} onChange={(e) => setLinkedBookingId(e.target.value)}>
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function monthStart(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01T00:00:00.000Z`;
}

function monthEnd(d: Date): string {
  const e = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
  return e.toISOString();
}

type FilterKey = "all" | GroupKey;

const FILTER_PILLS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "Все категории" },
  { key: "repair", label: "Ремонт" },
  { key: "rent", label: "Аренда" },
  { key: "purchase", label: "Закупка" },
  { key: "payroll", label: "Зарплаты" },
  { key: "other", label: "Прочее" },
];

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ExpensesPage() {
  const { authorized, loading } = useRequireRole(ALLOWED);
  const [month, setMonth] = useState(() => new Date());
  const [breakdown, setBreakdown] = useState<BreakdownItem[]>([]);
  const [expenses, setExpenses] = useState<ExpenseItem[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [activeFilter, setActiveFilter] = useState<FilterKey>("all");
  const [search, setSearch] = useState("");

  const fetchAll = async (cancelled: { v: boolean }) => {
    if (!authorized) return;
    const from = monthStart(month);
    const to = monthEnd(month);
    const [brk, exp] = await Promise.all([
      apiFetch<BreakdownItem[]>(`/api/finance/expenses-breakdown?from=${from}&to=${to}`),
      apiFetch<ExpensesResponse>(`/api/expenses?from=${from}&to=${to}&limit=200`),
    ]);
    if (!cancelled.v) {
      setBreakdown(brk);
      setExpenses(exp.items);
    }
  };

  useEffect(() => {
    const cancelled = { v: false };
    fetchAll(cancelled);
    return () => { cancelled.v = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authorized, month]);

  const handleDelete = async (id: string) => {
    if (!confirm("Удалить расход?")) return;
    await apiFetch(`/api/expenses/${id}`, { method: "DELETE" });
    const cancelled = { v: false };
    await fetchAll(cancelled);
  };

  const prevMonth = () => setMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1));
  const nextMonth = () => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1));

  if (loading || !authorized) return null;

  const monthStr = month.toLocaleString("ru-RU", { month: "long", year: "numeric" });
  const grouped = groupBreakdown(breakdown);
  const total = grouped.reduce((s, g) => s + g.total, 0);
  const opCount = grouped.reduce((s, g) => s + g.count, 0);

  // Filter expenses
  const filtered = expenses.filter((e) => {
    const gk = CATEGORY_GROUP[e.category] ?? "other";
    const matchFilter = activeFilter === "all" || gk === activeFilter;
    const q = search.toLowerCase();
    const matchSearch =
      !q ||
      (e.description ?? e.name).toLowerCase().includes(q) ||
      (e.booking?.projectName ?? "").toLowerCase().includes(q);
    return matchFilter && matchSearch;
  });

  return (
    <div className="pb-10">
      <FinanceTabNav />

      <div className="px-7 py-5">
        {/* Header */}
        <div className="flex justify-between items-end mb-4 pb-3.5 border-b border-border">
          <div>
            <h1 className="text-[22px] font-semibold text-ink tracking-tight">Расходы</h1>
            <p className="text-xs text-ink-2 mt-0.5">
              За {monthStr.toLowerCase()} потрачено{" "}
              <strong className="mono-num text-slate">{formatRub(total)}</strong>
              {" · "}{opCount} операций
            </p>
          </div>
          <div className="flex gap-2">
            <div className="flex items-center gap-1.5 bg-surface-subtle border border-border rounded p-1">
              {["Неделя", "Месяц", "Квартал", "Год"].map((lbl) => (
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
            <div className="flex items-center gap-1.5 border border-border rounded p-1">
              <button onClick={prevMonth} aria-label="Предыдущий месяц" className="px-2 py-1 text-xs text-ink-2 hover:text-ink">‹</button>
              <span className="text-xs font-medium text-ink capitalize">{monthStr}</span>
              <button onClick={nextMonth} aria-label="Следующий месяц" className="px-2 py-1 text-xs text-ink-2 hover:text-ink">›</button>
            </div>
            <button
              onClick={() => setShowModal(true)}
              className="px-3.5 py-1.5 text-xs font-medium bg-accent text-white rounded border border-accent hover:bg-accent-bright"
            >
              + Добавить расход
            </button>
          </div>
        </div>

        {/* Donut + categories panel */}
        <div className="bg-surface border border-border rounded-[6px] overflow-hidden shadow-xs mb-4">
          <div className="flex justify-between items-center px-4 py-3.5 border-b border-border">
            <h3 className="text-[13.5px] font-semibold text-ink">Структура расходов за {monthStr.toLowerCase()}</h3>
          </div>

          <div className="grid gap-5 px-5 py-5 pb-3.5 border-b border-border" style={{ gridTemplateColumns: "200px 1fr" }}>
            {/* Donut */}
            <DonutChart grouped={grouped} total={total} opCount={opCount} />

            {/* Category list */}
            <div className="flex flex-col gap-1.5">
              {grouped.length === 0 ? (
                <p className="text-sm text-ink-3">Нет расходов</p>
              ) : (
                grouped.map((g) => {
                  const meta = GROUP_META[g.key];
                  const barWidth = total > 0 ? Math.round((g.total / total) * 100) : 0;
                  return (
                    <div key={g.key} className="grid items-center gap-2.5 py-1" style={{ gridTemplateColumns: "14px 1fr auto auto" }}>
                      <span
                        className="w-2.5 h-2.5 rounded-sm shrink-0"
                        style={{ background: COLOR_MAP[g.key] }}
                      />
                      <div>
                        <p className="text-[12.5px] font-medium text-ink">{meta.label}</p>
                        <div className="h-[5px] bg-surface-subtle rounded-full mt-1 min-w-[120px]">
                          <div
                            className="h-full rounded-full"
                            style={{ width: `${barWidth}%`, background: COLOR_MAP[g.key] }}
                          />
                        </div>
                      </div>
                      <span className="mono-num font-semibold text-[12.5px] text-right min-w-[85px]">{formatRub(g.total)}</span>
                      <span className="mono-num text-[11.5px] text-ink-2 text-right min-w-[38px]">{g.pct}%</span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* Table panel */}
        <div className="bg-surface border border-border rounded-[6px] overflow-hidden shadow-xs">
          {/* Filter bar */}
          <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-surface-subtle flex-wrap">
            {FILTER_PILLS.map((f) => (
              <button
                key={f.key}
                onClick={() => setActiveFilter(f.key)}
                className={`border rounded-full px-3 py-1 text-[11.5px] font-medium transition-colors ${
                  activeFilter === f.key
                    ? "bg-accent text-white border-accent"
                    : "bg-surface border-border text-ink-2 hover:bg-surface-subtle"
                }`}
              >
                {f.label}
              </button>
            ))}
            <div className="flex-1" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск по описанию"
              className="bg-surface border border-border rounded px-2.5 py-1 text-xs text-ink-2 min-w-[180px]"
            />
          </div>

          <table className="w-full text-[12.5px] border-collapse">
            <thead>
              <tr>
                <th className="w-1 p-0" />
                <th className="text-left px-3.5 py-2.5 bg-surface-subtle border-b border-border eyebrow" style={{ width: "13%" }}>Дата</th>
                <th className="text-left px-3.5 py-2.5 bg-surface-subtle border-b border-border eyebrow" style={{ width: "30%" }}>Категория и описание</th>
                <th className="text-left px-3.5 py-2.5 bg-surface-subtle border-b border-border eyebrow">Основание</th>
                <th className="text-right px-3.5 py-2.5 bg-surface-subtle border-b border-border eyebrow" style={{ width: "14%" }}>Сумма</th>
                <th className="text-right px-3.5 py-2.5 bg-surface-subtle border-b border-border eyebrow" style={{ width: "12%" }}>Действия</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e) => {
                const gk = CATEGORY_GROUP[e.category] ?? "other";
                const meta = GROUP_META[gk];
                const catLabel = CATEGORY_LABELS[e.category] ?? e.category;
                return (
                  <tr key={e.id} className="border-b border-border hover:bg-surface-subtle">
                    <td
                      className="w-1 p-0 border-l-[3px]"
                      style={{ borderLeftColor: COLOR_MAP[gk] }}
                    />
                    <td className="px-3.5 py-3 mono-num text-xs text-ink-2 align-middle">
                      {new Date(e.expenseDate).toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}
                    </td>
                    <td className="px-3.5 py-3 align-middle">
                      <p className="font-medium text-ink">{catLabel} · {e.description ?? e.name}</p>
                      {e.booking?.projectName && (
                        <p className="text-[11px] text-ink-2 mt-0.5">{e.booking.projectName}</p>
                      )}
                    </td>
                    <td className="px-3.5 py-3 align-middle text-ink-2">
                      {e.linkedRepairId ? (
                        <span className="text-xs">Ремонт</span>
                      ) : (
                        <span className="text-xs">—</span>
                      )}
                    </td>
                    <td className={`px-3.5 py-3 text-right mono-num font-semibold align-middle ${meta.tailwind}`}>
                      {formatRub(e.amount)}
                    </td>
                    <td className="px-3.5 py-3 text-right align-middle">
                      <div className="flex gap-1.5 justify-end">
                        {e.booking && (
                          <a
                            href={`/bookings/${e.bookingId}`}
                            aria-label="Открыть бронь"
                            className="w-[26px] h-[26px] rounded border border-border bg-surface flex items-center justify-center text-ink-2 hover:bg-surface-subtle text-sm font-medium"
                          >
                            ›
                          </a>
                        )}
                        <button
                          onClick={() => handleDelete(e.id)}
                          aria-label="Удалить расход"
                          className="w-[26px] h-[26px] rounded border border-rose-border bg-rose-soft flex items-center justify-center text-rose hover:bg-rose-soft text-xs font-medium"
                        >
                          ✕
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-ink-3 text-sm">
                    {expenses.length === 0 ? "Нет расходов за этот месяц" : "Нет результатов по фильтру"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showModal && (
        <AddExpenseModal
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
