"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { useRequireRole } from "../../../src/hooks/useRequireRole";
import { useCurrentUser } from "../../../src/hooks/useCurrentUser";
import { apiFetch } from "../../../src/lib/api";
import { formatRub, pluralize } from "../../../src/lib/format";
import { toMoscowDateString } from "../../../src/lib/moscowDate";
import { toast } from "../../../src/components/ToastProvider";
import { FinanceTabNav } from "../../../src/components/finance/FinanceTabNav";
import { LegacyBookingImportModal } from "../../../src/components/finance/LegacyBookingImportModal";
import { RecordPaymentModal } from "../../../src/components/finance/RecordPaymentModal";
import { AIReminderModal } from "../../../src/components/finance/AIReminderModal";
import { BookingPaymentsModal } from "../../../src/components/finance/BookingPaymentsModal";
import type { UserRole } from "../../../src/lib/auth";

const ALLOWED: UserRole[] = ["SUPER_ADMIN"];

// ── Types ─────────────────────────────────────────────────────────────────────

interface DebtProject {
  bookingId: string;
  projectName: string;
  amountOutstanding: string;
  /** PAR F1: сумма уже полученных платежей */
  amountPaid: string;
  /** PAR F1: итоговая сумма по брони */
  finalAmount: string;
  /** PAR F4: количество платежей */
  paymentCount: number;
  expectedPaymentDate: string | null;
  daysOverdue: number | null;
  paymentStatus: string;
  bookingStatus?: string;
  /** B1 */
  startDate: string | null;
  endDate: string | null;
  clientName: string;
  clientId: string;
}

interface ClientDebt {
  clientId: string;
  clientName: string;
  totalOutstanding: string;
  overdueAmount: string;
  maxDaysOverdue: number;
  bookingsCount: number;
  projects: DebtProject[];
  clientPhone?: string | null;
  clientEmail?: string | null;
  lastReminderAt?: string | null;
}

interface DebtsResponse {
  debts: ClientDebt[];
  summary: {
    totalClients: number;
    totalOutstanding: string;
    totalOverdue: string;
    asOf: string;
  };
}

// ── Flat row type ──────────────────────────────────────────────────────────────

interface FlatRow extends DebtProject {
  clientPhone: string | null;
  clientEmail: string | null;
  lastReminderAt: string | null;
  totalClientOutstanding: string;
}

// ── Sort types ─────────────────────────────────────────────────────────────────

type SortField = "startDate" | "name" | "amount" | "status";
type SortOrder = "asc" | "desc";

// ── Status filter type ─────────────────────────────────────────────────────────

type StatusFilter = "all" | "open" | "partial" | "overdue";

// ── Date helpers ───────────────────────────────────────────────────────────────

const RU_MONTHS_SHORT = [
  "янв", "фев", "мар", "апр", "май", "июн",
  "июл", "авг", "сен", "окт", "ноя", "дек",
];

function formatStartDate(dateStr: string | null): { dayMon: string; year: string } | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return {
    dayMon: `${d.getDate()} ${RU_MONTHS_SHORT[d.getMonth()]}`,
    year: String(d.getFullYear()),
  };
}

function startDateColor(dateStr: string | null, daysOverdue: number | null): string {
  if (daysOverdue !== null && daysOverdue > 0) return "text-rose";
  if (!dateStr) return "text-ink-3";
  // D5: compare using Moscow TZ date strings for TZ-stability
  // D6: today = amber (call-to-action urgency), future = accent (blue), past = ink-3
  const todayMsk = toMoscowDateString(new Date());
  const dateMsk = toMoscowDateString(new Date(dateStr));
  if (dateMsk === todayMsk) return "text-amber"; // today
  if (dateMsk > todayMsk) return "text-accent"; // future
  return "text-ink-3"; // past
}

// ── Payment status → pill ──────────────────────────────────────────────────────

