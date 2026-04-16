"use client";

import { useEffect, useMemo, useState } from "react";
import { useRequireRole } from "../../src/hooks/useRequireRole";
import { apiFetch } from "../../src/lib/api";
import { formatRub, MONTHS_LOCATIVE } from "../../src/lib/format";
import { FinanceTabNav } from "../../src/components/finance/FinanceTabNav";
import type { UserRole } from "../../src/lib/auth";

const ALLOWED: UserRole[] = ["SUPER_ADMIN"];

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

const SHORT_MONTHS: Record<string, string> = {
  "01": "Янв", "02": "Фев", "03": "Мар", "04": "Апр",
  "05": "Май", "06": "Июн", "07": "Июл", "08": "Авг",
  "09": "Сен", "10": "Окт", "11": "Ноя", "12": "Дек",
};

function agePill(days: number | null) {
  if (days === null || days <= 0)
    return { label: "По графику", cls: "bg-emerald-soft text-emerald border border-emerald-border" };
  if (days <= 7)
    return { label: `Через ${days} дн.`, cls: "bg-amber-soft text-amber border border-amber-border" };
  return { label: `${days} дней`, cls: "bg-rose-soft text-rose border border-rose-border" };
}

function formatDateCard(dateStr: string | null) {
  if (!dateStr) return { day: "—", month: "" };
  const d = new Date(dateStr);
  return {
    day: String(d.getDate()).padStart(2, "0"),
    month: SHORT_MONTHS[String(d.getMonth() + 1).padStart(2, "0")] ?? "",
  };
}

// ── Trend chart (SVG bars) ────────────────────────────────────────────────────

