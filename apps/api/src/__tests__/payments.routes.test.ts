/**
 * Smoke tests for /api/payments.
 * Sprint 3: payments router — SUPER_ADMIN only (роли проверяются внутри роутера).
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-payments-routes.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-payments";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-payments";
process.env.WAREHOUSE_SECRET = "test-warehouse-payments";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-secret-payments-min16chars";

let app: Express;
let prisma: any;

let superAdminToken: string;
let warehouseToken: string;

// Ids созданные в beforeAll для тестов
let bookingId: string;
let createdPaymentId: string;

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
  const hash = await hashPassword("payments-test-pass");

  const superAdmin = await prisma.adminUser.create({
    data: { username: "payments_super", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  const warehouse = await prisma.adminUser.create({
    data: { username: "payments_warehouse", passwordHash: hash, role: "WAREHOUSE" },
  });

  superAdminToken = signSession({ userId: superAdmin.id, username: superAdmin.username, role: "SUPER_ADMIN" });
  warehouseToken = signSession({ userId: warehouse.id, username: warehouse.username, role: "WAREHOUSE" });

  // Создаём клиента и бронь для тестов
  const client = await prisma.client.create({
    data: { name: "Тест Клиент Payments", phone: "+79001234567" },
  });
  const booking = await prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: "Тест Проект",
      startDate: new Date("2026-05-01T10:00:00Z"),
      endDate: new Date("2026-05-03T10:00:00Z"),
      status: "CONFIRMED",
      totalEstimateAmount: "10000.00",
      finalAmount: "10000.00",
      discountAmount: "0.00",
      amountPaid: "0.00",
      amountOutstanding: "10000.00",
    },
  });
  bookingId = booking.id;
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

const apiKey = { "X-API-Key": "test-key-payments" };
function authHeaders(token: string) {
  return { ...apiKey, "Authorization": `Bearer ${token}` };
}

describe("/api/payments", () => {
  it("401 UNAUTHENTICATED — нет сессии, только API-ключ", async () => {
    const res = await request(app)
      .post("/api/payments")
      .set(apiKey)
      .send({ bookingId, amount: 1000, method: "CASH", receivedAt: new Date().toISOString() });
    expect(res.status).toBe(401);
    expect(res.body.details).toBe("UNAUTHENTICATED");
  });

  it("403 PAYMENT_LIMIT_EXCEEDED — WAREHOUSE не может создавать платежи на CONFIRMED брони", async () => {
    // Бронь в статусе CONFIRMED — WH-лимит отклоняет (допустимые: ISSUED, RETURNED)
    const res = await request(app)
      .post("/api/payments")
      .set(authHeaders(warehouseToken))
      .send({ bookingId, amount: 1000, method: "CASH", receivedAt: new Date().toISOString() });
    expect(res.status).toBe(403);
    expect(res.body.details).toMatchObject({ field: "bookingStatus" });
  });

  it("400 Zod validation — отсутствует amount", async () => {
    const res = await request(app)
      .post("/api/payments")
      .set(authHeaders(superAdminToken))
      .send({ bookingId, method: "CASH", receivedAt: new Date().toISOString() });
    expect(res.status).toBe(400);
  });

  it("201 SUPER_ADMIN создаёт платёж → amountPaid обновляется, AuditEntry записывается", async () => {
    const res = await request(app)
      .post("/api/payments")
      .set(authHeaders(superAdminToken))
      .send({
        bookingId,
        amount: 5000,
        method: "BANK_TRANSFER",
        receivedAt: new Date().toISOString(),
        note: "Первый взнос",
      });
    expect(res.status).toBe(201);
    expect(res.body.payment).toBeDefined();
    expect(Number(res.body.payment.amount)).toBe(5000);
    createdPaymentId = res.body.payment.id;

    // amountPaid на брони обновился
    const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
    expect(Number(booking.amountPaid.toString())).toBeGreaterThan(0);

    // AuditEntry записана
    const audit = await prisma.auditEntry.findFirst({
      where: { entityType: "Payment", action: "PAYMENT_CREATE" },
    });
    expect(audit).not.toBeNull();
  });

  it("DELETE SUPER_ADMIN удаляет платёж → amountPaid пересчитывается", async () => {
    // Сначала получаем amountPaid до удаления
    const beforeBooking = await prisma.booking.findUnique({ where: { id: bookingId } });
    const amountBefore = Number(beforeBooking.amountPaid.toString());

    const res = await request(app)
      .delete(`/api/payments/${createdPaymentId}`)
      .set(authHeaders(superAdminToken));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // amountPaid пересчитан (уменьшился или стал 0)
    const afterBooking = await prisma.booking.findUnique({ where: { id: bookingId } });
    const amountAfter = Number(afterBooking.amountPaid.toString());
    expect(amountAfter).toBeLessThan(amountBefore);
  });
});
