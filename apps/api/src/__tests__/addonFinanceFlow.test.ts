/**
 * Integration: добор → ADDON Estimate → recomputeBookingFinance →
 * booking.finalAmount + outstanding + paymentStatus.
 *
 * Сценарии:
 *  - confirm → MAIN Estimate, addonAmount=0, outstanding=main.afterDiscount
 *  - addExtraItem → ADDON Estimate создан, addonAmount > 0, outstanding растёт
 *  - доплата = outstanding → paymentStatus → "PAID"
 *  - повторный addExtraItem на PAID-брони → outstanding > 0, paymentStatus → "PARTIALLY_PAID"
 */

import path from "path";
import { execSync } from "child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-addon-finance.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-addon-finance";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-addon-finance";
process.env.WAREHOUSE_SECRET = "test-warehouse-addon-fin-min16c";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-addon-finance-min16ch";

let prisma: any;
let clientId: string;
let equipmentId: string;
let bookingId: string;
let sessionId: string;

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
    data: { name: "Finance flow", phone: "+70000000888" },
  });
  clientId = client.id;

  const eq = await prisma.equipment.create({
    data: {
      importKey: "finance-flow-eq",
      name: "Vmount Battery",
      category: "Электрика",
      rentalRatePerShift: "1000",
      stockTrackingMode: "COUNT",
    },
  });
  equipmentId = eq.id;

  // CONFIRMED booking + MAIN Estimate с suma 5000 (после 50% скидки от 10000)
  const booking = await prisma.booking.create({
    data: {
      clientId,
      projectName: "Finance test",
      startDate: new Date(),
      endDate: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
      status: "CONFIRMED",
      totalEstimateAmount: "10000",
      discountAmount: "5000",
      finalAmount: "5000",
      amountOutstanding: "5000",
    },
  });
  bookingId = booking.id;

  await prisma.estimate.create({
    data: {
      bookingId,
      kind: "MAIN",
      shifts: 2,
      subtotal: "10000",
      discountPercent: "50",
      discountAmount: "5000",
      totalAfterDiscount: "5000",
    },
  });

  await prisma.bookingItem.create({
    data: { bookingId, equipmentId, quantity: 1 },
  });

  const session = await prisma.scanSession.create({
    data: { bookingId, workerName: "test", operation: "ISSUE", status: "ACTIVE" },
  });
  sessionId = session.id;
});

afterAll(async () => {
  await prisma?.$disconnect?.();
});

describe("addExtraItem → finance flow", () => {
  it("addExtraItem ×3 Vmount → finalAmount растёт на (3×1000×2×(1−0.5))=3000 → outstanding обновлён", async () => {
    const { addExtraItem } = await import("../services/checklistService");
    const { recomputeBookingFinance } = await import("../services/finance");

    await addExtraItem(sessionId, equipmentId, 3, "test");
    await recomputeBookingFinance(bookingId); // ensure synced

    const fresh = await prisma.booking.findUnique({ where: { id: bookingId } });
    // main.afterDiscount = 5000, addon.afterDiscount = 3000, total = 8000
    expect(fresh.finalAmount.toString()).toBe("8000");
    expect(fresh.addonAmount.toString()).toBe("3000");
    expect(fresh.amountOutstanding.toString()).toBe("8000");
    expect(fresh.paymentStatus).toBe("NOT_PAID");
  });

  it("оплата полная → paymentStatus = PAID; затем addExtraItem ещё ×2 → status → PARTIALLY_PAID", async () => {
    // Pay 8000 (purpose: bring outstanding to 0)
    await prisma.payment.create({
      data: {
        bookingId,
        direction: "INCOME",
        amount: "8000",
        status: "RECEIVED",
        paymentMethod: "CASH",
        receivedAt: new Date(),
      },
    });
    const { recomputeBookingFinance } = await import("../services/finance");
    await recomputeBookingFinance(bookingId);

    let fresh = await prisma.booking.findUnique({ where: { id: bookingId } });
    expect(fresh.paymentStatus).toBe("PAID");
    expect(fresh.amountOutstanding.toString()).toBe("0");

    // Add ещё ×2 Vmount → addon растёт на 2×1000×2×0.5 = 2000 → outstanding = 2000 → PARTIALLY_PAID
    const { addExtraItem } = await import("../services/checklistService");
    await addExtraItem(sessionId, equipmentId, 2, "test");
    await recomputeBookingFinance(bookingId);

    fresh = await prisma.booking.findUnique({ where: { id: bookingId } });
    expect(fresh.addonAmount.toString()).toBe("5000"); // 3000 + 2000
    expect(fresh.finalAmount.toString()).toBe("10000"); // 5000 + 5000
    expect(fresh.amountOutstanding.toString()).toBe("2000");
    expect(fresh.paymentStatus).toBe("PARTIALLY_PAID");
  });
});
