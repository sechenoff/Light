/**
 * Tests for billableShifts24h "не считать вторые сутки" grace logic.
 * Чекбокс прощает хвост ≤ 4 ч сверх целых суток (округление вниз).
 */

import { describe, it, expect } from "vitest";
import { billableShifts24h, SECOND_DAY_GRACE_MS, MS_PER_RENTAL_SHIFT } from "../utils/dates";

const H = 60 * 60 * 1000;
const base = new Date("2026-05-21T00:00:00.000Z");
const plus = (ms: number) => new Date(base.getTime() + ms);

describe("billableShifts24h — default (no grace)", () => {
  it("exactly 24h → 1 shift", () => {
    expect(billableShifts24h(base, plus(24 * H))).toBe(1);
  });
  it("25h → 2 shifts (ceil)", () => {
    expect(billableShifts24h(base, plus(25 * H))).toBe(2);
  });
  it("26h → 2 shifts (ceil)", () => {
    expect(billableShifts24h(base, plus(26 * H))).toBe(2);
  });
  it("48h → 2 shifts", () => {
    expect(billableShifts24h(base, plus(48 * H))).toBe(2);
  });
  it("zero/negative → 0", () => {
    expect(billableShifts24h(base, base)).toBe(0);
    expect(billableShifts24h(plus(H), base)).toBe(0);
  });
});

describe("billableShifts24h — skipPartialDay=true (grace ≤ 4h)", () => {
  it("25h → 1 shift (1h over, forgiven)", () => {
    expect(billableShifts24h(base, plus(25 * H), true)).toBe(1);
  });
  it("26h → 1 shift (2h over, forgiven — user's example)", () => {
    expect(billableShifts24h(base, plus(26 * H), true)).toBe(1);
  });
  it("28h → 1 shift (exactly 4h over = grace boundary, forgiven)", () => {
    expect(billableShifts24h(base, plus(28 * H), true)).toBe(1);
  });
  it("29h → 2 shifts (5h over, exceeds grace — billed normally)", () => {
    expect(billableShifts24h(base, plus(29 * H), true)).toBe(2);
  });
  it("exactly 24h → 1 shift (no remainder, unchanged)", () => {
    expect(billableShifts24h(base, plus(24 * H), true)).toBe(1);
  });
  it("50h → 2 shifts (2h over 48h, forgiven: 5d+2h pattern)", () => {
    expect(billableShifts24h(base, plus(50 * H), true)).toBe(2);
  });
  it("53h → 3 shifts (5h over 48h, exceeds grace)", () => {
    expect(billableShifts24h(base, plus(53 * H), true)).toBe(3);
  });
  it("3h total → 1 shift (floor would be 0, clamped to min 1)", () => {
    expect(billableShifts24h(base, plus(3 * H), true)).toBe(1);
  });
  it("grace constant is 4 hours", () => {
    expect(SECOND_DAY_GRACE_MS).toBe(4 * H);
    expect(MS_PER_RENTAL_SHIFT).toBe(24 * H);
  });
});
