"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  getDashboard,
  type GafferDashboard,
  type GafferDashboardOverdueIncomingRow,
  type GafferDashboardUpcomingObligationRow,
  type GafferDashboardAtRiskProjectRow,
} from "../../src/lib/gafferApi";
import { formatRub, MONTHS_LOCATIVE } from "../../src/lib/format";
import {
  ClientsWithDebtPanel,
  TeamWithDebtPanel,
} from "../../src/components/gaffer/dashboard/DebtorPanels";
import { toast } from "../../src/components/ToastProvider";
import { useGafferUser } from "../../src/components/gaffer/GafferUserContext";
import {
  Panel,
  PanelTitle,
  KPI,
  Tag,
  BalanceBar,
  Donut,
  Eyebrow,
  H1Title,
  H1Subtitle,
} from "../../src/components/gaffer/designSystem";

// ── Localisation helpers ─────────────────────────────────────────────────────

const WEEKDAYS_LC = [
  "воскресенье",
  "понедельник",
  "вторник",
  "среда",
  "четверг",
  "пятница",
  "суббота",
];

const MONTHS_NOM = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

function formatGreetDate(date: Date): string {
  const weekday = WEEKDAYS_LC[date.getDay()];
  const day = date.getDate();
  const month = MONTHS_NOM[date.getMonth()];
  return `${weekday}, ${day} ${month}`;
}

function greetingWord(hour: number): string {
  if (hour >= 5 && hour < 12) return "утро";
  if (hour >= 12 && hour < 18) return "день";
  return "вечер";
}

function formatPaymentDate(isoStr: string): string {
  const d = new Date(isoStr);
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function daysUntil(isoStr: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(isoStr);
  target.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

const CATEGORY_LABELS: Record<string, string> = {
  client: "Клиент",
  crew: "Осветитель",
  rental: "Рентал",
};

// ── Skeleton ──────────────────────────────────────────────────────────────────

function Skeleton() {
  return (
    <div className="animate-pulse space-y-4 p-6">
      <div className="h-6 bg-gaffer-bg-sub rounded w-1/2" />
      <div className="h-10 bg-gaffer-bg-sub rounded w-2/3" />
      <div className="grid grid-cols-4 gap-3 mt-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-24 bg-gaffer-bg-sub rounded-md" />
        ))}
      </div>
    </div>
  );
}

// ── Panel 1: Overdue incoming ─────────────────────────────────────────────────

