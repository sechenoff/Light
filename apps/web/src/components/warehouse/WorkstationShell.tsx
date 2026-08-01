"use client";

/**
 * WorkstationShell — каркас «Рабочего стола кладовщика v2».
 *
 * Заменяет ScanShell на уровне страницы: та же тёмная canon-шапка, но вместо
 * потока «выбор операции → назад» — постоянная навигация из 5 разделов:
 *   Смена · Выдача · Приёмка · В работе · Журнал (+ Поломки внутри Журнала).
 *
 * Mobile  : контент + фиксированный нижний таб-бар (5 табов, бейджи).
 * Desktop : левая rail-колонка (200px) + контент; контент сам может быть
 *           двухпанельным (list | detail) — как прежний ScanShell.
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
  badgeTone?: "accent" | "rose" | "amber";
}> = [
  { key: "shift", label: "Смена", icon: IconHome },
  { key: "issue", label: "Выдача", icon: IconIssue, badgeKey: "issue", badgeTone: "accent" },
  { key: "return", label: "Приёмка", icon: IconReturn, badgeKey: "return", badgeTone: "rose" },
  { key: "inwork", label: "В работе", icon: IconClock, badgeKey: "inwork", badgeTone: "amber" },
  { key: "journal", label: "Журнал", icon: IconChart },
];

const BADGE_TONE: Record<string, string> = {
  accent: "bg-accent-bright",
  rose: "bg-rose",
  amber: "bg-amber",
};

function TabBadge({ count, tone }: { count: number; tone: string }) {
  if (count <= 0) return null;
  return (
    <span
      className={`${BADGE_TONE[tone] ?? "bg-rose"} mono-num flex h-[16px] min-w-[16px] items-center justify-center rounded-full px-1 text-[9.5px] font-bold text-white`}
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

  const railNav = (
    <nav
      aria-label="Разделы склада"
      className="hidden lg:flex lg:w-[200px] lg:shrink-0 lg:flex-col lg:gap-0.5 lg:border-r lg:border-border lg:bg-surface lg:p-2"
    >
      {TABS.map(({ key, label, icon: Icon, badgeKey, badgeTone }) => {
        const isOn = activeNavKey === key;
        return (
          <button
            key={key}
            type="button"
            onClick={() => onTab(key)}
            aria-current={isOn ? "page" : undefined}
            className={`flex min-h-[42px] items-center gap-2.5 rounded-md px-3 py-2 text-left text-[13px] font-medium transition-colors ${
              isOn
                ? "bg-accent-soft font-semibold text-accent-bright"
                : "text-ink-2 hover:bg-surface-muted"
            }`}
          >
            <Icon className="h-[18px] w-[18px] shrink-0" />
            <span className="flex-1">{label}</span>
            {badgeKey && (
              <TabBadge count={badges[badgeKey] ?? 0} tone={badgeTone ?? "rose"} />
            )}
          </button>
        );
      })}
      <div className="mx-2 my-2 h-px bg-border" />
      <button
        type="button"
        onClick={() => onTab("problems")}
        aria-current={tab === "problems" ? "page" : undefined}
        className={`flex min-h-[42px] items-center gap-2.5 rounded-md px-3 py-2 text-left text-[13px] font-medium transition-colors ${
          tab === "problems"
            ? "bg-accent-soft font-semibold text-accent-bright"
            : "text-ink-2 hover:bg-surface-muted"
        }`}
      >
        <IconWrench className="h-[18px] w-[18px] shrink-0" />
        <span className="flex-1">Поломки</span>
        <TabBadge count={badges.problems ?? 0} tone="amber" />
      </button>
      <div className="mt-auto px-3 py-2 text-[11px] text-ink-3">
        {workerName}
        {onLogout && (
          <button
            type="button"
            onClick={onLogout}
            className="mt-0.5 block text-left text-[11px] text-ink-3 underline hover:text-ink"
          >
            Выйти
          </button>
        )}
      </div>
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
    <div className="flex min-h-screen flex-col bg-surface-muted">
      {/* Тёмная canon-шапка (как ScanShell). */}
      <header className="bg-accent text-white">
        <div className="mx-auto flex w-full max-w-[1380px] items-center gap-3 px-4 py-3 lg:px-6">
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
                  className="rounded border border-white/25 px-2.5 py-1 text-xs font-medium text-white/90 transition-colors hover:bg-white/10 lg:hidden"
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
          <div className="mx-auto flex w-full max-w-[1380px] flex-1 pb-[68px] lg:pb-0">
            {railNav}
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
