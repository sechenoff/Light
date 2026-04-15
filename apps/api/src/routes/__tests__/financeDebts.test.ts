/**
 * Интеграционные тесты GET /api/finance/debts
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../../prisma/test-finance-debts.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-finance-debts";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-finance-debts";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-secret-financedebts-min16chars";

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
    data: { username: "financedebts_super_admin", passwordHash: hash, role: "SUPER_ADMIN" },
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

async function createEquipment(name = "Прожектор") {
  return prisma.equipment.create({
    data: {
      importKey: `СВЕТ||${name.toUpperCase().replace(/\s/g, "_")}||||`,
      name,
      category: "Свет",
      totalQuantity: 5,
      stockTrackingMode: "COUNT",
      rentalRatePerShift: 1000,
    },
  });
}

async function createClient(name: string) {
  return prisma.client.create({ data: { name } });
}

async function createBookingWithDebt(
  clientId: string,
  equipmentId: string,
  status: string,
  finalAmount: string,
  paymentStatus: string,
  expectedPaymentDate: Date | null = null,
  amountPaid = "0.00",
) {
  // amountOutstanding вычисляется из finalAmount - amountPaid через recomputeBookingFinance.
  // Поэтому передаём finalAmount и amountPaid напрямую, чтобы управлять долгом.
  const amountOutstanding = (
    parseFloat(finalAmount) - parseFloat(amountPaid)
  ).toFixed(2);

  return prisma.booking.create({
    data: {
      clientId,
      projectName: "Тестовый проект",
      startDate: new Date("2026-04-01T10:00:00.000Z"),
      endDate: new Date("2026-04-03T10:00:00.000Z"),
      status,
      amountOutstanding,
      finalAmount,
      amountPaid,
      paymentStatus,
      expectedPaymentDate,
      items: { create: [{ equipmentId, quantity: 1 }] },
    },
  });
}

// ──────────────────────────────────────────────────────────────────
// Тесты
// ──────────────────────────────────────────────────────────────────

describe("GET /api/finance/debts", () => {
  it("возвращает 401 без API-ключа", async () => {
    const res = await request(app).get("/api/finance/debts");
    expect(res.status).toBe(401);
  });

  it("возвращает пустой список когда нет долгов", async () => {
    const res = await request(app).get("/api/finance/debts").set(AUTH());
    expect(res.status).toBe(200);
    expect(res.body.debts).toEqual([]);
    expect(res.body.summary.totalClients).toBe(0);
    expect(res.body.summary.totalOutstanding).toBe("0.00");
  });

  it("агрегирует долги по клиенту и сортирует по сумме desc", async () => {
    const eq = await createEquipment("Свет агрегация");

    // Клиент A: 2 брони → totalOutstanding = 5000 + 3000 = 8000
    const clientA = await createClient("Клиент А Агрегация");
    await createBookingWithDebt(clientA.id, eq.id, "CONFIRMED", "5000.00", "NOT_PAID");
    await createBookingWithDebt(clientA.id, eq.id, "CONFIRMED", "3000.00", "NOT_PAID");

    // Клиент B: 1 бронь → totalOutstanding = 12000
    const clientB = await createClient("Клиент Б Агрегация");
    await createBookingWithDebt(clientB.id, eq.id, "CONFIRMED", "12000.00", "NOT_PAID");

    const res = await request(app).get("/api/finance/debts").set(AUTH());
    expect(res.status).toBe(200);

    const debts = res.body.debts;
    // Найти наших клиентов (в БД могут быть данные из других тестов)
    const debtA = debts.find((d: any) => d.clientName === "Клиент А Агрегация");
    const debtB = debts.find((d: any) => d.clientName === "Клиент Б Агрегация");

    expect(debtA).toBeDefined();
    expect(debtB).toBeDefined();
    expect(debtA.totalOutstanding).toBe("8000.00");
    expect(debtA.bookingsCount).toBe(2);
    expect(debtB.totalOutstanding).toBe("12000.00");

    // Клиент Б (12000) должен идти перед Клиент А (8000) — сортировка desc
    const idxA = debts.indexOf(debtA);
    const idxB = debts.indexOf(debtB);
    expect(idxB).toBeLessThan(idxA);
  });

  it("CANCELLED брони исключаются из debts", async () => {
    const eq = await createEquipment("Свет отменённый");
    const client = await createClient("Клиент Отмена");

    // CANCELLED бронь с долгом — не должна попасть в debts
    await createBookingWithDebt(client.id, eq.id, "CANCELLED", "9999.00", "NOT_PAID");

    const res = await request(app).get("/api/finance/debts").set(AUTH());
    expect(res.status).toBe(200);
    const debt = res.body.debts.find((d: any) => d.clientName === "Клиент Отмена");
    expect(debt).toBeUndefined();
  });

  it("брони с amountOutstanding = 0 исключаются", async () => {
    const eq = await createEquipment("Свет оплаченный");
    const client = await createClient("Клиент Оплачен");

    // Бронь без долга — не попадает в debts
    await createBookingWithDebt(client.id, eq.id, "RETURNED", "0.00", "PAID");

    const res = await request(app).get("/api/finance/debts").set(AUTH());
    expect(res.status).toBe(200);
    const debt = res.body.debts.find((d: any) => d.clientName === "Клиент Оплачен");
    expect(debt).toBeUndefined();
  });

  it("?overdueOnly=true фильтрует только клиентов с overdueAmount > 0", async () => {
    const eq = await createEquipment("Свет просрочка");

    // Клиент с просроченной бронью
    const clientOverdue = await createClient("Клиент Просрочен");
    const pastDate = new Date("2026-01-01T00:00:00.000Z"); // в прошлом
    await createBookingWithDebt(
      clientOverdue.id, eq.id, "CONFIRMED", "7000.00", "OVERDUE", pastDate,
    );

    // Клиент без просрочки
    const clientNotOverdue = await createClient("Клиент Не Просрочен");
    const futureDate = new Date("2099-01-01T00:00:00.000Z");
    await createBookingWithDebt(
      clientNotOverdue.id, eq.id, "CONFIRMED", "3000.00", "NOT_PAID", futureDate,
    );

    const res = await request(app)
      .get("/api/finance/debts?overdueOnly=true")
      .set(AUTH());
    expect(res.status).toBe(200);

    const overdueDebt = res.body.debts.find((d: any) => d.clientName === "Клиент Просрочен");
    const notOverdueDebt = res.body.debts.find((d: any) => d.clientName === "Клиент Не Просрочен");

    expect(overdueDebt).toBeDefined();
    expect(notOverdueDebt).toBeUndefined();
  });

  it("daysOverdue корректно считается для брони с expectedPaymentDate в прошлом", async () => {
    const eq = await createEquipment("Свет дней просрочки");
    const client = await createClient("Клиент Дней Просрочки");

    // Дата платежа — 10 дней назад
    const tenDaysAgo = new Date();
    tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);
    tenDaysAgo.setHours(0, 0, 0, 0);

    await createBookingWithDebt(
      client.id, eq.id, "CONFIRMED", "5000.00", "OVERDUE", tenDaysAgo,
    );

    const res = await request(app).get("/api/finance/debts").set(AUTH());
    expect(res.status).toBe(200);

    const debt = res.body.debts.find((d: any) => d.clientName === "Клиент Дней Просрочки");
    expect(debt).toBeDefined();
    // maxDaysOverdue должен быть около 10 дней
    expect(debt.maxDaysOverdue).toBeGreaterThanOrEqual(9);
    expect(debt.maxDaysOverdue).toBeLessThanOrEqual(11);

    // Проверяем daysOverdue в projects
    expect(debt.projects[0].daysOverdue).toBeGreaterThanOrEqual(9);
  });

  it("?minAmount фильтрует по минимальной сумме долга", async () => {
    const eq = await createEquipment("Свет минимум");

    const clientSmall = await createClient("Клиент Малый");
    await createBookingWithDebt(clientSmall.id, eq.id, "CONFIRMED", "100.00", "NOT_PAID");

    const clientLarge = await createClient("Клиент Большой");
    await createBookingWithDebt(clientLarge.id, eq.id, "CONFIRMED", "50000.00", "NOT_PAID");

    const res = await request(app)
      .get("/api/finance/debts?minAmount=1000")
      .set(AUTH());
    expect(res.status).toBe(200);

    const smallDebt = res.body.debts.find((d: any) => d.clientName === "Клиент Малый");
    const largeDebt = res.body.debts.find((d: any) => d.clientName === "Клиент Большой");

    expect(smallDebt).toBeUndefined();
    expect(largeDebt).toBeDefined();
  });

  it("возвращает корректную структуру summary", async () => {
    const res = await request(app).get("/api/finance/debts").set(AUTH());
    expect(res.status).toBe(200);
    expect(res.body.summary).toHaveProperty("totalClients");
    expect(res.body.summary).toHaveProperty("totalOutstanding");
    expect(res.body.summary).toHaveProperty("totalOverdue");
    expect(res.body.summary).toHaveProperty("asOf");
    expect(typeof res.body.summary.asOf).toBe("string");
  });

  it("?minAmount=abc возвращает 400 — невалидный параметр", async () => {
    const res = await request(app)
      .get("/api/finance/debts?minAmount=abc")
      .set(AUTH());
    expect(res.status).toBe(400);
  });
});
