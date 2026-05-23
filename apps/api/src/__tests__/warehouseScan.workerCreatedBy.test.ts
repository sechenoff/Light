/**
 * Регрессионный тест: completeSession с createdBy = workerName (имя/username,
 * не AdminUser.id) — реальный prod-сценарий, когда `warehouseAuth` кладёт в
 * `req.warehouseWorker.name` либо `WarehousePin.name`, либо `AdminUser.username`
 * (не id). Раньше это валило `Repair` и `ProblemItem` через P2003 на
 * `AuditEntry.userId → AdminUser.id` FK внутри их $transaction.
 *
 * После фикса: audit вынесен из tx как best-effort `.catch()`, бизнес-объекты
 * создаются всегда, даже если userId не резолвится в AdminUser.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-worker-createdby.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-worker";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-worker";
process.env.WAREHOUSE_SECRET = "test-warehouse-worker";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-worker-min16chars-padding";

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
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }
});

/** Билдер: бронь в статусе ISSUED с N UNIT-резервациями (по одной единице каждая). */
async function seedReturnReadyBooking(unitCount: number): Promise<{
  bookingId: string;
  unitIds: string[];
  sessionId: string;
}> {
  const client = await prisma.client.create({
    data: { name: `WC-${Math.random()}`, phone: `+7${Math.floor(Math.random() * 1e10)}` },
  });
  const equipment = await prisma.equipment.create({
    data: {
      importKey: `wc-eq-${Math.random()}`,
      name: "WC equipment",
      category: "Тест",
      rentalRatePerShift: 100,
      stockTrackingMode: "UNIT",
    },
  });
  const unitIds: string[] = [];
  for (let i = 0; i < unitCount; i++) {
    const u = await prisma.equipmentUnit.create({
      data: { equipmentId: equipment.id, status: "ISSUED" },
    });
    unitIds.push(u.id);
  }
  const booking = await prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: "WC test",
      startDate: new Date("2026-05-01"),
      endDate: new Date("2026-05-05"),
      status: "ISSUED",
      amountPaid: 0,
      amountOutstanding: 0,
    },
  });
  const bi = await prisma.bookingItem.create({
    data: { bookingId: booking.id, equipmentId: equipment.id, quantity: unitCount },
  });
  for (const uid of unitIds) {
    await prisma.bookingItemUnit.create({
      data: { bookingItemId: bi.id, equipmentUnitId: uid },
    });
  }
  const session = await prisma.scanSession.create({
    data: { bookingId: booking.id, workerName: "PIN-Иван", operation: "RETURN", status: "ACTIVE" },
  });
  return { bookingId: booking.id, unitIds, sessionId: session.id };
}

