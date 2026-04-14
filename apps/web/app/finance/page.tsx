"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { apiFetch, apiFetchRaw } from "../../src/lib/api";
import { StatusBadge } from "../../src/components/StatusBadge";
import { formatMoneyRub } from "../../src/lib/format";
import { RoleGuard } from "../../src/components/RoleGuard";

type Tab = "bookings" | "dashboard" | "payments" | "receivables" | "expenses" | "profit" | "cashflow";

type BookingRow = {
  id: string;
  status: "DRAFT" | "CONFIRMED" | "ISSUED" | "RETURNED" | "CANCELLED";
  paymentStatus: "NOT_PAID" | "PARTIALLY_PAID" | "PAID" | "OVERDUE";
  projectName: string;
  startDate: string;
  endDate: string;
  displayName: string;
  client: { id: string; name: string };
  items: Array<{ id: string; equipmentId: string; quantity: number; equipment: { id: string; name: string; category: string } }>;
  amountPaid: string;
  amountOutstanding: string;
  finalAmount: string;
  expectedPaymentDate: string | null;
  confirmedAt: string | null;
  createdAt: string;
};

type DashboardResponse = {
  incomeToday: string;
  incomeWeek: string;
  incomeMonth: string;
  monthProfit: string;
  expectedPayments: Array<{
    id: string;
    amount: string;
    plannedPaymentDate: string | null;
    payerName: string | null;
    booking: null | { id: string; projectName: string; clientName: string };
  }>;
  overdueBookings: Array<{
    id: string;
    clientName: string;
    projectName: string;
    expectedPaymentDate: string | null;
    amountOutstanding: string;
  }>;
  summary: {
    totalIncome: string;
    totalReceivables: string;
    overdueReceivables: string;
    grossProfit: string;
    expenses: string;
    netProfit: string;
    unpaidCount: number;
    partialCount: number;
  };
};

type PaymentRow = {
  id: string;
  bookingId: string | null;
  amount: string;
  currency: string;
  paymentDate: string | null;
  plannedPaymentDate: string | null;
  paymentMethod: "CASH" | "BANK_TRANSFER" | "CARD" | "OTHER";
  direction: "INCOME" | "EXPENSE";
  status: "PLANNED" | "RECEIVED" | "CANCELLED";
  payerName: string | null;
  comment: string | null;
  booking: null | {
    id: string;
    projectName: string;
    client: { name: string };
  };
};

type ExpenseRow = {
  id: string;
  bookingId: string | null;
  category: "TRANSPORT" | "EQUIPMENT" | "CONTRACTORS" | "STAFF" | "RENT" | "REPAIR" | "OTHER";
  name: string;
  amount: string;
  currency: string;
  expenseDate: string;
  comment: string | null;
  booking: null | { id: string; projectName: string; client: { name: string } };
};

type ReceivableRow = {
  id: string;
  status?: "DRAFT" | "CONFIRMED" | "ISSUED" | "RETURNED" | "CANCELLED";
  startDate?: string;
  endDate?: string;
  clientName: string;
  projectName: string;
  finalAmount: string;
  amountPaid: string;
  amountOutstanding: string;
  expectedPaymentDate: string | null;
  paymentStatus: "NOT_PAID" | "PARTIALLY_PAID" | "PAID" | "OVERDUE";
  paymentComment: string | null;
};

type ProfitResponse = {
  revenue: string;
  expenses: string;
  grossProfit: string;
  netProfit: string;
  byBooking: Array<{
    bookingId: string;
    clientName: string;
    projectName: string;
    revenue: string;
    expenses: string;
    profit: string;
  }>;
  byClient: Array<{
    clientName: string;
    revenue: string;
    expenses: string;
    profit: string;
  }>;
};

type CashflowRow = {
  id: string;
  date: string;
  type: "income" | "expense";
  status: string;
  amount: string;
  bookingId: string | null;
  clientName: string | null;
  projectName: string | null;
  comment: string | null;
  source: "payment" | "expense";
};

const tabs: Array<{ id: Tab; label: string }> = [
  { id: "bookings", label: "Брони" },
  { id: "dashboard", label: "Сводка" },
  { id: "payments", label: "Платежи" },
  { id: "receivables", label: "Долги" },
  { id: "expenses", label: "Расходы" },
  { id: "profit", label: "Прибыль" },
  { id: "cashflow", label: "Движение денег" },
];

function paymentMethodRu(v: string): string {
  if (v === "BANK_TRANSFER") return "ИП";
  if (v === "CARD") return "Перевод на карты";
  if (v === "CASH") return "Наличные";
  return "Другое";
}

function statusRu(v: string): string {
  if (v === "PLANNED") return "Ожидается";
  if (v === "RECEIVED") return "Получен";
  if (v === "CANCELLED") return "Отменен";
  if (v === "NOT_PAID") return "Не оплачен";
  if (v === "PARTIALLY_PAID") return "Частично оплачен";
  if (v === "PAID") return "Оплачен";
  if (v === "OVERDUE") return "Просрочен";
  if (v === "CONFIRMED") return "Подтвержден";
  if (v === "ISSUED") return "Выдан";
  if (v === "RETURNED") return "Возвращен";
  if (v === "DRAFT") return "Черновик";
  return v;
}

function cashflowTypeRu(v: CashflowRow["type"]): string {
  return v === "income" ? "Приход" : "Расход";
}

function cashflowSourceRu(v: CashflowRow["source"]): string {
  return v === "payment" ? "Платеж" : "Расход";
}

// Доступ ограничен ролью SUPER_ADMIN — локальный пароль убран,
// проверка идёт через RoleGuard на основе сессии пользователя.
export default function FinancePage() {
  return (
    <RoleGuard allow={["SUPER_ADMIN"]}>
      <FinancePageInner />
    </RoleGuard>
  );
}

