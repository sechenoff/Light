import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-units.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-for-units";

let app: Express;

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../.."),
    env: {
      ...process.env,
      DATABASE_URL: `file:${TEST_DB_PATH}`,
      PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes",
    },
    stdio: "pipe",
  });

  const mod = await import("../app");
  app = mod.app;
});

afterAll(async () => {
  const { prisma } = await import("../prisma");
  await prisma.$disconnect();

  for (const suffix of ["", "-wal", "-shm"]) {
    const f = TEST_DB_PATH + suffix;
    if (fs.existsSync(f)) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }
});

const AUTH = { "X-API-Key": "test-key-1" };

/**
 * Список категорий с уникальными аббревиатурами для штрихкодов.
 * Каждая категория из barcodeAbbrev CYRILLIC_ABBREV_MAP → уникальная 3-буквенная аббревиатура.
 * Ротируем по кругу, чтобы каждый тест получал свою категорию и избегал коллизий штрихкодов.
 */
const UNIQUE_CATEGORIES = [
  "led панели",        // → LED
  "галогенные приборы", // → HAL
  "гмн приборы",       // → HMI
  "фрезнели",          // → FRS
  "прожекторы",        // → PRJ
  "рефлекторы",        // → REF
  "флуоресцентные",    // → FLR
  "rgb",               // → RGB
  "матрицы",           // → MTX
  "пятно",             // → SPT
  "заливка",           // → FLD
  "прочее",            // → OTH
  "аксессуары",        // → ACC
  "штативы",           // → STD
  "кабели",            // → CBL
  "диффузоры",         // → DIF
  "генераторы",        // → GEN
  "кейсы",             // → CAS
  "сетки",             // → GRD
  "рамки",             // → FRM
];

let _equipCounter = 0;

/**
 * Создаёт оборудование с UNIT-режимом, возвращает id.
 * Каждый вызов использует уникальную категорию → уникальный префикс штрихкода
 * → нет коллизий при генерации первой единицы с seq=1.
 */
async function createUnitEquipment() {
  const category = UNIQUE_CATEGORIES[_equipCounter % UNIQUE_CATEGORIES.length];
  _equipCounter++;
  const name = `TestEq-${_equipCounter}`;
  const res = await request(app)
    .post("/api/equipment")
    .set(AUTH)
    .send({
      category,
      name,
      totalQuantity: 0,
      stockTrackingMode: "UNIT",
      rentalRatePerShift: 1000,
    });
  expect(res.status).toBe(200);
  return res.body.equipment.id as string;
}

// ─────────────────────────────────────────────────────
// GET /api/equipment/:equipmentId/units
// ─────────────────────────────────────────────────────

