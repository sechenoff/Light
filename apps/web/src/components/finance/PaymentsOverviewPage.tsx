"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiFetch } from "../../lib/api";
import { formatRub } from "../../lib/format";
import { useCurrentUser } from "../../hooks/useCurrentUser";
import { FinanceTabNav } from "./FinanceTabNav";
import { PeriodSelector } from "./PeriodSelector";
import { RecordPaymentModal } from "./RecordPaymentModal";
import { VoidPaymentModal } from "./VoidPaymentModal";
import { RefundModal } from "./RefundModal";
import { derivePeriodRange, type PeriodKey } from "../../lib/periodUtils";
import { StatusPill } from "../StatusPill";
import { PaymentsByClient } from "./PaymentsByClient";
import { PaymentsFilterBar, type PaymentsFilter } from "./PaymentsFilterBar";
import { PaymentsTable, type OverviewItem } from "./PaymentsTable";
import { PaymentsTotalsStrip } from "./PaymentsTotalsStrip";
import { toMoscowDateString } from "../../lib/moscowDate";

// ── Types ─────────────────────────────────────────────────────────────────────

type PaymentMethod = "CASH" | "BANK_TRANSFER" | "CARD" | "OTHER";
type PaymentType = "income" | "refund";
type ViewTab = "payments" | "bookings" | "clients";

interface PaymentItem {
  id: string;
  amount: string;
  method: PaymentMethod;
  receivedAt: string;
  note: string | null;
  voidedAt: string | null;
  createdBy: string | null;
  /** H2: разрешённое имя пользователя из AdminUser (вместо cuid) */
  createdByName?: string | null;
  booking: {
    id: string;
    projectName: string;
    client: { id: string; name: string };
  } | null;
  invoice: { id: string; number: string | null } | null;
  // refund flag (negative amount)
  isRefund?: boolean;
}

interface PaymentsListResponse {
  items: PaymentItem[];
  total: number;
}

// For booking-level overview
interface OverviewResponse {
  items: OverviewItem[];
  totals: {
    count: number;
    billed: string;
    paid: string;
    outstanding: string;
    averageAmount: string;
  };
  nextCursor: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: "💵 Наличные",
  CARD: "💳 Карта",
  BANK_TRANSFER: "🏦 Перевод",
  OTHER: "📦 Другое",
};

const METHOD_CHIP_LABELS: Record<PaymentMethod, string> = {
  CASH: "Наличные",
  CARD: "Карта (терминал)",
  BANK_TRANSFER: "Перевод",
  OTHER: "Онлайн",
};

function formatPaymentDate(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  return {
    date: d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" }),
    time: d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }),
  };
}

/** Converts ISO datetime to YYYY-MM-DD for API */
function toDateParam(iso: string): string {
  try {
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
    return toMoscowDateString(new Date(iso));
  } catch {
    return iso;
  }
}

function buildOverviewQuery(filter: PaymentsFilter, cursor?: string): string {
  const params = new URLSearchParams();
  params.set("limit", "50");
  if (filter.from) params.set("from", toDateParam(filter.from));
  if (filter.to) params.set("to", toDateParam(filter.to));
  if (filter.clientId) params.set("clientId", filter.clientId);
  if (filter.amountMin) params.set("amountMin", filter.amountMin);
  if (filter.amountMax) params.set("amountMax", filter.amountMax);
  if (filter.paymentStatuses.length > 0 && filter.paymentStatuses.length < 4) {
    params.set("paymentStatus", filter.paymentStatuses.join(","));
  }
  if (cursor) params.set("cursor", cursor);
  return `?${params.toString()}`;
}

// ── Method chips ───────────────────────────────────────────────────────────────

interface MethodTotals {
  total: number;
  cash: number;
  card: number;
  transfer: number;
  other: number;
  refunds: number;
}

function computeMethodTotals(items: PaymentItem[]): MethodTotals {
  const totals: MethodTotals = { total: 0, cash: 0, card: 0, transfer: 0, other: 0, refunds: 0 };
  for (const item of items) {
    if (item.voidedAt) continue;
    const amt = Number(item.amount);
    if (amt < 0) {
      totals.refunds += amt;
      continue;
    }
    totals.total += amt;
    if (item.method === "CASH") totals.cash += amt;
    else if (item.method === "CARD") totals.card += amt;
    else if (item.method === "BANK_TRANSFER") totals.transfer += amt;
    else totals.other += amt;
  }
  return totals;
}

