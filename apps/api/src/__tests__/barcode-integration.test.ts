/**
 * Интеграционные тесты штрихкодов и складского сканирования.
 *
 * Тестирует полный цикл: выдача (ISSUE) и возврат (RETURN) через реальную БД.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-barcode.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1,test-key-2";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-for-integration";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-integration";

let app: Express;
let prisma: any;

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

  const mod = await import("../app");
  app = mod.app;
  const pmod = await import("../prisma");
  prisma = pmod.prisma;
});

afterAll(async () => {
  await prisma.$disconnect();
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = TEST_DB_PATH + suffix;
    if (fs.existsSync(f)) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* игнорируем */
      }
    }
  }
});

const AUTH = { "X-API-Key": "test-key-1" };

// ──────────────────────────────────────────────────────────────────
// Вспомогательные функции
// ──────────────────────────────────────────────────────────────────

async function createEquipment(
  name: string,
  category: string,
  totalQuantity: number,
  stockTrackingMode: "COUNT" | "UNIT",
) {
  const res = await request(app)
    .post("/api/equipment")
    .set(AUTH)
    .send({
      name,
      category,
      totalQuantity,
      stockTrackingMode,
      rentalRatePerShift: 500,
    });
  expect(res.status).toBe(200);
  return res.body.equipment;
}

async function generateUnits(equipmentId: string, count: number) {
  const res = await request(app)
    .post(`/api/equipment/${equipmentId}/units/generate`)
    .set(AUTH)
    .send({ count });
  expect(res.status).toBe(201);
  return res.body.units as Array<{ id: string; barcode: string; barcodePayload: string; status: string }>;
}

async function createClientDirect(name: string) {
  return prisma.client.create({ data: { name } });
}

async function createBookingDraft(clientName: string, equipmentId: string, quantity: number) {
  const res = await request(app)
    .post("/api/bookings/draft")
    .set(AUTH)
    .send({
      client: { name: clientName },
      projectName: "Тестовый проект",
      startDate: "2026-06-01",
      endDate: "2026-06-03",
      items: [{ equipmentId, quantity }],
    });
  expect(res.status).toBe(200);
  return res.body.booking;
}

async function confirmBooking(bookingId: string) {
  const res = await request(app)
    .post(`/api/bookings/${bookingId}/status`)
    .set(AUTH)
    .send({ action: "confirm" });
  expect(res.status).toBe(200);
  return res.body.booking;
}

async function issueBooking(bookingId: string) {
  const res = await request(app)
    .post(`/api/bookings/${bookingId}/status`)
    .set(AUTH)
    .send({ action: "issue" });
  expect(res.status).toBe(200);
  return res.body.booking;
}

// ──────────────────────────────────────────────────────────────────
// Импорт сервисов сканирования (не HTTP — Bearer auth не нужен в тестах)
// ──────────────────────────────────────────────────────────────────

async function getScanService() {
  return import("../services/warehouseScan");
}

// ──────────────────────────────────────────────────────────────────
// Полный цикл ISSUE
// ──────────────────────────────────────────────────────────────────