describe("completeSession с createdBy НЕ равным AdminUser.id (workerName/PIN-name)", () => {
  it("repairUnits: Repair карточка создаётся, unit→MAINTENANCE, failedBrokenUnits пустой", async () => {
    // 3 единицы: 1 принимаем (сканируем), 1 на ремонт, 1 проигнорим (missing).
    const { unitIds, sessionId, bookingId } = await seedReturnReadyBooking(3);
    const [acceptedUnit, repairUnit] = unitIds;

    // Скан только принятой единицы.
    await prisma.scanRecord.create({
      data: { sessionId, equipmentUnitId: acceptedUnit, hmacVerified: false },
    });

    const { completeSession } = await import("../services/warehouseScan");

    // createdBy — реальный prod-сценарий: имя кладовщика по PIN, НЕ AdminUser.id.
    const summary = await completeSession(sessionId, {
      repairUnits: [{ equipmentUnitId: repairUnit, comment: "разбит светофильтр", urgency: "URGENT" }],
      createdBy: "PIN-Иван",
    });

    // ── Контракт: бронь переведена в RETURNED (main TX закоммитилась) ──────
    const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
    expect(booking.status).toBe("RETURNED");

    // ── Repair карточка создана несмотря на не-AdminUser createdBy ─────────
    expect(summary.createdRepairIds).toHaveLength(1);
    expect(summary.failedBrokenUnits).toHaveLength(0);

    const repair = await prisma.repair.findFirst({ where: { unitId: repairUnit } });
    expect(repair).not.toBeNull();
    expect(repair.status).toBe("WAITING_REPAIR");
    expect(repair.reason).toBe("разбит светофильтр");
    expect(repair.urgency).toBe("URGENT");
    expect(repair.sourceBookingId).toBe(bookingId);
    expect(repair.createdBy).toBe("PIN-Иван");

    // ── Unit переведён в MAINTENANCE ─────────────────────────────────────
    const unit = await prisma.equipmentUnit.findUnique({ where: { id: repairUnit } });
    expect(unit.status).toBe("MAINTENANCE");
  });

  it("problemUnits (LOST): ProblemItem создаётся, unit→MISSING, failedProblemUnits пустой", async () => {
    const { unitIds, sessionId, bookingId } = await seedReturnReadyBooking(2);
    const [acceptedUnit, problemUnit] = unitIds;

    await prisma.scanRecord.create({
      data: { sessionId, equipmentUnitId: acceptedUnit, hmacVerified: false },
    });

    const { completeSession } = await import("../services/warehouseScan");
    const summary = await completeSession(sessionId, {
      problemUnits: [{ equipmentUnitId: problemUnit, reason: "LOST", comment: "не вернули со смены" }],
      createdBy: "PIN-Иван",
    });

    expect(summary.createdProblemItemIds).toHaveLength(1);
    expect(summary.failedProblemUnits).toHaveLength(0);

    const pi = await prisma.problemItem.findFirst({ where: { equipmentUnitId: problemUnit } });
    expect(pi).not.toBeNull();
    expect(pi.status).toBe("SEARCHING");
    expect(pi.reason).toBe("LOST");
    expect(pi.comment).toBe("не вернули со смены");
    expect(pi.sourceBookingId).toBe(bookingId);
    expect(pi.createdBy).toBe("PIN-Иван");

    const unit = await prisma.equipmentUnit.findUnique({ where: { id: problemUnit } });
    expect(unit.status).toBe("MISSING");
  });

  it("problemUnits (DESTROYED): ProblemItem WROTE_OFF + unit RETIRED, без AdminUser id", async () => {
    const { unitIds, sessionId } = await seedReturnReadyBooking(1);
    const [destroyedUnit] = unitIds;

    const { completeSession } = await import("../services/warehouseScan");
    const summary = await completeSession(sessionId, {
      problemUnits: [{ equipmentUnitId: destroyedUnit, reason: "DESTROYED", comment: "раздавили на площадке" }],
      createdBy: "sechenoff",
    });

    expect(summary.createdProblemItemIds).toHaveLength(1);
    expect(summary.failedProblemUnits).toHaveLength(0);

    const pi = await prisma.problemItem.findFirst({ where: { equipmentUnitId: destroyedUnit } });
    expect(pi.status).toBe("WROTE_OFF");
    expect(pi.resolvedAt).not.toBeNull();

    const unit = await prisma.equipmentUnit.findUnique({ where: { id: destroyedUnit } });
    expect(unit.status).toBe("RETIRED");
  });

  it("комбо (repair + problem): обе сущности созданы атомарно с workerName", async () => {
    const { unitIds, sessionId } = await seedReturnReadyBooking(2);
    const [repairUnit, problemUnit] = unitIds;

    const { completeSession } = await import("../services/warehouseScan");
    const summary = await completeSession(sessionId, {
      repairUnits: [{ equipmentUnitId: repairUnit, comment: "трещина в корпусе" }],
      problemUnits: [{ equipmentUnitId: problemUnit, reason: "STOLEN", comment: "украли" }],
      createdBy: "Кладовщик Дмитрий",
    });

    expect(summary.createdRepairIds).toHaveLength(1);
    expect(summary.createdProblemItemIds).toHaveLength(1);
    expect(summary.failedBrokenUnits).toHaveLength(0);
    expect(summary.failedProblemUnits).toHaveLength(0);

    const repair = await prisma.repair.findFirst({ where: { unitId: repairUnit } });
    const pi = await prisma.problemItem.findFirst({ where: { equipmentUnitId: problemUnit } });
    expect(repair).not.toBeNull();
    expect(pi).not.toBeNull();
    expect(pi.status).toBe("SEARCHING");

    const ru = await prisma.equipmentUnit.findUnique({ where: { id: repairUnit } });
    const pu = await prisma.equipmentUnit.findUnique({ where: { id: problemUnit } });
    expect(ru.status).toBe("MAINTENANCE");
    expect(pu.status).toBe("MISSING");
  });
});