describe("GET /api/equipment/:equipmentId/units", () => {
  it("returns empty array for equipment without units", async () => {
    const equipmentId = await createUnitEquipment();
    const res = await request(app)
      .get(`/api/equipment/${equipmentId}/units`)
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.units).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────
// POST /api/equipment/:equipmentId/units/generate
// ─────────────────────────────────────────────────────

describe("POST /api/equipment/:equipmentId/units/generate", () => {
  it("generates requested number of units", async () => {
    const equipmentId = await createUnitEquipment();
    const res = await request(app)
      .post(`/api/equipment/${equipmentId}/units/generate`)
      .set(AUTH)
      .send({ count: 3 });
    expect(res.status).toBe(201);
    expect(res.body.units).toHaveLength(3);
  });

  it("each generated unit has barcode and barcodePayload", async () => {
    const equipmentId = await createUnitEquipment();
    const res = await request(app)
      .post(`/api/equipment/${equipmentId}/units/generate`)
      .set(AUTH)
      .send({ count: 1 });
    expect(res.status).toBe(201);
    const unit = res.body.units[0];
    expect(unit.barcode).toBeDefined();
    expect(unit.barcodePayload).toBeDefined();
  });

  it("generated units appear in GET list", async () => {
    const equipmentId = await createUnitEquipment();
    await request(app)
      .post(`/api/equipment/${equipmentId}/units/generate`)
      .set(AUTH)
      .send({ count: 2 });
    const res = await request(app)
      .get(`/api/equipment/${equipmentId}/units`)
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.units).toHaveLength(2);
  });

  it("rejects count=0 with 400", async () => {
    const equipmentId = await createUnitEquipment();
    const res = await request(app)
      .post(`/api/equipment/${equipmentId}/units/generate`)
      .set(AUTH)
      .send({ count: 0 });
    expect(res.status).toBe(400);
  });

  it("rejects count>100 with 400", async () => {
    const equipmentId = await createUnitEquipment();
    const res = await request(app)
      .post(`/api/equipment/${equipmentId}/units/generate`)
      .set(AUTH)
      .send({ count: 101 });
    expect(res.status).toBe(400);
  });

  it("sequence numbers continue after existing units", async () => {
    const equipmentId = await createUnitEquipment();
    // Generate first batch
    const res1 = await request(app)
      .post(`/api/equipment/${equipmentId}/units/generate`)
      .set(AUTH)
      .send({ count: 2 });
    // Generate second batch
    const res2 = await request(app)
      .post(`/api/equipment/${equipmentId}/units/generate`)
      .set(AUTH)
      .send({ count: 1 });
    expect(res2.status).toBe(201);
    // Barcodes should be unique (no overlap)
    const allBarcodes = [
      ...res1.body.units.map((u: { barcode: string }) => u.barcode),
      ...res2.body.units.map((u: { barcode: string }) => u.barcode),
    ];
    const unique = new Set(allBarcodes);
    expect(unique.size).toBe(3);
  });

  it("accepts optional serialNumbers", async () => {
    const equipmentId = await createUnitEquipment();
    const res = await request(app)
      .post(`/api/equipment/${equipmentId}/units/generate`)
      .set(AUTH)
      .send({ count: 2, serialNumbers: ["SN-001", "SN-002"] });
    expect(res.status).toBe(201);
    const serials = res.body.units.map((u: { serialNumber: string | null }) => u.serialNumber);
    expect(serials).toContain("SN-001");
    expect(serials).toContain("SN-002");
  });
});

// ─────────────────────────────────────────────────────
// PATCH /api/equipment/:equipmentId/units/:unitId
// ─────────────────────────────────────────────────────

describe("PATCH /api/equipment/:equipmentId/units/:unitId", () => {
  it("updates comment on a unit", async () => {
    const equipmentId = await createUnitEquipment();
    const genRes = await request(app)
      .post(`/api/equipment/${equipmentId}/units/generate`)
      .set(AUTH)
      .send({ count: 1 });
    const unitId = genRes.body.units[0].id;

    const res = await request(app)
      .patch(`/api/equipment/${equipmentId}/units/${unitId}`)
      .set(AUTH)
      .send({ comment: "Требует проверки" });
    expect(res.status).toBe(200);
    expect(res.body.unit.comment).toBe("Требует проверки");
  });

  it("updates status to MAINTENANCE", async () => {
    const equipmentId = await createUnitEquipment();
    const genRes = await request(app)
      .post(`/api/equipment/${equipmentId}/units/generate`)
      .set(AUTH)
      .send({ count: 1 });
    const unitId = genRes.body.units[0].id;

    const res = await request(app)
      .patch(`/api/equipment/${equipmentId}/units/${unitId}`)
      .set(AUTH)
      .send({ status: "MAINTENANCE" });
    expect(res.status).toBe(200);
    expect(res.body.unit.status).toBe("MAINTENANCE");
  });

  it("returns 400 for invalid status value", async () => {
    const equipmentId = await createUnitEquipment();
    const genRes = await request(app)
      .post(`/api/equipment/${equipmentId}/units/generate`)
      .set(AUTH)
      .send({ count: 1 });
    const unitId = genRes.body.units[0].id;

    const res = await request(app)
      .patch(`/api/equipment/${equipmentId}/units/${unitId}`)
      .set(AUTH)
      .send({ status: "INVALID_STATUS" });
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────
// DELETE /api/equipment/:equipmentId/units/:unitId
// ─────────────────────────────────────────────────────

describe("DELETE /api/equipment/:equipmentId/units/:unitId", () => {
  it("deletes an AVAILABLE unit", async () => {
    const equipmentId = await createUnitEquipment();
    const genRes = await request(app)
      .post(`/api/equipment/${equipmentId}/units/generate`)
      .set(AUTH)
      .send({ count: 1 });
    const unitId = genRes.body.units[0].id;

    const res = await request(app)
      .delete(`/api/equipment/${equipmentId}/units/${unitId}`)
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("returns 409 when trying to delete non-AVAILABLE unit", async () => {
    const equipmentId = await createUnitEquipment();
    const genRes = await request(app)
      .post(`/api/equipment/${equipmentId}/units/generate`)
      .set(AUTH)
      .send({ count: 1 });
    const unitId = genRes.body.units[0].id;

    // Set status to MAINTENANCE
    await request(app)
      .patch(`/api/equipment/${equipmentId}/units/${unitId}`)
      .set(AUTH)
      .send({ status: "MAINTENANCE" });

    const res = await request(app)
      .delete(`/api/equipment/${equipmentId}/units/${unitId}`)
      .set(AUTH);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/AVAILABLE/);
  });
});

// ─────────────────────────────────────────────────────
// GET /api/equipment/:equipmentId/units/labels (PDF)
// ─────────────────────────────────────────────────────

describe("GET /api/equipment/:equipmentId/units/labels", () => {
  it("returns PDF with correct content-type", async () => {
    const equipmentId = await createUnitEquipment();
    await request(app)
      .post(`/api/equipment/${equipmentId}/units/generate`)
      .set(AUTH)
      .send({ count: 2 });

    const res = await request(app)
      .get(`/api/equipment/${equipmentId}/units/labels`)
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
    expect(res.headers["content-disposition"]).toMatch(`labels-${equipmentId}.pdf`);
  });

  it("returns 404 when no units with barcodes exist", async () => {
    const equipmentId = await createUnitEquipment();
    const res = await request(app)
      .get(`/api/equipment/${equipmentId}/units/labels`)
      .set(AUTH);
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────
// GET /api/equipment/:equipmentId/units/:unitId/label (PNG)
// ─────────────────────────────────────────────────────

describe("GET /api/equipment/:equipmentId/units/:unitId/label", () => {
  it("returns PNG for a unit with barcode", async () => {
    const equipmentId = await createUnitEquipment();
    const genRes = await request(app)
      .post(`/api/equipment/${equipmentId}/units/generate`)
      .set(AUTH)
      .send({ count: 1 });
    const unitId = genRes.body.units[0].id;

    const res = await request(app)
      .get(`/api/equipment/${equipmentId}/units/${unitId}/label`)
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/image\/png/);
  });

  it("returns 404 for non-existent unit", async () => {
    const equipmentId = await createUnitEquipment();
    const res = await request(app)
      .get(`/api/equipment/${equipmentId}/units/nonexistent-id/label`)
      .set(AUTH);
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────
// GET /api/equipment — unitStatusCounts for UNIT items
// ─────────────────────────────────────────────────────

describe("GET /api/equipment unitStatusCounts", () => {
  it("includes unitStatusCounts for UNIT-tracked equipment", async () => {
    const equipmentId = await createUnitEquipment();
    await request(app)
      .post(`/api/equipment/${equipmentId}/units/generate`)
      .set(AUTH)
      .send({ count: 3 });

    const res = await request(app).get("/api/equipment").set(AUTH);
    expect(res.status).toBe(200);
    const item = res.body.equipments.find((e: { id: string }) => e.id === equipmentId);
    expect(item).toBeDefined();
    expect(item.unitStatusCounts).toBeDefined();
    expect(item.unitStatusCounts.AVAILABLE).toBe(3);
  });

  it("unitStatusCounts is null for COUNT-tracked equipment", async () => {
    const res1 = await request(app)
      .post("/api/equipment")
      .set(AUTH)
      .send({
        category: "Тест",
        name: "COUNT-оборудование-уникальное",
        totalQuantity: 5,
        stockTrackingMode: "COUNT",
        rentalRatePerShift: 500,
      });
    const equipmentId = res1.body.equipment.id;

    const res = await request(app).get("/api/equipment").set(AUTH);
    const item = res.body.equipments.find((e: { id: string }) => e.id === equipmentId);
    expect(item).toBeDefined();
    expect(item.unitStatusCounts).toBeNull();
  });
});
