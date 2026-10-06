/**
 * Свои смены позиции в форме брони (мокап docs/mockups/line-shifts-continuation/
 * m1-form-shifts.html) — без React.
 *
 * У позиции каталога может быть своё число смен «не меньше N»: бронь на одну
 * смену, а пару приборов берут на двое суток. Действующее число смен строки —
 * большее из своего и смен брони (общая арифметика — `@light-rental/shared`,
 * та же, что на сервере). Значение хранится как ввели: продлят бронь — строка
 * пойдёт вместе с ней, ничего не обнуляется.
 */
import { MAX_LINE_SHIFTS, effectiveLineShifts, lineDueAt } from "@light-rental/shared";

import { pluralize } from "../../../lib/format";

export { MAX_LINE_SHIFTS, effectiveLineShifts, lineDueAt };

/**
 * Ввод в ячейке «Смен»: только целые 1…60. Пусто или 0 — как у брони (null),
 * больше предела — предел.
 */
export function parseShiftsInput(raw: string): number | null {
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return null;
  const n = Number(digits);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(MAX_LINE_SHIFTS, Math.floor(n));
}

/** Значение из сохранённого черновика или ответа сервера: мусор — как у брони. */
export function sanitizeLineShifts(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return null;
  return Math.min(MAX_LINE_SHIFTS, value);
}

/** Строка длиннее брони: своё значение больше смен брони. */
export function isLongLine(bookingShifts: number, lineShifts: number | null | undefined): boolean {
  return effectiveLineShifts(bookingShifts, lineShifts) > bookingShifts;
}

export const shiftsWord = (n: number) => pluralize(n, "смена", "смены", "смен");
export const shiftsWordAcc = (n: number) => pluralize(n, "смену", "смены", "смен");
const positionsWord = (n: number) => pluralize(n, "позиция", "позиции", "позиций");

/**
 * Подпись «2 позиции на 2 смены» для шапки и итога состава. Строк с разными
 * сроками несколько — по каждому сроку своя часть: «2 позиции на 2 смены ·
 * 1 позиция на 3 смены». Нет длинных строк — null.
 */
export function longLinesSummary(
  lines: Iterable<{ shifts?: number | null }>,
  bookingShifts: number,
): string | null {
  const byShifts = new Map<number, number>();
  for (const l of lines) {
    if (!isLongLine(bookingShifts, l.shifts)) continue;
    const eff = effectiveLineShifts(bookingShifts, l.shifts);
    byShifts.set(eff, (byShifts.get(eff) ?? 0) + 1);
  }
  if (byShifts.size === 0) return null;
  return Array.from(byShifts.entries())
    .sort(([a], [b]) => a - b)
    .map(([shifts, count]) => `${count} ${positionsWord(count)} на ${shifts} ${shiftsWordAcc(shifts)}`)
    .join(" · ");
}

/**
 * Сколько позиций длиннее брони и когда их ждут. `lineShifts` — общее число
 * смен, если у всех длинных строк оно одно (тогда и срок один), иначе null.
 */
export function longLinesInfo(
  lines: Iterable<{ shifts?: number | null }>,
  bookingShifts: number,
  bookingEndMs: number,
): { count: number; latestDueMs: number; lineShifts: number | null } | null {
  let count = 0;
  let latest = 0;
  const effective = new Set<number>();
  for (const l of lines) {
    if (!isLongLine(bookingShifts, l.shifts)) continue;
    count += 1;
    effective.add(effectiveLineShifts(bookingShifts, l.shifts));
    latest = Math.max(latest, lineDueAt(bookingEndMs, bookingShifts, l.shifts));
  }
  if (count === 0) return null;
  return { count, latestDueMs: latest, lineShifts: effective.size === 1 ? [...effective][0] : null };
}

function parts(ms: number, opts: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat("ru-RU", { ...opts, hourCycle: "h23" }).formatToParts(new Date(ms));
}
const pick = (p: Intl.DateTimeFormatPart[], t: Intl.DateTimeFormatPartTypes) => p.find((x) => x.type === t)?.value ?? "";

/**
 * «ср 10:00» — подпись срока у строки. Время — как в полях дат формы (часовой
 * пояс браузера): срок строки считается от того же «Возврата».
 */
export function formatDueShort(ms: number): string {
  const p = parts(ms, { weekday: "short", hour: "2-digit", minute: "2-digit" });
  return `${pick(p, "weekday")} ${pick(p, "hour")}:${pick(p, "minute")}`;
}

/** «ср 14 окт. 10:00» — срок в плашке и шторке. */
export function formatDueLong(ms: number): string {
  const p = parts(ms, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const month = pick(p, "month").replace(/\.$/, "");
  return `${pick(p, "weekday")} ${pick(p, "day")} ${month}. ${pick(p, "hour")}:${pick(p, "minute")}`;
}

/** «вт 13 окт. к 10:00» — когда ждём бронь и длинные позиции (плашка состава). */
export function formatDueBy(ms: number): string {
  const p = parts(ms, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const month = pick(p, "month").replace(/\.$/, "");
  return `${pick(p, "weekday")} ${pick(p, "day")} ${month}. к ${pick(p, "hour")}:${pick(p, "minute")}`;
}

/** «на ср» — день, на который не хватает склада. */
export function formatDueDay(ms: number): string {
  return pick(parts(ms, { weekday: "short" }), "weekday");
}

/** Период брони для шторки смен: «пн 12 окт. 10:00 → вт 13 окт. 10:00». */
export function periodLabelOf(pickupISO: string | null | undefined, returnISO: string | null | undefined): string | null {
  if (!pickupISO || !returnISO) return null;
  const start = Date.parse(pickupISO);
  const end = Date.parse(returnISO);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return `${formatDueLong(start)} → ${formatDueLong(end)}`;
}
