/**
 * Интеграционный тест: репэйр-фото — staged-фото поломки линкуются в RepairPhoto
 * при завершении сессии возврата.
 *
 * Phase 3 — фото поломки загружаются во время сессии возврата в staging-
 * директорию (scan-sessions/{sessionId}/{unitId}/), затем на completeSession
 * для единиц, помеченных в ремонт (repairUnits), staged-фото переносятся в
 * uploads/repairs/{repairId}/ и создаются RepairPhoto-записи.
 *
 * Гарнесс/setupReturnSession/adminUserId — паттерн из warehouseProblemUnit.test.ts
 * (warehouseLostUnit.test.ts удалён в предыдущей задаче).
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-repair-photos.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-repair-photos";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-repair-photos-32char";
process.env.WAREHOUSE_SECRET = "test-warehouse-repair-photos16c";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-repair-photos-min16char";

let prisma: any;
let clientId: string;
let equipmentId: string;
let adminUserId: string;

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=", "base64");

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
  const hash = await hashPassword("test-pass-repair-photos");

  const adminUser = await prisma.adminUser.create({
    data: { username: "repair_photos_admin", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  adminUserId = adminUser.id;

  const client = await prisma.client.create({
    data: { name: "Тест клиент фото", phone: "+70000000097" },
  });
  clientId = client.id;

  const equipment = await prisma.equipment.create({
    data: {
      importKey: "repair-photos-equipment-001",
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
      projectName: `Тест фото ${unitBarcode}`,
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

describe("repair photos", () => {
  it("staged photos become RepairPhoto on complete", async () => {
    const { unit, session } = await setupReturnSession("RP-1");
    const { writeStagedPhoto } = await import("../services/repairPhotoStorage");
    writeStagedPhoto(session.id, unit.id, PNG, "broke.png");
    const { completeSession } = await import("../services/warehouseScan");
    const s = await completeSession(session.id, {
      repairUnits: [{ equipmentUnitId: unit.id, comment: "скол" }], createdBy: adminUserId,
    });
    const photos = await prisma.repairPhoto.findMany({ where: { repairId: s.createdRepairIds[0] } });
    expect(photos).toHaveLength(1);
    expect(photos[0].filePath.startsWith("repairs/")).toBe(true);
  });
});
