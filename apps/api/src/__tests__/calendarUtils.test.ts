/**
 * Unit tests for buildOccupancyMap (pure logic used in /calendar page)
 * Тесты для buildOccupancyMap — вычисление занятости по дням
 */

import { describe, it, expect } from "vitest";
import { buildOccupancyMap, type CalendarEvent } from "../../../../apps/web/src/lib/calendarUtils";

describe("buildOccupancyMap", () => {
  it("возвращает пустой Map для пустого массива событий", () => {
    const map = buildOccupancyMap([], "2025-03-01", "2025-03-07");
    expect(map.size).toBe(0);
  });

  it("добавляет запись для однодневного события", () => {
    const events: CalendarEvent[] = [
      {
        id: "e1",
        bookingId: "b1",
        resourceId: "r1",
        title: "Проект",
        clientName: "Клиент",
        start: "2025-03-03T00:00:00.000Z",
        end: "2025-03-03T23:59:59.000Z",
        quantity: 2,
        status: "CONFIRMED",
      },
    ];
    const map = buildOccupancyMap(events, "2025-03-01", "2025-03-07");
    const entry = map.get("r1-2025-03-03");
    expect(entry).toBeDefined();
    expect(entry!.occupied).toBe(2);
    expect(entry!.bookings).toHaveLength(1);
  });

  it("распределяет многодневное событие по всем дням диапазона", () => {
    const events: CalendarEvent[] = [
      {
        id: "e2",
        bookingId: "b2",
        resourceId: "r2",
        title: "Длинный проект",
        clientName: "Клиент 2",
        start: "2025-03-04T00:00:00.000Z",
        end: "2025-03-06T23:59:59.000Z",
        quantity: 3,
        status: "CONFIRMED",
      },
    ];
    const map = buildOccupancyMap(events, "2025-03-01", "2025-03-07");
    expect(map.get("r2-2025-03-04")?.occupied).toBe(3);
    expect(map.get("r2-2025-03-05")?.occupied).toBe(3);
    expect(map.get("r2-2025-03-06")?.occupied).toBe(3);
    // Дни вне события не должны быть в карте для этого ресурса
    expect(map.get("r2-2025-03-07")).toBeUndefined();
  });

  it("суммирует занятость от нескольких событий на одном ресурсе в один день", () => {
    const events: CalendarEvent[] = [
      {
        id: "e3a",
        bookingId: "b3a",
        resourceId: "r3",
        title: "Проект А",
        clientName: "Клиент А",
        start: "2025-03-05T00:00:00.000Z",
        end: "2025-03-05T23:59:59.000Z",
        quantity: 1,
        status: "CONFIRMED",
      },
      {
        id: "e3b",
        bookingId: "b3b",
        resourceId: "r3",
        title: "Проект Б",
        clientName: "Клиент Б",
        start: "2025-03-05T00:00:00.000Z",
        end: "2025-03-05T23:59:59.000Z",
        quantity: 2,
        status: "CONFIRMED",
      },
    ];
    const map = buildOccupancyMap(events, "2025-03-01", "2025-03-07");
    const entry = map.get("r3-2025-03-05");
    expect(entry?.occupied).toBe(3);
    expect(entry?.bookings).toHaveLength(2);
  });

  it("обрезает события, выходящие за пределы диапазона", () => {
    const events: CalendarEvent[] = [
      {
        id: "e4",
        bookingId: "b4",
        resourceId: "r4",
        title: "Выходит за рамки",
        clientName: "Клиент 4",
        start: "2025-02-28T00:00:00.000Z",
        end: "2025-03-03T23:59:59.000Z",
        quantity: 1,
        status: "CONFIRMED",
      },
    ];
    const map = buildOccupancyMap(events, "2025-03-01", "2025-03-07");
    // До 1 марта — за пределами, не должны быть в карте
    expect(map.get("r4-2025-02-28")).toBeUndefined();
    expect(map.get("r4-2025-03-01")?.occupied).toBe(1);
    expect(map.get("r4-2025-03-03")?.occupied).toBe(1);
  });
});
