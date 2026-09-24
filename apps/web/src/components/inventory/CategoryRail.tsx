"use client";

/**
 * Левая карточка «Счёта» (мокап, экран 1 `aside`): шапка сессии, общий
 * прогресс, «расхождений пока» и рейл категорий — готово ✓ / в работе /
 * не начато, кто считает, сколько расхождений.
 */

import { useState } from "react";

import { pluralize } from "../../lib/format";
import { discrepancyCount, fmtDayTime, positions, scopeLabel } from "./format";
import type { StockCountCategory, StockCountDetail } from "./types";
import { CARD, CARD_TITLE, FOCUS } from "./ui";

/** Сколько категорий показывать до «ещё N». */
const RAIL_LIMIT = 14;

type CategoryState = "done" | "progress" | "idle";

function stateOf(c: StockCountCategory): CategoryState {
  if (c.lines > 0 && c.counted >= c.lines) return "done";
  return c.counted > 0 ? "progress" : "idle";
}

export function ProgressBar({ value, total, tone = "accent" }: { value: number; total: number; tone?: "accent" | "emerald" }) {
  const ratio = total > 0 ? Math.min(1, value / total) : 0;
  return (
    <div
      className="relative mt-1.5 h-1.5 overflow-hidden rounded-sm bg-surface-subtle"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={value}
    >
      <span
        className={`absolute inset-0 origin-left rounded-sm ${tone === "emerald" ? "bg-emerald" : "bg-accent-bright"}`}
        style={{ transform: `scaleX(${ratio})` }}
      />
    </div>
  );
}

export function CategoryRail({
  detail,
  selected,
  onSelect,
}: {
  detail: StockCountDetail;
  selected: string | null;
  onSelect: (category: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const cats = detail.categoryProgress;
  const discrepancies = discrepancyCount(detail.totals);
  const hasCounters = detail.counters.length > 0;

  const collapsed = !expanded && cats.length > RAIL_LIMIT;
  const head = collapsed ? cats.slice(0, RAIL_LIMIT - 1) : cats;
  const hidden = collapsed ? cats.slice(RAIL_LIMIT - 1) : [];
  // Выбранная категория видна всегда, даже если она в свёрнутом хвосте.
  const pinned = hidden.find((c) => c.category === selected);
  const rest = hidden.filter((c) => c !== pinned);
  const restLines = rest.reduce((s, c) => s + c.lines, 0);
  const restCounted = rest.reduce((s, c) => s + c.counted, 0);

  return (
    <aside className={CARD} aria-label="Прогресс по категориям">
      {/* До xl рейл стоит сразу под шапкой страницы, где номер, охват и время уже
          написаны, — здесь остаются только считающие (их шапка не показывает). */}
      <div className={`border-b border-border px-3.5 py-2.5 ${hasCounters ? "" : "hidden xl:block"}`}>
        <h3 className={`${CARD_TITLE} hidden xl:block`}>Инвентаризация № {detail.number}</h3>
        <p className="text-[11.5px] text-ink-2 xl:mt-px">
          <span className="hidden xl:inline">
            {scopeLabel(detail.categories)} · начата {fmtDayTime(detail.startedAt)}
            {hasCounters ? " · " : ""}
          </span>
          {hasCounters && (
            <>
              <span className="xl:hidden">считают </span>
              {detail.counters.join(", ")}
            </>
          )}
        </p>
      </div>

      <div className="border-b border-border px-3.5 py-2.5">
        <div className="flex items-baseline justify-between text-xs text-ink-2">
          <span>посчитано</span>
          <span>
            <b className="mono-num text-[15px] text-ink">{detail.totals.counted}</b> из {detail.totals.lines}
          </span>
        </div>
        <ProgressBar value={detail.totals.counted} total={detail.totals.lines} />
        <div className="mt-1.5 flex items-baseline justify-between text-xs text-ink-2">
          <span>расхождений пока</span>
          <span className={`mono-num font-semibold ${discrepancies > 0 ? "text-rose" : "text-ink-3"}`}>
            {discrepancies}
          </span>
        </div>
        {detail.unitModeExcluded > 0 && (
          <p className="mt-1.5 text-[11px] leading-snug text-ink-3">
            {positions(detail.unitModeExcluded)} со штучным учётом{" "}
            {pluralize(detail.unitModeExcluded, "сверяется", "сверяются", "сверяются")} в карточке единиц
          </p>
        )}
      </div>

      <ul className="flex flex-col">
        {[...head, ...(pinned ? [pinned] : [])].map((c) => (
          <li key={c.category} className="border-b border-border last:border-b-0">
            <RailItem category={c} selected={c.category === selected} onSelect={onSelect} />
          </li>
        ))}
        {rest.length > 0 && (
          <li>
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className={`grid w-full grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-[7px] px-3.5 py-1.5 text-left text-[11.5px] text-ink-3 hover:bg-surface-muted hover:text-ink-2 ${FOCUS}`}
            >
              <span />
              <span className="truncate">
                ещё {rest.length} {pluralize(rest.length, "категория", "категории", "категорий")} ·{" "}
                {rest
                  .slice(0, 3)
                  .map((c) => c.category)
                  .join(", ")}
                {rest.length > 3 ? "…" : ""}
              </span>
              <span className="mono-num text-[11.5px]">
                {restCounted}/{restLines}
              </span>
            </button>
          </li>
        )}
      </ul>
    </aside>
  );
}

function RailItem({
  category: c,
  selected,
  onSelect,
}: {
  category: StockCountCategory;
  selected: boolean;
  onSelect: (category: string) => void;
}) {
  const state = stateOf(c);
  const stateLabel = state === "done" ? "посчитано" : state === "progress" ? "в работе" : "не начато";
  return (
    <button
      type="button"
      onClick={() => onSelect(c.category)}
      aria-current={selected ? "true" : undefined}
      aria-label={`${c.category}: ${stateLabel}, ${c.counted} из ${c.lines}${
        c.discrepancies > 0 ? `, расхождений ${c.discrepancies}` : ""
      }`}
      className={`grid w-full grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-[7px] px-3.5 py-1.5 text-left text-[12.5px] transition-colors ${
        selected ? "bg-accent-soft font-semibold text-ink" : "text-ink hover:bg-surface-muted"
      } ${FOCUS} focus-visible:outline-offset-[-2px]`}
    >
      <StateDot state={state} />
      <span className="min-w-0 truncate">
        {c.category}
        {c.counters.length > 0 && (
          <small className="ml-1 text-[11px] font-normal text-ink-3">{c.counters.join(", ")}</small>
        )}
      </span>
      <span className={`mono-num whitespace-nowrap text-[11.5px] font-normal ${state === "done" ? "text-emerald" : "text-ink-2"}`}>
        {c.counted}/{c.lines}
        {c.discrepancies > 0 && (
          <span className="ml-1 text-[10.5px] font-semibold text-rose">{c.discrepancies} расх.</span>
        )}
      </span>
    </button>
  );
}

function StateDot({ state }: { state: CategoryState }) {
  if (state === "done") {
    return (
      <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-emerald text-surface" aria-hidden="true">
        <svg viewBox="0 0 24 24" className="h-[9px] w-[9px]" fill="none" stroke="currentColor" strokeWidth={3}>
          <path d="m5 12 5 5L20 7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  }
  if (state === "progress") {
    return (
      <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full border-[1.5px] border-accent-bright" aria-hidden="true">
        <span className="h-1.5 w-1.5 rounded-full bg-accent-bright" />
      </span>
    );
  }
  return <span className="h-3.5 w-3.5 rounded-full border-[1.5px] border-border-strong" aria-hidden="true" />;
}
