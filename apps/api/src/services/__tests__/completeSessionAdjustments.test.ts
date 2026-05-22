/**
 * Интеграционный тест: completeSession с issuanceAdjustments (Task 7).
 *
 * Покрывает:
 *  - COUNT-mode happy path: уменьшение BookingItem.quantity + recreate MAIN
 *  - N=0: BookingItem остаётся (qty=0), MAIN исключает его
 *  - UNIT-mode happy path: освобождает (M − N) неотсканированных юнитов
 *  - UNIT-mode rejection: все отсканированы → 409 ADJUSTMENT_CONFLICTS_WITH_SCANS
 *  - OVERPAID transition: paid=5000, скидываем на 1500 → finalAmount=3500 < paid
 *  - summary.mainOriginalAfterDiscount snapshot (до adjustments)
 *  - Пустой массив adjustments эквивалентен отсутствию параметра
 */

import path from "path";
import { execSync } from "child_process";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const TEST_DB_PATH = path.resolve(__dirname, "../../../prisma/test-issue-adjustments.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-issue-adj";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-issue-adj";
process.env.WAREHOUSE_SECRET = "test-warehouse-issue-adj-min16ch";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-issue-adj-min16ch00000";

let prisma: any;

interface CountFixture {
  bookingId: string;
  equipmentId: string;
  bookingItemId: string;
  sessionId: string;
  adminUserId: string;
}

async function seedCountFixture(opts: {
  bookingItemQty: number;
  mainLineQty: number;
  rentalRatePerShift?: string;
  shifts?: number;
  paid?: string;
  finalAmount?: string;
  discountAmount?: string;
  subtotal?: string;
  totalAfterDiscount?: string;
}): Promise<CountFixture> {
  const rate = opts.rentalRatePerShift ?? "1000";
  const shifts = opts.shifts ?? 1;
  const paid = opts.paid ?? "0";
  const finalAmount = opts.finalAmount ?? "0";
  const discountAmount = opts.discountAmount ?? "0";
  const subtotal = opts.subtotal ?? (Number(rate) * opts.mainLineQty * shifts).toString();
  const totalAfterDiscount = opts.totalAfterDiscount ?? subtotal;

  const { hashPassword } = await import("../auth");
  const hash = await hashPassword("test-pass-issue-adj");
  const admin = await prisma.adminUser.create({
    data: {
      username: `issue_adj_admin_${Math.random().toString(36).slice(2, 10)}`,
      passwordHash: hash,
      role: "SUPER_ADMIN",
    },
  });

  const client = await prisma.client.create({
    data: { name: "Issue adj test", phone: "+70000000999" },
  });

  const equipment = await prisma.equipment.create({
    data: {
      importKey: `issue-adj-eq-${Math.random().toString(36).slice(2, 10)}`,
      name: "SkyPanel S60",
      category: "Свет",
      rentalRatePerShift: rate,
      stockTrackingMode: "COUNT",
      totalQuantity: 10,
    },
  });

  const booking = await prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: "Issue adj project",
      startDate: new Date("2026-06-01"),
      endDate: new Date("2026-06-03"),
      status: "CONFIRMED",
      amountPaid: paid,
      amountOutstanding: "0",
      totalEstimateAmount: subtotal,
      discountAmount,
      finalAmount,
    },
  });

  await prisma.estimate.create({
    data: {
      bookingId: booking.id,
      kind: "MAIN",
      shifts,
      subtotal,
      discountAmount,
      totalAfterDiscount,
      lines: {
        create: [
          {
            equipmentId: equipment.id,
            categorySnapshot: "Свет",
            nameSnapshot: "SkyPanel S60",
            quantity: opts.mainLineQty,
            unitPrice: rate,
            lineSum: (Number(rate) * opts.mainLineQty * shifts).toString(),
          },
        ],
      },
    },
  });

  const bi = await prisma.bookingItem.create({
    data: { bookingId: booking.id, equipmentId: equipment.id, quantity: opts.bookingItemQty },
  });

  // Опциональный платёж (для OVERPAID).
  if (Number(paid) > 0) {
    await prisma.payment.create({
      data: {
        bookingId: booking.id,
        direction: "INCOME",
        amount: paid,
        status: "RECEIVED",
        paymentMethod: "CASH",
        receivedAt: new Date(),
      },
    });
  }

  const session = await prisma.scanSession.create({
    data: {
      bookingId: booking.id,
      workerName: "Тест склад",
      operation: "ISSUE",
      status: "ACTIVE",
    },
  });

  return {
    bookingId: booking.id,
    equipmentId: equipment.id,
    bookingItemId: bi.id,
    sessionId: session.id,
    adminUserId: admin.id,
  };
}

