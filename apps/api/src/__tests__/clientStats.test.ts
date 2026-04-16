/**
 * Интеграционные тесты GET /api/clients/:id/stats
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-client-stats.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-clientstats";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-clientstats";
process.env.JWT_SECRET = "test-jwt-secret-clientstats-min16chars";

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
    data: { username: "cs_sa", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  superAdminToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });

  const wh = await prisma.adminUser.create({
    data: { username: "cs_wh", passwordHash: hash, role: "WAREHOUSE" },
  });
  warehouseToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });

  const tech = await prisma.adminUser.create({
    data: { username: "cs_tech", passwordHash: hash, role: "TECHNICIAN" },
  });
  technicianToken = signSession({ userId: tech.id, username: tech.username, role: "TECHNICIAN" });
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

function AUTH_SA() { return { "X-API-Key": "test-key-1", Authorization: `Bearer ${superAdminToken}` }; }
function AUTH_WH() { return { "X-API-Key": "test-key-1", Authorization: `Bearer ${warehouseToken}` }; }
function AUTH_TECH() { return { "X-API-Key": "test-key-1", Authorization: `Bearer ${technicianToken}` }; }

describe("GET /api/clients/:id/stats", () => {
  it("возвращает 404 для несуществующего клиента", async () => {
    const res = await request(app)
      .get("/api/clients/nonexistent-id/stats")
      .set(AUTH_SA());
    expect(res.status).toBe(404);
    expect(res.body.message).toBeTruthy();
  });

  it("TECHNICIAN получает 403", async () => {
    const client = await prisma.client.create({ data: { name: "Тест Техник Клиент" } });
    const res = await request(app)
      .get(`/api/clients/${client.id}/stats`)
      .set(AUTH_TECH());
    expect(res.status).toBe(403);
  });

  it("возвращает нулевую статистику для клиента без броней", async () => {
    const client = await prisma.client.create({ data: { name: "Клиент Без Броней" } });
    const res = await request(app)
      .get(`/api/clients/${client.id}/stats`)
      .set(AUTH_SA());
    expect(res.status).toBe(200);
    expect(res.body.clientId).toBe(client.id);
    expect(res.body.clientName).toBe("Клиент Без Броней");
    expect(res.body.bookingCount).toBe(0);
    expect(res.body.averageCheck).toBe(0);
    expect(res.body.totalRevenue).toBe(0);
    expect(res.body.outstandingDebt).toBe(0);
    expect(res.body.hasDebt).toBe(false);
    expect(res.body.lastBookingDate).toBeNull();
  });

  it("считает только не-CANCELLED брони", async () => {
    const client = await prisma.client.create({ data: { name: "Клиент Отменённых" } });
    const equip = await prisma.equipment.create({
      data: {
        importKey: `cs-test-${Date.now()}`,
        name: "Прожектор тест",
        category: "Свет",
        totalQuantity: 5,
        rentalRatePerShift: 1000,
      },
    });
    // CANCELLED бронь — не должна считаться
    await prisma.booking.create({
      data: {
        clientId: client.id,
        projectName: "Отменённый проект",
        startDate: new Date("2026-03-01T10:00:00Z"),
        endDate: new Date("2026-03-03T10:00:00Z"),
        status: "CANCELLED",
        finalAmount: 50000,
        amountOutstanding: 50000,
      },
    });
    // DRAFT бронь — должна считаться
    await prisma.booking.create({
      data: {
        clientId: client.id,
        projectName: "Черновик проект",
        startDate: new Date("2026-04-01T10:00:00Z"),
        endDate: new Date("2026-04-03T10:00:00Z"),
        status: "DRAFT",
        finalAmount: 30000,
        amountOutstanding: 30000,
      },
    });

    const res = await request(app)
      .get(`/api/clients/${client.id}/stats`)
      .set(AUTH_WH());
    expect(res.status).toBe(200);
    expect(res.body.bookingCount).toBe(1);
    expect(res.body.totalRevenue).toBe(30000);
    expect(res.body.outstandingDebt).toBe(30000);
    expect(res.body.hasDebt).toBe(true);
  });

  it("вычисляет среднее только по броням с finalAmount > 0", async () => {
    const uid = Date.now();
    const client = await prisma.client.create({ data: { name: `Клиент Среднего ${uid}` } });
    // Бронь с finalAmount = 0 (черновик без сметы) — не учитывается в среднем
    await prisma.booking.create({
      data: {
        clientId: client.id,
        projectName: "Нулевая бронь",
        startDate: new Date("2026-01-01T10:00:00Z"),
        endDate: new Date("2026-01-02T10:00:00Z"),
        status: "DRAFT",
        finalAmount: 0,
      },
    });
    // Бронь с finalAmount = 60000
    await prisma.booking.create({
      data: {
        clientId: client.id,
        projectName: "Проект А",
        startDate: new Date("2026-02-01T10:00:00Z"),
        endDate: new Date("2026-02-03T10:00:00Z"),
        status: "CONFIRMED",
        finalAmount: 60000,
      },
    });
    // Бронь с finalAmount = 20000
    await prisma.booking.create({
      data: {
        clientId: client.id,
        projectName: "Проект Б",
        startDate: new Date("2026-03-01T10:00:00Z"),
        endDate: new Date("2026-03-03T10:00:00Z"),
        status: "CONFIRMED",
        finalAmount: 20000,
      },
    });

    const res = await request(app)
      .get(`/api/clients/${client.id}/stats`)
      .set(AUTH_SA());
    expect(res.status).toBe(200);
    expect(res.body.bookingCount).toBe(3); // все три не-CANCELLED
    expect(res.body.totalRevenue).toBe(80000); // 0 + 60000 + 20000
    expect(res.body.averageCheck).toBe(40000); // (60000 + 20000) / 2
    expect(res.body.hasDebt).toBe(false);
  });

  it("возвращает lastBookingDate как ISO-строку самой свежей startDate", async () => {
    const uid = Date.now();
    const client = await prisma.client.create({ data: { name: `Клиент Дат ${uid}` } });
    await prisma.booking.create({
      data: {
        clientId: client.id,
        projectName: "Старая бронь",
        startDate: new Date("2026-01-10T10:00:00Z"),
        endDate: new Date("2026-01-12T10:00:00Z"),
        status: "RETURNED",
        finalAmount: 10000,
      },
    });
    await prisma.booking.create({
      data: {
        clientId: client.id,
        projectName: "Свежая бронь",
        startDate: new Date("2026-04-15T10:00:00Z"),
        endDate: new Date("2026-04-17T10:00:00Z"),
        status: "CONFIRMED",
        finalAmount: 20000,
      },
    });

    const res = await request(app)
      .get(`/api/clients/${client.id}/stats`)
      .set(AUTH_SA());
    expect(res.status).toBe(200);
    expect(res.body.lastBookingDate).toBe("2026-04-15T10:00:00.000Z");
  });
});
