import { describe, it, expect } from "vitest";
import { effectiveLineShifts, lineDueAt, lineExtraShifts, MAX_LINE_SHIFTS, RENTAL_SHIFT_MS } from "../src/lineShifts";

// Конец брони — ровный час от «сейчас»: календарные даты в тестах не зашиваем.
const END = Math.ceil(Date.now() / 3_600_000) * 3_600_000;

describe("смены строки брони", () => {
  it("без своего числа смен строка идёт с бронью", () => {
    expect(effectiveLineShifts(1, null)).toBe(1);
    expect(effectiveLineShifts(3, undefined)).toBe(3);
    expect(lineDueAt(END, 1, null)).toBe(END);
  });

  it("2 смены на брони в 1 смену — ждём сутками позже, в то же время", () => {
    expect(effectiveLineShifts(1, 2)).toBe(2);
    expect(lineExtraShifts(1, 2)).toBe(1);
    expect(lineDueAt(new Date(END), 1, 2)).toBe(END + RENTAL_SHIFT_MS);
  });

  it("своё число не больше смен брони — строка не короче брони", () => {
    expect(effectiveLineShifts(3, 2)).toBe(3);
    expect(effectiveLineShifts(3, 3)).toBe(3);
    expect(lineDueAt(END, 3, 2)).toBe(END);
  });

  it("продление брони догоняет строку: действующее — большее из двух", () => {
    // Строка на 3 смены, бронь продлили до 4 — строка просто идёт с бронью.
    expect(effectiveLineShifts(4, 3)).toBe(4);
    expect(lineExtraShifts(4, 3)).toBe(0);
  });
});

describe("предел своих смен", () => {
  it("значение больше MAX_LINE_SHIFTS обрезается до предела", () => {
    expect(effectiveLineShifts(1, MAX_LINE_SHIFTS + 40)).toBe(MAX_LINE_SHIFTS);
    expect(lineDueAt(0, 1, MAX_LINE_SHIFTS + 40)).toBe((MAX_LINE_SHIFTS - 1) * RENTAL_SHIFT_MS);
  });
  it("бронь длиннее предела идёт своими сменами", () => {
    expect(effectiveLineShifts(MAX_LINE_SHIFTS + 5, 2)).toBe(MAX_LINE_SHIFTS + 5);
  });
});
