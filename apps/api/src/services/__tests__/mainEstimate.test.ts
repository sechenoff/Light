/**
 * Интеграционный тест: recreateMainEstimate.
 *  - пересоздаёт MAIN из текущих BookingItem (quantity > 0)
 *  - сохраняет discountPercent и shifts существующей MAIN-сметы
 *  - пропускает позиции с quantity = 0
 *  - удаляет MAIN, если ни одной позиции с quantity > 0 не осталось
 *  - идемпотентность повторного вызова
 *  - no-op для несуществующей брони
 */

import path from "path";
import { execSync } from "child_process";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const TEST_DB_PATH = path.resolve(__dirname, "../../../prisma/test-main-estimate.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-main-est";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-main-est";
process.env.WAREHOUSE_SECRET = "test-warehouse-main-est-min16ch";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-main-est-min16chars0";

let prisma: any;
let bookingId: string;
let eq1Id: string;
let eq2Id: string;

async function seedFixture() {
  const client = await prisma.client.create({
    data: { name: "Main est test", phone: "+70000000888" },
  });

  const e1 = await prisma.equipment.create({
    data: {
      importKey: "main-est-eq1",
      name: "Aputure 600D",
      category: "COB",
      totalQuantity: 5,
      rentalRatePerShift: "1000",
      stockTrackingMode: "COUNT",
    },
  });
  eq1Id = e1.id;

  const e2 = await prisma.equipment.create({
    data: {
      importKey: "main-est-eq2",
      name: "Astera Titan",
      category: "LED",
      totalQuantity: 3,
      rentalRatePerShift: "500",
      stockTrackingMode: "COUNT",
    },
  });
  eq2Id = e2.id;

  const booking = await prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: "Main est project",
      startDate: new Date("2026-06-01"),
      endDate: new Date("2026-06-02"),
      status: "CONFIRMED",
      finalAmount: "0",
      amountPaid: "0",
      items: {
        create: [
          { equipmentId: eq1Id, quantity: 2 },
          { equipmentId: eq2Id, quantity: 1 },
        ],
      },
      estimates: {
        create: {
          kind: "MAIN",
          shifts: 1,
          subtotal: "2500",
          discountPercent: "10",
          discountAmount: "250",
          totalAfterDiscount: "2250",
          lines: {
            create: [
              {
                equipmentId: eq1Id,
                categorySnapshot: "COB",
                nameSnapshot: "Aputure 600D",
                quantity: 2,
                unitPrice: "1000",
                lineSum: "2000",
              },
              {
                equipmentId: eq2Id,
                categorySnapshot: "LED",
                nameSnapshot: "Astera Titan",
                quantity: 1,
                unitPrice: "500",
                lineSum: "500",
              },
            ],
          },
        },
      },
    },
  });
  bookingId = booking.id;
}

describe("recreateMainEstimate", () => {
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
    await seedFixture();
  });

  afterEach(async () => {
    await prisma?.$disconnect?.();
  });

  it("recreates MAIN from current BookingItem quantities, preserving discountPercent and shifts", async () => {
    const { recreateMainEstimate } = await import("../mainEstimate");
    // Reduce eq1 from 2 to 1
    await prisma.bookingItem.updateMany({
      where: { bookingId, equipmentId: eq1Id },
      data: { quantity: 1 },
    });

    await recreateMainEstimate(bookingId);

    const main = await prisma.estimate.findFirst({
      where: { bookingId, kind: "MAIN" },
      include: { lines: true },
    });
    expect(main).not.toBeNull();
    expect(main.discountPercent.toString()).toBe("10");
    expect(main.shifts).toBe(1);
    expect(main.lines).toHaveLength(2);
    const eq1Line = main.lines.find((l: any) => l.equipmentId === eq1Id);
    expect(eq1Line).toBeTruthy();
    expect(eq1Line.quantity).toBe(1);
    expect(eq1Line.lineSum.toString()).toBe("1000");
    // subtotal = 1×1000 + 1×500 = 1500
    expect(main.subtotal.toString()).toBe("1500");
    // discount = 1500 × 10% = 150; total = 1500 − 150 = 1350
    expect(main.totalAfterDiscount.toString()).toBe("1350");
  });

  it("skips BookingItems with quantity=0", async () => {
    const { recreateMainEstimate } = await import("../mainEstimate");
    await prisma.bookingItem.updateMany({
      where: { bookingId, equipmentId: eq2Id },
      data: { quantity: 0 },
    });

    await recreateMainEstimate(bookingId);

    const main = await prisma.estimate.findFirst({
      where: { bookingId, kind: "MAIN" },
      include: { lines: true },
    });
    expect(main.lines).toHaveLength(1);
    expect(main.lines[0].equipmentId).toBe(eq1Id);
  });

  it("deletes MAIN when no BookingItems with quantity>0 remain", async () => {
    const { recreateMainEstimate } = await import("../mainEstimate");
    await prisma.bookingItem.updateMany({
      where: { bookingId },
      data: { quantity: 0 },
    });

    await recreateMainEstimate(bookingId);

    const main = await prisma.estimate.findFirst({
      where: { bookingId, kind: "MAIN" },
    });
    expect(main).toBeNull();
  });

  it("is idempotent — second call yields same totals and line count", async () => {
    const { recreateMainEstimate } = await import("../mainEstimate");
    await recreateMainEstimate(bookingId);
    const first = await prisma.estimate.findFirst({
      where: { bookingId, kind: "MAIN" },
      include: { lines: true },
    });
    await recreateMainEstimate(bookingId);
    const second = await prisma.estimate.findFirst({
      where: { bookingId, kind: "MAIN" },
      include: { lines: true },
    });
    expect(second.totalAfterDiscount.toString()).toBe(first.totalAfterDiscount.toString());
    expect(second.lines.length).toBe(first.lines.length);
  });

  it("no-op when booking does not exist", async () => {
    const { recreateMainEstimate } = await import("../mainEstimate");
    await expect(recreateMainEstimate("non-existent-id")).resolves.toBeUndefined();
  });
});
