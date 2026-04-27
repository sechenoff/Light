/**
 * Интеграционные тесты для holistic-fix:
 * H1 — rolesGuard на /api/warehouse/workers/*
 * H2 — per-route guards на /api/equipment/:id/units/* и /api/equipment-units/*
 * H4 — аудит-записи при DELETE /api/bookings/:id и CRUD /api/admin-users
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-roles-holistic.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-holistic";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-holistic-xxxxxxxxxxx";
process.env.WAREHOUSE_SECRET = "test-warehouse-holistic-secret-xxx";
process.env.JWT_SECRET = "test-jwt-holistic-secret-min16chars";
process.env.VISION_PROVIDER = "mock";

let app: Express;
let prisma: any;

let superAdminToken: string;
let warehouseToken: string;
let technicianToken: string;

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
  const hash = await hashPassword("test-pass-123");

  const sa = await prisma.adminUser.create({
    data: { username: "holistic_super_admin", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  superAdminToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });

  const wh = await prisma.adminUser.create({
    data: { username: "holistic_warehouse", passwordHash: hash, role: "WAREHOUSE" },
  });
  warehouseToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });

  const tech = await prisma.adminUser.create({
    data: { username: "holistic_technician", passwordHash: hash, role: "TECHNICIAN" },
  });
  technicianToken = signSession({ userId: tech.id, username: tech.username, role: "TECHNICIAN" });
});

afterAll(async () => {
  await prisma.$disconnect();
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = TEST_DB_PATH + suffix;
    if (fs.existsSync(f)) {
      try { fs.unlinkSync(f); } catch { /* игнор */ }
    }
  }
});

function SA() { return { "X-API-Key": "test-key-holistic", Authorization: `Bearer ${superAdminToken}` }; }
function WH() { return { "X-API-Key": "test-key-holistic", Authorization: `Bearer ${warehouseToken}` }; }
function TECH() { return { "X-API-Key": "test-key-holistic", Authorization: `Bearer ${technicianToken}` }; }
function NOAUTH() { return { "X-API-Key": "test-key-holistic" }; }

// ──────────────────────────────────────────────────────────────────
// H1: /api/warehouse/workers — rolesGuard(SA + WH)
// ──────────────────────────────────────────────────────────────────

describe("H1: /api/warehouse/workers rolesGuard", () => {
  it("GET /api/warehouse/workers — нет сессии → 401", async () => {
    const res = await request(app)
      .get("/api/warehouse/workers")
      .set(NOAUTH());
    expect(res.status).toBe(401);
    // HttpError(401, ..., "UNAUTHENTICATED") → { message, details: "UNAUTHENTICATED" }
    expect(res.body.details).toBe("UNAUTHENTICATED");
  });

  it("GET /api/warehouse/workers — TECHNICIAN → 403", async () => {
    const res = await request(app)
      .get("/api/warehouse/workers")
      .set(TECH());
    expect(res.status).toBe(403);
    expect(res.body.details).toBe("FORBIDDEN_BY_ROLE");
  });

  it("GET /api/warehouse/workers — WAREHOUSE → 200", async () => {
    const res = await request(app)
      .get("/api/warehouse/workers")
      .set(WH());
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("workers");
  });

  it("GET /api/warehouse/workers — SUPER_ADMIN → 200", async () => {
    const res = await request(app)
      .get("/api/warehouse/workers")
      .set(SA());
    expect(res.status).toBe(200);
  });

  it("POST /api/warehouse/workers — нет сессии → 401", async () => {
    const res = await request(app)
      .post("/api/warehouse/workers")
      .set(NOAUTH())
      .send({ name: "Иван", pin: "1234" });
    expect(res.status).toBe(401);
  });

  it("POST /api/warehouse/workers — TECHNICIAN → 403", async () => {
    const res = await request(app)
      .post("/api/warehouse/workers")
      .set(TECH())
      .send({ name: "Иван", pin: "1234" });
    expect(res.status).toBe(403);
  });

  it("POST /api/warehouse/workers — WAREHOUSE → 201", async () => {
    const res = await request(app)
      .post("/api/warehouse/workers")
      .set(WH())
      .send({ name: "Тест Холистик", pin: "9876" });
    expect(res.status).toBe(201);
    expect(res.body.worker).toBeDefined();
  });

  it("PATCH /api/warehouse/workers/:id — TECHNICIAN → 403", async () => {
    // Создаём работника через SA
    const createRes = await request(app)
      .post("/api/warehouse/workers")
      .set(SA())
      .send({ name: "Обновить Холистик", pin: "1111" });
    const workerId = createRes.body.worker?.id;
    expect(workerId).toBeDefined();

    const res = await request(app)
      .patch(`/api/warehouse/workers/${workerId}`)
      .set(TECH())
      .send({ isActive: false });
    expect(res.status).toBe(403);
  });

  it("DELETE /api/warehouse/workers/:id — TECHNICIAN → 403", async () => {
    const createRes = await request(app)
      .post("/api/warehouse/workers")
      .set(SA())
      .send({ name: "Удалить Холистик", pin: "2222" });
    const workerId = createRes.body.worker?.id;
    expect(workerId).toBeDefined();

    const res = await request(app)
      .delete(`/api/warehouse/workers/${workerId}`)
      .set(TECH());
    expect(res.status).toBe(403);
  });
});

