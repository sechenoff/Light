import { describe, it, expect } from "vitest";
import { effectiveLineShifts, lineDueAt, lineExtraShifts, RENTAL_SHIFT_MS } from "../src/lineShifts";

const END = Date.UTC(2026, 9, 13, 7, 0); // вт 10:00 МСК

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
