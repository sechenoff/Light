/**
 * Интеграционные тесты /api/dashboard/today
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-dashboard.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1,test-key-2";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-dashboard";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-dashboard";

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

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

async function createEquipment(name = "Прожектор") {
  return prisma.equipment.create({
    data: {
      importKey: `СВЕТ||${name.toUpperCase()}||||`,
      name,
      category: "Свет",
      totalQuantity: 5,
      stockTrackingMode: "COUNT",
      rentalRatePerShift: 500,
    },
  });
}

async function createClient(name = "Тестовый клиент") {
  return prisma.client.create({ data: { name } });
}

async function createBooking(
  clientId: string,
  equipmentId: string,
  status: string,
  startDate: Date,
  endDate: Date
) {
  return prisma.booking.create({
    data: {
      clientId,
      projectName: "Тестовый проект",
      startDate,
      endDate,
      status,
      items: {
        create: [{ equipmentId, quantity: 2 }],
      },
    },
  });
}

// ──────────────────────────────────────────────────────────────────
// Тесты
// ──────────────────────────────────────────────────────────────────

describe("GET /api/dashboard/today", () => {
  it("возвращает 401 без API-ключа", async () => {
    const res = await request(app).get("/api/dashboard/today");
    expect(res.status).toBe(401);
  });

  it("возвращает пустые списки когда нет броней", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await request(app)
      .get(`/api/dashboard/today?date=${today}`)
      .set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.pickups).toEqual([]);
    expect(res.body.returns).toEqual([]);
    expect(res.body.active).toEqual([]);
  });

  it("включает CONFIRMED брони начинающиеся сегодня в pickups", async () => {
    const client = await createClient("Клиент пикап");
    const eq = await createEquipment("Свет пикап");

    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    const startDate = new Date(`${todayStr}T10:00:00.000Z`);
    const endDate = new Date(`${todayStr}T23:59:59.999Z`);
    endDate.setDate(endDate.getDate() + 2); // заканчивается послезавтра

    await createBooking(client.id, eq.id, "CONFIRMED", startDate, new Date(startDate.getTime() + 3 * 24 * 60 * 60 * 1000));

    const res = await request(app)
      .get(`/api/dashboard/today?date=${todayStr}`)
      .set(AUTH);
    expect(res.status).toBe(200);
    const pickup = res.body.pickups.find((b: any) => b.clientName === "Клиент пикап");
    expect(pickup).toBeDefined();
    expect(pickup.itemCount).toBe(1);
    expect(pickup.items[0].quantity).toBe(2);
    expect(pickup.items[0].equipmentName).toBe("Свет пикап");
  });

  it("включает ISSUED брони заканчивающиеся сегодня в returns", async () => {
    const client = await createClient("Клиент возврат");
    const eq = await createEquipment("Свет возврат");

    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    const endDate = new Date(`${todayStr}T18:00:00.000Z`);
    const startDate = new Date(endDate.getTime() - 2 * 24 * 60 * 60 * 1000);

    await createBooking(client.id, eq.id, "ISSUED", startDate, endDate);

    const res = await request(app)
      .get(`/api/dashboard/today?date=${todayStr}`)
      .set(AUTH);
    expect(res.status).toBe(200);
    const ret = res.body.returns.find((b: any) => b.clientName === "Клиент возврат");
    expect(ret).toBeDefined();
  });

  it("включает все ISSUED брони в active независимо от даты", async () => {
    const client = await createClient("Клиент активный");
    const eq = await createEquipment("Свет активный");

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 5);
    const nextWeek = new Date();
    nextWeek.setDate(nextWeek.getDate() + 5);

    await createBooking(client.id, eq.id, "ISSUED", yesterday, nextWeek);

    const today = new Date().toISOString().slice(0, 10);
    const res = await request(app)
      .get(`/api/dashboard/today?date=${today}`)
      .set(AUTH);
    expect(res.status).toBe(200);
    const active = res.body.active.find((b: any) => b.clientName === "Клиент активный");
    expect(active).toBeDefined();
  });

  it("не включает DRAFT брони в pickups", async () => {
    const client = await createClient("Клиент черновик");
    const eq = await createEquipment("Свет черновик");

    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    const startDate = new Date(`${todayStr}T09:00:00.000Z`);

    await createBooking(client.id, eq.id, "DRAFT", startDate, new Date(startDate.getTime() + 24 * 60 * 60 * 1000));

    const res = await request(app)
      .get(`/api/dashboard/today?date=${todayStr}`)
      .set(AUTH);
    expect(res.status).toBe(200);
    const draft = res.body.pickups.find((b: any) => b.clientName === "Клиент черновик");
    expect(draft).toBeUndefined();
  });

  it("позволяет переопределить дату через query param", async () => {
    const client = await createClient("Клиент другой день");
    const eq = await createEquipment("Свет другой день");

    const otherDate = "2025-06-15";
    const startDate = new Date(`${otherDate}T10:00:00.000Z`);

    await createBooking(client.id, eq.id, "CONFIRMED", startDate, new Date(`${otherDate}T23:59:59.999Z`));

    const res = await request(app)
      .get(`/api/dashboard/today?date=${otherDate}`)
      .set(AUTH);
    expect(res.status).toBe(200);
    const pickup = res.body.pickups.find((b: any) => b.clientName === "Клиент другой день");
    expect(pickup).toBeDefined();
  });
});
