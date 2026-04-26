"use client";

import React, { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { useRequireRole } from "../../../src/hooks/useRequireRole";
import { useCurrentUser } from "../../../src/hooks/useCurrentUser";
import { apiFetch } from "../../../src/lib/api";
import { formatRub, pluralize } from "../../../src/lib/format";
import { FinanceTabNav } from "../../../src/components/finance/FinanceTabNav";
import { LegacyBookingImportModal } from "../../../src/components/finance/LegacyBookingImportModal";
import { ContactChips } from "../../../src/components/finance/ContactChips";
import { RecordPaymentModal } from "../../../src/components/finance/RecordPaymentModal";
import type { UserRole } from "../../../src/lib/auth";

const ALLOWED: UserRole[] = ["SUPER_ADMIN"];

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

type AgingBucket = "overdue30" | "overdue7" | "soon" | "current";

function getAgingBucket(maxDaysOverdue: number, projects: DebtProject[]): AgingBucket {
  if (maxDaysOverdue > 30) return "overdue30";
  if (maxDaysOverdue > 0) return "overdue7";
  const now = Date.now();
  for (const p of projects) {
    if (!p.expectedPaymentDate) continue;
    const diff = Math.ceil((new Date(p.expectedPaymentDate).getTime() - now) / 86400000);
    if (diff >= 0 && diff <= 7) return "soon";
  }
  return "current";
}

function formatPayDate(dateStr: string | null): string {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
}

// Aging cell color classes
const BUCKET_CELL = [
  // current
  "bg-surface-subtle text-ink-2",
  // 1-30
  "text-amber",
  // 31-60
  "text-amber font-medium",
  // 61-90
  "text-rose font-medium",
  // 90+
  "text-rose font-semibold",
] as const;

const BUCKET_BG = [
  "bg-surface-subtle",
  "bg-amber-soft/60",
  "bg-amber-soft",
  "bg-rose-soft/70",
  "bg-rose-soft",
] as const;

// ── Main page ─────────────────────────────────────────────────────────────────

function DebtsPageInner() {
  const { authorized, loading } = useRequireRole(ALLOWED);
  const currentUser = useCurrentUser();
  const searchParams = useSearchParams();
  const legacyMode = searchParams.get("legacy") === "1";
  const [data, setData] = useState<DebtsResponse | null>(null);
  const [search, setSearch] = useState("");
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [recordPaymentOpen, setRecordPaymentOpen] = useState(false);

  function loadDebts() {
    let cancelled = false;
    setFetching(true);
    apiFetch<DebtsResponse>("/api/finance/debts?withAging=true")
      .then((d) => { if (!cancelled) setData(d); })
      .finally(() => { if (!cancelled) setFetching(false); });
    return () => { cancelled = true; };
  }

  useEffect(() => {
    if (!authorized) return;
    return loadDebts();
  }, [authorized]);

  function toggle(clientId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(clientId)) next.delete(clientId);
      else next.add(clientId);
      return next;
    });
  }

  if (loading || !authorized) return null;
  if (!data && fetching) return <div className="p-8 text-ink-3 text-sm">Загрузка…</div>;

  const debtCount = data?.summary.totalClients ?? data?.debts.length ?? 0;

  // Filter legacy debts
  const filteredDebts = (data?.debts ?? []).filter((d) => {
    const bucket = getAgingBucket(d.maxDaysOverdue, d.projects);
    const matchOverdue = !overdueOnly || bucket === "overdue30" || bucket === "overdue7";
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
      // show rows that have any non-current debt
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
  const hasLegacyDebts = filteredDebts.length > 0;

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
                onClick={() => {
                  const a = document.createElement("a");
                  a.href = "/api/finance/debts.xlsx";
                  a.download = "debts.xlsx";
                  a.click();
                }}
                className="px-3.5 py-2 text-[12px] font-medium border border-border bg-surface rounded-lg hover:bg-surface-subtle"
              >
                📊 Экспорт XLSX
              </button>
            </div>
          </div>
        </div>

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
            {/* Toggle: все / только просроченные */}
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

        {/* Aging matrix table */}
        {hasAgingMatrix ? (
          <div className="bg-surface border border-border rounded-lg overflow-hidden shadow-xs mb-6">
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]" style={{ minWidth: 680 }}>
                <thead className="bg-surface-subtle border-b border-border">
                  <tr>
                    <th className="px-4 py-3 text-left eyebrow">Контрагент</th>
                    <th className="px-3 py-3 text-right eyebrow">Текущая</th>
                    <th className="px-3 py-3 text-right eyebrow">1–30 дн.</th>
                    <th className="px-3 py-3 text-right eyebrow">31–60</th>
                    <th className="px-3 py-3 text-right eyebrow">61–90</th>
                    <th className="px-3 py-3 text-right eyebrow">90+</th>
                    <th className="px-3 py-3 text-right eyebrow">Итого</th>
                    <th className="w-40 px-3 py-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {agingRows.map((row) => {
                    // find matching legacy debt for contact info
                    const legacyDebt = data?.debts.find((d) => d.clientId === row.clientId);
                    const phone = row.clientPhone ?? legacyDebt?.clientPhone ?? null;
                    const email = row.clientEmail ?? legacyDebt?.clientEmail ?? null;
                    const bookingsCount = legacyDebt?.bookingsCount ?? 0;

                    type BucketKey = "current" | "days1to30" | "days31to60" | "days61to90" | "over90";
                    const cells: [BucketKey, number][] = [
                      ["current", 0],
                      ["days1to30", 1],
                      ["days31to60", 2],
                      ["days61to90", 3],
                      ["over90", 4],
                    ];

                    return (
                      <tr key={row.clientId} className="border-b border-slate-soft last:border-0 hover:bg-surface-subtle/30 transition-colors">
                        <td className="px-4 py-3.5">
                          <strong className="text-ink font-medium">{row.clientName}</strong>
                          <div className="text-[11px] text-ink-3 mt-0.5">
                            {bookingsCount > 0
                              ? `${bookingsCount} ${pluralize(bookingsCount, "счёт", "счёта", "счетов")}`
                              : "по счетам"}
                          </div>
                        </td>
                        {cells.map(([key, idx]) => {
                          const val = Number(row[key]);
                          return (
                            <td
                              key={key}
                              className={`px-3 py-3.5 text-right mono-num ${BUCKET_BG[idx]} ${val > 0 ? BUCKET_CELL[idx] : "text-ink-3"}`}
                            >
                              {val > 0 ? formatRub(val) : "—"}
                            </td>
                          );
                        })}
                        <td className="px-3 py-3.5 text-right mono-num font-semibold text-ink">
                          {formatRub(row.total)}
                        </td>
                        <td className="px-3 py-3.5">
                          <div className="flex gap-1.5 justify-end flex-wrap">
                            <button
                              onClick={() => setRecordPaymentOpen(true)}
                              className="px-2.5 py-1 text-[11px] border border-border bg-surface rounded hover:border-accent-bright hover:text-accent-bright transition-colors whitespace-nowrap"
                            >
                              ₽ Платёж
                            </button>
                            <ContactChips
                              phone={phone}
                              email={email}
                              clientName={row.clientName}
                              outstanding={Number(row.total)}
                            />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {/* Totals row */}
                  <tr className="bg-ink text-white">
                    <td className="px-4 py-3 font-semibold">Итого</td>
                    <td className="px-3 py-3 text-right mono-num">{agingTotals.current > 0 ? formatRub(agingTotals.current) : "—"}</td>
                    <td className="px-3 py-3 text-right mono-num">{agingTotals.days1to30 > 0 ? formatRub(agingTotals.days1to30) : "—"}</td>
                    <td className="px-3 py-3 text-right mono-num">{agingTotals.days31to60 > 0 ? formatRub(agingTotals.days31to60) : "—"}</td>
                    <td className="px-3 py-3 text-right mono-num">{agingTotals.days61to90 > 0 ? formatRub(agingTotals.days61to90) : "—"}</td>
                    <td className="px-3 py-3 text-right mono-num">{agingTotals.over90 > 0 ? formatRub(agingTotals.over90) : "—"}</td>
                    <td className="px-3 py-3 text-right mono-num font-bold text-[14px]">{formatRub(agingTotals.total)}</td>
                    <td className="px-3 py-3"></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        ) : null}

        {/* Mobile accordion (md:hidden) — aging buckets by priority */}
        <div className="md:hidden mb-5">
          <p className="eyebrow text-ink-3 mb-2">
            всего {data ? formatRub(data.summary.totalOutstanding) : "—"} · {debtCount} контрагентов
          </p>
          {(data?.agingPerClient?.length ?? 0) > 0 && (
            <div className="space-y-2">
              {/* Bucket cards sorted worst-first */}
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

        {/* Legacy bookings section */}
        {hasLegacyDebts && (
          <div className="mt-2">
            <p className="eyebrow text-ink-3 mb-3">Legacy брони (до миграции)</p>
            <div className="flex flex-col gap-2">
              {filteredDebts.map((d) => {
                const isOpen = expanded.has(d.clientId);
                const bucket = getAgingBucket(d.maxDaysOverdue, d.projects);
                const isOverdue = bucket === "overdue30" || bucket === "overdue7";
                const amountTone = isOverdue ? "text-rose" : "text-ink";

                return (
                  <div
                    key={d.clientId}
                    className={`bg-surface border rounded-lg overflow-hidden transition-shadow ${
                      isOpen ? "border-accent-border shadow-sm" : "border-border"
                    }`}
                  >
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      onClick={() => toggle(d.clientId)}
                      className={`w-full grid items-center gap-4 px-4 py-3.5 text-left ${
                        isOpen ? "bg-accent-soft border-b border-accent-border" : "hover:bg-surface-subtle"
                      }`}
                      style={{ gridTemplateColumns: "14px minmax(0,1fr) auto auto auto" }}
                    >
                      <span className={`text-ink-3 text-[12px] transition-transform ${isOpen ? "rotate-90" : ""}`} aria-hidden>
                        ▸
                      </span>
                      <div className="min-w-0">
                        <div className="text-[13px] font-semibold text-ink truncate">{d.clientName}</div>
                        <div className="text-[11px] text-ink-2 mt-0.5">
                          {d.bookingsCount} {pluralize(d.bookingsCount, "проект", "проекта", "проектов")}
                        </div>
                      </div>
                      <div className={`text-right mono-num text-[14px] font-semibold ${amountTone}`}>
                        {formatRub(d.totalOutstanding)}
                      </div>
                      <div className="flex gap-1.5 justify-end" onClick={(e) => e.stopPropagation()}>
                        <ContactChips
                          phone={d.clientPhone ?? null}
                          email={d.clientEmail ?? null}
                          clientName={d.clientName}
                          outstanding={Number(d.totalOutstanding)}
                        />
                        <a
                          href={`/bookings?clientId=${d.clientId}`}
                          aria-label="Открыть брони клиента"
                          className="w-7 h-7 rounded border border-border bg-surface flex items-center justify-center text-ink-2 hover:bg-surface-subtle text-sm"
                        >
                          ›
                        </a>
                      </div>
                    </button>

                    {isOpen && (
                      <div className="bg-surface-subtle pl-14 pr-4 py-2">
                        {d.projects.map((p) => (
                          <div
                            key={p.bookingId}
                            className="grid items-center gap-3 py-2.5 border-b border-dashed border-border last:border-b-0"
                            style={{ gridTemplateColumns: "minmax(0,1fr) auto 32px" }}
                          >
                            <div>
                              <div className="text-[12.5px] text-ink truncate">{p.projectName}</div>
                              <div className="text-[11px] text-ink-3">
                                {p.daysOverdue !== null && p.daysOverdue > 0
                                  ? `Просрочено ${p.daysOverdue} дн.`
                                  : formatPayDate(p.expectedPaymentDate)}
                              </div>
                            </div>
                            <div className={`mono-num text-[13px] font-semibold ${p.daysOverdue !== null && p.daysOverdue > 0 ? "text-rose" : "text-ink"}`}>
                              {formatRub(p.amountOutstanding)}
                            </div>
                            <a
                              href={`/bookings/${p.bookingId}`}
                              aria-label="Открыть бронь"
                              className="w-7 h-7 rounded border border-border bg-surface flex items-center justify-center text-ink-2 hover:bg-surface-subtle text-sm"
                            >
                              ›
                            </a>
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
        {!hasAgingMatrix && !hasLegacyDebts && (
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

      <LegacyBookingImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => { setImportOpen(false); loadDebts(); }}
      />
      <RecordPaymentModal
        open={recordPaymentOpen}
        onClose={() => setRecordPaymentOpen(false)}
        onCreated={() => { setRecordPaymentOpen(false); loadDebts(); }}
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
