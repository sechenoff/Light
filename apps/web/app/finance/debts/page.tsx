"use client";

import React, { useEffect, useState } from "react";
import { useRequireRole } from "../../../src/hooks/useRequireRole";
import { apiFetch } from "../../../src/lib/api";
import { formatRub } from "../../../src/lib/format";
import { FinanceTabNav } from "../../../src/components/finance/FinanceTabNav";
import type { UserRole } from "../../../src/lib/auth";

const ALLOWED: UserRole[] = ["SUPER_ADMIN"];

interface DebtProject {
  bookingId: string;
  projectName: string;
  amountOutstanding: string;
  expectedPaymentDate: string | null;
  daysOverdue: number | null;
  paymentStatus: string;
}

interface ClientDebt {
  clientId: string;
  clientName: string;
  totalOutstanding: string;
  overdueAmount: string;
  maxDaysOverdue: number;
  bookingsCount: number;
  projects: DebtProject[];
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

// ── Helpers ───────────────────────────────────────────────────────────────────

type AgingBucket = "overdue30" | "overdue7" | "soon" | "current";

function getAgingBucket(maxDaysOverdue: number, projects: DebtProject[]): AgingBucket {
  if (maxDaysOverdue > 30) return "overdue30";
  if (maxDaysOverdue > 0) return "overdue7";
  // Check if any project has payment due within 7 days
  const now = Date.now();
  for (const p of projects) {
    if (!p.expectedPaymentDate) continue;
    const diff = Math.ceil((new Date(p.expectedPaymentDate).getTime() - now) / 86400000);
    if (diff >= 0 && diff <= 7) return "soon";
  }
  return "current";
}

function agePillFromDays(days: number | null, projects: DebtProject[]) {
  if (days !== null && days > 30)
    return { label: `${days} дней`, cls: "bg-rose-soft text-rose border border-rose-border" };
  if (days !== null && days > 0)
    return { label: `${days} дней`, cls: "bg-rose-soft text-rose border border-rose-border" };
  const now = Date.now();
  for (const p of projects) {
    if (!p.expectedPaymentDate) continue;
    const diff = Math.ceil((new Date(p.expectedPaymentDate).getTime() - now) / 86400000);
    if (diff >= 0 && diff <= 7)
      return { label: `Через ${diff} дн.`, cls: "bg-amber-soft text-amber border border-amber-border" };
  }
  return { label: "По графику", cls: "bg-emerald-soft text-emerald border border-emerald-border" };
}

function formatPayDate(dateStr: string | null): string {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
}

function computeAgingCounts(debts: ClientDebt[]) {
  const counts = { overdue30: 0, overdue7: 0, soon: 0, current: 0 };
  const totals = { overdue30: 0, overdue7: 0, soon: 0, current: 0 };
  for (const d of debts) {
    const bucket = getAgingBucket(d.maxDaysOverdue, d.projects);
    counts[bucket]++;
    totals[bucket] += Number(d.totalOutstanding);
  }
  return { counts, totals };
}

const STRIPE_CLASSES: Record<AgingBucket, string> = {
  overdue30: "border-l-rose",
  overdue7: "border-l-rose/70",
  soon: "border-l-amber",
  current: "border-l-emerald",
};

// ── Main page ─────────────────────────────────────────────────────────────────

export default function DebtsPage() {
  const { authorized, loading } = useRequireRole(ALLOWED);
  const [data, setData] = useState<DebtsResponse | null>(null);
  const [search, setSearch] = useState("");
  const [activeFilter, setActiveFilter] = useState<"all" | AgingBucket>("all");
  const [fetching, setFetching] = useState(false);

  useEffect(() => {
    if (!authorized) return;
    let cancelled = false;
    setFetching(true);
    apiFetch<DebtsResponse>("/api/finance/debts")
      .then((d) => { if (!cancelled) setData(d); })
      .finally(() => { if (!cancelled) setFetching(false); });
    return () => { cancelled = true; };
  }, [authorized]);

  if (loading || !authorized) return null;
  if (!data && fetching) return <div className="p-8 text-ink-3 text-sm">Загрузка…</div>;

  const { counts, totals } = data ? computeAgingCounts(data.debts) : { counts: { overdue30: 0, overdue7: 0, soon: 0, current: 0 }, totals: { overdue30: 0, overdue7: 0, soon: 0, current: 0 } };

  const overdueCount = (counts.overdue30 ?? 0) + (counts.overdue7 ?? 0);

  // Filter + search
  const filtered = (data?.debts ?? []).filter((d) => {
    const bucket = getAgingBucket(d.maxDaysOverdue, d.projects);
    const matchFilter = activeFilter === "all" || bucket === activeFilter;
    const q = search.toLowerCase();
    const matchSearch =
      !q ||
      d.clientName.toLowerCase().includes(q) ||
      d.projects.some((p) => p.projectName.toLowerCase().includes(q));
    return matchFilter && matchSearch;
  });

  const debtCount = data?.summary.totalClients ?? data?.debts.length ?? 0;

  return (
    <div className="pb-10">
      <FinanceTabNav debtCount={debtCount} />

      <div className="px-7 py-5">
        {/* Header */}
        <div className="flex justify-between items-end mb-4 pb-3.5 border-b border-border">
          <div>
            <h1 className="text-[22px] font-semibold text-ink tracking-tight">Должники</h1>
            <p className="text-xs text-ink-2 mt-0.5">
              Итого задолженность:{" "}
              <strong className="mono-num text-rose">{data ? formatRub(data.summary.totalOutstanding) : "—"}</strong>
              {" · "}{debtCount} клиентов
              {" · "}{overdueCount} с просрочкой
            </p>
          </div>
          <div className="flex gap-2">
            <button className="px-3.5 py-1.5 text-xs font-medium border border-border-strong bg-surface rounded hover:bg-surface-subtle">
              Экспорт в XLSX
            </button>
            <button className="px-3.5 py-1.5 text-xs font-medium bg-accent text-white rounded border border-accent hover:bg-accent-bright">
              Отправить напоминания ({overdueCount})
            </button>
          </div>
        </div>

        {/* Aging buckets */}
        <div className="grid grid-cols-4 gap-px mb-5 bg-border border border-border rounded-[6px] overflow-hidden">
          <div className="bg-rose-soft px-4 py-3.5">
            <p className="eyebrow text-rose mb-1.5">Просрочка &gt; 30 дней</p>
            <p className="mono-num text-[16px] font-semibold text-rose">{formatRub(totals.overdue30)}</p>
            <p className="text-[11.5px] text-ink-2 mt-0.5">{counts.overdue30} клиент</p>
          </div>
          <div className="bg-rose-soft/50 px-4 py-3.5">
            <p className="eyebrow text-ink-3 mb-1.5">Просрочка 1–30 дней</p>
            <p className="mono-num text-[16px] font-semibold text-ink">{formatRub(totals.overdue7)}</p>
            <p className="text-[11.5px] text-ink-2 mt-0.5">{counts.overdue7} клиентов</p>
          </div>
          <div className="bg-amber-soft px-4 py-3.5">
            <p className="eyebrow text-amber mb-1.5">Срок через 1–7 дней</p>
            <p className="mono-num text-[16px] font-semibold text-ink">{formatRub(totals.soon)}</p>
            <p className="text-[11.5px] text-ink-2 mt-0.5">{counts.soon} клиентов</p>
          </div>
          <div className="bg-surface px-4 py-3.5">
            <p className="eyebrow text-ink-2 mb-1.5">В пределах графика</p>
            <p className="mono-num text-[16px] font-semibold text-ink">{formatRub(totals.current)}</p>
            <p className="text-[11.5px] text-ink-2 mt-0.5">{counts.current} клиентов</p>
          </div>
        </div>

        {/* Table panel */}
        <div className="bg-surface border border-border rounded-[6px] overflow-hidden shadow-xs">
          {/* Filter bar */}
          <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-surface-subtle flex-wrap">
            {([
              { key: "all", label: "Все", count: data?.debts.length ?? 0 },
              { key: "overdue30", label: "Просрочка 30+", count: counts.overdue30, cls: "border-rose-border text-rose" },
              { key: "overdue7", label: "Просрочка", count: counts.overdue7, cls: "border-rose-border text-rose" },
              { key: "soon", label: "Скоро", count: counts.soon, cls: "border-amber-border text-amber" },
              { key: "current", label: "По графику", count: counts.current },
            ] as { key: string; label: string; count: number; cls?: string }[]).map((f) => (
              <button
                key={f.key}
                onClick={() => setActiveFilter(f.key as "all" | AgingBucket)}
                className={`border rounded-full px-3 py-1 text-[11.5px] font-medium transition-colors ${
                  activeFilter === f.key
                    ? "bg-accent text-white border-accent"
                    : `bg-surface ${f.cls ?? "border-border text-ink-2"} hover:bg-surface-subtle`
                }`}
              >
                {f.label}{" "}
                <span className="opacity-70 mono-num">{f.count}</span>
              </button>
            ))}
            <div className="flex-1" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск по клиенту или броне"
              className="bg-surface border border-border rounded px-2.5 py-1 text-xs text-ink-2 min-w-[180px]"
            />
            <button className="border border-border bg-transparent rounded px-2 py-1 text-xs text-ink-2 hover:bg-surface-subtle">
              ⇅ Сортировка
            </button>
          </div>

          {/* Table */}
          <table className="w-full text-[12.5px] border-collapse">
            <thead>
              <tr>
                <th className="w-1 p-0" />
                <th className="text-left px-3.5 py-2.5 bg-surface-subtle border-b border-border eyebrow" style={{ width: "28%" }}>Клиент</th>
                <th className="text-left px-3.5 py-2.5 bg-surface-subtle border-b border-border eyebrow">Бронь</th>
                <th className="text-right px-3.5 py-2.5 bg-surface-subtle border-b border-border eyebrow">Должен</th>
                <th className="px-3.5 py-2.5 bg-surface-subtle border-b border-border eyebrow" style={{ width: "15%" }}>Срок оплаты</th>
                <th className="px-3.5 py-2.5 bg-surface-subtle border-b border-border eyebrow" style={{ width: "15%" }}>Статус</th>
                <th className="text-right px-3.5 py-2.5 bg-surface-subtle border-b border-border eyebrow" style={{ width: "14%" }}>Действия</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((d) => {
                const bucket = getAgingBucket(d.maxDaysOverdue, d.projects);
                const pill = agePillFromDays(d.maxDaysOverdue, d.projects);
                const isOverdue = bucket === "overdue30" || bucket === "overdue7";
                const isSoon = bucket === "soon";
                const firstProject = d.projects[0];
                const payDate = firstProject?.expectedPaymentDate ?? null;

                return (
                  <tr key={d.clientId} className="border-b border-border hover:bg-surface-subtle cursor-pointer">
                    <td className={`w-1 p-0 border-l-[3px] ${STRIPE_CLASSES[bucket]}`} />
                    <td className="px-3.5 py-3 align-middle">
                      <p className="font-medium text-ink">{d.clientName}</p>
                      <p className="text-[11px] text-ink-2 mt-0.5">
                        {d.bookingsCount} {d.bookingsCount === 1 ? "бронь" : "броней"}
                      </p>
                    </td>
                    <td className="px-3.5 py-3 align-middle">
                      {firstProject ? (
                        <>
                          <p className="text-ink">{firstProject.projectName}</p>
                          {d.projects.length > 1 && (
                            <p className="text-[11px] text-ink-2 mt-0.5">+{d.projects.length - 1} ещё</p>
                          )}
                        </>
                      ) : (
                        <span className="text-ink-3">—</span>
                      )}
                    </td>
                    <td className={`px-3.5 py-3 text-right mono-num font-semibold align-middle ${isOverdue ? "text-rose" : isSoon ? "text-amber" : "text-ink"}`}>
                      {formatRub(d.totalOutstanding)}
                    </td>
                    <td className="px-3.5 py-3 align-middle mono-num text-ink-2">
                      {formatPayDate(payDate)}
                    </td>
                    <td className="px-3.5 py-3 align-middle">
                      <span
                        className={`text-[10.5px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-[0.04em] ${pill.cls}`}
                        style={{ fontFamily: "IBM Plex Sans Condensed, sans-serif" }}
                      >
                        {pill.label}
                      </span>
                    </td>
                    <td className="px-3.5 py-3 text-right align-middle">
                      <div className="flex gap-1.5 justify-end">
                        {isOverdue && (
                          <>
                            <button aria-label="Отправить напоминание" className="w-[26px] h-[26px] rounded border border-border bg-surface flex items-center justify-center text-ink-2 hover:bg-surface-subtle text-sm">
                              ✉
                            </button>
                            <button aria-label="Позвонить" className="w-[26px] h-[26px] rounded border border-border bg-surface flex items-center justify-center text-ink-2 hover:bg-surface-subtle text-sm">
                              ☎
                            </button>
                          </>
                        )}
                        <a
                          href={`/bookings?clientId=${d.clientId}`}
                          aria-label="Открыть"
                          className="w-[26px] h-[26px] rounded border border-border bg-surface flex items-center justify-center text-ink-2 hover:bg-surface-subtle text-sm font-medium"
                        >
                          ›
                        </a>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-ink-3 text-sm">
                    {data?.debts.length === 0 ? "Нет задолженностей" : "Нет результатов по фильтру"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {data?.summary && (
            <div className="px-4 py-3 border-t border-border bg-surface-subtle flex justify-between text-xs text-ink-2">
              <span>{data.summary.totalClients} клиентов</span>
              <span className="mono-num font-medium text-ink">{formatRub(data.summary.totalOutstanding)}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
