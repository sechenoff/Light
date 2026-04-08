/**
 * Тесты для глобальных эндпоинтов equipment-units:
 * - GET /api/equipment-units (список с пагинацией)
 * - GET /api/equipment-units/lookup (поиск по штрихкоду)
 * - POST /api/equipment-units/labels (PDF-этикетки)
 * - POST /api/equipment/:id/units/:unitId/assign-barcode
 * - POST /api/equipment/:id/units/batch-assign
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-global-units.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-global-units";

let app: Express;
let prisma: any;

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
  const pmod = await import("../prisma");
  prisma = pmod.prisma;
});

afterAll(async () => {
  await prisma.$disconnect();
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = TEST_DB_PATH + suffix;
    if (fs.existsSync(f)) {
      try { fs.unlinkSync(f); } catch { /* игнорируем */ }
    }
  }
});

const AUTH = { "X-API-Key": "test-key-1" };

// ──────────────────────────────────────────────
// Вспомогательные функции
// ──────────────────────────────────────────────

let _catIdx = 0;
const CATEGORIES = [
  "led панели", "галогенные приборы", "гмн приборы", "фрезнели",
  "прожекторы", "рефлекторы", "флуоресцентные", "rgb",
];

async function createEquipment(mode: "UNIT" | "COUNT" = "UNIT") {
  const category = CATEGORIES[_catIdx % CATEGORIES.length];
  _catIdx++;
  const res = await request(app)
    .post("/api/equipment")
    .set(AUTH)
    .send({
      name: `ТестЕд-${_catIdx}`,
      category,
      totalQuantity: 0,
      stockTrackingMode: mode,
      rentalRatePerShift: 500,
    });
  expect(res.status).toBe(200);
  return res.body.equipment;
}

async function generateUnit(equipmentId: string) {
  const res = await request(app)
    .post(`/api/equipment/${equipmentId}/units/generate`)
    .set(AUTH)
    .send({ count: 1 });
  expect(res.status).toBe(201);
  return res.body.units[0] as { id: string; barcode: string; barcodePayload: string; status: string };
}

// ──────────────────────────────────────────────
// GET /api/equipment-units
// ──────────────────────────────────────────────

describe("GET /api/equipment-units", () => {
  it("returns paginated list", async () => {
    const equipment = await createEquipment();
    await generateUnit(equipment.id);

    const res = await request(app)
      .get("/api/equipment-units")
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("units");
    expect(res.body).toHaveProperty("total");
    expect(res.body).toHaveProperty("page");
    expect(res.body).toHaveProperty("totalPages");
    expect(Array.isArray(res.body.units)).toBe(true);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
  });

  it("supports hasBarcode=true filter", async () => {
    const res = await request(app)
      .get("/api/equipment-units?hasBarcode=true")
      .set(AUTH);
    expect(res.status).toBe(200);
    for (const u of res.body.units) {
      expect(u.barcode).not.toBeNull();
    }
  });

  it("supports status filter", async () => {
    const res = await request(app)
      .get("/api/equipment-units?status=AVAILABLE")
      .set(AUTH);
    expect(res.status).toBe(200);
    for (const u of res.body.units) {
      expect(u.status).toBe("AVAILABLE");
    }
  });

  it("each unit includes equipment info", async () => {
    const equipment = await createEquipment();
    await generateUnit(equipment.id);

    const res = await request(app)
      .get("/api/equipment-units")
      .set(AUTH);
    expect(res.status).toBe(200);
    for (const u of res.body.units) {
      expect(u.equipment).toBeDefined();
      expect(u.equipment.id).toBeDefined();
      expect(u.equipment.name).toBeDefined();
    }
  });
});

// ──────────────────────────────────────────────
// GET /api/equipment-units/lookup
// ──────────────────────────────────────────────

