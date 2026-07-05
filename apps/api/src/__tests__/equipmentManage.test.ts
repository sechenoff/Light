import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-equipment-manage.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-for-manage";
process.env.JWT_SECRET = "test-jwt-secret-manage-min16chars";

let app: Express;
let superAdminToken: string;
let warehouseToken: string;
let technicianToken: string;
let superAdminId: string;

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

  const { prisma } = await import("../prisma");
  const { hashPassword, signSession } = await import("../services/auth");
  const hash = await hashPassword("test-pass-123");

  const sa = await prisma.adminUser.create({
    data: { username: "manage_sa", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  superAdminId = sa.id;
  superAdminToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });

  const wh = await prisma.adminUser.create({
    data: { username: "manage_wh", passwordHash: hash, role: "WAREHOUSE" },
  });
  warehouseToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });

  const tech = await prisma.adminUser.create({
    data: { username: "manage_tech", passwordHash: hash, role: "TECHNICIAN" },
  });
  technicianToken = signSession({ userId: tech.id, username: tech.username, role: "TECHNICIAN" });
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

function AUTH(token: string = superAdminToken) {
  return { "X-API-Key": "test-key-1", Authorization: `Bearer ${token}` };
}

// Уникальные категории → уникальные аббревиатуры штрихкодов (без коллизий seq=1).
const UNIQUE_CATEGORIES = ["кабели", "штативы", "фрезнели", "прожекторы", "генераторы", "кейсы"];
let _counter = 0;

async function createEquipment(mode: "COUNT" | "UNIT" = "COUNT") {
  const category = UNIQUE_CATEGORIES[_counter % UNIQUE_CATEGORIES.length];
  _counter++;
  const res = await request(app)
    .post("/api/equipment")
    .set(AUTH())
    .send({
      category,
      name: `Manage-Eq-${_counter}`,
      totalQuantity: mode === "UNIT" ? 0 : 2,
      stockTrackingMode: mode,
      rentalRatePerShift: 1000,
    });
  expect(res.status).toBe(200);
  return res.body.equipment.id as string;
}

async function createUnit(equipmentId: string) {
  const res = await request(app)
    .post(`/api/equipment/${equipmentId}/units/generate`)
    .set(AUTH())
    .send({ count: 1 });
  expect(res.status).toBe(201);
  return res.body.units[0].id as string;
}

// ─────────────────────────────────────────────────────
// POST /api/equipment/reorder — rolesGuard
// ─────────────────────────────────────────────────────

