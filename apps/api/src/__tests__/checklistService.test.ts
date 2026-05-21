/**
 * Интеграционный тест: сервис чек-листа склада
 * Тестирует checkUnit (идемпотентность), uncheckUnit, addExtraItem, getChecklistState
 */

import path from "path";
import { execSync } from "child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-checklist.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-checklist";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-checklist";
process.env.WAREHOUSE_SECRET = "test-warehouse-checklist";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-checklist-min16chars";

let prisma: any;
let checklistService: typeof import("../services/checklistService");

let clientId: string;
let equipmentId: string;
let unitId: string;
let unit2Id: string;
let countEquipmentId: string;
let bookingId: string;
let sessionId: string;
let countBookingItemId: string;
let unitBookingItemId: string;

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
  checklistService = await import("../services/checklistService");

  const { hashPassword } = await import("../services/auth");
  const hash = await hashPassword("checklist-pass");

  await prisma.adminUser.create({
    data: { username: "checklist_super", passwordHash: hash, role: "SUPER_ADMIN" },
  });

  const client = await prisma.client.create({
    data: { name: "Тест клиент checklist", phone: "+70000000002" },
  });
  clientId = client.id;

  // UNIT оборудование
  const equipment = await prisma.equipment.create({
    data: {
      importKey: "checklist-unit-001",
      name: "Fresnel 650W",
      category: "Fresnel",
      rentalRatePerShift: 1000,
      stockTrackingMode: "UNIT",
      // totalQuantity=5 — нужен для hard-cap проверки (см. addExtraItem ADDON_OVER_STOCK).
      totalQuantity: 5,
    },
  });
  equipmentId = equipment.id;

  const unit = await prisma.equipmentUnit.create({
    data: { equipmentId, barcode: "FRESNEL-001", status: "AVAILABLE" },
  });
  unitId = unit.id;

  const unit2 = await prisma.equipmentUnit.create({
    data: { equipmentId, barcode: "FRESNEL-002", status: "AVAILABLE" },
  });
  unit2Id = unit2.id;

  // COUNT оборудование
  const countEquipment = await prisma.equipment.create({
    data: {
      importKey: "checklist-count-001",
      name: "Sandbag 7kg",
      category: "Аксессуары",
      rentalRatePerShift: 150,
      stockTrackingMode: "COUNT",
      // totalQuantity=100 — нужен для hard-cap; в этом блоке тестируется суммирование
      // существующей позиции (quantity 5 -> 8), не строгий cap.
      totalQuantity: 100,
    },
  });
  countEquipmentId = countEquipment.id;

  // Создаём бронь
  const booking = await prisma.booking.create({
    data: {
      clientId,
      projectName: "Тест чек-лист",
      startDate: new Date("2026-05-01"),
      endDate: new Date("2026-05-03"),
      status: "CONFIRMED",
      amountPaid: 0,
      amountOutstanding: 0,
    },
  });
  bookingId = booking.id;

  // UNIT BookingItem
  const unitBi = await prisma.bookingItem.create({
    data: { bookingId, equipmentId, quantity: 2 },
  });
  unitBookingItemId = unitBi.id;

  // Резервируем юниты
  await prisma.bookingItemUnit.createMany({
    data: [
      { bookingItemId: unitBi.id, equipmentUnitId: unitId },
      { bookingItemId: unitBi.id, equipmentUnitId: unit2Id },
    ],
  });

  // COUNT BookingItem
  const countBi = await prisma.bookingItem.create({
    data: { bookingId, equipmentId: countEquipmentId, quantity: 5 },
  });
  countBookingItemId = countBi.id;

  // Создаём сессию выдачи
  const session = await prisma.scanSession.create({
    data: {
      bookingId,
      workerName: "Тест склад checklist",
      operation: "ISSUE",
      status: "ACTIVE",
    },
  });
  sessionId = session.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("checkUnit", () => {
  it("отмечает UNIT-позицию (создаёт ScanRecord)", async () => {
    const result = await checklistService.checkUnit(sessionId, unitId);
    expect(result.alreadyChecked).toBe(false);

    const record = await prisma.scanRecord.findFirst({
      where: { sessionId, equipmentUnitId: unitId },
    });
    expect(record).not.toBeNull();
    expect(record.hmacVerified).toBe(false);
  });

  it("идемпотентен: повторный checkUnit не бросает, возвращает alreadyChecked=true", async () => {
    const result = await checklistService.checkUnit(sessionId, unitId);
    expect(result.alreadyChecked).toBe(true);
  });
});

