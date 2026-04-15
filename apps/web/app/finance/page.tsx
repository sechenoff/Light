"use client";

import { useEffect, useMemo, useState } from "react";
import { useRequireRole } from "../../src/hooks/useRequireRole";
import { apiFetch } from "../../src/lib/api";
import { formatRub } from "../../src/lib/format";
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function daysUntil(dateStr: string | null): string {
  if (!dateStr) return "";
  const diff = Math.ceil((new Date(dateStr).getTime() - Date.now()) / 86400000);
  if (diff < 0) return `${Math.abs(diff)} дн. просрочено`;
  if (diff === 0) return "сегодня";
  return `через ${diff} дн.`;
}

// ── Trend chart (inline SVG) ──────────────────────────────────────────────────

function TrendChart({ trend }: { trend: TrendEntry[] }) {
  const maxVal = useMemo(() => {
    let m = 1;
    for (const t of trend) {
      m = Math.max(m, Number(t.earned), Number(t.spent));
    }
    return m;
  }, [trend]);

  const HEIGHT = 140;
  const BAR_W = 20;
  const GROUP_W = 60;

  return (
    <div className="mt-4">
      <p className="eyebrow mb-2">Тренд за 12 месяцев</p>
      <div className="flex gap-3 mb-1">
        <span className="flex items-center gap-1 text-xs text-ink-2">
          <span className="inline-block w-3 h-3 rounded-sm" style={{ background: "#047857" }} /> Доход
        </span>
        <span className="flex items-center gap-1 text-xs text-ink-2">
          <span className="inline-block w-3 h-3 rounded-sm" style={{ background: "#334155" }} /> Расход
        </span>
      </div>
      <svg viewBox={`0 0 ${trend.length * GROUP_W} ${HEIGHT + 20}`} className="w-full h-40">
        {trend.map((m, i) => {
          const earnedH = Math.max(2, (Number(m.earned) / maxVal) * HEIGHT);
          const spentH = Math.max(2, (Number(m.spent) / maxVal) * HEIGHT);
          return (
            <g key={m.month} transform={`translate(${i * GROUP_W}, 0)`}>
              <rect x={8} y={HEIGHT - earnedH} width={BAR_W} height={earnedH} fill="#047857" rx="2" />
              <rect x={32} y={HEIGHT - spentH} width={BAR_W} height={spentH} fill="#334155" rx="2" />
              <text x={30} y={HEIGHT + 14} textAnchor="middle" fill="#a1a1aa" fontSize="9" fontFamily="IBM Plex Mono">
                {m.month.slice(5)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ── KPI Card ──────────────────────────────────────────────────────────────────

function KpiCard({ label, value, stripeColor }: { label: string; value: string; stripeColor: string }) {
  return (
    <div className="bg-surface border border-border rounded-lg shadow-xs overflow-hidden flex">
      <div className="w-1 shrink-0" style={{ background: stripeColor }} />
      <div className="p-4 flex-1">
        <p className="eyebrow">{label}</p>
        <p className="mono-num text-2xl mt-1 text-ink">{value}</p>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function FinancePage() {
  const { authorized, loading } = useRequireRole(ALLOWED);
  const [data, setData] = useState<Dashboard | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);

  useEffect(() => {
    if (!authorized) return;
    apiFetch<Dashboard>("/api/finance/dashboard")
      .then(setData)
      .catch((e) => setDataError(String(e.message)));
  }, [authorized]);

  if (loading || !authorized) return null;
  if (dataError) return <div className="p-8 text-rose text-sm">Ошибка: {dataError}</div>;
  if (!data) return <div className="p-8 text-ink-3 text-sm">Загрузка…</div>;

  const net = Number(data.netThisMonth);
  const earned = Number(data.earnedThisMonth);
  const netPercent = earned > 0 ? Math.round((net / earned) * 100) : 0;
  const netSign = net >= 0 ? "+" : "";

  return (
    <div className="space-y-6 pb-10">
      {/* Header */}
      <div>
        <p className="eyebrow">Финансы</p>
        <h1 className="text-2xl font-semibold text-ink mt-1">Сводка</h1>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard label="Долги клиентов" value={formatRub(data.totalOutstanding)} stripeColor="#9f1239" />
        <KpiCard label="Заработали за месяц" value={formatRub(data.earnedThisMonth)} stripeColor="#047857" />
        <KpiCard label="Потратили за месяц" value={formatRub(data.spentThisMonth)} stripeColor="#334155" />
        <KpiCard label="Ждём на неделе" value={formatRub(
          data.upcomingWeek.reduce((s, u) => s + Number(u.amountOutstanding), 0)
        )} stripeColor="#a16207" />
      </div>

      {/* Net profit strip */}
      <div className="bg-ink text-surface rounded-lg p-6 flex items-center justify-between">
        <div>
          <p className="eyebrow text-surface/60">Чистая прибыль за месяц</p>
          <p className="mono-num text-3xl mt-1">{formatRub(data.netThisMonth)}</p>
        </div>
        <div className={`text-2xl font-bold mono-num ${net >= 0 ? "text-emerald-border" : "text-rose-border"}`}>
          {netSign}{netPercent}%
        </div>
      </div>

      {/* Trend chart + upcoming */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-surface border border-border rounded-lg p-4 shadow-xs">
          <TrendChart trend={data.trend} />
        </div>

        {/* Upcoming payments */}
        <div className="bg-surface border border-border rounded-lg p-4 shadow-xs">
          <p className="eyebrow mb-3">Ближайшие платежи (7 дней)</p>
          {data.upcomingWeek.length === 0 ? (
            <p className="text-sm text-ink-3">Нет платежей на горизонте</p>
          ) : (
            <ul className="space-y-2">
              {data.upcomingWeek.map((u) => (
                <li key={u.bookingId} className="text-sm">
                  <span className="font-medium text-ink">{u.clientName}</span>
                  <span className="text-ink-2"> · {u.projectName}</span>
                  <div className="flex justify-between mt-0.5">
                    <span className="mono-num text-ink font-medium">{formatRub(u.amountOutstanding)}</span>
                    <span className="text-ink-3 text-xs">{daysUntil(u.expectedPaymentDate)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Top-5 debtors */}
      {data.topDebtors.length > 0 && (
        <div className="bg-surface border border-border rounded-lg p-4 shadow-xs">
          <p className="eyebrow mb-3">Топ-5 должников</p>
          <ul className="divide-y divide-border">
            {data.topDebtors.map((d) => (
              <li key={d.clientId} className="py-2 flex items-center justify-between">
                <a
                  href={`/finance/debts?clientId=${d.clientId}`}
                  className="text-sm font-medium text-ink hover:text-accent transition-colors"
                >
                  {d.clientName}
                </a>
                <div className="flex items-center gap-3 text-right">
                  <span className="mono-num text-sm font-semibold text-ink">{formatRub(d.outstanding)}</span>
                  {d.overdueDays !== null && d.overdueDays > 0 && (
                    <span className="text-xs text-rose">просрочка {d.overdueDays} дн.</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
