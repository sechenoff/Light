/**
 * Интеграционный тест: recomputeAddonEstimate (новая формула).
 *  - Формула: addonQty = max(0, BookingItem.quantity − MAIN.line.qty) per equipment.
 *  - Equipment не в MAIN — полностью считается добором.
 *  - Нет добора (BookingItem.quantity <= MAIN.line.qty) — ADDON удаляется.
 *  - Сохраняет shifts и discountPercent из MAIN.
 *  - Идемпотентность повторного вызова.
 *  - Нет MAIN → no-op.
 */

import path from "path";
import { execSync } from "child_process";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const TEST_DB_PATH = path.resolve(__dirname, "../../../prisma/test-addon-estimate.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-addon-est-svc";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-addon-est-svc";
process.env.WAREHOUSE_SECRET = "test-warehouse-addon-est-svc-min16ch";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-addon-est-svc-min16chars0";

let prisma: any;
let bookingId: string;
let eq1Id: string;
let eq2Id: string;

/**
 * Сеет бронь с MAIN-сметой. main.lines заводятся под equipmentId=eq1Id
 * с указанной quantity. BookingItem[eq1] создаётся с totalBookingItemQty.
 * BookingItem для eq2 НЕ создаётся (тесты добавляют по необходимости).
 */
async function seedBookingWithMain(opts: {
  mainQty: number; // MAIN.line.quantity для eq1
  totalBookingItemQty: number; // BookingItem.quantity для eq1
  shifts?: number;
  discountPercent?: string | null;
}) {
  const shifts = opts.shifts ?? 1;
  const discountPercent = opts.discountPercent ?? null;

  const client = await prisma.client.create({
    data: { name: "Addon est svc test", phone: "+70000000777" },
  });

  const e1 = await prisma.equipment.create({
    data: {
      importKey: "addon-est-svc-eq1",
      name: "Aputure 600D",
      category: "COB",
      totalQuantity: 10,
      rentalRatePerShift: "1000",
      stockTrackingMode: "COUNT",
    },
  });
  eq1Id = e1.id;

  const e2 = await prisma.equipment.create({
    data: {
      importKey: "addon-est-svc-eq2",
      name: "Astera Titan",
      category: "LED",
      totalQuantity: 10,
      rentalRatePerShift: "500",
      stockTrackingMode: "COUNT",
    },
  });
  eq2Id = e2.id;

  // MAIN.subtotal = mainQty × 1000 × shifts
  const mainSubtotal = opts.mainQty * 1000 * shifts;
  const discountAmt = discountPercent
    ? Math.round((mainSubtotal * Number(discountPercent)) / 100)
    : 0;

  const booking = await prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: "Addon est svc project",
      startDate: new Date("2026-06-01"),
      endDate: new Date("2026-06-02"),
      status: "CONFIRMED",
      finalAmount: "0",
      amountPaid: "0",
      items: {
        create:
          opts.totalBookingItemQty > 0
            ? [{ equipmentId: eq1Id, quantity: opts.totalBookingItemQty }]
            : [],
      },
      estimates: {
        create: {
          kind: "MAIN",
          shifts,
          subtotal: mainSubtotal.toString(),
          discountPercent,
          discountAmount: discountAmt.toString(),
          totalAfterDiscount: (mainSubtotal - discountAmt).toString(),
          lines:
            opts.mainQty > 0
              ? {
                  create: [
                    {
                      equipmentId: eq1Id,
                      categorySnapshot: "COB",
                      nameSnapshot: "Aputure 600D",
                      quantity: opts.mainQty,
                      unitPrice: "1000",
                      lineSum: (opts.mainQty * 1000 * shifts).toString(),
                    },
                  ],
                }
              : undefined,
        },
      },
    },
  });
  bookingId = booking.id;
}

