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
let techToken: string;
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
  const tech = await prisma.adminUser.create({ data: { username: "tech-rcor", passwordHash: "x", role: "TECHNICIAN" } });
  techToken = signSession({ userId: tech.id, username: tech.username, role: "TECHNICIAN" });
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
async function returnedBooking(opts: { standId?: string; start?: number; end?: number } = {}) {
  seq += 1;
  const start = new Date(opts.start ?? N - 20 * HOUR);
  const standId = opts.standId ?? stand;
  const b = await prisma.booking.create({
    data: {
      clientId,
      projectName: `Реклама ${seq}`,
      docNumber: `СМ-RC-${seq}`,
      status: "ISSUED",
      startDate: start,
      endDate: new Date(opts.end ?? N + 4 * HOUR),
      issuedAt: start,
      confirmedAt: start,
      discountPercent: 50,
      legacyFinance: false,
      items: { create: [{ equipmentId: standId, quantity: 6 }, { equipmentId: lens, quantity: 2 }] },
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
  return { b, units, standItem: b.items.find((i: any) => i.equipmentId === standId).id as string, lensItem: lensItem.id as string };
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

/** Своя позиция на 20 шт — чтобы занятость других тестов не мешала счёту. */
async function freshStand() {
  seq += 1;
  return (
    await prisma.equipment.create({
      data: { importKey: `rcor-stand-${seq}`, name: `Стойка ${seq}`, category: "Грип", totalQuantity: 20, rentalRatePerShift: 500, stockTrackingMode: "COUNT" },
    })
  ).id as string;
}
const confirmedHolder = (equipmentId: string, quantity: number, from: number, to: number, projectName = "Клип «Север»") =>
  prisma.booking.create({
    data: {
      clientId,
      projectName,
      status: "CONFIRMED",
      startDate: new Date(from),
      endDate: new Date(to),
      items: { create: [{ equipmentId, quantity }] },
    },
  });
const preview = (id: string, stays: unknown[]) =>
  request(app).post(`/api/bookings/${id}/return-correction/preview`).set(AUTH()).send({ stays });
const shiftBack = (bookingId: string, ms: number) =>
  prisma.auditEntry.updateMany({ where: { entityId: bookingId, action: "BOOKING_RETURNED" }, data: { createdAt: new Date(Date.now() - ms) } });

describe("«Часть не вернули»: держатели — с текущего момента", () => {
  it("сдали раньше срока: позиция нужна другой брони до конца оплаченного — конфликт виден", async () => {
    const eq = await freshStand();
    const { b, standItem } = await returnedBooking({ standId: eq });
    await confirmedHolder(eq, 18, Date.now() + HOUR, N + 3 * HOUR);
    const stays = [{ bookingItemId: standItem, quantity: 3, until: new Date(N + 4 * HOUR).toISOString() }];
    const pv = await preview(b.id, stays);
    expect(pv.status).toBe(200);
    expect(pv.body.conflicts).toEqual([expect.objectContaining({ bookingItemId: standItem, needed: 3, available: 2 })]);
    const p = await plan(b.id);
    const refused = await correct(b.id, { stays, expectedSplitRevision: p.splitRevision });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("CONTINUATION_CONFLICT");
    // Срок дальше оплаченного — тот же держатель внутри оплаченного тоже виден.
    const longer = await preview(b.id, [{ ...stays[0], until: new Date(N + 4 * HOUR + DAY).toISOString() }]);
    expect(longer.body.conflicts).toHaveLength(1);
    const acked = await correct(b.id, { stays: [{ ...stays[0], acknowledgedConflict: true }], expectedSplitRevision: p.splitRevision });
    expect(acked.status).toBe(200);
  });

  it("невыданная бронь в прошлом не считается держателем", async () => {
    const eq = await freshStand();
    const { b, standItem } = await returnedBooking({ standId: eq });
    await confirmedHolder(eq, 20, N - 3 * DAY, N - 2 * DAY, "Давно прошедшая");
    const pv = await preview(b.id, [{ bookingItemId: standItem, quantity: 2, until: new Date(N + DAY).toISOString() }]);
    expect(pv.status).toBe(200);
    expect(pv.body.conflicts).toEqual([]);
  });
});

describe("«Часть не вернули»: единицы", () => {
  it("свободная, но зарезервированная за другой бронью единица — отдельно, с названием брони", async () => {
    const { b, units, lensItem } = await returnedBooking();
    const future = await prisma.booking.create({
      data: { clientId, projectName: "Сериал «Маяк»", status: "CONFIRMED", startDate: new Date(N + 2 * DAY), endDate: new Date(N + 3 * DAY), items: { create: [{ equipmentId: lens, quantity: 1 }] } },
      include: { items: true },
    });
    await prisma.bookingItemUnit.create({ data: { bookingItemId: future.items[0].id, equipmentUnitId: units[1] } });
    const line = (await plan(b.id)).lines.find((l: any) => l.bookingItemId === lensItem);
    expect(line.units.map((u: any) => u.id)).toEqual([units[0]]);
    expect(line.reservedUnits).toEqual([expect.objectContaining({ id: units[1], reservedFor: "Сериал «Маяк»" })]);
    expect(line.quantity).toBe(1);
  });

  it("единица после приёмки побывала в другой брони — у клиента её быть не может", async () => {
    const { b, units, lensItem } = await returnedBooking();
    await shiftBack(b.id, 3 * HOUR);
    const other = await prisma.booking.create({
      data: { clientId, projectName: "Короткая", status: "RETURNED", startDate: new Date(N - 2 * HOUR), endDate: new Date(N - HOUR), items: { create: [{ equipmentId: lens, quantity: 1 }] } },
      include: { items: true },
    });
    await prisma.bookingItemUnit.create({ data: { bookingItemId: other.items[0].id, equipmentUnitId: units[1], returnedAt: new Date(Date.now() - HOUR) } });
    const line = (await plan(b.id)).lines.find((l: any) => l.bookingItemId === lensItem);
    expect(line.units.map((u: any) => u.id)).toEqual([units[0]]);
  });

  it("продолжение исправления отменили — единицу снова можно отметить, журнал называет её", async () => {
    const { b, units, lensItem } = await returnedBooking();
    const until = new Date(b.endDate.getTime() + DAY).toISOString();
    const first = await correct(b.id, {
      stays: [{ bookingItemId: lensItem, quantity: 1, until, equipmentUnitIds: [units[0]] }],
      expectedSplitRevision: (await plan(b.id)).splitRevision,
    });
    expect(first.status).toBe(200);
    const audit = await prisma.auditEntry.findFirst({ where: { entityId: b.id, action: "BOOKING_RETURN_CORRECTED" } });
    const after = typeof audit.after === "string" ? JSON.parse(audit.after) : audit.after;
    expect(after.equipmentUnits).toMatch(new RegExp(`^RC-${seq}-1 \\(принят `));
    const cancel = await request(app)
      .post(`/api/bookings/${first.body.continuationIds[0]}/cancel-continuation`)
      .set(AUTH())
      .send({ reason: "Ошиблись, объектив на полке" });
    expect(cancel.status).toBe(200);
    expect((await prisma.equipmentUnit.findUnique({ where: { id: units[0] } })).status).toBe("AVAILABLE");
    const p = await plan(b.id);
    const line = p.lines.find((l: any) => l.bookingItemId === lensItem);
    expect(line.units.map((u: any) => u.id).sort()).toEqual([...units].sort());
    const again = await correct(b.id, {
      stays: [{ bookingItemId: lensItem, quantity: 1, until, equipmentUnitIds: [units[0]] }],
      expectedSplitRevision: p.splitRevision,
    });
    expect(again.status).toBe(200);
    const live = await prisma.bookingItemUnit.findFirst({ where: { equipmentUnitId: units[0], returnedAt: null }, include: { bookingItem: true } });
    expect(live.bookingItem.bookingId).toBe(again.body.continuationIds[0]);
  });

  it("одна единица дважды — 400, а не «только что выдали»", async () => {
    const { b, units, lensItem } = await returnedBooking();
    const until = new Date(b.endDate.getTime() + DAY).toISOString();
    const res = await correct(b.id, {
      stays: [
        { bookingItemId: lensItem, quantity: 1, until, equipmentUnitIds: [units[0]] },
        { bookingItemId: lensItem, quantity: 1, until: new Date(b.endDate.getTime() + 2 * DAY).toISOString(), equipmentUnitIds: [units[0]] },
      ],
      expectedSplitRevision: (await plan(b.id)).splitRevision,
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("RETURN_CORRECTION_UNIT_NOT_ON_SHELF");
  });
});

describe("«Часть не вернули»: сроки, деньги, доступ", () => {
  it("приняли позже оплаченного — смены от приёмки: «+1» от неё — ровно одна смена", async () => {
    const eq = await freshStand();
    const { b, standItem } = await returnedBooking({ standId: eq, start: N - 50 * HOUR, end: N - 26 * HOUR });
    const p = await plan(b.id);
    const line = p.lines.find((l: any) => l.bookingItemId === standItem);
    expect(line.billingAnchor).toBe(p.returnedAt);
    const res = await correct(b.id, {
      stays: [{ bookingItemId: standItem, quantity: 1, until: new Date(Date.parse(p.returnedAt) + DAY).toISOString() }],
      expectedSplitRevision: p.splitRevision,
    });
    expect(res.status).toBe(200);
    const child = await prisma.booking.findUnique({ where: { id: res.body.continuationIds[0] } });
    // 500 × 1 смена, скидка 50 %.
    expect(Number(child.finalAmount)).toBe(250);
  });

  it("срок «до» между приёмкой и сейчас — 400", async () => {
    const { b, standItem } = await returnedBooking();
    await shiftBack(b.id, 3 * HOUR);
    const res = await correct(b.id, {
      stays: [{ bookingItemId: standItem, quantity: 1, until: new Date(Date.now() - HOUR).toISOString() }],
      expectedSplitRevision: (await plan(b.id)).splitRevision,
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("PARTIAL_RETURN_BAD_STAY");
  });

  it("без записи о приёмке — нельзя; выданную бронь — понятный отказ, а не «изменили»", async () => {
    const { b } = await returnedBooking();
    await prisma.auditEntry.deleteMany({ where: { entityId: b.id, action: "BOOKING_RETURNED" } });
    expect((await plan(b.id)).blockedBy).toBe("NO_RETURN_RECORD");
    const issued = await prisma.booking.create({
      data: { clientId, projectName: "Выдана", status: "ISSUED", startDate: new Date(N - HOUR), endDate: new Date(N + DAY), issuedAt: new Date(N - HOUR), items: { create: [{ equipmentId: stand, quantity: 1 }] } },
      include: { items: true },
    });
    const res = await correct(issued.id, {
      stays: [{ bookingItemId: issued.items[0].id, quantity: 1, until: new Date(N + 2 * DAY).toISOString() }],
      expectedSplitRevision: 0,
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("RETURN_CORRECTION_NOT_RETURNED");
  });

  it("технику — нельзя", async () => {
    const { b } = await returnedBooking();
    const res = await request(app)
      .get(`/api/bookings/${b.id}/return-correction`)
      .set({ "X-API-Key": "test-key-rcor", Authorization: `Bearer ${techToken}` });
    expect(res.status).toBe(403);
  });
});
