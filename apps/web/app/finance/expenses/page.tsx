"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { useRequireRole } from "../../../src/hooks/useRequireRole";
import { apiFetch } from "../../../src/lib/api";
import { formatRub } from "../../../src/lib/format";
import { FinanceTabNav } from "../../../src/components/finance/FinanceTabNav";
import { PeriodSelector } from "../../../src/components/finance/PeriodSelector";
import { ExpenseDocumentUpload } from "../../../src/components/finance/ExpenseDocumentUpload";
import { StatusPill } from "../../../src/components/StatusPill";
import { derivePeriodRange, type PeriodKey } from "../../../src/lib/periodUtils";
import type { UserRole } from "../../../src/lib/auth";
import { toast } from "../../../src/components/ToastProvider";

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

const GROUP_META: Record<GroupKey, { label: string; icon: string; color: string }> = {
  repair:   { label: "Запчасти",            icon: "🔧", color: "#a16207" },
  rent:     { label: "Аренда и склад",      icon: "🏢", color: "#334155" },
  purchase: { label: "Закупка",             icon: "🛒", color: "#1e3a8a" },
  payroll:  { label: "Зарплата",            icon: "💼", color: "#a16207" },
  other:    { label: "Транспорт и прочее",  icon: "🚗", color: "#0f766e" },
};

const CATEGORY_LABELS: Record<string, string> = {
  TRANSPORT: "Транспорт",
  EQUIPMENT: "Оборудование",
  CONTRACTORS: "Подрядчики",
  STAFF: "Персонал",
  RENT: "Аренда",
  REPAIR: "Запчасти",
  PAYROLL: "Зарплата",
  PURCHASE: "Закупки",
  OTHER: "Прочее",
};

// Filter pills definition
type FilterKey = "all" | GroupKey;

const FILTER_PILLS: { key: FilterKey; label: string; icon: string }[] = [
  { key: "all",      label: "Все",      icon: "" },
  { key: "repair",   label: "Запчасти", icon: "🔧" },
  { key: "other",    label: "Транспорт", icon: "🚗" },
  { key: "payroll",  label: "Зарплата", icon: "💼" },
  { key: "purchase", label: "Закупка",  icon: "🛒" },
  { key: "rent",     label: "Прочее",   icon: "📦" },
];

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
  documentUrl: string | null;
  booking: { id: string; projectName: string } | null;
}

interface ExpensesResponse {
  items: ExpenseItem[];
  total: number;
}

// ── Donut chart (SVG stroke-dasharray technique) ──────────────────────────────

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

