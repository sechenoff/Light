/**
 * Форматирование для акта инвентаризации: московское время, склонения, знак
 * расхождения. Общее для PDF и XLSX, чтобы два файла одного акта не спорили в
 * мелочах («18.09 09:30» в одном и «18.09 06:30» в другом).
 *
 * Время — всегда московское. Москва живёт в UTC+3 без перехода на летнее
 * время, поэтому сдвиг фиксированный и не зависит ни от TZ сервера, ни от ICU
 * (сервер на проде в Амстердаме, CI — в UTC).
 */

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

const MONTHS_GENITIVE = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
];

export const NBSP = "\u00A0";
/** Настоящий минус, а не дефис: в колонке чисел дефис читается как тире. */
export const MINUS = "\u2212";

interface MoscowParts {
  year: number;
  month: number;
  day: number;
  hours: number;
  minutes: number;
}

function moscowParts(d: Date): MoscowParts {
  const shifted = new Date(d.getTime() + MSK_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    hours: shifted.getUTCHours(),
    minutes: shifted.getUTCMinutes(),
  };
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** «11.09» */
export function fmtDayMonth(d: Date): string {
  const p = moscowParts(d);
  return `${pad2(p.day)}.${pad2(p.month + 1)}`;
}

/** «18.09.2026» */
export function fmtDate(d: Date): string {
  const p = moscowParts(d);
  return `${pad2(p.day)}.${pad2(p.month + 1)}.${p.year}`;
}

/** «09:30» */
export function fmtTime(d: Date): string {
  const p = moscowParts(d);
  return `${pad2(p.hours)}:${pad2(p.minutes)}`;
}

/** «18.09 16:48» — для строки метаданных, где год и так в шапке. */
export function fmtShortDateTime(d: Date): string {
  return `${fmtDayMonth(d)} ${fmtTime(d)}`;
}

/** «18.09.2026 16:48» */
export function fmtDateTime(d: Date): string {
  return `${fmtDate(d)} ${fmtTime(d)}`;
}

/** «18 сентября 2026 г.» */
export function fmtDateLong(d: Date): string {
  const p = moscowParts(d);
  return `${p.day} ${MONTHS_GENITIVE[p.month]} ${p.year}${NBSP}г.`;
}

export function isSameMoscowDay(a: Date, b: Date): boolean {
  return fmtDate(a) === fmtDate(b);
}

export function pluralRu(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n);
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

/** «295 позиций» / «1 позиция» */
export function positionsLabel(n: number): string {
  return `${fmtInt(n)}${NBSP}${pluralRu(n, "позиция", "позиции", "позиций")}`;
}

/** «1 808» — разряды неразрывным пробелом (перенос внутри числа недопустим). */
export function fmtInt(n: number): string {
  const sign = n < 0 ? MINUS : "";
  return sign + String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
}

/** «+2» / «−3» / «0» */
export function signed(n: number): string {
  if (n > 0) return `+${fmtInt(n)}`;
  if (n < 0) return `${MINUS}${fmtInt(-n)}`;
  return "0";
}

/**
 * Окно счёта для строки метаданных: «09:30–16:05», если считали в один день с
 * датой акта; «17.09 09:30–16:05» — в другой день; «17.09 09:30 – 18.09 11:00»
 * — если счёт растянулся на несколько дней.
 */
export function fmtCountingWindow(from: Date, to: Date, docDate: Date): string {
  if (isSameMoscowDay(from, to)) {
    const range = fmtTime(from) === fmtTime(to) ? fmtTime(from) : `${fmtTime(from)}–${fmtTime(to)}`;
    return isSameMoscowDay(from, docDate) ? range : `${fmtDayMonth(from)} ${range}`;
  }
  return `${fmtShortDateTime(from)} – ${fmtShortDateTime(to)}`;
}
