/**
 * F-REPAIR-1 «Сломанное не продаётся».
 *
 * До этой правки слова `Repair` не было ни в availability.ts, ни в добор-проверке
 * склада, ни в чек-листе выдачи: витрина, календарь и склад продолжали предлагать
 * то, что физически лежит в мастерской. Тесты фиксируют три вещи:
 *  - активный безъюнитный ремонт уменьшает наличие, закрытый — нет;
 *  - штучная единица в MAINTENANCE вычитается РОВНО ОДИН раз (главный риск: она
 *    уже исключена из usableUnitBase, и наивный вычет ремонтов вычел бы её дважды);
 *  - витрина, добор на складе и чек-лист выдачи дают одно и то же число.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-repair-availability.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-repair-avail";

const WINDOW_START = new Date("2026-09-01T00:00:00.000Z");
const WINDOW_END = new Date("2026-09-03T00:00:00.000Z");

beforeAll(() => {
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../.."),
    env: {
      ...process.env,
      DATABASE_URL: `file:${TEST_DB_PATH}`,
      PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes",
    },
    stdio: "pipe",
  });
});

afterAll(async () => {
  const { prisma } = await import("../prisma");
  await prisma.$disconnect();
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = TEST_DB_PATH + suffix;
    if (fs.existsSync(f)) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }
});

async function createCountEquipment(key: string, name: string, totalQuantity: number) {
  const { prisma } = await import("../prisma");
  return prisma.equipment.create({
    data: {
      category: "Тест-категория",
      name,
      importKey: key,
      rentalRatePerShift: "500",
      stockTrackingMode: "COUNT",
      totalQuantity,
    },
  });
}

/** Наличие позиции в тестовом окне (то, что видит витрина /api/availability). */
async function availableIn(equipmentId: string): Promise<number> {
  const { getAvailability } = await import("../services/availability");
  const rows = await getAvailability({
    startDate: WINDOW_START,
    endDate: WINDOW_END,
    equipmentIds: [equipmentId],
  });
  return rows.find((r) => r.equipment.id === equipmentId)?.availableQuantity ?? -1;
}

describe("getRepairCountByEquipmentMap", () => {
  it("считает активные безъюнитные ремонты по Repair.equipmentId и по bookingItem", async () => {
    const { prisma } = await import("../prisma");
    const { getRepairCountByEquipmentMap } = await import("../services/availability");

    const eq = await createCountEquipment("frepair-map-eq", "Стойка Manfrotto", 10);

    // Заявка из киоска: equipmentId проставлен напрямую.
    await prisma.repair.create({
      data: { equipmentId: eq.id, quantity: 2, reason: "погнута", createdBy: "tester" },
    });

    // Поломка с приёмки: equipmentId пуст, позиция известна через BookingItem.
    const client = await prisma.client.create({ data: { name: "Клиент F-REPAIR map" } });
    const booking = await prisma.booking.create({
      data: {
        clientId: client.id,
        projectName: "Проект F-REPAIR map",
        status: "RETURNED",
        startDate: new Date("2026-01-01T00:00:00.000Z"),
        endDate: new Date("2026-01-02T00:00:00.000Z"),
      },
    });
    const bookingItem = await prisma.bookingItem.create({
      data: { bookingId: booking.id, equipmentId: eq.id, quantity: 3 },
    });
    await prisma.repair.create({
      data: { bookingItemId: bookingItem.id, quantity: 1, reason: "треснул замок", createdBy: "tester" },
    });

    const map = await getRepairCountByEquipmentMap([eq.id]);
    expect(map.get(eq.id)).toBe(3);
  });

  it("возвращает пустую карту на пустом списке позиций", async () => {
    const { getRepairCountByEquipmentMap } = await import("../services/availability");
    const map = await getRepairCountByEquipmentMap([]);
    expect(map.size).toBe(0);
  });
});

describe("getAvailability — активный ремонт уменьшает наличие", () => {
  it("позиция без штучного учёта: 25 в парке, 3 в ремонте → доступно 22", async () => {
    const { prisma } = await import("../prisma");
    const eq = await createCountEquipment("frepair-count-25", "Кабель 25 м", 25);

    await prisma.repair.create({
      data: {
        equipmentId: eq.id,
        quantity: 3,
        reason: "перебит кабель",
        status: "IN_REPAIR",
        createdBy: "tester",
      },
    });

    expect(await availableIn(eq.id)).toBe(22);
  });

  it("закрытый и списанный ремонт наличие НЕ уменьшают", async () => {
    const { prisma } = await import("../prisma");
    const eq = await createCountEquipment("frepair-closed", "Зарядка V-mount", 8);

    await prisma.repair.create({
      data: {
        equipmentId: eq.id, quantity: 2, reason: "починено",
        status: "CLOSED", closedAt: new Date(), createdBy: "tester",
      },
    });
    await prisma.repair.create({
      data: {
        equipmentId: eq.id, quantity: 1, reason: "списано",
        status: "WROTE_OFF", closedAt: new Date(), createdBy: "tester",
      },
    });
    // Контроль: один активный ремонт всё же вычитается.
    await prisma.repair.create({
      data: { equipmentId: eq.id, quantity: 1, reason: "ждёт запчасть", status: "WAITING_PARTS", createdBy: "tester" },
    });

    expect(await availableIn(eq.id)).toBe(7);
  });

  it("потеряшки и ремонты вычитаются совместно, не затирая друг друга", async () => {
    const { prisma } = await import("../prisma");
    const eq = await createCountEquipment("frepair-lost-mix", "Стойка-журавль", 20);

    const client = await prisma.client.create({ data: { name: "Клиент F-REPAIR mix" } });
    const booking = await prisma.booking.create({
      data: {
        clientId: client.id,
        projectName: "Проект F-REPAIR mix",
        status: "RETURNED",
        // Бронь вне тестового окна — occupied по ней должен быть 0.
        startDate: new Date("2026-01-10T00:00:00.000Z"),
        endDate: new Date("2026-01-11T00:00:00.000Z"),
      },
    });
    const bookingItem = await prisma.bookingItem.create({
      data: { bookingId: booking.id, equipmentId: eq.id, quantity: 20 },
    });

    // 5 потеряно
    await prisma.problemItem.create({
      data: {
        bookingItemId: bookingItem.id, quantity: 5, sourceBookingId: booking.id,
        reason: "LOST", comment: "не вернулись с площадки", status: "SEARCHING", createdBy: "tester",
      },
    });
    // 4 в ремонте
    await prisma.repair.create({
      data: { equipmentId: eq.id, quantity: 4, reason: "сорвана резьба", createdBy: "tester" },
    });

    // 20 − 5 потеряно − 4 в ремонте = 11
    expect(await availableIn(eq.id)).toBe(11);
  });
});