function statusPill(paymentStatus: string, daysOverdue: number | null): { label: string; cls: string } {
  if (daysOverdue !== null && daysOverdue > 0) {
    return {
      label: `Просрочено ${daysOverdue} ${pluralize(daysOverdue, "дн", "дн", "дн")}`,
      cls: "bg-rose-soft text-rose border-rose-border",
    };
  }
  switch (paymentStatus) {
    case "PARTIALLY_PAID": return { label: "Частично", cls: "bg-amber-soft text-amber border-amber-border" };
    case "OVERDUE": return {
      label: `Просрочено${daysOverdue ? ` ${daysOverdue} дн` : ""}`,
      cls: "bg-rose-soft text-rose border-rose-border",
    };
    case "NOT_PAID": return { label: "Открыт", cls: "bg-amber-soft text-amber border-amber-border" };
    case "PAID": return { label: "Оплачено", cls: "bg-emerald-soft text-emerald-dark border-emerald-border" };
    default: return { label: paymentStatus, cls: "bg-surface-subtle text-ink-2 border-border" };
  }
}

// ── Sort helpers ───────────────────────────────────────────────────────────────

function sortRows(rows: FlatRow[], sort: SortField, order: SortOrder): FlatRow[] {
  const sorted = [...rows].sort((a, b) => {
    let cmp = 0;
    switch (sort) {
      case "startDate":
        cmp = (a.startDate ?? "").localeCompare(b.startDate ?? "");
        break;
      case "name":
        cmp = a.clientName.localeCompare(b.clientName, "ru");
        break;
      case "amount":
        cmp = Number(a.amountOutstanding) - Number(b.amountOutstanding);
        break;
      case "status": {
        const aOver = a.daysOverdue ?? -Infinity;
        const bOver = b.daysOverdue ?? -Infinity;
        cmp = aOver - bOver;
        break;
      }
    }
    return order === "asc" ? cmp : -cmp;
  });
  return sorted;
}

// ── Sort arrow ─────────────────────────────────────────────────────────────────

function SortArrow({ active, order }: { active: boolean; order: SortOrder }) {
  if (!active) return <span className="text-ink-3 text-[10px] ml-1">↕</span>;
  return <span className="ml-1 text-[10px] text-accent-bright">{order === "asc" ? "▲" : "▼"}</span>;
}

// ── Action menu ────────────────────────────────────────────────────────────────

interface ActionMenuProps {
  row: FlatRow;
  onRemind: () => void;
  onDelete: () => void;
  onPaymentsList: () => void;
}

