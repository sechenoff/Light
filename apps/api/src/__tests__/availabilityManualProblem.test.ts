/**
 * Регрессия доступности: потеряшка, привязанная к позиции напрямую
 * (`ProblemItem.equipmentId`, без брони), уменьшает «Доступно».
 *
 * До инвентаризации getLostCountByEquipmentMap искал позицию только через
 * bookingItem, и потеряшка «не нашли на складе» (инвентаризация) или заведённая
 * вручную в доступность не попадала бы вовсе: календарь продолжал бы продавать
 * то, чего на полке нет. Строка с ОБОИМИ полями должна считаться один раз.
 *
 * Здесь же — потеряшки с приёмки (UNIT и COUNT) теперь пишут прямой equipmentId.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-availability-manual-problem.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-avail-manual";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-avail-manual";
process.env.WAREHOUSE_SECRET = "test-warehouse-avail-manual";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-secret-avail-manual-min16chars";

const DAY = 24 * 60 * 60 * 1000;
const daysFromNow = (d: number) => new Date(Date.now() + d * DAY);

let app: Express;
let prisma: any;
let saToken: string;
let clientId: string;

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
  app = (await import("../app")).app;
  prisma = (await import("../prisma")).prisma;

  const { hashPassword, signSession } = await import("../services/auth");
  const sa = await prisma.adminUser.create({
    data: { username: "avail_super", passwordHash: await hashPassword("avail-pass"), role: "SUPER_ADMIN" },
  });
  saToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });
  clientId = (await prisma.client.create({ data: { name: "Клиент Доступности" } })).id;
});

afterAll(async () => {
  await prisma.$disconnect();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const f = TEST_DB_PATH + suffix;
    if (fs.existsSync(f)) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }
});

async function countEquipment(key: string, name: string, totalQuantity: number) {
  return prisma.equipment.create({
    data: {
      importKey: `avail-manual-${key}`,
      name,
      category: "Грип",
      totalQuantity,
      rentalRatePerShift: "300",
      stockTrackingMode: "COUNT",
    },
  });
}

async function returnedBookingWith(equipmentId: string, quantity: number) {
  return prisma.booking.create({
    data: {
      clientId,
      projectName: `Возврат ${equipmentId.slice(-4)}`,
      status: "RETURNED",
      startDate: daysFromNow(-5),
      endDate: daysFromNow(-3),
      items: { create: [{ equipmentId, quantity }] },
    },
    include: { items: true },
  });
}

/** Доступно по /api/availability на окно в будущем, где броней нет. */
async function availableViaApi(equipmentId: string): Promise<number> {
  const start = encodeURIComponent(daysFromNow(20).toISOString());
  const end = encodeURIComponent(daysFromNow(21).toISOString());
  const res = await request(app)
    .get(`/api/availability?start=${start}&end=${end}`)
    .set({ "X-API-Key": "test-key-avail-manual", Authorization: `Bearer ${saToken}` });
  expect(res.status).toBe(200);
  const row = res.body.rows.find((r: any) => r.equipmentId === equipmentId);
  expect(row).toBeDefined();
  return row.availableQuantity;
}

