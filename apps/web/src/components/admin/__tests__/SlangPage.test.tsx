/**
 * Tests for the Slang Dictionary page data-fetching and filtering behaviour.
 * We test through a thin helper (not the full page) to avoid router/auth deps.
 */
import { describe, it, expect } from "vitest";

// ── Types (duplicated subset for tests) ───────────────────────────────────────
type SlangAlias = {
  id: string;
  phraseNormalized: string;
  phraseOriginal: string;
  equipmentId: string;
  confidence: number;
  source: string;
  createdAt: string;
  usageCount: number;
  lastUsedAt: string;
  equipment: { name: string; category: string };
};

type DictionaryGroup = {
  equipment: { id: string; name: string; category: string };
  aliases: SlangAlias[];
  aliasCount: number;
};

// ── Pure helpers (extracted here to be unit-testable) ─────────────────────────

function flattenGroups(groups: DictionaryGroup[]): SlangAlias[] {
  return groups.flatMap((g) => g.aliases);
}

type FilterKey = "all" | "confirmed" | "pending" | "auto" | "manual";

function filterAliases(
  aliases: SlangAlias[],
  filter: FilterKey,
  search: string,
): SlangAlias[] {
  let result = aliases;

  if (filter === "confirmed") {
    result = result.filter(
      (a) => a.source === "manual" || a.source === "confirmed",
    );
  } else if (filter === "auto") {
    result = result.filter((a) => a.source === "auto");
  } else if (filter === "manual") {
    result = result.filter((a) => a.source === "manual");
  }
  // "pending" handled separately (from SlangCandidate), skip here

  if (search.trim()) {
    const q = search.toLowerCase();
    result = result.filter(
      (a) =>
        a.phraseNormalized.toLowerCase().includes(q) ||
        a.phraseOriginal.toLowerCase().includes(q) ||
        a.equipment.name.toLowerCase().includes(q),
    );
  }

  return result;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const alias1: SlangAlias = {
  id: "a1",
  phraseNormalized: "кин",
  phraseOriginal: "Кин",
  equipmentId: "e1",
  confidence: 0.9,
  source: "auto",
  createdAt: "2026-01-01T00:00:00Z",
  usageCount: 5,
  lastUsedAt: "2026-03-01T00:00:00Z",
  equipment: { name: "Kinoflo", category: "Свет" },
};

const alias2: SlangAlias = {
  id: "a2",
  phraseNormalized: "арри",
  phraseOriginal: "Арри",
  equipmentId: "e2",
  confidence: 0.95,
  source: "manual",
  createdAt: "2026-01-02T00:00:00Z",
  usageCount: 12,
  lastUsedAt: "2026-03-02T00:00:00Z",
  equipment: { name: "ARRI SkyPanel", category: "Свет" },
};

const alias3: SlangAlias = {
  id: "a3",
  phraseNormalized: "байер",
  phraseOriginal: "Байер",
  equipmentId: "e3",
  confidence: 0.7,
  source: "auto",
  createdAt: "2026-01-03T00:00:00Z",
  usageCount: 2,
  lastUsedAt: "2026-02-01T00:00:00Z",
  equipment: { name: "Bayer filter", category: "Оптика" },
};

const groups: DictionaryGroup[] = [
  { equipment: { id: "e1", name: "Kinoflo", category: "Свет" }, aliases: [alias1], aliasCount: 1 },
  { equipment: { id: "e2", name: "ARRI SkyPanel", category: "Свет" }, aliases: [alias2], aliasCount: 1 },
  { equipment: { id: "e3", name: "Bayer filter", category: "Оптика" }, aliases: [alias3], aliasCount: 1 },
];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("flattenGroups", () => {
  it("flattens all aliases from all groups into a single array", () => {
    const flat = flattenGroups(groups);
    expect(flat).toHaveLength(3);
    expect(flat.map((a) => a.id)).toEqual(["a1", "a2", "a3"]);
  });

  it("returns empty array for empty groups", () => {
    expect(flattenGroups([])).toEqual([]);
  });
});

describe("filterAliases", () => {
  it("returns all aliases for filter=all with no search", () => {
    const result = filterAliases([alias1, alias2, alias3], "all", "");
    expect(result).toHaveLength(3);
  });

  it("filters to auto-learned aliases only", () => {
    const result = filterAliases([alias1, alias2, alias3], "auto", "");
    expect(result.map((a) => a.id)).toEqual(["a1", "a3"]);
  });

  it("filters to manually added aliases only", () => {
    const result = filterAliases([alias1, alias2, alias3], "manual", "");
    expect(result.map((a) => a.id)).toEqual(["a2"]);
  });

  it("filters by phrase search (case-insensitive)", () => {
    const result = filterAliases([alias1, alias2, alias3], "all", "кин");
    expect(result.map((a) => a.id)).toEqual(["a1"]);
  });

  it("filters by equipment name search", () => {
    const result = filterAliases([alias1, alias2, alias3], "all", "arri");
    expect(result.map((a) => a.id)).toEqual(["a2"]);
  });

  it("combines source filter and search", () => {
    const result = filterAliases([alias1, alias2, alias3], "auto", "байер");
    expect(result.map((a) => a.id)).toEqual(["a3"]);
  });

  it("returns empty when no match", () => {
    const result = filterAliases([alias1, alias2, alias3], "all", "zzznomatch");
    expect(result).toHaveLength(0);
  });
});