describe("Full ISSUE flow", () => {
  it("создаёт оборудование, генерирует юниты, создаёт бронь, подтверждает, проводит ISSUE-сессию, завершает — все юниты ISSUED", async () => {
    const {
      createSession,
      recordScan,
      completeSession,
      getReconciliationPreview,
    } = await getScanService();

    // 1. Создаём UNIT-оборудование
    const equipment = await createEquipment("Панель Nova P300", "Свет", 3, "UNIT");

    // 2. Генерируем 3 юнита — каждый получает barcode + barcodePayload
    const units = await generateUnits(equipment.id, 3);
    expect(units).toHaveLength(3);
    for (const u of units) {
      expect(u.barcode).toBeTruthy();
      expect(u.barcodePayload).toBeTruthy();
    }

    // 3. Создаём бронь
    const booking = await createBookingDraft("Клиент ISSUE", equipment.id, 3);

    // 4. Подтверждаем бронь → автоматически резервируются 3 AVAILABLE юнита как BookingItemUnit
    const confirmed = await confirmBooking(booking.id);
    expect(confirmed.status).toBe("CONFIRMED");

    // Проверяем что резервации созданы
    const reservations = await prisma.bookingItemUnit.findMany({
      where: { bookingItem: { bookingId: booking.id } },
    });
    expect(reservations).toHaveLength(3);

    // 5. Создаём ISSUE-сессию напрямую через сервис
    const session = await createSession(booking.id, "Иван", "ISSUE");
    expect(session.status).toBe("ACTIVE");

    // 6. Сканируем все 3 юнита по их barcodePayload
    for (const u of units) {
      const result = await recordScan(session.id, u.barcodePayload);
      expect("error" in result).toBe(false);
    }

    // 7. Предварительная сверка: ожидаем 3, отсканировано 3, missing 0
    const preview = await getReconciliationPreview(session.id);
    expect(preview.scanned).toBe(3);
    expect(preview.expected).toBe(3);
    expect(preview.missing).toHaveLength(0);

    // 8. Завершаем сессию
    const summary = await completeSession(session.id);
    expect(summary.scanned).toBe(3);
    expect(summary.missing).toHaveLength(0);

    // 9. Все 3 юнита теперь ISSUED
    const dbUnits = await prisma.equipmentUnit.findMany({
      where: { equipmentId: equipment.id },
    });
    for (const u of dbUnits) {
      expect(u.status).toBe("ISSUED");
    }

    // 10. BookingItemUnit записи существуют для всех 3 юнитов
    const biuRecords = await prisma.bookingItemUnit.findMany({
      where: { bookingItem: { bookingId: booking.id } },
    });
    expect(biuRecords).toHaveLength(3);
  });
});

// ──────────────────────────────────────────────────────────────────
// Полный цикл RETURN
// ──────────────────────────────────────────────────────────────────

describe("Full RETURN flow", () => {
  it("возвращает 2 из 3 выданных юнитов, 1 остаётся ISSUED и помечается как missing", async () => {
    const {
      createSession,
      recordScan,
      completeSession,
    } = await getScanService();

    // Подготовка: полный ISSUE-цикл
    const equipment = await createEquipment("Фрезнель 2kW", "Свет", 3, "UNIT");
    const units = await generateUnits(equipment.id, 3);
    const booking = await createBookingDraft("Клиент RETURN", equipment.id, 3);
    await confirmBooking(booking.id);

    const issueSession = await createSession(booking.id, "Петр", "ISSUE");
    for (const u of units) {
      await recordScan(issueSession.id, u.barcodePayload);
    }
    await completeSession(issueSession.id);

    // Переводим бронь в статус ISSUED чтобы можно было создать RETURN-сессию
    await issueBooking(booking.id);

    // 1. Создаём RETURN-сессию
    const returnSession = await createSession(booking.id, "Мария", "RETURN");
    expect(returnSession.status).toBe("ACTIVE");

    // 2. Сканируем только 2 из 3 юнитов
    await recordScan(returnSession.id, units[0].barcodePayload);
    await recordScan(returnSession.id, units[1].barcodePayload);

    // 3. Завершаем сессию
    const summary = await completeSession(returnSession.id);
    expect(summary.scanned).toBe(2);
    expect(summary.missing).toHaveLength(1);

    // 4. Проверяем статусы юнитов: 2 стали AVAILABLE, 1 остался ISSUED
    const dbUnits = await prisma.equipmentUnit.findMany({
      where: { equipmentId: equipment.id },
      orderBy: { createdAt: "asc" },
    });
    const availableCount = dbUnits.filter((u: any) => u.status === "AVAILABLE").length;
    const issuedCount = dbUnits.filter((u: any) => u.status === "ISSUED").length;
    expect(availableCount).toBe(2);
    expect(issuedCount).toBe(1);

    // 5. returnedAt задан для 2 возвращённых юнитов
    const returnedBiu = await prisma.bookingItemUnit.findMany({
      where: {
        bookingItem: { bookingId: booking.id },
        returnedAt: { not: null },
      },
    });
    expect(returnedBiu).toHaveLength(2);
  });
});

// ──────────────────────────────────────────────────────────────────
// Граничные случаи
// ──────────────────────────────────────────────────────────────────

