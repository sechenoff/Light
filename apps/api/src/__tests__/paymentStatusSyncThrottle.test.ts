/**
 * MC1: троттлинг полного пересчёта финансов броней.
 *
 * paymentStatusSyncForAllBookings раньше выполнял полный recompute на КАЖДЫЙ
 * GET /finance/dashboard | /finance/debts | /receivables — страница /finance
 * (Promise.all из двух запросов) запускала два полных прогона параллельно.
 *
 * Новый контракт:
 *  - не чаще раза в PAYMENT_SYNC_THROTTLE_MS (60 с);
 *  - параллельные вызовы разделяют один in-flight прогон (та же Promise);
 *  - вызов остаётся await-ируемым — никаких фоновых записей после ответа;
 *  - resetPaymentStatusSyncThrottle() сбрасывает состояние (для тестов).
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-payment-sync-throttle.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-sync-throttle";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-sync-throttle";
process.env.WAREHOUSE_SECRET = "test-warehouse-sync-min16chars";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-sync-throttle-min16chars";

let prisma: any;
let bookingId: string;

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

  const client = await prisma.client.create({
    data: { name: "Sync throttle client", phone: "+70000000888" },
  });

  // Легаси-бронь без MAIN Estimate: recompute освежает только производные
  // поля (amountPaid / amountOutstanding / paymentStatus) — удобно проверять,
  // сработал ли прогон.
  const booking = await prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: "Throttle repro",
      startDate: new Date(),
      endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
      status: "ISSUED",
      finalAmount: "20000",
      amountPaid: "0",
      amountOutstanding: "20000",
      paymentStatus: "NOT_PAID",
    },
  });
  bookingId = booking.id;

  await prisma.payment.create({
    data: {
      bookingId,
      direction: "INCOME",
      amount: "5000",
      status: "RECEIVED",
      paymentMethod: "CASH",
      receivedAt: new Date(),
    },
  });
});

afterAll(async () => {
  await prisma?.$disconnect?.();
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = TEST_DB_PATH + suffix;
    if (fs.existsSync(f)) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }
});

/** Портит производные поля напрямую в БД — имитация дрейфа. */
async function corruptDerivedFields() {
  await prisma.booking.update({
    where: { id: bookingId },
    data: { amountPaid: "0", amountOutstanding: "99999", paymentStatus: "NOT_PAID" },
  });
}

describe("paymentStatusSyncForAllBookings — троттлинг", () => {
  it("первый вызов выполняет полный пересчёт (awaited, до ответа)", async () => {
    const { paymentStatusSyncForAllBookings, resetPaymentStatusSyncThrottle } =
      await import("../services/finance");
    resetPaymentStatusSyncThrottle();

    await paymentStatusSyncForAllBookings();

    const fresh = await prisma.booking.findUnique({ where: { id: bookingId } });
    expect(fresh.amountPaid.toString()).toBe("5000");
    expect(fresh.amountOutstanding.toString()).toBe("15000");
    expect(fresh.paymentStatus).toBe("PARTIALLY_PAID");
  });

  it("повторный вызов в окне троттлинга пропускается (дрейф не чинится до истечения окна)", async () => {
    const { paymentStatusSyncForAllBookings } = await import("../services/finance");
    // Прогон из предыдущего теста только что завершился — окно 60 с активно.
    await corruptDerivedFields();

    await paymentStatusSyncForAllBookings();

    const fresh = await prisma.booking.findUnique({ where: { id: bookingId } });
    // Пересчёт НЕ выполнялся — испорченные значения на месте
    expect(fresh.amountOutstanding.toString()).toBe("99999");
    expect(fresh.paymentStatus).toBe("NOT_PAID");
  });

  it("после сброса троттлинга пересчёт выполняется снова", async () => {
    const { paymentStatusSyncForAllBookings, resetPaymentStatusSyncThrottle } =
      await import("../services/finance");
    resetPaymentStatusSyncThrottle();

    await paymentStatusSyncForAllBookings();

    const fresh = await prisma.booking.findUnique({ where: { id: bookingId } });
    expect(fresh.amountPaid.toString()).toBe("5000");
    expect(fresh.amountOutstanding.toString()).toBe("15000");
    expect(fresh.paymentStatus).toBe("PARTIALLY_PAID");
  });

  it("параллельные вызовы разделяют один in-flight прогон (та же Promise)", async () => {
    const { paymentStatusSyncForAllBookings, resetPaymentStatusSyncThrottle } =
      await import("../services/finance");
    resetPaymentStatusSyncThrottle();

    // Сценарий страницы /finance: Promise.all([dashboard, debts]) → два вызова
    const p1 = paymentStatusSyncForAllBookings();
    const p2 = paymentStatusSyncForAllBookings();
    expect(p2).toBe(p1);
    await Promise.all([p1, p2]);

    const fresh = await prisma.booking.findUnique({ where: { id: bookingId } });
    expect(fresh.amountOutstanding.toString()).toBe("15000");
  });
});
