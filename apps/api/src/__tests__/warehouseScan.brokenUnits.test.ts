/**
 * Интеграционный тест: warehouse scan return с brokenUnits
 * Sprint 4.4 — после возврата оборудования создаются Repair карточки
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-scan-broken.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-scan-broken";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-scan-broken";
process.env.WAREHOUSE_SECRET = "test-warehouse-scan-broken";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-scan-broken-min16chars";

let prisma: any;
let superAdminId: string;
let clientId: string;
let equipmentId: string;
let unitId: string;
let bookingId: string;
let sessionId: string;

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
  const hash = await hashPassword("scan-broken-pass");

  const superAdmin = await prisma.adminUser.create({
    data: { username: "scan_broken_super", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  superAdminId = superAdmin.id;

  const client = await prisma.client.create({
    data: { name: "Тест клиент scan broken", phone: "+70000000001" },
  });
  clientId = client.id;

  const equipment = await prisma.equipment.create({
    data: {
      importKey: "scan-broken-equipment-001",
      name: "Свет для тест scan",
      category: "Осветительные приборы",
      rentalRatePerShift: 500,
      stockTrackingMode: "UNIT",
    },
  });
  equipmentId = equipment.id;

  const unit = await prisma.equipmentUnit.create({
    data: {
      equipmentId,
      barcode: "SCAN-BROKEN-001",
      status: "ISSUED",
    },
  });
  unitId = unit.id;

  // Создаём бронирование в статусе ISSUED
  const booking = await prisma.booking.create({
    data: {
      clientId,
      projectName: "Тест возврат",
      startDate: new Date("2026-04-01"),
      endDate: new Date("2026-04-05"),
      status: "ISSUED",
      amountPaid: 0,
      amountOutstanding: 0,
    },
  });
  bookingId = booking.id;

  // Создаём позицию и резервацию
  const bookingItem = await prisma.bookingItem.create({
    data: {
      bookingId,
      equipmentId,
      quantity: 1,
    },
  });

  await prisma.bookingItemUnit.create({
    data: {
      bookingItemId: bookingItem.id,
      equipmentUnitId: unitId,
    },
  });

  // Создаём активную RETURN сессию
  const session = await prisma.scanSession.create({
    data: {
      bookingId,
      workerName: "Тест склад",
      operation: "RETURN",
      status: "ACTIVE",
    },
  });
  sessionId = session.id;

  // Регистрируем скан
  await prisma.scanRecord.create({
    data: {
      sessionId,
      equipmentUnitId: unitId,
      hmacVerified: false,
    },
  });
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

describe("completeSession с brokenUnits", () => {
  it("после возврата с brokenUnits — Repair создана, unit в MAINTENANCE", async () => {
    const { completeSession } = await import("../services/warehouseScan");

    const summary = await completeSession(sessionId, {
      brokenUnits: [
        {
          equipmentUnitId: unitId,
          reason: "Поломана линза",
          urgency: "URGENT",
        },
      ],
      createdBy: superAdminId,
    });

    expect(summary.scanned).toBe(1);

    // Ремонт должен быть создан
    const repair = await prisma.repair.findFirst({
      where: { unitId, status: "WAITING_REPAIR" },
    });
    expect(repair).not.toBeNull();
    expect(repair.reason).toBe("Поломана линза");
    expect(repair.urgency).toBe("URGENT");
    expect(repair.sourceBookingId).toBe(bookingId);

    // Unit должен быть в MAINTENANCE (createRepair изменил статус)
    const unit = await prisma.equipmentUnit.findUnique({ where: { id: unitId } });
    expect(unit.status).toBe("MAINTENANCE");
  });
});