interface UnitFixture {
  bookingId: string;
  equipmentId: string;
  bookingItemId: string;
  sessionId: string;
  unitIds: string[]; // все юниты (3 шт по умолчанию)
  reservationIds: string[]; // BookingItemUnit ids в том же порядке
  adminUserId: string;
}

async function seedUnitFixture(opts: {
  unitCount: number; // обычно 3
  scannedIndices: number[]; // индексы [0..unitCount-1], которые отсканированы
}): Promise<UnitFixture> {
  const { hashPassword } = await import("../auth");
  const hash = await hashPassword("test-pass-issue-adj-unit");
  const admin = await prisma.adminUser.create({
    data: {
      username: `issue_adj_unit_admin_${Math.random().toString(36).slice(2, 10)}`,
      passwordHash: hash,
      role: "SUPER_ADMIN",
    },
  });

  const client = await prisma.client.create({
    data: { name: "Issue adj unit test", phone: "+70000000888" },
  });

  const equipment = await prisma.equipment.create({
    data: {
      importKey: `issue-adj-unit-eq-${Math.random().toString(36).slice(2, 10)}`,
      name: "Astera Titan",
      category: "LED",
      rentalRatePerShift: "1000",
      stockTrackingMode: "UNIT",
    },
  });

  const unitIds: string[] = [];
  for (let i = 0; i < opts.unitCount; i++) {
    const u = await prisma.equipmentUnit.create({
      data: {
        equipmentId: equipment.id,
        barcode: `IADJ-${i}-${Math.random().toString(36).slice(2, 8)}`,
        status: "AVAILABLE",
      },
    });
    unitIds.push(u.id);
  }

  const booking = await prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: "Issue adj unit project",
      startDate: new Date("2026-06-01"),
      endDate: new Date("2026-06-03"),
      status: "CONFIRMED",
      amountPaid: "0",
      amountOutstanding: "0",
      totalEstimateAmount: (1000 * opts.unitCount).toString(),
      discountAmount: "0",
      finalAmount: (1000 * opts.unitCount).toString(),
    },
  });

  await prisma.estimate.create({
    data: {
      bookingId: booking.id,
      kind: "MAIN",
      shifts: 1,
      subtotal: (1000 * opts.unitCount).toString(),
      discountAmount: "0",
      totalAfterDiscount: (1000 * opts.unitCount).toString(),
      lines: {
        create: [
          {
            equipmentId: equipment.id,
            categorySnapshot: "LED",
            nameSnapshot: "Astera Titan",
            quantity: opts.unitCount,
            unitPrice: "1000",
            lineSum: (1000 * opts.unitCount).toString(),
          },
        ],
      },
    },
  });

  const bi = await prisma.bookingItem.create({
    data: { bookingId: booking.id, equipmentId: equipment.id, quantity: opts.unitCount },
  });

  const reservationIds: string[] = [];
  for (const uid of unitIds) {
    const r = await prisma.bookingItemUnit.create({
      data: { bookingItemId: bi.id, equipmentUnitId: uid },
    });
    reservationIds.push(r.id);
  }

  const session = await prisma.scanSession.create({
    data: {
      bookingId: booking.id,
      workerName: "Тест склад unit",
      operation: "ISSUE",
      status: "ACTIVE",
    },
  });

  for (const idx of opts.scannedIndices) {
    await prisma.scanRecord.create({
      data: { sessionId: session.id, equipmentUnitId: unitIds[idx], hmacVerified: false },
    });
  }

  return {
    bookingId: booking.id,
    equipmentId: equipment.id,
    bookingItemId: bi.id,
    sessionId: session.id,
    unitIds,
    reservationIds,
    adminUserId: admin.id,
  };
}

