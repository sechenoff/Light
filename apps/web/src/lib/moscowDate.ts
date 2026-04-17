/**
 * Клиентское зеркало утилит apps/api/src/utils/moscowDate.ts.
 *
 * Московское время: Europe/Moscow, UTC+3, без перехода на летнее время.
 * Все даты типа "только дата" (date-only) хранятся как UTC полночь Москвы,
 * например: "2026-04-20" → 2026-04-19T21:00:00Z
 */

/**
 * Конвертирует Date в строку "YYYY-MM-DD" в московском часовом поясе.
 */
export function toMoscowDateString(d: Date): string {
  return d.toLocaleString("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

/**
 * Парсит строку "YYYY-MM-DD" как полночь по московскому времени (+03:00).
 * Выбрасывает Error, если формат некорректен.
 */
export function fromMoscowDateString(s: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`Некорректный формат даты: "${s}". Ожидается YYYY-MM-DD`);
  }
  const d = new Date(`${s}T00:00:00+03:00`);
  if (isNaN(d.getTime())) {
    throw new Error(`Некорректная дата: "${s}"`);
  }
  return d;
}

/**
 * Возвращает начало сегодняшнего дня по московскому времени как UTC Date.
 */
export function moscowTodayStart(): Date {
  const todayStr = toMoscowDateString(new Date());
  return fromMoscowDateString(todayStr);
}

/**
 * Прибавляет n дней к дате (по UTC миллисекундам).
 */
export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 24 * 60 * 60 * 1000);
}
