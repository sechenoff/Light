/**
 * Интеграционный тест: problem flow — обработка проблемных единиц при возврате
 *
 * Phase 2 — «Потеряно» и «Не вернули» схлопнуты в единый ✗ Проблема outcome
 * с 4 причинами (LEFT_ON_SITE / LOST / DESTROYED / STOLEN). Немедленный
 * write-off/компенсация/invoice-resync убраны — заменены жизненным циклом
 * реестра «Потеряшки» (problemItemService).
 *
 * Проверяет:
 * - LOST → ProblemItem SEARCHING, unit MISSING (не RETIRED)
 * - DESTROYED → unit RETIRED, ProblemItem WROTE_OFF
 * - repairUnits (переименование brokenUnits) по-прежнему создаёт Repair
 * - поздний возврат авто-резолвит открытую EXPECTED-карточку
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-problem-unit.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-problem-unit";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-problem-unit-32chars";
process.env.WAREHOUSE_SECRET = "test-warehouse-problem-unit-16c";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-problem-unit-min16chars";

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
  const hash = await hashPassword("test-pass-problem-unit");

  const adminUser = await prisma.adminUser.create({
    data: { username: "problem_unit_admin", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  adminUserId = adminUser.id;

  const client = await prisma.client.create({
    data: { name: "Тест клиент проблема", phone: "+70000000098" },
  });
  clientId = client.id;

  const equipment = await prisma.equipment.create({
    data: {
      importKey: "problem-unit-equipment-001",
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
      projectName: `Тест проблема ${unitBarcode}`,
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

describe("completeSession problemUnits", () => {
  it("LOST → ProblemItem SEARCHING, unit MISSING (not RETIRED)", async () => {
    const { unit, booking, session } = await setupReturnSession("PU-LOST-1");
    const { completeSession } = await import("../services/warehouseScan");
    await completeSession(session.id, { problemUnits: [{ equipmentUnitId: unit.id, reason: "LOST", comment: "не вернули со смены" }], createdBy: adminUserId });
    const u = await prisma.equipmentUnit.findUnique({ where: { id: unit.id } });
    expect(u!.status).toBe("MISSING");
    const pi = await prisma.problemItem.findFirst({ where: { equipmentUnitId: unit.id } });
    expect(pi!.reason).toBe("LOST"); expect(pi!.status).toBe("SEARCHING"); expect(pi!.sourceBookingId).toBe(booking.id);
  });

  it("DESTROYED → unit RETIRED, ProblemItem WROTE_OFF", async () => {
    const { unit, session } = await setupReturnSession("PU-DESTR-1");
    const { completeSession } = await import("../services/warehouseScan");
    await completeSession(session.id, { problemUnits: [{ equipmentUnitId: unit.id, reason: "DESTROYED", comment: "раздавлен" }], createdBy: adminUserId });
    const u = await prisma.equipmentUnit.findUnique({ where: { id: unit.id } });
    expect(u!.status).toBe("RETIRED");
    const pi = await prisma.problemItem.findFirst({ where: { equipmentUnitId: unit.id } });
    expect(pi!.status).toBe("WROTE_OFF");
  });

  it("repairUnits still creates Repair (renamed from brokenUnits)", async () => {
    const { unit, session } = await setupReturnSession("PU-REPAIR-1");
    const { completeSession } = await import("../services/warehouseScan");
    const s = await completeSession(session.id, { repairUnits: [{ equipmentUnitId: unit.id, comment: "трещина" }], createdBy: adminUserId });
    expect(s.createdRepairIds).toHaveLength(1);
    const rep = await prisma.repair.findUnique({ where: { id: s.createdRepairIds[0] } });
    expect(rep!.urgency).toBe("NORMAL"); expect(rep!.reason).toBe("трещина");
  });

  it("late return auto-resolves an open EXPECTED ProblemItem", async () => {
    const { createProblemItem } = await import("../services/problemItemService");
    const { unit, session } = await setupReturnSession("PU-LATE-1");
    await createProblemItem({ equipmentUnitId: unit.id, reason: "LEFT_ON_SITE", comment: "осталось", sourceBookingId: null, createdBy: adminUserId });
    const { completeSession } = await import("../services/warehouseScan");
    await completeSession(session.id, { createdBy: adminUserId });
    const pi = await prisma.problemItem.findFirst({ where: { equipmentUnitId: unit.id } });
    expect(pi!.status).toBe("FOUND");
    const u = await prisma.equipmentUnit.findUnique({ where: { id: unit.id } });
    expect(u!.status).toBe("AVAILABLE");
  });
});