function ActionMenu({ row, onRemind, onDelete, onPaymentsList }: ActionMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Дополнительные действия"
        className="h-[30px] w-[30px] flex items-center justify-center border border-border bg-surface rounded text-ink-2 hover:bg-surface-subtle text-sm"
      >
        ⋯
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-30 bg-surface border border-border rounded-lg shadow-lg py-1 min-w-[190px]">
          <button
            onClick={() => { setOpen(false); onPaymentsList(); }}
            className="w-full text-left px-3.5 py-2 text-[12.5px] text-ink-2 hover:bg-surface-subtle"
          >
            📋 Список платежей{row.paymentCount > 0 ? ` (${row.paymentCount})` : ""}
          </button>
          <button
            onClick={() => {
              setOpen(false);
              window.location.href = `/api/bookings/${row.bookingId}/invoice.pdf`;
            }}
            className="w-full text-left px-3.5 py-2 text-[12.5px] text-ink-2 hover:bg-surface-subtle"
          >
            📄 Скачать счёт PDF
          </button>
          <button
            onClick={() => {
              setOpen(false);
              window.location.href = `/api/finance/debts/${row.clientId}/report.pdf`;
            }}
            className="w-full text-left px-3.5 py-2 text-[12.5px] text-ink-2 hover:bg-surface-subtle"
          >
            📋 Отчёт по клиенту PDF
          </button>
          <button
            onClick={() => { setOpen(false); onRemind(); }}
            className="w-full text-left px-3.5 py-2 text-[12.5px] text-ink-2 hover:bg-surface-subtle"
          >
            🤖 Напомнить клиенту
          </button>
          <div className="border-t border-border my-1" />
          <button
            onClick={() => { setOpen(false); onDelete(); }}
            className="w-full text-left px-3.5 py-2 text-[12.5px] text-rose hover:bg-rose-soft"
          >
            🗑 Удалить бронь
          </button>
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

function DebtsPageInner() {
  const { authorized, loading } = useRequireRole(ALLOWED);
  const currentUser = useCurrentUser();
  const router = useRouter();
  const searchParams = useSearchParams();

  const legacyMode = searchParams.get("legacy") === "1";

  // F3: sort URL persistence
  const ALLOWED_SORTS: SortField[] = ["startDate", "name", "amount", "status"];
  const rawSort = searchParams.get("sort");
  const initSort: SortField = ALLOWED_SORTS.includes(rawSort as SortField) ? (rawSort as SortField) : "startDate";
  const rawOrder = searchParams.get("order");
  const initOrder: SortOrder = rawOrder === "asc" || rawOrder === "desc" ? rawOrder : "desc";
  // F4: client filter URL persistence
  const initClient = searchParams.get("client") ?? "";

  const [sort, setSort] = useState<SortField>(initSort);
  const [order, setOrder] = useState<SortOrder>(initOrder);
  const [clientFilter, setClientFilter] = useState<string>(initClient);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");
  const [data, setData] = useState<DebtsResponse | null>(null);
  const [fetching, setFetching] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  // Payment modal state
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [paymentBookingId, setPaymentBookingId] = useState<string | undefined>(undefined);
  const [paymentContext, setPaymentContext] = useState<{ projectName: string; clientName: string; amountOutstanding: string } | null>(null);

  // BookingPaymentsModal state
  const [paymentsListOpen, setPaymentsListOpen] = useState(false);
  const [paymentsListBookingId, setPaymentsListBookingId] = useState<string>("");
  const [paymentsListContext, setPaymentsListContext] = useState<{ projectName: string; clientName: string; amountOutstanding: string } | null>(null);

  // AI reminder modal state
  const [reminderClientDebt, setReminderClientDebt] = useState<ClientDebt | null>(null);
  const [reminderRowClientId, setReminderRowClientId] = useState<string | null>(null);

  // Remindable clients
  const [remindableCount, setRemindableCount] = useState<number | null>(null);
  const remindableFetched = useRef(false);

  const fetchRemindable = useCallback(() => {
    let cancelled = false;
    apiFetch<{ clients: Array<{ clientId: string }> }>("/api/finance/debts/remindable")
      .then((d) => { if (!cancelled) setRemindableCount(d.clients.length); })
      .catch(() => { if (!cancelled) setRemindableCount(null); });
    return () => { cancelled = true; };
  }, []);

  // D7: track in-flight request to abort previous on new call
  const loadAbortRef = useRef<AbortController | null>(null);

  const loadDebts = useCallback(() => {
    // Abort any prior in-flight fetch
    if (loadAbortRef.current) loadAbortRef.current.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    let cancelled = false;
    setFetching(true);
    apiFetch<DebtsResponse>("/api/finance/debts", { signal: controller.signal })
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e: unknown) => {
        if (cancelled) return;
        // AbortError is expected on superseded requests — suppress toast
        if (e instanceof Error && e.name === "AbortError") return;
        toast.error("Ошибка загрузки долгов");
      })
      .finally(() => { if (!cancelled) setFetching(false); });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  useEffect(() => {
    if (!authorized) return;
    return loadDebts();
  }, [authorized, loadDebts]);

  useEffect(() => {
    if (!authorized || remindableFetched.current) return;
    remindableFetched.current = true;
    fetchRemindable();
  }, [authorized, fetchRemindable]);

  // ── Flatten data ───────────────────────────────────────────────────────────────

  const allRows: FlatRow[] = (data?.debts ?? []).flatMap((c) =>
    c.projects.map((p) => ({
      ...p,
      clientPhone: c.clientPhone ?? null,
      clientEmail: c.clientEmail ?? null,
      lastReminderAt: c.lastReminderAt ?? null,
      totalClientOutstanding: c.totalOutstanding,
    }))
  );

  // ── Per-client chips data ──────────────────────────────────────────────────────

  const clientChips = (data?.debts ?? []).map((c) => ({
    clientId: c.clientId,
    clientName: c.clientName,
    totalOutstanding: c.totalOutstanding,
    overdueAmount: c.overdueAmount,
    maxDaysOverdue: c.maxDaysOverdue,
    bookingsCount: c.bookingsCount,
  }));

  // ── Filtering ──────────────────────────────────────────────────────────────────

  const filtered = allRows.filter((row) => {
    // Client filter
    if (clientFilter && row.clientId !== clientFilter) return false;
    // Status filter
    if (statusFilter === "open" && !(row.paymentStatus === "NOT_PAID" && (row.daysOverdue === null || row.daysOverdue <= 0))) return false;
    if (statusFilter === "partial" && row.paymentStatus !== "PARTIALLY_PAID") return false;
    if (statusFilter === "overdue" && !((row.daysOverdue ?? 0) > 0 || row.paymentStatus === "OVERDUE")) return false;
    // Search
    const q = search.toLowerCase();
    if (q && !row.clientName.toLowerCase().includes(q) && !row.projectName.toLowerCase().includes(q)) return false;
    return true;
  });

  // Status counts
  const openCount = allRows.filter((r) => r.paymentStatus === "NOT_PAID" && (r.daysOverdue === null || r.daysOverdue <= 0)).length;
  const partialCount = allRows.filter((r) => r.paymentStatus === "PARTIALLY_PAID").length;
  const overdueCount = allRows.filter((r) => (r.daysOverdue ?? 0) > 0 || r.paymentStatus === "OVERDUE").length;

  // Sort rows
  const sortedRows = sortRows(filtered, sort, order);

  // ── URL helpers ────────────────────────────────────────────────────────────────

  function handleSort(field: SortField) {
    const newOrder = sort === field && order === "desc" ? "asc" : "desc";
    setSort(field);
    setOrder(newOrder);
    const params = new URLSearchParams(searchParams.toString());
    params.set("sort", field);
    params.set("order", newOrder);
    router.replace(`?${params.toString()}`, { scroll: false });
  }

  function handleClientFilter(clientId: string) {
    const next = clientId === clientFilter ? "" : clientId;
    setClientFilter(next);
    const params = new URLSearchParams(searchParams.toString());
    if (next) params.set("client", next);
    else params.delete("client");
    router.replace(`?${params.toString()}`, { scroll: false });
  }

  // ── Actions ────────────────────────────────────────────────────────────────────

  function openPayment(row: FlatRow) {
    setPaymentBookingId(row.bookingId);
    setPaymentContext({ projectName: row.projectName, clientName: row.clientName, amountOutstanding: row.amountOutstanding });
    setPaymentOpen(true);
  }

  function openPaymentsList(row: FlatRow) {
    setPaymentsListBookingId(row.bookingId);
    setPaymentsListContext({ projectName: row.projectName, clientName: row.clientName, amountOutstanding: row.amountOutstanding });
    setPaymentsListOpen(true);
  }

  function openReminder(row: FlatRow) {
    // Find full client debt for total outstanding
    const clientDebt = data?.debts.find((c) => c.clientId === row.clientId) ?? null;
    setReminderClientDebt(clientDebt);
    setReminderRowClientId(row.clientId);
  }

  async function handleDelete(row: FlatRow) {
    if (!confirm(`Удалить бронь «${row.projectName}»? Это действие нельзя отменить.`)) return;
    try {
      await apiFetch(`/api/bookings/${row.bookingId}`, { method: "DELETE" });
      toast.success("Бронь удалена");
      loadDebts();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Ошибка удаления");
    }
  }

  if (loading || !authorized) return null;
  if (!data && fetching) return <div className="p-8 text-ink-3 text-sm">Загрузка…</div>;

  const totalClients = data?.summary.totalClients ?? 0;
  const totalOutstanding = data?.summary.totalOutstanding ?? "0";
  const totalOverdue = data?.summary.totalOverdue ?? "0";

  const activeReminderClient = reminderClientDebt;

  return (
    <div className="pb-10 bg-surface-subtle min-h-screen">
      <FinanceTabNav debtCount={totalClients} />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-5">

        {/* Header */}
        <div className="flex items-end justify-between gap-3 mb-5">
          <div>
            <p className="eyebrow text-ink-3 mb-1">ФИНАНСЫ</p>
            <h1 className="text-[24px] font-semibold text-ink tracking-tight mb-1">Дебиторка</h1>
            <p className="text-[13px] text-ink-2">
              {totalClients} {pluralize(totalClients, "клиент", "клиента", "клиентов")}
              {" · "}{allRows.length} открытых {pluralize(allRows.length, "долг", "долга", "долгов")}
              {" · к получению "}
              <strong className="mono-num text-ink">{formatRub(totalOutstanding)}</strong>
            </p>
          </div>
          <div className="flex gap-2 flex-shrink-0">
            {legacyMode && currentUser?.user?.role === "SUPER_ADMIN" && (
              <button
                type="button"
                onClick={() => setImportOpen(true)}
                className="px-3.5 py-2 text-[12px] font-medium rounded-lg border border-accent-border bg-accent-soft text-accent-bright hover:bg-accent-border"
              >
                + Импортировать смету
              </button>
            )}
            <button
              onClick={() => { window.location.href = "/api/finance/debts.xlsx"; }}
              className="px-3.5 py-2 text-[12px] font-medium border border-border bg-surface rounded-lg hover:bg-surface-subtle"
            >
              📊 Экспорт всего
            </button>
          </div>
        </div>

        {/* KPI strip — 4 cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
          <div className="bg-surface border border-border rounded-lg px-4 py-3">
            <p className="eyebrow text-ink-3 mb-0.5">Всего к получению</p>
            <p className={`mono-num text-[17px] font-semibold ${Number(totalOutstanding) > 0 ? "text-rose" : "text-ink"}`}>
              {formatRub(totalOutstanding)}
            </p>
          </div>
          <div className="bg-surface border border-border rounded-lg px-4 py-3">
            <p className="eyebrow text-ink-3 mb-0.5">Просрочено</p>
            <p className={`mono-num text-[17px] font-semibold ${Number(totalOverdue) > 0 ? "text-rose" : "text-ink"}`}>
              {formatRub(totalOverdue)}
            </p>
            {overdueCount > 0 && (
              <p className="text-[11px] text-rose mt-0.5">{overdueCount} {pluralize(overdueCount, "долг", "долга", "долгов")}</p>
            )}
          </div>
          <div className="bg-surface border border-border rounded-lg px-4 py-3">
            <p className="eyebrow text-ink-3 mb-0.5">Частично оплачено</p>
            <p className="mono-num text-[17px] font-semibold text-ink">{partialCount}</p>
            {partialCount > 0 && (
              <p className="text-[11px] text-ink-2 mt-0.5">
                {formatRub(allRows.filter((r) => r.paymentStatus === "PARTIALLY_PAID").reduce((s, r) => s + Number(r.amountOutstanding), 0))}
              </p>
            )}
          </div>
          <div className="bg-surface border border-border rounded-lg px-4 py-3">
            <p className="eyebrow text-ink-3 mb-0.5">К напоминанию</p>
            <p className="mono-num text-[17px] font-semibold text-ink">
              {remindableCount ?? "…"}
            </p>
            {(remindableCount ?? 0) > 0 && (
              <p className="text-[11px] text-ink-2 mt-0.5">готовы к уведомлению</p>
            )}
          </div>
        </div>

        {/* Per-client chips — horizontal scroll */}
        {clientChips.length > 0 && (
          <div className="mb-5">
            <p className="eyebrow text-ink-3 mb-2">КЛИЕНТЫ С ДОЛГОМ · клик = фильтр</p>
            <div className="flex gap-2 overflow-x-auto pb-1 -webkit-overflow-scrolling-touch">
              {/* "Все клиенты" chip */}
              <button
                onClick={() => handleClientFilter("")}
                className={`flex-shrink-0 min-w-[130px] flex flex-col gap-0.5 px-3 py-2 border rounded-md text-left transition-colors ${
                  clientFilter === ""
                    ? "bg-accent text-white border-accent"
                    : "bg-surface border-border hover:bg-surface-subtle"
                }`}
              >
                <span className={`text-[12px] font-semibold ${clientFilter === "" ? "text-white" : "text-ink"}`}>
                  Все клиенты
                </span>
                <span className={`font-mono text-[13px] font-semibold ${clientFilter === "" ? "text-white" : "text-rose"}`}>
                  {formatRub(totalOutstanding)}
                </span>
                <span className={`text-[10px] uppercase tracking-wide ${clientFilter === "" ? "text-white/70" : "text-ink-3"}`}>
                  {allRows.length} {pluralize(allRows.length, "бронь", "брони", "броней")}
                </span>
              </button>

              {clientChips.map((c) => (
                <button
                  key={c.clientId}
                  onClick={() => handleClientFilter(c.clientId)}
                  className={`flex-shrink-0 min-w-[130px] flex flex-col gap-0.5 px-3 py-2 border rounded-md text-left transition-colors ${
                    clientFilter === c.clientId
                      ? "bg-accent text-white border-accent"
                      : "bg-surface border-border hover:bg-surface-subtle"
                  }`}
                >
                  <span className={`text-[12px] font-semibold truncate max-w-[140px] ${clientFilter === c.clientId ? "text-white" : "text-ink"}`}>
                    {c.clientName}
                  </span>
                  <span className={`font-mono text-[13px] font-semibold ${clientFilter === c.clientId ? "text-white" : "text-rose"}`}>
                    {formatRub(c.totalOutstanding)}
                  </span>
                  <span className={`text-[10px] uppercase tracking-wide ${clientFilter === c.clientId ? "text-white/70" : "text-ink-3"}`}>
                    {c.maxDaysOverdue > 0
                      ? `⚠ просрочка ${c.maxDaysOverdue} дн`
                      : `${c.bookingsCount} ${pluralize(c.bookingsCount, "бронь", "брони", "броней")}`}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* PDF-отчёт по выбранному клиенту */}
        {clientFilter && (
          <div className="mb-3 flex items-center gap-2">
            <a
              href={`/api/finance/debts/${clientFilter}/report.pdf`}
              className="inline-flex items-center gap-1.5 h-[30px] px-3 text-[12px] font-medium border border-border bg-surface text-ink-2 rounded hover:bg-surface-subtle transition-colors"
              download
            >
              📋 Отчёт по клиенту PDF
            </a>
            <a
              href={`/api/finance/debts/${clientFilter}/export.xlsx`}
              className="inline-flex items-center gap-1.5 h-[30px] px-3 text-[12px] font-medium border border-border bg-surface text-ink-2 rounded hover:bg-surface-subtle transition-colors"
              download
            >
              📊 Excel
            </a>
          </div>
        )}

        {/* Filter pills + search */}
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          {(
            [
              { key: "all", label: "Все", count: allRows.length },
              { key: "open", label: "Открыты", count: openCount },
              { key: "partial", label: "Частично", count: partialCount },
              { key: "overdue", label: "Просрочено", count: overdueCount },
            ] as { key: StatusFilter; label: string; count: number }[]
          ).map((f) => (
            <button
              key={f.key}
              onClick={() => setStatusFilter(f.key)}
              className={`h-[30px] px-3 text-[12px] font-medium border rounded transition-colors ${
                statusFilter === f.key
                  ? "bg-accent text-white border-accent"
                  : "bg-surface border-border text-ink-2 hover:bg-surface-subtle"
              }`}
            >
              {f.label}
              <span className={`ml-1.5 ${statusFilter === f.key ? "text-white/70" : "text-ink-3"}`}>{f.count}</span>
            </button>
          ))}
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="🔍 Найти клиента или проект…"
            className="ml-auto border border-border rounded px-3 py-1.5 text-[12px] bg-surface text-ink-2 w-[240px]"
          />
        </div>

        {/* D3: Mobile sort selector — visible only on mobile where column headers are hidden */}
        <div className="md:hidden mb-3">
          <select
            value={`${sort}:${order}`}
            onChange={(e) => {
              const [f, o] = e.target.value.split(":") as [SortField, SortOrder];
              setSort(f);
              setOrder(o);
              const params = new URLSearchParams(searchParams.toString());
              params.set("sort", f);
              params.set("order", o);
              router.replace(`?${params.toString()}`, { scroll: false });
            }}
            className="w-full border border-border rounded px-3 py-2 text-[13px] bg-surface text-ink-2"
            aria-label="Сортировка"
          >
            <option value="startDate:desc">По дате (свежие)</option>
            <option value="startDate:asc">По дате (старые)</option>
            <option value="name:asc">По имени (А-Я)</option>
            <option value="amount:desc">По сумме (большие)</option>
            <option value="amount:asc">По сумме (малые)</option>
            <option value="status:desc">По статусу (горящие)</option>
          </select>
        </div>

        {/* ── Desktop table ── */}
        {sortedRows.length === 0 ? (
          <div className="bg-surface border border-border rounded-lg px-4 py-14 text-center">
            {allRows.length === 0 ? (
              <>
                <p className="text-2xl mb-2">🎉</p>
                <p className="eyebrow mb-1">Дебиторка</p>
                <p className="text-[15px] font-medium text-ink mb-1">Долгов нет</p>
                <p className="text-sm text-ink-2">Все клиенты закрыли свои брони.</p>
              </>
            ) : (
              <p className="text-sm text-ink-3">Нет результатов по выбранному фильтру</p>
            )}
          </div>
        ) : (
          <>
            {/* Desktop table (hidden on mobile) */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full border-collapse bg-surface border border-border rounded-lg overflow-hidden text-[13.5px]">
                <thead className="bg-surface-subtle text-[11px] uppercase tracking-wide text-ink-3">
                  <tr>
                    <th
                      className={`text-left px-3 py-2.5 border-b border-border cursor-pointer select-none w-[92px] ${sort === "startDate" ? "text-accent-bright" : ""}`}
                      onClick={() => handleSort("startDate")}
                    >
                      Дата проекта
                      <SortArrow active={sort === "startDate"} order={order} />
                    </th>
                    <th
                      className={`text-left px-3 py-2.5 border-b border-border cursor-pointer select-none ${sort === "name" ? "text-accent-bright" : ""}`}
                      onClick={() => handleSort("name")}
                    >
                      Клиент / Проект
                      <SortArrow active={sort === "name"} order={order} />
                    </th>
                    <th
                      className={`text-right px-3 py-2.5 border-b border-border cursor-pointer select-none w-[120px] ${sort === "amount" ? "text-accent-bright" : ""}`}
                      onClick={() => handleSort("amount")}
                    >
                      Сумма
                      <SortArrow active={sort === "amount"} order={order} />
                    </th>
                    <th
                      className={`text-left px-3 py-2.5 border-b border-border cursor-pointer select-none w-[130px] ${sort === "status" ? "text-accent-bright" : ""}`}
                      onClick={() => handleSort("status")}
                    >
                      Статус
                      <SortArrow active={sort === "status"} order={order} />
                    </th>
                    <th className="text-left px-3 py-2.5 border-b border-border w-[200px]">
                      Действия
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((row) => {
                    const dateInfo = formatStartDate(row.startDate);
                    const dateColor = startDateColor(row.startDate, row.daysOverdue);
                    const pill = statusPill(row.paymentStatus, row.daysOverdue);

                    return (
                      <tr
                        key={row.bookingId}
                        className="border-t border-border hover:bg-surface-subtle transition-colors"
                      >
                        {/* Date */}
                        <td className={`px-3 py-2.5 font-mono font-semibold leading-tight ${dateColor}`}>
                          {dateInfo ? (
                            <>
                              <span className="text-[14px] block">{dateInfo.dayMon}</span>
                              <span className="text-[11px] text-ink-3">{dateInfo.year}</span>
                            </>
                          ) : <span className="text-ink-3">—</span>}
                        </td>

                        {/* Client / Project */}
                        <td className="px-3 py-2.5 leading-tight">
                          <div className="font-semibold text-ink text-[13.5px]">{row.clientName}</div>
                          <div className="text-[11.5px] text-ink-2">{row.projectName}</div>
                        </td>

                        {/* Amount */}
                        <td className="px-3 py-2.5 text-right leading-tight">
                          <div className="mono-num font-semibold text-[14px] text-rose">
                            {formatRub(row.amountOutstanding)}
                          </div>
                          {/* D1: show «получено» on ALL non-PAID rows */}
                          {Number(row.amountPaid) > 0 ? (
                            <div className="text-[11px] text-ink-3">
                              получено: {formatRub(Number(row.amountPaid))} из {formatRub(Number(row.finalAmount))}
                            </div>
                          ) : (
                            <div className="text-[11px] text-ink-3">получено: 0 ₽</div>
                          )}
                        </td>

                        {/* Status */}
                        <td className="px-3 py-2.5">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border whitespace-nowrap ${pill.cls}`}>
                            {pill.label}
                          </span>
                        </td>

                        {/* Actions — Variant 2: CTA + icons */}
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => openPayment(row)}
                              className="h-[30px] px-2.5 flex items-center gap-1 bg-accent text-white border border-accent rounded text-[12px] font-medium hover:bg-accent-bright"
                            >
                              ₽ Оплатить
                            </button>
                            <a
                              href={`/bookings/${row.bookingId}`}
                              aria-label="Редактировать бронь"
                              className="h-[30px] w-[30px] flex items-center justify-center border border-border bg-surface rounded text-ink-2 hover:bg-surface-subtle text-sm"
                            >
                              ✏️
                            </a>
                            <ActionMenu
                              row={row}
                              onRemind={() => openReminder(row)}
                              onDelete={() => handleDelete(row)}
                              onPaymentsList={() => openPaymentsList(row)}
                            />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile cards (hidden on desktop) */}
            <div className="md:hidden flex flex-col gap-3">
              {sortedRows.map((row) => {
                const dateInfo = formatStartDate(row.startDate);
                const dateColor = startDateColor(row.startDate, row.daysOverdue);
                const pill = statusPill(row.paymentStatus, row.daysOverdue);
                return (
                  <div key={row.bookingId} className="bg-surface border border-border rounded-lg p-3.5">
                    <div className="flex items-center justify-between mb-2">
                      <div className={`font-mono font-semibold text-[14px] ${dateColor}`}>
                        {dateInfo ? `${dateInfo.dayMon} ${dateInfo.year}` : "—"}
                      </div>
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border ${pill.cls}`}>
                        {pill.label}
                      </span>
                    </div>
                    <div className="font-semibold text-ink text-[14px] mb-0.5">{row.clientName}</div>
                    <div className="text-[12px] text-ink-2 mb-2">{row.projectName}</div>
                    <div className="flex items-end justify-between mb-3">
                      <span className="mono-num font-semibold text-[18px] text-rose">{formatRub(row.amountOutstanding)}</span>
                      {/* D1: show «получено» on ALL non-PAID rows in mobile card */}
                      {Number(row.amountPaid) > 0 ? (
                        <span className="text-[11px] text-ink-3">
                          получено: {formatRub(Number(row.amountPaid))} из {formatRub(Number(row.finalAmount))}
                        </span>
                      ) : (
                        <span className="text-[11px] text-ink-3">получено: 0 ₽</span>
                      )}
                    </div>
                    {/* D4: 3-button layout — row 1: full-width CTA, row 2: ✏️ + ⋯ at ≥44px */}
                    <div className="grid grid-cols-2 gap-1.5 mb-1.5">
                      <button
                        onClick={() => openPayment(row)}
                        className="h-11 flex items-center justify-center gap-1 bg-accent text-white border border-accent rounded text-[13px] font-medium hover:bg-accent-bright col-span-2"
                      >
                        ₽ Оплатить
                      </button>
                    </div>
                    <div className="grid grid-cols-2 gap-1.5">
                      <a
                        href={`/bookings/${row.bookingId}`}
                        className="h-11 flex items-center justify-center gap-1 border border-border bg-surface rounded text-[12px] text-ink-2 hover:bg-surface-subtle"
                      >
                        ✏️ Правка
                      </a>
                      <ActionMenu
                        row={row}
                        onRemind={() => openReminder(row)}
                        onDelete={() => handleDelete(row)}
                        onPaymentsList={() => openPaymentsList(row)}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

      </div>

      {/* Modals */}
      <RecordPaymentModal
        open={paymentOpen}
        onClose={() => setPaymentOpen(false)}
        defaultBookingId={paymentBookingId}
        bookingContext={paymentContext ? {
          id: paymentBookingId ?? "",
          displayName: paymentContext.projectName,
          projectName: paymentContext.projectName,
          amountOutstanding: paymentContext.amountOutstanding,
          client: { name: paymentContext.clientName },
        } : undefined}
        legacyFinance
        onCreated={() => { setPaymentOpen(false); loadDebts(); }}
      />

      {activeReminderClient && (
        <AIReminderModal
          open={!!reminderRowClientId}
          onClose={() => { setReminderClientDebt(null); setReminderRowClientId(null); }}
          clientId={activeReminderClient.clientId}
          clientName={activeReminderClient.clientName}
          totalOutstanding={activeReminderClient.totalOutstanding}
          clientEmail={activeReminderClient.clientEmail ?? null}
          onReminded={() => {
            setReminderClientDebt(null);
            setReminderRowClientId(null);
            fetchRemindable();
            loadDebts();
          }}
        />
      )}

      {paymentsListContext && (
        <BookingPaymentsModal
          open={paymentsListOpen}
          onClose={() => setPaymentsListOpen(false)}
          bookingId={paymentsListBookingId}
          bookingContext={paymentsListContext}
          onChange={() => loadDebts()}
        />
      )}

      <LegacyBookingImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => { setImportOpen(false); loadDebts(); }}
      />
    </div>
  );
}

export default function DebtsPage() {
  return (
    <Suspense fallback={<div className="p-8 text-ink-3 text-sm">Загрузка…</div>}>
      <DebtsPageInner />
    </Suspense>
  );
}
