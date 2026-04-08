export type CalendarEvent = {
  id: string;
  bookingId: string;
  resourceId: string;
  title: string;
  clientName: string;
  start: string;
  end: string;
  quantity: number;
  status: string;
};

type OccupancyEntry = {
  occupied: number;
  bookings: CalendarEvent[];
};

/**
 * Извлекает дату (YYYY-MM-DD) из ISO-строки без учёта часового пояса.
 * API отдаёт даты вида "2025-03-06T23:59:59.000Z"; берём только дату.
 */
function isoToDateStr(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Прибавляет один день к строке YYYY-MM-DD без использования Date (timezone-safe).
 */
function addOneDayStr(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00Z"); // полдень UTC — не переходит дату
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Строит карту занятости: Map<`${resourceId}-${dateStr}`, OccupancyEntry>
 * Для каждого события итерирует каждый день, который оно охватывает,
 * и суммирует quantity в соответствующую ячейку.
 */
export function buildOccupancyMap(
  events: CalendarEvent[],
  periodStart: string,
  periodEnd: string
): Map<string, OccupancyEntry> {
  const map = new Map<string, OccupancyEntry>();

  for (const event of events) {
    const eventStartStr = isoToDateStr(event.start);
    const eventEndStr = isoToDateStr(event.end);

    // Итерируем по дням от начала до конца события
    let dateStr = eventStartStr;
    while (dateStr <= eventEndStr) {
      if (dateStr >= periodStart && dateStr <= periodEnd) {
        const key = `${event.resourceId}-${dateStr}`;
        const entry = map.get(key) ?? { occupied: 0, bookings: [] };
        if (event.status !== "DRAFT") {
          entry.occupied += event.quantity;
        }
        entry.bookings.push(event);
        map.set(key, entry);
      }
      dateStr = addOneDayStr(dateStr);
    }
  }

  return map;
}
