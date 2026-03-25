const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function parseISODateToUTC(dateStr: string): Date {
  // Expecting YYYY-MM-DD
  const [y, m, d] = dateStr.split("-").map((v) => Number(v));
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1, 0, 0, 0, 0));
  if (Number.isNaN(dt.getTime())) throw new Error(`Invalid date: ${dateStr}`);
  return dt;
}

/** 24 часа = 1 смена (биллинг). */
export const MS_PER_RENTAL_SHIFT = 24 * 60 * 60 * 1000;

/**
 * Граница периода брони: только дата YYYY-MM-DD или полная ISO-дата/время.
 * Для устаревших запросов «только дата»: начало — 00:00 UTC, конец — 23:59:59.999 UTC этого дня.
 */
export function parseBookingRangeBound(input: string, role: "start" | "end"): Date {
  const s = input.trim();
  if (ISO_DATE_ONLY.test(s)) {
    const [y, m, d] = s.split("-").map((v) => Number(v));
    const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1, 0, 0, 0, 0));
    if (Number.isNaN(dt.getTime())) throw new Error(`Invalid date: ${input}`);
    if (role === "start") return dt;
    return new Date(Date.UTC(y, (m || 1) - 1, d || 1, 23, 59, 59, 999));
  }
  const t = new Date(s);
  if (Number.isNaN(t.getTime())) throw new Error(`Invalid datetime: ${input}`);
  return t;
}

export function assertBookingRangeOrder(start: Date, end: Date) {
  if (end.getTime() <= start.getTime()) {
    throw new Error("Конец аренды должен быть позже начала");
  }
}

/** Округление вверх до целых смен по 24 ч, минимум 1 смена при положительной длительности. */
export function billableShifts24h(start: Date, end: Date): number {
  const ms = end.getTime() - start.getTime();
  if (ms <= 0) return 0;
  return Math.max(1, Math.ceil(ms / MS_PER_RENTAL_SHIFT));
}

export function formatRentalDurationDetails(start: Date, end: Date): {
  shifts: number;
  totalHours: number;
  labelShort: string;
} {
  const ms = end.getTime() - start.getTime();
  const shifts = billableShifts24h(start, end);
  const totalHours = ms / (60 * 60 * 1000);
  const fullDays = Math.floor(ms / MS_PER_RENTAL_SHIFT);
  const remAfterDays = ms % MS_PER_RENTAL_SHIFT;
  const wholeHoursRemainder = Math.floor(remAfterDays / (60 * 60 * 1000));
  const minutesRemainder = Math.round((remAfterDays % (60 * 60 * 1000)) / (60 * 1000));

  const parts: string[] = [];
  if (fullDays > 0) parts.push(`${fullDays} сут.`);
  if (wholeHoursRemainder > 0) parts.push(`${wholeHoursRemainder} ч.`);
  if (fullDays === 0 && wholeHoursRemainder === 0 && minutesRemainder > 0) {
    parts.push(`${minutesRemainder} мин.`);
  }
  const durationPart = parts.length > 0 ? parts.join(" ") : "менее 1 ч.";

  const shiftWord = pluralShiftWord(shifts);
  const labelShort = `${durationPart} · ${shifts} ${shiftWord} (по 24 ч)`;
  return { shifts, totalHours, labelShort };
}

function pluralShiftWord(shifts: number): string {
  if (shifts % 10 === 1 && shifts % 100 !== 11) return "смена";
  if (shifts % 10 >= 2 && shifts % 10 <= 4 && (shifts % 100 < 10 || shifts % 100 >= 20)) return "смены";
  return "смен";
}

/** Строка для блока «Просчёт часов сметы» в PDF/XLSX (с заделом на авто по датам). */
export function formatExportHourCalculationLine(start: Date, end: Date): string {
  const ms = end.getTime() - start.getTime();
  const shifts = billableShifts24h(start, end);
  const fullDays = Math.floor(ms / MS_PER_RENTAL_SHIFT);
  const remAfterDays = ms % MS_PER_RENTAL_SHIFT;
  const wholeHoursRemainder = Math.floor(remAfterDays / (60 * 60 * 1000));
  const minutesRemainder = Math.round((remAfterDays % (60 * 60 * 1000)) / (60 * 1000));

  const parts: string[] = [];
  if (fullDays > 0) parts.push(`${fullDays} сут.`);
  if (wholeHoursRemainder > 0) parts.push(`${wholeHoursRemainder} ч.`);
  if (fullDays === 0 && wholeHoursRemainder === 0 && minutesRemainder > 0) {
    parts.push(`${minutesRemainder} мин.`);
  }
  const durationPart = parts.length > 0 ? parts.join(" ") : "менее 1 ч.";
  const w = pluralShiftWord(shifts);
  return `${shifts} ${w} = 24 ч. · ${durationPart} · ${shifts} ${w} (по 24 ч)`;
}

export function normalizeDateRangeInclusive(start: Date, end: Date): { start: Date; end: Date } {
  const s = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate(), 0, 0, 0, 0));
  const e = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate(), 0, 0, 0, 0));
  if (e.getTime() < s.getTime()) throw new Error("End date must be >= start date");
  return { start: s, end: e };
}

export function diffDaysInclusive(start: Date, end: Date): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  const s = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const e = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  return Math.floor((e - s) / msPerDay) + 1;
}

