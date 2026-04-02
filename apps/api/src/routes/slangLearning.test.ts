import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock prisma before importing the module under test
const mockPrisma = {
  slangAlias: {
    findFirst: vi.fn(),
    upsert: vi.fn(),
    findMany: vi.fn(),
    delete: vi.fn(),
  },
  slangLearningCandidate: {
    findFirst: vi.fn(),
    create: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    update: vi.fn(),
    findMany: vi.fn(),
  },
};

vi.mock("../prisma", () => ({ prisma: mockPrisma }));
vi.mock("../services/equipmentMatcher", () => ({ norm: (s: string) => s.toLowerCase().replace(/[^a-zа-яё0-9\s]/gi, " ").replace(/\s+/g, " ").trim() }));

// Import after mocks are set up
import request from "supertest";
import express from "express";

let app: express.Express;

beforeEach(async () => {
  vi.clearAllMocks();
  // Re-import router freshly each time
  const { slangLearningRouter } = await import("./slangLearning");
  app = express();
  app.use(express.json());
  app.use("/", slangLearningRouter);
});

// ── Task 1: POST /propose → auto-approve ──────────────────────────────────────

describe("POST /propose — auto-approve", () => {
  it("upserts SlangAlias with source AUTO_LEARNED and creates APPROVED candidate", async () => {
    const aliasResult = {
      id: "alias-1",
      phraseNormalized: "шторм",
      phraseOriginal: "шторм",
      equipmentId: "eq-1",
      confidence: 0.9,
      source: "AUTO_LEARNED",
      usageCount: 1,
    };
    const candidateResult = {
      id: "cand-1",
      rawPhrase: "шторм",
      normalizedPhrase: "шторм",
      proposedEquipmentId: "eq-1",
      status: "APPROVED",
      confidence: 0.9,
    };

    mockPrisma.slangAlias.findMany.mockResolvedValue([]);
    mockPrisma.slangAlias.upsert.mockResolvedValue(aliasResult);
    mockPrisma.slangLearningCandidate.create.mockResolvedValue(candidateResult);

    const res = await request(app).post("/propose").send({
      rawPhrase: "шторм",
      proposedEquipmentId: "eq-1",
      confidence: 0.9,
    });

    expect(res.status).toBe(201);
    expect(res.body.autoApproved).toBe(true);
    expect(res.body.alias).toBeDefined();
    expect(res.body.candidate).toBeDefined();

    // Verify upsert was called with correct args
    expect(mockPrisma.slangAlias.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { phraseNormalized_equipmentId: { phraseNormalized: "шторм", equipmentId: "eq-1" } },
        create: expect.objectContaining({ source: "AUTO_LEARNED" }),
        update: expect.objectContaining({ usageCount: { increment: 1 } }),
      }),
    );

    // Verify candidate was created with APPROVED status
    expect(mockPrisma.slangLearningCandidate.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "APPROVED" }),
      }),
    );
  });

  it("returns 201 even when phrase has no equipmentId (unresolved phrase)", async () => {
    const candidateResult = {
      id: "cand-2",
      rawPhrase: "непонятное",
      normalizedPhrase: "непонятное",
      proposedEquipmentId: null,
      status: "APPROVED",
      confidence: 0.3,
    };

    mockPrisma.slangLearningCandidate.create.mockResolvedValue(candidateResult);

    const res = await request(app).post("/propose").send({
      rawPhrase: "непонятное",
      confidence: 0.3,
    });

    expect(res.status).toBe(201);
    // No alias upsert without equipmentId
    expect(mockPrisma.slangAlias.upsert).not.toHaveBeenCalled();
  });

  it("logs conflict when same phrase maps to different equipment (both aliases coexist)", async () => {
    // Two aliases with same phrase, different equipmentIds should both be created (upsert handles it)
    const alias1 = { id: "alias-1", phraseNormalized: "тысячник", equipmentId: "eq-1", source: "AUTO_LEARNED", usageCount: 3 };
    const alias2 = { id: "alias-2", phraseNormalized: "тысячник", equipmentId: "eq-2", source: "AUTO_LEARNED", usageCount: 1 };

    mockPrisma.slangAlias.upsert.mockResolvedValue(alias2);
    mockPrisma.slangLearningCandidate.create.mockResolvedValue({
      id: "cand-2",
      status: "APPROVED",
    });

    // Simulate existing aliases for same phrase (to trigger conflict detection)
    mockPrisma.slangAlias.findMany.mockResolvedValue([alias1]);

    const res = await request(app).post("/propose").send({
      rawPhrase: "тысячник",
      proposedEquipmentId: "eq-2",
      confidence: 0.8,
    });

    expect(res.status).toBe(201);
    expect(res.body.autoApproved).toBe(true);
    // Both aliases should coexist — upsert should still be called
    expect(mockPrisma.slangAlias.upsert).toHaveBeenCalled();
  });
});

// ── Task 2: GET /dictionary ────────────────────────────────────────────────────

describe("GET /dictionary — aliases grouped by equipment", () => {
  it("returns aliases grouped by equipment, sorted by aliasCount desc", async () => {
    mockPrisma.slangAlias.findMany.mockResolvedValue([
      { id: "a1", phraseNormalized: "шторм", phraseOriginal: "шторм", equipmentId: "eq-1", confidence: 1.0, source: "AUTO_LEARNED", usageCount: 5, equipment: { name: "Electric Storm XT52", category: "COB" } },
      { id: "a2", phraseNormalized: "пятьдва", phraseOriginal: "пять два", equipmentId: "eq-1", confidence: 1.0, source: "AUTO_LEARNED", usageCount: 2, equipment: { name: "Electric Storm XT52", category: "COB" } },
      { id: "a3", phraseNormalized: "нова", phraseOriginal: "нова", equipmentId: "eq-2", confidence: 0.9, source: "MANUAL_ADMIN", usageCount: 1, equipment: { name: "Nova P600", category: "LED Panel" } },
    ]);

    const res = await request(app).get("/dictionary");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // First group should be eq-1 (2 aliases) before eq-2 (1 alias)
    expect(res.body[0].equipment.id).toBe("eq-1");
    expect(res.body[0].aliasCount).toBe(2);
    expect(res.body[0].aliases).toHaveLength(2);
    expect(res.body[1].equipment.id).toBe("eq-2");
    expect(res.body[1].aliasCount).toBe(1);
  });
});

// ── Task 2: GET /dictionary/export ────────────────────────────────────────────

describe("GET /dictionary/export — flat JSON array", () => {
  it("returns flat array with correct fields", async () => {
    mockPrisma.slangAlias.findMany.mockResolvedValue([
      {
        id: "a1",
        phraseNormalized: "шторм",
        phraseOriginal: "Шторм",
        equipmentId: "eq-1",
        confidence: 1.0,
        source: "AUTO_LEARNED",
        usageCount: 5,
        equipment: { name: "Electric Storm XT52", category: "COB" },
      },
    ]);

    const res = await request(app).get("/dictionary/export");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const item = res.body[0];
    expect(item.phraseNormalized).toBe("шторм");
    expect(item.phraseOriginal).toBe("Шторм");
    expect(item.equipmentId).toBe("eq-1");
    expect(item.equipmentName).toBe("Electric Storm XT52");
    expect(item.source).toBe("AUTO_LEARNED");
    expect(item.confidence).toBe(1.0);
  });
});
