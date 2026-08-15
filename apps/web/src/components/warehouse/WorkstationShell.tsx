"use client";

/**
 * WorkstationShell — каркас «Рабочего стола кладовщика v2».
 *
 * С 2026-08-02 раздел живёт ВНУТРИ общего AppShell (глобальный сайдбар сайта),
 * а не отдельным полноэкранным киоском — решение владельца: единая навигация
 * по всему сайту. Внутренняя навигация раздела:
 *
 * Desktop : горизонтальные табы под шапкой (паттерн AdminTabNav из админки):
 *   Смена · Выдача · Приёмка · В работе · Журнал · Поломки. Контент может
 *   быть двухпанельным (list | detail).
 * Mobile  : фиксированный нижний таб-бар (5 табов, бейджи) — сохранён:
 *   для планшета склада это лучшие touch-таргеты.
 *
 * Тёмная canon-шапка раздела сохранена (прецедент — DayHeader на /day):
 * несёт заголовок текущего экрана, имя работника киоск-сессии и её логаут
 * (PIN-сессия отдельна от основной сессии сайта).
 *
 * Мокап: docs/mockups/warehouse-scan/05-workstation-v2.html.
 * Touch-таргеты ≥44px; иконки SVG (workstationIcons), не эмодзи.
 */

import type { ReactNode } from "react";
import {
  IconHome,
  IconIssue,
  IconReturn,
  IconClock,
  IconChart,
  IconWrench,
} from "./workstationIcons";

export type WorkstationTab =
  | "shift"
  | "issue"
  | "return"
  | "inwork"
  | "journal"
  | "problems";

export interface WorkstationBadges {
  /** Починенное, что ещё лежит на верстаке (блок «Вернулось из ремонта»). */
  shift?: number;
  issue?: number;
  return?: number;
  inwork?: number;
  problems?: number;
}

interface WorkstationShellProps {
  tab: WorkstationTab;
  onTab: (tab: WorkstationTab) => void;
  badges?: WorkstationBadges;
  eyebrow?: string;
  title: string;
  workerName?: string;
  onLogout?: () => void;
  /** Кнопка «назад» в шапке (внутри под-потока, например чек-листа). */
  onBack?: () => void;
  /** Скрыть навигацию целиком (экран логина). */
  navHidden?: boolean;
  /** Левый list-слот (двухпанельные табы Выдача/Приёмка/В работе). */
  list?: ReactNode;
  /** Поведение list на мобильном: stack (по умолчанию) или скрыт. */
  mobileList?: "stack" | "hidden";
  detail: ReactNode;
}

const TABS: Array<{
  key: WorkstationTab;
  label: string;
  icon: typeof IconHome;
  badgeKey?: keyof WorkstationBadges;
  badgeTone?: "accent" | "rose" | "amber" | "emerald";
}> = [
  // Бейдж «Смены» — не задача, а напоминание: столько починенного ещё не
  // вернули на полку. Потому зелёный, а не тревожный.
  { key: "shift", label: "Смена", icon: IconHome, badgeKey: "shift", badgeTone: "emerald" },
  { key: "issue", label: "Выдача", icon: IconIssue, badgeKey: "issue", badgeTone: "accent" },
  { key: "return", label: "Приёмка", icon: IconReturn, badgeKey: "return", badgeTone: "rose" },
  { key: "inwork", label: "В работе", icon: IconClock, badgeKey: "inwork", badgeTone: "amber" },
  { key: "journal", label: "Журнал", icon: IconChart },
];

const BADGE_TONE: Record<string, string> = {
  accent: "bg-accent-bright",
  rose: "bg-rose",
  amber: "bg-amber",
  emerald: "bg-emerald",
};