describe("потеряшка по позиции без брони уменьшает доступность", () => {
  it("ручная потеряшка (только equipmentId) → /api/availability показывает меньше", async () => {
    const eq = await countEquipment("manual", "Флаг 24×36", 10);
    expect(await availableViaApi(eq.id)).toBe(10);

    await prisma.problemItem.create({
      data: {
        equipmentId: eq.id, quantity: 2, reason: "NOT_ON_SHELF", status: "SEARCHING",
        source: "MANUAL", comment: "не нашли на полке", createdBy: "avail_super",
      },
    });
    expect(await availableViaApi(eq.id)).toBe(8);

    // Найденная (FOUND) — снова в обороте.
    await prisma.problemItem.create({
      data: {
        equipmentId: eq.id, quantity: 3, reason: "LOST", status: "FOUND",
        source: "MANUAL", comment: "нашлась", createdBy: "avail_super",
      },
    });
    expect(await availableViaApi(eq.id)).toBe(8);
  });

  it("строка с equipmentId И bookingItem считается один раз", async () => {
    const eq = await countEquipment("both", "Стойка низкая", 10);
    const booking = await returnedBookingWith(eq.id, 4);
    await prisma.problemItem.create({
      data: {
        equipmentId: eq.id, bookingItemId: booking.items[0].id, sourceBookingId: booking.id,
        quantity: 3, reason: "LOST", comment: "с приёмки", createdBy: "Иван",
      },
    });
    // Старая строка с приёмки — только через бронь.
    await prisma.problemItem.create({
      data: {
        bookingItemId: booking.items[0].id, sourceBookingId: booking.id,
        quantity: 1, reason: "LEFT_ON_SITE", status: "EXPECTED", comment: "на площадке", createdBy: "Иван",
      },
    });
    expect(await availableViaApi(eq.id)).toBe(6);

    const { getLostCountByEquipmentMap } = await import("../services/availability");
    expect((await getLostCountByEquipmentMap([eq.id])).get(eq.id)).toBe(4);
  });

  it("если поля указывают на разные позиции — строка идёт прямой позиции", async () => {
    const direct = await countEquipment("direct", "Прищепка", 10);
    const viaBooking = await countEquipment("via", "Грузик", 10);
    const booking = await returnedBookingWith(viaBooking.id, 2);
    await prisma.problemItem.create({
      data: {
        equipmentId: direct.id, bookingItemId: booking.items[0].id,
        quantity: 2, reason: "LOST", comment: "расхождение полей", createdBy: "Иван",
      },
    });
    const { getLostCountByEquipmentMap } = await import("../services/availability");
    const both = await getLostCountByEquipmentMap([direct.id, viaBooking.id]);
    expect(both.get(direct.id)).toBe(2);
    expect(both.get(viaBooking.id)).toBeUndefined();
    // Спросили только позицию из брони — чужая строка ей не засчитывается.
    const onlyVia = await getLostCountByEquipmentMap([viaBooking.id]);
    expect(onlyVia.get(viaBooking.id)).toBeUndefined();
  });
});

describe("потеряшки с приёмки пишут equipmentId", () => {
  it("UNIT: createProblemItem берёт позицию с единицы", async () => {
    const eq = await prisma.equipment.create({
      data: {
        importKey: "avail-manual-unit",
        name: "Прожектор HMI",
        category: "Свет",
        totalQuantity: 1,
        rentalRatePerShift: "5000",
        stockTrackingMode: "UNIT",
      },
    });
    const unit = await prisma.equipmentUnit.create({ data: { equipmentId: eq.id, status: "AVAILABLE" } });
    const { createProblemItem } = await import("../services/problemItemService");
    const pi = await createProblemItem({
      equipmentUnitId: unit.id,
      reason: "LOST",
      comment: "не вернули",
      createdBy: "Иван",
    });
    expect(pi.equipmentId).toBe(eq.id);
    expect(pi.source).toBe("RETURN");
  });

  it("COUNT: приёмка в киоске берёт позицию с позиции брони", async () => {
    const eq = await countEquipment("count-return", "Сэндбэг", 10);
    const booking = await prisma.booking.create({
      data: {
        clientId,
        projectName: "Приёмка COUNT",
        status: "ISSUED",
        startDate: daysFromNow(-2),
        endDate: daysFromNow(1),
        items: { create: [{ equipmentId: eq.id, quantity: 3 }] },
      },
      include: { items: true },
    });
    const session = await prisma.scanSession.create({
      data: { bookingId: booking.id, workerName: "Иван", operation: "RETURN", status: "ACTIVE" },
    });
    const { completeSession } = await import("../services/warehouseScan");
    const summary = await completeSession(session.id, {
      createdBy: "Иван",
      problemUnits: [{ bookingItemId: booking.items[0].id, quantity: 1, reason: "LOST", comment: "не вернули" }],
    });
    expect(summary.createdProblemItemIds).toHaveLength(1);
    const pi = await prisma.problemItem.findUnique({ where: { id: summary.createdProblemItemIds[0] } });
    expect(pi).toMatchObject({ equipmentId: eq.id, bookingItemId: booking.items[0].id, quantity: 1, source: "RETURN" });
  });
});
