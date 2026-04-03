import { describe, it, expect } from "vitest";
import { splitHours, calcPersonCost, calculateCrewCost } from "../src/crewCalculator";
import { ROLES_BY_ID } from "../src/crewRates";

// ─── splitHours ───────────────────────────────────────────────────────────────

describe("splitHours", () => {
  it("0 hours → all zeros", () => {
    expect(splitHours(0)).toEqual({ shiftHours: 0, ot1Hours: 0, ot2Hours: 0, ot3Hours: 0 });
  });

  it("negative → treated as 0", () => {
    expect(splitHours(-5)).toEqual({ shiftHours: 0, ot1Hours: 0, ot2Hours: 0, ot3Hours: 0 });
  });

  it("5 hours → shift only, no OT", () => {
    expect(splitHours(5)).toEqual({ shiftHours: 5, ot1Hours: 0, ot2Hours: 0, ot3Hours: 0 });
  });

  it("10 hours → exactly one shift, no OT", () => {
    expect(splitHours(10)).toEqual({ shiftHours: 10, ot1Hours: 0, ot2Hours: 0, ot3Hours: 0 });
  });

  it("11 hours → shift + 1h tier1", () => {
    expect(splitHours(11)).toEqual({ shiftHours: 10, ot1Hours: 1, ot2Hours: 0, ot3Hours: 0 });
  });

  it("18 hours → shift + 8h tier1 (exactly fills tier1)", () => {
    expect(splitHours(18)).toEqual({ shiftHours: 10, ot1Hours: 8, ot2Hours: 0, ot3Hours: 0 });
  });

  it("19 hours → shift + 8h tier1 + 1h tier2", () => {
    expect(splitHours(19)).toEqual({ shiftHours: 10, ot1Hours: 8, ot2Hours: 1, ot3Hours: 0 });
  });

  it("24 hours → shift + 8h tier1 + 6h tier2 (fills tier2)", () => {
    expect(splitHours(24)).toEqual({ shiftHours: 10, ot1Hours: 8, ot2Hours: 6, ot3Hours: 0 });
  });

  it("25 hours → shift + 8h tier1 + 6h tier2 + 1h tier3", () => {
    expect(splitHours(25)).toEqual({ shiftHours: 10, ot1Hours: 8, ot2Hours: 6, ot3Hours: 1 });
  });

  it("example from spec: 13h → 10 shift + 3h tier1", () => {
    expect(splitHours(13)).toEqual({ shiftHours: 10, ot1Hours: 3, ot2Hours: 0, ot3Hours: 0 });
  });

  it("example from spec: 21h → 10 shift + 8h tier1 + 3h tier2", () => {
    expect(splitHours(21)).toEqual({ shiftHours: 10, ot1Hours: 8, ot2Hours: 3, ot3Hours: 0 });
  });

  it("example from spec: 27h → 10 shift + 8h tier1 + 6h tier2 + 3h tier3", () => {
    expect(splitHours(27)).toEqual({ shiftHours: 10, ot1Hours: 8, ot2Hours: 6, ot3Hours: 3 });
  });
});

// ─── calcPersonCost — Gaffer ──────────────────────────────────────────────────

describe("calcPersonCost — Gaffer", () => {
  const gaffer = ROLES_BY_ID.GAFFER;

  it("0 hours → full shift, no OT", () => {
    const r = calcPersonCost(gaffer, 0);
    expect(r.baseShiftCost).toBe(20_000);
    expect(r.overtimeTier1Cost).toBe(0);
    expect(r.totalPerPerson).toBe(20_000);
  });

  it("5 hours → full shift (min billing is 10h)", () => {
    const r = calcPersonCost(gaffer, 5);
    expect(r.baseShiftCost).toBe(20_000);
    expect(r.totalPerPerson).toBe(20_000);
  });

  it("10 hours → exactly the shift rate", () => {
    expect(calcPersonCost(gaffer, 10).totalPerPerson).toBe(20_000);
  });

  it("11 hours → shift + 1h × 4000", () => {
    const r = calcPersonCost(gaffer, 11);
    expect(r.overtimeTier1Hours).toBe(1);
    expect(r.overtimeTier1Cost).toBe(4_000);
    expect(r.totalPerPerson).toBe(24_000);
  });

  it("18 hours → shift + 8h × 4000", () => {
    const r = calcPersonCost(gaffer, 18);
    expect(r.overtimeTier1Hours).toBe(8);
    expect(r.overtimeTier1Cost).toBe(32_000);
    expect(r.overtimeTier2Cost).toBe(0);
    expect(r.totalPerPerson).toBe(52_000);
  });

  it("19 hours → shift + 8h tier1 + 1h tier2 × 8000", () => {
    const r = calcPersonCost(gaffer, 19);
    expect(r.overtimeTier1Hours).toBe(8);
    expect(r.overtimeTier1Cost).toBe(32_000);
    expect(r.overtimeTier2Hours).toBe(1);
    expect(r.overtimeTier2Cost).toBe(8_000);
    expect(r.totalPerPerson).toBe(60_000);
  });

  it("24 hours → shift + 8h tier1 + 6h tier2", () => {
    const r = calcPersonCost(gaffer, 24);
    expect(r.overtimeTier2Hours).toBe(6);
    expect(r.overtimeTier2Cost).toBe(48_000);
    expect(r.overtimeTier3Cost).toBe(0);
    expect(r.totalPerPerson).toBe(20_000 + 32_000 + 48_000);
  });

  it("25 hours → shift + 8h tier1 + 6h tier2 + 1h tier3 × 16000", () => {
    const r = calcPersonCost(gaffer, 25);
    expect(r.overtimeTier3Hours).toBe(1);
    expect(r.overtimeTier3Cost).toBe(16_000);
    expect(r.totalPerPerson).toBe(20_000 + 32_000 + 48_000 + 16_000);
  });
});

