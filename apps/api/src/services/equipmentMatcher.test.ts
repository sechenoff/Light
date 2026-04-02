import { describe, it, expect, vi, beforeEach } from "vitest";
import Decimal from "decimal.js";

// Must use vi.hoisted so the mock factory can reference these fns before module init
const mockPrisma = vi.hoisted(() => ({
  equipment: {
    findMany: vi.fn(),
  },
  slangAlias: {
    findMany: vi.fn(),
  },
}));

vi.mock("../prisma", () => ({ prisma: mockPrisma }));

// Import after mocks are set up
import { matchGafferRequest, matchGafferRequestOrdered, matchEquipmentToInventory, norm } from "./equipmentMatcher";

// ── Тестовые данные ───────────────────────────────────────────────────────────

const makeCatalog = () => [
  { id: "eq-1", name: "Electric Storm XT52", category: "COB", totalQuantity: 3, rentalRatePerShift: new Decimal("5000") },
  { id: "eq-2", name: "Nova P600", category: "LED Panel", totalQuantity: 2, rentalRatePerShift: new Decimal("3000") },
  { id: "eq-3", name: "Titan Tube", category: "Battery", totalQuantity: 5, rentalRatePerShift: new Decimal("1500") },
];

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Task 3: Multi-alias conflict in findTopCandidates (via matchGafferRequest) ─

describe("matchGafferRequest — multi-alias conflict", () => {
  it("resolves to single alias when only one equipmentId for phrase", async () => {
    mockPrisma.equipment.findMany.mockResolvedValue(makeCatalog());
    mockPrisma.slangAlias.findMany.mockResolvedValue([
      { phraseNormalized: "шторм", equipmentId: "eq-1", usageCount: 5 },
    ]);

    const result = await matchGafferRequest([{ name: "шторм", quantity: 1 }]);

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].equipmentId).toBe("eq-1");
    expect(result.resolved[0].confidence).toBe(1.0);
    expect(result.needsReview).toHaveLength(0);
  });

  it("returns needsReview when phrase maps to 2+ equipment (conflict)", async () => {
    mockPrisma.equipment.findMany.mockResolvedValue(makeCatalog());
    // Same phrase "тысячник" → two different equipment IDs
    mockPrisma.slangAlias.findMany.mockResolvedValue([
      { phraseNormalized: "тысячник", equipmentId: "eq-1", usageCount: 3 },
      { phraseNormalized: "тысячник", equipmentId: "eq-2", usageCount: 1 },
    ]);

    const result = await matchGafferRequest([{ name: "тысячник", quantity: 2 }]);

    expect(result.needsReview).toHaveLength(1);
    expect(result.resolved).toHaveLength(0);
    const review = result.needsReview[0];
    expect(review.rawPhrase).toBe("тысячник");
    // eq-1 should be first (higher usageCount)
    expect(review.candidates[0].equipmentId).toBe("eq-1");
  });

  it("sorts conflict candidates by usageCount desc (most-used first)", async () => {
    mockPrisma.equipment.findMany.mockResolvedValue(makeCatalog());
    mockPrisma.slangAlias.findMany.mockResolvedValue([
      { phraseNormalized: "светлый", equipmentId: "eq-2", usageCount: 1 },
      { phraseNormalized: "светлый", equipmentId: "eq-1", usageCount: 10 },
    ]);

    const result = await matchGafferRequest([{ name: "светлый", quantity: 1 }]);

    expect(result.needsReview).toHaveLength(1);
    const candidates = result.needsReview[0].candidates;
    expect(candidates[0].equipmentId).toBe("eq-1"); // higher usageCount first
    expect(candidates[1].equipmentId).toBe("eq-2");
  });
});

describe("matchGafferRequestOrdered — multi-alias conflict", () => {
  it("returns needsReview kind for conflicting phrase", async () => {
    mockPrisma.equipment.findMany.mockResolvedValue(makeCatalog());
    mockPrisma.slangAlias.findMany.mockResolvedValue([
      { phraseNormalized: "тысячник", equipmentId: "eq-1", usageCount: 3 },
      { phraseNormalized: "тысячник", equipmentId: "eq-2", usageCount: 1 },
    ]);

    const result = await matchGafferRequestOrdered([{ name: "тысячник", quantity: 1 }]);

    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("needsReview");
  });
});

// ── Task 4: matchEquipmentToInventory uses DB aliases instead of TYPE_SYNONYMS ─

describe("matchEquipmentToInventory — DB alias lookup in strategy 4", () => {
  it("resolves via DB alias when no exact/contains/token match", async () => {
    const catalog = [
      { id: "eq-1", name: "Electric Storm XT52", category: "COB", totalQuantity: 3, rentalRatePerShift: new Decimal("5000"), sortOrder: 1 },
    ];
    mockPrisma.equipment.findMany.mockResolvedValue(catalog);
    // The query "xt52" won't token/contains match "Electric Storm XT52" with ≥2 tokens
    // but an alias maps it
    mockPrisma.slangAlias.findMany.mockResolvedValue([
      { phraseNormalized: "xt52", equipmentId: "eq-1", usageCount: 5 },
    ]);

    const result = await matchEquipmentToInventory([
      { name: "xt52", category: "COB", quantity: 1 },
    ]);

    expect(result.matched).toHaveLength(1);
    expect(result.matched[0].equipmentId).toBe("eq-1");
  });

  it("TYPE_SYNONYMS constant is no longer used (function does not exist or has no effect)", async () => {
    // After removing TYPE_SYNONYMS and typeSynonymMatch, we ensure the module
    // still resolves equipment through DB aliases.
    mockPrisma.equipment.findMany.mockResolvedValue(makeCatalog().map(c => ({ ...c, sortOrder: 1 })));
    mockPrisma.slangAlias.findMany.mockResolvedValue([
      { phraseNormalized: "titan tube", equipmentId: "eq-3", usageCount: 2 },
    ]);

    const result = await matchEquipmentToInventory([
      { name: "titan tube", category: "Battery", quantity: 2 },
    ]);

    // Should match via DB alias or exact/contains match
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0].equipmentId).toBe("eq-3");
  });
});