function DonutSVG({ grouped }: { grouped: GroupedData[] }) {
  // SVG circle circumference for r=15.9155 → C = 2πr ≈ 100
  const CIRC = 100;
  let offset = 0;
  const segments = grouped.map((g) => {
    const dash = g.pct;
    const seg = { ...g, dash, offset };
    offset += dash;
    return seg;
  });

  if (grouped.length === 0) {
    return (
      <svg viewBox="0 0 36 36" className="w-[110px] h-[110px]">
        <circle cx="18" cy="18" r="15.9155" fill="none" stroke="var(--color-surface-subtle)" strokeWidth="3.5"/>
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 36 36" className="w-[110px] h-[110px]">
      {/* background track */}
      <circle cx="18" cy="18" r="15.9155" fill="none" stroke="var(--color-surface-subtle)" strokeWidth="3.5"/>
      {segments.map((seg) => (
        <circle
          key={seg.key}
          cx="18" cy="18" r="15.9155"
          fill="none"
          stroke={GROUP_META[seg.key].color}
          strokeWidth="3.5"
          strokeDasharray={`${seg.dash} ${CIRC - seg.dash}`}
          strokeDashoffset={-seg.offset}
        />
      ))}
    </svg>
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
  const [linkedBookingId, setLinkedBookingId] = useState("");
  const [bookings, setBookings] = useState<BookingOption[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedExpenseId, setSavedExpenseId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // C2: split into 3 calls — API Zod rejects comma-separated status values
    Promise.all([
      apiFetch<{ bookings: BookingOption[] }>("/api/bookings?status=CONFIRMED&limit=100"),
      apiFetch<{ bookings: BookingOption[] }>("/api/bookings?status=ISSUED&limit=100"),
      apiFetch<{ bookings: BookingOption[] }>("/api/bookings?status=RETURNED&limit=100"),
    ])
      .then(([c, i, r]) => {
        if (!cancelled) setBookings([...(c.bookings ?? []), ...(i.bookings ?? []), ...(r.bookings ?? [])]);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const handleSubmit = async () => {
    if (!amount || !description) { setError("Заполните обязательные поля"); return; }
    setSaving(true);
    setError("");
    try {
      const created = await apiFetch<{ expense: { id: string } }>("/api/expenses", {
        method: "POST",
        body: JSON.stringify({
          date: new Date(date).toISOString(),
          category,
          amount: Number(amount),
          description,
          linkedBookingId: linkedBookingId || undefined,
        }),
      });
      if (created?.expense?.id) {
        setSavedExpenseId(created.expense.id);
      } else {
        onCreated();
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Ошибка");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-surface rounded-lg p-6 w-full max-w-md shadow-xl">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-semibold text-ink">Добавить расход</h2>
          <button onClick={onClose} aria-label="Закрыть" className="text-ink-3 hover:text-ink text-xl leading-none">×</button>
        </div>

        {savedExpenseId ? (
          <div className="space-y-4">
            <p className="text-sm text-ink-2">Расход сохранён. Прикрепите документ (необязательно).</p>
            <ExpenseDocumentUpload
              expenseId={savedExpenseId}
              existingDocumentUrl={null}
              onUploaded={onCreated}
            />
            <div className="flex gap-2 justify-end pt-2">
              <button onClick={onCreated}
                className="px-4 py-2 text-sm border border-border rounded text-ink-2 hover:bg-surface-subtle">
                Пропустить
              </button>
            </div>
          </div>
        ) : (
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
        )}
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

function ExpensesPageInner() {
  const { authorized, loading } = useRequireRole(ALLOWED);
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialPeriod = (searchParams.get("period") as PeriodKey | null) ?? "month";
  const [period, setPeriod] = useState<PeriodKey>(initialPeriod);

  function handlePeriodChange(p: PeriodKey) {
    setPeriod(p);
    const params = new URLSearchParams(searchParams.toString());
    params.set("period", p);
    router.replace(`?${params.toString()}`, { scroll: false });
  }

  const [breakdown, setBreakdown] = useState<BreakdownItem[]>([]);
  const [expenses, setExpenses] = useState<ExpenseItem[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [docModalExpenseId, setDocModalExpenseId] = useState<string | null>(null);
  const [docModalExistingUrl, setDocModalExistingUrl] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<FilterKey>("all");
  // pending filter: null = show all, true = show only pending
  const [showPendingOnly, setShowPendingOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [fetchError, setFetchError] = useState<string | null>(null);

  const fetchAll = async (cancelled: { v: boolean }) => {
    if (!authorized) return;
    try {
      const range = derivePeriodRange(period);
      const [brk, exp] = await Promise.all([
        apiFetch<BreakdownItem[]>(`/api/finance/expenses-breakdown?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`),
        apiFetch<ExpensesResponse>(`/api/expenses?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}&limit=200`),
      ]);
      if (!cancelled.v) {
        setBreakdown(brk);
        setExpenses(exp.items);
        setFetchError(null);
      }
    } catch (e) {
      if (!cancelled.v) setFetchError(e instanceof Error ? e.message : "Ошибка загрузки");
    }
  };

  useEffect(() => {
    const cancelled = { v: false };
    fetchAll(cancelled);
    return () => { cancelled.v = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authorized, period]);

  const handleDelete = async (id: string) => {
    if (!confirm("Удалить расход?")) return;
    await apiFetch(`/api/expenses/${id}`, { method: "DELETE" });
    const cancelled = { v: false };
    await fetchAll(cancelled);
  };

  const handleApprove = async (id: string) => {
    try {
      await apiFetch(`/api/expenses/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ approved: true }),
      });
      toast.success("Расход утверждён");
      const cancelled = { v: false };
      await fetchAll(cancelled);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Ошибка при утверждении");
    }
  };

  if (loading || !authorized) return null;
  if (fetchError) return <div className="p-8 text-rose text-sm">Ошибка: {fetchError}</div>;

  const grouped = groupBreakdown(breakdown);
  const totalAll = grouped.reduce((s, g) => s + g.total, 0);
  const opCountAll = grouped.reduce((s, g) => s + g.count, 0);

  // Approved/pending split
  const approvedItems = expenses.filter((e) => e.approved);
  const pendingItems = expenses.filter((e) => !e.approved);
  const approvedTotal = approvedItems.reduce((s, e) => s + Number(e.amount), 0);
  const pendingTotal = pendingItems.reduce((s, e) => s + Number(e.amount), 0);

  // Filter expenses for table
  const filtered = expenses.filter((e) => {
    const gk = CATEGORY_GROUP[e.category] ?? "other";
    const matchFilter = activeFilter === "all" || gk === activeFilter;
    const matchPending = !showPendingOnly || !e.approved;
    const q = search.toLowerCase();
    const matchSearch =
      !q ||
      (e.description ?? e.name).toLowerCase().includes(q) ||
      (e.booking?.projectName ?? "").toLowerCase().includes(q);
    return matchFilter && matchSearch && matchPending;
  });

  // Is REPAIR category without linkedRepairId? → warn badge
  function isUnlinkedRepair(e: ExpenseItem): boolean {
    return (e.category === "REPAIR" || CATEGORY_GROUP[e.category] === "repair") && !e.linkedRepairId;
  }

  return (
    <div className="pb-10">
      <FinanceTabNav />

      <div className="px-4 md:px-7 py-5">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:justify-between md:items-center mb-5 gap-3">
          <div>
            <p className="eyebrow text-ink-3">Финансы</p>
            <h1 className="text-[22px] font-semibold text-ink tracking-tight">Расходы</h1>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <PeriodSelector value={period} onChange={handlePeriodChange} />
            <button
              onClick={() => setShowModal(true)}
              className="px-3.5 py-1.5 text-xs font-medium bg-accent-bright text-white rounded hover:bg-accent transition-colors"
            >
              + Записать расход
            </button>
          </div>
        </div>

        {/* Summary grid: Утверждено | Ждут | Доnut */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5 mb-5">
          {/* Approved */}
          <div className="bg-surface border border-border rounded-[8px] p-4 shadow-xs">
            <p className="eyebrow text-ink-3 mb-1">Утверждено за период</p>
            <p className="mono-num text-[24px] font-semibold text-rose leading-tight">
              −{formatRub(approvedTotal)}
            </p>
            <p className="text-xs text-ink-3 mt-1">{approvedItems.length} операций</p>
          </div>

          {/* Pending */}
          <button
            onClick={() => setShowPendingOnly((v) => !v)}
            className={`text-left bg-amber-soft border rounded-[8px] p-4 shadow-xs transition-all ${
              showPendingOnly
                ? "border-amber ring-1 ring-amber"
                : "border-amber-border hover:border-amber"
            }`}
          >
            <p className="eyebrow text-amber mb-1">Ждут утверждения</p>
            <p className="mono-num text-[24px] font-semibold text-amber leading-tight">
              {formatRub(pendingTotal)}
            </p>
            <p className="text-xs text-amber mt-1">
              {pendingItems.length} {pendingItems.length === 1 ? "операция" : "операции"} — {showPendingOnly ? "сбросить фильтр" : "открыть фильтр"}
            </p>
          </button>

          {/* Distribution donut */}
          <div className="bg-surface border border-border rounded-[8px] p-4 shadow-xs">
            <p className="eyebrow text-ink-3 mb-3">Распределение</p>
            <div className="flex items-center gap-3">
              <DonutSVG grouped={grouped} />
              <div className="flex flex-col gap-1 text-[11.5px] text-ink-2 min-w-0">
                {grouped.length === 0 ? (
                  <span className="text-ink-3">Нет данных</span>
                ) : (
                  grouped.map((g) => (
                    <span key={g.key} className="flex items-center gap-1.5 truncate">
                      <span
                        className="inline-block w-2 h-2 rounded-sm shrink-0"
                        style={{ background: GROUP_META[g.key].color }}
                      />
                      {GROUP_META[g.key].label}{" "}
                      <span className="mono-num font-medium text-ink">{Math.round(g.total / 1000)}k</span>
                    </span>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Filter row */}
        <div className="flex flex-col md:flex-row items-start md:items-center gap-2.5 mb-3.5 flex-wrap">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="🔍 описание, привязка…"
            className="border border-border rounded-lg px-3 py-2 text-[13px] bg-surface text-ink min-w-[200px] focus:outline-none focus:border-accent"
          />
          <div className="flex gap-1.5 flex-wrap">
            {FILTER_PILLS.map((f) => (
              <button
                key={f.key}
                onClick={() => setActiveFilter(f.key)}
                className={`px-3 py-1.5 border rounded-[6px] text-xs font-medium transition-colors ${
                  activeFilter === f.key
                    ? "bg-accent-soft text-accent-bright border-accent-border"
                    : "bg-surface border-border text-ink-2 hover:bg-surface-subtle"
                }`}
              >
                {f.icon && <span className="mr-1">{f.icon}</span>}{f.label}
              </button>
            ))}
          </div>
        </div>

        {/* Desktop table */}
        <div className="hidden md:block bg-surface border border-border rounded-[6px] overflow-hidden shadow-xs">
          <table className="w-full text-[12.5px] border-collapse">
            <thead>
              <tr className="bg-surface-subtle border-b border-border">
                <th className="text-left px-3.5 py-2.5 eyebrow" style={{ width: "10%" }}>Дата</th>
                <th className="text-left px-3.5 py-2.5 eyebrow" style={{ width: "14%" }}>Категория</th>
                <th className="text-left px-3.5 py-2.5 eyebrow">Описание</th>
                <th className="text-left px-3.5 py-2.5 eyebrow" style={{ width: "14%" }}>Привязка</th>
                <th className="text-left px-3.5 py-2.5 eyebrow" style={{ width: "10%" }}>Документ</th>
                <th className="text-right px-3.5 py-2.5 eyebrow" style={{ width: "11%" }}>Сумма</th>
                <th className="text-left px-3.5 py-2.5 eyebrow" style={{ width: "10%" }}>Статус</th>
                <th className="text-right px-3.5 py-2.5 eyebrow" style={{ width: "10%" }}></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e) => {
                const gk = CATEGORY_GROUP[e.category] ?? "other";
                const catLabel = CATEGORY_LABELS[e.category] ?? e.category;
                const isPending = !e.approved;
                const unlinkedRepair = isUnlinkedRepair(e);

                return (
                  <tr
                    key={e.id}
                    className={`border-b border-border ${
                      isPending ? "bg-amber-soft/50" : "hover:bg-surface-subtle"
                    }`}
                  >
                    <td className="px-3.5 py-3 mono-num text-xs text-ink-2 align-middle">
                      {new Date(e.expenseDate).toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}
                    </td>
                    <td className="px-3.5 py-3 align-middle">
                      <span className="text-[12px] font-medium text-ink">
                        {GROUP_META[gk].icon} {catLabel}
                      </span>
                    </td>
                    <td className="px-3.5 py-3 align-middle">
                      <p className="font-medium text-ink">{e.description ?? e.name}</p>
                      {e.booking?.projectName && (
                        <p className="text-[11px] text-ink-2 mt-0.5">{e.booking.projectName}</p>
                      )}
                    </td>
                    {/* Привязка: repair → amber badge, booking → accent badge, unlinked repair → warn pill */}
                    <td className="px-3.5 py-3 align-middle">
                      {e.linkedRepairId ? (
                        <a
                          href={`/repair/${e.linkedRepairId}`}
                          className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-[4px] bg-amber-soft text-amber hover:opacity-80 transition-opacity whitespace-nowrap mono-num"
                        >
                          🛠 R-{e.linkedRepairId.slice(-6)}
                        </a>
                      ) : e.bookingId ? (
                        <a
                          href={`/bookings/${e.bookingId}`}
                          className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-[4px] bg-accent-soft text-accent-bright hover:opacity-80 transition-opacity whitespace-nowrap mono-num"
                        >
                          📦 #{e.bookingId.slice(-6)}
                        </a>
                      ) : unlinkedRepair ? (
                        <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-amber-soft text-amber border border-amber-border">
                          ⚠ Не привязан
                        </span>
                      ) : (
                        <span className="text-xs text-ink-3">—</span>
                      )}
                    </td>
                    {/* Документ */}
                    <td className="px-3.5 py-3 align-middle">
                      {e.documentUrl ? (
                        <a
                          href={`/api/expenses/${e.id}/document`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-[11px] text-accent-bright hover:underline"
                        >
                          📎 файл
                        </a>
                      ) : (
                        <button
                          onClick={() => { setDocModalExpenseId(e.id); setDocModalExistingUrl(null); }}
                          aria-label="Прикрепить документ"
                          className="text-xs text-ink-3 hover:text-ink-2"
                        >
                          —
                        </button>
                      )}
                    </td>
                    <td className="px-3.5 py-3 text-right mono-num font-semibold align-middle text-rose">
                      −{formatRub(e.amount)}
                    </td>
                    {/* Статус */}
                    <td className="px-3.5 py-3 align-middle">
                      {isPending ? (
                        <StatusPill variant="warn" label="Ждёт утв." />
                      ) : (
                        <StatusPill variant="ok" label="Утверждён" />
                      )}
                    </td>
                    {/* Actions */}
                    <td className="px-3.5 py-3 text-right align-middle">
                      <div className="flex gap-1 justify-end">
                        {isPending && (
                          <button
                            aria-label="Утвердить"
                            title="Утвердить расход"
                            onClick={() => handleApprove(e.id)}
                            className="w-7 h-7 rounded border border-emerald bg-surface flex items-center justify-center text-emerald hover:bg-emerald/10 text-xs font-medium"
                          >
                            ✓
                          </button>
                        )}
                        {e.documentUrl ? (
                          <a
                            href={`/api/expenses/${e.id}/document`}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label="Открыть документ"
                            className="w-7 h-7 rounded border border-border bg-surface flex items-center justify-center text-ink-2 hover:bg-surface-subtle text-xs"
                          >
                            📄
                          </a>
                        ) : (
                          <button
                            onClick={() => { setDocModalExpenseId(e.id); setDocModalExistingUrl(null); }}
                            aria-label="Прикрепить документ"
                            className="w-7 h-7 rounded border border-border bg-surface flex items-center justify-center text-ink-3 hover:bg-surface-subtle text-xs"
                          >
                            📎
                          </button>
                        )}
                        <button
                          onClick={() => handleDelete(e.id)}
                          aria-label="Удалить расход"
                          className="w-7 h-7 rounded border border-rose-border bg-rose-soft flex items-center justify-center text-rose hover:bg-rose-soft/80 text-xs"
                        >
                          🗑
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center">
                    {expenses.length === 0 ? (
                      <div className="flex flex-col items-center gap-2">
                        <p className="eyebrow">Расходы за период</p>
                        <p className="text-[15px] font-medium text-ink">Расходов за период нет</p>
                        <button
                          onClick={() => setShowModal(true)}
                          className="mt-1 px-4 py-2 text-sm bg-accent-bright text-white rounded hover:bg-accent transition-colors"
                        >
                          Записать расход →
                        </button>
                      </div>
                    ) : (
                      <p className="text-sm text-ink-3">Нет результатов по фильтру</p>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {opCountAll > 0 && (
            <div className="px-4 py-2 border-t border-border bg-surface-subtle text-xs text-ink-3">
              За период: {opCountAll} операций · итого −{formatRub(totalAll)}
            </div>
          )}
        </div>

        {/* Mobile card list */}
        <div className="md:hidden">
          <div className="mb-3">
            <p className="eyebrow text-rose mb-1">Расходы · {period}</p>
            <p className="mono-num text-[26px] font-semibold text-rose">−{formatRub(totalAll)}</p>
            <p className="text-xs text-ink-3 mt-0.5">{approvedItems.length} утверждено · {pendingItems.length} ждут</p>
          </div>

          {/* Mobile category pills horizontal scroll */}
          <div className="flex gap-1.5 overflow-x-auto pb-2 mb-3 -mx-4 px-4">
            {FILTER_PILLS.map((f) => (
              <button
                key={f.key}
                onClick={() => setActiveFilter(f.key)}
                className={`flex-shrink-0 px-3 py-1.5 border rounded-[6px] text-xs font-medium transition-colors ${
                  activeFilter === f.key
                    ? "bg-accent-soft text-accent-bright border-accent-border"
                    : "bg-surface border-border text-ink-2"
                }`}
              >
                {f.icon && <span className="mr-1">{f.icon}</span>}{f.label}
              </button>
            ))}
          </div>

          <div className="flex flex-col gap-2">
            {filtered.map((e) => {
              const gk = CATEGORY_GROUP[e.category] ?? "other";
              const catLabel = CATEGORY_LABELS[e.category] ?? e.category;
              const isPending = !e.approved;

              return (
                <div
                  key={e.id}
                  className={`rounded-[10px] p-3 border ${
                    isPending
                      ? "border-amber-border bg-amber-soft/50"
                      : "border-border bg-surface"
                  }`}
                >
                  <div className="flex justify-between items-start gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold text-[13px] text-ink truncate">
                        {e.description ?? e.name}
                      </p>
                      <p className="text-xs text-ink-3 mt-0.5">
                        {new Date(e.expenseDate).toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}{" · "}
                        {GROUP_META[gk].icon} {catLabel}
                        {e.linkedRepairId && (
                          <> · <a href={`/repair/${e.linkedRepairId}`} className="text-amber underline">🛠 Ремонт</a></>
                        )}
                        {!e.linkedRepairId && e.bookingId && (
                          <> · <a href={`/bookings/${e.bookingId}`} className="text-accent-bright underline">📦 Бронь</a></>
                        )}
                      </p>
                    </div>
                    <span className="mono-num text-[14px] font-semibold text-rose shrink-0">−{formatRub(e.amount)}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-2">
                    {isPending ? (
                      <StatusPill variant="warn" label="Ждёт утв." />
                    ) : (
                      <StatusPill variant="ok" label="Утверждён" />
                    )}
                    {isPending && (
                      <button
                        aria-label="Утвердить расход"
                        onClick={() => handleApprove(e.id)}
                        className="ml-auto px-2.5 py-1 border border-emerald text-emerald rounded text-xs hover:bg-emerald/10"
                      >
                        ✓ Утвердить
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
            {filtered.length === 0 && (
              <p className="text-sm text-ink-3 text-center py-8">Нет расходов</p>
            )}
          </div>

          <button
            onClick={() => setShowModal(true)}
            className="mt-4 w-full py-2.5 text-sm font-medium bg-accent-bright text-white rounded-lg hover:bg-accent transition-colors"
          >
            + Записать расход
          </button>
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

      {docModalExpenseId && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-surface rounded-lg p-6 w-full max-w-md shadow-xl">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-semibold text-ink">Документ расхода</h2>
              <button
                onClick={() => setDocModalExpenseId(null)}
                aria-label="Закрыть"
                className="text-ink-3 hover:text-ink text-xl leading-none"
              >
                ×
              </button>
            </div>
            <ExpenseDocumentUpload
              expenseId={docModalExpenseId}
              existingDocumentUrl={docModalExistingUrl}
              onUploaded={async () => {
                setDocModalExpenseId(null);
                const cancelled = { v: false };
                await fetchAll(cancelled);
              }}
            />
            <div className="flex justify-end mt-3">
              <button
                onClick={() => setDocModalExpenseId(null)}
                className="px-4 py-2 text-sm border border-border rounded text-ink-2 hover:bg-surface-subtle"
              >
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ExpensesPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-ink-3">Загрузка…</div>}>
      <ExpensesPageInner />
    </Suspense>
  );
}