function OverdueIncomingPanel({
  rows,
}: {
  rows: GafferDashboardOverdueIncomingRow[];
}) {
  function handleReminder(projectCode: string) {
    toast.info(`AI-напоминание для ${projectCode} в разработке`);
  }

  return (
    <Panel className="flex flex-col">
      <PanelTitle count={rows.length}>Просрочено · мне не заплатили</PanelTitle>
      <div className="border-t border-gaffer-divider">
        {rows.length === 0 ? (
          <div className="py-8 text-center">
            <div className="text-sm font-medium text-gaffer-fg">Всё в порядке</div>
            <div className="text-xs text-gaffer-fg-muted mt-1">
              Нет просроченных входящих оплат
            </div>
          </div>
        ) : (
          rows.map((row) => (
            <div
              key={row.projectId}
              className="flex items-center justify-between py-2 px-3 border-b border-gaffer-divider last:border-0 gap-2"
            >
              {/* Left */}
              <div className="flex flex-col min-w-0 flex-1">
                <span className="text-xs text-gaffer-fg-subtle font-mono">
                  {row.projectCode}
                </span>
                <span className="text-sm text-gaffer-fg truncate">
                  {row.projectTitle}
                </span>
                <span className="text-xs text-gaffer-fg-muted">{row.clientName}</span>
              </div>
              {/* Middle */}
              <Tag tone="neg">+{row.overdueDays} дн</Tag>
              {/* Right */}
              <div className="text-right shrink-0">
                <span className="block text-sm text-gaffer-neg font-mono font-semibold">
                  {formatRub(row.remaining)}
                </span>
                <button
                  className="block text-xs text-gaffer-accent underline mt-0.5"
                  onClick={() => handleReminder(row.projectCode)}
                  type="button"
                >
                  Напомнить
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </Panel>
  );
}

// ── Panel 2: Upcoming obligations ─────────────────────────────────────────────

function UpcomingObligationsPanel({
  rows,
}: {
  rows: GafferDashboardUpcomingObligationRow[];
}) {
  return (
    <Panel className="flex flex-col">
      <PanelTitle count={rows.length}>Ближайшие платежи</PanelTitle>
      <div className="border-t border-gaffer-divider">
        {rows.length === 0 ? (
          <div className="py-8 text-center">
            <div className="text-xs text-gaffer-fg-muted">
              Нет платежей в ближайшие 14 дней
            </div>
          </div>
        ) : (
          rows.map((row, i) => {
            const days = daysUntil(row.dueAt);
            const isIn = row.kind === "IN";
            return (
              <div
                key={`${row.projectId}-${i}`}
                className="flex items-center gap-3 py-2 px-3 border-b border-gaffer-divider last:border-0"
              >
                {/* Date badge */}
                <div className="flex flex-col w-14 shrink-0">
                  <span className="text-xs font-mono font-semibold text-gaffer-fg">
                    {formatPaymentDate(row.dueAt)}
                  </span>
                  <span className="text-[10px] text-gaffer-fg-muted">
                    {days === 0 ? "сегодня" : days < 0 ? "просрочено" : `через ${days} д`}
                  </span>
                </div>
                {/* Counterparty */}
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-gaffer-fg truncate">
                    {row.contactName}{" "}
                    <span className="text-gaffer-fg-muted text-xs">
                      · {CATEGORY_LABELS[row.category]}
                    </span>
                  </div>
                  <div className="text-[10px] font-mono text-gaffer-fg-subtle">
                    {row.projectCode}
                  </div>
                </div>
                {/* Amount */}
                <span
                  className={`text-sm font-mono font-semibold shrink-0 ${
                    isIn ? "text-gaffer-pos" : "text-gaffer-neg"
                  }`}
                >
                  {isIn ? "+" : "−"}
                  {formatRub(row.remaining)}
                </span>
              </div>
            );
          })
        )}
      </div>
    </Panel>
  );
}

// ── Panel 3: At-risk projects ─────────────────────────────────────────────────

function AtRiskProjectsPanel({
  rows,
}: {
  rows: GafferDashboardAtRiskProjectRow[];
}) {
  return (
    <Panel className="flex flex-col">
      <PanelTitle count={rows.length}>Проекты в зоне риска</PanelTitle>
      <div className="border-t border-gaffer-divider">
        {rows.length === 0 ? (
          <div className="py-8 text-center">
            <div className="text-xs text-gaffer-fg-muted">Нет проектов в зоне риска</div>
          </div>
        ) : (
          rows.map((row) => (
            <div
              key={row.projectId}
              className="px-3 py-3 border-b border-gaffer-divider last:border-0"
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gaffer-fg truncate flex-1 pr-2">
                  {row.projectTitle}
                </span>
                <span className="text-sm font-mono font-semibold text-gaffer-neg shrink-0">
                  {formatRub(row.remainingIn)}
                </span>
              </div>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-[10px] font-mono text-gaffer-fg-subtle">
                  {row.projectCode}
                </span>
                <span className="text-xs text-gaffer-fg-muted">{row.clientName}</span>
              </div>
              <div className="mt-2">
                <BalanceBar
                  received={parseFloat(row.received)}
                  paid={parseFloat(row.paid)}
                  remaining={parseFloat(row.remaining)}
                  total={parseFloat(row.total)}
                />
              </div>
            </div>
          ))
        )}
      </div>
    </Panel>
  );
}

// ── Panel 4: Debt structure ───────────────────────────────────────────────────

function DebtStructurePanel({
  debtStructure,
}: {
  debtStructure: GafferDashboard["debtStructure"];
}) {
  const vendorVal = parseFloat(debtStructure.vendorOutSum);
  const teamVal = parseFloat(debtStructure.teamOutSum);

  const segments = [
    { value: vendorVal, color: "var(--gaffer-accent)", label: "Ренталам" },
    { value: teamVal, color: "var(--gaffer-warn)", label: "Осветителям" },
  ];

  return (
    <Panel className="flex flex-col">
      <PanelTitle>Структура долгов</PanelTitle>
      <div className="border-t border-gaffer-divider p-3">
        <div className="flex gap-6 items-start">
          <Donut size={120} thickness={18} segments={segments} />
          <div className="flex flex-col gap-2 flex-1">
            {/* Legend */}
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-sm text-gaffer-fg">
                <span
                  className="w-2 h-2 rounded-sm shrink-0"
                  style={{ background: "var(--gaffer-accent)" }}
                />
                Ренталам
              </span>
              <span className="text-sm font-mono text-gaffer-fg">
                {formatRub(debtStructure.vendorOutSum)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-sm text-gaffer-fg">
                <span
                  className="w-2 h-2 rounded-sm shrink-0"
                  style={{ background: "var(--gaffer-warn)" }}
                />
                Осветителям
              </span>
              <span className="text-sm font-mono text-gaffer-fg">
                {formatRub(debtStructure.teamOutSum)}
              </span>
            </div>
            {/* Stats */}
            <div className="border-t border-gaffer-divider pt-2 mt-1 space-y-1">
              <div className="flex justify-between text-sm">
                <span className="text-gaffer-fg-muted">Закрыто проектов</span>
                <span className="font-mono text-gaffer-fg">
                  {debtStructure.closedProjectCount}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gaffer-fg-muted">В работе</span>
                <span className="font-mono text-gaffer-fg">
                  {debtStructure.inProgressProjectCount}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gaffer-fg-muted">Просрочено</span>
                <span className="font-mono text-gaffer-neg">
                  {debtStructure.overdueProjectCount}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Panel>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function GafferDashboardPage() {
  const [data, setData] = useState<GafferDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const { user } = useGafferUser();
  const now = new Date();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getDashboard()
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) toast.error("Не удалось загрузить дашборд");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const greetWord = greetingWord(now.getHours());
  const userName = user?.name || "Дмитрий";
  const activeProjects = data?.meta.activeProjects ?? 0;
  const openObligationCount = data?.kpi.openObligationCount ?? 0;
  const cashGap14d = data ? parseFloat(data.kpi.cashGap14d) : 0;

  return (
    <div className="min-h-screen bg-gaffer-bg px-4 py-6 md:px-6">
      {/* Header row */}
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <Eyebrow>Гафер · {formatGreetDate(now)}</Eyebrow>
          <H1Title>Доброе {greetWord}, {userName}</H1Title>
          {data && (
            <H1Subtitle>
              По {activeProjects} активным проектам · {openObligationCount} открытых обязательств
            </H1Subtitle>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0 mt-1">
          <Link
            href="/gaffer/obligations"
            className="inline-flex items-center gap-1.5 text-gaffer-fg bg-gaffer-bg-sub border border-gaffer-border rounded-md px-3 py-1.5 text-sm hover:bg-gaffer-bg-panel transition-colors"
          >
            Все долги
          </Link>
          <Link
            href="/gaffer/projects/new"
            className="bg-gaffer-accent text-gaffer-accent-fg rounded-md px-3 py-1.5 text-sm font-medium hover:opacity-90 transition-opacity"
          >
            + Новый проект
          </Link>
        </div>
      </div>

      {loading ? (
        <Skeleton />
      ) : data ? (
        <>
          {/* KPI row */}
          <div className="grid grid-cols-4 gap-3 mb-6 max-[780px]:grid-cols-2 max-[430px]:grid-cols-1">
            <KPI
              tone="pos"
              colored
              label="Мне должны"
              value={formatRub(data.kpi.owedToMe)}
              sub={
                <>
                  из них просрочено{" "}
                  <span className="text-gaffer-neg font-medium">
                    {formatRub(data.kpi.overdueIncomingSum)}
                  </span>
                </>
              }
            />
            <KPI
              tone="neg"
              colored
              label="Я должен"
              value={formatRub(data.kpi.iOwe)}
              sub={
                <>
                  к выплате в 14 дней{" "}
                  <span className="font-medium">
                    {formatRub(data.kpi.dueSoonOutgoingSum)}
                  </span>
                </>
              }
            />
            <KPI
              tone="default"
              label="Свободные деньги"
              value={formatRub(data.kpi.freeCash)}
              sub="факт. сальдо по кассе"
            />
            <KPI
              tone={cashGap14d < 0 ? "warn" : "default"}
              label="Прогноз на 14 дней"
              value={
                cashGap14d >= 0
                  ? `+${formatRub(data.kpi.cashGap14d)}`
                  : formatRub(data.kpi.cashGap14d)
              }
              sub="свободно + ожидается − платежи"
            />
          </div>

          {/* Debtor list panels — inserted per canon §02 between KPI row and analytic panels */}
          <div className="grid grid-cols-2 gap-4 mb-4 max-[780px]:grid-cols-1">
            <ClientsWithDebtPanel rows={data.clientsWithDebt} />
            <TeamWithDebtPanel team={data.teamWithDebt} vendors={data.vendorsWithDebt} />
          </div>

          {/* Panel grid — top row */}
          <div className="grid grid-cols-2 gap-4 mb-4 max-[780px]:grid-cols-1">
            <OverdueIncomingPanel rows={data.overdueIncoming} />
            <UpcomingObligationsPanel rows={data.upcomingObligations} />
          </div>

          {/* Panel grid — bottom row */}
          <div className="grid grid-cols-2 gap-4 max-[780px]:grid-cols-1">
            <AtRiskProjectsPanel rows={data.atRiskProjects} />
            <DebtStructurePanel debtStructure={data.debtStructure} />
          </div>
        </>
      ) : (
        <div className="py-12 text-center text-gaffer-fg-muted text-sm px-4">
          <div className="text-4xl mb-3">📊</div>
          <p>Не удалось загрузить данные дашборда</p>
        </div>
      )}
    </div>
  );
}
