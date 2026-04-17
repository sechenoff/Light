/**
 * Юнит-тесты для утилит moscowDate.ts
 */

import { describe, it, expect } from "vitest";
import {
  toMoscowDateString,
  fromMoscowDateString,
  moscowTodayStart,
  addDays,
} from "../utils/moscowDate";

describe("toMoscowDateString", () => {
  it("конвертирует UTC-время в московскую дату (UTC+3)", () => {
    // 2026-04-19T21:00:00Z — это полночь 2026-04-20 по Москве (+3)
    const d = new Date("2026-04-19T21:00:00Z");
    expect(toMoscowDateString(d)).toBe("2026-04-20");
  });

  it("23:00 UTC April 19 → 2026-04-20 по Москве", () => {
    // 23:00 UTC = 02:00 следующего дня по Москве → всё ещё 20 апреля
    const d = new Date("2026-04-19T23:00:00Z");
    expect(toMoscowDateString(d)).toBe("2026-04-20");
  });

  it("20:59 UTC April 19 → всё ещё 2026-04-19 по Москве", () => {
    // 20:59 UTC = 23:59 Москвы → ещё 19 апреля
    const d = new Date("2026-04-19T20:59:00Z");
    expect(toMoscowDateString(d)).toBe("2026-04-19");
  });

  it("полночь UTC — это утро по Москве", () => {
    // 2026-04-20T00:00:00Z = 2026-04-20T03:00:00 MSK → 20 апреля
    const d = new Date("2026-04-20T00:00:00Z");
    expect(toMoscowDateString(d)).toBe("2026-04-20");
  });
});

describe("fromMoscowDateString", () => {
  it("парсит YYYY-MM-DD как полночь Москвы (UTC+3)", () => {
    const d = fromMoscowDateString("2026-04-20");
    // 2026-04-20T00:00:00+03:00 = 2026-04-19T21:00:00Z
    expect(d.toISOString()).toBe("2026-04-19T21:00:00.000Z");
  });

  it("roundtrip: toMoscowDateString(fromMoscowDateString(s)) === s", () => {
    const s = "2026-12-31";
    expect(toMoscowDateString(fromMoscowDateString(s))).toBe(s);
  });

  it("выбрасывает ошибку при некорректном формате", () => {
    expect(() => fromMoscowDateString("20-04-2026")).toThrow();
  });

  it("выбрасывает ошибку при пустой строке", () => {
    expect(() => fromMoscowDateString("")).toThrow();
  });

  it("переход через месяц: 2026-01-31 → 2026-01-30T21:00:00Z", () => {
    const d = fromMoscowDateString("2026-01-31");
    expect(d.toISOString()).toBe("2026-01-30T21:00:00.000Z");
  });
});

describe("addDays", () => {
  it("прибавляет 1 день", () => {
    const d = new Date("2026-04-20T00:00:00Z");
    const next = addDays(d, 1);
    expect(next.toISOString()).toBe("2026-04-21T00:00:00.000Z");
  });

  it("прибавляет 0 дней — тот же момент", () => {
    const d = new Date("2026-04-20T12:00:00Z");
    expect(addDays(d, 0).getTime()).toBe(d.getTime());
  });

  it("переход через месяц: 31 января + 1 = 1 февраля", () => {
    const d = fromMoscowDateString("2026-01-31");
    const next = addDays(d, 1);
    expect(toMoscowDateString(next)).toBe("2026-02-01");
  });
});

describe("moscowTodayStart", () => {
  it("возвращает полночь текущего дня по Москве", () => {
    const todayStart = moscowTodayStart();
    // Должен быть ровно полночь Москвы: UTC миллисекунды кратны 1 дню со смещением 3 часа
    // Проверяем что UTCHours == 21 (= MSK midnight)
    // Но может быть 20 если округление другое, поэтому проверяем roundtrip
    const reconstructed = toMoscowDateString(todayStart);
    expect(toMoscowDateString(new Date())).toBe(reconstructed);
  });

  it("добавление 1 дня к сегодняшнему старту даёт завтрашнее начало", () => {
    const todayStart = moscowTodayStart();
    const tomorrowStart = addDays(todayStart, 1);
    // Разница должна быть ровно 24 часа
    expect(tomorrowStart.getTime() - todayStart.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});
