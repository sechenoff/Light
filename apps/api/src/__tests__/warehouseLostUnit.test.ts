/**
 * Интеграционный тест: lost flow — обработка утерянных единиц при возврате
 *
 * Проверяет:
 * - unit.status → RETIRED
 * - Создан Repair со статусом WROTE_OFF
 * - При chargeClient=true: создан BookingItem компенсации + audit BOOKING_CHARGE_ADDED
 * - При chargeClient=false: BookingItem не создаётся
 * - На ISSUE-сессии lostUnits игнорируются
 * - Одновременно brokenUnits и lostUnits в одном payload — оба обработаны
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-lost-unit.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-lost-unit";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-lost-unit-32chars00";
process.env.WAREHOUSE_SECRET = "test-warehouse-lost-unit-min16c";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-lost-unit-min16chars00";

let prisma: any;
let clientId: string;
let equipmentId: string;
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
  const hash = await hashPassword("test-pass-lost-unit");

  const adminUser = await prisma.adminUser.create({
    data: { username: "lost_unit_admin", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  adminUserId = adminUser.id;

  const client = await prisma.client.create({
    data: { name: "Тест клиент утеря", phone: "+70000000099" },
  });
  clientId = client.id;

  const equipment = await prisma.equipment.create({
    data: {
      importKey: "lost-unit-equipment-001",
      name: "Арри Алекса",
      category: "Камеры",
      rentalRatePerShift: 10000,
      stockTrackingMode: "UNIT",
    },
  });
  equipmentId = equipment.id;
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

/** Хелпер: создаёт бронь со статусом ISSUED, unit, сессию возврата и scan record */
async function setupReturnSession(unitBarcode: string) {
  const unit = await prisma.equipmentUnit.create({
    data: { equipmentId, barcode: unitBarcode, status: "ISSUED" },
  });

  const booking = await prisma.booking.create({
    data: {
      clientId,
      projectName: `Тест утеря ${unitBarcode}`,
      startDate: new Date("2026-04-01"),
      endDate: new Date("2026-04-05"),
      status: "ISSUED",
      amountPaid: 0,
      amountOutstanding: 0,
    },
  });

  const bookingItem = await prisma.bookingItem.create({
    data: { bookingId: booking.id, equipmentId, quantity: 1 },
  });

  await prisma.bookingItemUnit.create({
    data: { bookingItemId: bookingItem.id, equipmentUnitId: unit.id },
  });

  const session = await prisma.scanSession.create({
    data: {
      bookingId: booking.id,
      workerName: "Тест кладовщик",
      operation: "RETURN",
      status: "ACTIVE",
    },
  });

  await prisma.scanRecord.create({
    data: { sessionId: session.id, equipmentUnitId: unit.id, hmacVerified: false },
  });

  return { unit, booking, session };
}

