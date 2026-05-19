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

  it("adds + writes BOOKING_ITEM_ADDED_WITH_CONFLICT when acknowledged", async () => {
    const { addExtraItem } = await import("../services/checklistService");
    const r = await addExtraItem(sessionId, eqBusyId, 1, createdById, true);
    expect(r.bookingItemId).toBeTruthy();
    const audit = await prisma.auditEntry.findFirst({
      where: { action: "BOOKING_ITEM_ADDED_WITH_CONFLICT" },
    });
    expect(audit).not.toBeNull();
  });
});
