/**
 * «Часть не вернули» (этап 14b): бронь приняли целиком, а часть осталась у
 * клиента. В течение 7 дней — продолжение от момента приёмки; не больше, чем
 * осталось; штучные — только единицы, которые по учёту на складе; во время
 * инвентаризации — нельзя.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-return-correction.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-rcor";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-return-correction";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-rcor";
process.env.JWT_SECRET = "test-jwt-return-correction-16";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const N = Math.floor(Date.now() / HOUR) * HOUR;

let app: Express;
let prisma: any;
let saToken: string;
let saId: string;
let clientId: string;
let stand: string;
let lens: string;
let seq = 0;

const AUTH = () => ({ "X-API-Key": "test-key-rcor", Authorization: `Bearer ${saToken}` });

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, DATABASE_URL: `file:${TEST_DB_PATH}`, PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes" },
    stdio: "pipe",
  });
  app = (await import("../app")).app;
  prisma = (await import("../prisma")).prisma;
  const { signSession } = await import("../services/auth");
  const sa = await prisma.adminUser.create({ data: { username: "sa-rcor", passwordHash: "x", role: "SUPER_ADMIN" } });
  saId = sa.id;
  saToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });
  clientId = (await prisma.client.create({ data: { name: "Продакшн «Сфера»" } })).id;
  stand = (
    await prisma.equipment.create({
      data: { importKey: "rcor-stand", name: "Стойка C-Stand", category: "Грип", totalQuantity: 20, rentalRatePerShift: 500, stockTrackingMode: "COUNT" },
    })
  ).id;
  lens = (
    await prisma.equipment.create({
      data: { importKey: "rcor-lens", name: "Объектив Cooke", category: "Оптика", totalQuantity: 5, rentalRatePerShift: 2000, stockTrackingMode: "UNIT" },
    })
  ).id;
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    const f = `${TEST_DB_PATH}${suffix}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

/**
 * Выданная бронь на 1 смену (началась 20 ч назад, кончается через 4 ч): стойки
 * ×6 и два объектива Cooke со своими единицами — и сразу принятая целиком
 * обычным «Вернуть».
 */
async function returnedBooking() {
  seq += 1;
  const start = new Date(N - 20 * HOUR);
  const b = await prisma.booking.create({
    data: {
      clientId,
      projectName: `Реклама ${seq}`,
      docNumber: `СМ-RC-${seq}`,
      status: "ISSUED",
      startDate: start,
      endDate: new Date(N + 4 * HOUR),
      issuedAt: start,
      confirmedAt: start,
      discountPercent: 50,
      legacyFinance: false,
      items: { create: [{ equipmentId: stand, quantity: 6 }, { equipmentId: lens, quantity: 2 }] },
    },
    include: { items: true },
  });
  const lensItem = b.items.find((i: any) => i.equipmentId === lens);
  const units = [];
  for (let k = 1; k <= 2; k += 1) {
    const u = await prisma.equipmentUnit.create({ data: { equipmentId: lens, status: "ISSUED", internalInventoryNumber: `RC-${seq}-${k}` } });
    await prisma.bookingItemUnit.create({ data: { bookingItemId: lensItem.id, equipmentUnitId: u.id } });
    units.push(u.id as string);
  }
  const { rebuildBookingEstimate } = await import("../services/bookings");
  await rebuildBookingEstimate(b.id);
  const ret = await request(app).post(`/api/bookings/${b.id}/status`).set(AUTH()).send({ action: "return" });
  expect(ret.status).toBe(200);
  return { b, units, standItem: b.items.find((i: any) => i.equipmentId === stand).id as string, lensItem: lensItem.id as string };
}

const plan = async (id: string) => (await request(app).get(`/api/bookings/${id}/return-correction`).set(AUTH())).body;
const correct = (id: string, body: Record<string, unknown>) =>
  request(app).post(`/api/bookings/${id}/return-correction`).set(AUTH()).send(body);