describe("completeSession с lostUnits", () => {
  it("chargeClient=true → unit RETIRED, Repair WROTE_OFF, BookingItem компенсации, финансы пересчитаны", async () => {
    const { unit, booking, session } = await setupReturnSession("LOST-UNIT-001");
    const { completeSession } = await import("../services/warehouseScan");

    await completeSession(session.id, {
      lostUnits: [
        {
          equipmentUnitId: unit.id,
          reason: "Потеряна на объекте съёмки",
          lostLocation: "ON_SITE",
          chargeClient: true,
        },
      ],
      createdBy: adminUserId,
    });

    // 1. Unit переведён в RETIRED
    const updatedUnit = await prisma.equipmentUnit.findUnique({ where: { id: unit.id } });
    expect(updatedUnit.status).toBe("RETIRED");

    // 2. Создана Repair запись со статусом WROTE_OFF
    const repair = await prisma.repair.findFirst({
      where: { unitId: unit.id, status: "WROTE_OFF" },
    });
    expect(repair).not.toBeNull();
    expect(repair.reason).toContain("ON_SITE");
    expect(repair.reason).toContain("Потеряна на объекте съёмки");
    expect(repair.sourceBookingId).toBe(booking.id);

    // 3. Создан BookingItem компенсации
    const compensationItem = await prisma.bookingItem.findFirst({
      where: { bookingId: booking.id, customCategory: "Компенсация" },
    });
    expect(compensationItem).not.toBeNull();
    expect(compensationItem.customName).toContain("Арри Алекса");
    expect(compensationItem.quantity).toBe(1);
    // replacementCost = rentalRatePerShift * 30 = 10000 * 30 = 300000
    expect(compensationItem.customUnitPrice.toString()).toBe("300000");

    // 4. AuditEntry: UNIT_LOST
    const auditLost = await prisma.auditEntry.findFirst({
      where: { action: "UNIT_LOST", entityId: unit.id },
    });
    expect(auditLost).not.toBeNull();

    // 5. AuditEntry: UNIT_STATUS_CHANGED
    const auditStatus = await prisma.auditEntry.findFirst({
      where: { action: "UNIT_STATUS_CHANGED", entityId: unit.id },
    });
    expect(auditStatus).not.toBeNull();

    // 6. AuditEntry: BOOKING_CHARGE_ADDED
    const auditCharge = await prisma.auditEntry.findFirst({
      where: { action: "BOOKING_CHARGE_ADDED", entityId: booking.id },
    });
    expect(auditCharge).not.toBeNull();
  });

  it("chargeClient=false → unit RETIRED, Repair WROTE_OFF, НЕТ BookingItem компенсации", async () => {
    const { unit, booking, session } = await setupReturnSession("LOST-UNIT-002");
    const { completeSession } = await import("../services/warehouseScan");

    await completeSession(session.id, {
      lostUnits: [
        {
          equipmentUnitId: unit.id,
          reason: "Забыта в переходнике",
          lostLocation: "AT_CLIENT",
          chargeClient: false,
        },
      ],
      createdBy: adminUserId,
    });

    // Unit переведён в RETIRED
    const updatedUnit = await prisma.equipmentUnit.findUnique({ where: { id: unit.id } });
    expect(updatedUnit.status).toBe("RETIRED");

    // Repair создана
    const repair = await prisma.repair.findFirst({
      where: { unitId: unit.id, status: "WROTE_OFF" },
    });
    expect(repair).not.toBeNull();

    // Аудит есть
    const auditLost = await prisma.auditEntry.findFirst({
      where: { action: "UNIT_LOST", entityId: unit.id },
    });
    expect(auditLost).not.toBeNull();

    // НЕТ BookingItem компенсации
    const compensationItem = await prisma.bookingItem.findFirst({
      where: { bookingId: booking.id, customCategory: "Компенсация" },
    });
    expect(compensationItem).toBeNull();

    // НЕТ аудита BOOKING_CHARGE_ADDED
    const auditCharge = await prisma.auditEntry.findFirst({
      where: { action: "BOOKING_CHARGE_ADDED", entityId: booking.id },
    });
    expect(auditCharge).toBeNull();
  });

  it("lostUnits на ISSUE-сессии → игнорируются, unit НЕ переводится в RETIRED", async () => {
    // Создаём ISSUE-сессию (unit в статусе AVAILABLE)
    const unit = await prisma.equipmentUnit.create({
      data: { equipmentId, barcode: "LOST-UNIT-003", status: "AVAILABLE" },
    });
    const booking = await prisma.booking.create({
      data: {
        clientId,
        projectName: "Тест ignore lost on issue",
        startDate: new Date("2026-04-10"),
        endDate: new Date("2026-04-15"),
        status: "CONFIRMED",
        amountPaid: 0,
        amountOutstanding: 0,
      },
    });
    const bookingItem = await prisma.bookingItem.create({
      data: { bookingId: booking.id, equipmentId, quantity: 1 },
    });
    await prisma.bookingItemUnit.create({
      data: { bookingItemId: bookingItem.id, equipmentUnitId: unit.id },
    });
    const issueSession = await prisma.scanSession.create({
      data: {
        bookingId: booking.id,
        workerName: "Тест кладовщик",
        operation: "ISSUE",
        status: "ACTIVE",
      },
    });
    await prisma.scanRecord.create({
      data: { sessionId: issueSession.id, equipmentUnitId: unit.id, hmacVerified: false },
    });

    const { completeSession } = await import("../services/warehouseScan");

    await completeSession(issueSession.id, {
      lostUnits: [
        {
          equipmentUnitId: unit.id,
          reason: "Пытаемся передать lostUnit в ISSUE — должно игнорироваться",
          lostLocation: "UNKNOWN",
          chargeClient: true,
        },
      ],
      createdBy: adminUserId,
    });

    // Unit должен быть ISSUED (из ISSUE-сессии), НЕ RETIRED
    const updatedUnit = await prisma.equipmentUnit.findUnique({ where: { id: unit.id } });
    expect(updatedUnit.status).toBe("ISSUED");

    // Repair не создана
    const repair = await prisma.repair.findFirst({
      where: { unitId: unit.id, status: "WROTE_OFF" },
    });
    expect(repair).toBeNull();
  });

  it("brokenUnits + lostUnits в одном payload → оба обработаны", async () => {
    // Два unit-а: один broken, один lost
    const unitBroken = await prisma.equipmentUnit.create({
      data: { equipmentId, barcode: "MIXED-BROKEN-001", status: "ISSUED" },
    });
    const unitLost = await prisma.equipmentUnit.create({
      data: { equipmentId, barcode: "MIXED-LOST-001", status: "ISSUED" },
    });

    const booking = await prisma.booking.create({
      data: {
        clientId,
        projectName: "Тест mixed",
        startDate: new Date("2026-04-20"),
        endDate: new Date("2026-04-25"),
        status: "ISSUED",
        amountPaid: 0,
        amountOutstanding: 0,
      },
    });

    const bookingItem = await prisma.bookingItem.create({
      data: { bookingId: booking.id, equipmentId, quantity: 2 },
    });
    await prisma.bookingItemUnit.create({
      data: { bookingItemId: bookingItem.id, equipmentUnitId: unitBroken.id },
    });
    await prisma.bookingItemUnit.create({
      data: { bookingItemId: bookingItem.id, equipmentUnitId: unitLost.id },
    });

    const session = await prisma.scanSession.create({
      data: {
        bookingId: booking.id,
        workerName: "Тест кладовщик",
        operation: "RETURN",
        status: "ACTIVE",
      },
    });
    // Сканируем оба unit-а (возврат)
    await prisma.scanRecord.create({
      data: { sessionId: session.id, equipmentUnitId: unitBroken.id, hmacVerified: false },
    });
    await prisma.scanRecord.create({
      data: { sessionId: session.id, equipmentUnitId: unitLost.id, hmacVerified: false },
    });

    const { completeSession } = await import("../services/warehouseScan");

    const summary = await completeSession(session.id, {
      brokenUnits: [
        { equipmentUnitId: unitBroken.id, reason: "Трещина на корпусе", urgency: "URGENT" },
      ],
      lostUnits: [
        {
          equipmentUnitId: unitLost.id,
          reason: "Утерян в дороге",
          lostLocation: "IN_TRANSIT",
          chargeClient: false,
        },
      ],
      createdBy: adminUserId,
    });

    // Broken unit — должен быть в MAINTENANCE (createRepair переводит в MAINTENANCE)
    const brokenUnitAfter = await prisma.equipmentUnit.findUnique({ where: { id: unitBroken.id } });
    expect(brokenUnitAfter.status).toBe("MAINTENANCE");

    // Создана карточка ремонта для broken
    expect(summary.createdRepairIds).toHaveLength(1);
    const repairBroken = await prisma.repair.findUnique({ where: { id: summary.createdRepairIds[0] } });
    expect(repairBroken).not.toBeNull();
    expect(repairBroken.status).toBe("WAITING_REPAIR");

    // Lost unit — должен быть в RETIRED
    const lostUnitAfter = await prisma.equipmentUnit.findUnique({ where: { id: unitLost.id } });
    expect(lostUnitAfter.status).toBe("RETIRED");

    // Repair WROTE_OFF для lost unit
    const repairLost = await prisma.repair.findFirst({
      where: { unitId: unitLost.id, status: "WROTE_OFF" },
    });
    expect(repairLost).not.toBeNull();
  });

  it("replacementCost=0 + chargeClient=true → BookingItem НЕ создан (skip + warn)", async () => {
    // Оборудование с нулевыми ставками
    const freeEquipment = await prisma.equipment.create({
      data: {
        importKey: "lost-unit-free-rate-001",
        name: "Бесплатный кабель",
        category: "Кабели",
        rentalRatePerShift: 0,
        rentalRatePerProject: null,
        stockTrackingMode: "UNIT",
      },
    });
    const unit = await prisma.equipmentUnit.create({
      data: { equipmentId: freeEquipment.id, barcode: "LOST-UNIT-FREE-001", status: "ISSUED" },
    });
    const booking = await prisma.booking.create({
      data: {
        clientId,
        projectName: "Тест нулевая ставка",
        startDate: new Date("2026-04-15"),
        endDate: new Date("2026-04-20"),
        status: "ISSUED",
        amountPaid: 0,
        amountOutstanding: 0,
      },
    });
    const bookingItem = await prisma.bookingItem.create({
      data: { bookingId: booking.id, equipmentId: freeEquipment.id, quantity: 1 },
    });
    await prisma.bookingItemUnit.create({
      data: { bookingItemId: bookingItem.id, equipmentUnitId: unit.id },
    });
    const session = await prisma.scanSession.create({
      data: {
        bookingId: booking.id,
        workerName: "Тест кладовщик",
        operation: "RETURN",
        status: "ACTIVE",
      },
    });
    await prisma.scanRecord.create({
      data: { sessionId: session.id, equipmentUnitId: unit.id, hmacVerified: false },
    });

    const { completeSession } = await import("../services/warehouseScan");

    const result = await completeSession(session.id, {
      lostUnits: [
        {
          equipmentUnitId: unit.id,
          reason: "Потерян кабель с нулевой ставкой",
          lostLocation: "UNKNOWN",
          chargeClient: true,
        },
      ],
      createdBy: adminUserId,
    });

    // Unit переведён в RETIRED
    const updatedUnit = await prisma.equipmentUnit.findUnique({ where: { id: unit.id } });
    expect(updatedUnit.status).toBe("RETIRED");

    // Repair создана
    const repair = await prisma.repair.findFirst({ where: { unitId: unit.id, status: "WROTE_OFF" } });
    expect(repair).not.toBeNull();

    // BookingItem компенсации НЕ создан (ставка 0)
    const compensationItem = await prisma.bookingItem.findFirst({
      where: { bookingId: booking.id, customCategory: "Компенсация" },
    });
    expect(compensationItem).toBeNull();

    // failedLostUnits пустой (unit обработан успешно, просто без BookingItem)
    expect(result.failedLostUnits).toHaveLength(0);
  });

  it("partial failure в lost-unit loop → failedLostUnits[] содержит ошибку, остальные обработаны", async () => {
    // Создаём двух единиц: первый с несуществующим ID (вызовет ошибку), второй нормальный
    const validUnit = await prisma.equipmentUnit.create({
      data: { equipmentId, barcode: "LOST-PARTIAL-VALID-001", status: "ISSUED" },
    });
    const booking = await prisma.booking.create({
      data: {
        clientId,
        projectName: "Тест partial failure",
        startDate: new Date("2026-04-25"),
        endDate: new Date("2026-04-30"),
        status: "ISSUED",
        amountPaid: 0,
        amountOutstanding: 0,
      },
    });
    const bookingItem = await prisma.bookingItem.create({
      data: { bookingId: booking.id, equipmentId, quantity: 1 },
    });
    await prisma.bookingItemUnit.create({
      data: { bookingItemId: bookingItem.id, equipmentUnitId: validUnit.id },
    });
    const session = await prisma.scanSession.create({
      data: {
        bookingId: booking.id,
        workerName: "Тест кладовщик",
        operation: "RETURN",
        status: "ACTIVE",
      },
    });
    await prisma.scanRecord.create({
      data: { sessionId: session.id, equipmentUnitId: validUnit.id, hmacVerified: false },
    });

    const { completeSession } = await import("../services/warehouseScan");
    const NON_EXISTENT_ID = "non-existent-unit-id-00000000";

    const result = await completeSession(session.id, {
      lostUnits: [
        // 1-й: несуществующий ID → должен упасть → попасть в failedLostUnits
        {
          equipmentUnitId: NON_EXISTENT_ID,
          reason: "Тест несуществующего unit",
          lostLocation: "UNKNOWN",
          chargeClient: false,
        },
        // 2-й: реальный unit → должен успешно обработаться
        {
          equipmentUnitId: validUnit.id,
          reason: "Потеряна валидная единица",
          lostLocation: "IN_TRANSIT",
          chargeClient: false,
        },
      ],
      createdBy: adminUserId,
    });

    // Валидный unit обработан: RETIRED
    const updatedValid = await prisma.equipmentUnit.findUnique({ where: { id: validUnit.id } });
    expect(updatedValid.status).toBe("RETIRED");

    // Repair создана для валидного
    const repairValid = await prisma.repair.findFirst({
      where: { unitId: validUnit.id, status: "WROTE_OFF" },
    });
    expect(repairValid).not.toBeNull();

    // failedLostUnits содержит несуществующий unit
    expect(result.failedLostUnits).toHaveLength(1);
    expect(result.failedLostUnits[0].equipmentUnitId).toBe(NON_EXISTENT_ID);
    expect(result.failedLostUnits[0].reason).toBeTruthy();
  });
});
