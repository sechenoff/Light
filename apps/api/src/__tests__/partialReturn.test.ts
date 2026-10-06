/**
 * «Принять часть — остальное у клиента» (этап 10, в пределах оплаченного).
 *
 * Основная бронь принимается, оставленное переходит в бронь-продолжение со
 * своим номером и сметой 0 ₽. Позиции «по плану у клиента» (своё число смен
 * дольше брони) обычным «Вернуть» без подтверждения не сдаются.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-partial-return.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-prt";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-partial-return";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-prt";
process.env.JWT_SECRET = "test-jwt-partial-return-16chars";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const N = Math.floor(Date.now() / HOUR) * HOUR;

let app: Express;
let prisma: any;
let saToken: string;
let clientId: string;
let storm: string;
let stand: string;
let seq = 0;

const AUTH = () => ({ "X-API-Key": "test-key-prt", Authorization: `Bearer ${saToken}` });

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, DATABASE_URL: `file:${TEST_DB_PATH}`, PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes" },
    stdio: "pipe",
  });
  app = (await import("../app")).app;
  prisma = (await import("../prisma")).prisma;
  const { signSession } = await import("../services/auth");
  const sa = await prisma.adminUser.create({ data: { username: "sa-prt", passwordHash: "x", role: "SUPER_ADMIN" } });
  saToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });
  clientId = (await prisma.client.create({ data: { name: "Продакшн «Сфера»" } })).id;
  const mk = (key: string, name: string, rate: number, mode = "COUNT", qty = 20) =>
    prisma.equipment.create({ data: { importKey: key, name, category: "Свет", totalQuantity: qty, rentalRatePerShift: rate, stockTrackingMode: mode } });
  storm = (await mk("prt-storm", "Aputure STORM 400x", 1000)).id;
  stand = (await mk("prt-stand", "Стойка C-Stand", 500)).id;
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    const f = `${TEST_DB_PATH}${suffix}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

/**
 * Выданная бронь на 1 смену: началась 20 ч назад, кончается через 4 ч. STORM ×2
 * взят на 2 смены (по плану у клиента ещё сутки после конца брони), стойки ×6 —
 * как бронь. Смета MAIN собрана общим путём.
 */
async function issuedBooking(
  opts: { stormShifts?: number | null; start?: number; end?: number; stormId?: string; standId?: string } = {},
) {
  seq += 1;
  const stormId = opts.stormId ?? storm;
  const standId = opts.standId ?? stand;
  const start = new Date(opts.start ?? N - 20 * HOUR);
  const end = new Date(opts.end ?? N + 4 * HOUR);
  const b = await prisma.booking.create({
    data: {
      clientId,
      projectName: `Реклама ${seq}`,
      docNumber: `СМ-PRT-${seq}`,
      status: "ISSUED",
      startDate: start,
      endDate: end,
      issuedAt: start,
      confirmedAt: start,
      discountPercent: 50,
      legacyFinance: false,
      items: {
        create: [
          { equipmentId: stormId, quantity: 2, shifts: opts.stormShifts === undefined ? 2 : opts.stormShifts },
          { equipmentId: standId, quantity: 6 },
        ],
      },
    },
    include: { items: true },
  });
  const { rebuildBookingEstimate } = await import("../services/bookings");
  await rebuildBookingEstimate(b.id);
  return b;
}

const itemOf = (b: any, equipmentId: string) => b.items.find((i: any) => i.equipmentId === equipmentId);
const plan = async (id: string) => (await request(app).get(`/api/bookings/${id}/return-plan`).set(AUTH())).body;

describe("план приёмки", () => {
  it("позиция «по плану у клиента» отмечена, оплачено — до её срока", async () => {
    const b = await issuedBooking();
    const p = await plan(b.id);
    const line = p.lines.find((l: any) => l.equipmentId === storm);
    const due = new Date(b.endDate.getTime() + DAY).toISOString();
    expect(line.plannedStayUntil).toBe(due);
    expect(line.paidThrough).toBe(due);
    expect(p.lines.find((l: any) => l.equipmentId === stand).plannedStayUntil).toBeNull();
    expect(p.hasPlannedStays).toBe(true);
  });
});