// ──────────────────────────────────────────────────────────────────
// H2: /api/equipment/:id/units — TECHNICIAN read-only
// ──────────────────────────────────────────────────────────────────

describe("H2: equipment units per-route guards", () => {
  let equipmentId: string;

  beforeAll(async () => {
    // Создаём оборудование
    const eq = await prisma.equipment.create({
      data: {
        importKey: "TEST||HOLISTIC||||",
        name: "Прожектор Холистик",
        category: "Свет",
        totalQuantity: 1,
        stockTrackingMode: "UNIT",
        rentalRatePerShift: 500,
      },
    });
    equipmentId = eq.id;
  });

  it("GET /api/equipment/:id/units — TECHNICIAN → 200", async () => {
    const res = await request(app)
      .get(`/api/equipment/${equipmentId}/units`)
      .set(TECH());
    expect(res.status).toBe(200);
  });

  it("POST /api/equipment/:id/units/generate — TECHNICIAN → 403", async () => {
    const res = await request(app)
      .post(`/api/equipment/${equipmentId}/units/generate`)
      .set(TECH())
      .send({ count: 1 });
    expect(res.status).toBe(403);
    expect(res.body.details).toBe("FORBIDDEN_BY_ROLE");
  });

  it("POST /api/equipment/:id/units/generate — WAREHOUSE → 201", async () => {
    const res = await request(app)
      .post(`/api/equipment/${equipmentId}/units/generate`)
      .set(WH())
      .send({ count: 1 });
    expect(res.status).toBe(201);
    expect(res.body.units).toHaveLength(1);
  });

  it("PATCH /api/equipment/:id/units/:unitId — TECHNICIAN → 403", async () => {
    // Получаем существующую единицу
    const listRes = await request(app)
      .get(`/api/equipment/${equipmentId}/units`)
      .set(SA());
    const unitId = listRes.body.units?.[0]?.id;
    expect(unitId).toBeDefined();

    const res = await request(app)
      .patch(`/api/equipment/${equipmentId}/units/${unitId}`)
      .set(TECH())
      .send({ status: "MAINTENANCE" });
    expect(res.status).toBe(403);
  });

  it("DELETE /api/equipment/:id/units/:unitId — TECHNICIAN → 403", async () => {
    const listRes = await request(app)
      .get(`/api/equipment/${equipmentId}/units`)
      .set(SA());
    const unitId = listRes.body.units?.[0]?.id;
    expect(unitId).toBeDefined();

    const res = await request(app)
      .delete(`/api/equipment/${equipmentId}/units/${unitId}`)
      .set(TECH());
    expect(res.status).toBe(403);
  });

  // Global equipment-units
  it("GET /api/equipment-units — TECHNICIAN → 200", async () => {
    const res = await request(app)
      .get("/api/equipment-units")
      .set(TECH());
    expect(res.status).toBe(200);
  });

  it("POST /api/equipment-units/labels — TECHNICIAN → 403", async () => {
    const res = await request(app)
      .post("/api/equipment-units/labels")
      .set(TECH())
      .send({ unitIds: ["dummy"] });
    expect(res.status).toBe(403);
  });

  it("GET /api/equipment-units/lookup — нет сессии → 401", async () => {
    const res = await request(app)
      .get("/api/equipment-units/lookup?barcode=test")
      .set(NOAUTH());
    expect(res.status).toBe(401);
  });
});

// ──────────────────────────────────────────────────────────────────
// H4: Аудит при удалении брони
// ──────────────────────────────────────────────────────────────────

