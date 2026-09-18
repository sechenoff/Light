"use client";

/**
 * Пять плиток сводки «Итога» (мокап, экран 2 `.tiles`): посчитано, сошлось,
 * недостача, излишек, под вопросом ₽/смена. Разделители — через `gap-px` на
 * фоне границы, чтобы сетка 2 / 3 / 5 колонок не требовала подбора рамок.
 */

import { rubWhole } from "./format";
import type { StockCountTotals } from "./types";

function Tile({
  label,
  children,
  sub,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  sub: string;
  className?: string;
}) {
  return (
    <div className={`min-w-0 bg-surface px-3.5 py-2.5 ${className}`}>
      <p className="eyebrow">{label}</p>
      <div className="mono-num mt-0.5 text-xl font-semibold leading-tight tracking-[-0.015em]">{children}</div>
      <p className="mt-px text-[11.5px] leading-snug text-ink-3">{sub}</p>
    </div>
  );
}

function Unit({ children }: { children: React.ReactNode }) {
  return <small className="font-sans text-xs font-medium tracking-normal text-ink-2">{children}</small>;
}

export function SummaryTiles({
  totals,
  shortageDecided,
  surplusDecided,
  matchedNote,
  finished = false,
}: {
  totals: StockCountTotals;
  /** Решено недостач / излишков — из строк; null, пока строки грузятся. */
  shortageDecided: number | null;
  surplusDecided: number | null;
  matchedNote: string;
  /** Завершена / отменена — подписи в прошедшем времени. */
  finished?: boolean;
}) {
  const uncounted = totals.lines - totals.counted;
  const money = Number(totals.shortageRatePerShift);
  return (
    <section
      aria-label="Сводка"
      className="mt-2.5 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border shadow-xs md:grid-cols-3 xl:grid-cols-5"
    >
      <Tile
        label="Посчитано"
        sub={
          uncounted > 0
            ? `${uncounted} не посчитано — ${finished ? "остались" : "останутся"} «не сверены»`
            : "все позиции посчитаны"
        }
      >
        {totals.counted} <Unit>из {totals.lines}</Unit>
      </Tile>
      <Tile label="Сошлось" sub={matchedNote}>
        <span className="text-emerald">{totals.matched}</span>
      </Tile>
      <Tile
        label="Недостача"
        sub={
          totals.shortagePositions === 0
            ? "нет"
            : shortageDecided == null
              ? "…"
              : `решено ${shortageDecided} из ${totals.shortagePositions}`
        }
      >
        <span className="text-rose">{totals.shortagePositions}</span> <Unit>поз · {totals.shortageQty} шт</Unit>
      </Tile>
      <Tile
        label="Излишек"
        sub={
          totals.surplusPositions === 0
            ? "нет"
            : surplusDecided == null
              ? "…"
              : `решено ${surplusDecided} из ${totals.surplusPositions}`
        }
      >
        <span className="text-emerald">{totals.surplusPositions}</span> <Unit>поз · {totals.surplusQty} шт</Unit>
      </Tile>
      <Tile label="Под вопросом" sub="ставки позиций с недостачей" className="col-span-2 xl:col-span-1">
        ≈ {rubWhole(money)} ₽ <Unit>/смена</Unit>
      </Tile>
    </section>
  );
}
