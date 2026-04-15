/**
 * Интеграционные тесты dryRun для POST /api/bookings/draft и PATCH /api/bookings/:id
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../../prisma/test-bookings-dryrun.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-dryrun";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-dryrun";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-secret-dryrun-min16chars";

let app: Express;
let prisma: any;
let superAdminToken: string;

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../../.."),
    env: {
      ...process.env,
      DATABASE_URL: `file:${TEST_DB_PATH}`,
      PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes",
    },
    stdio: "pipe",
  });

  const mod = await import("../../app");
  app = mod.app;
  const pmod = await import("../../prisma");
  prisma = pmod.prisma;

  // Создаём SUPER_ADMIN для тестов роутов, защищённых rolesGuard
  const { hashPassword, signSession } = await import("../../services/auth");
  const hash = await hashPassword("test-pass-123");
  const admin = await prisma.adminUser.create({
    data: { username: "dryrun_super_admin", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  superAdminToken = signSession({ userId: admin.id, username: admin.username, role: "SUPER_ADMIN" });
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

function AUTH() { return { "X-API-Key": "test-key-1", Authorization: `Bearer ${superAdminToken}` }; }

// ──────────────────────────────────────────────────────────────────
// Вспомогательные функции
// ──────────────────────────────────────────────────────────────────

async function createEquipment(name = "Прожектор DryRun") {
  return prisma.equipment.create({
    data: {
      importKey: `СВЕТ||${name.toUpperCase().replace(/\s/g, "_")}||||`,
      name,
      category: "Свет",
      totalQuantity: 10,
      stockTrackingMode: "COUNT",
      rentalRatePerShift: 2000,
    },
  });
}

async function createClient(name = "Тестовый клиент DryRun") {
  return prisma.client.create({ data: { name } });
}

async function createBookingFull(
  clientId: string,
  equipmentId: string,
) {
  return prisma.booking.create({
    data: {
      clientId,
      projectName: "Проект DryRun",
      startDate: new Date("2026-05-01T10:00:00.000Z"),
      endDate: new Date("2026-05-03T10:00:00.000Z"),
      status: "DRAFT",
      items: { create: [{ equipmentId, quantity: 2 }] },
    },
  });
}

// ──────────────────────────────────────────────────────────────────
// Тесты: POST /api/bookings/draft с dryRun:true
// ──────────────────────────────────────────────────────────────────

describe("POST /api/bookings/draft с dryRun:true", () => {
  it("возвращает dryRun:true и booking.id:null", async () => {
    const eq = await createEquipment("Свет dryRun создание");

    const res = await request(app)
      .post("/api/bookings/draft")
      .set(AUTH())
      .send({
        dryRun: true,
        client: { name: "DryRun Клиент А" },
        projectName: "DryRun Проект А",
        startDate: "2026-06-01T10:00:00.000Z",
        endDate: "2026-06-03T10:00:00.000Z",
        items: [{ equipmentId: eq.id, quantity: 1 }],
      });

    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.booking.id).toBeNull();
    expect(res.body.booking.status).toBe("DRAFT_PREVIEW");
    expect(res.body.booking.projectName).toBe("DryRun Проект А");
    expect(res.body.booking.estimate).toBeDefined();
    expect(typeof res.body.booking.estimate.totalAfterDiscount).toBe("string");
  });

  it("dryRun не создаёт бронь в БД", async () => {
    const eq = await createEquipment("Свет dryRun без записи");
    const countBefore = await prisma.booking.count();

    await request(app)
      .post("/api/bookings/draft")
      .set(AUTH())
      .send({
        dryRun: true,
        client: { name: "DryRun Клиент Б" },
        projectName: "DryRun Проект Б",
        startDate: "2026-07-01T10:00:00.000Z",
        endDate: "2026-07-02T10:00:00.000Z",
        items: [{ equipmentId: eq.id, quantity: 1 }],
      });

    const countAfter = await prisma.booking.count();
    expect(countAfter).toBe(countBefore);
  });

  it("dryRun не создаёт клиента в БД", async () => {
    const eq = await createEquipment("Свет dryRun без клиента");
    const clientCountBefore = await prisma.client.count();

    await request(app)
      .post("/api/bookings/draft")
      .set(AUTH())
      .send({
        dryRun: true,
        client: { name: "DryRun Клиент Уникальное Имя XYZ123" },
        projectName: "DryRun Проект",
        startDate: "2026-08-01T10:00:00.000Z",
        endDate: "2026-08-02T10:00:00.000Z",
        items: [{ equipmentId: eq.id, quantity: 1 }],
      });

    const clientCountAfter = await prisma.client.count();
    expect(clientCountAfter).toBe(clientCountBefore);
  });

  it("без dryRun создаёт реальную бронь в БД", async () => {
    const client = await createClient("Клиент реальный");
    const eq = await createEquipment("Свет реальный");
    const countBefore = await prisma.booking.count();

    const res = await request(app)
      .post("/api/bookings/draft")
      .set(AUTH())
      .send({
        client: { name: client.name },
        projectName: "Реальный Проект",
        startDate: "2026-09-01T10:00:00.000Z",
        endDate: "2026-09-03T10:00:00.000Z",
        items: [{ equipmentId: eq.id, quantity: 1 }],
      });

    expect(res.status).toBe(200);
    expect(res.body.booking).toBeDefined();
    expect(res.body.dryRun).toBeUndefined();

    const countAfter = await prisma.booking.count();
    expect(countAfter).toBe(countBefore + 1);
  });

  it("dryRun с несуществующим equipmentId возвращает 400", async () => {
    const res = await request(app)
      .post("/api/bookings/draft")
      .set(AUTH())
      .send({
        dryRun: true,
        client: { name: "DryRun Ошибка" },
        projectName: "Проект Ошибка",
        startDate: "2026-10-01T10:00:00.000Z",
        endDate: "2026-10-02T10:00:00.000Z",
        items: [{ equipmentId: "non-existent-id", quantity: 1 }],
      });

    expect(res.status).toBe(400);
  });
});

// ──────────────────────────────────────────────────────────────────
// Тесты: PATCH /api/bookings/:id с dryRun:true
// ──────────────────────────────────────────────────────────────────

describe("PATCH /api/bookings/:id с dryRun:true", () => {
  it("возвращает превью изменений без записи в БД", async () => {
    const client = await createClient("Клиент PATCH DryRun");
    const eq = await createEquipment("Свет PATCH dryRun");
    const booking = await createBookingFull(client.id, eq.id);

    const originalProjectName = booking.projectName;

    const res = await request(app)
      .patch(`/api/bookings/${booking.id}`)
      .set(AUTH())
      .send({
        dryRun: true,
        projectName: "DryRun Новое Название",
        startDate: "2026-05-05T10:00:00.000Z",
        endDate: "2026-05-07T10:00:00.000Z",
      });

    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.booking.projectName).toBe("DryRun Новое Название");
    expect(res.body.booking.id).toBe(booking.id);

    // БД не изменена
    const unchanged = await prisma.booking.findUnique({ where: { id: booking.id } });
    expect(unchanged.projectName).toBe(originalProjectName);
  });

  it("dryRun PATCH не изменяет бронь в БД", async () => {
    const client = await createClient("Клиент PATCH DryRun 2");
    const eq = await createEquipment("Свет PATCH dryRun 2");
    const booking = await createBookingFull(client.id, eq.id);

    await request(app)
      .patch(`/api/bookings/${booking.id}`)
      .set(AUTH())
      .send({
        dryRun: true,
        startDate: "2026-12-01T10:00:00.000Z",
        endDate: "2026-12-10T10:00:00.000Z",
      });

    // Проверяем что даты не изменились
    const unchanged = await prisma.booking.findUnique({ where: { id: booking.id } });
    expect(unchanged.startDate.toISOString()).toBe(booking.startDate.toISOString());
    expect(unchanged.endDate.toISOString()).toBe(booking.endDate.toISOString());
  });

  it("dryRun PATCH на несуществующую бронь возвращает 404", async () => {
    const res = await request(app)
      .patch("/api/bookings/non-existent-booking-id")
      .set(AUTH())
      .send({ dryRun: true, projectName: "Не важно" });

    expect(res.status).toBe(404);
  });
});
