/**
 * Regression: recomputeBookingFinance must be idempotent for bookings WITHOUT
 * a MAIN Estimate (DRAFT / PENDING_APPROVAL state, or legacy rows). Previously
 * the fallback branch read booking.finalAmount as the "equipment after discount"
 * base, then added transportSubtotalRub — so every call inflated finalAmount by
 * transport.
 *
 * Bug observed in prod: PENDING_APPROVAL booking with 1-day rental, MAIN
 * estimate not yet created, transport = 61 600 ₽. Eleven PATCHes → finalAmount
 * grew by 10 × 61 600 = 616 000 ₽ above the correct value.
 *
 * Aggravating factor: GET /api/finance/debts calls paymentStatusSyncForAllBookings()
 * which runs recomputeBookingFinance over every booking — so just opening the
 * debts page was enough to keep inflating.
 *
 * Fix: without a MAIN Estimate, leave finalAmount / totalEstimateAmount /
 * discountAmount / addonAmount untouched (no authoritative source for them).
 * Only refresh derived fields (amountPaid / amountOutstanding / paymentStatus).
 */

import path from "path";
import { execSync } from "child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-recompute-fallback.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-recompute-fb";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-recompute-fb";
process.env.WAREHOUSE_SECRET = "test-warehouse-rcm-fb-min16cc";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-recompute-fb-min16ch";

let prisma: any;
let clientId: string;

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
    data: { name: "Recompute fallback", phone: "+70000000777" },
  });
  clientId = client.id;
});

afterAll(async () => {
  await prisma?.$disconnect?.();
});

describe("recomputeBookingFinance — fallback without MAIN Estimate", () => {
  it("PENDING_APPROVAL booking with transport: repeated calls do NOT inflate finalAmount", async () => {
    const { recomputeBookingFinance } = await import("../services/finance");

    // Reproduces the prod incident: 11 PATCHes turned 137 950 into 753 950.
    const booking = await prisma.booking.create({
      data: {
        clientId,
        projectName: "Prod repro: Привет Ad",
        startDate: new Date(),
        endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
        status: "PENDING_APPROVAL",
        totalEstimateAmount: "152700",
        discountAmount: "76350",
        transportSubtotalRub: "61600",
        finalAmount: "137950", // correct value: estimate - discount + transport
        amountOutstanding: "137950",
      },
    });

    for (let i = 0; i < 11; i++) {
      await recomputeBookingFinance(booking.id);
    }

    const fresh = await prisma.booking.findUnique({ where: { id: booking.id } });
    expect(fresh.finalAmount.toString()).toBe("137950");
    expect(fresh.amountOutstanding.toString()).toBe("137950");
  });

  it("DRAFT booking: recompute does NOT mutate finalAmount when MAIN Estimate is absent", async () => {
    const { recomputeBookingFinance } = await import("../services/finance");

    const booking = await prisma.booking.create({
      data: {
        clientId,
        projectName: "Draft preserved",
        startDate: new Date(),
        endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
        status: "DRAFT",
        totalEstimateAmount: "10000",
        discountAmount: "3000",
        transportSubtotalRub: "2000",
        finalAmount: "9000",
        amountOutstanding: "9000",
      },
    });

    await recomputeBookingFinance(booking.id);
    await recomputeBookingFinance(booking.id);
    await recomputeBookingFinance(booking.id);

    const fresh = await prisma.booking.findUnique({ where: { id: booking.id } });
    expect(fresh.finalAmount.toString()).toBe("9000");
    expect(fresh.totalEstimateAmount.toString()).toBe("10000");
    expect(fresh.discountAmount.toString()).toBe("3000");
  });

  it("ISSUED booking with payments but no Estimate (legacy): derived fields refresh, finalAmount preserved", async () => {
    const { recomputeBookingFinance } = await import("../services/finance");

    const booking = await prisma.booking.create({
      data: {
        clientId,
        projectName: "Legacy ISSUED",
        startDate: new Date(),
        endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
        status: "ISSUED",
        finalAmount: "25000",
        amountPaid: "0",
        amountOutstanding: "25000",
        paymentStatus: "NOT_PAID",
      },
    });

    await prisma.payment.create({
      data: {
        bookingId: booking.id,
        direction: "INCOME",
        amount: "10000",
        status: "RECEIVED",
        paymentMethod: "CASH",
        receivedAt: new Date(),
      },
    });

    await recomputeBookingFinance(booking.id);

    const fresh = await prisma.booking.findUnique({ where: { id: booking.id } });
    expect(fresh.finalAmount.toString()).toBe("25000"); // unchanged
    expect(fresh.amountPaid.toString()).toBe("10000"); // refreshed
    expect(fresh.amountOutstanding.toString()).toBe("15000"); // refreshed
    expect(fresh.paymentStatus).toBe("PARTIALLY_PAID"); // refreshed
  });

  it("CONFIRMED booking WITH MAIN Estimate: recompute writes finalAmount from estimate (golden path)", async () => {
    const { recomputeBookingFinance } = await import("../services/finance");

    const booking = await prisma.booking.create({
      data: {
        clientId,
        projectName: "Confirmed golden",
        startDate: new Date(),
        endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
        status: "CONFIRMED",
        totalEstimateAmount: "0", // will be overwritten from estimate
        discountAmount: "0",
        finalAmount: "0",
        transportSubtotalRub: "1500",
      },
    });

    await prisma.estimate.create({
      data: {
        bookingId: booking.id,
        kind: "MAIN",
        shifts: 1,
        subtotal: "8000",
        discountPercent: "25",
        discountAmount: "2000",
        totalAfterDiscount: "6000",
      },
    });

    await recomputeBookingFinance(booking.id);
    await recomputeBookingFinance(booking.id);

    const fresh = await prisma.booking.findUnique({ where: { id: booking.id } });
    // finalAmount = mainAfterDiscount(6000) + transport(1500) = 7500
    expect(fresh.finalAmount.toString()).toBe("7500");
    expect(fresh.totalEstimateAmount.toString()).toBe("8000");
    expect(fresh.discountAmount.toString()).toBe("2000");
  });
});