// ── Main component ────────────────────────────────────────────────────────────

export function PaymentsOverviewPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useCurrentUser();
  const [recordPaymentOpen, setRecordPaymentOpen] = useState(false);

  // View tab
  const tabParam = searchParams.get("view") as ViewTab | null;
  const [view, setViewState] = useState<ViewTab>(
    tabParam === "bookings" || tabParam === "clients" ? tabParam : "payments"
  );

  // Period
  const initialPeriod = (searchParams.get("period") as PeriodKey | null) ?? "month";
  const [period, setPeriod] = useState<PeriodKey>(initialPeriod);

  // Method filter (null = all)
  const [methodFilter, setMethodFilter] = useState<PaymentMethod | null>(null);
  // Include voided
  const [includeVoided, setIncludeVoided] = useState(false);
  // Search
  const [search, setSearch] = useState("");
  // Type filter
  const [typeFilter, setTypeFilter] = useState<"all" | "income" | "refund">("all");
  // Void/refund modals
  const [voidPaymentId, setVoidPaymentId] = useState<string | null>(null);
  const [refundPaymentId, setRefundPaymentId] = useState<string | null>(null);

  function setView(v: ViewTab) {
    setViewState(v);
    const params = new URLSearchParams(searchParams.toString());
    params.set("view", v);
    router.replace(`?${params.toString()}`);
  }

  function handlePeriodChange(p: PeriodKey) {
    setPeriod(p);
    const range = derivePeriodRange(p);
    setBookingsFilter((prev) => ({ ...prev, from: range.from, to: range.to }));
    setBookingsItems([]);
    setBookingsNextCursor(null);
    const params = new URLSearchParams(searchParams.toString());
    params.set("period", p);
    router.replace(`?${params.toString()}`);
  }

  // ── Individual payments tab ──────────────────────────────────────────────────

  const [payments, setPayments] = useState<PaymentItem[]>([]);
  const [paymentsLoading, setPaymentsLoading] = useState(false);
  const [paymentsError, setPaymentsError] = useState<string | null>(null);

  const fetchPayments = useCallback(
    (period_: PeriodKey) => {
      let cancelled = false;
      setPaymentsLoading(true);
      const range = derivePeriodRange(period_);
      const params = new URLSearchParams();
      params.set("limit", "100");
      params.set("from", range.from);
      params.set("to", range.to);
      apiFetch<PaymentsListResponse>(`/api/payments?${params}`)
        .then((r) => {
          if (!cancelled) {
            setPayments(r.items);
            setPaymentsError(null);
          }
        })
        .catch((e) => {
          if (!cancelled) setPaymentsError(e instanceof Error ? e.message : "Ошибка загрузки");
        })
        .finally(() => {
          if (!cancelled) setPaymentsLoading(false);
        });
      return () => { cancelled = true; };
    },
    []
  );

  useEffect(() => {
    if (view !== "payments") return;
    return fetchPayments(period);
  }, [fetchPayments, period, view]);

  // ── Bookings tab ─────────────────────────────────────────────────────────────

  const initialRange = derivePeriodRange(initialPeriod);
  const [bookingsFilter, setBookingsFilter] = useState<PaymentsFilter>({
    from: initialRange.from,
    to: initialRange.to,
    clientId: "",
    amountMin: "",
    amountMax: "",
    paymentStatuses: ["NOT_PAID", "PARTIALLY_PAID", "PAID", "OVERDUE"],
  });

  const [bookingsItems, setBookingsItems] = useState<OverviewItem[]>([]);
  const [bookingsTotals, setBookingsTotals] = useState<OverviewResponse["totals"] | null>(null);
  const [bookingsNextCursor, setBookingsNextCursor] = useState<string | null>(null);
  const [bookingsLoading, setBookingsLoading] = useState(false);
  const [bookingsError, setBookingsError] = useState<string | null>(null);

  const fetchBookings = useCallback(
    (append: boolean, cursor?: string) => {
      let cancelled = false;
      setBookingsLoading(true);
      apiFetch<OverviewResponse>(
        `/api/finance/payments-overview${buildOverviewQuery(bookingsFilter, cursor)}`
      )
        .then((r) => {
          if (cancelled) return;
          setBookingsItems((prev) => (append ? [...prev, ...r.items] : r.items));
          setBookingsTotals(r.totals);
          setBookingsNextCursor(r.nextCursor);
          setBookingsError(null);
        })
        .catch((e) => {
          if (!cancelled) setBookingsError(e instanceof Error ? e.message : "Ошибка загрузки");
        })
        .finally(() => {
          if (!cancelled) setBookingsLoading(false);
        });
      return () => { cancelled = true; };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      bookingsFilter.from,
      bookingsFilter.to,
      bookingsFilter.clientId,
      bookingsFilter.amountMin,
      bookingsFilter.amountMax,
      bookingsFilter.paymentStatuses.join(","),
    ]
  );

  useEffect(() => {
    if (view !== "bookings") return;
    const cancel = fetchBookings(false);
    return cancel;
  }, [fetchBookings, view]);

  function handleBookingsFilterChange(f: PaymentsFilter) {
    setBookingsFilter(f);
    setBookingsItems([]);
    setBookingsNextCursor(null);
  }

  // ── Derived data ──────────────────────────────────────────────────────────────

  const methodTotals = computeMethodTotals(payments);

  // Filtered payments for display
  const filteredPayments = payments.filter((p) => {
    // voided filter
    if (!includeVoided && p.voidedAt) return false;
    // method filter
    if (methodFilter && p.method !== methodFilter) return false;
    // type filter
    if (typeFilter === "income" && Number(p.amount) < 0) return false;
    if (typeFilter === "refund" && Number(p.amount) >= 0) return false;
    // search
    const q = search.toLowerCase();
    if (q) {
      const clientName = p.booking?.client.name.toLowerCase() ?? "";
      const project = p.booking?.projectName.toLowerCase() ?? "";
      const invoice = p.invoice?.number?.toLowerCase() ?? "";
      if (!clientName.includes(q) && !project.includes(q) && !invoice.includes(q)) return false;
    }
    return true;
  });

  return (
    <div className="pb-10 bg-surface-subtle min-h-screen">
      <FinanceTabNav />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-5">

        {/* Page header */}
        <div className="mb-5">
          <p className="eyebrow text-ink-3">Финансы</p>
          <div className="flex items-center justify-between gap-3 flex-wrap mt-1">
            <h1 className="text-[22px] font-semibold text-ink tracking-tight">Платежи</h1>
            <div className="flex items-center gap-2 flex-wrap">
              {/* Period selector */}
              <PeriodSelector value={period} onChange={handlePeriodChange} />
              <button className="px-3.5 py-2 text-[12px] font-medium border border-border bg-surface rounded-lg hover:bg-surface-subtle transition-colors">
                📊 Экспорт XLSX
              </button>
              {(user?.role === "SUPER_ADMIN" || user?.role === "WAREHOUSE") && (
                <button
                  onClick={() => setRecordPaymentOpen(true)}
                  className="px-3.5 py-2 text-[12px] font-semibold bg-accent-bright text-white rounded-lg hover:opacity-90 transition-opacity whitespace-nowrap"
                >
                  + Записать платёж
                </button>
              )}
              {/* View tab switcher */}
              <div className="flex border border-border rounded-lg overflow-hidden bg-surface">
                <button
                  onClick={() => setView("payments")}
                  className={`px-3.5 py-2 text-[12px] font-medium transition-colors ${
                    view === "payments"
                      ? "bg-accent-soft text-accent-bright border-r border-accent-border"
                      : "text-ink-2 hover:text-ink border-r border-border"
                  }`}
                >
                  Транзакции
                </button>
                <button
                  onClick={() => setView("bookings")}
                  className={`px-3.5 py-2 text-[12px] font-medium transition-colors ${
                    view === "bookings"
                      ? "bg-accent-soft text-accent-bright border-r border-accent-border"
                      : "text-ink-2 hover:text-ink border-r border-border"
                  }`}
                >
                  Брони
                </button>
                <button
                  onClick={() => setView("clients")}
                  className={`px-3.5 py-2 text-[12px] font-medium transition-colors ${
                    view === "clients" ? "bg-accent-soft text-accent-bright" : "text-ink-2 hover:text-ink"
                  }`}
                >
                  По клиентам
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* === Transactions view === */}
        {view === "payments" && (
          <>
            {/* Method chips */}
            <div className="flex gap-2 mb-5 flex-wrap">
              {/* All chip */}
              <button
                onClick={() => setMethodFilter(null)}
                className={`flex flex-col items-start gap-0.5 px-3.5 py-2.5 rounded-lg border text-[12px] transition-colors ${
                  methodFilter === null
                    ? "bg-accent text-white border-accent"
                    : "bg-surface border-border text-ink-2 hover:bg-surface-subtle"
                }`}
              >
                <span className="text-[11px] font-medium opacity-80">Все</span>
                <strong className="mono-num text-[14px]">{formatRub(methodTotals.total)}</strong>
              </button>
              {/* Per-method chips */}
              {(["CASH", "CARD", "BANK_TRANSFER", "OTHER"] as PaymentMethod[]).map((m) => {
                const amt = m === "CASH" ? methodTotals.cash
                  : m === "CARD" ? methodTotals.card
                  : m === "BANK_TRANSFER" ? methodTotals.transfer
                  : methodTotals.other;
                const active = methodFilter === m;
                const amtColor = m === "CASH" ? "text-emerald" : m === "CARD" ? "text-accent-bright" : "text-slate";
                return (
                  <button
                    key={m}
                    onClick={() => setMethodFilter(active ? null : m)}
                    className={`flex flex-col items-start gap-0.5 px-3.5 py-2.5 rounded-lg border text-[12px] transition-colors ${
                      active
                        ? "bg-accent text-white border-accent"
                        : "bg-surface border-border text-ink-2 hover:bg-surface-subtle"
                    }`}
                  >
                    <span className="text-[11px] font-medium opacity-80">{METHOD_CHIP_LABELS[m]}</span>
                    <strong className={`mono-num text-[14px] ${active ? "text-white" : amtColor}`}>
                      {formatRub(amt)}
                    </strong>
                  </button>
                );
              })}
              {/* Refunds chip */}
              <button
                onClick={() => setTypeFilter(typeFilter === "refund" ? "all" : "refund")}
                className={`flex flex-col items-start gap-0.5 px-3.5 py-2.5 rounded-lg border text-[12px] transition-colors ${
                  typeFilter === "refund"
                    ? "bg-rose-soft border-rose-border text-rose"
                    : "bg-surface border-border text-ink-2 hover:bg-surface-subtle"
                }`}
              >
                <span className="text-[11px] font-medium opacity-80">Возвраты</span>
                <strong className="mono-num text-[14px] text-rose">{formatRub(methodTotals.refunds)}</strong>
              </button>
            </div>

            {/* Filter bar */}
            <div className="flex gap-2 mb-3 flex-wrap items-center">
              <input
                className="border border-border rounded-lg px-3 py-2 text-[13px] bg-surface min-w-[220px]"
                placeholder="🔍 клиент, бронь, № счёта"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <select
                className="border border-border rounded-lg px-3 py-2 text-[13px] bg-surface"
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value as "all" | "income" | "refund")}
              >
                <option value="all">Все типы</option>
                <option value="income">Приход</option>
                <option value="refund">Возврат</option>
              </select>
              <select
                className="border border-border rounded-lg px-3 py-2 text-[13px] bg-surface"
                value={methodFilter ?? ""}
                onChange={(e) => setMethodFilter((e.target.value as PaymentMethod) || null)}
              >
                <option value="">Все методы</option>
                <option value="CASH">Наличные</option>
                <option value="CARD">Карта</option>
                <option value="BANK_TRANSFER">Перевод</option>
                <option value="OTHER">Другое</option>
              </select>
              <label className="flex items-center gap-2 text-[13px] text-ink-2 py-1 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={includeVoided}
                  onChange={(e) => setIncludeVoided(e.target.checked)}
                />
                Включить аннулированные
              </label>
            </div>

            {/* Error */}
            {paymentsError && (
              <div className="mb-4 p-3 rounded-lg bg-rose-soft border border-rose-border text-rose text-sm">
                {paymentsError}
              </div>
            )}

            {/* Table — desktop */}
            {paymentsLoading && payments.length === 0 ? (
              <div className="text-center py-12 text-ink-3 text-sm">Загрузка…</div>
            ) : filteredPayments.length === 0 ? (
              <div className="bg-surface border border-border rounded-lg py-16 text-center text-ink-2">
                <p className="text-[15px] font-medium mb-2">Платежей нет</p>
                <p className="text-sm text-ink-3">Запишите первый платёж кнопкой выше.</p>
              </div>
            ) : (
              <>
                {/* Desktop */}
                <div className="hidden md:block bg-surface border border-border rounded-lg overflow-hidden shadow-xs">
                  <table className="w-full text-[12.5px]">
                    <thead className="bg-surface-subtle border-b border-border">
                      <tr>
                        <th className="px-4 py-3 text-left eyebrow">Дата · время</th>
                        <th className="px-3 py-3 text-left eyebrow">Клиент</th>
                        <th className="px-3 py-3 text-left eyebrow">Бронь</th>
                        <th className="px-3 py-3 text-left eyebrow">Счёт</th>
                        <th className="px-3 py-3 text-left eyebrow">Метод</th>
                        <th className="px-3 py-3 text-right eyebrow">Сумма</th>
                        <th className="px-3 py-3 text-left eyebrow">Кто принял</th>
                        <th className="px-3 py-3 text-left eyebrow">Статус</th>
                        <th className="w-20 px-3 py-3"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredPayments.map((p) => {
                        const amt = Number(p.amount);
                        const isRefund = amt < 0;
                        const isVoided = !!p.voidedAt;
                        const { date, time } = formatPaymentDate(p.receivedAt ?? p.id);

                        return (
                          <tr
                            key={p.id}
                            className={`border-b border-slate-soft last:border-0 transition-colors ${
                              isVoided ? "opacity-50 bg-surface-subtle" : "hover:bg-surface-subtle/40"
                            }`}
                          >
                            <td className="px-4 py-3 mono-num">
                              {date}
                              <br />
                              <span className="text-ink-3">{time}</span>
                            </td>
                            <td className="px-3 py-3">
                              <strong className="text-ink">{p.booking?.client.name ?? "—"}</strong>
                            </td>
                            <td className="px-3 py-3">
                              {p.booking ? (
                                <a href={`/bookings/${p.booking.id}`} className="text-[11px] text-accent hover:underline font-mono">
                                  #{p.booking.id.slice(-6)}
                                </a>
                              ) : (
                                <span className="text-ink-3">—</span>
                              )}
                            </td>
                            <td className="px-3 py-3">
                              {p.invoice?.number ? (
                                <span className="font-mono text-[11px] bg-surface-subtle border border-border rounded px-1.5 py-0.5">
                                  {p.invoice.number}
                                </span>
                              ) : (
                                <span className="text-ink-3">—</span>
                              )}
                            </td>
                            <td className="px-3 py-3 text-ink-2">{METHOD_LABELS[p.method]}</td>
                            <td className="px-3 py-3 text-right mono-num font-semibold">
                              {isRefund ? (
                                <span className="text-amber">{formatRub(amt)}</span>
                              ) : isVoided ? (
                                <span className="text-ink-3 line-through">{formatRub(amt)}</span>
                              ) : (
                                <span className="text-emerald">+{formatRub(amt)}</span>
                              )}
                            </td>
                            <td className="px-3 py-3 text-ink-2">
                              {p.createdByName ? (
                                <span className="text-[12px]">{p.createdByName}</span>
                              ) : p.createdBy === "_system_" ? (
                                <span className="text-[12px] text-ink-3">Система</span>
                              ) : p.createdBy ? (
                                <span className="text-ink-3">—</span>
                              ) : (
                                <span className="text-ink-3">—</span>
                              )}
                            </td>
                            <td className="px-3 py-3">
                              {isVoided ? (
                                <StatusPill variant="none" label="Аннулирован" />
                              ) : isRefund ? (
                                <StatusPill variant="warn" label="Возврат" />
                              ) : (
                                <StatusPill variant="ok" label="Получен" />
                              )}
                            </td>
                            <td className="px-3 py-3">
                              {!isVoided && !isRefund && (
                                <div className="flex gap-1 justify-end">
                                  <button
                                    onClick={() => setRefundPaymentId(p.id)}
                                    className="w-7 h-7 flex items-center justify-center border border-border rounded hover:border-accent-bright hover:text-accent-bright text-[13px]"
                                    aria-label="Возврат"
                                    title="Возврат"
                                  >
                                    ↩
                                  </button>
                                  <button
                                    onClick={() => setVoidPaymentId(p.id)}
                                    className="w-7 h-7 flex items-center justify-center border border-border rounded hover:border-rose hover:text-rose text-[13px]"
                                    aria-label="Аннулировать"
                                    title="Аннулировать"
                                  >
                                    ⊘
                                  </button>
                                </div>
                              )}
                              {isVoided && p.note && (
                                <span className="text-[11px] text-ink-3 truncate max-w-[80px] block">{p.note}</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Mobile card list */}
                <div className="md:hidden space-y-2 mt-2">
                  {filteredPayments.map((p) => {
                    const amt = Number(p.amount);
                    const isRefund = amt < 0;
                    const isVoided = !!p.voidedAt;
                    const { date, time } = formatPaymentDate(p.receivedAt ?? p.id);
                    return (
                      <div
                        key={p.id}
                        className={`border rounded-lg p-3 ${
                          isRefund
                            ? "bg-amber-soft border-amber-border"
                            : isVoided
                              ? "bg-surface-subtle border-border opacity-60"
                              : "bg-surface border-border"
                        }`}
                      >
                        <div className="flex justify-between items-center">
                          <strong className="text-ink text-[13px]">{p.booking?.client.name ?? "—"}</strong>
                          <span className={`mono-num font-semibold text-[14px] ${isRefund ? "text-amber" : "text-emerald"}`}>
                            {isRefund ? "" : "+"}{formatRub(amt)}
                          </span>
                        </div>
                        <div className="text-[11px] text-ink-3 mt-1">
                          {METHOD_LABELS[p.method]} · {date}, {time}
                          {(p.createdByName ?? p.createdBy) && ` · ${p.createdByName ?? p.createdBy}`}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </>
        )}

        {/* === Bookings view === */}
        {view === "bookings" && (
          <>
            <PaymentsFilterBar filter={bookingsFilter} onChange={handleBookingsFilterChange} />
            {bookingsTotals && (
              <PaymentsTotalsStrip
                billed={bookingsTotals.billed}
                paid={bookingsTotals.paid}
                outstanding={bookingsTotals.outstanding}
                averageAmount={bookingsTotals.averageAmount}
                count={bookingsTotals.count}
              />
            )}
            {bookingsError && (
              <div className="mb-4 p-3 rounded-lg bg-rose-soft border border-rose-border text-rose text-sm">
                {bookingsError}
              </div>
            )}
            <PaymentsTable
              items={bookingsItems}
              loading={bookingsLoading}
              onLoadMore={bookingsNextCursor ? () => fetchBookings(true, bookingsNextCursor) : null}
              onRefresh={() => fetchBookings(false)}
              onRecordPayment={() => setRecordPaymentOpen(true)}
            />
          </>
        )}

        {/* === Clients view === */}
        {view === "clients" && (
          <PaymentsByClient filter={bookingsFilter} />
        )}
      </div>

      {/* RecordPaymentModal */}
      <RecordPaymentModal
        open={recordPaymentOpen}
        onClose={() => setRecordPaymentOpen(false)}
        onCreated={() => {
          setRecordPaymentOpen(false);
          if (view === "payments") fetchPayments(period);
          else fetchBookings(false);
        }}
      />
      {/* VoidPaymentModal */}
      <VoidPaymentModal
        open={!!voidPaymentId}
        paymentId={voidPaymentId}
        onClose={() => setVoidPaymentId(null)}
        onVoided={() => { setVoidPaymentId(null); fetchPayments(period); }}
      />
      {/* RefundModal */}
      <RefundModal
        open={!!refundPaymentId}
        paymentId={refundPaymentId ?? undefined}
        onClose={() => setRefundPaymentId(null)}
        onSuccess={() => { setRefundPaymentId(null); fetchPayments(period); }}
      />
    </div>
  );
}