describe("uncheckUnit", () => {
  it("снимает отметку (удаляет ScanRecord)", async () => {
    // Сначала убедимся, что запись есть (от предыдущего теста)
    const before = await prisma.scanRecord.findFirst({
      where: { sessionId, equipmentUnitId: unitId },
    });
    expect(before).not.toBeNull();

    const result = await checklistService.uncheckUnit(sessionId, unitId);
    expect(result.wasChecked).toBe(true);

    const after = await prisma.scanRecord.findFirst({
      where: { sessionId, equipmentUnitId: unitId },
    });
    expect(after).toBeNull();
  });

  it("идемпотентен: uncheck несуществующей записи возвращает wasChecked=false", async () => {
    const result = await checklistService.uncheckUnit(sessionId, unitId);
    expect(result.wasChecked).toBe(false);
  });
});

describe("getChecklistState", () => {
  it("возвращает состояние с UNIT и COUNT позициями", async () => {
    // Проставим один юнит
    await checklistService.checkUnit(sessionId, unitId);

    const state = await checklistService.getChecklistState(sessionId);

    expect(state.sessionId).toBe(sessionId);
    expect(state.bookingId).toBe(bookingId);
    expect(state.operation).toBe("ISSUE");

    const unitItem = state.items.find((i) => i.trackingMode === "UNIT");
    expect(unitItem).toBeDefined();
    expect(unitItem?.units?.length).toBe(2);
    expect(unitItem?.units?.find((u) => u.unitId === unitId)?.checked).toBe(true);
    expect(unitItem?.units?.find((u) => u.unitId === unit2Id)?.checked).toBe(false);
    expect(unitItem?.checkedQty).toBe(1);

    const countItem = state.items.find((i) => i.trackingMode === "COUNT");
    expect(countItem).toBeDefined();
    expect(countItem?.quantity).toBe(5);
  });

  it("progress считает только UNIT-чекбоксы", async () => {
    const state = await checklistService.getChecklistState(sessionId);
    // 2 UNIT юнита, 1 отмечен (COUNT позиции не входят в totalItems т.к. не отслеживаются на сервере)
    expect(state.progress.checkedItems).toBe(1);
    // totalItems включает только UNIT-юниты (2 штуки в данном примере)
    const unitItem = state.items.find((i) => i.trackingMode === "UNIT");
    expect(unitItem?.units?.length).toBe(2);
  });
});

