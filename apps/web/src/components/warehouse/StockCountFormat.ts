/**
 * Чистые подписи экрана счёта инвентаризации в киоске.
 *
 * Словарь — спека §1 (docs/superpowers/specs/2026-09-18-inventory-design.md):
 * «на полке должно быть», «сошлось», «недостача», «излишек», «Пересчитать».
 * Никаких кодов и штрихкодов. Минус — типографский «−» (U+2212), как в мокапе.
 */

import type {
  StockCountCategory,
  StockCountLineView,
} from "../inventory/types";

/** Верхняя граница счёта — та же, что у сервера (MAX_COUNT_QTY). */
export const MAX_COUNT_QTY = 100_000;

const MINUS = "−";

/**
 * Позиция в одном экземпляре — вместо степпера две большие кнопки
 * «✓ На месте» / «Нет на полке» (114 позиций из 295 на проде).
 */
export function isSingleUnitLine(line: StockCountLineView): boolean {
  return line.expected.total === 1;
}

export interface LineResult {
  text: string;
  tone: "emerald" | "rose";
}

/** Итог посчитанной строки; null — ещё не посчитана. */
export function lineResult(line: StockCountLineView): LineResult | null {
  if (line.countedQty == null || line.diff == null) return null;
  const { diff, countedQty } = line;
  if (diff === 0) {
    if (isSingleUnitLine(line) && countedQty === 1) {
      return { text: "✓ на месте · 1 из 1", tone: "emerald" };
    }
    return { text: `✓ сошлось · ${countedQty}`, tone: "emerald" };
  }
  if (diff < 0) {
    return { text: `${MINUS}${-diff} · решит руководитель после счёта`, tone: "rose" };
  }
  return { text: `+${diff} · излишек — решит руководитель`, tone: "emerald" };
}

export interface ExplanationPart {
  text: string;
  /** amber — «по календарю на съёмке»: без этой поправки позиция выглядела бы пропавшей. */
  tone: "muted" | "amber";
}

function calendarText(line: StockCountLineView): string {
  const qty = line.expected.calendar;
  const names = line.calendarBookings
    .map((b) => (b.projectName || b.clientName || "").trim())
    .filter((n) => n.length > 0);
  if (names.length === 0) return `${qty} на съёмке по календарю`;
  const shown = names.slice(0, 2).map((n) => `«${n}»`).join(", ");
  const rest = names.length > 2 ? ` и ещё ${names.length - 2}` : "";
  return `${qty} у ${shown}${rest} по календарю`;
}

/**
 * Пояснение под названием: «по учёту 6 шт», если с полки ничего не уходило,
 * иначе разбивка формулы «всего 41 · 6 у «Лето» по календарю».
 */
export function lineExplanation(line: StockCountLineView): ExplanationPart[] {
  const b = line.expected;
  const reduced = b.issued + b.calendar + b.repair + b.lost;
  if (reduced === 0) return [{ text: `по учёту ${b.total} шт`, tone: "muted" }];

  const parts: ExplanationPart[] = [{ text: `всего ${b.total}`, tone: "muted" }];
  if (b.issued > 0) parts.push({ text: `${b.issued} на съёмках`, tone: "muted" });
  if (b.calendar > 0) parts.push({ text: calendarText(line), tone: "amber" });
  if (b.repair > 0) parts.push({ text: `${b.repair} в мастерской`, tone: "muted" });
  if (b.lost > 0) parts.push({ text: `${b.lost} в потеряшках`, tone: "muted" });
  return parts;
}

export interface LinesSummary {
  lines: number;
  counted: number;
  matched: number;
  shortageQty: number;
  surplusQty: number;
}

/** Сводка по строкам участка — для метки «X / Y», прогресса и подвала. */
export function summarizeLines(lines: StockCountLineView[]): LinesSummary {
  return lines.reduce<LinesSummary>(
    (acc, l) => {
      if (l.countedQty == null || l.diff == null) return acc;
      return {
        ...acc,
        counted: acc.counted + 1,
        matched: acc.matched + (l.diff === 0 ? 1 : 0),
        shortageQty: acc.shortageQty + (l.diff < 0 ? -l.diff : 0),
        surplusQty: acc.surplusQty + (l.diff > 0 ? l.diff : 0),
      };
    },
    { lines: lines.length, counted: 0, matched: 0, shortageQty: 0, surplusQty: 0 },
  );
}

/** «считает: Иван» / «считают: Иван, Олег» / «посчитали: …» / «ещё не начинали». */
export function countersText(c: StockCountCategory): string {
  if (c.counters.length === 0) return "ещё не начинали";
  const names = c.counters.join(", ");
  if (c.lines > 0 && c.counted >= c.lines) return `посчитали: ${names}`;
  return c.counters.length === 1 ? `считает: ${names}` : `считают: ${names}`;
}

/** Строка с оптимистичным счётом — до ответа сервера. */
export function withCount(line: StockCountLineView, qty: number): StockCountLineView {
  return { ...line, countedQty: qty, diff: qty - line.expected.expected };
}

/** Строка после «Пересчитать» — до ответа сервера. */
export function withReset(line: StockCountLineView): StockCountLineView {
  return {
    ...line,
    countedQty: null,
    countedBy: null,
    countedAt: null,
    diff: null,
    decision: null,
    decisionNote: null,
    decidedBy: null,
    decidedAt: null,
  };
}

/** Ограничить ввод счёта: целое 0…MAX_COUNT_QTY. */
export function clampQty(qty: number): number {
  if (!Number.isFinite(qty)) return 0;
  return Math.min(MAX_COUNT_QTY, Math.max(0, Math.trunc(qty)));
}