describe("recomputeAddonEstimate (new formula)", () => {
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

  it("uses formula addonQty = max(0, BookingItem.quantity − MAIN.line.qty)", async () => {
    // Setup: bookingItem quantity=5, MAIN.line says 3 → ADDON should have quantity=2
    await seedBookingWithMain({ mainQty: 3, totalBookingItemQty: 5 });
    const { recomputeAddonEstimate } = await import("../addonEstimate");

    await recomputeAddonEstimate(bookingId);

    const addon = await prisma.estimate.findFirst({
      where: { bookingId, kind: "ADDON" },
      include: { lines: true },
    });
    expect(addon).not.toBeNull();
    expect(addon.lines).toHaveLength(1);
    expect(addon.lines[0].quantity).toBe(2);
    expect(addon.lines[0].equipmentId).toBe(eq1Id);
  });

  it("emits no ADDON when BookingItem.quantity <= MAIN.line.qty", async () => {
    // BookingItem.quantity=3, MAIN.line.quantity=3 → no ADDON
    await seedBookingWithMain({ mainQty: 3, totalBookingItemQty: 3 });
    const { recomputeAddonEstimate } = await import("../addonEstimate");

    await recomputeAddonEstimate(bookingId);

    const addon = await prisma.estimate.findFirst({
      where: { bookingId, kind: "ADDON" },
    });
    expect(addon).toBeNull();
  });

  it("emits ADDON for equipment NOT in MAIN — full quantity counts as addon", async () => {
    // Seed booking with MAIN.line[eq1].quantity=3, BookingItem[eq1].quantity=3 (no diff)
    // Then add BookingItem[eq2] quantity=2 (NOT in MAIN)
    // → ADDON should have one line with eq2 quantity=2
    await seedBookingWithMain({ mainQty: 3, totalBookingItemQty: 3 });
    await prisma.bookingItem.create({
      data: { bookingId, equipmentId: eq2Id, quantity: 2 },
    });
    const { recomputeAddonEstimate } = await import("../addonEstimate");

    await recomputeAddonEstimate(bookingId);

    const addon = await prisma.estimate.findFirst({
      where: { bookingId, kind: "ADDON" },
      include: { lines: true },
    });
    expect(addon).not.toBeNull();
    expect(addon.lines).toHaveLength(1);
    expect(addon.lines[0].equipmentId).toBe(eq2Id);
    expect(addon.lines[0].quantity).toBe(2);
  });

  it("inherits shifts and discountPercent from MAIN", async () => {
    // BookingItem.quantity=5, MAIN.line.quantity=2, shifts=2, discount=50% → addonQty=3.
    // ADDON.subtotal = 3 × 1000 × 2 = 6000. Discount 50% = 3000. totalAfterDiscount = 3000.
    await seedBookingWithMain({
      mainQty: 2,
      totalBookingItemQty: 5,
      shifts: 2,
      discountPercent: "50",
    });
    const { recomputeAddonEstimate } = await import("../addonEstimate");

    await recomputeAddonEstimate(bookingId);

    const addon = await prisma.estimate.findFirst({
      where: { bookingId, kind: "ADDON" },
      include: { lines: true },
    });
    expect(addon).not.toBeNull();
    expect(addon.shifts).toBe(2);
    expect(addon.discountPercent?.toString()).toBe("50");
    expect(addon.lines).toHaveLength(1);
    expect(addon.lines[0].quantity).toBe(3);
    expect(addon.lines[0].lineSum.toString()).toBe("6000");
    expect(addon.subtotal.toString()).toBe("6000");
    expect(addon.discountAmount.toString()).toBe("3000");
    expect(addon.totalAfterDiscount.toString()).toBe("3000");
  });

  it("is idempotent — second call yields same totals and line count", async () => {
    await seedBookingWithMain({ mainQty: 3, totalBookingItemQty: 5 });
    const { recomputeAddonEstimate } = await import("../addonEstimate");

    await recomputeAddonEstimate(bookingId);
    const first = await prisma.estimate.findFirst({
      where: { bookingId, kind: "ADDON" },
      include: { lines: true },
    });
    await recomputeAddonEstimate(bookingId);
    const second = await prisma.estimate.findFirst({
      where: { bookingId, kind: "ADDON" },
      include: { lines: true },
    });
    expect(second.totalAfterDiscount.toString()).toBe(first.totalAfterDiscount.toString());
    expect(second.lines.length).toBe(first.lines.length);
  });

  it("no-op when booking has no MAIN Estimate", async () => {
    const client = await prisma.client.create({
      data: { name: "Orphan", phone: "+70000000333" },
    });
    const orphan = await prisma.booking.create({
      data: {
        clientId: client.id,
        projectName: "DRAFT booking",
        startDate: new Date(),
        endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
        status: "DRAFT",
      },
    });
    const { recomputeAddonEstimate } = await import("../addonEstimate");

    await expect(recomputeAddonEstimate(orphan.id)).resolves.toBeUndefined();

    const addon = await prisma.estimate.findFirst({
      where: { bookingId: orphan.id, kind: "ADDON" },
    });
    expect(addon).toBeNull();
  });

  it("deletes existing ADDON when new computation yields no addon lines", async () => {
    // Start with addon-state (qty=5, main=3 → addon=2), then reduce bookingItem to match main
    await seedBookingWithMain({ mainQty: 3, totalBookingItemQty: 5 });
    const { recomputeAddonEstimate } = await import("../addonEstimate");

    await recomputeAddonEstimate(bookingId);
    const first = await prisma.estimate.findFirst({
      where: { bookingId, kind: "ADDON" },
    });
    expect(first).not.toBeNull();

    // Reduce bookingItem to match MAIN → no addon
    await prisma.bookingItem.updateMany({
      where: { bookingId, equipmentId: eq1Id },
      data: { quantity: 3 },
    });
    await recomputeAddonEstimate(bookingId);

    const after = await prisma.estimate.findFirst({
      where: { bookingId, kind: "ADDON" },
    });
    expect(after).toBeNull();
  });
});
