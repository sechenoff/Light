"use client";

/**
 * Operation picker — canon port of the original
 * `apps/web/app/warehouse/scan/page.tsx` `OperationStep`.
 *
 * Three tap targets:
 *  - «Выдача» (ISSUE)   — load equipment to the client (creates ISSUE session)
 *  - «Возврат» (RETURN) — receive equipment back (creates RETURN session)
 *  - «В работе» (IN_WORK, read-only view) — what's currently with clients
 *
 * `IN_WORK` is a frontend-only view mode — no scan session is created. The
 * page-level state handles the routing: IN_WORK → InWorkList → InWorkDetails →
 * (optional) «Принять обратно» that flips into RETURN.
 */

import type { ScanOperation } from "./types";

export type ScanViewMode = ScanOperation | "IN_WORK";

export function OperationStep({
  onSelect,
}: {
  onSelect: (mode: ScanViewMode) => void;
}) {
  return (
    <div className="w-full max-w-[420px]">
      <p className="eyebrow mb-4">Что вы делаете сейчас?</p>

      <button
        type="button"
        onClick={() => onSelect("ISSUE")}
        className="mb-3 block w-full rounded-lg border border-accent-border bg-accent-soft p-5 text-left transition-colors hover:bg-surface active:opacity-80"
      >
        <span className="mb-2 block text-3xl" aria-hidden="true">
          📤
        </span>
        <span className="block font-cond text-[22px] font-bold text-accent-bright">
          Выдача
        </span>
        <span className="mt-1 block text-sm text-ink-2">
          Загрузить оборудование клиенту
        </span>
      </button>

      <button
        type="button"
        onClick={() => onSelect("RETURN")}
        className="mb-3 block w-full rounded-lg border border-teal-border bg-teal-soft p-5 text-left transition-colors hover:bg-surface active:opacity-80"
      >
        <span className="mb-2 block text-3xl" aria-hidden="true">
          📥
        </span>
        <span className="block font-cond text-[22px] font-bold text-teal">
          Возврат
        </span>
        <span className="mt-1 block text-sm text-ink-2">
          Принять оборудование от клиента
        </span>
      </button>

      <button
        type="button"
        onClick={() => onSelect("IN_WORK")}
        className="mb-3 block w-full rounded-lg border border-border-strong bg-surface p-5 text-left transition-colors hover:bg-surface-muted active:opacity-80"
      >
        <span className="mb-2 block text-3xl" aria-hidden="true">
          📋
        </span>
        <span className="block font-cond text-[22px] font-bold text-ink">
          В работе
        </span>
        <span className="mt-1 block text-sm text-ink-2">
          Посмотреть, что сейчас у клиентов
        </span>
      </button>

      <div className="mt-4 rounded-lg border border-dashed border-border-strong bg-surface p-3 text-center text-xs text-ink-2">
        Нужно зарегистрировать поломку без возврата?{" "}
        <a href="/repair" className="font-medium text-accent-bright">
          Открыть мастерскую →
        </a>
      </div>
    </div>
  );
}
