"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { useRequireRole } from "../../../src/hooks/useRequireRole";
import { useCurrentUser } from "../../../src/hooks/useCurrentUser";
import { apiFetch } from "../../../src/lib/api";
import { formatRub, pluralize } from "../../../src/lib/format";
import { FinanceTabNav } from "../../../src/components/finance/FinanceTabNav";
import { LegacyBookingImportModal } from "../../../src/components/finance/LegacyBookingImportModal";
import { ContactChips } from "../../../src/components/finance/ContactChips";
import { RecordPaymentModal } from "../../../src/components/finance/RecordPaymentModal";
import { AIReminderModal } from "../../../src/components/finance/AIReminderModal";
import type { UserRole } from "../../../src/lib/auth";

const ALLOWED: UserRole[] = ["SUPER_ADMIN"];

// ── Types ─────────────────────────────────────────────────────────────────────

interface DebtProject {
  bookingId: string;
  projectName: string;
  amountOutstanding: string;
  expectedPaymentDate: string | null;
  daysOverdue: number | null;
  paymentStatus: string;
  bookingStatus?: string;
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

interface InvoiceAgingBucket {
  label: string;
  minDays: number;
  maxDays: number | null;
  total: string;
  invoiceCount: number;
}

interface ClientAgingRow {
  clientId: string;
  clientName: string;
  current: string;
  days1to30: string;
  days31to60: string;
  days61to90: string;
  over90: string;
  total: string;
  clientPhone?: string | null;
  clientEmail?: string | null;
}

interface DebtsResponse {
  debts: ClientDebt[];
  summary: {
    totalClients: number;
    totalOutstanding: string;
    totalOverdue: string;
    asOf: string;
  };
  aging?: InvoiceAgingBucket[];
  agingPerClient?: ClientAgingRow[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

type SortField = "name" | "amount" | "date";
type SortOrder = "asc" | "desc";

function formatPayDate(dateStr: string | null): string {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
}

function formatDaysLabel(maxDaysOverdue: number, projects: DebtProject[]): {
  label: string;
  tone: "rose" | "amber" | "ink-2";
} {
  if (maxDaysOverdue > 0) {
    return { label: `${maxDaysOverdue} ${pluralize(maxDaysOverdue, "день", "дня", "дней")} просрочка`, tone: "rose" };
  }
  const now = Date.now();
  let minDays = Infinity;
  for (const p of projects) {
    if (!p.expectedPaymentDate) continue;
    const diff = Math.ceil((new Date(p.expectedPaymentDate).getTime() - now) / 86400000);
    if (diff >= 0 && diff < minDays) minDays = diff;
  }
  if (minDays <= 7 && minDays !== Infinity) {
    return { label: `через ${minDays} ${pluralize(minDays, "день", "дня", "дней")}`, tone: "amber" };
  }
  return { label: "—", tone: "ink-2" };
}

// Aging cell color classes
const BUCKET_CELL = [
  "bg-surface-subtle text-ink-2",
  "text-amber",
  "text-amber font-medium",
  "text-rose font-medium",
  "text-rose font-semibold",
] as const;

const BUCKET_BG = [
  "bg-surface-subtle",
  "bg-amber-soft/60",
  "bg-amber-soft",
  "bg-rose-soft/70",
  "bg-rose-soft",
] as const;

// ── Sort arrow ─────────────────────────────────────────────────────────────────

function SortArrow({ active, order }: { active: boolean; order: SortOrder }) {
  if (!active) return <span className="text-ink-3 text-[10px] ml-1">↕</span>;
  return <span className="text-accent-bright text-[10px] ml-1">{order === "asc" ? "▲" : "▼"}</span>;
}

// ── Smart-pick earliest overdue booking ───────────────────────────────────────

function pickPriorityBooking(projects: DebtProject[]): string | null {
  if (!projects?.length) return null;
  // 1. Most overdue (daysOverdue > 0, descending)
  const overdue = projects.filter((p) => (p.daysOverdue ?? 0) > 0);
  if (overdue.length > 0) {
    return overdue.sort((a, b) => (b.daysOverdue ?? 0) - (a.daysOverdue ?? 0))[0].bookingId;
  }
  // 2. With dueDate, earliest first
  const withDueDate = projects.filter((p) => p.expectedPaymentDate);
  if (withDueDate.length > 0) {
    return withDueDate.sort((a, b) =>
      String(a.expectedPaymentDate).localeCompare(String(b.expectedPaymentDate))
    )[0].bookingId;
  }
  // 3. Largest amount fallback
  return projects.sort((a, b) =>
    Number(b.amountOutstanding) - Number(a.amountOutstanding)
  )[0].bookingId;
}

// ── Main page ─────────────────────────────────────────────────────────────────

function DebtsPageInner() {
  const { authorized, loading } = useRequireRole(ALLOWED);
  const currentUser = useCurrentUser();
  const router = useRouter();
  const searchParams = useSearchParams();

  const legacyMode = searchParams.get("legacy") === "1";
  const initSort = (searchParams.get("sort") as SortField | null) ?? "amount";
  const initOrder = (searchParams.get("order") as SortOrder | null) ?? "desc";

  const [sort, setSort] = useState<SortField>(initSort);
  const [order, setOrder] = useState<SortOrder>(initOrder);
  const [data, setData] = useState<DebtsResponse | null>(null);
  const [search, setSearch] = useState("");
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Payment modal state
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [paymentBookingId, setPaymentBookingId] = useState<string | undefined>(undefined);

  // AI reminder modal state
  const [reminderClient, setReminderClient] = useState<ClientDebt | null>(null);

  // Remindable clients ribbon
  const [remindableCount, setRemindableCount] = useState<number | null>(null);
  const remindableFetched = useRef(false);

  const fetchRemindable = useCallback(() => {
    let cancelled = false;
    apiFetch<{ clients: Array<{ clientId: string }> }>("/api/finance/debts/remindable")
      .then((d) => { if (!cancelled) setRemindableCount(d.clients.length); })
      .catch(() => { if (!cancelled) setRemindableCount(null); });
    return () => { cancelled = true; };
  }, []);

  const loadDebts = useCallback((s: SortField, o: SortOrder) => {
    let cancelled = false;
    setFetching(true);
    apiFetch<DebtsResponse>(`/api/finance/debts?withAging=true&sort=${s}&order=${o}`)
      .then((d) => { if (!cancelled) setData(d); })
      .finally(() => { if (!cancelled) setFetching(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!authorized) return;
    return loadDebts(sort, order);
  }, [authorized, sort, order, loadDebts]);

  useEffect(() => {
    if (!authorized || remindableFetched.current) return;
    remindableFetched.current = true;
    fetchRemindable();
  }, [authorized, fetchRemindable]);

  function handleSort(field: SortField) {
    const newOrder = sort === field && order === "desc" ? "asc" : "desc";
    setSort(field);
    setOrder(newOrder);
    const params = new URLSearchParams(searchParams.toString());
    params.set("sort", field);
    params.set("order", newOrder);
    router.replace(`?${params.toString()}`, { scroll: false });
  }

  function toggle(clientId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(clientId)) next.delete(clientId);
      else next.add(clientId);
      return next;
    });
  }

  function openPayment(bookingId?: string) {
    setPaymentBookingId(bookingId);
    setPaymentOpen(true);
  }

  function handlePaymentCreated() {
    setPaymentOpen(false);
    loadDebts(sort, order);
  }

  function handleReminderSent() {
    setReminderClient(null);
    fetchRemindable();
    loadDebts(sort, order);
  }

  if (loading || !authorized) return null;
  if (!data && fetching) return <div className="p-8 text-ink-3 text-sm">Загрузка…</div>;

  const debtCount = data?.summary.totalClients ?? data?.debts.length ?? 0;

  // Filter debts
  const filteredDebts = (data?.debts ?? []).filter((d) => {
    const isOverdue = d.maxDaysOverdue > 0;
    const matchOverdue = !overdueOnly || isOverdue;
    const q = search.toLowerCase();
    const matchSearch =
      !q ||
      d.clientName.toLowerCase().includes(q) ||
      d.projects.some((p) => p.projectName.toLowerCase().includes(q));
    return matchOverdue && matchSearch;
  });

  // Filter aging matrix rows
  const agingRows = (data?.agingPerClient ?? []).filter((row) => {
    const q = search.toLowerCase();
    if (q && !row.clientName.toLowerCase().includes(q)) return false;
    if (overdueOnly) {
      return (
        Number(row.days1to30) > 0 ||
        Number(row.days31to60) > 0 ||
        Number(row.days61to90) > 0 ||
        Number(row.over90) > 0
      );
    }
    return true;
  });

  // Totals for aging matrix
  const agingTotals = agingRows.reduce(
    (acc, row) => ({
      current: acc.current + Number(row.current),
      days1to30: acc.days1to30 + Number(row.days1to30),
      days31to60: acc.days31to60 + Number(row.days31to60),
      days61to90: acc.days61to90 + Number(row.days61to90),
      over90: acc.over90 + Number(row.over90),
      total: acc.total + Number(row.total),
    }),
    { current: 0, days1to30: 0, days31to60: 0, days61to90: 0, over90: 0, total: 0 }
  );

  const hasAgingMatrix = agingRows.length > 0;
  const hasDebtsList = filteredDebts.length > 0;

  return (
    <div className="pb-10 bg-surface-subtle min-h-screen">
      <FinanceTabNav debtCount={debtCount} />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-5">

        {/* Header */}
        <div className="mb-5">
          <p className="eyebrow text-ink-3">Финансы</p>
          <div className="flex items-center justify-between gap-3 flex-wrap mt-1">
            <h1 className="text-[22px] font-semibold text-ink tracking-tight">Дебиторка</h1>
            <div className="flex gap-2">
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
                📊 Экспорт XLSX
              </button>
            </div>
          </div>
        </div>

        {/* KPI summary strip */}
        {data?.summary && (
          <div className="grid grid-cols-3 gap-3 mb-5">
            <div className="bg-surface border border-border rounded-lg px-4 py-3">
              <p className="eyebrow text-ink-3 mb-0.5">Всего долгов</p>
              <p className="mono-num text-[18px] font-semibold text-ink">{formatRub(data.summary.totalOutstanding)}</p>
            </div>
            <div className="bg-surface border border-border rounded-lg px-4 py-3">
              <p className="eyebrow text-ink-3 mb-0.5">Просрочено</p>
              <p className={`mono-num text-[18px] font-semibold ${Number(data.summary.totalOverdue) > 0 ? "text-rose" : "text-ink"}`}>
                {formatRub(data.summary.totalOverdue)}
              </p>
            </div>
            <div className="bg-surface border border-border rounded-lg px-4 py-3">
              <p className="eyebrow text-ink-3 mb-0.5">Клиентов с долгом</p>
              <p className="mono-num text-[18px] font-semibold text-ink">{data.summary.totalClients}</p>
            </div>
          </div>
        )}

        {/* Action ribbon: clients ready for reminder */}
        {remindableCount !== null && remindableCount > 0 && (
          <div className="mb-4 flex items-center gap-3 bg-amber-soft border border-amber-border rounded-lg px-4 py-3">
            <span className="text-[13px] text-ink">
              🤖 {remindableCount} {pluralize(remindableCount, "клиент готов", "клиента готовы", "клиентов готовы")} к напоминанию
            </span>
            <button
              type="button"
              onClick={() => setOverdueOnly(true)}
              className="ml-auto px-3 py-1.5 text-[11px] font-medium border border-amber-border rounded-lg bg-surface hover:bg-amber-soft"
            >
              Просмотреть
            </button>
          </div>
        )}

        {/* Filter row */}
        <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="text"
              className="border border-border rounded-lg px-3 py-2 text-[13px] bg-surface min-w-[240px]"
              placeholder="🔍 Контрагент или проект…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="flex border border-border rounded-lg overflow-hidden">
              <button
                onClick={() => setOverdueOnly(false)}
                className={`px-3.5 py-2 text-[12px] font-medium transition-colors ${
                  !overdueOnly
                    ? "bg-surface text-ink"
                    : "bg-surface-subtle text-ink-2 hover:bg-surface"
                }`}
              >
                Все с остатком
              </button>
              <button
                onClick={() => setOverdueOnly(true)}
                className={`px-3.5 py-2 text-[12px] font-medium transition-colors border-l border-border ${
                  overdueOnly
                    ? "bg-accent-bright text-white"
                    : "bg-surface-subtle text-ink-2 hover:bg-surface"
                }`}
              >
                Только просроченные
              </button>
            </div>
          </div>
        </div>

        {/* Aging legend */}
        <div className="flex gap-4 items-center text-[12px] text-ink-2 mb-3 flex-wrap">
          <span className="font-semibold">Светофор просрочки:</span>
          <span className="flex items-center gap-1.5">
            <span className="w-3.5 h-3.5 rounded-sm bg-surface-subtle border border-border inline-block" />
            Текущая
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-3.5 h-3.5 rounded-sm bg-amber-soft/60 inline-block" />
            1–30 дн.
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-3.5 h-3.5 rounded-sm bg-amber-soft inline-block" />
            31–60
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-3.5 h-3.5 rounded-sm bg-rose-soft/70 inline-block" />
            61–90
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-3.5 h-3.5 rounded-sm bg-rose-soft inline-block" />
            90+ безнадёжно
          </span>
        </div>


        {/* Mobile accordion (md:hidden) */}
        <div className="md:hidden mb-5">
          <p className="eyebrow text-ink-3 mb-2">
            всего {data ? formatRub(data.summary.totalOutstanding) : "—"} · {debtCount} контрагентов
          </p>
          {(data?.agingPerClient?.length ?? 0) > 0 && (
            <div className="space-y-2">
              {[
                { label: "90+ безнадёжно", key: "over90" as const, borderColor: "border-rose-border", textColor: "text-rose" },
                { label: "61–90 дней", key: "days61to90" as const, borderColor: "border-rose-border", textColor: "text-rose" },
                { label: "31–60 дней", key: "days31to60" as const, borderColor: "border-amber-border", textColor: "text-amber" },
                { label: "1–30 дней", key: "days1to30" as const, borderColor: "border-amber-border", textColor: "text-amber" },
              ].map(({ label, key, borderColor, textColor }) => {
                const total = agingRows.reduce((s, r) => s + Number(r[key]), 0);
                const clients = agingRows.filter((r) => Number(r[key]) > 0).map((r) => r.clientName);
                if (total === 0) return null;
                return (
                  <div key={key} className={`border ${borderColor} rounded-lg p-3`}>
                    <div className="flex justify-between items-center">
                      <strong className={textColor}>{label}</strong>
                      <span className={`mono-num font-semibold ${textColor}`}>{formatRub(total)}</span>
                    </div>
                    <div className="mt-2 text-[12px] text-ink-2">{clients.slice(0, 3).join(" · ")}</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Per-client debts table with sortable header */}
        {hasDebtsList && (
          <div className="mt-2">
            <div className="bg-surface border border-border rounded-t-lg overflow-hidden">
              {/* Sortable table header */}
              <div
                className="hidden md:grid items-center bg-surface-subtle border-b border-border px-4 py-2.5 text-[11px] font-medium text-ink-2"
                style={{ gridTemplateColumns: "24px minmax(0,1fr) 130px 160px 220px 24px" }}
              >
                <div></div>
                <button
                  type="button"
                  onClick={() => handleSort("name")}
                  className="text-left flex items-center hover:text-ink"
                >
                  Клиент
                  <SortArrow active={sort === "name"} order={order} />
                </button>
                <button
                  type="button"
                  onClick={() => handleSort("amount")}
                  className="text-right flex items-center justify-end hover:text-ink"
                >
                  Долг
                  <SortArrow active={sort === "amount"} order={order} />
                </button>
                <button
                  type="button"
                  onClick={() => handleSort("date")}
                  className="text-right flex items-center justify-end hover:text-ink"
                >
                  Самый старый долг
                  <SortArrow active={sort === "date"} order={order} />
                </button>
                <div className="text-right">Действия</div>
                <div></div>
              </div>
            </div>

            <div className="flex flex-col gap-0 border-x border-b border-border rounded-b-lg overflow-hidden">
              {filteredDebts.map((d) => {
                const isOpen = expanded.has(d.clientId);
                const isOverdue = d.maxDaysOverdue > 0;
                const amountTone = isOverdue ? "text-rose" : "text-ink";
                const { label: daysLabel, tone: daysTone } = formatDaysLabel(d.maxDaysOverdue, d.projects);
                const earliestBookingId = pickPriorityBooking(d.projects);

                return (
                  <div
                    key={d.clientId}
                    className={`bg-surface border-b border-border last:border-b-0 overflow-hidden transition-shadow ${
                      isOpen ? "shadow-sm" : ""
                    }`}
                  >
                    {/* Row header */}
                    <div
                      className={`grid items-center gap-3 px-4 py-3.5 ${
                        isOpen ? "bg-accent-soft border-b border-accent-border" : "hover:bg-surface-subtle"
                      }`}
                      style={{ gridTemplateColumns: "24px minmax(0,1fr) auto" }}
                    >
                      {/* Chevron */}
                      <button
                        type="button"
                        aria-expanded={isOpen}
                        aria-label={isOpen ? "Свернуть" : "Развернуть"}
                        onClick={() => toggle(d.clientId)}
                        className="w-6 h-6 flex items-center justify-center text-ink-3 text-[12px]"
                      >
                        <span className={`inline-block transition-transform ${isOpen ? "rotate-90" : ""}`}>▸</span>
                      </button>

                      {/* Client info + inline KPI */}
                      <div className="min-w-0 cursor-pointer" onClick={() => toggle(d.clientId)}>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[13px] font-semibold text-ink">{d.clientName}</span>
                          <span className="text-[11px] text-ink-3">
                            {d.bookingsCount} {pluralize(d.bookingsCount, "проект", "проекта", "проектов")}
                          </span>
                          <span className={`text-[11px] mono-num font-semibold ${amountTone}`}>
                            {formatRub(d.totalOutstanding)}
                          </span>
                          {daysLabel !== "—" && (
                            <span className={`text-[11px] text-${daysTone}`}>{daysLabel}</span>
                          )}
                        </div>
                        {/* Contact chips inline */}
                        <div className="flex items-center gap-1.5 mt-1" onClick={(e) => e.stopPropagation()}>
                          {d.clientPhone && (
                            <a
                              href={`tel:${d.clientPhone}`}
                              className="text-[11px] text-ink-2 hover:text-accent-bright flex items-center gap-0.5"
                            >
                              📞 {d.clientPhone}
                            </a>
                          )}
                          {d.clientEmail && (
                            <a
                              href={`mailto:${d.clientEmail}`}
                              className="text-[11px] text-ink-2 hover:text-accent-bright flex items-center gap-0.5"
                            >
                              ✉️ {d.clientEmail}
                            </a>
                          )}
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex gap-1.5 items-center flex-wrap justify-end" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          onClick={() => openPayment(earliestBookingId ?? undefined)}
                          className="px-2.5 py-1.5 text-[11px] font-medium border border-accent-bright bg-accent-bright text-white rounded-lg hover:opacity-90 whitespace-nowrap"
                        >
                          ₽ Оплатить
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            window.location.href = `/api/finance/debts/${d.clientId}/export.xlsx`;
                          }}
                          className="px-2.5 py-1.5 text-[11px] border border-border bg-surface rounded-lg hover:bg-surface-subtle whitespace-nowrap"
                        >
                          📊 Экспорт
                        </button>
                        <button
                          type="button"
                          onClick={() => setReminderClient(d)}
                          className="px-2.5 py-1.5 text-[11px] border border-border bg-surface rounded-lg hover:bg-surface-subtle whitespace-nowrap"
                        >
                          🤖 Напомнить
                        </button>
                      </div>
                    </div>

                    {/* Expanded details */}
                    {isOpen && (
                      <div className="bg-surface-subtle px-10 py-3">
                        {/* Mini aging matrix */}
                        {(() => {
                          const agingRow = data?.agingPerClient?.find((r) => r.clientId === d.clientId);
                          if (!agingRow) return null;
                          return (
                            <div className="flex gap-3 flex-wrap mb-3 text-[11px]">
                              <span className="text-ink-3 font-medium">Старение:</span>
                              {[
                                { label: "Текущая", val: agingRow.current, cls: "text-ink-2" },
                                { label: "1–30 дн.", val: agingRow.days1to30, cls: "text-amber" },
                                { label: "31–60", val: agingRow.days31to60, cls: "text-amber font-medium" },
                                { label: "61–90", val: agingRow.days61to90, cls: "text-rose font-medium" },
                                { label: "90+", val: agingRow.over90, cls: "text-rose font-semibold" },
                              ].filter((b) => Number(b.val) > 0).map((b) => (
                                <span key={b.label} className={b.cls}>
                                  {b.label}: {formatRub(b.val)}
                                </span>
                              ))}
                            </div>
                          );
                        })()}

                        {/* Per-booking rows */}
                        {d.projects.map((p) => (
                          <div
                            key={p.bookingId}
                            className="grid items-center gap-3 py-2.5 border-b border-dashed border-border last:border-b-0"
                            style={{ gridTemplateColumns: "minmax(0,1fr) 90px 90px 120px auto" }}
                          >
                            <div>
                              <div className="text-[12.5px] text-ink truncate">{p.projectName}</div>
                              <div className="text-[11px] text-ink-3">
                                {p.daysOverdue !== null && p.daysOverdue > 0
                                  ? `Просрочено ${p.daysOverdue} дн.`
                                  : formatPayDate(p.expectedPaymentDate)}
                              </div>
                            </div>
                            <div className="text-[11px] text-ink-2 mono-num text-right hidden md:block">
                              —
                            </div>
                            <div className="text-[11px] text-ink-2 mono-num text-right hidden md:block">
                              —
                            </div>
                            <div className={`mono-num text-[13px] font-semibold text-right ${p.daysOverdue !== null && p.daysOverdue > 0 ? "text-rose" : "text-ink"}`}>
                              {formatRub(p.amountOutstanding)}
                            </div>
                            <div className="flex gap-1.5 justify-end">
                              <button
                                type="button"
                                onClick={() => openPayment(p.bookingId)}
                                className="px-2.5 py-1 text-[11px] border border-border bg-surface rounded hover:border-accent-bright hover:text-accent-bright transition-colors whitespace-nowrap"
                              >
                                Оплатить эту бронь
                              </button>
                              <a
                                href={`/bookings/${p.bookingId}`}
                                aria-label="Открыть бронь"
                                className="w-7 h-7 rounded border border-border bg-surface flex items-center justify-center text-ink-2 hover:bg-surface-subtle text-sm"
                              >
                                ›
                              </a>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Empty state */}
        {!hasAgingMatrix && !hasDebtsList && (
          <div className="bg-accent-soft border border-accent-border rounded-lg px-4 py-14 text-center">
            {data?.debts.length === 0 && (data?.agingPerClient?.length ?? 0) === 0 ? (
              <>
                <p className="text-2xl mb-2">🎉</p>
                <p className="eyebrow mb-1">Должники</p>
                <p className="text-[15px] font-medium text-ink mb-1">Долгов нет</p>
                <p className="text-sm text-ink-2">Все клиенты закрыли свои брони.</p>
              </>
            ) : (
              <p className="text-sm text-ink-3">Нет результатов по выбранному фильтру</p>
            )}
          </div>
        )}

        {data?.summary && (
          <div className="mt-4 px-4 py-3 border border-border rounded-lg bg-surface flex justify-between text-[12px] text-ink-2">
            <span>
              {data.summary.totalClients} {pluralize(data.summary.totalClients, "клиент", "клиента", "клиентов")}
            </span>
            <span className="mono-num font-semibold text-ink">{formatRub(data.summary.totalOutstanding)}</span>
          </div>
        )}
      </div>

      {/* Modals */}
      <LegacyBookingImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => { setImportOpen(false); loadDebts(sort, order); }}
      />
      <RecordPaymentModal
        open={paymentOpen}
        defaultBookingId={paymentBookingId}
        onClose={() => setPaymentOpen(false)}
        onCreated={handlePaymentCreated}
      />
      {reminderClient && (
        <AIReminderModal
          open={true}
          onClose={() => setReminderClient(null)}
          clientId={reminderClient.clientId}
          clientName={reminderClient.clientName}
          totalOutstanding={formatRub(reminderClient.totalOutstanding)}
          clientEmail={reminderClient.clientEmail}
          onReminded={handleReminderSent}
        />
      )}
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
