"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useRequireRole } from "../../src/hooks/useRequireRole";
import { useCurrentUser } from "../../src/hooks/useCurrentUser";
import { apiFetch } from "../../src/lib/api";
import { formatRub } from "../../src/lib/format";
import { FinanceTabNav } from "../../src/components/finance/FinanceTabNav";
import { ForecastWidget } from "../../src/components/finance/ForecastWidget";
import { derivePeriodRange, PERIOD_LABELS, PERIOD_OPTIONS, type PeriodKey } from "../../src/lib/periodUtils";
import { StatusPill } from "../../src/components/StatusPill";
import type { UserRole } from "../../src/lib/auth";
import { RecordPaymentModal } from "../../src/components/finance/RecordPaymentModal";
import { CreateInvoiceModal } from "../../src/components/finance/CreateInvoiceModal";

const ALLOWED: UserRole[] = ["SUPER_ADMIN", "WAREHOUSE"];

// ── Types ─────────────────────────────────────────────────────────────────────

interface TrendEntry {
  month: string;
  earned: string;
  spent: string;
  net: string;
}

interface UpcomingEntry {
  bookingId: string;
  projectName: string;
  clientName: string;
  amountOutstanding: string;
  expectedPaymentDate: string | null;
}

interface TopDebtor {
  clientId: string;
  clientName: string;
  outstanding: string;
  overdueDays: number | null;
  bookingsCount?: number;
  projectName?: string;
}

interface Dashboard {
  asOf: string;
  totalOutstanding: string;
  earnedThisMonth: string;
  spentThisMonth: string;
  netThisMonth: string;
  upcomingWeek: UpcomingEntry[];
  trend: TrendEntry[];
  topDebtors: TopDebtor[];
  summary: {
    totalReceivables: string;
    overdueReceivables: string;
  };
}

