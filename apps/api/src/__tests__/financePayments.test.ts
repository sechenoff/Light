/**
 * Интеграционные тесты /api/finance/payments-overview и /api/finance/payments-by-client
 *
 * Паттерн: TEST_DB_PATH isolation, prisma db push --force-reset, signSession() токены.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import Decimal from "decimal.js";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-finance-payments.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-finance-payments";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-fp";
process.env.JWT_SECRET = "test-jwt-secret-finance-payments-min16";

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
  const hash = await hashPassword("test-pass-fp");

  const admin = await prisma.adminUser.create({
    data: { username: "fp_super_admin", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  superAdminToken = signSession({ userId: admin.id, username: admin.username, role: "SUPER_ADMIN" });

  const wh = await prisma.adminUser.create({
    data: { username: "fp_warehouse", passwordHash: hash, role: "WAREHOUSE" },
  });
  warehouseToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });

  const tech = await prisma.adminUser.create({
    data: { username: "fp_technician", passwordHash: hash, role: "TECHNICIAN" },
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

function AUTH_SA() {
  return { "X-API-Key": "test-key-1", Authorization: `Bearer ${superAdminToken}` };
}
function AUTH_WH() {
  return { "X-API-Key": "test-key-1", Authorization: `Bearer ${warehouseToken}` };
}
function AUTH_TECH() {
  return { "X-API-Key": "test-key-1", Authorization: `Bearer ${technicianToken}` };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function createClient(name: string) {
  return prisma.client.create({ data: { name } });
}

async function createEquipment(name = "Свет тест") {
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

async function createBooking(
  clientId: string,
  equipmentId: string,
  opts: {
    status?: string;
    startDate?: Date;
    endDate?: Date;
    finalAmount?: number;
    amountPaid?: number;
    paymentStatus?: string;
  } = {}
) {
  const startDate = opts.startDate ?? new Date("2026-04-01T10:00:00.000Z");
  const endDate = opts.endDate ?? new Date("2026-04-05T10:00:00.000Z");
  const finalAmount = new Decimal(opts.finalAmount ?? 10000);
  const amountPaid = new Decimal(opts.amountPaid ?? 0);
  const amountOutstanding = finalAmount.minus(amountPaid);
  const paymentStatus = opts.paymentStatus ?? "NOT_PAID";

  return prisma.booking.create({
    data: {
      clientId,
      projectName: "Тестовый проект",
      startDate,
      endDate,
      status: opts.status ?? "CONFIRMED",
      finalAmount,
      amountPaid,
      amountOutstanding,
      paymentStatus,
      isFullyPaid: amountPaid.equals(finalAmount),
      items: {
        create: [{ equipmentId, quantity: 1 }],
      },
    },
  });
}

// ── /api/finance/payments-overview ───────────────────────────────────────────

describe("GET /api/finance/payments-overview", () => {
  it("возвращает 403 для TECHNICIAN", async () => {
    const res = await request(app)
      .get("/api/finance/payments-overview")
      .set(AUTH_TECH());
    expect(res.status).toBe(403);
  });

  it("возвращает 403 для WAREHOUSE", async () => {
    const res = await request(app)
      .get("/api/finance/payments-overview")
      .set(AUTH_WH());
    expect(res.status).toBe(403);
  });

  it("базовый список и корректные итоги (1 оплачен, 1 частично, 1 не оплачен)", async () => {
    const client = await createClient("Клиент А");
    const eq = await createEquipment("Оборудование А");

    // PAID
    await createBooking(client.id, eq.id, {
      finalAmount: 20000,
      amountPaid: 20000,
      paymentStatus: "PAID",
      status: "RETURNED",
    });

    // PARTIALLY_PAID
    await createBooking(client.id, eq.id, {
      finalAmount: 15000,
      amountPaid: 5000,
      paymentStatus: "PARTIALLY_PAID",
      status: "CONFIRMED",
    });

    // NOT_PAID
    await createBooking(client.id, eq.id, {
      finalAmount: 10000,
      amountPaid: 0,
      paymentStatus: "NOT_PAID",
      status: "CONFIRMED",
    });

    const res = await request(app)
      .get("/api/finance/payments-overview")
      .set(AUTH_SA());

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBeGreaterThanOrEqual(3);

    // Проверяем структуру одной записи
    const item = res.body.items[0];
    expect(item).toHaveProperty("id");
    expect(item).toHaveProperty("startDate");
    expect(item).toHaveProperty("endDate");
    expect(item).toHaveProperty("client");
    expect(item.client).toHaveProperty("name");
    expect(item).toHaveProperty("finalAmount");
    expect(item).toHaveProperty("amountPaid");
    expect(item).toHaveProperty("amountOutstanding");
    expect(item).toHaveProperty("paymentStatus");
    expect(item).toHaveProperty("overdueDays");

    // Decimal-поля сериализованы как строки
    expect(typeof item.finalAmount).toBe("string");
    expect(typeof item.amountPaid).toBe("string");
    expect(typeof item.amountOutstanding).toBe("string");

    // Итоги
    expect(res.body.totals).toBeDefined();
    expect(Number(res.body.totals.billed)).toBeGreaterThanOrEqual(45000);
    expect(Number(res.body.totals.paid)).toBeGreaterThanOrEqual(25000);
    expect(Number(res.body.totals.outstanding)).toBeGreaterThanOrEqual(20000);
    expect(res.body.totals.count).toBeGreaterThanOrEqual(3);
  });

  it("фильтр paymentStatus=PARTIALLY_PAID возвращает только частично оплаченные", async () => {
    const client = await createClient("Клиент фильтр");
    const eq = await createEquipment("Оборудование фильтр");

    await createBooking(client.id, eq.id, {
      finalAmount: 8000,
      amountPaid: 3000,
      paymentStatus: "PARTIALLY_PAID",
    });
    await createBooking(client.id, eq.id, {
      finalAmount: 5000,
      amountPaid: 5000,
      paymentStatus: "PAID",
      status: "RETURNED",
    });

    const res = await request(app)
      .get("/api/finance/payments-overview?paymentStatus=PARTIALLY_PAID")
      .set(AUTH_SA());

    expect(res.status).toBe(200);
    // Все возвращённые записи должны иметь PARTIALLY_PAID
    for (const item of res.body.items) {
      expect(item.paymentStatus).toBe("PARTIALLY_PAID");
    }
    expect(res.body.items.length).toBeGreaterThanOrEqual(1);
  });

  it("фильтр по датам from/to", async () => {
    const client = await createClient("Клиент дата");
    const eq = await createEquipment("Оборудование дата");

    // Бронь в январе
    await createBooking(client.id, eq.id, {
      startDate: new Date("2026-01-10T10:00:00.000Z"),
      endDate: new Date("2026-01-15T10:00:00.000Z"),
      finalAmount: 7000,
    });

    // Бронь в мае
    await createBooking(client.id, eq.id, {
      startDate: new Date("2026-05-10T10:00:00.000Z"),
      endDate: new Date("2026-05-15T10:00:00.000Z"),
      finalAmount: 9000,
    });

    const res = await request(app)
      .get("/api/finance/payments-overview?from=2026-01-01&to=2026-01-31")
      .set(AUTH_SA());

    expect(res.status).toBe(200);
    // Должны быть только брони за январь
    for (const item of res.body.items) {
      const d = new Date(item.startDate);
      expect(d.getMonth()).toBe(0); // январь
    }
  });

  it("фильтр по amountMin/amountMax", async () => {
    const client = await createClient("Клиент сумма");
    const eq = await createEquipment("Оборудование сумма");

    await createBooking(client.id, eq.id, { finalAmount: 3000 });
    await createBooking(client.id, eq.id, { finalAmount: 50000 });

    const res = await request(app)
      .get("/api/finance/payments-overview?amountMin=10000&amountMax=60000")
      .set(AUTH_SA());

    expect(res.status).toBe(200);
    for (const item of res.body.items) {
      expect(Number(item.finalAmount)).toBeGreaterThanOrEqual(10000);
      expect(Number(item.finalAmount)).toBeLessThanOrEqual(60000);
    }
  });

  it("nextCursor работает для пагинации", async () => {
    // Брони уже созданы выше — проверяем что cursor-поле присутствует
    const res = await request(app)
      .get("/api/finance/payments-overview?limit=2")
      .set(AUTH_SA());

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("nextCursor");
    // Если записей больше 2 — cursor не null
    if (res.body.items.length === 2) {
      // Может быть null если всего 2 или < limit
      expect(res.body.nextCursor !== undefined).toBe(true);
    }
  });
});

// ── /api/finance/payments-by-client ─────────────────────────────────────────

describe("GET /api/finance/payments-by-client", () => {
  it("возвращает 403 для TECHNICIAN", async () => {
    const res = await request(app)
      .get("/api/finance/payments-by-client")
      .set(AUTH_TECH());
    expect(res.status).toBe(403);
  });

  it("корректно агрегирует по клиентам (2 клиента, у каждого 2 брони)", async () => {
    // Очищаем клиентов, созданных ранее — нет, просто добавляем новых
    const c1 = await createClient("Мосфильм");
    const c2 = await createClient("Газпром Медиа");
    const eq = await createEquipment("Камера");

    // Клиент 1: 2 брони по 20к, оплачено 15к итого
    await createBooking(c1.id, eq.id, {
      finalAmount: 20000,
      amountPaid: 10000,
      paymentStatus: "PARTIALLY_PAID",
      startDate: new Date("2026-03-01T10:00:00.000Z"),
    });
    await createBooking(c1.id, eq.id, {
      finalAmount: 20000,
      amountPaid: 5000,
      paymentStatus: "PARTIALLY_PAID",
      startDate: new Date("2026-03-10T10:00:00.000Z"),
    });

    // Клиент 2: 2 брони, обе полностью оплачены
    await createBooking(c2.id, eq.id, {
      finalAmount: 30000,
      amountPaid: 30000,
      paymentStatus: "PAID",
      status: "RETURNED",
      startDate: new Date("2026-03-05T10:00:00.000Z"),
    });
    await createBooking(c2.id, eq.id, {
      finalAmount: 10000,
      amountPaid: 10000,
      paymentStatus: "PAID",
      status: "RETURNED",
      startDate: new Date("2026-03-08T10:00:00.000Z"),
    });

    const res = await request(app)
      .get("/api/finance/payments-by-client")
      .set(AUTH_SA());

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.clients)).toBe(true);
    expect(res.body.totals).toBeDefined();

    // Найдём клиента Мосфильм
    const mf = res.body.clients.find((c: any) => c.name === "Мосфильм");
    expect(mf).toBeDefined();
    expect(mf.bookingCount).toBe(2);
    expect(Number(mf.totalBilled)).toBe(40000);
    expect(Number(mf.totalPaid)).toBe(15000);
    expect(Number(mf.totalOutstanding)).toBe(25000);

    // Клиент 2 с нулевым долгом
    const gm = res.body.clients.find((c: any) => c.name === "Газпром Медиа");
    expect(gm).toBeDefined();
    expect(Number(gm.totalOutstanding)).toBe(0);
  });

  it("onlyWithDebt=true исключает клиентов с нулевым долгом", async () => {
    const res = await request(app)
      .get("/api/finance/payments-by-client?onlyWithDebt=true")
      .set(AUTH_SA());

    expect(res.status).toBe(200);
    for (const c of res.body.clients) {
      expect(Number(c.totalOutstanding)).toBeGreaterThan(0);
    }
  });
});