describe("GET /api/equipment-units/lookup", () => {
  it("resolves unit by HMAC barcodePayload", async () => {
    const equipment = await createEquipment();
    const unit = await generateUnit(equipment.id);

    const res = await request(app)
      .get(`/api/equipment-units/lookup?barcode=${unit.barcodePayload}`)
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.unit.id).toBe(unit.id);
    expect(res.body.hmacVerified).toBe(true);
    expect(res.body.equipment).toBeDefined();
  });

  it("returns 404 for unknown barcode", async () => {
    const res = await request(app)
      .get("/api/equipment-units/lookup?barcode=totally-unknown-barcode")
      .set(AUTH);
    expect(res.status).toBe(404);
  });

  it("returns 400 when barcode param is missing", async () => {
    const res = await request(app)
      .get("/api/equipment-units/lookup")
      .set(AUTH);
    expect(res.status).toBe(400);
  });
});

// ──────────────────────────────────────────────
// POST /api/equipment/:id/units/:unitId/assign-barcode
// ──────────────────────────────────────────────

describe("POST /api/equipment/:id/units/:unitId/assign-barcode", () => {
  it("assigns a custom barcode to a unit without one", async () => {
    const equipment = await createEquipment();
    // Create unit without barcode by direct DB insert
    const unit = await prisma.equipmentUnit.create({
      data: { equipmentId: equipment.id, status: "AVAILABLE" },
    });

    const res = await request(app)
      .post(`/api/equipment/${equipment.id}/units/${unit.id}/assign-barcode`)
      .set(AUTH)
      .send({ barcode: "MY-CUSTOM-001" });
    expect(res.status).toBe(200);
    expect(res.body.unit.barcode).toBe("MY-CUSTOM-001");
    expect(res.body.unit.barcodePayload).toBeTruthy();
  });

  it("rejects barcode with colon character", async () => {
    const equipment = await createEquipment();
    const unit = await prisma.equipmentUnit.create({
      data: { equipmentId: equipment.id, status: "AVAILABLE" },
    });

    const res = await request(app)
      .post(`/api/equipment/${equipment.id}/units/${unit.id}/assign-barcode`)
      .set(AUTH)
      .send({ barcode: "BAD:BARCODE" });
    expect(res.status).toBe(400);
  });

  it("rejects duplicate barcode with 409", async () => {
    const equipment = await createEquipment();

    // Unit 1 gets the barcode
    const unit1 = await prisma.equipmentUnit.create({
      data: { equipmentId: equipment.id, status: "AVAILABLE" },
    });
    await request(app)
      .post(`/api/equipment/${equipment.id}/units/${unit1.id}/assign-barcode`)
      .set(AUTH)
      .send({ barcode: "UNIQUE-DUP-001" });

    // Unit 2 tries same barcode
    const unit2 = await prisma.equipmentUnit.create({
      data: { equipmentId: equipment.id, status: "AVAILABLE" },
    });
    const res = await request(app)
      .post(`/api/equipment/${equipment.id}/units/${unit2.id}/assign-barcode`)
      .set(AUTH)
      .send({ barcode: "UNIQUE-DUP-001" });
    expect(res.status).toBe(409);
    expect(res.body.existingUnit).toBeDefined();
  });

  it("allows overwrite with force=true", async () => {
    const equipment = await createEquipment();
    const unit = await generateUnit(equipment.id);
    const oldBarcode = unit.barcode;

    const res = await request(app)
      .post(`/api/equipment/${equipment.id}/units/${unit.id}/assign-barcode`)
      .set(AUTH)
      .send({ barcode: "FORCED-NEW-001", force: true });
    expect(res.status).toBe(200);
    expect(res.body.unit.barcode).toBe("FORCED-NEW-001");
    expect(res.body.unit.barcode).not.toBe(oldBarcode);
  });

  it("rejects assign-barcode without force when unit already has barcode", async () => {
    const equipment = await createEquipment();
    const unit = await generateUnit(equipment.id);

    const res = await request(app)
      .post(`/api/equipment/${equipment.id}/units/${unit.id}/assign-barcode`)
      .set(AUTH)
      .send({ barcode: "NEW-BARCODE-NO-FORCE" });
    expect(res.status).toBe(409);
  });

  it("returns 404 for non-existent unit", async () => {
    const equipment = await createEquipment();
    const res = await request(app)
      .post(`/api/equipment/${equipment.id}/units/non-existent-id/assign-barcode`)
      .set(AUTH)
      .send({ barcode: "SOME-BARCODE" });
    expect(res.status).toBe(404);
  });
});

