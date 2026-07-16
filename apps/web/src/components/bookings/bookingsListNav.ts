/**
 * bookingsListNav.ts — сохранение контекста списка броней между страницами.
 *
 * Проблема: со страницы брони «← К списку» вела на голый `/bookings`, теряя
 * фильтры (статус/даты/поиск), которые были активны. Список зеркалит фильтры
 * в свой URL, но карточка брони этого URL не знает. Решение — sessionStorage:
 * список запоминает свою query-строку, карточка читает её для back-ссылки и
 * пост-экшен редиректов (reject / архив).
 *
 * sessionStorage (не localStorage) — контекст живёт в пределах вкладки и не
 * протекает в новые сессии.
 */

const KEY = "lr:bookingsListQuery";

/** Запомнить текущую query-строку списка (вида `?status=CONFIRMED&q=…` или ``). */
export function rememberBookingsListQuery(search: string): void {
  try {
    window.sessionStorage.setItem(KEY, search);
  } catch {
    /* sessionStorage недоступен (private mode) — молча пропускаем */
  }
}

/** Ссылка на список с последними активными фильтрами (fallback — голый `/bookings`). */
export function readBookingsListHref(): string {
  try {
    const s = window.sessionStorage.getItem(KEY);
    return s ? `/bookings${s}` : "/bookings";
  } catch {
    return "/bookings";
  }
}
