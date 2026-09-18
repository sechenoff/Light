"use client";

/**
 * Карточка «Идёт инвентаризация № N» на «Смене» — вход в счёт полки.
 *
 * Инвентаризация — редкое событие, поэтому у неё нет своей вкладки: пока она
 * идёт, карточка висит наверху «Смены» (мокап final-inventory.html, путь
 * «Смена» → «Идёт инвентаризация — ваш участок: Грип»).
 */

import type { StockCountDetail } from "../inventory/types";
import { pluralize } from "../../lib/format";

export function StockCountShiftCard({
  stockCount,
  workerName,
  onCount,
}: {
  stockCount: StockCountDetail;
  /** Кто на смене — чтобы подсказать «ваш участок». */
  workerName?: string;
  onCount: () => void;
}) {
  const { number, totals, categoryProgress } = stockCount;
  const allCounted = totals.lines > 0 && totals.counted >= totals.lines;
  const ratio = totals.lines > 0 ? Math.min(1, totals.counted / totals.lines) : 0;
  const mine = workerName
    ? categoryProgress.find((c) => c.counted < c.lines && c.counters.includes(workerName))
    : undefined;

  return (
    <section
      aria-label={`Идёт инвентаризация № ${number}`}
      className="rounded-lg border border-accent-border bg-surface shadow-xs"
    >
      <div className="flex flex-col gap-3 px-3.5 py-3 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <p className="eyebrow !text-accent-bright">Инвентаризация</p>
          <h3 className="font-cond text-[16px] font-bold leading-tight text-ink">
            Идёт инвентаризация № {number}
          </h3>
          <p className="mt-0.5 text-[12px] text-ink-2">
            посчитано <b className="mono-num text-ink">{totals.counted}</b> из{" "}
            <b className="mono-num text-ink">{totals.lines}</b>{" "}
            {pluralize(totals.lines, "позиции", "позиций", "позиций")}
            {allCounted
              ? " · всё посчитано, решения за руководителем"
              : mine
                ? ` · ваш участок: ${mine.category}`
                : ""}
          </p>
          <div
            role="progressbar"
            aria-label={`Посчитано ${totals.counted} из ${totals.lines}`}
            aria-valuemin={0}
            aria-valuemax={totals.lines}
            aria-valuenow={totals.counted}
            className="mt-2 h-1 overflow-hidden rounded-full bg-surface-subtle"
          >
            <div
              className="h-full origin-left bg-accent-bright"
              style={{ transform: `scaleX(${ratio})` }}
            />
          </div>
        </div>
        <button
          type="button"
          onClick={onCount}
          className="flex min-h-[44px] shrink-0 items-center justify-center rounded bg-accent-bright px-5 text-[14px] font-semibold text-surface transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-bright focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
        >
          {allCounted ? "Открыть →" : "Считать →"}
        </button>
      </div>
    </section>
  );
}
