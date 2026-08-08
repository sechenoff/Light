import { describe, it, expect } from "vitest";
import { extractSlangCandidates, ExtractInput } from "./extractor";

const input: ExtractInput[] = [
  { phrase: "Лантерн 120", equipmentId: "eq-lantern", equipmentName: "Lantern 120", msgId: 100, nameSubstringMatch: true },
  { phrase: "Лантерн 120", equipmentId: "eq-lantern", equipmentName: "Lantern 120", msgId: 200, nameSubstringMatch: true },
  { phrase: "Мбю 12",      equipmentId: "eq-mbu",     equipmentName: "MBU 12",      msgId: 300, nameSubstringMatch: false },
  { phrase: "1000с",       equipmentId: "eq-1000s",   equipmentName: "1000c",       msgId: 400, nameSubstringMatch: false },
  { phrase: "1000с",       equipmentId: "eq-other",   equipmentName: "Other",       msgId: 401, nameSubstringMatch: false },
];

describe("extractSlangCandidates", () => {
  it("aggregates duplicate (phrase, equipmentId) pairs", () => {
    const out = extractSlangCandidates(input);
    const lantern = out.find((c) => c.phraseOriginal === "Лантерн 120");
    expect(lantern!.supportCount).toBe(2);
    expect(lantern!.sourceMsgIds).toEqual([100, 200]);
  });

  it("auto-approves high-support + substring match (confidence ≥ 0.85)", () => {
    const out = extractSlangCandidates(input);
    const lantern = out.find((c) => c.phraseOriginal === "Лантерн 120");
    expect(lantern!.decision).toBe("AUTO");
    expect(lantern!.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it("low-support single occurrence → REVIEW", () => {
    const out = extractSlangCandidates(input);
    const mbu = out.find((c) => c.phraseOriginal === "Мбю 12");
    expect(mbu!.decision).toBe("REVIEW");
    expect(mbu!.confidence).toBeLessThan(0.85);
  });

  it("split phrase across two equipments → both REVIEW", () => {
    const out = extractSlangCandidates(input);
    const candidates = out.filter((c) => c.phraseOriginal === "1000с");
    expect(candidates.length).toBe(2);
    for (const c of candidates) expect(c.decision).toBe("REVIEW");
  });
});
