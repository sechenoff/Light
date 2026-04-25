/**
 * Интеграционные тесты WH-limits для POST /api/payments.
 * WAREHOUSE может записывать платежи только при соблюдении ограничений:
 * - method ∈ {CASH, CARD}
 * - amount ≤ 100 000 ₽
 * - booking.status ∈ {ISSUED, RETURNED}
 * Нарушение → 403 PAYMENT_LIMIT_EXCEEDED.
 * SUPER_ADMIN обходит ограничения.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-payment-limits.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-paylimits";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-paylimits";
process.env.JWT_SECRET = "test-jwt-secret-paylimits-min16chars";

let app: Express;
let prisma: any;
let superAdminToken: string;
let warehouseToken: string;
let warehouseUserId: string;

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
    data: { username: "paylim_sa", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  superAdminToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });

  const wh = await prisma.adminUser.create({
    data: { username: "paylim_wh", passwordHash: hash, role: "WAREHOUSE" },
  });
  warehouseToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });
  warehouseUserId = wh.id;
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

let _counter = 0;

async function createBookingWithStatus(status: string) {
  const uid = `${Date.now()}_${++_counter}`;
  const client = await prisma.client.upsert({
    where: { name: `ПлатёжТест-${uid}` },
    update: {},
    create: { name: `ПлатёжТест-${uid}` },
  });
  const equipment = await prisma.equipment.create({
    data: {
      importKey: `paylim-eq-${uid}`,
      name: `Тест оборудование ${uid}`,
      category: "Тест",
      rentalRatePerShift: 1000,
      totalQuantity: 1,
    },
  });
  const booking = await prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: `Проект ${uid}`,
      startDate: new Date("2026-05-01T10:00:00Z"),
      endDate: new Date("2026-05-03T18:00:00Z"),
      status,
      items: {
        create: { equipmentId: equipment.id, quantity: 1 },
      },
    },
  });
  return booking;
}

const validPaymentBody = (bookingId: string) => ({
  bookingId,
  amount: 5000,
  method: "CASH",
  receivedAt: new Date().toISOString(),
});

describe("WH-limits: метод оплаты", () => {
  it("WAREHOUSE — CASH разрешён на ISSUED брони", async () => {
    const booking = await createBookingWithStatus("ISSUED");
    const res = await request(app)
      .post("/api/payments")
      .set(AUTH_WH())
      .send(validPaymentBody(booking.id));
    expect(res.status).toBe(201);
  });

  it("WAREHOUSE — CARD разрешён на ISSUED брони", async () => {
    const booking = await createBookingWithStatus("ISSUED");
    const res = await request(app)
      .post("/api/payments")
      .set(AUTH_WH())
      .send({ ...validPaymentBody(booking.id), method: "CARD" });
    expect(res.status).toBe(201);
  });

  it("WAREHOUSE — BANK_TRANSFER запрещён → 403 PAYMENT_LIMIT_EXCEEDED", async () => {
    const booking = await createBookingWithStatus("ISSUED");
    const res = await request(app)
      .post("/api/payments")
      .set(AUTH_WH())
      .send({ ...validPaymentBody(booking.id), method: "BANK_TRANSFER" });
    expect(res.status).toBe(403);
    expect(res.body.details).toMatchObject({ field: "method" });
  });

  it("WAREHOUSE — OTHER запрещён → 403 PAYMENT_LIMIT_EXCEEDED", async () => {
    const booking = await createBookingWithStatus("ISSUED");
    const res = await request(app)
      .post("/api/payments")
      .set(AUTH_WH())
      .send({ ...validPaymentBody(booking.id), method: "OTHER" });
    expect(res.status).toBe(403);
    expect(res.body.details).toMatchObject({ field: "method" });
  });

  it("SUPER_ADMIN — BANK_TRANSFER разрешён без ограничений", async () => {
    const booking = await createBookingWithStatus("ISSUED");
    const res = await request(app)
      .post("/api/payments")
      .set(AUTH_SA())
      .send({ ...validPaymentBody(booking.id), method: "BANK_TRANSFER" });
    expect(res.status).toBe(201);
  });
});

describe("WH-limits: лимит суммы", () => {
  it("WAREHOUSE — сумма 100000 разрешена (граница включена)", async () => {
    const booking = await createBookingWithStatus("ISSUED");
    const res = await request(app)
      .post("/api/payments")
      .set(AUTH_WH())
      .send({ ...validPaymentBody(booking.id), amount: 100000 });
    expect(res.status).toBe(201);
  });

  it("WAREHOUSE — сумма 100001 запрещена → 403 PAYMENT_LIMIT_EXCEEDED", async () => {
    const booking = await createBookingWithStatus("ISSUED");
    const res = await request(app)
      .post("/api/payments")
      .set(AUTH_WH())
      .send({ ...validPaymentBody(booking.id), amount: 100001 });
    expect(res.status).toBe(403);
    expect(res.body.details).toMatchObject({ field: "amount", limit: 100000 });
  });

  it("SUPER_ADMIN — сумма 500000 разрешена без ограничений", async () => {
    const booking = await createBookingWithStatus("ISSUED");
    const res = await request(app)
      .post("/api/payments")
      .set(AUTH_SA())
      .send({ ...validPaymentBody(booking.id), amount: 500000 });
    expect(res.status).toBe(201);
  });
});

describe("WH-limits: статус брони", () => {
  it("WAREHOUSE — ISSUED разрешён", async () => {
    const booking = await createBookingWithStatus("ISSUED");
    const res = await request(app)
      .post("/api/payments")
      .set(AUTH_WH())
      .send(validPaymentBody(booking.id));
    expect(res.status).toBe(201);
  });

  it("WAREHOUSE — RETURNED разрешён", async () => {
    const booking = await createBookingWithStatus("RETURNED");
    const res = await request(app)
      .post("/api/payments")
      .set(AUTH_WH())
      .send(validPaymentBody(booking.id));
    expect(res.status).toBe(201);
  });

  it("WAREHOUSE — DRAFT запрещён → 403 PAYMENT_LIMIT_EXCEEDED", async () => {
    const booking = await createBookingWithStatus("DRAFT");
    const res = await request(app)
      .post("/api/payments")
      .set(AUTH_WH())
      .send(validPaymentBody(booking.id));
    expect(res.status).toBe(403);
    expect(res.body.details).toMatchObject({ field: "bookingStatus" });
  });

  it("WAREHOUSE — CONFIRMED запрещён → 403 PAYMENT_LIMIT_EXCEEDED", async () => {
    const booking = await createBookingWithStatus("CONFIRMED");
    const res = await request(app)
      .post("/api/payments")
      .set(AUTH_WH())
      .send(validPaymentBody(booking.id));
    expect(res.status).toBe(403);
    expect(res.body.details).toMatchObject({ field: "bookingStatus" });
  });

  it("SUPER_ADMIN — DRAFT разрешён без ограничений", async () => {
    const booking = await createBookingWithStatus("DRAFT");
    const res = await request(app)
      .post("/api/payments")
      .set(AUTH_SA())
      .send(validPaymentBody(booking.id));
    expect(res.status).toBe(201);
  });
});

describe("WH-limits: аудит", () => {
  it("Успешный WH-платёж записывает PAYMENT_CREATE_BY_WH в аудит", async () => {
    const booking = await createBookingWithStatus("ISSUED");
    const res = await request(app)
      .post("/api/payments")
      .set(AUTH_WH())
      .send(validPaymentBody(booking.id));
    expect(res.status).toBe(201);
    const paymentId = res.body.payment.id;
    const audit = await prisma.auditEntry.findFirst({
      where: { action: "PAYMENT_CREATE_BY_WH", entityId: paymentId },
    });
    expect(audit).not.toBeNull();
    expect(audit.userId).toBe(warehouseUserId);
  });
});
