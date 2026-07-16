"use client";

/**
 * Сводка финансов — «состояние денег за 10 секунд» (редизайн v2, 2026-07).
 *
 * Структура (референсы: QuickBooks Cash Flow, Xero Invoices Owed):
 *  1. KPI за период (Получено нетто с Δ% к прошлому периоду · Расходы · Чистыми)
 *     + Долг (снимок, от периода не зависит).
 *  2. Денежный поток — бары 6 мес на реальных платежах (CashflowChart).
 *  3. Долг по возрасту — кликабельные aging-бакеты по броням (AgingStrip).
 *  4. Требует внимания: топ-должники + ожидаемые поступления 7 дней
 *     (пустые панели скрываются).
 *  5. Прогноз по счетам/броням (ForecastWidget) — скрыт, пока пуст.
 *
 * Бизнес живёт по модели «бронь → долг → платёж» (Invoice на проде не
 * используется), поэтому сводка не зависит от счетов.
 */

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useRequireRole } from "../../src/hooks/useRequireRole";
import { useCurrentUser } from "../../src/hooks/useCurrentUser";
import { apiFetch } from "../../src/lib/api";
import { formatRub, formatExpenseRub, pluralize } from "../../src/lib/format";
import { FinanceTabNav } from "../../src/components/finance/FinanceTabNav";
import { ForecastWidget } from "../../src/components/finance/ForecastWidget";
import { CashflowChart, type TrendEntry } from "../../src/components/finance/CashflowChart";
import { AgingStrip, type AgingData } from "../../src/components/finance/AgingStrip";
import { PeriodSelector } from "../../src/components/finance/PeriodSelector";
import { derivePeriodRange, derivePreviousPeriodRange, PERIOD_LABELS, type PeriodKey } from "../../src/lib/periodUtils";
import { StatusPill } from "../../src/components/StatusPill";
import type { UserRole } from "../../src/lib/auth";
import { RecordPaymentModal } from "../../src/components/finance/RecordPaymentModal";
import { CreateInvoiceModal } from "../../src/components/finance/CreateInvoiceModal";

const ALLOWED: UserRole[] = ["SUPER_ADMIN", "WAREHOUSE"];

// ── Types ─────────────────────────────────────────────────────────────────────

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
  overdueClientsCount: number;
  debtorClientsCount: number;
  aging: AgingData;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Δ% к прошлому периоду: "+18%" / "−7%" / null (нет базы для сравнения). */
function deltaPercent(current: number, previous: number | null): string | null {
  if (previous === null || previous <= 0) return null;
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return "как в прошлом";
  return pct > 0 ? `+${pct}% к прошлому` : `−${Math.abs(pct)}% к прошлому`;
}

// ── KPI card ─────────────────────────────────────────────────────────────────