describe("completeSession with issuanceAdjustments", () => {
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

  it("COUNT-mode: reduces BookingItem.quantity from 3 to 2 and recreates MAIN with qty=2", async () => {
    const fx = await seedCountFixture({
      bookingItemQty: 3,
      mainLineQty: 3,
      finalAmount: "3000",
      subtotal: "3000",
      totalAfterDiscount: "3000",
    });
    const { completeSession } = await import("../warehouseScan");

    await completeSession(fx.sessionId, {
      issuanceAdjustments: [{ bookingItemId: fx.bookingItemId, actualQuantity: 2 }],
      createdBy: fx.adminUserId,
    });

    const updated = await prisma.bookingItem.findUnique({ where: { id: fx.bookingItemId } });
    expect(updated.quantity).toBe(2);

    const main = await prisma.estimate.findFirst({
      where: { bookingId: fx.bookingId, kind: "MAIN" },
      include: { lines: true },
    });
    expect(main).not.toBeNull();
    const eqLine = main.lines.find((l: any) => l.equipmentId === fx.equipmentId);
    expect(eqLine).toBeTruthy();
    expect(eqLine.quantity).toBe(2);
  });

  it("N=0: BookingItem.quantity becomes 0 and MAIN excludes this equipment", async () => {
    const fx = await seedCountFixture({
      bookingItemQty: 3,
      mainLineQty: 3,
      finalAmount: "3000",
      subtotal: "3000",
      totalAfterDiscount: "3000",
    });
    const { completeSession } = await import("../warehouseScan");

    await completeSession(fx.sessionId, {
      issuanceAdjustments: [{ bookingItemId: fx.bookingItemId, actualQuantity: 0 }],
      createdBy: fx.adminUserId,
    });

    const updated = await prisma.bookingItem.findUnique({ where: { id: fx.bookingItemId } });
    expect(updated.quantity).toBe(0);

    const main = await prisma.estimate.findFirst({
      where: { bookingId: fx.bookingId, kind: "MAIN" },
      include: { lines: true },
    });
    // Если у брони не осталось позиций с qty>0, MAIN удаляется.
    if (main) {
      expect(main.lines.find((l: any) => l.equipmentId === fx.equipmentId)).toBeUndefined();
    } else {
      // ok — MAIN был удалён (нет позиций > 0)
      expect(main).toBeNull();
    }
  });

  it("UNIT-mode: releases (M − N) BookingItemUnit records for non-scanned units", async () => {
    // 3 reservations, scan units 0 and 1 (not 2). actualQuantity=2 → release 1 unit (the unscanned one).
    const fx = await seedUnitFixture({ unitCount: 3, scannedIndices: [0, 1] });
    const { completeSession } = await import("../warehouseScan");

    await completeSession(fx.sessionId, {
      issuanceAdjustments: [{ bookingItemId: fx.bookingItemId, actualQuantity: 2 }],
      createdBy: fx.adminUserId,
    });

    const remaining = await prisma.bookingItemUnit.findMany({
      where: { bookingItemId: fx.bookingItemId },
    });
    expect(remaining).toHaveLength(2);
    const remainingUnitIds = new Set(remaining.map((r: any) => r.equipmentUnitId));
    // Оставшиеся юниты — те что отсканированы.
    expect(remainingUnitIds.has(fx.unitIds[0])).toBe(true);
    expect(remainingUnitIds.has(fx.unitIds[1])).toBe(true);
    // Удалённый юнит — НЕ отсканирован.
    expect(remainingUnitIds.has(fx.unitIds[2])).toBe(false);
  });

  it("UNIT-mode: throws 409 ADJUSTMENT_CONFLICTS_WITH_SCANS when scanned > requested", async () => {
    // Все 3 юнита отсканированы. Попытка снять до 2 → конфликт.
    const fx = await seedUnitFixture({ unitCount: 3, scannedIndices: [0, 1, 2] });
    const { completeSession } = await import("../warehouseScan");

    let captured: any = null;
    try {
      await completeSession(fx.sessionId, {
        issuanceAdjustments: [{ bookingItemId: fx.bookingItemId, actualQuantity: 2 }],
        createdBy: fx.adminUserId,
      });
    } catch (e) {
      captured = e;
    }
    expect(captured).not.toBeNull();
    expect(captured.status).toBe(409);
    expect(captured.code).toBe("ADJUSTMENT_CONFLICTS_WITH_SCANS");
    expect(captured.details).toMatchObject({
      bookingItemId: fx.bookingItemId,
      scannedCount: 3,
      requestedQuantity: 2,
    });

    // Транзакция должна откатиться — BookingItem.quantity не изменился.
    const bi = await prisma.bookingItem.findUnique({ where: { id: fx.bookingItemId } });
    expect(bi.quantity).toBe(3);
    // Все 3 резервации сохранились.
    const remaining = await prisma.bookingItemUnit.findMany({
      where: { bookingItemId: fx.bookingItemId },
    });
    expect(remaining).toHaveLength(3);
  });

  it("OVERPAID: paymentStatus transitions when paid > new finalAmount after adjustment", async () => {
    // Seed: paid=5000, finalAmount=5000. Reduce 5 → 3 (delta 2 × 1000 = 2000) → finalAmount=3000 < paid.
    const fx = await seedCountFixture({
      bookingItemQty: 5,
      mainLineQty: 5,
      paid: "5000",
      finalAmount: "5000",
      subtotal: "5000",
      totalAfterDiscount: "5000",
    });
    const { completeSession } = await import("../warehouseScan");

    await completeSession(fx.sessionId, {
      issuanceAdjustments: [{ bookingItemId: fx.bookingItemId, actualQuantity: 3 }],
      createdBy: fx.adminUserId,
    });

    const booking = await prisma.booking.findUnique({ where: { id: fx.bookingId } });
    expect(booking.paymentStatus).toBe("OVERPAID");
  });

  it("summary.mainOriginalAfterDiscount snapshots pre-adjustment value; mainAfterDiscount reflects post-adjustment", async () => {
    // before: 5×1000=5000; adjust to 3×1000=3500 ❌ нет — adjust to 3 даёт 3000.
    // Делаем «before=5000, after=3500» через partial: 5 → 3.5 нельзя (int), используем shifts.
    // Чтобы получить «было 5000 → стало 3500», используем rate=500, shifts=2, bookingItemQty=5 → 5×500×2=5000;
    // adjust to 3.5 нельзя. Используем quantity 7 → 3500 после adjustment до 5 (5×500×2=5000... все равно 5000).
    // Проще: rate=1000, bookingItemQty=5, adjust to 3 → 3000 (было 5000 → стало 3000). Тогда:
    //   mainOriginalAfterDiscount = "5000", mainAfterDiscount = "3000".
    // Тест проверяет именно snapshot и обновление.
    const fx = await seedCountFixture({
      bookingItemQty: 5,
      mainLineQty: 5,
      finalAmount: "5000",
      subtotal: "5000",
      totalAfterDiscount: "5000",
    });
    const { completeSession } = await import("../warehouseScan");

    const summary = await completeSession(fx.sessionId, {
      issuanceAdjustments: [{ bookingItemId: fx.bookingItemId, actualQuantity: 3 }],
      createdBy: fx.adminUserId,
    });

    expect(summary.mainOriginalAfterDiscount).toBe("5000");
    expect(summary.mainAfterDiscount).toBe("3000");
  });

  it("empty adjustments array == no adjustments (BookingItem.quantity preserved)", async () => {
    const fx = await seedCountFixture({
      bookingItemQty: 3,
      mainLineQty: 3,
      finalAmount: "3000",
      subtotal: "3000",
      totalAfterDiscount: "3000",
    });
    const { completeSession } = await import("../warehouseScan");

    const before = await prisma.bookingItem.findUnique({ where: { id: fx.bookingItemId } });

    await completeSession(fx.sessionId, {
      issuanceAdjustments: [],
      createdBy: fx.adminUserId,
    });

    const after = await prisma.bookingItem.findUnique({ where: { id: fx.bookingItemId } });
    expect(after.quantity).toBe(before.quantity);
  });

  // ── U2: inline-добор через issuanceAdjustments (positive delta) ─────────────
  it("allows actualQuantity > bi.quantity if within addCap (inline-добор)", async () => {
    // Seed: Equipment.totalQuantity=5, BookingItem.quantity=2, no overlapping
    // other bookings → addCap = 5 − 0 − 2 = 3.
    // Adjustment: actualQuantity=4 (delta +2) → must succeed; BookingItem.quantity
    // обновляется до 4, MAIN пересчитывается.
    const fx = await seedCountFixture({
      bookingItemQty: 2,
      mainLineQty: 2,
      finalAmount: "2000",
      subtotal: "2000",
      totalAfterDiscount: "2000",
    });
    const { completeSession } = await import("../warehouseScan");

    await completeSession(fx.sessionId, {
      issuanceAdjustments: [{ bookingItemId: fx.bookingItemId, actualQuantity: 4 }],
      createdBy: fx.adminUserId,
    });

    const updated = await prisma.bookingItem.findUnique({ where: { id: fx.bookingItemId } });
    expect(updated.quantity).toBe(4);

    const audit = await prisma.auditEntry.findFirst({
      where: {
        action: "BOOKING_ITEM_QUANTITY_INCREASED",
        entityType: "Booking",
        entityId: fx.bookingId,
      },
    });
    expect(audit).not.toBeNull();
  });

  it("rejects actualQuantity > bi.quantity + addCap with 409 ADDON_OVER_STOCK", async () => {
    // Seed: Equipment.totalQuantity=5, BookingItem.quantity=2; добавим другую
    // пересекающуюся бронь с quantity=2 → occupiedByOthers=2.
    // addCap = 5 − 2 − 2 = 1. Adjustment actualQuantity=5 (delta +3) > addCap=1
    // → 409 ADDON_OVER_STOCK { addCap: 1, requested: 5, alreadyInBooking: 2 }.
    const fx = await seedCountFixture({
      bookingItemQty: 2,
      mainLineQty: 2,
      finalAmount: "2000",
      subtotal: "2000",
      totalAfterDiscount: "2000",
    });
    // seedCountFixture создаёт equipment с totalQuantity=10; для этого теста
    // нужно totalQuantity=5, чтобы получить addCap=1 после добавления
    // пересекающейся брони с qty=2.
    await prisma.equipment.update({
      where: { id: fx.equipmentId },
      data: { totalQuantity: 5 },
    });

    // Другой бронь на пересекающиеся даты, занимающая 2 шт того же оборудования.
    const otherClient = await prisma.client.create({
      data: { name: "Other booking client", phone: "+70000000777" },
    });
    const otherBooking = await prisma.booking.create({
      data: {
        clientId: otherClient.id,
        projectName: "Other overlapping",
        startDate: new Date("2026-06-01"),
        endDate: new Date("2026-06-03"),
        status: "CONFIRMED",
        totalEstimateAmount: "2000",
        discountAmount: "0",
        finalAmount: "2000",
        amountOutstanding: "2000",
        amountPaid: "0",
      },
    });
    await prisma.bookingItem.create({
      data: { bookingId: otherBooking.id, equipmentId: fx.equipmentId, quantity: 2 },
    });

    const { completeSession } = await import("../warehouseScan");

    let captured: any = null;
    try {
      await completeSession(fx.sessionId, {
        issuanceAdjustments: [{ bookingItemId: fx.bookingItemId, actualQuantity: 5 }],
        createdBy: fx.adminUserId,
      });
    } catch (e) {
      captured = e;
    }
    expect(captured).not.toBeNull();
    expect(captured.status).toBe(409);
    expect(captured.code).toBe("ADDON_OVER_STOCK");
    expect(captured.details).toMatchObject({
      addCap: 1,
      requested: 5,
      alreadyInBooking: 2,
    });

    // Транзакция откатилась — BookingItem.quantity не изменился.
    const bi = await prisma.bookingItem.findUnique({ where: { id: fx.bookingItemId } });
    expect(bi.quantity).toBe(2);
  });

  it("UNIT-mode positive delta: bumps quantity without creating BookingItemUnit reservations", async () => {
    // 3 unit-reservations, scan только первые 2. actualQuantity=4 (delta +1).
    // Equipment.totalQuantity по seedUnitFixture не задан явно → дефолт 0,
    // что даст addCap < 0. Пересчитаем с totalQuantity=5 после сидинга,
    // чтобы addCap = 5 − 0 − 3 = 2 (других пересекающихся броней нет).
    const fx = await seedUnitFixture({ unitCount: 3, scannedIndices: [0, 1] });
    await prisma.equipment.update({
      where: { id: fx.equipmentId },
      data: { totalQuantity: 5 },
    });

    const { completeSession } = await import("../warehouseScan");

    await completeSession(fx.sessionId, {
      issuanceAdjustments: [{ bookingItemId: fx.bookingItemId, actualQuantity: 4 }],
      createdBy: fx.adminUserId,
    });

    // BookingItem.quantity = 4 (физическая выдача operator-ом).
    const bi = await prisma.bookingItem.findUnique({ where: { id: fx.bookingItemId } });
    expect(bi.quantity).toBe(4);

    // BookingItemUnit reservations: inline-добор НЕ создаёт новых резерваций,
    // а основной блок completeSession удаляет не-отсканированные резервации
    // (стандартная сверка). Итог: остаются 2 резервации (только отсканированные).
    // Контракт: при положительной дельте мы НЕ добавляем reservation-rows.
    const reservations = await prisma.bookingItemUnit.findMany({
      where: { bookingItemId: fx.bookingItemId },
    });
    expect(reservations.length).toBe(2);
    const scannedReservations = reservations.filter(
      (r: any) => r.equipmentUnitId === fx.unitIds[0] || r.equipmentUnitId === fx.unitIds[1],
    );
    expect(scannedReservations.length).toBe(2);
  });
});
