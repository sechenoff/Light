"use client";

/**
 * Standalone responsive frame for the warehouse-scan kiosk page.
 *
 * NOT wrapped in AppShell — this is a full-screen kiosk surface used on a
 * mounted tablet / phone. Pure layout, zero business logic.
 *
 * Mobile  (default): single full-height column, dark canon header band on top.
 * Desktop (lg:)     : two-pane grid — list slot left, detail slot right —
 *                     mirroring mockup `03-issue-and-desktop.html` block 4.
 *
 * Visual source of truth: docs/mockups/warehouse-scan/03-issue-and-desktop.html
 * (block 1 mobile header band, block 4 desktop `.desk` two-pane).
 */

import type { ReactNode } from "react";

interface ScanShellProps {
  /** Надстрочник в тёмной шапке (например, «Склад · Выдача»). */
  eyebrow?: string;
  /** Заголовок в тёмной шапке (например, «Выберите бронь»). */
  title: string;
  /** Имя залогиненного кладовщика (правый край шапки). */
  workerName?: string;
  /** Кнопка выхода (если есть активная складская сессия). */
  onLogout?: () => void;
  /** Опциональная кнопка «назад» слева в шапке. */
  onBack?: () => void;
  /**
   * Left list slot. On desktop it becomes the fixed-width left pane;
   * on mobile it stacks above `detail`. When omitted (e.g. login screen),
   * only `detail` is rendered, centered.
   */
  list?: ReactNode;
  /** Right detail slot (checklist / placeholder / login form). */
  detail: ReactNode;
}

export function ScanShell({
  eyebrow,
  title,
  workerName,
  onLogout,
  onBack,
  list,
  detail,
}: ScanShellProps) {
  const twoPane = list != null;

  return (
    <div className="min-h-screen flex flex-col bg-surface-muted">
      {/* Dark canon header band (mockup .top / .dt — deep navy = accent). */}
      <header className="bg-accent text-white">
        <div className="mx-auto flex w-full max-w-[1180px] items-center gap-3 px-4 py-3 lg:px-6">
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
            {eyebrow && (
              <p className="eyebrow !text-white/70">{eyebrow}</p>
            )}
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

      {/* Body */}
      {twoPane ? (
        <div className="mx-auto w-full max-w-[1180px] flex-1 lg:grid lg:grid-cols-[minmax(280px,360px)_1fr]">
          {/* Left = list slot. On desktop: scrollable, right divider. */}
          <aside className="border-b border-border bg-surface-muted lg:overflow-y-auto lg:border-b-0 lg:border-r">
            {list}
          </aside>
          {/* Right = detail slot. */}
          <main className="flex min-w-0 flex-1 flex-col bg-surface lg:overflow-y-auto">
            {detail}
          </main>
        </div>
      ) : (
        <main className="flex flex-1 items-center justify-center px-4 py-8">
          {detail}
        </main>
      )}
    </div>
  );
}
