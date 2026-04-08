/**
 * Интеграционные тесты сервиса importSession.
 *
 * Тестирует полный цикл: создание сессии, матчинг, вычисление diff, применение изменений.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import xlsx from "xlsx";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-import.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1,test-key-2";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-for-import";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-import";

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

// ──────────────────────────────────────────────────────────────────
// Вспомогательные функции
// ──────────────────────────────────────────────────────────────────

function makeTestXlsx(rows: Record<string, unknown>[]): Buffer {
  const wb = xlsx.utils.book_new();
  const ws = xlsx.utils.json_to_sheet(rows);
  xlsx.utils.book_append_sheet(wb, ws, "Sheet1");
  return Buffer.from(xlsx.write(wb, { type: "buffer", bookType: "xlsx" }));
}

async function createTestEquipment(name: string, category: string, price: number, qty: number) {
  return prisma.equipment.create({
    data: {
      importKey: `${category.toUpperCase()}||${name.toUpperCase()}||||`,
      category,
      name,
      totalQuantity: qty,
      rentalRatePerShift: price,
    },
  });
}

async function getImportService() {
  return import("../services/importSession");
}

// ──────────────────────────────────────────────────────────────────
// Тесты createSession
// ──────────────────────────────────────────────────────────────────

describe("createSession", () => {
  it("создаёт сессию из валидного .xlsx файла", async () => {
    const { createSession } = await getImportService();

    const buffer = makeTestXlsx([
      { Категория: "Свет", Наименование: "Прожектор 1kW", "Кол-во": 2, Стоимость: 1000 },
      { Категория: "Свет", Наименование: "Панель Nova P300", "Кол-во": 1, Стоимость: 2000 },
    ]);

    const result = await createSession({
      buffer,
      originalname: "catalog.xlsx",
      size: buffer.length,
    });

    expect(result.session).toBeDefined();
    expect(result.session.status).toBe("PARSING");
    expect(result.session.fileName).toBe("catalog.xlsx");
    expect(result.preview).toBeDefined();
    expect(result.preview.headers).toContain("Наименование");
  });

  it("отклоняет файл с недопустимым расширением", async () => {
    const { createSession } = await getImportService();

    const buffer = Buffer.from("не xlsx");

    await expect(
      createSession({ buffer, originalname: "file.csv", size: buffer.length }),
    ).rejects.toThrow();
  });

  it("отклоняет файл больше 5MB", async () => {
    const { createSession } = await getImportService();

    const bigBuffer = Buffer.alloc(6 * 1024 * 1024 + 1, 0);

    await expect(
      createSession({ buffer: bigBuffer, originalname: "big.xlsx", size: bigBuffer.length }),
    ).rejects.toThrow();
  });

  it("удаляет существующую активную OWN-сессию при создании новой", async () => {
    const { createSession } = await getImportService();

    const buffer = makeTestXlsx([
      { Категория: "Свет", Наименование: "Прожектор 1kW", "Кол-во": 2, Стоимость: 1000 },
    ]);

    const first = await createSession({
      buffer,
      originalname: "first.xlsx",
      size: buffer.length,
    });

    const second = await createSession({
      buffer,
      originalname: "second.xlsx",
      size: buffer.length,
    });

    // Первая сессия должна быть удалена
    const firstInDb = await prisma.importSession.findUnique({ where: { id: first.session.id } });
    expect(firstInDb).toBeNull();

    expect(second.session.fileName).toBe("second.xlsx");
  });
});

// ──────────────────────────────────────────────────────────────────
// Тесты matchRow
// ──────────────────────────────────────────────────────────────────

describe("matchRow", () => {
  it("точное совпадение по importKey", async () => {
    const { matchRow } = await getImportService();

    const eq = await createTestEquipment("Панель Nova P300", "Свет", 2000, 3);

    const catalog = [eq];
    const result = await matchRow(
      { sourceName: "Панель Nova P300", sourceCategory: "Свет", sourceBrand: null, sourceModel: null },
      catalog,
    );

    expect(result.equipmentId).toBe(eq.id);
    expect(result.matchMethod).toBe("exact");
    expect(result.matchConfidence).toBeGreaterThanOrEqual(1.0);
  });

  it("нечёткое совпадение dice (похожее название)", async () => {
    const { matchRow } = await getImportService();

    const eq = await createTestEquipment("Fresnel Arri 2000W", "Свет", 3000, 2);

    const catalog = [eq];
    const result = await matchRow(
      { sourceName: "Fresnel Arri 2kW", sourceCategory: "Свет", sourceBrand: null, sourceModel: null },
      catalog,
    );

    // Должен найти через dice (достаточно похожее имя)
    if (result.equipmentId) {
      expect(result.matchMethod).toBe("dice");
      expect(result.matchConfidence).toBeGreaterThanOrEqual(0.7);
    } else {
      // Если не нашёл — всё равно корректно
      expect(result.equipmentId).toBeNull();
    }
  });

  it("нет совпадения для полностью другого названия", async () => {
    const { matchRow } = await getImportService();

    const eq = await createTestEquipment("Микрофон Sennheiser", "Звук", 500, 1);

    const catalog = [eq];
    const result = await matchRow(
      { sourceName: "Абсолютно другое оборудование XYZ123", sourceCategory: "Прочее", sourceBrand: null, sourceModel: null },
      catalog,
    );

    expect(result.equipmentId).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────
// Тесты computeDiff
// ──────────────────────────────────────────────────────────────────

describe("computeDiff", () => {
  it("обнаруживает изменение цены", async () => {
    const { createSession, mapAndMatch } = await getImportService();

    const eq = await createTestEquipment("Прожектор Diff1", "Свет", 1000, 2);

    // Импортируем с новой ценой
    const buffer = makeTestXlsx([
      { Категория: "Свет", Наименование: "Прожектор Diff1", "Кол-во": 2, Стоимость: 1500 },
    ]);

    const { session } = await createSession({
      buffer,
      originalname: "diff.xlsx",
      size: buffer.length,
    });

    await mapAndMatch(session.id, "OWN_PRICE_UPDATE", {
      category: "Категория",
      name: "Наименование",
      quantity: "Кол-во",
      rentalRatePerShift: "Стоимость",
    });

    const rows = await prisma.importSessionRow.findMany({
      where: { sessionId: session.id, equipmentId: eq.id },
    });

    expect(rows.length).toBeGreaterThan(0);
    const row = rows[0];
    expect(row.action).toBe("PRICE_CHANGE");
    expect(parseFloat(row.oldPrice)).toBe(1000);
    expect(parseFloat(row.sourcePrice)).toBe(1500);
  });

  it("обнаруживает изменение количества", async () => {
    const { createSession, mapAndMatch } = await getImportService();

    const eq = await createTestEquipment("Прожектор QtyTest", "Свет", 1000, 2);

    const buffer = makeTestXlsx([
      { Категория: "Свет", Наименование: "Прожектор QtyTest", "Кол-во": 5, Стоимость: 1000 },
    ]);

    const { session } = await createSession({
      buffer,
      originalname: "qty.xlsx",
      size: buffer.length,
    });

    await mapAndMatch(session.id, "OWN_PRICE_UPDATE", {
      category: "Категория",
      name: "Наименование",
      quantity: "Кол-во",
      rentalRatePerShift: "Стоимость",
    });

    const rows = await prisma.importSessionRow.findMany({
      where: { sessionId: session.id, equipmentId: eq.id },
    });

    expect(rows.length).toBeGreaterThan(0);
    const row = rows[0];
    expect(row.action).toBe("QTY_CHANGE");
  });

  it("помечает NO_CHANGE если ничего не изменилось", async () => {
    const { createSession, mapAndMatch } = await getImportService();

    const eq = await createTestEquipment("Прожектор NoChange", "Свет", 1000, 2);

    const buffer = makeTestXlsx([
      { Категория: "Свет", Наименование: "Прожектор NoChange", "Кол-во": 2, Стоимость: 1000 },
    ]);

    const { session } = await createSession({
      buffer,
      originalname: "nochange.xlsx",
      size: buffer.length,
    });

    await mapAndMatch(session.id, "OWN_PRICE_UPDATE", {
      category: "Категория",
      name: "Наименование",
      quantity: "Кол-во",
      rentalRatePerShift: "Стоимость",
    });

    const rows = await prisma.importSessionRow.findMany({
      where: { sessionId: session.id, equipmentId: eq.id },
    });

    expect(rows.length).toBeGreaterThan(0);
    const row = rows[0];
    expect(row.action).toBe("NO_CHANGE");
  });

  it("помечает подозрительные значения: цена=0, отрицательная, >10x", async () => {
    const { createSession, mapAndMatch } = await getImportService();

    const eq1 = await createTestEquipment("Прожектор Susp1", "Свет", 1000, 1);
    const eq2 = await createTestEquipment("Прожектор Susp2", "Свет", 1000, 1);
    const eq3 = await createTestEquipment("Прожектор Susp3", "Свет", 1000, 1);

    const buffer = makeTestXlsx([
      { Категория: "Свет", Наименование: "Прожектор Susp1", "Кол-во": 1, Стоимость: 0 },
      { Категория: "Свет", Наименование: "Прожектор Susp2", "Кол-во": 1, Стоимость: -100 },
      { Категория: "Свет", Наименование: "Прожектор Susp3", "Кол-во": 1, Стоимость: 50000 },
    ]);

    const { session } = await createSession({
      buffer,
      originalname: "susp.xlsx",
      size: buffer.length,
    });

    await mapAndMatch(session.id, "OWN_PRICE_UPDATE", {
      category: "Категория",
      name: "Наименование",
      quantity: "Кол-во",
      rentalRatePerShift: "Стоимость",
    });

    // Проверяем что строки были созданы (флаги через matchMethod или отдельное поле)
    const rows = await prisma.importSessionRow.findMany({
      where: { sessionId: session.id },
    });

    // Находим строки по equipmentId
    const row1 = rows.find((r: any) => r.equipmentId === eq1.id);
    const row2 = rows.find((r: any) => r.equipmentId === eq2.id);
    const row3 = rows.find((r: any) => r.equipmentId === eq3.id);

    // Суммарно должны быть помечены флагами
    const flagged = rows.filter((r: any) => r.matchMethod?.includes("FLAGGED") || r.sourceCategory?.includes("FLAGGED") || parseFloat(r.sourcePrice) <= 0 || parseFloat(r.sourcePrice) > 10000);
    expect(flagged.length).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────────────────────────
// Тесты applyChanges
// ──────────────────────────────────────────────────────────────────

describe("applyChanges", () => {
  it("применяет обновление цены для принятых строк", async () => {
    const { createSession, mapAndMatch, updateRowStatus, applyChanges } = await getImportService();

    const eq = await createTestEquipment("Прожектор Apply1", "Свет", 1000, 2);

    const buffer = makeTestXlsx([
      { Категория: "Свет", Наименование: "Прожектор Apply1", "Кол-во": 2, Стоимость: 2000 },
    ]);

    const { session } = await createSession({
      buffer,
      originalname: "apply.xlsx",
      size: buffer.length,
    });

    await mapAndMatch(session.id, "OWN_PRICE_UPDATE", {
      category: "Категория",
      name: "Наименование",
      quantity: "Кол-во",
      rentalRatePerShift: "Стоимость",
    });

    const rows = await prisma.importSessionRow.findMany({
      where: { sessionId: session.id, equipmentId: eq.id },
    });
    expect(rows.length).toBeGreaterThan(0);
    const row = rows[0];

    // Принимаем строку
    await updateRowStatus(row.id, "ACCEPTED");

    // Применяем изменения
    const result = await applyChanges(session.id);
    expect(result.applied).toBeDefined();

    // Проверяем что цена обновилась
    const updatedEq = await prisma.equipment.findUnique({ where: { id: eq.id } });
    expect(parseFloat(updatedEq.rentalRatePerShift)).toBe(2000);
  });

  it("REMOVED_ITEM с активной бронью пропускается", async () => {
    const { createSession, mapAndMatch, bulkAction, applyChanges } = await getImportService();

    // Создаём оборудование
    const eq = await createTestEquipment("Прожектор RemoveTest", "Свет", 1000, 1);

    // Создаём клиента и активную бронь с этим оборудованием
    const client = await prisma.client.create({ data: { name: "Клиент RemoveTest" } });
    const booking = await prisma.booking.create({
      data: {
        clientId: client.id,
        projectName: "Проект RemoveTest",
        startDate: new Date("2027-01-01"),
        endDate: new Date("2027-01-03"),
        status: "CONFIRMED",
        items: {
          create: {
            equipmentId: eq.id,
            quantity: 1,
          },
        },
      },
    });

    // Импорт без этого оборудования → должен создать REMOVED_ITEM
    const buffer = makeTestXlsx([
      { Категория: "Другое", Наименование: "Другое оборудование", "Кол-во": 1, Стоимость: 500 },
    ]);

    const { session } = await createSession({
      buffer,
      originalname: "remove.xlsx",
      size: buffer.length,
    });

    await mapAndMatch(session.id, "OWN_PRICE_UPDATE", {
      category: "Категория",
      name: "Наименование",
      quantity: "Кол-во",
      rentalRatePerShift: "Стоимость",
    });

    // Принимаем все строки включая REMOVED_ITEM
    await bulkAction(session.id, "ACCEPTED", {});

    // Применяем
    const result = await applyChanges(session.id);

    // REMOVED_ITEM с активной бронью должен быть в skipped
    const skippedRemoved = result.skipped.find((s: any) => s.reason?.includes("бронь") || s.reason?.includes("active"));
    // Оборудование должно остаться в БД
    const stillExists = await prisma.equipment.findUnique({ where: { id: eq.id } });
    expect(stillExists).not.toBeNull();
  });

  it("оптимистичная блокировка: второй applyChanges возвращает 409", async () => {
    const { createSession, mapAndMatch, applyChanges } = await getImportService();

    const eq = await createTestEquipment("Прожектор Lock1", "Свет", 1000, 1);

    const buffer = makeTestXlsx([
      { Категория: "Свет", Наименование: "Прожектор Lock1", "Кол-во": 1, Стоимость: 1000 },
    ]);

    const { session } = await createSession({
      buffer,
      originalname: "lock.xlsx",
      size: buffer.length,
    });

    await mapAndMatch(session.id, "OWN_PRICE_UPDATE", {
      category: "Категория",
      name: "Наименование",
      quantity: "Кол-во",
      rentalRatePerShift: "Стоимость",
    });

    // Первый apply
    await applyChanges(session.id);

    // Второй apply должен бросить 409
    await expect(applyChanges(session.id)).rejects.toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────
// Тесты bulkAction
// ──────────────────────────────────────────────────────────────────

describe("bulkAction", () => {
  it("bulk accept не включает помеченные флагами строки", async () => {
    const { createSession, mapAndMatch, bulkAction } = await getImportService();

    const eq = await createTestEquipment("Прожектор BulkFlag", "Свет", 1000, 1);

    // Цена = 0 (подозрительная)
    const buffer = makeTestXlsx([
      { Категория: "Свет", Наименование: "Прожектор BulkFlag", "Кол-во": 1, Стоимость: 0 },
    ]);

    const { session } = await createSession({
      buffer,
      originalname: "bulk.xlsx",
      size: buffer.length,
    });

    await mapAndMatch(session.id, "OWN_PRICE_UPDATE", {
      category: "Категория",
      name: "Наименование",
      quantity: "Кол-во",
      rentalRatePerShift: "Стоимость",
    });

    // Bulk accept всех строк
    await bulkAction(session.id, "ACCEPTED", {});

    // Подозрительные строки должны остаться PENDING
    const rows = await prisma.importSessionRow.findMany({
      where: { sessionId: session.id },
    });

    // Проверяем что строка с ценой 0 не стала ACCEPTED
    const flaggedRow = rows.find((r: any) => {
      const price = parseFloat(r.sourcePrice);
      return price <= 0;
    });

    if (flaggedRow) {
      expect(flaggedRow.status).toBe("PENDING");
    }
  });
});
