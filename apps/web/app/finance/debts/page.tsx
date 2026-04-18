"use client";

import React, { useEffect, useState } from "react";
import { useRequireRole } from "../../../src/hooks/useRequireRole";
import { useCurrentUser } from "../../../src/hooks/useCurrentUser";
import { apiFetch } from "../../../src/lib/api";
import { formatRub, pluralize } from "../../../src/lib/format";
import { FinanceTabNav } from "../../../src/components/finance/FinanceTabNav";
import { LegacyBookingImportModal } from "../../../src/components/finance/LegacyBookingImportModal";
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
  const now = Date.now();
  for (const p of projects) {
    if (!p.expectedPaymentDate) continue;
    const diff = Math.ceil((new Date(p.expectedPaymentDate).getTime() - now) / 86400000);
    if (diff >= 0 && diff <= 7) return "soon";
  }
  return "current";
}

function agePillFromDays(days: number | null, projects: DebtProject[]) {
  if (days !== null && days > 0)
    return {
      label: `Просрочка ${days} ${pluralize(days, "день", "дня", "дней")}`,
      cls: "bg-rose-soft text-rose border-rose-border",
    };
  const now = Date.now();
  for (const p of projects) {
    if (!p.expectedPaymentDate) continue;
    const diff = Math.ceil((new Date(p.expectedPaymentDate).getTime() - now) / 86400000);
    if (diff >= 0 && diff <= 7)
      return {
        label: `Через ${diff} ${pluralize(diff, "день", "дня", "дней")}`,
        cls: "bg-amber-soft text-amber border-amber-border",
      };
  }
  return { label: "По графику", cls: "bg-emerald-soft text-emerald border-emerald-border" };
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

const AVATAR_PALETTE = [
  "bg-emerald-soft text-emerald",
  "bg-accent-soft text-accent-bright",
  "bg-amber-soft text-amber",
  "bg-rose-soft text-rose",
  "bg-teal-soft text-teal",
  "bg-indigo-soft text-indigo",
] as const;

function avatarClasses(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
}

function avatarLetter(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed[0].toUpperCase() : "?";
}

function latestPayDate(projects: DebtProject[]): string | null {
  let latest: number | null = null;
  for (const p of projects) {
    if (!p.expectedPaymentDate) continue;
    const t = new Date(p.expectedPaymentDate).getTime();
    if (latest === null || t > latest) latest = t;
  }
  return latest === null ? null : new Date(latest).toISOString();
}

function sortedProjects(projects: DebtProject[]): DebtProject[] {
  return [...projects].sort((a, b) => {
    const aOver = a.daysOverdue ?? -1;
    const bOver = b.daysOverdue ?? -1;
    if (bOver !== aOver) return bOver - aOver;
    const aAmt = Number(a.amountOutstanding);
    const bAmt = Number(b.amountOutstanding);
    return bAmt - aAmt;
  });
}

function projectDateLabel(p: DebtProject): { text: string; tone: "rose" | "amber" | "ink-3" } {
  if (p.daysOverdue !== null && p.daysOverdue > 0) {
    return {
      text: `${formatPayDate(p.expectedPaymentDate)} · просрочено ${p.daysOverdue} ${pluralize(p.daysOverdue, "день", "дня", "дней")}`,
      tone: "rose",
    };
  }
  if (p.expectedPaymentDate) {
    const diff = Math.ceil((new Date(p.expectedPaymentDate).getTime() - Date.now()) / 86400000);
    if (diff >= 0 && diff <= 7) {
      return {
        text: `${formatPayDate(p.expectedPaymentDate)} · через ${diff} ${pluralize(diff, "день", "дня", "дней")}`,
        tone: "amber",
      };
    }
    return { text: formatPayDate(p.expectedPaymentDate), tone: "ink-3" };
  }
  return { text: "Срок не задан", tone: "ink-3" };
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function DebtsPage() {
  const { authorized, loading } = useRequireRole(ALLOWED);
  const currentUser = useCurrentUser();
  const [data, setData] = useState<DebtsResponse | null>(null);
  const [search, setSearch] = useState("");
  const [activeFilter, setActiveFilter] = useState<"all" | AgingBucket>("all");
  const [fetching, setFetching] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function loadDebts() {
    let cancelled = false;
    setFetching(true);
    apiFetch<DebtsResponse>("/api/finance/debts")
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

  const { counts, totals } = data
    ? computeAgingCounts(data.debts)
    : { counts: { overdue30: 0, overdue7: 0, soon: 0, current: 0 }, totals: { overdue30: 0, overdue7: 0, soon: 0, current: 0 } };

  const overdueCount = (counts.overdue30 ?? 0) + (counts.overdue7 ?? 0);

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
              {" · "}{debtCount} {pluralize(debtCount, "клиент", "клиента", "клиентов")}
              {" · "}{overdueCount} с просрочкой
            </p>
          </div>
          <div className="flex gap-2">
            {currentUser?.user?.role === "SUPER_ADMIN" && (
              <button
                type="button"
                onClick={() => setImportOpen(true)}
                className="px-3.5 py-1.5 text-xs font-medium rounded border border-accent-border bg-accent-soft text-accent-bright hover:bg-accent-border"
              >
                + Импортировать смету
              </button>
            )}
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
            <p className="text-[11.5px] text-ink-2 mt-0.5">
              {counts.overdue30} {pluralize(counts.overdue30, "клиент", "клиента", "клиентов")}
            </p>
          </div>
          <div className="bg-rose-soft/50 px-4 py-3.5">
            <p className="eyebrow text-ink-3 mb-1.5">Просрочка 1–30 дней</p>
            <p className="mono-num text-[16px] font-semibold text-ink">{formatRub(totals.overdue7)}</p>
            <p className="text-[11.5px] text-ink-2 mt-0.5">
              {counts.overdue7} {pluralize(counts.overdue7, "клиент", "клиента", "клиентов")}
            </p>
          </div>
          <div className="bg-amber-soft px-4 py-3.5">
            <p className="eyebrow text-amber mb-1.5">Срок через 1–7 дней</p>
            <p className="mono-num text-[16px] font-semibold text-ink">{formatRub(totals.soon)}</p>
            <p className="text-[11.5px] text-ink-2 mt-0.5">
              {counts.soon} {pluralize(counts.soon, "клиент", "клиента", "клиентов")}
            </p>
          </div>
          <div className="bg-surface px-4 py-3.5">
            <p className="eyebrow text-ink-2 mb-1.5">В пределах графика</p>
            <p className="mono-num text-[16px] font-semibold text-ink">{formatRub(totals.current)}</p>
            <p className="text-[11.5px] text-ink-2 mt-0.5">
              {counts.current} {pluralize(counts.current, "клиент", "клиента", "клиентов")}
            </p>
          </div>
        </div>

        {/* Filter bar */}
        <div className="flex items-center gap-2 px-4 py-3 border border-border bg-surface-subtle rounded-[6px] mb-3 flex-wrap">
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
            placeholder="Поиск по клиенту или проекту"
            className="bg-surface border border-border rounded px-2.5 py-1 text-xs text-ink-2 min-w-[200px]"
          />
        </div>

        {/* Cards list */}
        {filtered.length === 0 ? (
          <div className="bg-surface border border-border rounded-[8px] px-4 py-10 text-center text-ink-3 text-sm">
            {data?.debts.length === 0 ? "Нет задолженностей" : "Нет результатов по фильтру"}
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {filtered.map((d) => {
              const isOpen = expanded.has(d.clientId);
              const pill = agePillFromDays(d.maxDaysOverdue, d.projects);
              const bucket = getAgingBucket(d.maxDaysOverdue, d.projects);
              const isOverdue = bucket === "overdue30" || bucket === "overdue7";
              const isSoon = bucket === "soon";
              const amountTone = isOverdue ? "text-rose" : isSoon ? "text-amber" : "text-ink";
              const lastDate = latestPayDate(d.projects);
              const projects = sortedProjects(d.projects);

              return (
                <div
                  key={d.clientId}
                  className={`bg-surface border rounded-[10px] overflow-hidden transition-shadow ${
                    isOpen ? "border-accent-border shadow-sm" : "border-border"
                  }`}
                >
                  {/* Card head — clickable */}
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    onClick={() => toggle(d.clientId)}
                    className={`w-full grid items-center gap-4 px-4 sm:px-5 py-3.5 text-left ${
                      isOpen
                        ? "bg-accent-soft border-b border-accent-border"
                        : "hover:bg-surface-subtle"
                    }`}
                    style={{ gridTemplateColumns: "18px minmax(0,1fr) auto auto auto" }}
                  >
                    {/* caret */}
                    <span
                      aria-hidden
                      className={`inline-block text-ink-3 mono-num text-[12px] transition-transform ${
                        isOpen ? "rotate-90 text-ink-2" : ""
                      }`}
                    >
                      ▸
                    </span>

                    {/* Avatar + name */}
                    <div className="flex items-center gap-3 min-w-0">
                      <span
                        className={`inline-flex items-center justify-center w-8 h-8 rounded-full text-[13px] font-semibold flex-shrink-0 ${avatarClasses(d.clientId || d.clientName)}`}
                      >
                        {avatarLetter(d.clientName)}
                      </span>
                      <div className="min-w-0">
                        <div className="text-[14px] font-semibold text-ink truncate">{d.clientName}</div>
                        <div className="text-[11.5px] text-ink-2 mt-0.5">
                          {d.bookingsCount} {pluralize(d.bookingsCount, "проект", "проекта", "проектов")}
                          {lastDate ? ` · последний срок ${formatPayDate(lastDate)}` : ""}
                        </div>
                      </div>
                    </div>

                    {/* Age chip */}
                    <span
                      className={`text-[10.5px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-[0.04em] border whitespace-nowrap ${pill.cls}`}
                      style={{ fontFamily: "IBM Plex Sans Condensed, sans-serif" }}
                    >
                      {pill.label}
                    </span>

                    {/* Amount */}
                    <div className="text-right">
                      <div className={`mono-num text-[16px] font-semibold ${amountTone}`}>
                        {formatRub(d.totalOutstanding)}
                      </div>
                      <div className="text-[11px] text-ink-3">задолженность</div>
                    </div>

                    {/* Actions */}
                    <div
                      className="flex gap-1.5 justify-end"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {isOverdue && (
                        <>
                          <button
                            type="button"
                            aria-label="Отправить напоминание"
                            className="w-[28px] h-[28px] rounded border border-border bg-surface flex items-center justify-center text-ink-2 hover:bg-surface-subtle text-sm"
                          >
                            ✉
                          </button>
                          <button
                            type="button"
                            aria-label="Позвонить"
                            className="w-[28px] h-[28px] rounded border border-border bg-surface flex items-center justify-center text-ink-2 hover:bg-surface-subtle text-sm"
                          >
                            ☎
                          </button>
                        </>
                      )}
                      <a
                        href={`/bookings?clientId=${d.clientId}`}
                        aria-label="Открыть карточку клиента"
                        className="w-[28px] h-[28px] rounded border border-border bg-surface flex items-center justify-center text-ink-2 hover:bg-surface-subtle text-sm font-medium"
                      >
                        ›
                      </a>
                    </div>
                  </button>

                  {/* Card body — projects */}
                  {isOpen && (
                    <div className="bg-surface-subtle pl-[64px] pr-4 sm:pr-5 py-2">
                      {projects.map((p) => {
                        const pDate = projectDateLabel(p);
                        const toneClass =
                          pDate.tone === "rose"
                            ? "text-rose"
                            : pDate.tone === "amber"
                              ? "text-amber"
                              : "text-ink-3";
                        const amtTone =
                          p.daysOverdue !== null && p.daysOverdue > 0 ? "text-rose" : "text-ink";
                        return (
                          <div
                            key={p.bookingId}
                            className="grid items-center gap-4 py-2.5 border-b border-dashed border-border last:border-b-0"
                            style={{ gridTemplateColumns: "minmax(0,1fr) minmax(160px,200px) 140px 32px" }}
                          >
                            <div className="min-w-0">
                              <div className="text-[13px] text-ink truncate">{p.projectName}</div>
                              <div className="text-[11px] text-ink-3 mt-0.5 truncate">
                                Бронь № {p.bookingId.slice(-6)}
                              </div>
                            </div>
                            <div className={`mono-num text-[12px] ${toneClass}`}>{pDate.text}</div>
                            <div className={`text-right mono-num text-[13px] font-semibold ${amtTone}`}>
                              {formatRub(p.amountOutstanding)}
                            </div>
                            <a
                              href={`/bookings/${p.bookingId}`}
                              aria-label="Открыть бронь"
                              className="w-[28px] h-[28px] rounded border border-border bg-surface flex items-center justify-center text-ink-2 hover:bg-surface text-sm font-medium"
                            >
                              ›
                            </a>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {data?.summary && (
          <div className="mt-4 px-4 py-3 border border-border rounded-[6px] bg-surface-subtle flex justify-between text-xs text-ink-2">
            <span>
              {data.summary.totalClients} {pluralize(data.summary.totalClients, "клиент", "клиента", "клиентов")}
            </span>
            <span className="mono-num font-medium text-ink">{formatRub(data.summary.totalOutstanding)}</span>
          </div>
        )}
      </div>
      <LegacyBookingImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => { setImportOpen(false); loadDebts(); }}
      />
    </div>
  );
}
