/**
 * Интеграционный тест: addExtraItem soft-warn conflict + warehouse addon endpoints
 * Phase 1 — warehouse-scan-redesign (Task 1.2)
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-addon-items.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-addon-items";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-addon-items";
process.env.WAREHOUSE_SECRET = "test-warehouse-addon-items";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-addon-items-min16chars";

let prisma: any;
let clientId: string;
let eqBusyId: string;
let eqFreeId: string;
let eqAuditId: string;
let targetBookingId: string;
let sessionId: string;
let createdById: string;

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

  // AuditEntry.userId — обязательный FK на AdminUser. Создаём пользователя и
  // передаём его id как createdBy, чтобы аудит-запись действительно писалась
  // (иначе writeAuditEntry бросает P2003 и .catch() её глушит).
  const { hashPassword } = await import("../services/auth");
  const hash = await hashPassword("addon-pass");
  const admin = await prisma.adminUser.create({
    data: { username: "addon_super", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  createdById = admin.id;

  const client = await prisma.client.create({
    data: { name: "Тест клиент addon", phone: "+70000000002" },
  });
  clientId = client.id;

  // COUNT-оборудование с единственным экземпляром
  const eqBusy = await prisma.equipment.create({
    data: {
      importKey: "addon-eq-busy-001",
      name: "Дефицитный прибор",
      category: "Осветительные приборы",
      rentalRatePerShift: 500,
      stockTrackingMode: "COUNT",
      totalQuantity: 1,
    },
  });
  eqBusyId = eqBusy.id;

  // Конфликтующая CONFIRMED бронь, занимающая eqBusy qty 1 на 2026-06-10..2026-06-12
  const busyBooking = await prisma.booking.create({
    data: {
      clientId,
      projectName: "Занятый проект",
      startDate: new Date("2026-06-10"),
      endDate: new Date("2026-06-12"),
      status: "CONFIRMED",
      amountPaid: 0,
      amountOutstanding: 0,
    },
  });
  await prisma.bookingItem.create({
    data: { bookingId: busyBooking.id, equipmentId: eqBusyId, quantity: 1 },
  });

  // Свободное COUNT-оборудование (2 шт., без броней) — для проверки, что
  // acknowledgedConflict без реального конфликта НЕ расширяет сток
  const eqFree = await prisma.equipment.create({
    data: {
      importKey: "addon-eq-free-001",
      name: "Свободный прибор",
      category: "Осветительные приборы",
      rentalRatePerShift: 300,
      stockTrackingMode: "COUNT",
      totalQuantity: 2,
    },
  });
  eqFreeId = eqFree.id;

  // Отдельный свободный артикул для теста аудита — чтобы добавление позиции
  // не влияло на addCap-ожидания в тесте про eqFree
  const eqAudit = await prisma.equipment.create({
    data: {
      importKey: "addon-eq-audit-001",
      name: "Прибор для аудита",
      category: "Осветительные приборы",
      rentalRatePerShift: 100,
      stockTrackingMode: "COUNT",
      totalQuantity: 5,
    },
  });
  eqAuditId = eqAudit.id;

  // Целевая CONFIRMED бронь на пересекающиеся даты 2026-06-11..2026-06-13
  const tgt = await prisma.booking.create({
    data: {
      clientId,
      projectName: "Целевой проект",
      startDate: new Date("2026-06-11"),
      endDate: new Date("2026-06-13"),
      status: "CONFIRMED",
      amountPaid: 0,
      amountOutstanding: 0,
    },
  });

  targetBookingId = tgt.id;

  const session = await prisma.scanSession.create({
    data: {
      bookingId: tgt.id,
      workerName: "tester",
      operation: "ISSUE",
      status: "ACTIVE",
    },
  });
  sessionId = session.id;
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

describe("addExtraItem conflict handling", () => {
  it("throws ADDON_CONFLICT when conflicting and not acknowledged", async () => {
    const { addExtraItem } = await import("../services/checklistService");
    await expect(
      addExtraItem(sessionId, eqBusyId, 1, createdById, false),
    ).rejects.toMatchObject({ status: 409, code: "ADDON_CONFLICT" });
  });

  it("«Выдать под ответственность»: ack при конфликте добавляет позицию + аудит WITH_CONFLICT", async () => {
    // Fix 2026-08-05. Раньше hard-cap вычитал occupiedByOthers и при ack —
    // а конфликт-карточка показывается ТОЛЬКО когда availableQuantity ≤ 0,
    // поэтому ack-путь всегда падал ADDON_OVER_STOCK и задизайненная спекой
    // кнопка «Выдать под ответственность» была недостижима. Теперь при
    // подтверждённом конфликте потолок — физический склад:
    // cap = totalQuantity(1) − alreadyMine(0) = 1 ≥ 1 → добавлено.
    const { addExtraItem } = await import("../services/checklistService");
    const { bookingItemId } = await addExtraItem(sessionId, eqBusyId, 1, createdById, true);
    expect(bookingItemId).toBeTruthy();

    const item = await prisma.bookingItem.findUnique({
      where: { bookingId_equipmentId: { bookingId: targetBookingId, equipmentId: eqBusyId } },
    });
    expect(item?.quantity).toBe(1);

    const audit = await prisma.auditEntry.findMany({
      where: { entityType: "Booking", entityId: targetBookingId, action: "BOOKING_ITEM_ADDED_WITH_CONFLICT" },
    });
    expect(audit).toHaveLength(1);
    // UI обещает «Конфликт зафиксируется в аудите» — снапшот должен нести детали
    const after = typeof audit[0].after === "string" ? JSON.parse(audit[0].after) : audit[0].after;
    expect(after.conflict).toBeTruthy();
    expect(after.conflict.projectName).toBe("Занятый проект");
  });

  it("аудит проходит FK, когда киоск открыт главной сессией (auditUserId)", async () => {
    // Регрессия 2026-08-05: createdBy — имя кладовщика из PIN-namespace, оно не
    // проходит FK на AdminUser, и writeAuditEntry молча падал в .catch().
    // Роут теперь передаёт req.adminUser?.id отдельным аргументом.
    const { addExtraItem } = await import("../services/checklistService");
    const before = await prisma.auditEntry.count({
      where: { entityType: "Booking", action: "BOOKING_ITEM_ADDED_ON_SITE" },
    });
    await addExtraItem(sessionId, eqAuditId, 1, "Иван Кладовщик", false, createdById);
    const rows = await prisma.auditEntry.findMany({
      where: { entityType: "Booking", action: "BOOKING_ITEM_ADDED_ON_SITE" },
      orderBy: { createdAt: "desc" },
    });
    expect(rows.length).toBe(before + 1);
    expect(rows[0].userId).toBe(createdById);
  });

  it("ack НЕ обходит физический склад: сверх totalQuantity → ADDON_OVER_STOCK", async () => {
    // После предыдущего теста в целевой брони уже 1 шт. — весь физический
    // сток (totalQuantity=1) выбран. Ещё 1 с ack → cap = 1 − 1 = 0 → 409.
    const { addExtraItem } = await import("../services/checklistService");
    await expect(
      addExtraItem(sessionId, eqBusyId, 1, createdById, true),
    ).rejects.toMatchObject({
      status: 409,
      code: "ADDON_OVER_STOCK",
      details: { addCap: 0, requested: 1, alreadyInBooking: 1 },
    });
  });

  it("ack без конфликта игнорируется: свободный артикул сверх стока → ADDON_OVER_STOCK", async () => {
    // eqFree свободен (конфликта нет) → ack не расширяет cap: клиент не может
    // выдать больше склада, просто прислав acknowledgedConflict: true.
    const { addExtraItem } = await import("../services/checklistService");
    await expect(
      addExtraItem(sessionId, eqFreeId, 3, createdById, true),
    ).rejects.toMatchObject({
      status: 409,
      code: "ADDON_OVER_STOCK",
      details: { addCap: 2, requested: 3, alreadyInBooking: 0 },
    });
  });
});
