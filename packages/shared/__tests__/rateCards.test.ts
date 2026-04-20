import { describe, it, expect } from "vitest";
import {
  RATE_CARDS,
  getRateCard,
  listPositions,
  progressiveOtCost,
} from "../src/rateCards";

describe("RATE_CARDS spot-checks", () => {
  it("rates_2024 gaffer shiftRate === 20000", () => {
    expect(RATE_CARDS.rates_2024.positions.gaffer.shiftRate).toBe(20000);
  });

  it("rates_2026 grip ot3Rate === 12800", () => {
    expect(RATE_CARDS.rates_2026.positions.grip.ot3Rate).toBe(12800);
  });
});

describe("listPositions", () => {
  it("returns 5 entries in exact order", () => {
    const positions = listPositions(RATE_CARDS.rates_2024);
    expect(positions).toHaveLength(5);
    const keys = positions.map((p) => p.key);
    expect(keys).toEqual(["gaffer", "key_grip", "best_boy", "programmer", "grip"]);
  });
});

describe("getRateCard", () => {
  it("returns null for 'custom'", () => {
    expect(getRateCard("custom")).toBeNull();
  });

  it("returns card for 'rates_2024'", () => {
    const card = getRateCard("rates_2024");
    expect(card).not.toBeNull();
    expect(card?.id).toBe("rates_2024");
  });

  it("returns null for unknown id", () => {
    // TypeScript cast required to test runtime guard
    expect(getRateCard("bogus" as "rates_2024")).toBeNull();
  });
});

describe("progressiveOtCost", () => {
  const card2024 = RATE_CARDS.rates_2024;
  const card2026 = RATE_CARDS.rates_2026;

  it("2024 / gaffer / 0 OT / 1 shift → base=20000, ot=0, total=20000", () => {
    // base = 1 * 20000 = 20000; ot = 0
    expect(progressiveOtCost(card2024, "gaffer", 0, 1)).toEqual({
      base: 20000,
      ot: 0,
      total: 20000,
    });
  });

  it("2024 / gaffer / 8 OT / 1 shift → base=20000, ot=32000, total=52000", () => {
    // ot = 8 * 4000 = 32000
    expect(progressiveOtCost(card2024, "gaffer", 8, 1)).toEqual({
      base: 20000,
      ot: 32000,
      total: 52000,
    });
  });

  it("2024 / gaffer / 14 OT / 1 shift → base=20000, ot=80000, total=100000", () => {
    // ot = 8*4000 + 6*8000 = 32000 + 48000 = 80000
    expect(progressiveOtCost(card2024, "gaffer", 14, 1)).toEqual({
      base: 20000,
      ot: 80000,
      total: 100000,
    });
  });

  it("2024 / gaffer / 17 OT / 2 shifts → base=40000, ot=128000, total=168000", () => {
    // base = 2 * 20000 = 40000
    // ot = 8*4000 + 6*8000 + 3*16000 = 32000 + 48000 + 48000 = 128000
    expect(progressiveOtCost(card2024, "gaffer", 17, 2)).toEqual({
      base: 40000,
      ot: 128000,
      total: 168000,
    });
  });

  it("2026 / grip / 10 OT / 1 shift → base=14400, ot=38400, total=52800", () => {
    // ot = 8*3200 + 2*6400 = 25600 + 12800 = 38400
    expect(progressiveOtCost(card2026, "grip", 10, 1)).toEqual({
      base: 14400,
      ot: 38400,
      total: 52800,
    });
  });

  it("negative/zero guard: OT=-5, shifts=0 → base=0, ot=0, total=0", () => {
    expect(progressiveOtCost(card2026, "grip", -5, 0)).toEqual({
      base: 0,
      ot: 0,
      total: 0,
    });
  });
});