describe("getAvailability — штучный учёт не вычитается дважды", () => {
  it("единица в MAINTENANCE с активной картой ремонта уменьшает наличие ровно на 1", async () => {
    const { prisma } = await import("../prisma");

    const eq = await prisma.equipment.create({
      data: {
        category: "Тест-категория",
        name: "Прибор штучный",
        importKey: "frepair-unit-double",
        rentalRatePerShift: "1000",
        stockTrackingMode: "UNIT",
        totalQuantity: 5,
      },
    });

    const units = [];
    for (let i = 0; i < 5; i++) {
      units.push(
        await prisma.equipmentUnit.create({
          data: {
            equipmentId: eq.id,
            barcode: `FREPAIR-U-${i}`,
            status: i === 0 ? "MAINTENANCE" : "AVAILABLE",
          },
        }),
      );
    }

    // Штучный ремонт: единица уже выведена из оборота статусом MAINTENANCE.
    // Если бы карта ремонтов учитывала строки с unitId, тот же прибор вычелся бы
    // и через usableUnitBase, и через ремонт → получили бы 3 вместо 4.
    await prisma.repair.create({
      data: {
        unitId: units[0].id,
        quantity: 1,
        reason: "не включается",
        status: "IN_REPAIR",
        createdBy: "tester",
      },
    });

    expect(await availableIn(eq.id)).toBe(4);

    // А безъюнитный ремонт на той же UNIT-позиции вычитается: физически прибор
    // в мастерской, но ни одна единица в MAINTENANCE не ушла.
    await prisma.repair.create({
      data: { equipmentId: eq.id, quantity: 1, reason: "потерян блок питания", createdBy: "tester" },
    });
    expect(await availableIn(eq.id)).toBe(3);
  });
});

describe("Витрина, добор на складе и чек-лист выдачи считают одинаково", () => {
  it("ремонт съедает подмену: все три экрана показывают 0 свободных", async () => {
    const { prisma } = await import("../prisma");
    const { findAddonConflict } = await import("../services/addonAvailability");
    const { getChecklistState, addExtraItem } = await import("../services/checklistService");

    // 3 в парке, 2 в ремонте → физически доступна 1 штука.
    const eq = await createCountEquipment("frepair-three-screens", "Ветродуй", 3);
    await prisma.repair.create({
      data: { equipmentId: eq.id, quantity: 2, reason: "сгорел мотор", createdBy: "tester" },
    });

    const client = await prisma.client.create({ data: { name: "Клиент F-REPAIR screens" } });

    // Чужая бронь на те же даты держит последнюю свободную штуку.
    const other = await prisma.booking.create({
      data: {
        clientId: client.id,
        projectName: "Чужой проект",
        status: "CONFIRMED",
        startDate: WINDOW_START,
        endDate: WINDOW_END,
      },
    });
    await prisma.bookingItem.create({
      data: { bookingId: other.id, equipmentId: eq.id, quantity: 1 },
    });

    // Текущая бронь: одна штука уже в смете (выдаётся сегодня).
    const mine = await prisma.booking.create({
      data: {
        clientId: client.id,
        projectName: "Наш проект",
        status: "ISSUED",
        startDate: WINDOW_START,
        endDate: WINDOW_END,
      },
    });
    await prisma.bookingItem.create({
      data: { bookingId: mine.id, equipmentId: eq.id, quantity: 1 },
    });
    const session = await prisma.scanSession.create({
      data: {
        bookingId: mine.id,
        workerName: "Тестовый кладовщик",
        operation: "ISSUE",
        status: "ACTIVE",
      },
    });

    // 1) Витрина: база 1 (3 − 2 в ремонте), занято 2 (обе брони) → 0.
    expect(await availableIn(eq.id)).toBe(0);

    // 2) Чек-лист выдачи: добрать нечего.
    const state = await getChecklistState(session.id);
    const line = state.items.find((i) => i.equipmentId === eq.id);
    expect(line?.addCap).toBe(0);

    // 3) Добор на складе: чужая бронь держит единственную рабочую штуку.
    //    До правки ёмкость считалась по сырому totalQuantity=3 и конфликта не было.
    const conflict = await findAddonConflict(eq.id, WINDOW_START, WINDOW_END, mine.id);
    expect(conflict).not.toBeNull();
    expect(conflict?.projectName).toBe("Чужой проект");

    // Даже «под ответственность» добрать нельзя: чужую бронь подвинуть можно,
    // мастерскую — нет.
    await expect(
      addExtraItem(session.id, eq.id, 1, "Тестовый кладовщик", true),
    ).rejects.toMatchObject({ status: 409, code: "ADDON_OVER_STOCK" });
  });
});