function TabBadge({ count, tone }: { count: number; tone: string }) {
  if (count <= 0) return null;
  return (
    <span
      // text-surface, не text-white: бейдж лежит на светлом фоне таб-бара, а
      // ночью его заливка осветляется — белая цифра на ней теряется.
      className={`${BADGE_TONE[tone] ?? "bg-rose"} mono-num flex h-[16px] min-w-[16px] items-center justify-center rounded-full px-1 text-[9.5px] font-bold text-surface`}
      aria-hidden
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

export function WorkstationShell({
  tab,
  onTab,
  badges = {},
  eyebrow,
  title,
  workerName,
  onLogout,
  onBack,
  navHidden = false,
  list,
  mobileList = "stack",
  detail,
}: WorkstationShellProps) {
  const twoPane = list != null;
  // «Журнал» подсвечен и когда открыт под-экран «Поломки».
  const activeNavKey: WorkstationTab = tab === "problems" ? "journal" : tab;

  // Горизонтальные табы раздела — тот же визуальный контракт, что AdminTabNav
  // в админке (подчёркивание активной, скролл самого бара на узких экранах).
  // Кнопки, не Link: разделы — это состояние страницы (?tab=), не маршруты.
  const topTabs = (
    <nav
      aria-label="Разделы склада"
      className="hidden gap-0.5 overflow-x-auto border-b border-border bg-surface px-4 lg:flex lg:px-6"
    >
      {[...TABS, { key: "problems" as WorkstationTab, label: "Поломки", icon: IconWrench, badgeKey: "problems" as const, badgeTone: "amber" as const }].map(
        ({ key, label, icon: Icon, badgeKey, badgeTone }) => {
          const isOn = key === "problems" ? tab === "problems" : activeNavKey === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => onTab(key)}
              aria-current={isOn ? "page" : undefined}
              className={`-mb-px flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-3.5 py-2.5 text-sm transition-colors ${
                isOn
                  ? "border-ink bg-surface font-medium text-ink"
                  : "border-transparent text-ink-2 hover:bg-surface-muted hover:text-ink"
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
              {badgeKey && (
                <TabBadge count={badges[badgeKey] ?? 0} tone={badgeTone ?? "rose"} />
              )}
            </button>
          );
        },
      )}
    </nav>
  );

  const tabBar = (
    <nav
      aria-label="Разделы склада"
      className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden"
    >
      {TABS.map(({ key, label, icon: Icon, badgeKey, badgeTone }) => {
        const isOn = activeNavKey === key;
        const count = badgeKey ? (badges[badgeKey] ?? 0) : 0;
        return (
          <button
            key={key}
            type="button"
            onClick={() => onTab(key)}
            aria-current={isOn ? "page" : undefined}
            className={`relative flex min-h-[52px] flex-col items-center justify-center gap-0.5 px-1 pb-1.5 pt-2 text-[10px] font-medium ${
              isOn ? "text-accent-bright" : "text-ink-3"
            }`}
          >
            {isOn && (
              <span
                aria-hidden
                className="absolute left-[22%] right-[22%] top-0 h-0.5 rounded-b bg-accent-bright"
              />
            )}
            {count > 0 && (
              <span className="absolute right-[calc(50%-19px)] top-1">
                <TabBadge count={count} tone={badgeTone ?? "rose"} />
              </span>
            )}
            <Icon className="h-[21px] w-[21px]" />
            {label}
          </button>
        );
      })}
    </nav>
  );

  return (
    // Высоту и глобальный сайдбар даёт AppShell; здесь только колонка раздела.
    <div className="flex min-h-full flex-1 flex-col bg-surface-muted">
      {/* Тёмная canon-шапка раздела (прецедент — DayHeader на /day). */}
      <header className="bg-accent-chrome text-white">
        <div className="flex w-full items-center gap-3 px-4 py-3 lg:px-6">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              aria-label="Назад"
              className="-ml-1 flex h-9 w-9 items-center justify-center rounded text-lg leading-none text-white/80 transition-colors hover:bg-white/10 hover:text-white"
            >
              ←
            </button>
          )}
          <div className="min-w-0 flex-1">
            {eyebrow && <p className="eyebrow !text-white/70">{eyebrow}</p>}
            <h1 className="truncate text-[15px] font-semibold leading-snug">
              {title}
            </h1>
          </div>
          {workerName && (
            <div className="flex shrink-0 items-center gap-3">
              <span className="hidden text-xs text-white/70 sm:inline">
                {workerName}
              </span>
              {onLogout && (
                <button
                  type="button"
                  onClick={onLogout}
                  className="rounded border border-white/25 px-2.5 py-1 text-xs font-medium text-white/90 transition-colors hover:bg-white/10"
                >
                  Выйти
                </button>
              )}
            </div>
          )}
        </div>
      </header>

      {navHidden ? (
        <main className="flex flex-1 items-center justify-center px-4 py-8">
          {detail}
        </main>
      ) : (
        <>
          {topTabs}
          <div className="flex w-full flex-1 pb-[68px] lg:pb-0">
            {twoPane ? (
              <div className="flex-1 lg:grid lg:grid-cols-[minmax(280px,340px)_1fr]">
                <aside
                  className={`border-b border-border bg-surface-muted lg:overflow-y-auto lg:border-b-0 lg:border-r ${
                    mobileList === "hidden" ? "hidden lg:block" : ""
                  }`}
                >
                  {list}
                </aside>
                <main className="flex min-w-0 flex-1 flex-col bg-surface lg:overflow-y-auto">
                  {detail}
                </main>
              </div>
            ) : (
              <main className="flex min-w-0 flex-1 flex-col">{detail}</main>
            )}
          </div>
          {tabBar}
        </>
      )}
    </div>
  );
}