describe("Edge cases", () => {
  it("при подтверждении резервируются только AVAILABLE юниты (MAINTENANCE/RETIRED исключаются)", async () => {
    const equipment = await createEquipment("Прожектор Arri M18", "Свет", 4, "UNIT");
    const units = await generateUnits(equipment.id, 4);

    // Переводим unit[0] в MAINTENANCE и unit[1] в RETIRED напрямую через Prisma
    await prisma.equipmentUnit.update({
      where: { id: units[0].id },
      data: { status: "MAINTENANCE" },
    });
    await prisma.equipmentUnit.update({
      where: { id: units[1].id },
      data: { status: "RETIRED" },
    });

    // Создаём бронь на 2 штуки (только 2 AVAILABLE)
    const booking = await createBookingDraft("Клиент MAINTENANCE", equipment.id, 2);
    const confirmed = await confirmBooking(booking.id);
    expect(confirmed.status).toBe("CONFIRMED");

    // Проверяем что зарезервированы только AVAILABLE юниты
    const reservations = await prisma.bookingItemUnit.findMany({
      where: { bookingItem: { bookingId: booking.id } },
      include: { equipmentUnit: true },
    });
    expect(reservations).toHaveLength(2);
    for (const r of reservations) {
      expect(r.equipmentUnit.status).toBe("AVAILABLE");
      expect(r.equipmentUnit.id).not.toBe(units[0].id); // не MAINTENANCE юнит
      expect(r.equipmentUnit.id).not.toBe(units[1].id); // не RETIRED юнит
    }
  });

  it("частичная выдача: сканируем 2 из 3 → незарезервированная BookingItemUnit удаляется", async () => {
    const { createSession, recordScan, completeSession } = await getScanService();

    const equipment = await createEquipment("Chimera 4x6", "Свет", 3, "UNIT");
    const units = await generateUnits(equipment.id, 3);
    const booking = await createBookingDraft("Клиент PARTIAL", equipment.id, 3);
    await confirmBooking(booking.id);

    // Перед ISSUE: 3 резервации
    const beforeBiu = await prisma.bookingItemUnit.findMany({
      where: { bookingItem: { bookingId: booking.id } },
    });
    expect(beforeBiu).toHaveLength(3);

    const session = await createSession(booking.id, "Алексей", "ISSUE");
    // Сканируем только 2 юнита
    await recordScan(session.id, units[0].barcodePayload);
    await recordScan(session.id, units[1].barcodePayload);
    const summary = await completeSession(session.id);

    // Summary: 1 missing (не отсканированный зарезервированный юнит)
    expect(summary.scanned).toBe(2);
    expect(summary.missing).toHaveLength(1);

    // После ISSUE: только 2 BookingItemUnit остались (незарезервированные удалены)
    const afterBiu = await prisma.bookingItemUnit.findMany({
      where: { bookingItem: { bookingId: booking.id } },
    });
    expect(afterBiu).toHaveLength(2);
  });

  it("замена юнита: сканируем юнит не из резервации → BookingItemUnit подменяется", async () => {
    const { createSession, recordScan, completeSession } = await getScanService();

    const equipment = await createEquipment("Nova SL150R", "Свет", 2, "UNIT");
    const units = await generateUnits(equipment.id, 2);
    const booking = await createBookingDraft("Клиент SUBST", equipment.id, 1);
    await confirmBooking(booking.id);

    // Смотрим какой юнит зарезервирован
    const reserved = await prisma.bookingItemUnit.findFirst({
      where: { bookingItem: { bookingId: booking.id } },
    });
    expect(reserved).toBeTruthy();

    // Находим юнит, который НЕ зарезервирован
    const nonReservedUnit = units.find((u) => u.id !== reserved.equipmentUnitId);
    expect(nonReservedUnit).toBeTruthy();

    const session = await createSession(booking.id, "Дмитрий", "ISSUE");
    // Сканируем незарезервированный юнит (замена)
    const result = await recordScan(session.id, nonReservedUnit!.barcodePayload);
    expect("error" in result).toBe(false);

    const summary = await completeSession(session.id);
    // substituted содержит id замены
    expect(summary.substituted).toHaveLength(1);
    expect(summary.substituted[0]).toBe(nonReservedUnit!.id);

    // BookingItemUnit теперь указывает на подменённый юнит
    const biu = await prisma.bookingItemUnit.findFirst({
      where: { bookingItem: { bookingId: booking.id } },
    });
    expect(biu?.equipmentUnitId).toBe(nonReservedUnit!.id);
  });

  it("отмена и повторное создание сессии работает корректно", async () => {
    const { createSession, cancelSession } = await getScanService();

    const equipment = await createEquipment("Lomo Anamorphic 35mm", "Оптика", 1, "UNIT");
    await generateUnits(equipment.id, 1);
    const booking = await createBookingDraft("Клиент CANCEL", equipment.id, 1);
    await confirmBooking(booking.id);

    // Создаём сессию и отменяем
    const session1 = await createSession(booking.id, "Олег", "ISSUE");
    await cancelSession(session1.id);

    const cancelled = await prisma.scanSession.findUnique({ where: { id: session1.id } });
    expect(cancelled?.status).toBe("CANCELLED");

    // Можно создать новую сессию после отмены
    const session2 = await createSession(booking.id, "Олег", "ISSUE");
    expect(session2.status).toBe("ACTIVE");

    // Отменяем и вторую сессию чтобы не мешала другим тестам
    await cancelSession(session2.id);
  });

  it("нельзя создать 2 активных сессии для одной брони и операции", async () => {
    const { createSession, cancelSession } = await getScanService();

    const equipment = await createEquipment("DJI Mavic 3", "Дроны", 1, "UNIT");
    await generateUnits(equipment.id, 1);
    const booking = await createBookingDraft("Клиент CONCURRENT", equipment.id, 1);
    await confirmBooking(booking.id);

    // Создаём первую сессию
    const session1 = await createSession(booking.id, "Алена", "ISSUE");
    expect(session1.status).toBe("ACTIVE");

    // Попытка создать вторую — должна упасть с ошибкой
    await expect(createSession(booking.id, "Борис", "ISSUE")).rejects.toThrow(
      "Уже существует активная сессия",
    );

    // Убираем за собой
    await cancelSession(session1.id);
  });

  it("COUNT-позиции в смешанной брони не требуют scan-записей", async () => {
    const { createSession, completeSession, getReconciliationPreview } = await getScanService();

    // Создаём UNIT-оборудование
    const unitEq = await createEquipment("Aputure 600D", "Свет", 1, "UNIT");
    await generateUnits(unitEq.id, 1);

    // Создаём COUNT-оборудование
    const countEq = await createEquipment("Диффузор 120x120", "Аксессуары", 5, "COUNT");

    // Бронь с обоими типами
    const res = await request(app)
      .post("/api/bookings/draft")
      .set(AUTH)
      .send({
        client: { name: "Клиент MIXED" },
        projectName: "Смешанный проект",
        startDate: "2026-07-01",
        endDate: "2026-07-03",
        items: [
          { equipmentId: unitEq.id, quantity: 1 },
          { equipmentId: countEq.id, quantity: 3 },
        ],
      });
    expect(res.status).toBe(200);
    const booking = res.body.booking;
    await confirmBooking(booking.id);

    // Создаём ISSUE-сессию и завершаем без единого скана
    const session = await createSession(booking.id, "Светлана", "ISSUE");

    // Предварительная сверка: expected = 1 (только UNIT-позиция)
    const preview = await getReconciliationPreview(session.id);
    expect(preview.expected).toBe(1);
    expect(preview.scanned).toBe(0);

    // Завершаем (частичная выдача, missing = 1 UNIT-юнит)
    const summary = await completeSession(session.id);
    // COUNT-позиции не влияют на expected
    expect(summary.expected).toBe(1);
  });

  it("PIN-код: блокировка после 5 неудачных попыток", async () => {
    const { hashPin, authenticateWorker } = await import("../services/warehouseAuth");

    const pin = "9876";
    const pinHash = await hashPin(pin);

    // Создаём складского работника с известным PIN
    const worker = await prisma.warehousePin.create({
      data: {
        name: "Тест Блокировка",
        pinHash,
        isActive: true,
        failedAttempts: 0,
      },
    });

    // 5 неудачных попыток с неверным PIN
    for (let i = 0; i < 5; i++) {
      const result = await authenticateWorker("Тест Блокировка", "wrongpin");
      expect("error" in result).toBe(true);
    }

    // 6-я попытка с правильным PIN — должна быть заблокирована
    const lockedResult = await authenticateWorker("Тест Блокировка", pin);
    expect("error" in lockedResult).toBe(true);
    expect((lockedResult as { error: string }).error).toContain("заблокирован");

    // Убираем за собой
    await prisma.warehousePin.delete({ where: { id: worker.id } });
  });
});
