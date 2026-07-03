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

  // it("DELETE …") — REMOVED вместе с deprecated DELETE /api/payments/:id.
  // Soft-void покрыт voidPayment-тестом в paymentService.test.ts.
});

describe("GET /api/payments — methodTotals по всей выборке", () => {
  beforeAll(async () => {
    // Дополнительные платежи с датами вне текущего месяца (для dashboard-тестов ниже).
    // Первый платёж (5000 BANK_TRANSFER, receivedAt=сейчас) создан в предыдущем describe.
    await prisma.payment.createMany({
      data: [
        {
          bookingId,
          amount: "1000.00",
          method: "CASH",
          paymentMethod: "CASH",
          direction: "INCOME",
          status: "RECEIVED",
          receivedAt: new Date("2026-05-02T10:00:00Z"),
          paymentDate: new Date("2026-05-02T10:00:00Z"),
        },
        {
          bookingId,
          amount: "2500.00",
          method: "CARD",
          paymentMethod: "CARD",
          direction: "INCOME",
          status: "RECEIVED",
          receivedAt: new Date("2026-05-02T11:00:00Z"),
          paymentDate: new Date("2026-05-02T11:00:00Z"),
        },
        // Возврат — отрицательная сумма, не должен попадать в total/cash
        {
          bookingId,
          amount: "-500.00",
          method: "CASH",
          paymentMethod: "CASH",
          direction: "INCOME",
          status: "RECEIVED",
          receivedAt: new Date("2026-05-03T10:00:00Z"),
          paymentDate: new Date("2026-05-03T10:00:00Z"),
        },
        // Аннулированный — исключается из агрегатов
        {
          bookingId,
          amount: "9999.00",
          method: "CASH",
          paymentMethod: "CASH",
          direction: "INCOME",
          status: "RECEIVED",
          receivedAt: new Date("2026-05-04T10:00:00Z"),
          paymentDate: new Date("2026-05-04T10:00:00Z"),
          voidedAt: new Date("2026-05-05T10:00:00Z"),
          voidReason: "тест",
        },
      ],
    });
  });

  it("агрегаты считаются по всей отфильтрованной выборке, а не по странице (limit=1)", async () => {
    const res = await request(app)
      .get("/api/payments?limit=1")
      .set(authHeaders(superAdminToken));
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    // 4 действующих платежа (voided исключён default-фильтром)
    expect(res.body.total).toBe(4);
    // total = 5000 (BANK_TRANSFER) + 1000 (CASH) + 2500 (CARD); возврат и voided не входят
    expect(res.body.methodTotals).toMatchObject({
      total: "8500.00",
      cash: "1000.00",
      card: "2500.00",
      transfer: "5000.00",
      other: "0.00",
      refunds: "-500.00",
    });
  });

  it("агрегаты уважают фильтр method", async () => {
    const res = await request(app)
      .get("/api/payments?method=CASH")
      .set(authHeaders(superAdminToken));
    expect(res.status).toBe(200);
    expect(res.body.methodTotals.cash).toBe("1000.00");
    expect(res.body.methodTotals.transfer).toBe("0.00");
  });

  // MC1: чекбокс «Включить аннулированные» — includeVoided прокидывается в сервис
  it("?includeVoided=true — voided-платёж возвращается с voidedAt/voidReason, агрегаты без него", async () => {
    const res = await request(app)
      .get("/api/payments?includeVoided=true")
      .set(authHeaders(superAdminToken));
    expect(res.status).toBe(200);
    // 4 действующих + 1 аннулированный
    expect(res.body.total).toBe(5);
    const voided = res.body.items.find((p: any) => p.voidedAt !== null);
    expect(voided).toBeDefined();
    expect(voided.voidReason).toBe("тест");
    expect(voided.amount).toBe("9999");
    // methodTotals по-прежнему только по действующим платежам
    expect(res.body.methodTotals.total).toBe("8500.00");
    expect(res.body.methodTotals.cash).toBe("1000.00");
  });

  it("без includeVoided (и с =false) voided-платежи исключены", async () => {
    const resDefault = await request(app)
      .get("/api/payments")
      .set(authHeaders(superAdminToken));
    expect(resDefault.status).toBe(200);
    expect(resDefault.body.total).toBe(4);
    expect(resDefault.body.items.every((p: any) => p.voidedAt === null)).toBe(true);

    const resFalse = await request(app)
      .get("/api/payments?includeVoided=false")
      .set(authHeaders(superAdminToken));
    expect(resFalse.body.total).toBe(4);
  });
});

describe("GET /api/finance/dashboard — период from/to", () => {
  beforeAll(async () => {
    // Январский платёж + утверждённый январский расход — вне текущего месяца
    await prisma.payment.create({
      data: {
        bookingId,
        amount: "7000.00",
        method: "CASH",
        paymentMethod: "CASH",
        direction: "INCOME",
        status: "RECEIVED",
        receivedAt: new Date("2026-01-15T10:00:00Z"),
        paymentDate: new Date("2026-01-15T10:00:00Z"),
      },
    });
    await prisma.expense.create({
      data: {
        name: "Тест-расход январь",
        category: "OTHER",
        amount: "1500.00",
        expenseDate: new Date("2026-01-20T10:00:00Z"),
        approved: true,
      },
    });
  });

  it("403 для WAREHOUSE", async () => {
    const res = await request(app)
      .get("/api/finance/dashboard")
      .set(authHeaders(warehouseToken));
    expect(res.status).toBe(403);
  });

  it("?from&to — earned/spent/net считаются за указанный диапазон", async () => {
    const res = await request(app)
      .get(
        "/api/finance/dashboard?from=2026-01-01T00:00:00.000Z&to=2026-01-31T23:59:59.999Z"
      )
      .set(authHeaders(superAdminToken));
    expect(res.status).toBe(200);
    expect(res.body.earnedThisMonth).toBe("7000.00");
    expect(res.body.spentThisMonth).toBe("1500.00");
    expect(res.body.netThisMonth).toBe("5500.00");
  });

  it("без параметров — прежнее поведение: текущий календарный месяц", async () => {
    const res = await request(app)
      .get("/api/finance/dashboard")
      .set(authHeaders(superAdminToken));
    expect(res.status).toBe(200);
    // В текущем месяце получен только платёж 5000 (создан POST-тестом выше с receivedAt=сейчас);
    // январские и майские платежи не входят
    expect(res.body.earnedThisMonth).toBe("5000.00");
    expect(res.body.spentThisMonth).toBe("0.00");
  });

  it("400 на невалидный from", async () => {
    const res = await request(app)
      .get("/api/finance/dashboard?from=не-дата")
      .set(authHeaders(superAdminToken));
    expect(res.status).toBe(400);
  });
});