// ─── calcPersonCost — Grip ────────────────────────────────────────────────────

describe("calcPersonCost — Grip", () => {
  const grip = ROLES_BY_ID.GRIP;

  it("10 hours → 12000", () => {
    expect(calcPersonCost(grip, 10).totalPerPerson).toBe(12_000);
  });

  it("13 hours → 12000 + 3 × 2600 = 19800", () => {
    const r = calcPersonCost(grip, 13);
    expect(r.overtimeTier1Hours).toBe(3);
    expect(r.overtimeTier1Cost).toBe(7_800);
    expect(r.totalPerPerson).toBe(19_800);
  });

  it("21 hours → 12000 + 8×2600 + 3×5200 = 12000+20800+15600 = 48400", () => {
    const r = calcPersonCost(grip, 21);
    expect(r.overtimeTier1Cost).toBe(20_800);
    expect(r.overtimeTier2Cost).toBe(15_600);
    expect(r.totalPerPerson).toBe(48_400);
  });

  it("27 hours → 12000 + 8×2600 + 6×5200 + 3×10400", () => {
    const r = calcPersonCost(grip, 27);
    expect(r.overtimeTier3Hours).toBe(3);
    expect(r.overtimeTier3Cost).toBe(31_200);
    expect(r.totalPerPerson).toBe(12_000 + 20_800 + 31_200 + 31_200);
  });
});

// ─── calculateCrewCost ────────────────────────────────────────────────────────

describe("calculateCrewCost", () => {
  it("empty crew → grandTotal 0", () => {
    const r = calculateCrewCost({}, 10);
    expect(r.grandTotal).toBe(0);
    expect(r.lines).toHaveLength(0);
  });

  it("null hours → empty result", () => {
    const r = calculateCrewCost({ GAFFER: 1 }, null);
    expect(r.grandTotal).toBe(0);
    expect(r.lines).toHaveLength(0);
  });

  it("0 hours → full shift billing still applies", () => {
    const r = calculateCrewCost({ GAFFER: 1 }, 0);
    expect(r.grandTotal).toBe(20_000);
    expect(r.lines[0].totalForRole).toBe(20_000);
  });

  it("roles with count 0 are excluded", () => {
    const r = calculateCrewCost({ GAFFER: 0, GRIP: 2 }, 10);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0].role).toBe("GRIP");
  });

  it("multiple people in one role → totalForRole = totalPerPerson × count", () => {
    const r = calculateCrewCost({ GRIP: 4 }, 10);
    expect(r.lines[0].count).toBe(4);
    expect(r.lines[0].totalForRole).toBe(12_000 * 4);
    expect(r.grandTotal).toBe(48_000);
  });

  it("multiple roles → grandTotal is sum of all", () => {
    // Gaffer × 1 (10h): 20000
    // Grip × 2 (10h): 12000 × 2 = 24000
    const r = calculateCrewCost({ GAFFER: 1, GRIP: 2 }, 10);
    expect(r.grandTotal).toBe(44_000);
  });

  it("spec example: Gaffer × 1 working 21h", () => {
    // 10h base=20000, 8h×4000=32000, 3h×8000=24000 → 76000
    const r = calculateCrewCost({ GAFFER: 1 }, 21);
    expect(r.lines[0].totalForRole).toBe(76_000);
    expect(r.grandTotal).toBe(76_000);
  });

  it("spec example: Grip × 4 working 13h", () => {
    // 10h base=12000, 3h×2600=7800 → 19800 per person × 4 = 79200
    const r = calculateCrewCost({ GRIP: 4 }, 13);
    expect(r.lines[0].totalPerPerson).toBe(19_800);
    expect(r.lines[0].totalForRole).toBe(79_200);
  });

  it("roles appear in config order (GAFFER first, GRIP last)", () => {
    const r = calculateCrewCost({ GRIP: 1, GAFFER: 1, PROGRAMMER: 1 }, 10);
    expect(r.lines.map((l) => l.role)).toEqual(["GAFFER", "PROGRAMMER", "GRIP"]);
  });
});