describe("POST /api/equipment/reorder rolesGuard", () => {
  it("TECHNICIAN gets 403 FORBIDDEN_BY_ROLE", async () => {
    const id = await createEquipment();
    const res = await request(app)
      .post("/api/equipment/reorder")
      .set(AUTH(technicianToken))
      .send({ ids: [id] });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN_BY_ROLE");
  });

  it("API key without session gets 401 UNAUTHENTICATED", async () => {
    const id = await createEquipment();
    const res = await request(app)
      .post("/api/equipment/reorder")
      .set({ "X-API-Key": "test-key-1" })
      .send({ ids: [id] });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHENTICATED");
  });

  it("WAREHOUSE can reorder", async () => {
    const a = await createEquipment();
    const b = await createEquipment();
    const res = await request(app)
      .post("/api/equipment/reorder")
      .set(AUTH(warehouseToken))
      .send({ ids: [b, a] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const { prisma } = await import("../prisma");
    const first = await prisma.equipment.findUnique({ where: { id: b }, select: { sortOrder: true } });
    const second = await prisma.equipment.findUnique({ where: { id: a }, select: { sortOrder: true } });
    expect(first!.sortOrder).toBe(0);
    expect(second!.sortOrder).toBe(1);
  });
});

// ─────────────────────────────────────────────────────
// POST /api/equipment — защита от дублей
// ─────────────────────────────────────────────────────

describe("POST /api/equipment duplicate guard", () => {
  it("rejects a case/whitespace-insensitive duplicate name+brand+model with 409", async () => {
    const first = await request(app)
      .post("/api/equipment")
      .set(AUTH())
      .send({
        category: "кабели",
        name: "Aputure LS 600d",
        brand: "Aputure",
        model: "LS 600d",
        totalQuantity: 1,
        stockTrackingMode: "COUNT",
        rentalRatePerShift: 1000,
      });
    expect(first.status).toBe(200);

    const dup = await request(app)
      .post("/api/equipment")
      .set(AUTH())
      .send({
        category: "кабели",
        name: "  aputure  ls 600d ",
        brand: "APUTURE",
        model: "ls 600d",
        totalQuantity: 1,
        stockTrackingMode: "COUNT",
        rentalRatePerShift: 1000,
      });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("EQUIPMENT_DUPLICATE");
    expect(dup.body.duplicateId).toBe(first.body.equipment.id);
  });

  it("allows a different model (not a duplicate)", async () => {
    await request(app)
      .post("/api/equipment")
      .set(AUTH())
      .send({
        category: "штативы",
        name: "Manfrotto",
        brand: "Manfrotto",
        model: "055",
        totalQuantity: 1,
        stockTrackingMode: "COUNT",
        rentalRatePerShift: 500,
      });
    const other = await request(app)
      .post("/api/equipment")
      .set(AUTH())
      .send({
        category: "штативы",
        name: "Manfrotto",
        brand: "Manfrotto",
        model: "190",
        totalQuantity: 1,
        stockTrackingMode: "COUNT",
        rentalRatePerShift: 500,
      });
    expect(other.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────
// PATCH /api/equipment/:id/units/:unitId — ручные статусы
// ─────────────────────────────────────────────────────

describe("PATCH unit — manual status transitions", () => {
  it("blocks manual transition to ISSUED with 409 MANUAL_ISSUE_FORBIDDEN", async () => {
    const equipmentId = await createEquipment("UNIT");
    const unitId = await createUnit(equipmentId);

    const res = await request(app)
      .patch(`/api/equipment/${equipmentId}/units/${unitId}`)
      .set(AUTH())
      .send({ status: "ISSUED" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("MANUAL_ISSUE_FORBIDDEN");

    const { prisma } = await import("../prisma");
    const unit = await prisma.equipmentUnit.findUnique({ where: { id: unitId }, select: { status: true } });
    expect(unit!.status).toBe("AVAILABLE");
  });

  it("allows editing an already-ISSUED unit with unchanged status (no audit)", async () => {
    const equipmentId = await createEquipment("UNIT");
    const unitId = await createUnit(equipmentId);
    const { prisma } = await import("../prisma");
    await prisma.equipmentUnit.update({ where: { id: unitId }, data: { status: "ISSUED" } });

    const res = await request(app)
      .patch(`/api/equipment/${equipmentId}/units/${unitId}`)
      .set(AUTH())
      .send({ status: "ISSUED", comment: "проверить кофр" });
    expect(res.status).toBe(200);
    expect(res.body.unit.status).toBe("ISSUED");
    expect(res.body.unit.comment).toBe("проверить кофр");

    const audit = await prisma.auditEntry.findFirst({
      where: { entityType: "EquipmentUnit", entityId: unitId },
    });
    expect(audit).toBeNull();
  });

  it("writes AuditEntry on manual status change", async () => {
    const equipmentId = await createEquipment("UNIT");
    const unitId = await createUnit(equipmentId);

    const res = await request(app)
      .patch(`/api/equipment/${equipmentId}/units/${unitId}`)
      .set(AUTH())
      .send({ status: "MAINTENANCE" });
    expect(res.status).toBe(200);
    expect(res.body.unit.status).toBe("MAINTENANCE");

    const { prisma } = await import("../prisma");
    const audit = await prisma.auditEntry.findFirst({
      where: { entityType: "EquipmentUnit", entityId: unitId, action: "UNIT_STATUS_MANUAL_CHANGE" },
    });
    expect(audit).not.toBeNull();
    expect(audit!.userId).toBe(superAdminId);
    expect(JSON.parse(audit!.before!)).toEqual({ status: "AVAILABLE" });
    expect(JSON.parse(audit!.after!)).toEqual({ status: "MAINTENANCE" });
  });

  it("does not write AuditEntry when only comment changes", async () => {
    const equipmentId = await createEquipment("UNIT");
    const unitId = await createUnit(equipmentId);

    const res = await request(app)
      .patch(`/api/equipment/${equipmentId}/units/${unitId}`)
      .set(AUTH())
      .send({ comment: "царапина на корпусе" });
    expect(res.status).toBe(200);

    const { prisma } = await import("../prisma");
    const audit = await prisma.auditEntry.findFirst({
      where: { entityType: "EquipmentUnit", entityId: unitId },
    });
    expect(audit).toBeNull();
  });

  it("allows manual return MISSING → AVAILABLE with audit", async () => {
    const equipmentId = await createEquipment("UNIT");
    const unitId = await createUnit(equipmentId);
    const { prisma } = await import("../prisma");
    await prisma.equipmentUnit.update({ where: { id: unitId }, data: { status: "MISSING" } });

    const res = await request(app)
      .patch(`/api/equipment/${equipmentId}/units/${unitId}`)
      .set(AUTH())
      .send({ status: "AVAILABLE" });
    expect(res.status).toBe(200);
    expect(res.body.unit.status).toBe("AVAILABLE");

    const audit = await prisma.auditEntry.findFirst({
      where: { entityType: "EquipmentUnit", entityId: unitId, action: "UNIT_STATUS_MANUAL_CHANGE" },
    });
    expect(audit).not.toBeNull();
    expect(JSON.parse(audit!.before!)).toEqual({ status: "MISSING" });
  });
});