function FinancePageInner() {
  const [tab, setTab] = useState<Tab>("bookings");
  const [bookings, setBookings] = useState<BookingRow[]>([]);
  const [bookingStatusFilter, setBookingStatusFilter] = useState<string>("");
  const [bookingPaymentFilter, setBookingPaymentFilter] = useState<string>("");
  const [bookingBusyId, setBookingBusyId] = useState<string | null>(null);
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [receivables, setReceivables] = useState<ReceivableRow[]>([]);
  const [expenses, setExpenses] = useState<ExpenseRow[]>([]);
  const [profit, setProfit] = useState<ProfitResponse | null>(null);
  const [cashflow, setCashflow] = useState<CashflowRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [clientFilter, setClientFilter] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [profitMonth, setProfitMonth] = useState("");
  const [paymentsPage, setPaymentsPage] = useState(1);
  const [paymentsMeta, setPaymentsMeta] = useState({ total: 0, totalPages: 1, pageSize: 25 });
  const [cashflowPage, setCashflowPage] = useState(1);
  const [cashflowMeta, setCashflowMeta] = useState({ total: 0, totalPages: 1, pageSize: 25 });

  const [paymentModalOpen, setPaymentModalOpen] = useState(false);
  const [expenseModalOpen, setExpenseModalOpen] = useState(false);
  const [editingPaymentId, setEditingPaymentId] = useState<string | null>(null);
  const [editingExpenseId, setEditingExpenseId] = useState<string | null>(null);
  const [paymentForm, setPaymentForm] = useState<any>({
    bookingId: "",
    amount: "",
    paymentDate: "",
    plannedPaymentDate: "",
    paymentMethod: "CASH",
    direction: "INCOME",
    status: "PLANNED",
    payerName: "",
    comment: "",
  });
  const [expenseForm, setExpenseForm] = useState<any>({
    bookingId: "",
    category: "OTHER",
    name: "",
    amount: "",
    expenseDate: "",
    comment: "",
  });

  async function loadBookings() {
    const data = await apiFetch<{ bookings: BookingRow[] }>("/api/bookings?limit=100");
    setBookings(data.bookings);
  }

  async function removeBooking(id: string) {
    if (!confirm("Удалить бронь? Действие нельзя отменить.")) return;
    setBookingBusyId(id);
    try {
      await apiFetch<{ ok: boolean }>(`/api/bookings/${id}`, { method: "DELETE" });
      setBookings((prev) => prev.filter((r) => r.id !== id));
    } catch (e: any) {
      alert(e?.message ?? "Не удалось удалить бронь");
    } finally {
      setBookingBusyId(null);
    }
  }

  async function runBookingStatusAction(id: string, action: "confirm" | "issue" | "return" | "cancel") {
    setBookingBusyId(id);
    try {
      await apiFetch(`/api/bookings/${id}/status`, { method: "POST", body: JSON.stringify({ action }) });
      await loadBookings();
    } catch (e: any) {
      alert(e?.message ?? "Не удалось обновить статус");
    } finally {
      setBookingBusyId(null);
    }
  }

  const filteredBookings = bookings.filter((r) => {
    if (bookingStatusFilter && r.status !== bookingStatusFilter) return false;
    if (bookingPaymentFilter && r.paymentStatus !== bookingPaymentFilter) return false;
    return true;
  });

  async function loadAll() {
    setLoading(true);
    try {
      const [bk, d, p, r, e, pr, cf] = await Promise.all([
        apiFetch<{ bookings: BookingRow[] }>("/api/bookings?limit=100"),
        apiFetch<DashboardResponse>("/api/finance/dashboard"),
        apiFetch<{ payments: PaymentRow[]; total: number; totalPages: number; pageSize: number }>(
          `/api/payments?client=${encodeURIComponent(clientFilter)}&project=${encodeURIComponent(projectFilter)}&status=${encodeURIComponent(
            statusFilter,
          )}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&page=${paymentsPage}&pageSize=${paymentsMeta.pageSize}`,
        ),
        apiFetch<{ receivables: ReceivableRow[] }>("/api/receivables"),
        apiFetch<{ expenses: ExpenseRow[] }>(`/api/expenses?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
        apiFetch<ProfitResponse>(`/api/profit?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
        apiFetch<{ rows: CashflowRow[]; total: number; totalPages: number; pageSize: number }>(
          `/api/cashflow?page=${cashflowPage}&pageSize=${cashflowMeta.pageSize}`,
        ),
      ]);
      setBookings(bk.bookings);
      setDashboard(d);
      setPayments(p.payments);
      setPaymentsMeta({ total: p.total, totalPages: p.totalPages, pageSize: p.pageSize });
      setReceivables(r.receivables);
      setExpenses(e.expenses);
      setProfit(pr);
      setCashflow(cf.rows);
      setCashflowMeta({ total: cf.total, totalPages: cf.totalPages, pageSize: cf.pageSize });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll().catch(() => {});
  }, []);

  useEffect(() => {
    loadAll().catch(() => {});
  }, [from, to, clientFilter, projectFilter, statusFilter, paymentsPage, cashflowPage]);

  useEffect(() => {
    setPaymentsPage(1);
    setCashflowPage(1);
  }, [from, to, clientFilter, projectFilter, statusFilter]);

  const receivableSummary = useMemo(() => {
    const total = receivables.reduce((a, b) => a + Number(b.amountOutstanding), 0);
    const overdue = receivables.filter((r) => r.paymentStatus === "OVERDUE").reduce((a, b) => a + Number(b.amountOutstanding), 0);
    return { total, overdue };
  }, [receivables]);

  const debtRows = useMemo(() => receivables.filter((r) => Number(r.amountOutstanding) > 0), [receivables]);
  const currentBookings = useMemo(
    () =>
      receivables.filter((r) => {
        // Backward-compatible: if API hasn't been restarted and `status` is absent,
        // show rows with debt so the section still works.
        if (!r.status) return Number(r.amountOutstanding) > 0;
        return r.status === "CONFIRMED" || r.status === "ISSUED";
      }),
    [receivables],
  );

  const unpaidProjects = useMemo(
    () =>
      receivables
        .filter((r) => Number(r.amountOutstanding) > 0)
        .map((r) => ({
          bookingId: r.id,
          label: `${r.clientName} · ${r.projectName} · остаток ${formatMoneyRub(r.amountOutstanding)}`,
          outstanding: Number(r.amountOutstanding),
        })),
    [receivables],
  );

  async function savePayment() {
    if (!paymentForm.bookingId) {
      alert("Выберите неоплаченный проект");
      return;
    }
    const payload = {
      bookingId: paymentForm.bookingId,
      amount: Number(paymentForm.amount),
      paymentDate: paymentForm.paymentDate ? new Date(paymentForm.paymentDate).toISOString() : new Date().toISOString(),
      plannedPaymentDate: paymentForm.plannedPaymentDate ? new Date(paymentForm.plannedPaymentDate).toISOString() : null,
      paymentMethod: paymentForm.paymentMethod,
      direction: "INCOME",
      status: "RECEIVED",
      payerName: paymentForm.payerName || null,
      comment: paymentForm.comment || null,
    };
    if (editingPaymentId) {
      await apiFetch(`/api/payments/${editingPaymentId}`, { method: "PATCH", body: JSON.stringify(payload) });
    } else {
      await apiFetch("/api/payments", { method: "POST", body: JSON.stringify(payload) });
    }
    setPaymentModalOpen(false);
    setEditingPaymentId(null);
    await loadAll();
  }

  async function saveExpense() {
    const payload = {
      bookingId: expenseForm.bookingId || null,
      category: expenseForm.category,
      name: expenseForm.name,
      amount: Number(expenseForm.amount),
      expenseDate: new Date(expenseForm.expenseDate).toISOString(),
      comment: expenseForm.comment || null,
    };
    if (editingExpenseId) {
      await apiFetch(`/api/expenses/${editingExpenseId}`, { method: "PATCH", body: JSON.stringify(payload) });
    } else {
      await apiFetch("/api/expenses", { method: "POST", body: JSON.stringify(payload) });
    }
    setExpenseModalOpen(false);
    setEditingExpenseId(null);
    await loadAll();
  }

  async function download(path: string, fallback: string) {
    const res = await apiFetchRaw(path, { method: "GET", credentials: "include" });
    if (!res.ok) return;
    const blob = await res.blob();
    const cd = res.headers.get("content-disposition") ?? "";
    const m = cd.match(/filename="([^"]+)"/i);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = m?.[1] ?? fallback;
    a.click();
    URL.revokeObjectURL(url);
  }

  function applyProfitMonth(monthValue: string) {
    setProfitMonth(monthValue);
    if (!monthValue) return;
    const [yearStr, monthStr] = monthValue.split("-");
    const year = Number(yearStr);
    const month = Number(monthStr);
    if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return;
    const fromDate = `${yearStr}-${monthStr}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const toDate = `${yearStr}-${monthStr}-${String(lastDay).padStart(2, "0")}`;
    setFrom(fromDate);
    setTo(toDate);
  }

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap no-print">
        <h1 className="text-xl font-semibold">Финансы</h1>
      </div>

      <div className="rounded border border-slate-200 bg-white p-3 flex flex-wrap items-center gap-2 no-print">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`rounded px-3 py-1.5 text-sm border ${tab === t.id ? "bg-slate-900 text-white border-slate-900" : "bg-white border-slate-300 hover:bg-slate-50"}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="rounded border border-slate-200 bg-white p-3 grid grid-cols-1 md:grid-cols-5 gap-3 no-print">
        <input className="rounded border border-slate-300 px-2 py-1 text-sm" placeholder="Клиент" value={clientFilter} onChange={(e) => setClientFilter(e.target.value)} />
        <input className="rounded border border-slate-300 px-2 py-1 text-sm" placeholder="Проект" value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)} />
        <select className="rounded border border-slate-300 px-2 py-1 text-sm" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">Все статусы</option>
          <option value="PLANNED">Ожидается</option>
          <option value="RECEIVED">Получен</option>
          <option value="CANCELLED">Отменен</option>
          <option value="NOT_PAID">Не оплачен</option>
          <option value="PARTIALLY_PAID">Частично оплачен</option>
          <option value="PAID">Оплачен</option>
          <option value="OVERDUE">Просрочен</option>
        </select>
        <input type="date" className="rounded border border-slate-300 px-2 py-1 text-sm" value={from} onChange={(e) => setFrom(e.target.value)} />
        <input type="date" className="rounded border border-slate-300 px-2 py-1 text-sm" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>

      {loading ? <div className="text-slate-500 text-sm">Загрузка...</div> : null}

      {tab === "bookings" ? (
        <div className="rounded border border-slate-200 bg-white overflow-hidden">
          <div className="p-3 border-b border-slate-200 flex items-center justify-between">
            <div className="text-sm text-slate-700">История броней</div>
            <div className="flex items-center gap-2">
              <select className="rounded border border-slate-300 px-2 py-1 text-xs bg-white" value={bookingStatusFilter} onChange={(e) => setBookingStatusFilter(e.target.value)}>
                <option value="">Все статусы брони</option>
                <option value="DRAFT">Черновик</option>
                <option value="CONFIRMED">Подтверждено</option>
                <option value="ISSUED">Выдано</option>
                <option value="RETURNED">Возвращено</option>
                <option value="CANCELLED">Отменено</option>
              </select>
              <select className="rounded border border-slate-300 px-2 py-1 text-xs bg-white" value={bookingPaymentFilter} onChange={(e) => setBookingPaymentFilter(e.target.value)}>
                <option value="">Все статусы оплаты</option>
                <option value="NOT_PAID">Не оплачен</option>
                <option value="PARTIALLY_PAID">Частично</option>
                <option value="PAID">Оплачен</option>
                <option value="OVERDUE">Просрочен</option>
              </select>
              <div className="text-xs text-slate-500">Всего: {filteredBookings.length}</div>
              <Link href="/bookings/new" className="rounded bg-slate-900 text-white px-3 py-1.5 text-xs hover:bg-slate-800">
                Новая бронь
              </Link>
            </div>
          </div>
          <div className="overflow-auto">
            <table className="min-w-[1300px] w-full text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="text-center px-3 py-2">Название</th>
                  <th className="text-center px-3 py-2">Клиент</th>
                  <th className="text-center px-3 py-2">Проект</th>
                  <th className="text-center px-3 py-2">Период</th>
                  <th className="text-center px-3 py-2">Статус</th>
                  <th className="text-center px-3 py-2">Оплата</th>
                  <th className="text-center px-3 py-2">Остаток</th>
                  <th className="text-center px-3 py-2">Действия</th>
                </tr>
              </thead>
              <tbody>
                {filteredBookings.map((r) => (
                  <tr key={r.id} className="border-t border-slate-100">
                    <td className="px-3 py-2 text-center">{r.displayName}</td>
                    <td className="px-3 py-2 text-center">{r.client.name}</td>
                    <td className="px-3 py-2 text-center">{r.projectName}</td>
                    <td className="px-3 py-2 text-center">
                      {new Date(r.startDate).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })} —{" "}
                      {new Date(r.endDate).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })}
                    </td>
                    <td className="px-3 py-2 text-center"><StatusBadge status={statusRu(r.status)} /></td>
                    <td className="px-3 py-2 text-center"><StatusBadge status={statusRu(r.paymentStatus)} /></td>
                    <td className="px-3 py-2 text-center">{formatMoneyRub(r.amountOutstanding)}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-center gap-3">
                        <Link className="text-slate-700 hover:text-slate-900" href={`/bookings/${r.id}`}>Открыть</Link>
                        {["DRAFT", "CONFIRMED"].includes(r.status) ? (
                          <Link href={`/bookings/${r.id}/edit`} title="Редактировать" className="text-slate-500 hover:text-slate-900">
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z" /></svg>
                          </Link>
                        ) : (
                          <span className="text-slate-300 cursor-not-allowed">
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z" /></svg>
                          </span>
                        )}
                        <button type="button" title="Удалить" className="text-rose-500 hover:text-rose-700 disabled:opacity-40" disabled={bookingBusyId === r.id} onClick={() => removeBooking(r.id)}>
                          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18" /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /></svg>
                        </button>
                        {r.status === "DRAFT" ? <button type="button" className="text-xs rounded border border-slate-300 px-2 py-1" disabled={bookingBusyId === r.id} onClick={() => runBookingStatusAction(r.id, "confirm")}>Подтвердить</button> : null}
                        {r.status === "CONFIRMED" ? <button type="button" className="text-xs rounded border border-slate-300 px-2 py-1" disabled={bookingBusyId === r.id} onClick={() => runBookingStatusAction(r.id, "issue")}>Выдать</button> : null}
                        {r.status === "ISSUED" ? <button type="button" className="text-xs rounded border border-slate-300 px-2 py-1" disabled={bookingBusyId === r.id} onClick={() => runBookingStatusAction(r.id, "return")}>Вернуть</button> : null}
                        {!["CANCELLED", "RETURNED"].includes(r.status) ? <button type="button" className="text-xs rounded border border-rose-300 text-rose-700 px-2 py-1" disabled={bookingBusyId === r.id} onClick={() => runBookingStatusAction(r.id, "cancel")}>Отменить</button> : null}
                      </div>
                    </td>
                  </tr>
                ))}
                {filteredBookings.length === 0 ? (
                  <tr><td className="px-3 py-6 text-center text-slate-500" colSpan={8}>Нет данных</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {tab === "dashboard" && dashboard ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
            <div className="rounded border border-slate-200 bg-white p-3"><div className="text-xs text-slate-500">Общий приход</div><div className="font-semibold">{formatMoneyRub(dashboard.summary.totalIncome)}</div></div>
            <div className="rounded border border-slate-200 bg-white p-3"><div className="text-xs text-slate-500">Общая дебиторка</div><div className="font-semibold">{formatMoneyRub(dashboard.summary.totalReceivables)}</div></div>
            <div className="rounded border border-slate-200 bg-white p-3"><div className="text-xs text-slate-500">Просроченная дебиторка</div><div className="font-semibold">{formatMoneyRub(dashboard.summary.overdueReceivables)}</div></div>
            <div className="rounded border border-slate-200 bg-white p-3"><div className="text-xs text-slate-500">Расходы</div><div className="font-semibold">{formatMoneyRub(dashboard.summary.expenses)}</div></div>
            <div className="rounded border border-slate-200 bg-white p-3"><div className="text-xs text-slate-500">Чистая прибыль</div><div className="font-semibold">{formatMoneyRub(dashboard.summary.netProfit)}</div></div>
            <div className="rounded border border-slate-200 bg-white p-3"><div className="text-xs text-slate-500">Неоплачено / Частично</div><div className="font-semibold">{dashboard.summary.unpaidCount} / {dashboard.summary.partialCount}</div></div>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="rounded border border-slate-200 bg-white overflow-hidden">
              <div className="p-3 border-b font-semibold text-sm">Платежи на сегодня/ожидаемые</div>
              <div className="max-h-72 overflow-auto">
                {dashboard.expectedPayments.map((p) => (
                  <div key={p.id} className="p-3 border-b text-sm flex justify-between">
                    <div>
                      <div>{p.booking?.clientName ?? p.payerName ?? "—"}</div>
                      <div className="text-xs text-slate-500">{p.booking?.projectName ?? ""}</div>
                    </div>
                    <div className="text-right">
                      <div className="font-medium">{formatMoneyRub(p.amount)}</div>
                      <div className="text-xs text-slate-500">{p.plannedPaymentDate ? new Date(p.plannedPaymentDate).toLocaleDateString("ru-RU") : "—"}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded border border-slate-200 bg-white overflow-hidden">
              <div className="p-3 border-b font-semibold text-sm">Просроченные платежи</div>
              <div className="max-h-72 overflow-auto">
                {dashboard.overdueBookings.map((b) => (
                  <div key={b.id} className="p-3 border-b text-sm flex justify-between">
                    <div>
                      <div>{b.clientName}</div>
                      <div className="text-xs text-slate-500">{b.projectName}</div>
                    </div>
                    <div className="text-right">
                      <div className="font-medium text-rose-700">{formatMoneyRub(b.amountOutstanding)}</div>
                      <div className="text-xs text-slate-500">{b.expectedPaymentDate ? new Date(b.expectedPaymentDate).toLocaleDateString("ru-RU") : "—"}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="rounded border border-slate-200 bg-white overflow-hidden">
            <div className="p-3 border-b flex items-center justify-between">
              <div className="font-semibold text-sm">Текущие брони</div>
              <div className="text-xs text-slate-500">Активные: {currentBookings.length}</div>
            </div>
            <div className="overflow-auto">
              <table className="min-w-[980px] w-full text-sm">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-3 py-2 text-left">Клиент</th>
                    <th className="px-3 py-2 text-left">Проект</th>
                    <th className="px-3 py-2 text-center">Период</th>
                    <th className="px-3 py-2 text-right">Сумма сметы</th>
                    <th className="px-3 py-2 text-right">Долг</th>
                    <th className="px-3 py-2 text-center">Статус</th>
                    <th className="px-3 py-2 text-center">Карточка</th>
                  </tr>
                </thead>
                <tbody>
                  {currentBookings.map((r) => (
                    <tr key={r.id} className="border-t border-slate-100">
                      <td className="px-3 py-2">{r.clientName}</td>
                      <td className="px-3 py-2">{r.projectName}</td>
                      <td className="px-3 py-2 text-center">
                        {r.startDate && r.endDate
                          ? `${new Date(r.startDate).toLocaleDateString("ru-RU")} — ${new Date(r.endDate).toLocaleDateString("ru-RU")}`
                          : "—"}
                      </td>
                      <td className="px-3 py-2 text-right">{formatMoneyRub(r.finalAmount)}</td>
                      <td className="px-3 py-2 text-right font-medium">{formatMoneyRub(r.amountOutstanding)}</td>
                      <td className="px-3 py-2 text-center">
                        <StatusBadge status={r.status ?? "CONFIRMED"} label={statusRu(r.status ?? "CONFIRMED")} />
                      </td>
                      <td className="px-3 py-2 text-center">
                        <Link href={`/bookings/${r.id}`} className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50">
                          Открыть
                        </Link>
                      </td>
                    </tr>
                  ))}
                  {currentBookings.length === 0 ? (
                    <tr>
                      <td className="px-3 py-6 text-center text-slate-500" colSpan={7}>
                        Активных броней нет
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}

      {tab === "payments" ? (
        <div className="rounded border border-slate-200 bg-white overflow-hidden">
          <div className="p-3 border-b flex items-center justify-between">
            <div className="font-semibold text-sm">Платежи</div>
            <div className="flex gap-2">
              <button className="rounded border border-slate-300 px-3 py-1.5 text-sm" onClick={() => download("/api/finance/export/payments.xlsx", "payments.xlsx")}>Export XLSX</button>
              <button className="rounded border border-slate-300 px-3 py-1.5 text-sm" onClick={() => download("/api/finance/export/payments.csv", "payments.csv")}>CSV</button>
              <button
                className="rounded bg-slate-900 text-white px-3 py-1.5 text-sm"
                onClick={() => {
                  setEditingPaymentId(null);
                  setPaymentForm({
                    bookingId: "",
                    amount: "",
                    paymentDate: "",
                    plannedPaymentDate: "",
                    paymentMethod: "CASH",
                    direction: "INCOME",
                    status: "RECEIVED",
                    payerName: "",
                    comment: "",
                  });
                  setPaymentModalOpen(true);
                }}
              >
                Добавить платеж
              </button>
            </div>
          </div>
          <div className="overflow-auto">
            <table className="min-w-[1100px] w-full text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-3 py-2 text-left">Дата</th><th className="px-3 py-2 text-left">Клиент</th><th className="px-3 py-2 text-left">Проект</th><th className="px-3 py-2 text-left">Бронь</th><th className="px-3 py-2 text-right">Сумма</th><th className="px-3 py-2">Статус</th><th className="px-3 py-2">Способ</th><th className="px-3 py-2 text-left">Комментарий</th><th className="px-3 py-2">Действия</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id} className="border-t border-slate-100">
                    <td className="px-3 py-2">{new Date(p.paymentDate || p.plannedPaymentDate || "").toLocaleDateString("ru-RU")}</td>
                    <td className="px-3 py-2">{p.booking?.client.name ?? p.payerName ?? "—"}</td>
                    <td className="px-3 py-2">{p.booking?.projectName ?? "—"}</td>
                    <td className="px-3 py-2">{p.bookingId ?? "—"}</td>
                    <td className="px-3 py-2 text-right font-medium">{formatMoneyRub(p.amount)}</td>
                    <td className="px-3 py-2 text-center"><StatusBadge status={p.status} label={statusRu(p.status)} /></td>
                    <td className="px-3 py-2 text-center">{paymentMethodRu(p.paymentMethod)}</td>
                    <td className="px-3 py-2">{p.comment ?? ""}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-center gap-2">
                        <button className="text-xs rounded border border-slate-300 px-2 py-1" onClick={() => { setEditingPaymentId(p.id); setPaymentForm({ bookingId: p.bookingId ?? "", amount: p.amount, paymentDate: p.paymentDate ? p.paymentDate.slice(0, 10) : "", plannedPaymentDate: p.plannedPaymentDate ? p.plannedPaymentDate.slice(0, 10) : "", paymentMethod: p.paymentMethod, direction: p.direction, status: p.status, payerName: p.payerName ?? "", comment: p.comment ?? "" }); setPaymentModalOpen(true); }}>Ред.</button>
                        {p.status !== "RECEIVED" ? <button className="text-xs rounded border border-emerald-300 text-emerald-700 px-2 py-1" onClick={async () => { await apiFetch(`/api/payments/${p.id}`, { method: "PATCH", body: JSON.stringify({ status: "RECEIVED", paymentDate: new Date().toISOString() }) }); await loadAll(); }}>Получен</button> : null}
                        {p.status !== "CANCELLED" ? <button className="text-xs rounded border border-rose-300 text-rose-700 px-2 py-1" onClick={async () => { await apiFetch(`/api/payments/${p.id}`, { method: "PATCH", body: JSON.stringify({ status: "CANCELLED" }) }); await loadAll(); }}>Отменить</button> : null}
                        <button
                          className="rounded border border-rose-300 text-rose-700 p-1.5 hover:bg-rose-50"
                          title="Удалить платеж"
                          aria-label="Удалить платеж"
                          onClick={async () => {
                            if (!confirm("Удалить платеж? Это действие нельзя отменить.")) return;
                            try {
                              await apiFetch(`/api/payments/${p.id}`, { method: "DELETE" });
                            } catch (e: any) {
                              // Fallback for old API instances where DELETE route is not yet available.
                              if (e?.status === 404) {
                                await apiFetch(`/api/payments/${p.id}`, {
                                  method: "PATCH",
                                  body: JSON.stringify({ status: "CANCELLED" }),
                                });
                              } else {
                                throw e;
                              }
                            }
                            await loadAll();
                          }}
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                            <path d="M3 6h18" />
                            <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                            <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                            <line x1="10" y1="11" x2="10" y2="17" />
                            <line x1="14" y1="11" x2="14" y2="17" />
                          </svg>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="p-3 border-t border-slate-200 flex items-center justify-between text-xs text-slate-600">
            <div>Всего: {paymentsMeta.total}</div>
            <div className="flex items-center gap-2">
              <button className="rounded border border-slate-300 px-2 py-1 disabled:opacity-40" disabled={paymentsPage <= 1} onClick={() => setPaymentsPage((p) => Math.max(1, p - 1))}>Назад</button>
              <span>{paymentsPage} / {paymentsMeta.totalPages}</span>
              <button className="rounded border border-slate-300 px-2 py-1 disabled:opacity-40" disabled={paymentsPage >= paymentsMeta.totalPages} onClick={() => setPaymentsPage((p) => Math.min(paymentsMeta.totalPages, p + 1))}>Вперед</button>
            </div>
          </div>
        </div>
      ) : null}

      {tab === "receivables" ? (
        <div className="rounded border border-slate-200 bg-white overflow-hidden">
          <div className="p-3 border-b flex items-center justify-between">
            <div className="font-semibold text-sm">Долги по проектам</div>
            <div className="text-xs text-slate-500">Итого: {formatMoneyRub(receivableSummary.total.toFixed(2))} · Просрочено: {formatMoneyRub(receivableSummary.overdue.toFixed(2))}</div>
          </div>
          <div className="overflow-auto">
            <table className="min-w-[1000px] w-full text-sm">
              <thead className="bg-slate-50 text-slate-600"><tr><th className="px-3 py-2 text-left">Клиент</th><th className="px-3 py-2 text-left">Проект</th><th className="px-3 py-2 text-right">Смета</th><th className="px-3 py-2 text-right">Оплачено</th><th className="px-3 py-2 text-right">Остаток</th><th className="px-3 py-2">Плановая дата</th><th className="px-3 py-2">Статус</th><th className="px-3 py-2 text-left">Комментарий</th></tr></thead>
              <tbody>
                {debtRows.map((r) => (
                  <tr key={r.id} className="border-t border-slate-100">
                    <td className="px-3 py-2">{r.clientName}</td><td className="px-3 py-2">{r.projectName}</td><td className="px-3 py-2 text-right">{formatMoneyRub(r.finalAmount)}</td><td className="px-3 py-2 text-right">{formatMoneyRub(r.amountPaid)}</td><td className="px-3 py-2 text-right font-medium">{formatMoneyRub(r.amountOutstanding)}</td><td className="px-3 py-2 text-center">{r.expectedPaymentDate ? new Date(r.expectedPaymentDate).toLocaleDateString("ru-RU") : "—"}</td><td className="px-3 py-2 text-center"><StatusBadge status={r.paymentStatus} label={statusRu(r.paymentStatus)} /></td><td className="px-3 py-2">{r.paymentComment ?? ""}</td>
                  </tr>
                ))}
                {debtRows.length === 0 ? (
                  <tr>
                    <td className="px-3 py-6 text-center text-slate-500" colSpan={8}>
                      Нет проектов с долгом
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {tab === "expenses" ? (
        <div className="rounded border border-slate-200 bg-white overflow-hidden">
          <div className="p-3 border-b flex items-center justify-between">
            <div className="font-semibold text-sm">Расходы</div>
            <div className="flex gap-2">
              <button className="rounded border border-slate-300 px-3 py-1.5 text-sm" onClick={() => download("/api/finance/export/expenses.xlsx", "expenses.xlsx")}>Export XLSX</button>
              <button className="rounded bg-slate-900 text-white px-3 py-1.5 text-sm" onClick={() => { setEditingExpenseId(null); setExpenseForm({ bookingId: "", category: "OTHER", name: "", amount: "", expenseDate: "", comment: "" }); setExpenseModalOpen(true); }}>Добавить расход</button>
            </div>
          </div>
          <div className="overflow-auto">
            <table className="min-w-[1000px] w-full text-sm">
              <thead className="bg-slate-50 text-slate-600"><tr><th className="px-3 py-2">Дата</th><th className="px-3 py-2">Категория</th><th className="px-3 py-2 text-left">Название</th><th className="px-3 py-2 text-right">Сумма</th><th className="px-3 py-2 text-left">Бронь</th><th className="px-3 py-2 text-left">Комментарий</th><th className="px-3 py-2">Действия</th></tr></thead>
              <tbody>
                {expenses.map((e) => (
                  <tr key={e.id} className="border-t border-slate-100">
                    <td className="px-3 py-2 text-center">{new Date(e.expenseDate).toLocaleDateString("ru-RU")}</td>
                    <td className="px-3 py-2 text-center">{e.category}</td>
                    <td className="px-3 py-2">{e.name}</td>
                    <td className="px-3 py-2 text-right font-medium">{formatMoneyRub(e.amount)}</td>
                    <td className="px-3 py-2">{e.booking ? `${e.booking.client.name} · ${e.booking.projectName}` : "—"}</td>
                    <td className="px-3 py-2">{e.comment ?? ""}</td>
                    <td className="px-3 py-2 text-center">
                      <button className="text-xs rounded border border-slate-300 px-2 py-1" onClick={() => { setEditingExpenseId(e.id); setExpenseForm({ bookingId: e.bookingId ?? "", category: e.category, name: e.name, amount: e.amount, expenseDate: e.expenseDate.slice(0, 10), comment: e.comment ?? "" }); setExpenseModalOpen(true); }}>Ред.</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {tab === "profit" && profit ? (
        <div className="space-y-4 print-profit">
          <div className="rounded border border-slate-200 bg-white p-3 no-print">
            <div className="flex items-end gap-3 flex-wrap">
              <div className="flex flex-col">
                <label className="text-xs text-slate-600">Месяц отчета</label>
                <input
                  type="month"
                  className="rounded border border-slate-300 px-2 py-1 text-sm"
                  value={profitMonth}
                  onChange={(e) => applyProfitMonth(e.target.value)}
                />
              </div>
              <button
                className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50"
                onClick={() => {
                  setProfitMonth("");
                  setFrom("");
                  setTo("");
                }}
              >
                Сбросить
              </button>
              <div className="text-xs text-slate-500">
                Период: {from || "—"} — {to || "—"}
              </div>
            </div>
          </div>
          <div className="rounded border border-slate-200 bg-white p-3 grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div><div className="text-xs text-slate-500">Выручка</div><div className="font-semibold">{formatMoneyRub(profit.revenue)}</div></div>
            <div><div className="text-xs text-slate-500">Расходы</div><div className="font-semibold">{formatMoneyRub(profit.expenses)}</div></div>
            <div><div className="text-xs text-slate-500">Валовая прибыль</div><div className="font-semibold">{formatMoneyRub(profit.grossProfit)}</div></div>
            <div><div className="text-xs text-slate-500">Чистая прибыль</div><div className="font-semibold">{formatMoneyRub(profit.netProfit)}</div></div>
          </div>
          <div className="rounded border border-slate-200 bg-white overflow-hidden">
            <div className="p-3 border-b flex justify-between">
              <div className="font-semibold text-sm">Прибыль по броням</div>
              <div className="flex gap-2">
                <button className="rounded border border-slate-300 px-3 py-1.5 text-sm" onClick={() => download("/api/finance/export/profit.xlsx", "profit.xlsx")}>Export XLSX</button>
                <button className="rounded border border-slate-300 px-3 py-1.5 text-sm" onClick={() => download("/api/finance/export/profit.csv", "profit.csv")}>CSV</button>
              </div>
            </div>
            <div className="overflow-auto">
              <table className="min-w-[900px] w-full text-sm">
                <thead className="bg-slate-50 text-slate-600"><tr><th className="px-3 py-2 text-left">Клиент</th><th className="px-3 py-2 text-left">Проект</th><th className="px-3 py-2 text-right">Выручка</th><th className="px-3 py-2 text-right">Расходы</th><th className="px-3 py-2 text-right">Прибыль</th></tr></thead>
                <tbody>
                  {profit.byBooking.map((b) => (
                    <tr key={b.bookingId} className="border-t border-slate-100"><td className="px-3 py-2">{b.clientName}</td><td className="px-3 py-2">{b.projectName}</td><td className="px-3 py-2 text-right">{formatMoneyRub(b.revenue)}</td><td className="px-3 py-2 text-right">{formatMoneyRub(b.expenses)}</td><td className="px-3 py-2 text-right font-semibold">{formatMoneyRub(b.profit)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}

      {tab === "cashflow" ? (
        <div className="rounded border border-slate-200 bg-white overflow-hidden">
          <div className="p-3 border-b font-semibold text-sm">Финансовый журнал</div>
          <div className="overflow-auto">
            <table className="min-w-[1000px] w-full text-sm">
              <thead className="bg-slate-50 text-slate-600"><tr><th className="px-3 py-2">Дата</th><th className="px-3 py-2">Тип</th><th className="px-3 py-2 text-right">Сумма</th><th className="px-3 py-2 text-left">Клиент</th><th className="px-3 py-2 text-left">Проект</th><th className="px-3 py-2 text-left">Комментарий</th><th className="px-3 py-2">Источник</th></tr></thead>
              <tbody>
                {cashflow.map((r) => (
                  <tr key={`${r.source}-${r.id}`} className="border-t border-slate-100">
                    <td className="px-3 py-2 text-center">{new Date(r.date).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })}</td>
                    <td className="px-3 py-2 text-center">{cashflowTypeRu(r.type)}</td>
                    <td className={`px-3 py-2 text-right font-medium ${r.type === "income" ? "text-emerald-700" : "text-rose-700"}`}>{r.type === "income" ? "+" : "-"}{formatMoneyRub(r.amount)}</td>
                    <td className="px-3 py-2">{r.clientName ?? "—"}</td>
                    <td className="px-3 py-2">{r.projectName ?? "—"}</td>
                    <td className="px-3 py-2">{r.comment ?? ""}</td>
                    <td className="px-3 py-2 text-center">{cashflowSourceRu(r.source)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="p-3 border-t border-slate-200 flex items-center justify-between text-xs text-slate-600">
            <div>Всего: {cashflowMeta.total}</div>
            <div className="flex items-center gap-2">
              <button className="rounded border border-slate-300 px-2 py-1 disabled:opacity-40" disabled={cashflowPage <= 1} onClick={() => setCashflowPage((p) => Math.max(1, p - 1))}>Назад</button>
              <span>{cashflowPage} / {cashflowMeta.totalPages}</span>
              <button className="rounded border border-slate-300 px-2 py-1 disabled:opacity-40" disabled={cashflowPage >= cashflowMeta.totalPages} onClick={() => setCashflowPage((p) => Math.min(cashflowMeta.totalPages, p + 1))}>Вперед</button>
            </div>
          </div>
        </div>
      ) : null}

      {paymentModalOpen ? (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="w-full max-w-2xl rounded-lg bg-white border border-slate-200 shadow-xl">
            <div className="p-4 border-b font-semibold">{editingPaymentId ? "Редактировать платеж" : "Добавить платеж"}</div>
            <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-3">
              <select
                className="rounded border border-slate-300 px-2 py-1 text-sm md:col-span-2"
                value={paymentForm.bookingId}
                onChange={(e) => {
                  const bookingId = e.target.value;
                  const selected = unpaidProjects.find((x) => x.bookingId === bookingId);
                  setPaymentForm((p: any) => ({
                    ...p,
                    bookingId,
                    amount: selected && !editingPaymentId ? String(selected.outstanding) : p.amount,
                  }));
                }}
              >
                <option value="">Выберите неоплаченный проект</option>
                {unpaidProjects.map((p) => (
                  <option key={p.bookingId} value={p.bookingId}>
                    {p.label}
                  </option>
                ))}
              </select>
              <input className="rounded border border-slate-300 px-2 py-1 text-sm" placeholder="Сумма платежа" value={paymentForm.amount} onChange={(e) => setPaymentForm((p: any) => ({ ...p, amount: e.target.value }))} />
              <input type="date" className="rounded border border-slate-300 px-2 py-1 text-sm" value={paymentForm.paymentDate} onChange={(e) => setPaymentForm((p: any) => ({ ...p, paymentDate: e.target.value }))} />
              <select className="rounded border border-slate-300 px-2 py-1 text-sm" value={paymentForm.paymentMethod} onChange={(e) => setPaymentForm((p: any) => ({ ...p, paymentMethod: e.target.value }))}>
                <option value="BANK_TRANSFER">ИП</option>
                <option value="CARD">Перевод на карты</option>
                <option value="CASH">Наличные</option>
                <option value="OTHER">Другое</option>
              </select>
              <input className="rounded border border-slate-300 px-2 py-1 text-sm" placeholder="Имя плательщика" value={paymentForm.payerName} onChange={(e) => setPaymentForm((p: any) => ({ ...p, payerName: e.target.value }))} />
              <textarea className="md:col-span-2 rounded border border-slate-300 px-2 py-1 text-sm" rows={3} placeholder="Комментарий" value={paymentForm.comment} onChange={(e) => setPaymentForm((p: any) => ({ ...p, comment: e.target.value }))} />
            </div>
            <div className="p-4 border-t flex justify-end gap-2">
              <button className="rounded border border-slate-300 px-3 py-1.5 text-sm" onClick={() => setPaymentModalOpen(false)}>Отмена</button>
              <button className="rounded bg-slate-900 text-white px-3 py-1.5 text-sm" onClick={savePayment}>Сохранить</button>
            </div>
          </div>
        </div>
      ) : null}

      {expenseModalOpen ? (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="w-full max-w-2xl rounded-lg bg-white border border-slate-200 shadow-xl">
            <div className="p-4 border-b font-semibold">{editingExpenseId ? "Редактировать расход" : "Добавить расход"}</div>
            <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-3">
              <select className="rounded border border-slate-300 px-2 py-1 text-sm" value={expenseForm.category} onChange={(e) => setExpenseForm((p: any) => ({ ...p, category: e.target.value }))}>
                <option value="TRANSPORT">транспорт</option><option value="EQUIPMENT">техника</option><option value="CONTRACTORS">подрядчики</option><option value="STAFF">персонал</option><option value="RENT">аренда</option><option value="REPAIR">ремонт</option><option value="OTHER">прочее</option>
              </select>
              <input className="rounded border border-slate-300 px-2 py-1 text-sm" placeholder="Название" value={expenseForm.name} onChange={(e) => setExpenseForm((p: any) => ({ ...p, name: e.target.value }))} />
              <input className="rounded border border-slate-300 px-2 py-1 text-sm" placeholder="Сумма" value={expenseForm.amount} onChange={(e) => setExpenseForm((p: any) => ({ ...p, amount: e.target.value }))} />
              <input type="date" className="rounded border border-slate-300 px-2 py-1 text-sm" value={expenseForm.expenseDate} onChange={(e) => setExpenseForm((p: any) => ({ ...p, expenseDate: e.target.value }))} />
              <textarea className="md:col-span-2 rounded border border-slate-300 px-2 py-1 text-sm" rows={3} placeholder="Комментарий" value={expenseForm.comment} onChange={(e) => setExpenseForm((p: any) => ({ ...p, comment: e.target.value }))} />
            </div>
            <div className="p-4 border-t flex justify-end gap-2">
              <button className="rounded border border-slate-300 px-3 py-1.5 text-sm" onClick={() => setExpenseModalOpen(false)}>Отмена</button>
              <button className="rounded bg-slate-900 text-white px-3 py-1.5 text-sm" onClick={saveExpense}>Сохранить</button>
            </div>
          </div>
        </div>
      ) : null}

      <style jsx global>{`
        @media print {
          body * {
            visibility: hidden;
          }
          .print-profit,
          .print-profit * {
            visibility: visible;
          }
          .print-profit {
            position: absolute;
            left: 0;
            top: 0;
            width: 100%;
            padding: 12px;
            background: white;
          }
          .no-print {
            display: none !important;
          }
        }
      `}</style>
    </div>
  );
}