describe("addExtraItem", () => {
  it("создаёт новую позицию в броне", async () => {
    const extraEquipment = await prisma.equipment.create({
      data: {
        importKey: "checklist-extra-001",
        name: "D-Tap кабель",
        category: "Аксессуары",
        rentalRatePerShift: 200,
        stockTrackingMode: "COUNT",
        // totalQuantity=10 — нужен для hard-cap; этот тест добавляет qty=2.
        totalQuantity: 10,
      },
    });

    const result = await checklistService.addExtraItem(
      sessionId,
      extraEquipment.id,
      2,
      "Тест склад checklist",
    );

    expect(result.bookingItemId).toBeTruthy();

    const item = await prisma.bookingItem.findUnique({
      where: { id: result.bookingItemId },
    });
    expect(item).not.toBeNull();
    expect(item.equipmentId).toBe(extraEquipment.id);
    expect(item.quantity).toBe(2);
    expect(item.bookingId).toBe(bookingId);
  });

  it("увеличивает quantity если позиция уже существует", async () => {
    // Используем existingEquipmentId (countEquipmentId уже в броне с qty=5)
    const result = await checklistService.addExtraItem(
      sessionId,
      countEquipmentId,
      3,
      "Тест склад checklist",
    );

    const item = await prisma.bookingItem.findUnique({
      where: { id: result.bookingItemId },
    });
    expect(item.quantity).toBe(8); // 5 + 3
  });

  it("бросает ошибку для несуществующего оборудования", async () => {
    await expect(
      checklistService.addExtraItem(sessionId, "non-existent-id", 1, "test"),
    ).rejects.toThrow("Оборудование не найдено");
  });

  it("addExtraItem creates an AddonRecord with delta quantity + triggers ADDON Estimate recompute", async () => {
    // Сценарий: бронь CONFIRMED с MAIN Estimate, в ISSUE сессии добавляем +3 Vmount.
    // Ожидаем: AddonRecord(quantity=3, sessionId, bookingItemId) + ADDON Estimate.
    const { addExtraItem } = await import("../services/checklistService");

    // Seed MAIN Estimate (без него recomputeAddonEstimate — no-op):
    // в этом тестовом файле бронь создаётся напрямую, минуя approveBooking,
    // поэтому посеять Estimate приходится вручную.
    const existingMain = await prisma.estimate.findFirst({
      where: { bookingId, kind: "MAIN" },
    });
    if (!existingMain) {
      await prisma.estimate.create({
        data: {
          bookingId,
          kind: "MAIN",
          shifts: 1,
          subtotal: "0",
          discountAmount: "0",
          totalAfterDiscount: "0",
        },
      });
    }

    const initialRecords = await prisma.addonRecord.count({
      where: { bookingId },
    });

    await addExtraItem(sessionId, equipmentId, 3, "test-operator");

    const finalRecords = await prisma.addonRecord.findMany({
      where: { bookingId },
      orderBy: { createdAt: "desc" },
    });
    expect(finalRecords.length).toBe(initialRecords + 1);
    expect(finalRecords[0].quantity).toBe(3);
    expect(finalRecords[0].sessionId).toBe(sessionId);
    expect(finalRecords[0].equipmentId).toBe(equipmentId);
    expect(finalRecords[0].createdBy).toBe("test-operator");

    // ADDON Estimate должен существовать с totalQty >= 3
    const addon = await prisma.estimate.findFirst({
      where: { bookingId, kind: "ADDON" },
      include: { lines: true },
    });
    expect(addon).toBeTruthy();
    const line = addon!.lines.find((l: any) => l.equipmentId === equipmentId);
    expect(line).toBeTruthy();
    expect(line!.quantity).toBeGreaterThanOrEqual(3);
  });

  // ── Hard cap (ADDON_OVER_STOCK) ────────────────────────────────────────────────
  // Формула: addCap = equipment.totalQuantity − occupiedByOthers − alreadyInThisBooking.
  // В этих тестах equipmentId.totalQuantity=5 и нет других пересекающихся броней,
  // поэтому occupiedByOthers=0; alreadyInBooking задаётся через upsert перед вызовом.

  it("rejects with 409 ADDON_OVER_STOCK when quantity exceeds addCap", async () => {
    const { addExtraItem } = await import("../services/checklistService");
    // Pre-fill this booking with quantity=4 → addCap = 5 − 0 − 4 = 1.
    await prisma.bookingItem.upsert({
      where: { bookingId_equipmentId: { bookingId, equipmentId } },
      update: { quantity: 4 },
      create: { bookingId, equipmentId, quantity: 4 },
    });
    // Requesting 2 must fail (cap=1).
    await expect(addExtraItem(sessionId, equipmentId, 2, "ivan")).rejects.toMatchObject({
      status: 409,
      code: "ADDON_OVER_STOCK",
      details: { addCap: 1, requested: 2, alreadyInBooking: 4 },
    });
  });

  it("allows quantity exactly equal to addCap", async () => {
    const { addExtraItem } = await import("../services/checklistService");
    await prisma.bookingItem.upsert({
      where: { bookingId_equipmentId: { bookingId, equipmentId } },
      update: { quantity: 4 },
      create: { bookingId, equipmentId, quantity: 4 },
    });
    // addCap = 5 − 0 − 4 = 1; запрос ровно на 1 → ОК.
    const result = await addExtraItem(sessionId, equipmentId, 1, "ivan");
    expect(result.bookingItemId).toBeDefined();
    const bi = await prisma.bookingItem.findUnique({
      where: { bookingId_equipmentId: { bookingId, equipmentId } },
    });
    expect(bi!.quantity).toBe(5);
  });

  it("second consecutive add fails when addCap exhausted", async () => {
    const { addExtraItem } = await import("../services/checklistService");
    await prisma.bookingItem.upsert({
      where: { bookingId_equipmentId: { bookingId, equipmentId } },
      update: { quantity: 3 },
      create: { bookingId, equipmentId, quantity: 3 },
    });
    // addCap = 5 − 0 − 3 = 2; первый запрос на 2 проходит, второй на 1 падает.
    await addExtraItem(sessionId, equipmentId, 2, "ivan");
    await expect(addExtraItem(sessionId, equipmentId, 1, "ivan")).rejects.toMatchObject({
      status: 409,
      code: "ADDON_OVER_STOCK",
    });
  });
});
