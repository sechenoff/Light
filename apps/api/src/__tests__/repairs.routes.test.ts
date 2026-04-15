/**
 * HTTP-тесты /api/repairs — Sprint 4
 * Матрица прав: SUPER_ADMIN / WAREHOUSE / TECHNICIAN
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-repairs-routes.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-repairs";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-repairs";
process.env.WAREHOUSE_SECRET = "test-warehouse-repairs";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-secret-repairs-min16chars";

let app: Express;
let prisma: any;

let superAdminToken: string;
let warehouseToken: string;
let technicianToken: string;

let superAdminId: string;
let warehouseId: string;
let technicianId: string;
let equipmentId: string;
let unitId: string;
let unit2Id: string;

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

  const { hashPassword, signSession } = await import("../services/auth");
  const hash = await hashPassword("repairs-routes-pass");

  const superAdmin = await prisma.adminUser.create({
    data: { username: "rr_super", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  const warehouse = await prisma.adminUser.create({
    data: { username: "rr_warehouse", passwordHash: hash, role: "WAREHOUSE" },
  });
  const technician = await prisma.adminUser.create({
    data: { username: "rr_technician", passwordHash: hash, role: "TECHNICIAN" },
  });

  superAdminId = superAdmin.id;
  warehouseId = warehouse.id;
  technicianId = technician.id;

  superAdminToken = signSession({ userId: superAdmin.id, username: superAdmin.username, role: "SUPER_ADMIN" });
  warehouseToken = signSession({ userId: warehouse.id, username: warehouse.username, role: "WAREHOUSE" });
  technicianToken = signSession({ userId: technician.id, username: technician.username, role: "TECHNICIAN" });

  const equipment = await prisma.equipment.create({
    data: {
      importKey: "rr-test-equipment-001",
      name: "Тест прибор RR",
      category: "Осветительные приборы",
      rentalRatePerShift: 500,
      stockTrackingMode: "UNIT",
    },
  });
  equipmentId = equipment.id;

  const unit = await prisma.equipmentUnit.create({
    data: { equipmentId, barcode: "RR-001", status: "AVAILABLE" },
  });
  unitId = unit.id;

  const unit2 = await prisma.equipmentUnit.create({
    data: { equipmentId, barcode: "RR-002", status: "AVAILABLE" },
  });
  unit2Id = unit2.id;
});

afterAll(async () => {
  await prisma.$disconnect();
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = TEST_DB_PATH + suffix;
    if (fs.existsSync(f)) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }
});

const apiKey = { "X-API-Key": "test-key-repairs" };
function auth(token: string) {
  return { ...apiKey, "Authorization": `Bearer ${token}` };
}

// ─── Auth guards ─────────────────────────────────────────────────────────────

describe("Auth guards", () => {
  it("401 — только API-ключ, нет сессии", async () => {
    const res = await request(app).get("/api/repairs").set(apiKey);
    expect(res.status).toBe(401);
    expect(res.body.details).toBe("UNAUTHENTICATED");
  });
});

// ─── GET /api/repairs ────────────────────────────────────────────────────────

describe("GET /api/repairs", () => {
  it("200 — SUPER_ADMIN видит список", async () => {
    const res = await request(app).get("/api/repairs").set(auth(superAdminToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.repairs)).toBe(true);
  });

  it("200 — WAREHOUSE видит список", async () => {
    const res = await request(app).get("/api/repairs").set(auth(warehouseToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.repairs)).toBe(true);
  });

  it("200 — TECHNICIAN видит список", async () => {
    const res = await request(app).get("/api/repairs").set(auth(technicianToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.repairs)).toBe(true);
  });
});

// ─── POST /api/repairs ───────────────────────────────────────────────────────

describe("POST /api/repairs", () => {
  it("201 — WAREHOUSE создаёт ремонт", async () => {
    const res = await request(app)
      .post("/api/repairs")
      .set(auth(warehouseToken))
      .send({ unitId, reason: "Склад создал ремонт", urgency: "NORMAL" });
    expect(res.status).toBe(201);
    expect(res.body.repair.status).toBe("WAITING_REPAIR");

    // Cleanup
    await prisma.repair.update({
      where: { id: res.body.repair.id },
      data: { status: "CLOSED", closedAt: new Date() },
    });
    await prisma.equipmentUnit.update({ where: { id: unitId }, data: { status: "AVAILABLE" } });
  });

  it("201 — TECHNICIAN создаёт ремонт", async () => {
    const res = await request(app)
      .post("/api/repairs")
      .set(auth(technicianToken))
      .send({ unitId, reason: "Техник нашёл поломку", urgency: "URGENT" });
    expect(res.status).toBe(201);
    expect(res.body.repair.status).toBe("WAITING_REPAIR");

    // Cleanup
    await prisma.repair.update({
      where: { id: res.body.repair.id },
      data: { status: "CLOSED", closedAt: new Date() },
    });
    await prisma.equipmentUnit.update({ where: { id: unitId }, data: { status: "AVAILABLE" } });
  });

  it("201 — SUPER_ADMIN создаёт ремонт", async () => {
    const res = await request(app)
      .post("/api/repairs")
      .set(auth(superAdminToken))
      .send({ unitId, reason: "Руководитель создал ремонт", urgency: "NOT_URGENT" });
    expect(res.status).toBe(201);
    expect(res.body.repair.status).toBe("WAITING_REPAIR");

    // Cleanup
    await prisma.repair.update({
      where: { id: res.body.repair.id },
      data: { status: "CLOSED", closedAt: new Date() },
    });
    await prisma.equipmentUnit.update({ where: { id: unitId }, data: { status: "AVAILABLE" } });
  });

  it("400 — reason слишком короткий", async () => {
    const res = await request(app)
      .post("/api/repairs")
      .set(auth(superAdminToken))
      .send({ unitId, reason: "", urgency: "NORMAL" });
    expect(res.status).toBe(400);
  });
});

// ─── GET /api/repairs/:id ────────────────────────────────────────────────────

describe("GET /api/repairs/:id", () => {
  let repairId: string;

  beforeAll(async () => {
    const repair = await prisma.repair.create({
      data: {
        unitId: unit2Id,
        reason: "Тест деталей",
        urgency: "NORMAL",
        createdBy: superAdminId,
        status: "WAITING_REPAIR",
        partsCost: 0,
        totalTimeHours: 0,
      },
    });
    repairId = repair.id;
    await prisma.equipmentUnit.update({ where: { id: unit2Id }, data: { status: "MAINTENANCE" } });
  });

  afterAll(async () => {
    await prisma.repair.update({ where: { id: repairId }, data: { status: "CLOSED", closedAt: new Date() } });
    await prisma.equipmentUnit.update({ where: { id: unit2Id }, data: { status: "AVAILABLE" } });
  });

  it("200 — TECHNICIAN видит детали", async () => {
    const res = await request(app)
      .get(`/api/repairs/${repairId}`)
      .set(auth(technicianToken));
    expect(res.status).toBe(200);
    expect(res.body.repair.id).toBe(repairId);
  });

  it("404 — несуществующий ремонт", async () => {
    const res = await request(app)
      .get("/api/repairs/nonexistent-repair-id")
      .set(auth(superAdminToken));
    expect(res.status).toBe(404);
  });
});

// ─── POST /:id/write-off — только SUPER_ADMIN ─────────────────────────────────

describe("POST /api/repairs/:id/write-off", () => {
  it("403 FORBIDDEN_BY_ROLE — WAREHOUSE не может списывать", async () => {
    // Создаём ремонт для теста
    const repair = await prisma.repair.create({
      data: {
        unitId,
        reason: "Списание тест",
        urgency: "NORMAL",
        createdBy: superAdminId,
        status: "IN_REPAIR",
        partsCost: 0,
        totalTimeHours: 0,
      },
    });
    await prisma.equipmentUnit.update({ where: { id: unitId }, data: { status: "MAINTENANCE" } });

    const res = await request(app)
      .post(`/api/repairs/${repair.id}/write-off`)
      .set(auth(warehouseToken));
    expect(res.status).toBe(403);
    expect(res.body.details).toBe("FORBIDDEN_BY_ROLE");

    // Cleanup
    await prisma.repair.update({ where: { id: repair.id }, data: { status: "CLOSED", closedAt: new Date() } });
    await prisma.equipmentUnit.update({ where: { id: unitId }, data: { status: "AVAILABLE" } });
  });

  it("403 FORBIDDEN_BY_ROLE — TECHNICIAN не может списывать", async () => {
    const repair = await prisma.repair.create({
      data: {
        unitId,
        reason: "Списание тест 2",
        urgency: "NORMAL",
        createdBy: superAdminId,
        status: "IN_REPAIR",
        partsCost: 0,
        totalTimeHours: 0,
      },
    });
    await prisma.equipmentUnit.update({ where: { id: unitId }, data: { status: "MAINTENANCE" } });

    const res = await request(app)
      .post(`/api/repairs/${repair.id}/write-off`)
      .set(auth(technicianToken));
    expect(res.status).toBe(403);

    // Cleanup
    await prisma.repair.update({ where: { id: repair.id }, data: { status: "CLOSED", closedAt: new Date() } });
    await prisma.equipmentUnit.update({ where: { id: unitId }, data: { status: "AVAILABLE" } });
  });

  it("200 — SUPER_ADMIN списывает", async () => {
    const woUnit = await prisma.equipmentUnit.create({
      data: { equipmentId, barcode: "WO-TEST-001", status: "AVAILABLE" },
    });

    const repair = await prisma.repair.create({
      data: {
        unitId: woUnit.id,
        reason: "Списание руководителем",
        urgency: "NORMAL",
        createdBy: superAdminId,
        status: "IN_REPAIR",
        partsCost: 0,
        totalTimeHours: 0,
      },
    });
    await prisma.equipmentUnit.update({ where: { id: woUnit.id }, data: { status: "MAINTENANCE" } });

    const res = await request(app)
      .post(`/api/repairs/${repair.id}/write-off`)
      .set(auth(superAdminToken));
    expect(res.status).toBe(200);
    expect(res.body.repair.status).toBe("WROTE_OFF");
  });
});

// ─── POST /:id/assign — TECHNICIAN может только self-assign ──────────────────

describe("POST /api/repairs/:id/assign", () => {
  let repairForAssign: string;

  beforeAll(async () => {
    const repair = await prisma.repair.create({
      data: {
        unitId,
        reason: "Назначение тест",
        urgency: "NORMAL",
        createdBy: superAdminId,
        status: "WAITING_REPAIR",
        partsCost: 0,
        totalTimeHours: 0,
      },
    });
    repairForAssign = repair.id;
    await prisma.equipmentUnit.update({ where: { id: unitId }, data: { status: "MAINTENANCE" } });
  });

  afterAll(async () => {
    await prisma.repair.update({ where: { id: repairForAssign }, data: { status: "CLOSED", closedAt: new Date() } });
    await prisma.equipmentUnit.update({ where: { id: unitId }, data: { status: "AVAILABLE" } });
  });

  it("403 — TECHNICIAN назначает ДРУГОГО — запрещено", async () => {
    const res = await request(app)
      .post(`/api/repairs/${repairForAssign}/assign`)
      .set(auth(technicianToken))
      .send({ assigneeId: superAdminId });
    expect(res.status).toBe(403);
  });

  it("200 — TECHNICIAN self-assign", async () => {
    const res = await request(app)
      .post(`/api/repairs/${repairForAssign}/assign`)
      .set(auth(technicianToken))
      .send({ assigneeId: technicianId });
    expect(res.status).toBe(200);
    expect(res.body.repair.assignedTo).toBe(technicianId);
  });

  it("200 — SUPER_ADMIN назначает кого угодно", async () => {
    const res = await request(app)
      .post(`/api/repairs/${repairForAssign}/assign`)
      .set(auth(superAdminToken))
      .send({ assigneeId: superAdminId });
    expect(res.status).toBe(200);
    expect(res.body.repair.assignedTo).toBe(superAdminId);
  });
});

// ─── POST /:id/close ─────────────────────────────────────────────────────────

describe("POST /api/repairs/:id/close", () => {
  it("200 — SUPER_ADMIN закрывает ремонт", async () => {
    const closeUnit = await prisma.equipmentUnit.create({
      data: { equipmentId, barcode: "CLOSE-TEST-001", status: "AVAILABLE" },
    });

    const repair = await prisma.repair.create({
      data: {
        unitId: closeUnit.id,
        reason: "Закрытие тест",
        urgency: "NORMAL",
        createdBy: superAdminId,
        status: "IN_REPAIR",
        partsCost: 0,
        totalTimeHours: 0,
      },
    });
    await prisma.equipmentUnit.update({ where: { id: closeUnit.id }, data: { status: "MAINTENANCE" } });

    const res = await request(app)
      .post(`/api/repairs/${repair.id}/close`)
      .set(auth(superAdminToken));
    expect(res.status).toBe(200);
    expect(res.body.repair.status).toBe("CLOSED");

    const unit = await prisma.equipmentUnit.findUnique({ where: { id: closeUnit.id } });
    expect(unit.status).toBe("AVAILABLE");
  });
});