// ──────────────────────────────────────────────
// POST /api/equipment/:id/units/batch-assign
// ──────────────────────────────────────────────

describe("POST /api/equipment/:id/units/batch-assign", () => {
  it("creates a new unit with barcode and increments totalQuantity", async () => {
    const equipment = await createEquipment("UNIT");
    const initialQty = equipment.totalQuantity;

    const res = await request(app)
      .post(`/api/equipment/${equipment.id}/units/batch-assign`)
      .set(AUTH)
      .send({ barcode: "BATCH-001" });
    expect(res.status).toBe(201);
    expect(res.body.unit.barcode).toBe("BATCH-001");
    expect(res.body.unit.barcodePayload).toBeTruthy();
    expect(res.body.unit.status).toBe("AVAILABLE");

    // Verify totalQuantity incremented
    const eqRes = await request(app)
      .get(`/api/equipment/${equipment.id}`)
      .set(AUTH);
    expect(eqRes.body.equipment.totalQuantity).toBe(initialQty + 1);
  });

  it("rejects COUNT-mode equipment with 400", async () => {
    const equipment = await createEquipment("COUNT");

    const res = await request(app)
      .post(`/api/equipment/${equipment.id}/units/batch-assign`)
      .set(AUTH)
      .send({ barcode: "SHOULD-FAIL" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/UNIT/);
  });

  it("rejects duplicate barcode with 409", async () => {
    const equipment = await createEquipment("UNIT");
    // Create first unit
    await request(app)
      .post(`/api/equipment/${equipment.id}/units/batch-assign`)
      .set(AUTH)
      .send({ barcode: "BATCH-DUP-001" });

    // Try duplicate
    const res = await request(app)
      .post(`/api/equipment/${equipment.id}/units/batch-assign`)
      .set(AUTH)
      .send({ barcode: "BATCH-DUP-001" });
    expect(res.status).toBe(409);
  });

  it("rejects barcode with colon", async () => {
    const equipment = await createEquipment("UNIT");
    const res = await request(app)
      .post(`/api/equipment/${equipment.id}/units/batch-assign`)
      .set(AUTH)
      .send({ barcode: "BAD:COLON" });
    expect(res.status).toBe(400);
  });
});

// ──────────────────────────────────────────────
// POST /api/equipment-units/labels
// ──────────────────────────────────────────────

describe("POST /api/equipment-units/labels", () => {
  it("returns PDF for valid unit IDs with barcodes", async () => {
    const equipment = await createEquipment();
    const unit = await generateUnit(equipment.id);

    const res = await request(app)
      .post("/api/equipment-units/labels")
      .set(AUTH)
      .send({ unitIds: [unit.id] });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
  });

  it("returns 404 when no units have barcodes", async () => {
    // Create unit without barcode directly
    const equipment = await createEquipment();
    const unit = await prisma.equipmentUnit.create({
      data: { equipmentId: equipment.id, status: "AVAILABLE" },
    });

    const res = await request(app)
      .post("/api/equipment-units/labels")
      .set(AUTH)
      .send({ unitIds: [unit.id] });
    expect(res.status).toBe(404);
  });

  it("rejects empty unitIds with 400", async () => {
    const res = await request(app)
      .post("/api/equipment-units/labels")
      .set(AUTH)
      .send({ unitIds: [] });
    expect(res.status).toBe(400);
  });
});
