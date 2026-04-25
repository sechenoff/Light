/**
 * Интеграционные тесты paymentService
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-payment-service.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-payment-svc";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-payment-svc";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-payment-svc";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-secret-payment-svc-min16chars";

let prisma: any;
let clientId: string;
let bookingId: string;
let adminUserId: string;

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

  const pmod = await import("../prisma");
  prisma = pmod.prisma;

  const { hashPassword } = await import("../services/auth");
  const hash = await hashPassword("test-pass-123");

  const admin = await prisma.adminUser.create({
    data: { username: "payment_svc_admin", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  adminUserId = admin.id;

  const client = await prisma.client.create({
    data: { name: "Тест клиент", phone: "+7999000001" },
  });
  clientId = client.id;

  const booking = await prisma.booking.create({
    data: {
      clientId,
      projectName: "Тестовый проект",
      startDate: new Date("2026-05-01"),
      endDate: new Date("2026-05-03"),
      status: "CONFIRMED",
      finalAmount: "100000",
      totalEstimateAmount: "100000",
      amountPaid: "0",
      amountOutstanding: "100000",
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

describe("createPayment", () => {
  it("создаёт платёж, увеличивает amountPaid и уменьшает amountOutstanding", async () => {
    const { createPayment } = await import("../services/paymentService");
    const payment = await createPayment({
      bookingId,
      amount: "30000",
      method: "CASH",
      receivedAt: new Date("2026-05-01T10:00:00Z"),
      note: "Первый взнос",
      createdBy: adminUserId,
    });

    expect(payment.id).toBeTruthy();
    expect(payment.direction).toBe("INCOME");
    expect(payment.status).toBe("RECEIVED");
    expect(payment.method).toBe("CASH");
    expect(payment.paymentMethod).toBe("CASH"); // legacy backfill

    // Проверяем пересчёт брони
    const updated = await prisma.booking.findUnique({ where: { id: bookingId } });
    expect(Number(updated.amountPaid.toString())).toBeCloseTo(30000, 0);
    expect(Number(updated.amountOutstanding.toString())).toBeCloseTo(70000, 0);
  });

  it("записывает audit entry с action PAYMENT_CREATE", async () => {
    const auditEntry = await prisma.auditEntry.findFirst({
      where: { action: "PAYMENT_CREATE", entityType: "Payment" },
      orderBy: { createdAt: "desc" },
    });
    expect(auditEntry).toBeTruthy();
    expect(auditEntry.before).toBeNull();
    expect(auditEntry.after).toBeTruthy();
  });

  it("выбрасывает 404 если бронь не существует", async () => {
    const { createPayment } = await import("../services/paymentService");
    await expect(
      createPayment({
        bookingId: "non-existent-id",
        amount: "1000",
        method: "CASH",
        receivedAt: new Date(),
        createdBy: adminUserId,
      }),
    ).rejects.toMatchObject({ status: 404, details: "BOOKING_NOT_FOUND" });
  });
});

describe("deletePayment", () => {
  it("аннулирует платёж (soft-void) через deprecated deletePayment и пересчитывает суммы брони", async () => {
    const { createPayment, deletePayment } = await import("../services/paymentService");

    const payment = await createPayment({
      bookingId,
      amount: "10000",
      method: "BANK_TRANSFER",
      receivedAt: new Date("2026-05-02T10:00:00Z"),
      createdBy: adminUserId,
    });

    const beforeDel = await prisma.booking.findUnique({ where: { id: bookingId } });
    const paidBefore = Number(beforeDel.amountPaid.toString());

    await deletePayment(payment.id, adminUserId);

    const afterDel = await prisma.booking.findUnique({ where: { id: bookingId } });
    const paidAfter = Number(afterDel.amountPaid.toString());

    expect(paidAfter).toBeCloseTo(paidBefore - 10000, 0);

    // Finance Phase 2: deletePayment delegates to voidPayment — audit writes PAYMENT_VOID
    const auditEntry = await prisma.auditEntry.findFirst({
      where: { action: "PAYMENT_VOID", entityType: "Payment", entityId: payment.id },
    });
    expect(auditEntry).toBeTruthy();
    expect(auditEntry.before).toBeTruthy();
    // Soft-void: after is not null (contains voidedAt etc.)
    expect(auditEntry.after).toBeTruthy();

    // Payment record still exists (soft-void, not hard delete)
    const voidedPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(voidedPayment).toBeTruthy();
    expect(voidedPayment.voidedAt).toBeTruthy();
  });
});

describe("updatePayment", () => {
  it("изменяет сумму, пересчитывает amountPaid, audit имеет before.amount и after.amount", async () => {
    const { createPayment, updatePayment } = await import("../services/paymentService");

    const payment = await createPayment({
      bookingId,
      amount: "5000",
      method: "CARD",
      receivedAt: new Date("2026-05-03T10:00:00Z"),
      createdBy: adminUserId,
    });

    const before = await prisma.booking.findUnique({ where: { id: bookingId } });
    const paidBefore = Number(before.amountPaid.toString());

    await updatePayment(payment.id, { amount: "8000" }, adminUserId);

    const after = await prisma.booking.findUnique({ where: { id: bookingId } });
    const paidAfter = Number(after.amountPaid.toString());

    // Delta: +3000
    expect(paidAfter).toBeCloseTo(paidBefore + 3000, 0);

    // Audit
    const auditEntry = await prisma.auditEntry.findFirst({
      where: { action: "PAYMENT_UPDATE", entityType: "Payment", entityId: payment.id },
    });
    expect(auditEntry).toBeTruthy();
    const beforeData = JSON.parse(auditEntry.before);
    const afterData = JSON.parse(auditEntry.after);
    expect(beforeData.amount).toBeTruthy();
    expect(afterData.amount).toBeTruthy();
    expect(Number(beforeData.amount)).toBeCloseTo(5000, 0);
    expect(Number(afterData.amount)).toBeCloseTo(8000, 0);
  });
});

describe("listPayments", () => {
  it("фильтрует по bookingId и сортирует по receivedAt desc", async () => {
    const { listPayments } = await import("../services/paymentService");

    const result = await listPayments({ bookingId });
    expect(result.total).toBeGreaterThan(0);
    expect(result.items.every((p: any) => p.bookingId === bookingId)).toBe(true);

    // Проверяем порядок: receivedAt desc
    const dates = result.items.map((p: any) => new Date(p.receivedAt ?? p.paymentDate).getTime());
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i - 1]).toBeGreaterThanOrEqual(dates[i]);
    }
  });
});