describe("«Часть не вернули»", () => {
  it("план: срок исправления, потолок по позициям, единицы на складе", async () => {
    const { b, units } = await returnedBooking();
    const p = await plan(b.id);
    expect(p.blockedBy).toBeNull();
    expect(Date.parse(p.correctableUntil) - Date.parse(p.returnedAt)).toBe(7 * DAY);
    expect(p.lines).toEqual([
      expect.objectContaining({ name: "Стойка C-Stand", quantity: 6, unitTracked: false, booked: 6 }),
      expect.objectContaining({ name: "Объектив Cooke", quantity: 2, unitTracked: true, units: expect.arrayContaining([expect.objectContaining({ id: units[0] })]) }),
    ]);
  });

  it("стойки не вернули — продолжение от момента приёмки, сверх оплаченного — дополнительная смета", async () => {
    const { b, standItem } = await returnedBooking();
    const p = await plan(b.id);
    const until = new Date(b.endDate.getTime() + DAY).toISOString();
    const stays = [{ bookingItemId: standItem, quantity: 2, until }];
    const preview = await request(app).post(`/api/bookings/${b.id}/return-correction/preview`).set(AUTH()).send({ stays });
    expect(preview.status).toBe(200);
    // Оплачено до конца брони; ещё сутки — 1 лишняя смена: 2 × 500, скидка 50 %.
    expect(preview.body.continuations[0]).toMatchObject({ total: "500.00", docNumber: `${b.docNumber}-1` });
    expect(await prisma.booking.count({ where: { parentBookingId: b.id } })).toBe(0);

    const res = await correct(b.id, { stays, expectedSplitRevision: p.splitRevision });
    expect(res.status).toBe(200);
    const child = await prisma.booking.findUnique({ where: { id: res.body.continuationIds[0] } });
    expect(child).toMatchObject({ status: "ISSUED", parentBookingId: b.id, docNumber: `${b.docNumber}-1` });
    expect(child.issuedAt.toISOString()).toBe(p.returnedAt);
    expect(Number(child.finalAmount)).toBe(500);
    expect((await prisma.booking.findUnique({ where: { id: b.id } })).status).toBe("RETURNED");
    const audit = await prisma.auditEntry.findFirst({ where: { entityId: b.id, action: "BOOKING_RETURN_CORRECTED" } });
    expect(audit).not.toBeNull();
    // Уже в продолжении — потолок меньше.
    const after = await plan(b.id);
    expect(after.lines.find((l: any) => l.bookingItemId === standItem)).toMatchObject({ quantity: 4, inContinuations: 2 });
  });

  it("штучная позиция: единица снова «Выдана», её резерв — у продолжения", async () => {
    const { b, units, lensItem } = await returnedBooking();
    expect((await prisma.equipmentUnit.findUnique({ where: { id: units[0] } })).status).toBe("AVAILABLE");
    const p = await plan(b.id);
    const res = await correct(b.id, {
      stays: [{ bookingItemId: lensItem, quantity: 1, until: new Date(b.endDate.getTime() + DAY).toISOString(), equipmentUnitIds: [units[0]] }],
      expectedSplitRevision: p.splitRevision,
    });
    expect(res.status).toBe(200);
    expect((await prisma.equipmentUnit.findUnique({ where: { id: units[0] } })).status).toBe("ISSUED");
    expect((await prisma.equipmentUnit.findUnique({ where: { id: units[1] } })).status).toBe("AVAILABLE");
    const live = await prisma.bookingItemUnit.findFirst({ where: { equipmentUnitId: units[0], returnedAt: null }, include: { bookingItem: true } });
    expect(live.bookingItem.bookingId).toBe(res.body.continuationIds[0]);
  });

  it("единицу с тех пор выдали другой брони — отметить её нельзя", async () => {
    const { b, units, lensItem } = await returnedBooking();
    await prisma.equipmentUnit.update({ where: { id: units[1] }, data: { status: "ISSUED" } });
    const p = await plan(b.id);
    const line = p.lines.find((l: any) => l.bookingItemId === lensItem);
    expect(line.units.map((u: any) => u.id)).toEqual([units[0]]);
    expect(line.quantity).toBe(1);
    const res = await correct(b.id, {
      stays: [{ bookingItemId: lensItem, quantity: 1, until: new Date(b.endDate.getTime() + DAY).toISOString(), equipmentUnitIds: [units[1]] }],
      expectedSplitRevision: p.splitRevision,
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("RETURN_CORRECTION_UNIT_NOT_ON_SHELF");
  });

  it("потолок: минус ремонт и «Потеряшки» с этой брони; больше — 400", async () => {
    const { b, standItem } = await returnedBooking();
    await prisma.repair.create({
      data: { bookingItemId: standItem, equipmentId: stand, quantity: 1, status: "WAITING_REPAIR", urgency: "NORMAL", reason: "погнута", sourceBookingId: b.id, createdBy: saId },
    });
    await prisma.problemItem.create({
      data: { bookingItemId: standItem, equipmentId: stand, quantity: 2, sourceBookingId: b.id, reason: "LOST", comment: "нет", status: "SEARCHING", createdBy: saId, source: "RETURN" },
    });
    const p = await plan(b.id);
    expect(p.lines.find((l: any) => l.bookingItemId === standItem)).toMatchObject({ quantity: 3, inRepair: 1, inProblems: 2 });
    const res = await correct(b.id, {
      stays: [{ bookingItemId: standItem, quantity: 4, until: new Date(b.endDate.getTime() + DAY).toISOString() }],
      expectedSplitRevision: p.splitRevision,
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("RETURN_CORRECTION_OVER_CAP");
    expect(await prisma.booking.count({ where: { parentBookingId: b.id } })).toBe(0);
  });

  it("прошло больше 7 дней — нельзя; выданную бронь так не исправить", async () => {
    const { b, standItem } = await returnedBooking();
    await prisma.auditEntry.updateMany({
      where: { entityId: b.id, action: "BOOKING_RETURNED" },
      data: { createdAt: new Date(Date.now() - 8 * DAY) },
    });
    const p = await plan(b.id);
    expect(p.blockedBy).toBe("WINDOW_CLOSED");
    const res = await correct(b.id, {
      stays: [{ bookingItemId: standItem, quantity: 1, until: new Date(N + DAY).toISOString() }],
      expectedSplitRevision: p.splitRevision,
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("RETURN_CORRECTION_WINDOW_CLOSED");

    const issued = await prisma.booking.create({
      data: { clientId, projectName: "Выдана", status: "ISSUED", startDate: new Date(N - HOUR), endDate: new Date(N + DAY), issuedAt: new Date(N - HOUR) },
    });
    expect((await plan(issued.id)).blockedBy).toBe("NOT_RETURNED");
  });

  it("идёт инвентаризация — исправить после её завершения", async () => {
    const { b, standItem } = await returnedBooking();
    const count = await prisma.stockCount.create({ data: { number: 9000 + seq, createdById: saId, createdByName: "sa-rcor" } });
    try {
      const p = await plan(b.id);
      expect(p.blockedBy).toBe("STOCK_COUNT_OPEN");
      const res = await correct(b.id, {
        stays: [{ bookingItemId: standItem, quantity: 1, until: new Date(b.endDate.getTime() + DAY).toISOString() }],
        expectedSplitRevision: p.splitRevision,
      });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("RETURN_CORRECTION_STOCK_COUNT_OPEN");
    } finally {
      await prisma.stockCount.update({ where: { id: count.id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    }
  });

  it("устаревшая ревизия — 409, продолжение одно", async () => {
    const { b, standItem } = await returnedBooking();
    const p = await plan(b.id);
    const body = {
      stays: [{ bookingItemId: standItem, quantity: 1, until: new Date(b.endDate.getTime() + DAY).toISOString() }],
      expectedSplitRevision: p.splitRevision,
    };
    expect((await correct(b.id, body)).status).toBe(200);
    const again = await correct(b.id, body);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("PARTIAL_RETURN_STALE");
    expect(await prisma.booking.count({ where: { parentBookingId: b.id } })).toBe(1);
  });
});