describe("H4: аудит DELETE /api/bookings/:id", () => {
  it("после удаления брони создаётся AuditEntry с action=delete", async () => {
    // Создаём клиента и оборудование и бронь напрямую через Prisma
    const client = await prisma.client.create({ data: { name: "Клиент Аудит" } });
    const eq = await prisma.equipment.create({
      data: {
        importKey: "AUDIT||EQ||||",
        name: "Фонарь Аудит",
        category: "Свет",
        totalQuantity: 1,
        stockTrackingMode: "COUNT",
        rentalRatePerShift: 100,
      },
    });
    const booking = await prisma.booking.create({
      data: {
        clientId: client.id,
        projectName: "Проект аудит",
        startDate: new Date("2026-05-01T10:00:00Z"),
        endDate: new Date("2026-05-02T10:00:00Z"),
        status: "DRAFT",
        paymentStatus: "NOT_PAID",
        finalAmount: 0,
        amountPaid: 0,
        amountOutstanding: 0,
      },
    });

    const auditsBefore = await prisma.auditEntry.count({ where: { entityId: booking.id } });

    const res = await request(app)
      .delete(`/api/bookings/${booking.id}`)
      .set(SA());
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const auditsAfter = await prisma.auditEntry.count({ where: { entityId: booking.id } });
    expect(auditsAfter).toBe(auditsBefore + 1);

    const entry = await prisma.auditEntry.findFirst({
      where: { entityId: booking.id, action: "BOOKING_DELETE" },
    });
    expect(entry).not.toBeNull();
    expect(entry!.entityType).toBe("Booking");
    expect(JSON.parse(entry!.before)).toMatchObject({ status: "DRAFT" });
    expect(entry!.after).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// H4: Аудит при CRUD /api/admin-users
// ──────────────────────────────────────────────────────────────────

describe("H4: аудит /api/admin-users CRUD", () => {
  it("POST /api/admin-users создаёт AuditEntry с action=create", async () => {
    const res = await request(app)
      .post("/api/admin-users")
      .set(SA())
      .send({ username: "audit_test_user", password: "pass123", role: "WAREHOUSE" });
    expect(res.status).toBe(201);
    const userId = res.body.user.id;

    const entry = await prisma.auditEntry.findFirst({
      where: { entityId: userId, action: "ADMIN_USER_CREATE", entityType: "AdminUser" },
    });
    expect(entry).not.toBeNull();
    expect(JSON.parse(entry!.after)).toMatchObject({ username: "audit_test_user", role: "WAREHOUSE" });
    expect(entry!.before).toBeNull();
  });

  it("PATCH /api/admin-users/:id создаёт AuditEntry с action=update", async () => {
    // Создаём пользователя для теста
    const createRes = await request(app)
      .post("/api/admin-users")
      .set(SA())
      .send({ username: "audit_patch_user", password: "pass123", role: "WAREHOUSE" });
    const userId = createRes.body.user.id;

    const res = await request(app)
      .patch(`/api/admin-users/${userId}`)
      .set(SA())
      .send({ role: "TECHNICIAN" });
    expect(res.status).toBe(200);

    const entry = await prisma.auditEntry.findFirst({
      where: { entityId: userId, action: "ADMIN_USER_UPDATE", entityType: "AdminUser" },
    });
    expect(entry).not.toBeNull();
    expect(JSON.parse(entry!.before)).toMatchObject({ role: "WAREHOUSE" });
    expect(JSON.parse(entry!.after)).toMatchObject({ role: "TECHNICIAN" });
  });

  it("DELETE /api/admin-users/:id создаёт AuditEntry с action=ADMIN_USER_DELETE", async () => {
    const createRes = await request(app)
      .post("/api/admin-users")
      .set(SA())
      .send({ username: "audit_delete_user", password: "pass123", role: "WAREHOUSE" });
    const userId = createRes.body.user.id;

    const res = await request(app)
      .delete(`/api/admin-users/${userId}`)
      .set(SA());
    expect(res.status).toBe(200);

    const entry = await prisma.auditEntry.findFirst({
      where: { entityId: userId, action: "ADMIN_USER_DELETE", entityType: "AdminUser" },
    });
    expect(entry).not.toBeNull();
    expect(entry!.after).toBeNull();
    expect(JSON.parse(entry!.before)).toMatchObject({ role: "WAREHOUSE" });
  });
});