describe("обычное «Вернуть»", () => {
  it("с позицией «по плану» — просит подтвердить, что вернули всё", async () => {
    const b = await issuedBooking();
    const refused = await request(app).post(`/api/bookings/${b.id}/status`).set(AUTH()).send({ action: "return" });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("PLANNED_STAY_PENDING");
    const ok = await request(app).post(`/api/bookings/${b.id}/status`).set(AUTH()).send({ action: "return", allReturned: true });
    expect(ok.status).toBe(200);
    expect(ok.body.booking.status).toBe("RETURNED");
  });

  it("без длинных позиций — одной кнопкой, как раньше", async () => {
    const b = await issuedBooking({ stormShifts: null });
    const ok = await request(app).post(`/api/bookings/${b.id}/status`).set(AUTH()).send({ action: "return" });
    expect(ok.status).toBe(200);
  });
});

describe("принять часть — остальное у клиента", () => {
  it("основная возвращена, оставленное — в продолжении за 0 ₽ со своим номером", async () => {
    // Свои позиции: другие тесты оставляют выданные брони на общих.
    const mk = (key: string, name: string, rate: number) =>
      prisma.equipment.create({ data: { importKey: `${key}-${++seq}`, name, category: "Свет", totalQuantity: 20, rentalRatePerShift: rate, stockTrackingMode: "COUNT" } });
    const storm = (await mk("prt-own-storm", "Aputure STORM 400x", 1000)).id;
    const stand = (await mk("prt-own-stand", "Стойка C-Stand", 500)).id;
    const b = await issuedBooking({ stormId: storm, standId: stand });
    const p = await plan(b.id);
    const due = p.lines.find((l: any) => l.equipmentId === storm).plannedStayUntil;
    const res = await request(app)
      .post(`/api/bookings/${b.id}/return-partial`)
      .set(AUTH())
      .send({ stays: [{ bookingItemId: itemOf(b, storm).id, quantity: 2, until: due }], expectedSplitRevision: p.splitRevision });
    expect(res.status).toBe(200);
    expect(res.body.booking.status).toBe("RETURNED");
    const [childId] = res.body.continuationIds;
    const child = await prisma.booking.findUnique({ where: { id: childId }, include: { items: true, estimates: { include: { lines: true } } } });
    expect(child.status).toBe("ISSUED");
    expect(child.docNumber).toBe(`${b.docNumber}-1`);
    expect(child.parentBookingId).toBe(b.id);
    expect(child.rootBookingId).toBe(b.id);
    expect(child.endDate.toISOString()).toBe(due);
    expect(child.items).toHaveLength(1);
    expect(child.items[0]).toMatchObject({ equipmentId: storm, quantity: 2, coveredShifts: 2 });
    const main = child.estimates.find((e: any) => e.kind === "MAIN");
    expect(main.lines[0].shifts).toBe(0);
    expect(Number(child.finalAmount)).toBe(0);
    // Оставленное держит склад продолжением, принятое — свободно.
    const { getAvailability } = await import("../services/availability");
    const [a] = await getAvailability({ startDate: new Date(N + 6 * HOUR), endDate: new Date(N + 7 * HOUR), equipmentIds: [storm] });
    expect(a.occupiedQuantity).toBe(2);
    const [st] = await getAvailability({ startDate: new Date(N + HOUR), endDate: new Date(N + 2 * HOUR), equipmentIds: [stand] });
    expect(st.occupiedQuantity).toBe(0);
    // Журнал: приёмка основной и создание продолжения.
    const audits = await prisma.auditEntry.findMany({ where: { entityId: { in: [b.id, childId] } } });
    const returned = audits.find((a: any) => a.action === "BOOKING_RETURNED");
    const after = typeof returned.after === "string" ? JSON.parse(returned.after) : returned.after;
    expect(after).toMatchObject({ via: "status:return-partial", continuationIds: childId });
    expect(audits.some((a: any) => a.action === "BOOKING_CONTINUATION_CREATED" && a.entityId === childId)).toBe(true);
    // Потеряшек не заводится.
    expect(await prisma.problemItem.count({ where: { sourceBookingId: b.id } })).toBe(0);
  });

  it("дольше оплаченного — пока отказ (дополнительная смета — позже)", async () => {
    const b = await issuedBooking();
    const p = await plan(b.id);
    const res = await request(app)
      .post(`/api/bookings/${b.id}/return-partial`)
      .set(AUTH())
      .send({
        stays: [{ bookingItemId: itemOf(b, stand).id, quantity: 1, until: new Date(b.endDate.getTime() + DAY).toISOString() }],
        expectedSplitRevision: p.splitRevision,
      });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CONTINUATION_BEYOND_PAID_NOT_YET");
    expect((await prisma.booking.findUnique({ where: { id: b.id } })).status).toBe("ISSUED");
  });

  it("основную сдали раньше срока, часть оставили до конца брони — продолжение с текущего момента", async () => {
    const b = await issuedBooking({ stormShifts: null, start: N - 4 * HOUR, end: N + 20 * HOUR });
    const p = await plan(b.id);
    const before = Date.now();
    const res = await request(app)
      .post(`/api/bookings/${b.id}/return-partial`)
      .set(AUTH())
      .send({ stays: [{ bookingItemId: itemOf(b, stand).id, quantity: 2, until: b.endDate.toISOString() }], expectedSplitRevision: p.splitRevision });
    expect(res.status).toBe(200);
    const child = await prisma.booking.findUnique({ where: { id: res.body.continuationIds[0] } });
    expect(child.startDate.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(Number(child.finalAmount)).toBe(0);
  });

  it("двойное нажатие — второй запрос получает 409, продолжение одно", async () => {
    const b = await issuedBooking();
    const p = await plan(b.id);
    const body = { stays: [{ bookingItemId: itemOf(b, storm).id, quantity: 1, until: p.lines.find((l: any) => l.equipmentId === storm).plannedStayUntil }], expectedSplitRevision: p.splitRevision };
    const first = await request(app).post(`/api/bookings/${b.id}/return-partial`).set(AUTH()).send(body);
    const second = await request(app).post(`/api/bookings/${b.id}/return-partial`).set(AUTH()).send(body);
    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(await prisma.booking.count({ where: { parentBookingId: b.id } })).toBe(1);
  });

  it("продолжение само принимается частично — следующее продолжение «-2»", async () => {
    const b = await issuedBooking({ stormShifts: 3 });
    const p = await plan(b.id);
    const due = p.lines.find((l: any) => l.equipmentId === storm).plannedStayUntil;
    const first = await request(app)
      .post(`/api/bookings/${b.id}/return-partial`)
      .set(AUTH())
      .send({ stays: [{ bookingItemId: itemOf(b, storm).id, quantity: 2, until: due }], expectedSplitRevision: p.splitRevision });
    const childId = first.body.continuationIds[0];
    const childPlan = await plan(childId);
    const childItem = childPlan.lines[0];
    const second = await request(app)
      .post(`/api/bookings/${childId}/return-partial`)
      .set(AUTH())
      .send({ stays: [{ bookingItemId: childItem.bookingItemId, quantity: 1, until: due }], expectedSplitRevision: childPlan.splitRevision });
    expect(second.status).toBe(200);
    const grand = await prisma.booking.findUnique({ where: { id: second.body.continuationIds[0] } });
    expect(grand.docNumber).toBe(`${b.docNumber}-2`);
    expect(grand.rootBookingId).toBe(b.id);
    expect(grand.parentBookingId).toBe(childId);
    expect(Number(grand.finalAmount)).toBe(0);
  });
});

describe("проверки оставленного", () => {
  it("два срока «до» в одной приёмке — два продолжения «-1» и «-2»", async () => {
    const b = await issuedBooking({ stormShifts: 3 });
    const p = await plan(b.id);
    const storm3 = p.lines.find((l: any) => l.equipmentId === storm);
    const end = b.endDate.toISOString();
    const res = await request(app)
      .post(`/api/bookings/${b.id}/return-partial`)
      .set(AUTH())
      .send({
        stays: [
          { bookingItemId: storm3.bookingItemId, quantity: 2, until: storm3.plannedStayUntil },
          { bookingItemId: itemOf(b, stand).id, quantity: 1, until: end },
        ],
        expectedSplitRevision: p.splitRevision,
      });
    expect(res.status).toBe(200);
    const children = await prisma.booking.findMany({ where: { parentBookingId: b.id }, orderBy: { endDate: "asc" } });
    expect(children.map((c: any) => c.docNumber)).toEqual([`${b.docNumber}-1`, `${b.docNumber}-2`]);
  });

  it("больше, чем в позиции, и срок в прошлом — 400, бронь не тронута", async () => {
    const b = await issuedBooking({ stormShifts: null, start: N - 4 * HOUR, end: N + 20 * HOUR });
    const p = await plan(b.id);
    const tooMany = await request(app)
      .post(`/api/bookings/${b.id}/return-partial`)
      .set(AUTH())
      .send({ stays: [{ bookingItemId: itemOf(b, stand).id, quantity: 7, until: b.endDate.toISOString() }], expectedSplitRevision: p.splitRevision });
    expect(tooMany.status).toBe(400);
    const past = await request(app)
      .post(`/api/bookings/${b.id}/return-partial`)
      .set(AUTH())
      .send({ stays: [{ bookingItemId: itemOf(b, stand).id, quantity: 1, until: new Date(N - HOUR).toISOString() }], expectedSplitRevision: p.splitRevision });
    expect(past.status).toBe(400);
    expect((await prisma.booking.findUnique({ where: { id: b.id } })).status).toBe("ISSUED");
  });

  it("своя позиция остаётся у клиента — 0 ₽ в продолжении", async () => {
    seq += 1;
    const b = await prisma.booking.create({
      data: {
        clientId, projectName: `Своя ${seq}`, docNumber: `СМ-PRT-${seq}`, status: "ISSUED", startDate: new Date(N - 4 * HOUR), endDate: new Date(N + 20 * HOUR), issuedAt: new Date(N - 4 * HOUR),
        items: { create: [{ customName: "Расходники", customUnitPrice: 1500, customCategory: "Произвольная позиция", quantity: 1 }] },
      },
      include: { items: true },
    });
    const { rebuildBookingEstimate } = await import("../services/bookings");
    await rebuildBookingEstimate(b.id);
    const p = await plan(b.id);
    const res = await request(app)
      .post(`/api/bookings/${b.id}/return-partial`)
      .set(AUTH())
      .send({ stays: [{ bookingItemId: b.items[0].id, quantity: 1, until: b.endDate.toISOString() }], expectedSplitRevision: p.splitRevision });
    expect(res.status).toBe(200);
    const child = await prisma.booking.findUnique({ where: { id: res.body.continuationIds[0] } });
    expect(Number(child.finalAmount)).toBe(0);
  });
});

describe("семья после частичной приёмки", () => {
  it("клиента не сменить у одной брони семьи", async () => {
    const b = await issuedBooking();
    const p = await plan(b.id);
    const res = await request(app)
      .post(`/api/bookings/${b.id}/return-partial`)
      .set(AUTH())
      .send({ stays: [{ bookingItemId: itemOf(b, storm).id, quantity: 1, until: p.lines.find((l: any) => l.equipmentId === storm).plannedStayUntil }], expectedSplitRevision: p.splitRevision });
    const other = await prisma.client.create({ data: { name: "Другой клиент" } });
    for (const id of [b.id, res.body.continuationIds[0]]) {
      const change = await request(app).post(`/api/bookings/${id}/change-client`).set(AUTH()).send({ clientId: other.id });
      expect(change.status).toBe(409);
      expect(change.body.code).toBe("HAS_CONTINUATION");
    }
  });

  it("групповой архив законченной семьи — продолжения уходят первыми", async () => {
    const b = await issuedBooking();
    const p = await plan(b.id);
    const res = await request(app)
      .post(`/api/bookings/${b.id}/return-partial`)
      .set(AUTH())
      .send({ stays: [{ bookingItemId: itemOf(b, storm).id, quantity: 1, until: p.lines.find((l: any) => l.equipmentId === storm).plannedStayUntil }], expectedSplitRevision: p.splitRevision });
    const childId = res.body.continuationIds[0];
    await request(app).post(`/api/bookings/${childId}/status`).set(AUTH()).send({ action: "return", allReturned: true });
    const bulk = await request(app).post("/api/bookings/bulk").set(AUTH()).send({ action: "archive", ids: [b.id, childId] });
    expect(bulk.status).toBe(200);
    expect(bulk.body.counts.failed).toBe(0);
    expect(bulk.body.results.map((r: any) => r.id)).toEqual([b.id, childId]);
  });
});

describe("штучный учёт", () => {
  it("оставленная единица переходит к продолжению и остаётся «Выдана», остальные — на полку", async () => {
    const lens = await prisma.equipment.create({
      data: { importKey: `prt-lens-${++seq}`, name: "Объектив Zeiss", category: "Оптика", totalQuantity: 2, rentalRatePerShift: 2000, stockTrackingMode: "UNIT" },
    });
    const units = [];
    for (let i = 0; i < 2; i++) {
      units.push(await prisma.equipmentUnit.create({ data: { equipmentId: lens.id, status: "ISSUED", internalInventoryNumber: `ZEISS-${seq}-${i}` } }));
    }
    const b = await prisma.booking.create({
      data: {
        clientId, projectName: "Оптика", status: "ISSUED", startDate: new Date(N - 4 * HOUR), endDate: new Date(N + 20 * HOUR), issuedAt: new Date(N - 4 * HOUR),
        items: { create: [{ equipmentId: lens.id, quantity: 2 }] },
      },
      include: { items: true },
    });
    for (const u of units) await prisma.bookingItemUnit.create({ data: { bookingItemId: b.items[0].id, equipmentUnitId: u.id } });
    const { rebuildBookingEstimate } = await import("../services/bookings");
    await rebuildBookingEstimate(b.id);
    const p = await plan(b.id);
    expect(p.lines[0].units.map((u: any) => u.label).sort()).toEqual([`ZEISS-${seq}-0`, `ZEISS-${seq}-1`]);
    const noUnits = await request(app)
      .post(`/api/bookings/${b.id}/return-partial`)
      .set(AUTH())
      .send({ stays: [{ bookingItemId: b.items[0].id, quantity: 1, until: b.endDate.toISOString() }], expectedSplitRevision: p.splitRevision });
    expect(noUnits.status).toBe(400);
    expect(noUnits.body.code).toBe("PARTIAL_RETURN_UNITS_REQUIRED");
    const dup = await request(app)
      .post(`/api/bookings/${b.id}/return-partial`)
      .set(AUTH())
      .send({ stays: [{ bookingItemId: b.items[0].id, quantity: 2, until: b.endDate.toISOString(), equipmentUnitIds: [units[0].id, units[0].id] }], expectedSplitRevision: p.splitRevision });
    expect(dup.status).toBe(400);
    const res = await request(app)
      .post(`/api/bookings/${b.id}/return-partial`)
      .set(AUTH())
      .send({ stays: [{ bookingItemId: b.items[0].id, quantity: 1, until: b.endDate.toISOString(), equipmentUnitIds: [units[1].id] }], expectedSplitRevision: p.splitRevision });
    expect(res.status).toBe(200);
    expect((await prisma.equipmentUnit.findUnique({ where: { id: units[1].id } })).status).toBe("ISSUED");
    expect((await prisma.equipmentUnit.findUnique({ where: { id: units[0].id } })).status).toBe("AVAILABLE");
    const childItem = await prisma.bookingItem.findFirst({ where: { bookingId: res.body.continuationIds[0] } });
    const live = await prisma.bookingItemUnit.findMany({ where: { equipmentUnitId: units[1].id, returnedAt: null } });
    expect(live).toHaveLength(1);
    expect(live[0].bookingItemId).toBe(childItem.id);
  });
});

describe("киоск", () => {
  it("приёмка брони с позицией «по плану» в киоске — на карточку", async () => {
    const b = await issuedBooking();
    const session = await prisma.scanSession.create({ data: { bookingId: b.id, workerName: "Иван", operation: "RETURN", status: "ACTIVE" } });
    const { completeSession } = await import("../services/warehouseScan");
    await expect(completeSession(session.id)).rejects.toMatchObject({ status: 409, code: "PLANNED_STAY_ON_CARD" });
  });

  const returnSession = (bookingId: string) =>
    prisma.scanSession.create({ data: { bookingId, workerName: "Иван", operation: "RETURN", status: "ACTIVE" } });

  it("чек-лист приёмки знает позиции «по плану»: срок, количество, ревизия разделения", async () => {
    const b = await issuedBooking();
    const session = await returnSession(b.id);
    const { getChecklistState } = await import("../services/checklistService");
    const state = await getChecklistState(session.id);
    expect(state.plannedStays).toEqual([
      { bookingItemId: itemOf(b, storm).id, until: new Date(b.endDate.getTime() + DAY).toISOString(), quantity: 2, unitIds: [] },
    ]);
    expect(state.splitRevision).toBe(0);
  });

  it("«Готово» с позицией «по плану» — основная возвращена, позиция ушла в продолжение за 0 ₽", async () => {
    const b = await issuedBooking();
    const session = await returnSession(b.id);
    const { completeSession } = await import("../services/warehouseScan");
    const until = new Date(b.endDate.getTime() + DAY).toISOString();
    const summary = await completeSession(session.id, {
      stays: [{ bookingItemId: itemOf(b, storm).id, quantity: 2, until }],
      expectedSplitRevision: 0,
    });
    expect(summary.continuationIds).toHaveLength(1);
    expect((await prisma.booking.findUnique({ where: { id: b.id } })).status).toBe("RETURNED");
    const child = await prisma.booking.findUnique({ where: { id: summary.continuationIds[0] }, include: { items: true } });
    expect(child).toMatchObject({ status: "ISSUED", parentBookingId: b.id, docNumber: `${b.docNumber}-1` });
    expect(child.endDate.toISOString()).toBe(until);
    expect(child.items).toEqual([expect.objectContaining({ equipmentId: storm, quantity: 2 })]);
    expect(Number(child.finalAmount)).toBe(0);
    // Журнал приёмки называет продолжение.
    const audit = await prisma.auditEntry.findFirst({ where: { entityId: b.id, action: "BOOKING_RETURNED" }, orderBy: { createdAt: "desc" } });
    const after = typeof audit.after === "string" ? JSON.parse(audit.after) : audit.after;
    expect(after).toMatchObject({ via: "kiosk", continuationIds: child.id });
  });

  it("«Вернули сейчас» — пустой список: всё принято, продолжения нет", async () => {
    const b = await issuedBooking();
    const session = await returnSession(b.id);
    const { completeSession } = await import("../services/warehouseScan");
    const summary = await completeSession(session.id, { stays: [] });
    expect(summary.continuationIds).toEqual([]);
    expect((await prisma.booking.findUnique({ where: { id: b.id } })).status).toBe("RETURNED");
    expect(await prisma.booking.count({ where: { parentBookingId: b.id } })).toBe(0);
  });

  it("дольше оплаченного — отказ, приёмка не записана, сессия жива", async () => {
    const b = await issuedBooking();
    const session = await returnSession(b.id);
    const { completeSession } = await import("../services/warehouseScan");
    const tooLate = new Date(b.endDate.getTime() + 3 * DAY).toISOString();
    await expect(
      completeSession(session.id, { stays: [{ bookingItemId: itemOf(b, storm).id, quantity: 2, until: tooLate }], expectedSplitRevision: 0 }),
    ).rejects.toMatchObject({ status: 409, code: "CONTINUATION_BEYOND_PAID_NOT_YET" });
    expect((await prisma.booking.findUnique({ where: { id: b.id } })).status).toBe("ISSUED");
    expect((await prisma.scanSession.findUnique({ where: { id: session.id } })).status).toBe("ACTIVE");
  });

  it("бронь уже разделили с карточки — устаревший экран киоска получает 409", async () => {
    const b = await issuedBooking();
    const session = await returnSession(b.id);
    await prisma.booking.update({ where: { id: b.id }, data: { splitRevision: 1 } });
    const { completeSession } = await import("../services/warehouseScan");
    const until = new Date(b.endDate.getTime() + DAY).toISOString();
    await expect(
      completeSession(session.id, { stays: [{ bookingItemId: itemOf(b, storm).id, quantity: 2, until }], expectedSplitRevision: 0 }),
    ).rejects.toMatchObject({ status: 409, code: "PARTIAL_RETURN_STALE" });
  });

  it("ремонт, проблема и «остаётся» вместе не больше количества строки", async () => {
    const b = await issuedBooking();
    const session = await returnSession(b.id);
    const { completeSession } = await import("../services/warehouseScan");
    const until = new Date(b.endDate.getTime() + DAY).toISOString();
    await expect(
      completeSession(session.id, {
        stays: [{ bookingItemId: itemOf(b, storm).id, quantity: 2, until }],
        repairUnits: [{ bookingItemId: itemOf(b, storm).id, quantity: 1, reason: "Не включается" } as never],
        expectedSplitRevision: 0,
      }),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_SPLIT" });
  });

  it("штучная позиция «по плану»: резерв к продолжению, единица не становится «не найдено»", async () => {
    const lens = await prisma.equipment.create({
      data: { importKey: `prt-klens-${++seq}`, name: "Объектив Cooke", category: "Оптика", totalQuantity: 2, rentalRatePerShift: 2000, stockTrackingMode: "UNIT" },
    });
    const units = [];
    for (let i = 0; i < 2; i++) {
      units.push(await prisma.equipmentUnit.create({ data: { equipmentId: lens.id, status: "ISSUED", internalInventoryNumber: `COOKE-${seq}-${i}` } }));
    }
    const b = await issuedBooking();
    const lensItem = await prisma.bookingItem.create({ data: { bookingId: b.id, equipmentId: lens.id, quantity: 2, shifts: 2 } });
    for (const u of units) await prisma.bookingItemUnit.create({ data: { bookingItemId: lensItem.id, equipmentUnitId: u.id } });
    const { rebuildBookingEstimate } = await import("../services/bookings");
    await rebuildBookingEstimate(b.id);
    const session = await returnSession(b.id);
    const { getChecklistState } = await import("../services/checklistService");
    const planned = (await getChecklistState(session.id)).plannedStays.find((p) => p.bookingItemId === lensItem.id)!;
    expect(planned.unitIds.sort()).toEqual(units.map((u) => u.id).sort());
    const { completeSession } = await import("../services/warehouseScan");
    const summary = await completeSession(session.id, {
      stays: [
        { bookingItemId: itemOf(b, storm).id, quantity: 2, until: planned.until },
        { bookingItemId: lensItem.id, quantity: 2, until: planned.until, equipmentUnitIds: planned.unitIds },
      ],
      expectedSplitRevision: 0,
    });
    expect(summary.missing).toEqual([]);
    for (const u of units) expect((await prisma.equipmentUnit.findUnique({ where: { id: u.id } })).status).toBe("ISSUED");
    const childLens = await prisma.bookingItem.findFirst({ where: { bookingId: summary.continuationIds[0], equipmentId: lens.id } });
    expect(await prisma.bookingItemUnit.count({ where: { bookingItemId: childLens.id, returnedAt: null } })).toBe(2);
  });
});