function TrendChart({ trend }: { trend: TrendEntry[] }) {
  const last6 = trend.slice(-6);
  const maxVal = useMemo(() => {
    let m = 1;
    for (const t of last6) {
      m = Math.max(m, Number(t.earned), Number(t.spent));
    }
    return m;
  }, [last6]);

  const HEIGHT = 120;

  return (
    <div className="px-5 pb-4 pt-2">
      <div
        className="grid gap-3.5"
        style={{ display: "grid", gridTemplateColumns: `repeat(${last6.length}, 1fr)`, height: `${HEIGHT + 32}px`, alignItems: "end" }}
      >
        {last6.map((m) => {
          const earnedPct = Math.max(2, (Number(m.earned) / maxVal) * HEIGHT);
          const spentPct = Math.max(2, (Number(m.spent) / maxVal) * HEIGHT);
          const monthKey = m.month.slice(5, 7);
          return (
            <div key={m.month} className="flex flex-col items-center gap-1" style={{ height: `${HEIGHT + 20}px`, justifyContent: "flex-end" }}>
              <div className="flex gap-[3px] items-end" style={{ height: `${HEIGHT}px` }}>
                <div
                  className="w-3.5 rounded-t-sm bg-emerald"
                  style={{ height: `${earnedPct}px` }}
                />
                <div
                  className="w-3.5 rounded-t-sm bg-slate"
                  style={{ height: `${spentPct}px` }}
                />
              </div>
              <span className="text-[10.5px] text-ink-3 font-medium uppercase tracking-wider" style={{ fontFamily: "IBM Plex Sans Condensed, sans-serif" }}>
                {SHORT_MONTHS[monthKey] ?? monthKey}
              </span>
            </div>
          );
        })}
      </div>
      <div className="flex gap-4 text-[11.5px] text-ink-2 mt-1">
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-2.5 h-2.5 rounded-sm bg-emerald" />
          Выручка
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-2.5 h-2.5 rounded-sm bg-slate" />
          Расходы
        </span>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function FinancePage() {
  const { authorized, loading } = useRequireRole(ALLOWED);
  const [data, setData] = useState<Dashboard | null>(null);
  const [debtCount, setDebtCount] = useState<number | undefined>(undefined);
  const [dataError, setDataError] = useState<string | null>(null);

  useEffect(() => {
    if (!authorized) return;
    let cancelled = false;
    (async () => {
      try {
        const [dash, debts] = await Promise.all([
          apiFetch<Dashboard>("/api/finance/dashboard"),
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
  }, [authorized]);

  if (loading || !authorized) return null;
  if (dataError) return <div className="p-8 text-rose text-sm">Ошибка: {dataError}</div>;
  if (!data) return <div className="p-8 text-ink-3 text-sm">Загрузка…</div>;

  const net = Number(data.netThisMonth);
  const earned = Number(data.earnedThisMonth);
  const spent = Number(data.spentThisMonth);
  const netSign = net >= 0 ? "+ " : "− ";
  const netAbs = Math.abs(net);

  const now = new Date();
  const monthName = MONTHS_LOCATIVE[now.getMonth()] ?? "";
  const asOf = data.asOf ? new Date(data.asOf) : now;
  const asOfStr = `${asOf.getDate()} апр, ${String(asOf.getHours()).padStart(2, "0")}:${String(asOf.getMinutes()).padStart(2, "0")}`;

  // Overdue debtors count
  const overdueCount = data.topDebtors.filter(
    (d) => d.overdueDays !== null && d.overdueDays > 0
  ).length;

  const upcomingTotal = data.upcomingWeek.reduce(
    (s, u) => s + Number(u.amountOutstanding),
    0
  );

  return (
    <div className="pb-10">
      <FinanceTabNav debtCount={debtCount} />

      <div className="px-7 py-5">
        {/* Page header */}
        <div className="flex justify-between items-end mb-4 pb-3.5 border-b border-border">
          <div>
            <h1 className="text-[22px] font-semibold text-ink tracking-tight">Финансы</h1>
            <p className="text-xs text-ink-2 mt-0.5">
              {monthName.charAt(0).toUpperCase() + monthName.slice(1)} {now.getFullYear()}
              {" · данные обновлены "}{asOfStr}
              {" · "}
              <span className="inline-flex items-center gap-1 bg-indigo-soft text-indigo border border-indigo-border rounded-full px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider">
                Только руководитель
              </span>
            </p>
          </div>
          <div className="flex gap-2.5">
            <div className="flex items-center gap-1.5 bg-surface-subtle border border-border rounded p-1">
              {["Сегодня", "Неделя", "Месяц", "Квартал", "Год"].map((lbl) => (
                <button
                  key={lbl}
                  className={`px-2.5 py-1 text-xs font-medium rounded-sm transition-colors ${
                    lbl === "Месяц"
                      ? "bg-surface text-ink shadow-xs"
                      : "text-ink-2 hover:text-ink"
                  }`}
                >
                  {lbl}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* KPI row */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5 mb-5">
          {/* Долги */}
          <div className="relative bg-surface border border-border rounded-[6px] px-[18px] pt-4 pb-[18px] overflow-hidden shadow-xs">
            <div className="absolute left-0 top-0 bottom-0 w-[3px] bg-rose" />
            <p className="eyebrow mb-2">Кто должен</p>
            <p className="mono-num text-2xl font-semibold text-ink leading-tight">{formatRub(data.totalOutstanding)}</p>
            <p className="text-[11.5px] text-ink-2 mt-1.5">
              {debtCount ?? "—"} клиентов, из них{" "}
              <strong className="text-rose">{overdueCount} просрочки</strong>
            </p>
            <span className="inline-flex items-center gap-1 text-[11px] font-medium mt-2.5 px-[7px] py-0.5 rounded-full bg-rose-soft text-rose">
              ▲ задолженность
            </span>
          </div>

          {/* Ожидается */}
          <div className="relative bg-surface border border-border rounded-[6px] px-[18px] pt-4 pb-[18px] overflow-hidden shadow-xs">
            <div className="absolute left-0 top-0 bottom-0 w-[3px] bg-amber" />
            <p className="eyebrow mb-2">Когда оплатят</p>
            <p className="mono-num text-2xl font-semibold text-ink leading-tight">{formatRub(upcomingTotal)}</p>
            <p className="text-[11.5px] text-ink-2 mt-1.5">
              ожидается за 7 дней · {data.upcomingWeek.length} платежей
            </p>
            <span className="inline-flex items-center gap-1 text-[11px] font-medium mt-2.5 px-[7px] py-0.5 rounded-full bg-slate-soft text-slate">
              {data.upcomingWeek.length} платежей в очереди
            </span>
          </div>

          {/* Выручка */}
          <div className="relative bg-surface border border-border rounded-[6px] px-[18px] pt-4 pb-[18px] overflow-hidden shadow-xs">
            <div className="absolute left-0 top-0 bottom-0 w-[3px] bg-emerald" />
            <p className="eyebrow mb-2">Сколько заработал</p>
            <p className="mono-num text-2xl font-semibold text-ink leading-tight">{formatRub(data.earnedThisMonth)}</p>
            <p className="text-[11.5px] text-ink-2 mt-1.5">выручка за месяц</p>
            <span className="inline-flex items-center gap-1 text-[11px] font-medium mt-2.5 px-[7px] py-0.5 rounded-full bg-emerald-soft text-emerald">
              ▲ выручка
            </span>
          </div>

          {/* Расходы */}
          <div className="relative bg-surface border border-border rounded-[6px] px-[18px] pt-4 pb-[18px] overflow-hidden shadow-xs">
            <div className="absolute left-0 top-0 bottom-0 w-[3px] bg-slate" />
            <p className="eyebrow mb-2">Сколько потратил</p>
            <p className="mono-num text-2xl font-semibold text-ink leading-tight">{formatRub(data.spentThisMonth)}</p>
            <p className="text-[11.5px] text-ink-2 mt-1.5">операции за месяц</p>
            <span className="inline-flex items-center gap-1 text-[11px] font-medium mt-2.5 px-[7px] py-0.5 rounded-full bg-slate-soft text-slate">
              расходы
            </span>
          </div>
        </div>

        {/* Net result strip */}
        <div className="flex justify-between items-center bg-accent-soft border border-accent-border rounded-[6px] px-5 py-3.5 mb-7" style={{ background: "linear-gradient(90deg, var(--tw-gradient-from) 0%, var(--tw-gradient-to) 80%)" }}>
          <div className="bg-gradient-to-r from-accent-soft to-white border border-accent-border rounded-[6px] px-5 py-3.5 flex justify-between items-center w-full">
            <div>
              <p className="text-[11.5px] font-semibold uppercase tracking-[0.03em] text-ink-2">Чистый результат месяца</p>
              <p className="mono-num text-[22px] font-semibold text-accent leading-tight mt-0.5">
                {netSign}{formatRub(netAbs)}
              </p>
            </div>
            <p className="mono-num text-[11px] text-ink-3">
              {formatRub(earned)} (заработал) − {formatRub(spent)} (потратил) ={" "}
              <strong className="text-accent">{netSign}{formatRub(netAbs)}</strong>
            </p>
          </div>
        </div>

        {/* Two-column: trend chart + top debtors */}
        <div className="grid gap-4 mb-5" style={{ gridTemplateColumns: "1.6fr 1fr" }}>
          {/* Trend chart panel */}
          <div className="bg-surface border border-border rounded-[6px] overflow-hidden shadow-xs">
            <div className="flex justify-between items-center px-4 py-3.5 border-b border-border">
              <h3 className="text-[13.5px] font-semibold text-ink">Доходы и расходы по месяцам</h3>
            </div>
            {data.trend.length > 0 ? (
              <TrendChart trend={data.trend} />
            ) : (
              <div className="p-5 text-sm text-ink-3">Нет данных</div>
            )}
          </div>

          {/* Top debtors panel */}
          <div className="bg-surface border border-border rounded-[6px] overflow-hidden shadow-xs">
            <div className="flex justify-between items-center px-4 py-3.5 border-b border-border">
              <h3 className="text-[13.5px] font-semibold text-ink">Топ должников</h3>
              <a href="/finance/debts" className="text-xs text-accent font-medium hover:underline">
                Все {debtCount} →
              </a>
            </div>
            <div className="py-1.5">
              {data.topDebtors.length === 0 ? (
                <p className="px-4 py-3 text-sm text-ink-3">Нет задолженностей</p>
              ) : (
                data.topDebtors.map((d) => {
                  const pill = agePill(d.overdueDays);
                  return (
                    <div
                      key={d.clientId}
                      className="grid items-center gap-3 px-4 py-2.5 border-b border-border last:border-0"
                      style={{ gridTemplateColumns: "1fr auto auto" }}
                    >
                      <div>
                        <p className="text-[13px] font-medium text-ink">{d.clientName}</p>
                        {d.projectName && (
                          <p className="text-[11.5px] text-ink-2 mt-0.5">{d.projectName}</p>
                        )}
                      </div>
                      <span className={`text-[10.5px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-[0.04em] ${pill.cls}`} style={{ fontFamily: "IBM Plex Sans Condensed, sans-serif" }}>
                        {pill.label}
                      </span>
                      <span className="mono-num font-semibold text-[13px] text-right">{formatRub(d.outstanding)}</span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* Upcoming payments panel */}
        <div className="bg-surface border border-border rounded-[6px] overflow-hidden shadow-xs">
          <div className="flex justify-between items-center px-4 py-3.5 border-b border-border">
            <h3 className="text-[13.5px] font-semibold text-ink">Ожидаемые поступления на этой неделе</h3>
            <a href="/finance/payments" className="text-xs text-accent font-medium hover:underline">
              Все платежи →
            </a>
          </div>
          <div className="py-1.5">
            {data.upcomingWeek.length === 0 ? (
              <p className="px-4 py-3 text-sm text-ink-3">Нет платежей на горизонте</p>
            ) : (
              data.upcomingWeek.map((u) => {
                const dc = formatDateCard(u.expectedPaymentDate);
                const today = new Date();
                const isToday = u.expectedPaymentDate &&
                  new Date(u.expectedPaymentDate).toDateString() === today.toDateString();
                return (
                  <div
                    key={u.bookingId}
                    className="grid items-center gap-3 px-4 py-2.5 border-b border-border last:border-0"
                    style={{ gridTemplateColumns: "44px 1fr auto" }}
                  >
                    <div
                      className={`text-center rounded px-0 py-1 ${isToday ? "bg-amber-soft" : "bg-surface-subtle"}`}
                      style={{ fontFamily: "IBM Plex Sans Condensed, sans-serif" }}
                    >
                      <p className={`text-[16px] font-bold leading-none ${isToday ? "text-amber" : "text-ink"}`}>{dc.day}</p>
                      <p className="text-[9.5px] uppercase tracking-[0.06em] text-ink-3 mt-0.5">{dc.month}</p>
                    </div>
                    <div>
                      <p className="text-[13px] font-medium text-ink">{u.clientName}</p>
                      <p className="text-[11.5px] text-ink-2 mt-0.5">{u.projectName}</p>
                    </div>
                    <p className="mono-num font-semibold text-[13px] text-right">{formatRub(u.amountOutstanding)}</p>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