interface DebtsResponse {
  debts: { clientId: string }[];
  summary: { totalClients: number; totalOutstanding: string };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function debtorStatusVariant(overdueDays: number | null): "alert" | "warn" | "info" {
  if (overdueDays !== null && overdueDays > 7) return "alert";
  if (overdueDays !== null && overdueDays > 0) return "warn";
  return "info";
}

function debtorStatusLabel(overdueDays: number | null): string {
  if (overdueDays !== null && overdueDays > 0) return "Просрочен";
  return "Выставлен";
}

function formatEventDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" }) +
    ", " +
    d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

// ── Activity feed entry (local type for mockup rendering) ─────────────────────

interface ActivityEntry {
  icon: string;
  amount?: string;
  amountType?: "in" | "out";
  text: string;
  sub: string;
}

// ── KPI card ─────────────────────────────────────────────────────────────────

function KpiCard({
  eyebrow,
  value,
  delta,
  variant,
  href,
  sparkPoints,
}: {
  eyebrow: string;
  value: string;
  delta?: string;
  variant?: "ok" | "alert" | "default";
  href?: string;
  sparkPoints?: string;
}) {
  const borderColor =
    variant === "ok" ? "border-emerald" : variant === "alert" ? "border-rose" : "border-border";
  const bgColor =
    variant === "ok" ? "bg-emerald-soft/20" : variant === "alert" ? "bg-rose-soft/30" : "bg-surface";
  const valueColor =
    variant === "ok" ? "text-emerald" : variant === "alert" ? "text-rose" : "text-ink";
  const sparkColor =
    variant === "ok" ? "#047857" : variant === "alert" ? "#9f1239" : "#52525b";

  const inner = (
    <div className={`relative border ${borderColor} ${bgColor} rounded-lg px-5 pt-4 pb-4 overflow-hidden shadow-xs h-full`}>
      <p className="eyebrow mb-2">{eyebrow}</p>
      <p className={`mono-num text-[22px] font-semibold ${valueColor} leading-tight`}>{value}</p>
      {delta && <p className="text-[11.5px] text-ink-2 mt-1.5">{delta}</p>}
      {sparkPoints && (
        <svg viewBox="0 0 120 28" preserveAspectRatio="none" className="w-full h-7 mt-2">
          <polyline
            fill="none"
            stroke={sparkColor}
            strokeWidth="1.5"
            points={sparkPoints}
          />
        </svg>
      )}
    </div>
  );

  if (href) {
    return <Link href={href} className="block hover:opacity-90 transition-opacity h-full">{inner}</Link>;
  }
  return inner;
}

// ── Main page ─────────────────────────────────────────────────────────────────

function FinancePageInner() {
  const { authorized, loading } = useRequireRole(ALLOWED);
  const { user } = useCurrentUser();
  const isSA = user?.role === "SUPER_ADMIN";
  const router = useRouter();
  const searchParams = useSearchParams();
  const [data, setData] = useState<Dashboard | null>(null);
  const [debtCount, setDebtCount] = useState<number | undefined>(undefined);
  const [dataError, setDataError] = useState<string | null>(null);
  const [period, setPeriod] = useState<PeriodKey>(
    (searchParams.get("period") as PeriodKey | null) ?? "month"
  );
  const [recordPaymentOpen, setRecordPaymentOpen] = useState(false);
  const [createInvoiceOpen, setCreateInvoiceOpen] = useState(false);

  function handlePeriodChange(p: PeriodKey) {
    setPeriod(p);
    const params = new URLSearchParams(searchParams.toString());
    params.set("period", p);
    router.replace(`?${params.toString()}`, { scroll: false });
  }

  useEffect(() => {
    if (!authorized) return;
    let cancelled = false;
    const range = derivePeriodRange(period);
    (async () => {
      try {
        const [dash, debts] = await Promise.all([
          apiFetch<Dashboard>(`/api/finance/dashboard?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`),
          apiFetch<DebtsResponse>("/api/finance/debts"),
        ]);
        if (!cancelled) {
          setData(dash);
          setDebtCount(debts.summary?.totalClients ?? debts.debts?.length ?? 0);
        }
      } catch (e: unknown) {
        if (!cancelled) setDataError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [authorized, period]);

  if (loading || !authorized) return null;
  if (dataError) return <div className="p-8 text-rose text-sm">Ошибка: {dataError}</div>;
  if (!data) return <div className="p-8 text-ink-3 text-sm">Загрузка…</div>;

  const net = Number(data.netThisMonth);
  const earned = Number(data.earnedThisMonth);
  const spent = Number(data.spentThisMonth);
  const outstanding = Number(data.totalOutstanding);

  const overdueCount = data.topDebtors.filter(
    (d) => d.overdueDays !== null && d.overdueDays > 0
  ).length;

  const margin = earned > 0 ? Math.round((net / earned) * 100) : 0;

  return (
    <div className="pb-10 bg-surface-subtle min-h-screen">
      <FinanceTabNav debtCount={debtCount} />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-5">

        {/* Header: eyebrow + title + period + actions */}
        <div className="mb-5">
          <p className="eyebrow text-ink-3">Финансы</p>
          <div className="flex items-center justify-between gap-3 flex-wrap mt-1">
            <h1 className="text-[22px] font-semibold text-ink tracking-tight">Сводка по деньгам</h1>
            <div className="flex items-center gap-2 flex-wrap">
              {/* Period pills */}
              <div className="flex items-center gap-1 bg-surface border border-border rounded-lg p-1 overflow-x-auto flex-nowrap">
                {PERIOD_OPTIONS.map((key) => (
                  <button
                    key={key}
                    onClick={() => handlePeriodChange(key)}
                    className={`px-3 py-1.5 text-[12px] font-medium rounded transition-colors whitespace-nowrap ${
                      period === key
                        ? "bg-accent-bright text-white shadow-xs"
                        : "text-ink-2 hover:text-ink"
                    }`}
                  >
                    {PERIOD_LABELS[key]}
                  </button>
                ))}
              </div>
              <button
                onClick={() => setRecordPaymentOpen(true)}
                className="px-3.5 py-2 text-[12px] font-semibold bg-accent-bright text-white rounded-lg hover:opacity-90 transition-opacity whitespace-nowrap"
              >
                + Записать платёж
              </button>
              {isSA && (
                <button
                  onClick={() => setCreateInvoiceOpen(true)}
                  className="px-3.5 py-2 text-[12px] font-medium border border-border bg-surface text-ink rounded-lg hover:bg-surface-subtle transition-colors whitespace-nowrap"
                >
                  + Создать счёт
                </button>
              )}
            </div>
          </div>
        </div>

        {/* KPI strip — 4 cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5 mb-5">
          <KpiCard
            eyebrow="Получено"
            value={formatRub(earned)}
            delta={`${net >= 0 ? "+" : ""}${margin}% маржа за период`}
            variant="ok"
            href={`/finance/payments?period=${period}`}
            sparkPoints="0,22 12,18 24,20 36,14 48,16 60,10 72,12 84,7 96,9 108,5 120,3"
          />
          <KpiCard
            eyebrow="Расходы"
            value={`−${formatRub(spent)}`}
            delta="операции за период"
            variant="default"
            href={`/finance/expenses?period=${period}`}
            sparkPoints="0,18 12,16 24,20 36,18 48,14 60,16 72,12 84,16 96,11 108,14 120,12"
          />
          <KpiCard
            eyebrow="Задолженность"
            value={formatRub(outstanding)}
            delta={`${overdueCount} клиент${overdueCount === 1 ? "" : "а"} просрочены`}
            variant="alert"
            href="/finance/debts"
            sparkPoints="0,16 12,17 24,15 36,18 48,16 60,19 72,17 84,21 96,19 108,22 120,20"
          />
          <KpiCard
            eyebrow="Прибыль (период)"
            value={formatRub(Math.abs(net))}
            delta={`маржа ${margin}%`}
            variant={net >= 0 ? "ok" : "alert"}
            sparkPoints="0,20 12,17 24,18 36,12 48,14 60,9 72,11 84,5 96,8 108,4 120,2"
          />
        </div>

        {/* Action ribbon — SA only, hidden when no actions */}
        {isSA && overdueCount > 0 && (
          <div className="mb-4 px-4 py-2.5 rounded-lg border border-amber-border bg-amber-soft flex items-center gap-3 text-[13px] flex-wrap">
            <span className="text-amber">⚡ Сегодня сделать:</span>
            <span className="text-ink">
              {overdueCount > 0 && (
                <><Link href="/finance/invoices?status=OVERDUE" className="text-amber font-semibold hover:underline">{overdueCount} {overdueCount === 1 ? "счёт просрочен" : "счёта просрочены"} ≥ 7 дней</Link></>
              )}
            </span>
            <Link href="/finance/invoices?status=OVERDUE" className="ml-auto px-3 py-1 text-[12px] font-medium border border-amber-border rounded-lg text-amber hover:bg-amber-border/20 whitespace-nowrap">
              Открыть →
            </Link>
          </div>
        )}

        {/* Forecast widget — SA only */}
        {isSA && <ForecastWidget months={6} />}

        {/* Two-column layout: top debtors + activity feed — SA only */}
        {isSA && <div className="grid gap-4 mt-4" style={{ gridTemplateColumns: "1.3fr 1fr" }}>

          {/* Top debtors panel */}
          <div className="bg-surface border border-border rounded-lg overflow-hidden shadow-xs">
            <div className="flex justify-between items-center px-4 py-3.5 border-b border-border">
              <h3 className="text-[13.5px] font-semibold text-ink">Топ-должники</h3>
              <Link href="/finance/debts" className="text-xs text-accent-bright font-medium hover:underline">
                Все долги →
              </Link>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="border-b border-border bg-surface-subtle">
                    <th className="text-left px-4 py-2.5 eyebrow">Клиент</th>
                    <th className="text-right px-3 py-2.5 eyebrow">Сумма</th>
                    <th className="text-right px-3 py-2.5 eyebrow">Просрочка</th>
                    <th className="px-3 py-2.5 eyebrow">Статус</th>
                    <th className="w-20 px-3 py-2.5"></th>
                  </tr>
                </thead>
                <tbody>
                  {data.topDebtors.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-8 text-center text-sm text-ink-3">Нет задолженностей</td>
                    </tr>
                  ) : (
                    data.topDebtors.map((d) => (
                      <tr key={d.clientId} className="border-b border-slate-soft last:border-0 hover:bg-surface-subtle/50 transition-colors">
                        <td className="px-4 py-3">
                          <strong className="text-ink font-medium">{d.clientName}</strong>
                          {d.projectName && (
                            <div className="text-[11px] text-ink-3 mt-0.5 truncate max-w-[180px]">{d.projectName}</div>
                          )}
                        </td>
                        <td className="px-3 py-3 text-right mono-num font-medium">{formatRub(d.outstanding)}</td>
                        <td className="px-3 py-3 text-right mono-num text-ink-2">
                          {d.overdueDays !== null && d.overdueDays > 0
                            ? `${d.overdueDays} дн.`
                            : "—"}
                        </td>
                        <td className="px-3 py-3">
                          <StatusPill
                            variant={debtorStatusVariant(d.overdueDays)}
                            label={debtorStatusLabel(d.overdueDays)}
                          />
                        </td>
                        <td className="px-3 py-3">
                          <button
                            onClick={() => setRecordPaymentOpen(true)}
                            className="px-2.5 py-1 text-[11px] border border-border bg-surface rounded hover:border-accent-bright hover:text-accent-bright transition-colors whitespace-nowrap"
                          >
                            ₽ Платёж
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Activity feed panel */}
          <div className="bg-surface border border-border rounded-lg overflow-hidden shadow-xs">
            <div className="flex justify-between items-center px-4 py-3.5 border-b border-border">
              <h3 className="text-[13.5px] font-semibold text-ink">Ожидаемые поступления</h3>
              <span className="text-[11.5px] text-ink-3">ближайшие 7 дней</span>
            </div>
            <div className="px-4 py-3 flex flex-col gap-3.5">
              {data.upcomingWeek.length === 0 ? (
                <p className="text-sm text-ink-3 py-4 text-center">Нет ожидаемых поступлений на этой неделе</p>
              ) : (
                data.upcomingWeek.slice(0, 6).map((u) => (
                  <div key={u.bookingId} className="flex gap-2.5 text-[12.5px]">
                    <span className="text-base mt-0.5">💰</span>
                    <div>
                      <div>
                        <strong className="text-emerald">+{formatRub(u.amountOutstanding)}</strong>
                        {" · "}
                        <span className="text-ink">{u.clientName}</span>
                      </div>
                      <div className="text-[11px] text-ink-3 mt-0.5">
                        {u.projectName}
                        {u.expectedPaymentDate && (
                          <> · срок {new Date(u.expectedPaymentDate).toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}</>
                        )}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>}

        {/* Mobile KPI (visible md:hidden) */}
        <div className="md:hidden mt-5">
          <p className="eyebrow text-ink-3 mb-3">Итог за период</p>
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-emerald-soft/30 border border-emerald-border rounded-lg p-3">
              <p className="eyebrow">Получено</p>
              <p className="mono-num text-[18px] font-semibold text-emerald mt-1">{formatRub(earned)}</p>
            </div>
            <div className="bg-rose-soft/30 border border-rose-border rounded-lg p-3">
              <p className="eyebrow">Долги</p>
              <p className="mono-num text-[18px] font-semibold text-rose mt-1">{formatRub(outstanding)}</p>
            </div>
            <div className="bg-surface border border-border rounded-lg p-3">
              <p className="eyebrow">Расходы</p>
              <p className="mono-num text-[18px] font-semibold text-ink mt-1">−{formatRub(spent)}</p>
            </div>
            <div className="bg-emerald-soft/20 border border-emerald-border rounded-lg p-3">
              <p className="eyebrow">Прибыль</p>
              <p className="mono-num text-[18px] font-semibold text-emerald mt-1">{formatRub(Math.abs(net))}</p>
            </div>
          </div>
        </div>

      </div>

      <RecordPaymentModal
        open={recordPaymentOpen}
        onClose={() => setRecordPaymentOpen(false)}
        onCreated={() => setRecordPaymentOpen(false)}
      />
      <CreateInvoiceModal
        open={createInvoiceOpen}
        onClose={() => setCreateInvoiceOpen(false)}
        onCreated={() => setCreateInvoiceOpen(false)}
      />
    </div>
  );
}

export default function FinancePage() {
  return (
    <Suspense fallback={<div className="p-8 text-ink-3 text-sm">Загрузка…</div>}>
      <FinancePageInner />
    </Suspense>
  );
}
