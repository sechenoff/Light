/**
 * Интеграционный тест: completeSession принимает COUNT-режим repair/problem.
 *
 * Покрывает:
 *  - repairUnits в COUNT-форме (bookingItemId + quantity) создаёт Repair с null unitId
 *  - problemUnits в COUNT-форме создаёт ProblemItem с null equipmentUnitId
 *  - INVALID_SPLIT (400) когда repair+problem > BookingItem.quantity
 */

import path from "path";
import { execSync } from "child_process";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const TEST_DB_PATH = path.resolve(__dirname, "../../../prisma/test-return-count-split.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-return-count-split";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-return-count-split";
process.env.WAREHOUSE_SECRET = "test-warehouse-return-count-split-min16ch";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-return-count-split-min16ch00";

let prisma: any;

interface CountReturnFixture {
  bookingId: string;
  bookingItemId: string;
  sessionId: string;
  adminUserId: string;
}

async function seedCountReturnFixture(opts: { bookingItemQty: number }): Promise<CountReturnFixture> {
  const { hashPassword } = await import("../auth");
  const hash = await hashPassword("test-pass-return-count");
  const admin = await prisma.adminUser.create({
    data: {
      username: `return_count_admin_${Math.random().toString(36).slice(2, 10)}`,
      passwordHash: hash,
      role: "SUPER_ADMIN",
    },
  });

  const client = await prisma.client.create({
    data: { name: "Return count test", phone: "+70000000123" },
  });

  const equipment = await prisma.equipment.create({
    data: {
      importKey: `return-count-eq-${Math.random().toString(36).slice(2, 10)}`,
      name: "Sandbag 5kg",
      category: "Acc",
      rentalRatePerShift: "100",
      stockTrackingMode: "COUNT",
      totalQuantity: 10,
    },
  });

  const booking = await prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: "Return count test project",
      startDate: new Date("2026-06-01"),
      endDate: new Date("2026-06-02"),
      status: "ISSUED",
      amountPaid: "0",
      amountOutstanding: "0",
      totalEstimateAmount: "300",
      discountAmount: "0",
      finalAmount: "300",
    },
  });

  const bi = await prisma.bookingItem.create({
    data: {
      bookingId: booking.id,
      equipmentId: equipment.id,
      quantity: opts.bookingItemQty,
    },
  });

  const session = await prisma.scanSession.create({
    data: {
      bookingId: booking.id,
      workerName: "Тест приёмка",
      operation: "RETURN",
      status: "ACTIVE",
    },
  });

  return {
    bookingId: booking.id,
    bookingItemId: bi.id,
    sessionId: session.id,
    adminUserId: admin.id,
  };
}

describe("completeSession — COUNT-mode repair/problem", () => {
  beforeEach(async () => {
    execSync("npx prisma db push --skip-generate --force-reset", {
      cwd: path.resolve(__dirname, "../../.."),
      env: {
        ...process.env,
        DATABASE_URL: `file:${TEST_DB_PATH}`,
        PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes",
      },
      stdio: "pipe",
    });
    const pmod = await import("../../prisma");
    prisma = pmod.prisma;
  });

  afterEach(async () => {
    await prisma?.$disconnect?.();
  });

  it("creates Repair row with bookingItemId + quantity (null unitId) for COUNT repair form", async () => {
    const fx = await seedCountReturnFixture({ bookingItemQty: 3 });
    const { completeSession } = await import("../warehouseScan");

    await completeSession(fx.sessionId, {
      repairUnits: [{ bookingItemId: fx.bookingItemId, quantity: 2, comment: "Сломана защёлка" }],
      createdBy: fx.adminUserId,
    });

    const repairs = await prisma.repair.findMany({ where: { bookingItemId: fx.bookingItemId } });
    expect(repairs).toHaveLength(1);
    expect(repairs[0].unitId).toBeNull();
    expect(repairs[0].quantity).toBe(2);
    expect(repairs[0].reason).toBe("Сломана защёлка");
  });

  it("creates ProblemItem row with bookingItemId + quantity (null equipmentUnitId) for COUNT problem form", async () => {
    const fx = await seedCountReturnFixture({ bookingItemQty: 3 });
    const { completeSession } = await import("../warehouseScan");

    await completeSession(fx.sessionId, {
      problemUnits: [
        {
          bookingItemId: fx.bookingItemId,
          quantity: 1,
          reason: "LEFT_ON_SITE",
          comment: "Забыли на площадке",
          expectedBackDate: "2026-06-05T10:00:00.000Z",
        },
      ],
      createdBy: fx.adminUserId,
    });

    const problems = await prisma.problemItem.findMany({ where: { bookingItemId: fx.bookingItemId } });
    expect(problems).toHaveLength(1);
    expect(problems[0].equipmentUnitId).toBeNull();
    expect(problems[0].quantity).toBe(1);
    expect(problems[0].reason).toBe("LEFT_ON_SITE");
    expect(problems[0].comment).toBe("Забыли на площадке");
  });

  it("rejects with 400 INVALID_SPLIT when repair+problem > BookingItem.quantity", async () => {
    const fx = await seedCountReturnFixture({ bookingItemQty: 3 });
    const { completeSession } = await import("../warehouseScan");

    // BookingItem.quantity = 3; try to push 2 repair + 2 problem = 4 > 3
    await expect(
      completeSession(fx.sessionId, {
        repairUnits: [{ bookingItemId: fx.bookingItemId, quantity: 2, comment: "x" }],
        problemUnits: [
          {
            bookingItemId: fx.bookingItemId,
            quantity: 2,
            reason: "LOST",
            comment: "y",
          },
        ],
        createdBy: fx.adminUserId,
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "INVALID_SPLIT",
      details: {
        bookingItemId: fx.bookingItemId,
        repair: 2,
        problem: 2,
        totalQty: 3,
      },
    });
  });
});
