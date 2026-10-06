/**
 * Смены строки брони — общая арифметика для API и веба.
 *
 * У брони один период (startDate..endDate) и одно число смен B — его считает
 * billableShifts24h (24-часовые смены, «не считать вторые сутки»). Позиция может
 * взять своё число смен «не меньше N» (BookingItem.shifts): типичный случай —
 * бронь на 1 смену, а пару приборов берут на двое суток. Здесь только чистые
 * функции от уже посчитанного B, чтобы не держать вторую копию
 * billableShifts24h.
 *
 * Действующее число смен строки — max(своё, B): своё значение хранится как
 * ввели и при продлении брони не обнуляется, а когда срок брони его догоняет,
 * строка просто идёт со всей бронью. Меньше, чем у брони, не бывает: прибор
 * всё равно у клиента до конца брони.
 */

/** Длина смены проката — 24 часа. */
export const RENTAL_SHIFT_MS = 24 * 60 * 60 * 1000;

/**
 * Предел своего числа смен строки. Нужен и проверке ввода, и выборкам
 * занятости: бронь, чей период кончился раньше окна, ещё может держать
 * длинную позицию — но не дольше этого предела.
 */
export const MAX_LINE_SHIFTS = 60;

/** Действующее число смен строки: своё «не меньше N» или смены брони. */
export function effectiveLineShifts(bookingShifts: number, lineShifts: number | null | undefined): number {
  return lineShifts != null && lineShifts > bookingShifts ? lineShifts : bookingShifts;
}

/**
 * Сколько смен строка длится сверх брони: 0 у обычной строки и у строки,
 * чьё своё число смен не больше смен брони.
 */
export function lineExtraShifts(bookingShifts: number, lineShifts: number | null | undefined): number {
  return effectiveLineShifts(bookingShifts, lineShifts) - bookingShifts;
}

/**
 * Когда строку ждут обратно: конец брони плюс лишние смены по 24 ч. Время
 * возврата сохраняется (бронь до вт 10:00, строка на 2 смены вместо 1 — до ср
 * 10:00) и никогда не раньше конца брони.
 */
export function lineDueAt(
  endDate: Date | number,
  bookingShifts: number,
  lineShifts: number | null | undefined,
): number {
  const end = typeof endDate === "number" ? endDate : endDate.getTime();
  return end + lineExtraShifts(bookingShifts, lineShifts) * RENTAL_SHIFT_MS;
}
