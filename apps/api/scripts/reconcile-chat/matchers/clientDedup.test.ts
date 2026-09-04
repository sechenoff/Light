import { describe, it, expect } from "vitest";
import { findDedupPairs, ClientForDedup } from "./clientDedup";

const sample: ClientForDedup[] = [
  { id: "c1", name: "Хакаги", bookingCount: 8 },
  { id: "c2", name: "Хокаге", bookingCount: 3 },
  { id: "c3", name: "Гена Белых", bookingCount: 13 },
  { id: "c4", name: "Гена", bookingCount: 0 },
  { id: "c5", name: "Романов Вова", bookingCount: 7 },
  { id: "c6", name: "Вова Митрофанов", bookingCount: 5 },
];

describe("findDedupPairs", () => {
  it("auto-merges Хакаги↔Хокаге (short, single token, distance 2)", () => {
    const pairs = findDedupPairs(sample);
    const auto = pairs.find((p) => p.auto);
    expect(auto).toBeDefined();
    expect(new Set([auto!.fromName, auto!.toName])).toEqual(new Set(["Хакаги", "Хокаге"]));
  });

  it("canonical is the one with more bookings", () => {
    const pairs = findDedupPairs(sample);
    const xPair = pairs.find((p) => p.fromName === "Хокаге" || p.toName === "Хокаге")!;
    expect(xPair.toName).toBe("Хакаги");
    expect(xPair.fromName).toBe("Хокаге");
  });

  it("Гена ↔ Гена Белых is suggested (not auto)", () => {
    const pairs = findDedupPairs(sample);
    const suggested = pairs.find((p) => p.fromName === "Гена" || p.toName === "Гена");
    expect(suggested).toBeDefined();
    expect(suggested!.auto).toBe(false);
  });

  it("does not pair Романов Вова with Вова Митрофанов", () => {
    const pairs = findDedupPairs(sample);
    expect(pairs.find((p) =>
      (p.fromName === "Романов Вова" && p.toName === "Вова Митрофанов") ||
      (p.fromName === "Вова Митрофанов" && p.toName === "Романов Вова")
    )).toBeUndefined();
  });
});
