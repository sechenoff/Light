/**
 * Интеграционный тест: recomputeAddonEstimate.
 *  - пустой набор → удаляет ADDON Estimate
 *  - 3 records по 2 equipment → ADDON с 2 lines, корректные totals
 *  - та же скидка %, что у MAIN
 *  - идемпотентность повторного вызова
 *  - нет MAIN → no-op
 */

import path from "path";
import { execSync } from "child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-addon-est.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-addon-est";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-addon-est";
process.env.WAREHOUSE_SECRET = "test-warehouse-addon-est-min16ch";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-addon-est-min16chars0";

let prisma: any;
let clientId: string;
let equipmentAId: string;
let equipmentBId: string;
let bookingId: string;
let sessionId: string;
let bookingItemAId: string;

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
    data: { name: "Addon est test", phone: "+70000000999" },
  });
  clientId = client.id;

  const eqA = await prisma.equipment.create({
    data: {
      importKey: "addon-est-A",
      name: "Vmount Battery",
      category: "Электрика",
      rentalRatePerShift: "1000",
      stockTrackingMode: "COUNT",
    },
  });
  equipmentAId = eqA.id;

  const eqB = await prisma.equipment.create({
    data: {
      importKey: "addon-est-B",
      name: "Adapter Vmount",
      category: "Электрика",
      rentalRatePerShift: "500",
      stockTrackingMode: "COUNT",
    },
  });
  equipmentBId = eqB.id;

  const booking = await prisma.booking.create({
    data: {
      clientId,
      projectName: "Addon test booking",
      startDate: new Date(),
      endDate: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
      status: "CONFIRMED",
    },
  });
  bookingId = booking.id;

  // MAIN Estimate с скидкой 50% и shifts=2
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

  const bi = await prisma.bookingItem.create({
    data: { bookingId, equipmentId: equipmentAId, quantity: 1 },
  });
  bookingItemAId = bi.id;

  const session = await prisma.scanSession.create({
    data: {
      bookingId,
      workerName: "test",
      operation: "ISSUE",
      status: "ACTIVE",
    },
  });
  sessionId = session.id;
});

afterAll(async () => {
  await prisma?.$disconnect?.();
});

describe("recomputeAddonEstimate", () => {
  it("no AddonRecord → ADDON Estimate is deleted (or not created)", async () => {
    const svc = await import("../services/addonEstimate");
    await svc.recomputeAddonEstimate(bookingId);
    const addon = await prisma.estimate.findFirst({ where: { bookingId, kind: "ADDON" } });
    expect(addon).toBeNull();
  });

  it("aggregates 3 records over 2 equipment into 2 lines with same discount % as MAIN", async () => {
    // 2× Vmount + 5× Vmount + 1× Adapter Vmount
    await prisma.addonRecord.createMany({
      data: [
        { bookingId, sessionId, bookingItemId: bookingItemAId, equipmentId: equipmentAId, quantity: 2, createdBy: "test" },
        { bookingId, sessionId, bookingItemId: bookingItemAId, equipmentId: equipmentAId, quantity: 5, createdBy: "test" },
      ],
    });
    // Adapter — separate BookingItem (test multiline aggregation)
    const biB = await prisma.bookingItem.create({
      data: { bookingId, equipmentId: equipmentBId, quantity: 1 },
    });
    await prisma.addonRecord.create({
      data: { bookingId, sessionId, bookingItemId: biB.id, equipmentId: equipmentBId, quantity: 1, createdBy: "test" },
    });

    const svc = await import("../services/addonEstimate");
    await svc.recomputeAddonEstimate(bookingId);

    const addon = await prisma.estimate.findFirst({
      where: { bookingId, kind: "ADDON" },
      include: { lines: true },
    });
    expect(addon).toBeTruthy();
    expect(addon.shifts).toBe(2);
    expect(addon.discountPercent?.toString()).toBe("50");
    expect(addon.lines).toHaveLength(2);

    // Vmount: 7 шт × 1000 ₽/смена × 2 смены = 14 000 ₽
    const vmount = addon.lines.find((l: any) => l.equipmentId === equipmentAId);
    expect(vmount).toBeTruthy();
    expect(vmount.quantity).toBe(7);
    expect(vmount.lineSum.toString()).toBe("14000");

    // Adapter: 1 шт × 500 × 2 = 1 000 ₽
    const adapter = addon.lines.find((l: any) => l.equipmentId === equipmentBId);
    expect(adapter.quantity).toBe(1);
    expect(adapter.lineSum.toString()).toBe("1000");

    // Subtotal = 14 000 + 1 000 = 15 000. Скидка 50% = 7 500. После скидки = 7 500.
    expect(addon.subtotal.toString()).toBe("15000");
    expect(addon.discountAmount.toString()).toBe("7500");
    expect(addon.totalAfterDiscount.toString()).toBe("7500");
  });

  it("idempotent re-run produces the same snapshot", async () => {
    const svc = await import("../services/addonEstimate");
    const before = await prisma.estimate.findFirst({
      where: { bookingId, kind: "ADDON" },
    });
    await svc.recomputeAddonEstimate(bookingId);
    const after = await prisma.estimate.findFirst({
      where: { bookingId, kind: "ADDON" },
    });
    expect(after.subtotal.toString()).toBe(before.subtotal.toString());
    expect(after.totalAfterDiscount.toString()).toBe(before.totalAfterDiscount.toString());
    // delete-then-create → new ID expected (snapshot replaced atomically)
    expect(after.id).not.toBe(before.id);
  });

  it("no-op when booking has no MAIN Estimate", async () => {
    const orphan = await prisma.booking.create({
      data: {
        clientId,
        projectName: "DRAFT booking",
        startDate: new Date(),
        endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
        status: "DRAFT",
      },
    });
    const svc = await import("../services/addonEstimate");
    await expect(svc.recomputeAddonEstimate(orphan.id)).resolves.toBeUndefined();
    const addon = await prisma.estimate.findFirst({
      where: { bookingId: orphan.id, kind: "ADDON" },
    });
    expect(addon).toBeNull();
  });
});
