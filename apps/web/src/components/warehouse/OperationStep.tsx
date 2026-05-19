"use client";

/**
 * Operation picker (ISSUE / RETURN) — canon port of the original
 * `apps/web/app/warehouse/scan/page.tsx` `OperationStep`. Behaviour identical
 * (two large tap targets, link to /repair); visuals are IBM Plex canon with
 * semantic tokens only. Rendered inside ScanShell's detail slot.
 */

import type { ScanOperation } from "./types";

export function OperationStep({
  onSelect,
}: {
  onSelect: (op: ScanOperation) => void;
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

      <div className="mt-4 rounded-lg border border-dashed border-border-strong bg-surface p-3 text-center text-xs text-ink-2">
        Нужно зарегистрировать поломку без возврата?{" "}
        <a href="/repair" className="font-medium text-accent-bright">
          Открыть мастерскую →
        </a>
      </div>
    </div>
  );
}