function KpiCard({
  eyebrow,
  value,
  sub,
  tone,
  href,
}: {
  eyebrow: string;
  value: string;
  sub?: string;
  tone?: "ok" | "alert" | "default";
  href?: string;
}) {
  const valueColor = tone === "ok" ? "text-emerald" : tone === "alert" ? "text-rose" : "text-ink";
  const inner = (
    <div className="border border-border bg-surface rounded-lg px-5 py-4 shadow-xs h-full">
      <p className="eyebrow mb-2">{eyebrow}</p>
      <p className={`mono-num text-[22px] font-semibold ${valueColor} leading-tight`}>{value}</p>
      {sub && <p className="text-[11.5px] text-ink-2 mt-1.5">{sub}</p>}
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
  const [prevEarned, setPrevEarned] = useState<number | null>(null);
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
    if (!authorized || !isSA) return;
    let cancelled = false;
    const range = derivePeriodRange(period);
    const prevRange = derivePreviousPeriodRange(period);
    (async () => {
      try {
        const [dash, prevDash] = await Promise.all([
          apiFetch<Dashboard>(`/api/finance/dashboard?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`),
          prevRange
            ? apiFetch<Dashboard>(`/api/finance/dashboard?from=${encodeURIComponent(prevRange.from)}&to=${encodeURIComponent(prevRange.to)}`)
            : Promise.resolve(null),
        ]);
        if (!cancelled) {
          setData(dash);
          setPrevEarned(prevDash ? Number(prevDash.earnedThisMonth) : null);
        }
      } catch (e: unknown) {
        if (!cancelled) setDataError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [authorized, isSA, period]);

  if (loading || !authorized) return null;

  // Все /api/finance/* эндпоинты — SUPER_ADMIN only. WAREHOUSE в меню видит
  // только «Счета», сюда попадает лишь прямым URL — показываем заглушку.
  if (!isSA) {
    return (
      <div className="pb-10 bg-surface-subtle min-h-screen">
        <FinanceTabNav />
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-16">
          <div className="bg-surface border border-border rounded-lg px-6 py-14 text-center shadow-xs">
            <p className="eyebrow text-ink-3 mb-1">Финансы</p>
            <h1 className="text-[18px] font-semibold text-ink mb-2">Раздел доступен руководителю</h1>
            <p className="text-sm text-ink-2 max-w-md mx-auto">
              Финансовая сводка, долги и счета видны только пользователям с ролью «Руководитель».
            </p>
            <Link
              href="/day"
              className="inline-block mt-5 px-4 py-2 text-[13px] font-medium bg-accent-bright text-white rounded-lg hover:opacity-90 transition-opacity"
            >
              ← На главную
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (dataError) return <div className="p-8 text-rose text-sm">Ошибка: {dataError}</div>;
  if (!data) return <div className="p-8 text-ink-3 text-sm">Загрузка…</div>;

  const net = Number(data.netThisMonth);
  const earned = Number(data.earnedThisMonth);
  const spent = Number(data.spentThisMonth);
  const outstanding = Number(data.totalOutstanding);
  const overdueCount = data.overdueClientsCount;
  const earnedDelta = deltaPercent(earned, prevEarned);

  const hasAttention = data.topDebtors.length > 0 || data.upcomingWeek.length > 0;

  return (
    <div className="pb-10 bg-surface-subtle min-h-screen">
      <FinanceTabNav debtCount={data.debtorClientsCount} />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-5">

        {/* Header: eyebrow + title + period + actions */}
        <div className="mb-5">
          <p className="eyebrow text-ink-3">Финансы</p>
          <div className="flex items-center justify-between gap-3 flex-wrap mt-1">
            <h1 className="text-[22px] font-semibold text-ink tracking-tight">Сводка по деньгам</h1>
            <div className="flex items-center gap-2 flex-wrap">
              <PeriodSelector value={period} onChange={handlePeriodChange} />
              <button
                onClick={() => setRecordPaymentOpen(true)}
                className="px-3.5 py-2 text-[12px] font-semibold bg-accent-bright text-white rounded-lg hover:opacity-90 transition-opacity whitespace-nowrap"
              >
                + Записать платёж
              </button>
              <button
                onClick={() => setCreateInvoiceOpen(true)}
                className="px-3.5 py-2 text-[12px] font-medium border border-border bg-surface text-ink rounded-lg hover:bg-surface-subtle transition-colors whitespace-nowrap"
              >
                + Создать счёт
              </button>
            </div>
          </div>
        </div>

        {/* KPI strip: три метрики за период + долг-снимок */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5 mb-4">
          <KpiCard
            eyebrow={`Получено · ${PERIOD_LABELS[period].toLowerCase()}`}
            value={formatRub(earned)}
            sub={earnedDelta ?? "нетто, с учётом возвратов"}
            tone="ok"
            href={`/finance/payments?period=${period}`}
          />
          <KpiCard
            eyebrow={`Расходы · ${PERIOD_LABELS[period].toLowerCase()}`}
            value={formatExpenseRub(spent)}
            sub="утверждённые"
            tone="default"
            href={`/finance/expenses?period=${period}`}
          />
          <KpiCard
            eyebrow={`Чистыми · ${PERIOD_LABELS[period].toLowerCase()}`}
            value={net < 0 ? `−${formatRub(Math.abs(net))}` : formatRub(net)}
            sub={net < 0 ? "убыток за период" : "получено минус расходы"}
            tone={net >= 0 ? "ok" : "alert"}
          />
          <KpiCard
            eyebrow="Долг клиентов · сейчас"
            value={formatRub(outstanding)}
            sub={
              overdueCount > 0
                ? `${overdueCount} ${pluralize(overdueCount, "клиент просрочен", "клиента просрочены", "клиентов просрочены")}`
                : `${data.debtorClientsCount} ${pluralize(data.debtorClientsCount, "клиент должен", "клиента должны", "клиентов должны")}`
            }
            tone={overdueCount > 0 ? "alert" : "default"}
            href="/finance/debts"
          />
        </div>

        {/* Просрочка — единственный action-баннер (показывается только при наличии) */}
        {overdueCount > 0 && (
          <div className="mb-4 px-4 py-2.5 rounded-lg border border-amber-border bg-amber-soft flex items-center gap-3 text-[13px] flex-wrap">
            <span className="text-ink">
              <Link href="/finance/debts?overdueOnly=true" className="text-amber font-semibold hover:underline">
                {overdueCount} {pluralize(overdueCount, "клиент с просрочкой", "клиента с просрочкой", "клиентов с просрочкой")}
              </Link>
              {" — стоит напомнить об оплате"}
            </span>
            <Link
              href="/finance/debts?overdueOnly=true"
              className="ml-auto px-3 py-1 text-[12px] font-medium border border-amber-border rounded-lg text-amber hover:bg-amber-border/20 whitespace-nowrap"
            >
              Открыть →
            </Link>
          </div>
        )}

        {/* Денежный поток + долг по возрасту */}
        <div className="grid grid-cols-1 lg:grid-cols-[1.3fr_1fr] gap-4 mb-4">
          <CashflowChart trend={data.trend} monthsToShow={6} />
          <AgingStrip aging={data.aging} />
        </div>

        {/* Требует внимания: должники + ожидаемые поступления */}
        {hasAttention && (
          <div className="grid grid-cols-1 lg:grid-cols-[1.3fr_1fr] gap-4 mb-4">
            {data.topDebtors.length > 0 && (
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
                        <th className="px-3 py-2.5 eyebrow text-left">Статус</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.topDebtors.map((d) => (
                        <tr
                          key={d.clientId}
                          className="border-b border-slate-soft last:border-0 hover:bg-surface-subtle/50 transition-colors cursor-pointer"
                          onClick={() => router.push(`/finance/debts?client=${d.clientId}`)}
                        >
                          <td className="px-4 py-3">
                            <strong className="text-ink font-medium">{d.clientName}</strong>
                          </td>
                          <td className="px-3 py-3 text-right mono-num font-medium">{formatRub(d.outstanding)}</td>
                          <td className="px-3 py-3 text-right mono-num text-ink-2">
                            {d.overdueDays !== null && d.overdueDays > 0 ? `${d.overdueDays} дн.` : "—"}
                          </td>
                          <td className="px-3 py-3">
                            <StatusPill
                              variant={d.overdueDays !== null ? (d.overdueDays > 7 ? "alert" : "warn") : "view"}
                              label={d.overdueDays !== null ? "Просрочен" : "Без срока"}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {data.upcomingWeek.length > 0 && (
              <div className="bg-surface border border-border rounded-lg overflow-hidden shadow-xs">
                <div className="flex justify-between items-center px-4 py-3.5 border-b border-border">
                  <h3 className="text-[13.5px] font-semibold text-ink">Ожидаемые поступления</h3>
                  <span className="text-[11.5px] text-ink-3">7 дней</span>
                </div>
                <div className="px-4 py-3 flex flex-col gap-3">
                  {data.upcomingWeek.slice(0, 6).map((u) => (
                    <Link key={u.bookingId} href={`/bookings/${u.bookingId}`} className="block text-[12.5px] hover:opacity-80 transition-opacity">
                      <div>
                        <strong className="mono-num text-emerald">+{formatRub(u.amountOutstanding)}</strong>
                        {" · "}
                        <span className="text-ink">{u.clientName}</span>
                      </div>
                      <div className="text-[11px] text-ink-3 mt-0.5">
                        {u.projectName}
                        {u.expectedPaymentDate && (
                          <> · срок {new Date(u.expectedPaymentDate).toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}</>
                        )}
                      </div>
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Прогноз поступлений — скрыт, пока пуст (см. ForecastWidget) */}
        <ForecastWidget months={6} />
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
