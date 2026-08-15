import { describe, it, expect } from "vitest";

import {
  formatCompact,
  getQuickPeriod,
  matchesPreset,
  shiftEnd,
  summarizePeriod,
} from "../catalogPeriod";

function localValue(daysFromToday: number, hour: number, now = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysFromToday, hour, 0);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  return `${y}-${m}-${day}T${h}:00`;
}

describe("getQuickPeriod", () => {
  it("«Сегодня» — сегодня 10:00 → завтра 10:00", () => {
    const r = getQuickPeriod("today");
    expect(r.start).toBe(localValue(0, 10));
    expect(r.end).toBe(localValue(1, 10));
  });

  it("«Завтра» — завтра 10:00 → послезавтра 10:00", () => {
    const r = getQuickPeriod("tomorrow");
    expect(r.start).toBe(localValue(1, 10));
    expect(r.end).toBe(localValue(2, 10));
  });

  it("«Неделя» — понедельник 10:00 → воскресенье 22:00 текущей недели", () => {
    // Среда: середина недели, обе границы очевидны.
    const wednesday = new Date(2026, 7, 12, 15, 30);
    const r = getQuickPeriod("week", wednesday);
    const s = new Date(r.start);
    const e = new Date(r.end);

    expect(s.getDay()).toBe(1);
    expect(s.getHours()).toBe(10);
    expect(e.getDay()).toBe(0);
    expect(e.getHours()).toBe(22);
    expect(s.getTime()).toBeLessThanOrEqual(wednesday.getTime());
    expect(e.getTime()).toBeGreaterThan(wednesday.getTime());
  });

  it("«Неделя» в воскресенье берёт ТЕКУЩУЮ неделю, а не следующую", () => {
    // Регрессия: getDay() === 0 у воскресенья, наивный (1 - 0) уводил бы
    // понедельник на день вперёд — неделя начиналась бы завтра.
    const sunday = new Date(2026, 7, 16, 12, 0);
    expect(sunday.getDay()).toBe(0);

    const r = getQuickPeriod("week", sunday);
    const s = new Date(r.start);
    expect(s.getDay()).toBe(1);
    expect(s.getTime()).toBeLessThan(sunday.getTime());
  });
});

describe("summarizePeriod", () => {
  it("сутки — «1 смена», 24 ч", () => {
    const r = summarizePeriod("2026-08-11T10:00", "2026-08-12T10:00");
    expect(r).toEqual({ shiftsLabel: "1 смена", hoursLabel: "24 ч" });
  });

  it("двое суток — «2 смены»", () => {
    expect(summarizePeriod("2026-08-11T10:00", "2026-08-13T10:00")?.shiftsLabel).toBe("2 смены");
  });

  it("пять суток — «5 смен» (плюрализация many)", () => {
    expect(summarizePeriod("2026-08-11T10:00", "2026-08-16T10:00")?.shiftsLabel).toBe("5 смен");
  });

  it("неполные сутки округляются вверх до смены, но часы показываются как есть", () => {
    const r = summarizePeriod("2026-08-11T10:00", "2026-08-11T15:00");
    expect(r).toEqual({ shiftsLabel: "1 смена", hoursLabel: "5 ч" });
  });

  it("конец не позже начала → null (подпись не выдумывается)", () => {
    expect(summarizePeriod("2026-08-12T10:00", "2026-08-11T10:00")).toBeNull();
    expect(summarizePeriod("2026-08-11T10:00", "2026-08-11T10:00")).toBeNull();
  });

  it("пустые даты (первый кадр до сидинга) → null", () => {
    expect(summarizePeriod("", "")).toBeNull();
    expect(summarizePeriod("2026-08-11T10:00", "")).toBeNull();
  });

  it("недопечатанная дата не роняет подпись", () => {
    expect(summarizePeriod("2026-08-11T10:00", "2026-08-0")).toBeNull();
  });
});

describe("formatCompact", () => {
  it("«11.08 10:00»", () => {
    expect(formatCompact("2026-08-11T10:00")).toBe("11.08 10:00");
  });

  it("мусор не рушит рендер", () => {
    expect(formatCompact("не дата")).toBe("—");
    expect(formatCompact("")).toBe("—");
  });
});

describe("shiftEnd", () => {
  it("+24 ч добавляет сутки", () => {
    expect(shiftEnd("2026-08-12T10:00", 24)).toBe("2026-08-13T10:00");
  });

  it("−24 ч убирает сутки", () => {
    expect(shiftEnd("2026-08-12T10:00", -24)).toBe("2026-08-11T10:00");
  });

  it("невалидную дату возвращает как есть", () => {
    expect(shiftEnd("нет", 24)).toBe("нет");
  });
});

describe("matchesPreset", () => {
  it("точное совпадение обеих границ", () => {
    const r = getQuickPeriod("today");
    expect(matchesPreset(r.start, r.end, "today")).toBe(true);
  });

  it("сдвинутый конец снимает активность пресета", () => {
    const r = getQuickPeriod("today");
    expect(matchesPreset(r.start, shiftEnd(r.end, 24), "today")).toBe(false);
  });
});
