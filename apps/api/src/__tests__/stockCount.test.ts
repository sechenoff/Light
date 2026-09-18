/**
 * Инвентаризация склада — жизненный цикл через HTTP (/api/stock-counts).
 *
 * Сценарий идёт сверху вниз на одной базе: открытая инвентаризация на систему
 * одна, поэтому тесты — последовательные шаги одной истории:
 *   права → охват и отмена → полный старт → формула «на полке должно быть» →
 *   снапшот при счёте → решения и их валидации → завершение и все его эффекты.
 *
 * Даты — только от Date.now(): зашитые календарные даты протухают.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-stock-count.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-stock-count";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-stock-count";
process.env.WAREHOUSE_SECRET = "test-warehouse-stock-count";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-secret-stock-count-min16chars";

const DAY = 24 * 60 * 60 * 1000;
const daysFromNow = (d: number) => new Date(Date.now() + d * DAY);

let app: Express;
let prisma: any;

let saToken: string;
let whToken: string;
let techToken: string;
let collectorToken: string;
let saId: string;

const eq: Record<string, string> = {};
let returnedBookingId: string;

const apiKey = { "X-API-Key": "test-key-stock-count" };
const auth = (token: string) => ({ ...apiKey, Authorization: `Bearer ${token}` });

async function createEquipment(
  key: string,
  name: string,
  category: string,
  totalQuantity: number,
  extra: Record<string, unknown> = {},
) {
  const row = await prisma.equipment.create({
    data: {
      importKey: `sc-${key}`,
      name,
      category,
      totalQuantity,
      rentalRatePerShift: "500",
      stockTrackingMode: "COUNT",
      ...extra,
    },
  });
  eq[key] = row.id;
  return row;
}

async function createBooking(
  clientId: string,
  projectName: string,
  status: string,
  startDays: number,
  endDays: number,
  items: Array<[string, number]>,
  extra: Record<string, unknown> = {},
) {
  return prisma.booking.create({
    data: {
      clientId,
      projectName,
      status,
      startDate: daysFromNow(startDays),
      endDate: daysFromNow(endDays),
      items: { create: items.map(([equipmentId, quantity]) => ({ equipmentId, quantity })) },
      ...extra,
    },
    include: { items: true },
  });
}

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
  const hash = await hashPassword("stock-count-pass");
  const sa = await prisma.adminUser.create({ data: { username: "sc_super", passwordHash: hash, role: "SUPER_ADMIN" } });
  const wh = await prisma.adminUser.create({ data: { username: "sc_warehouse", passwordHash: hash, role: "WAREHOUSE" } });
  const tech = await prisma.adminUser.create({ data: { username: "sc_tech", passwordHash: hash, role: "TECHNICIAN" } });
  const col = await prisma.adminUser.create({ data: { username: "sc_collector", passwordHash: hash, role: "COLLECTOR" } });
  saId = sa.id;
  saToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });
  whToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });
  techToken = signSession({ userId: tech.id, username: tech.username, role: "TECHNICIAN" });
  collectorToken = signSession({ userId: col.id, username: col.username, role: "COLLECTOR" });

  // Порядок категорий каталога: Свет → Грип → Транспорт.
  await prisma.appSetting.create({
    data: { key: "equipment_category_order", value: JSON.stringify(["Свет", "Грип", "Транспорт"]) },
  });

  await createEquipment("A", "Кабель 25 м", "Свет", 10, { sortOrder: 1 });
  await createEquipment("B", "Стойка C-stand", "Свет", 5, { sortOrder: 2 });
  await createEquipment("H", "Стойка низкая", "Свет", 3, { sortOrder: 3 });
  await createEquipment("G", "Удлинитель", "Свет", 8, { sortOrder: 4 });
  await createEquipment("U", "Прожектор HMI", "Свет", 2, { stockTrackingMode: "UNIT" });
  await createEquipment("C", "Флаг 18×24", "Грип", 4, { sortOrder: 1 });
  await createEquipment("D", "Прищепка", "Грип", 20, { sortOrder: 2 });
  await createEquipment("Z", "Грузик", "Грип", 2, { sortOrder: 3 });
  await createEquipment("E", "Рамка 12×12", "Грип", 6, { sortOrder: 4 });
  await createEquipment("F", "Сэндбэг", "Грип", 3, { sortOrder: 5 });
  await createEquipment("T", "Газель", "Транспорт", 1);

  const client = await prisma.client.create({ data: { name: "Клиент Инвентаризации" } });
  const calClient = await prisma.client.create({ data: { name: "Клиент Календарь" } });

  // ── Формула для «Кабель 25 м» (total 10) ───────────────────────────────────
  // Считаются: ISSUED (даже просроченная) 3, CONFIRMED на сегодня 2, ремонт 1, потеряшка 1.
  await createBooking(client.id, "Просроченная выдача", "ISSUED", -10, -5, [[eq.A, 3]]);
  await createBooking(calClient.id, "Съёмка «Календарь»", "CONFIRMED", -1, 1, [[eq.A, 2]]);
  // Не считаются: будущая CONFIRMED, архивная ISSUED, черновик, на согласовании.
  await createBooking(client.id, "Будущая", "CONFIRMED", 3, 5, [[eq.A, 4]]);
  await createBooking(client.id, "Архивная выдача", "ISSUED", -3, 3, [[eq.A, 5]], { deletedAt: new Date() });
  await createBooking(client.id, "Черновик", "DRAFT", -1, 1, [[eq.A, 1]]);
  await createBooking(client.id, "На согласовании", "PENDING_APPROVAL", -1, 1, [[eq.A, 1]]);
  await prisma.repair.create({ data: { equipmentId: eq.A, quantity: 1, reason: "перебит", createdBy: saId } });
  await prisma.repair.create({
    data: { equipmentId: eq.A, quantity: 2, reason: "починен", status: "CLOSED", createdBy: saId },
  });
  await prisma.problemItem.create({
    data: { equipmentId: eq.A, quantity: 1, reason: "LOST", comment: "вручную", source: "MANUAL", createdBy: "sc_super" },
  });
  await prisma.problemItem.create({
    data: { equipmentId: eq.A, quantity: 4, reason: "LOST", comment: "нашли", status: "FOUND", createdBy: "sc_super" },
  });

  // ── «Рамка 12×12» (total 6): две открытые потеряшки с приёмки, 2 шт. и 3 шт. ─
  const older = await createBooking(client.id, "Рамки, первая", "RETURNED", -20, -18, [[eq.E, 2]]);
  const newer = await createBooking(client.id, "Рамки, вторая", "RETURNED", -10, -8, [[eq.E, 3]]);
  await prisma.problemItem.create({
    data: {
      bookingItemId: older.items[0].id, sourceBookingId: older.id, quantity: 2, reason: "LOST",
      comment: "не вернули", createdBy: "Иван", createdAt: daysFromNow(-18),
    },
  });
  await prisma.problemItem.create({
    data: {
      bookingItemId: newer.items[0].id, sourceBookingId: newer.id, quantity: 3, reason: "LEFT_ON_SITE",
      status: "EXPECTED", comment: "остались на площадке", createdBy: "Иван", createdAt: daysFromNow(-8),
    },
  });

  // ── «Сэндбэг» (total 3): одна открытая потеряшка на 1 шт. ───────────────────
  await prisma.problemItem.create({
    data: { equipmentId: eq.F, quantity: 1, reason: "LOST", comment: "пропал", source: "MANUAL", createdBy: "sc_super" },
  });

  const returned = await createBooking(client.id, "Флаги на площадке", "RETURNED", -6, -4, [[eq.C, 2]]);
  returnedBookingId = returned.id;
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

async function linesOf(id: string, token = saToken, query = "") {
  const res = await request(app).get(`/api/stock-counts/${id}/lines${query}`).set(auth(token));
  expect(res.status).toBe(200);
  return res.body.lines as any[];
}

function lineFor(lines: any[], key: string) {
  const line = lines.find((l) => l.equipmentId === eq[key]);
  expect(line, `строка для ${key}`).toBeDefined();
  return line;
}

async function count(id: string, lineId: string, qty: number, token = whToken) {
  return request(app).post(`/api/stock-counts/${id}/lines/${lineId}/count`).set(auth(token)).send({ qty });
}

/**
 * Решение — от лица того, кто видит строку сейчас: если тест не указал, какой
 * счёт он «видел», берём текущий из базы (seen-значения обязательны, 409
 * LINE_CHANGED проверяется отдельно).
 */
async function decide(id: string, lineId: string, body: Record<string, unknown>, token = saToken) {
  let payload = body;
  if (body.decision != null && !("seenCountedQty" in body)) {
    const row = await prisma.stockCountLine.findUnique({ where: { id: lineId } });
    if (row?.countedQty != null) {
      payload = { seenCountedQty: row.countedQty, seenExpectedQty: row.expectedQty, ...body };
    }
  }
  return request(app).post(`/api/stock-counts/${id}/lines/${lineId}/decision`).set(auth(token)).send(payload);
}

// ─── Права ────────────────────────────────────────────────────────────────────

describe("права на /api/stock-counts", () => {
  it("без сессии → 401", async () => {
    const res = await request(app).get("/api/stock-counts").set(apiKey);
    expect(res.status).toBe(401);
  });

  it("TECHNICIAN и COLLECTOR → 403 на чтение и на старт", async () => {
    for (const token of [techToken, collectorToken]) {
      const list = await request(app).get("/api/stock-counts").set(auth(token));
      expect(list.status).toBe(403);
      expect(list.body.code).toBe("FORBIDDEN_BY_ROLE");
      const start = await request(app).post("/api/stock-counts").set(auth(token)).send({});
      expect(start.status).toBe(403);
    }
  });

  it("WAREHOUSE и SUPER_ADMIN видят пустой список и отсутствие идущей", async () => {
    for (const token of [whToken, saToken]) {
      const list = await request(app).get("/api/stock-counts").set(auth(token));
      expect(list.status).toBe(200);
      expect(list.body.items).toEqual([]);
      const active = await request(app).get("/api/stock-counts/active").set(auth(token));
      expect(active.status).toBe(200);
      expect(active.body.stockCount).toBeNull();
    }
  });
});

// ─── Охват и отмена ───────────────────────────────────────────────────────────

describe("старт по категориям и отмена", () => {
  let scopedId: string;

  it("охват без позиций → 400 EMPTY_SCOPE", async () => {
    const res = await request(app)
      .post("/api/stock-counts")
      .set(auth(whToken))
      .send({ categories: ["Нет такой категории"] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("EMPTY_SCOPE");
  });

  it("WAREHOUSE начинает по категории «Грип»: только её COUNT-позиции", async () => {
    const res = await request(app).post("/api/stock-counts").set(auth(whToken)).send({ categories: ["Грип"] });
    expect(res.status).toBe(201);
    const sc = res.body.stockCount;
    scopedId = sc.id;
    expect(sc.number).toBe(1);
    expect(sc.status).toBe("OPEN");
    expect(sc.categories).toEqual(["Грип"]);
    expect(sc.createdByName).toBe("sc_warehouse");
    expect(sc.totals.lines).toBe(5);
    expect(sc.unitModeExcluded).toBe(0);
    expect(sc.isFirst).toBe(true);
    const lines = await linesOf(scopedId);
    expect(lines.map((l) => l.category)).toEqual(["Грип", "Грип", "Грип", "Грип", "Грип"]);
  });

  it("вторая открытая → 409 STOCK_COUNT_ALREADY_OPEN", async () => {
    const res = await request(app).post("/api/stock-counts").set(auth(saToken)).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("STOCK_COUNT_ALREADY_OPEN");
  });

  it("отмена: CANCELLED, счёт после неё → 409 STOCK_COUNT_NOT_OPEN, аудит записан", async () => {
    const lines = await linesOf(scopedId);
    const counted = await count(scopedId, lineFor(lines, "C").id, 1);
    expect(counted.status).toBe(200);

    const res = await request(app).post(`/api/stock-counts/${scopedId}/cancel`).set(auth(whToken));
    expect(res.status).toBe(200);
    expect(res.body.stockCount.status).toBe("CANCELLED");
    expect(res.body.stockCount.cancelledAt).toBeTruthy();

    const after = await count(scopedId, lineFor(lines, "C").id, 2);
    expect(after.status).toBe(409);
    expect(after.body.code).toBe("STOCK_COUNT_NOT_OPEN");

    const again = await request(app).post(`/api/stock-counts/${scopedId}/cancel`).set(auth(whToken));
    expect(again.status).toBe(409);

    const audit = await prisma.auditEntry.findFirst({ where: { action: "STOCK_COUNT_CANCEL", entityId: scopedId } });
    expect(audit).not.toBeNull();
    // Отмена ничего не применяет.
    const flag = await prisma.equipment.findUnique({ where: { id: eq.C } });
    expect(flag.totalQuantity).toBe(4);
    expect(flag.lastCountedAt).toBeNull();
  });

  it("несуществующая инвентаризация → 404", async () => {
    const res = await request(app).get("/api/stock-counts/no-such-id").set(auth(saToken));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("STOCK_COUNT_NOT_FOUND");
  });
});

// ─── Полная инвентаризация ────────────────────────────────────────────────────

describe("полная инвентаризация", () => {
  let id: string;

  it("старт по всему складу: штучные исключены, порядок как в каталоге", async () => {
    const res = await request(app).post("/api/stock-counts").set(auth(saToken)).send({});
    expect(res.status).toBe(201);
    const sc = res.body.stockCount;
    id = sc.id;
    expect(sc.number).toBe(2);
    expect(sc.categories).toBeNull();
    expect(sc.totals.lines).toBe(10);
    expect(sc.unitModeExcluded).toBe(1);
    // Отменённая № 1 «первой» не считается.
    expect(sc.isFirst).toBe(true);
    expect(sc.categoryProgress.map((c: any) => c.category)).toEqual(["Свет", "Грип", "Транспорт"]);

    const lines = await linesOf(id);
    expect(lines.map((l) => l.equipmentId)).not.toContain(eq.U);
    expect(lines.map((l) => l.name)).toEqual([
      "Кабель 25 м", "Стойка C-stand", "Стойка низкая", "Удлинитель",
      "Флаг 18×24", "Прищепка", "Грузик", "Рамка 12×12", "Сэндбэг",
      "Газель",
    ]);
    expect(lines.map((l) => l.position)).toEqual([...lines.map((l) => l.position)].sort((a, b) => a - b));

    const active = await request(app).get("/api/stock-counts/active").set(auth(whToken));
    expect(active.body.stockCount.id).toBe(id);
  });

  it("формула: total − issued − calendar − repair − lost, живая для непосчитанной", async () => {
    const lines = await linesOf(id);
    const cable = lineFor(lines, "A");
    expect(cable.expectedIsSnapshot).toBe(false);
    expect(cable.expected).toEqual({ total: 10, issued: 3, calendar: 2, repair: 1, lost: 1, expected: 3 });
    expect(cable.calendarBookings).toHaveLength(1);
    expect(cable.calendarBookings[0]).toMatchObject({
      projectName: "Съёмка «Календарь»",
      clientName: "Клиент Календарь",
      quantity: 2,
    });
    expect(cable.countedQty).toBeNull();
    expect(cable.diff).toBeNull();
    expect(cable.allowedDecisions).toEqual([]);
    expect(cable.ratePerShift).toBe("500");

    // Открытые потеряшки «Рамки» (2 + 3) уменьшают ожидание: 6 − 5 = 1.
    const frame = lineFor(lines, "E");
    expect(frame.expected.lost).toBe(5);
    expect(frame.expected.expected).toBe(1);
    expect(frame.openProblemQty).toBe(5);
  });

  it("счёт снимает снапшот: выдача после счёта итог строки не сбивает", async () => {
    let lines = await linesOf(id);
    const res = await count(id, lineFor(lines, "A").id, 3);
    expect(res.status).toBe(200);
    expect(res.body.line).toMatchObject({
      countedQty: 3,
      countedBy: "sc_warehouse",
      diff: 0,
      expectedIsSnapshot: true,
    });
    expect(res.body.line.expected.expected).toBe(3);

    // Новая выдача той же позиции уже после счёта.
    const client = await prisma.client.findFirst({ where: { name: "Клиент Инвентаризации" } });
    await createBooking(client.id, "Выдали во время пересчёта", "ISSUED", 0, 2, [[eq.A, 1]]);

    lines = await linesOf(id);
    const cable = lineFor(lines, "A");
    expect(cable.expected.issued).toBe(3);
    expect(cable.expected.expected).toBe(3);
    expect(cable.diff).toBe(0);
    // Живое ожидание изменилось бы, но строка посчитана — показываем снапшот.
    const live = await request(app).get(`/api/stock-counts/${id}/lines?filter=uncounted`).set(auth(saToken));
    expect(live.body.lines.map((l: any) => l.equipmentId)).not.toContain(eq.A);
  });

  it("валидация количества → 400", async () => {
    const lines = await linesOf(id);
    const lineId = lineFor(lines, "B").id;
    for (const qty of [-1, 1.5, 100_001, "5"]) {
      const res = await request(app).post(`/api/stock-counts/${id}/lines/${lineId}/count`).set(auth(whToken)).send({ qty });
      expect(res.status).toBe(400);
    }
    const missing = await count(id, "no-such-line", 1);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("LINE_NOT_FOUND");
  });

  it("решение без расхождения → 409 LINE_NOT_DISCREPANT; на непосчитанной — отказ", async () => {
    const lines = await linesOf(id);
    // Без «что видел» решение не принимается вовсе.
    const blind = await decide(id, lineFor(lines, "B").id, { decision: "LOST" });
    expect(blind.status).toBe(400);
    // Непосчитанную строку «видеть посчитанной» нельзя — её пересчитали.
    const uncounted = await decide(id, lineFor(lines, "B").id, {
      decision: "LOST",
      seenCountedQty: 4,
      seenExpectedQty: 5,
    });
    expect(uncounted.status).toBe(409);
    expect(uncounted.body.code).toBe("LINE_CHANGED");

    const matched = await count(id, lineFor(lines, "B").id, 5);
    expect(matched.body.line.diff).toBe(0);
    const res = await decide(id, lineFor(lines, "B").id, { decision: "ADJUST", note: "проверка" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("LINE_NOT_DISCREPANT");
  });

  it("недостача: валидации «Нашлось» / «Ошибка учёта» / брони, потом «Пропало»", async () => {
    const lines = await linesOf(id);
    const lineId = lineFor(lines, "C").id;
    const counted = await count(id, lineId, 2);
    expect(counted.body.line.diff).toBe(-2);
    expect(counted.body.line.allowedDecisions).toEqual(["LOST", "ADJUST"]);

    const found = await decide(id, lineId, { decision: "FOUND" });
    expect(found.status).toBe(400);
    expect(found.body.code).toBe("DECISION_NOT_APPLICABLE");

    for (const note of [undefined, "", "  ab  "]) {
      const adjust = await decide(id, lineId, { decision: "ADJUST", note });
      expect(adjust.status).toBe(400);
      expect(adjust.body.code).toBe("REASON_REQUIRED");
    }

    const badBooking = await decide(id, lineId, { decision: "LOST", sourceBookingId: "no-such-booking" });
    expect(badBooking.status).toBe(404);
    expect(badBooking.body.code).toBe("BOOKING_NOT_FOUND");

    const lost = await decide(id, lineId, { decision: "LOST", sourceBookingId: returnedBookingId }, whToken);
    expect(lost.status).toBe(200);
    expect(lost.body.line).toMatchObject({
      decision: "LOST",
      decidedBy: "sc_warehouse",
      sourceBookingId: returnedBookingId,
      sourceBooking: { id: returnedBookingId, projectName: "Флаги на площадке", clientName: "Клиент Инвентаризации" },
    });
  });

  it("изменение счёта сбрасывает решение, тот же счёт — нет", async () => {
    const lines = await linesOf(id);
    const lineId = lineFor(lines, "C").id;
    const same = await count(id, lineId, 2);
    expect(same.body.line.decision).toBe("LOST");

    const recount = await count(id, lineId, 1);
    expect(recount.body.line.diff).toBe(-3);
    expect(recount.body.line.decision).toBeNull();
    expect(recount.body.line.sourceBookingId).toBeNull();

    const lost = await decide(id, lineId, {
      decision: "LOST",
      note: "Уехали на площадку",
      sourceBookingId: returnedBookingId,
    });
    expect(lost.status).toBe(200);

    // Снять решение — decision: null.
    const cleared = await decide(id, lineId, { decision: null });
    expect(cleared.body.line.decision).toBeNull();
    const again = await decide(id, lineId, {
      decision: "LOST",
      note: "Уехали на площадку",
      sourceBookingId: returnedBookingId,
    });
    expect(again.body.line.decision).toBe("LOST");
  });

  it("«Пересчитать» обнуляет счёт, снапшот и решение", async () => {
    const lines = await linesOf(id);
    const lineId = lineFor(lines, "G").id;
    await count(id, lineId, 6);
    await decide(id, lineId, { decision: "ADJUST", note: "проверка сброса" });
    const res = await request(app).post(`/api/stock-counts/${id}/lines/${lineId}/reset`).set(auth(whToken));
    expect(res.status).toBe(200);
    expect(res.body.line).toMatchObject({
      countedQty: null,
      countedBy: null,
      diff: null,
      decision: null,
      decisionNote: null,
      expectedIsSnapshot: false,
    });
  });

  it("учёт изменился после счёта: тот же счёт — ничего не меняет, правка — 409, «Пересчитать» — заново", async () => {
    const lines = await linesOf(id);
    const lineId = lineFor(lines, "G").id;
    const first = await count(id, lineId, 6); // ожидание 8 → −2
    expect(first.body.line.diff).toBe(-2);
    expect((await decide(id, lineId, { decision: "LOST" })).status).toBe(200);

    const client = await prisma.client.findFirst({ where: { name: "Клиент Инвентаризации" } });
    const issued = await createBooking(client.id, "Удлинители выдали во время счёта", "ISSUED", 0, 2, [[eq.G, 3]]);

    // Тот же счёт (повтор, досылка) — снапшот, решение и итог строки те же.
    const same = await count(id, lineId, 6);
    expect(same.status).toBe(200);
    expect(same.body.line.expected.expected).toBe(8);
    expect(same.body.line.diff).toBe(-2);
    expect(same.body.line.decision).toBe("LOST");
    expect(same.body.line.booksChangedSinceCount).toBe(true);
    expect(same.body.line.live).toMatchObject({ issued: 3, expected: 5 });

    // Правка против старого снапшота показала бы расхождение, которого нет.
    const before = await prisma.stockCountLine.findUnique({ where: { id: lineId } });
    const edit = await count(id, lineId, 7);
    expect(edit.status).toBe(409);
    expect(edit.body.code).toBe("EXPECTATION_CHANGED");
    const after = await prisma.stockCountLine.findUnique({ where: { id: lineId } });
    expect(after).toEqual(before);

    // «Пересчитать» и посчитать заново — снапшот по новому учёту.
    const reset = await request(app).post(`/api/stock-counts/${id}/lines/${lineId}/reset`).set(auth(whToken));
    expect(reset.status).toBe(200);
    const recount = await count(id, lineId, 3);
    expect(recount.body.line.expected.expected).toBe(5);
    expect(recount.body.line.diff).toBe(-2);
    expect(recount.body.line.booksChangedSinceCount).toBe(false);

    // Страховка на случай, если сброс когда-нибудь потеряется: решение, чей знак
    // не подходит расхождению, считается «без решения» везде — в фильтре, итогах,
    // плане и на завершении, — а не выпадает молча на применении.
    await prisma.stockCountLine.update({
      where: { id: lineId },
      data: { decision: "FOUND", decidedBy: "sc_super", decidedAt: new Date() },
    });
    const stale = await linesOf(id, saToken, "?filter=undecided");
    expect(stale.map((l) => l.equipmentId)).toEqual([eq.G]);
    const detail = await request(app).get(`/api/stock-counts/${id}`).set(auth(saToken));
    expect(detail.body.stockCount.totals.undecided).toBe(1);
    // В плане — только «Пропало» у «Флага» (−3), неподходящее «Нашлось» не учтено.
    expect(detail.body.stockCount.decisionsPlan).toMatchObject({ lostPositions: 1, lostQty: 3, foundPositions: 0 });
    const blockedStale = await request(app).post(`/api/stock-counts/${id}/complete`).set(auth(saToken));
    expect(blockedStale.status).toBe(409);
    expect(blockedStale.body.code).toBe("UNDECIDED_LINES");
    expect(blockedStale.body.details).toEqual({ count: 1 });

    // Вернуть историю в исходное состояние для следующих шагов.
    const back = await request(app).post(`/api/stock-counts/${id}/lines/${lineId}/reset`).set(auth(whToken));
    expect(back.status).toBe(200);
    await prisma.booking.update({ where: { id: issued.id }, data: { deletedAt: new Date() } });
  });

  it("излишек: «Нашлось» доступно только при открытых потеряшках", async () => {
    const lines = await linesOf(id);

    const frame = await count(id, lineFor(lines, "E").id, 4);
    expect(frame.body.line.diff).toBe(3);
    expect(frame.body.line.allowedDecisions).toEqual(["ADJUST", "FOUND"]);

    const bag = await count(id, lineFor(lines, "F").id, 4);
    expect(bag.body.line.diff).toBe(2);
    expect(bag.body.line.openProblemQty).toBe(1);

    const low = await count(id, lineFor(lines, "H").id, 4);
    expect(low.body.line.diff).toBe(1);
    expect(low.body.line.allowedDecisions).toEqual(["ADJUST"]);
    const notApplicable = await decide(id, lineFor(lines, "H").id, { decision: "FOUND" });
    expect(notApplicable.status).toBe(400);
    expect(notApplicable.body.code).toBe("DECISION_NOT_APPLICABLE");
    const lostOnSurplus = await decide(id, lineFor(lines, "H").id, { decision: "LOST" });
    expect(lostOnSurplus.status).toBe(400);
    expect(lostOnSurplus.body.code).toBe("DECISION_NOT_APPLICABLE");

    await count(id, lineFor(lines, "D").id, 17);
    await count(id, lineFor(lines, "Z").id, 0);
  });

  it("завершение с нерешёнными расхождениями → 409 UNDECIDED_LINES { count }", async () => {
    const undecided = await linesOf(id, saToken, "?filter=undecided");
    expect(undecided.map((l) => l.equipmentId).sort()).toEqual([eq.D, eq.E, eq.F, eq.H, eq.Z].sort());

    const res = await request(app).post(`/api/stock-counts/${id}/complete`).set(auth(saToken));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("UNDECIDED_LINES");
    expect(res.body.details).toEqual({ count: 5 });
  });

  it("решения и план завершения", async () => {
    const lines = await linesOf(id);
    expect((await decide(id, lineFor(lines, "D").id, { decision: "ADJUST", note: "Пересорт при закупке" }, whToken)).status).toBe(200);
    expect((await decide(id, lineFor(lines, "Z").id, { decision: "ADJUST", note: "Списаны давно" })).status).toBe(200);
    expect((await decide(id, lineFor(lines, "E").id, { decision: "FOUND" })).status).toBe(200);
    expect((await decide(id, lineFor(lines, "F").id, { decision: "FOUND" })).status).toBe(200);
    expect((await decide(id, lineFor(lines, "H").id, { decision: "ADJUST", note: "Не завели при покупке" })).status).toBe(200);

    const detail = await request(app).get(`/api/stock-counts/${id}`).set(auth(saToken));
    expect(detail.status).toBe(200);
    const sc = detail.body.stockCount;
    expect(sc.totals).toMatchObject({
      lines: 10,
      counted: 8,
      matched: 2,
      shortagePositions: 3,
      shortageQty: 3 + 3 + 2,
      surplusPositions: 3,
      surplusQty: 3 + 2 + 1,
      undecided: 0,
    });
    // Недостача × ставка 500: (3 + 3 + 2) × 500.
    expect(sc.totals.shortageRatePerShift).toBe("4000");
    expect(sc.decisionsPlan).toEqual({
      lostPositions: 1,
      lostQty: 3,
      adjustPositions: 3,
      adjustMinusQty: 5,
      adjustPlusQty: 1,
      foundPositions: 2,
      // «Рамка» закроет 3 из 5 открытых, «Сэндбэг» — 1 из 1 (второй лишний без объяснения).
      foundQty: 4,
    });
    expect(sc.counters).toEqual(expect.arrayContaining(["sc_warehouse"]));
    const svet = sc.categoryProgress.find((c: any) => c.category === "Свет");
    expect(svet).toMatchObject({ lines: 4, counted: 3, discrepancies: 1 });
  });

  it("«Как пропало» для строки отдаётся без штрихкодов", async () => {
    const lines = await linesOf(id);
    const res = await request(app)
      .get(`/api/stock-counts/${id}/lines/${lineFor(lines, "C").id}/trail`)
      .set(auth(whToken));
    expect(res.status).toBe(200);
    expect(res.body.trail.equipmentId).toBe(eq.C);
    expect(res.body.trail.windowIsDefault).toBe(true);
    expect(res.body.trail.bookings.map((b: any) => b.bookingId)).toContain(returnedBookingId);
    expect(res.body.trail.suggestedBookingId).toBe(returnedBookingId);
    expect(JSON.stringify(res.body)).not.toMatch(/barcode/i);
  });

  it("учёт позиций изменился после решения — завершение ждёт «оставить как посчитано»", async () => {
    // За время инвентаризации «Прищепку» докупили (20 → 25), а «Грузик» частично
    // списали (2 → 1). Поправки уже решены по снапшоту — молча применять их
    // поверх нового количества нельзя.
    await prisma.equipment.update({ where: { id: eq.D }, data: { totalQuantity: 25 } });
    await prisma.equipment.update({ where: { id: eq.Z }, data: { totalQuantity: 1 } });

    let lines = await linesOf(id);
    const pins = lineFor(lines, "D");
    const weight = lineFor(lines, "Z");
    expect(pins).toMatchObject({ booksChangedSinceCount: true, booksAcknowledged: false });
    expect(pins.expected.total).toBe(20);
    expect(pins.live.total).toBe(25);

    const blocked = await request(app).post(`/api/stock-counts/${id}/complete`).set(auth(whToken));
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("LINE_BOOKS_CHANGED");
    expect(blocked.body.details.count).toBe(2);
    expect(blocked.body.details.lineIds.sort()).toEqual([pins.id, weight.id].sort());
    expect((await prisma.equipment.findUnique({ where: { id: eq.D } })).totalQuantity).toBe(25);

    // Новое решение без подтверждения — тоже 409, с тем, что изменилось.
    const unacked = await decide(id, pins.id, { decision: "ADJUST", note: "Пересорт при закупке" }, whToken);
    expect(unacked.status).toBe(409);
    expect(unacked.body.code).toBe("LINE_BOOKS_CHANGED");
    expect(unacked.body.details.snapshot.total).toBe(20);
    expect(unacked.body.details.live.total).toBe(25);

    // «Оставить как посчитано»: поправка ляжет дельтой на ТЕКУЩЕЕ значение.
    for (const [lineId, note] of [
      [pins.id, "Пересорт при закупке"],
      [weight.id, "Списаны давно"],
    ] as const) {
      const ack = await decide(id, lineId, { decision: "ADJUST", note, acknowledgeBooksChanged: true }, whToken);
      expect(ack.status).toBe(200);
      expect(ack.body.line).toMatchObject({ booksChangedSinceCount: true, booksAcknowledged: true });
    }
    lines = await linesOf(id);
    expect(lineFor(lines, "D").booksAcknowledged).toBe(true);
  });

  it("завершение: все эффекты одной транзакцией", async () => {
    const res = await request(app).post(`/api/stock-counts/${id}/complete`).set(auth(whToken));
    expect(res.status).toBe(200);
    expect(res.body.stockCount.status).toBe("CLOSED");
    expect(res.body.stockCount.closedByName).toBe("sc_warehouse");
    const result = res.body.result;
    expect(result).toMatchObject({
      matched: 2,
      lostPositions: 1,
      lostQty: 3,
      adjustedPositions: 3,
      foundPositions: 2,
      foundQty: 4,
      unexplainedSurplusQty: 1,
      verifiedPositions: 8,
      uncounted: 2,
    });
    expect(result.createdProblemItemIds).toHaveLength(1);

    // LOST → потеряшка «Не нашли на складе» на всю недостачу.
    const pi = await prisma.problemItem.findUnique({ where: { id: result.createdProblemItemIds[0] } });
    expect(pi).toMatchObject({
      equipmentId: eq.C,
      equipmentUnitId: null,
      bookingItemId: null,
      quantity: 3,
      reason: "NOT_ON_SHELF",
      status: "SEARCHING",
      source: "STOCK_COUNT",
      stockCountId: id,
      sourceBookingId: returnedBookingId,
      comment: "Уехали на площадку",
      createdBy: "sc_warehouse",
    });

    // ADJUST → дельта к текущему значению, с полом в ноль; аудит на каждую позицию.
    expect((await prisma.equipment.findUnique({ where: { id: eq.D } })).totalQuantity).toBe(22);
    expect((await prisma.equipment.findUnique({ where: { id: eq.Z } })).totalQuantity).toBe(0);
    expect((await prisma.equipment.findUnique({ where: { id: eq.H } })).totalQuantity).toBe(4);
    const adjustAudit = await prisma.auditEntry.findMany({ where: { action: "STOCK_ADJUST" } });
    expect(adjustAudit).toHaveLength(3);
    const dAudit = adjustAudit.find((a: any) => a.entityId === eq.D);
    expect(dAudit.entityType).toBe("Equipment");
    expect(JSON.parse(dAudit.before)).toEqual({ totalQuantity: 25 });
    expect(JSON.parse(dAudit.after)).toMatchObject({
      totalQuantity: 22,
      diff: -3,
      reason: "Пересорт при закупке",
      stockCountNumber: 2,
      decidedBy: "sc_warehouse",
    });

    // FOUND → старые потеряшки закрываются первыми, последняя делится.
    const frameRows = await prisma.problemItem.findMany({
      where: { OR: [{ equipmentId: eq.E }, { bookingItem: { equipmentId: eq.E } }] },
      orderBy: [{ createdAt: "asc" }, { status: "asc" }],
    });
    const open = frameRows.filter((r: any) => r.status === "EXPECTED" || r.status === "SEARCHING");
    const found = frameRows.filter((r: any) => r.status === "FOUND");
    expect(open).toHaveLength(1);
    expect(open[0].quantity).toBe(2);
    expect(open[0].status).toBe("EXPECTED");
    expect(found.map((r: any) => r.quantity).sort()).toEqual([1, 2]);
    for (const r of found) {
      expect(r.resolutionNote).toBe("Найдено при инвентаризации № 2");
      expect(r.resolvedBy).toBe("sc_warehouse");
      expect(r.resolvedAt).not.toBeNull();
    }
    const split = found.find((r: any) => r.quantity === 1);
    expect(split.bookingItemId).toBe(open[0].bookingItemId);
    expect(split.comment).toBe("остались на площадке");

    const bagRows = await prisma.problemItem.findMany({ where: { equipmentId: eq.F } });
    expect(bagRows.every((r: any) => r.status === "FOUND")).toBe(true);

    // Посчитанные позиции сверены — в момент, когда их посчитали, а не когда
    // нажали «Завершить»; непосчитанные не тронуты.
    const verified = await prisma.equipment.findMany({
      where: { id: { in: [eq.A, eq.B, eq.C, eq.D, eq.Z, eq.E, eq.F, eq.H] } },
    });
    const countedLines = await prisma.stockCountLine.findMany({ where: { stockCountId: id, countedQty: { not: null } } });
    const countedAtOf = new Map(countedLines.map((l: any) => [l.equipmentId, l.countedAt.getTime()]));
    for (const e of verified) {
      expect(e.lastCountedAt, e.name).toBeInstanceOf(Date);
      expect(e.lastCountedAt.getTime(), e.name).toBe(countedAtOf.get(e.id));
    }
    const untouched = await prisma.equipment.findMany({ where: { id: { in: [eq.G, eq.T] } } });
    expect(untouched.every((e: any) => e.lastCountedAt === null)).toBe(true);
    expect(untouched.find((e: any) => e.id === eq.G).totalQuantity).toBe(8);

    const closeAudit = await prisma.auditEntry.findFirst({ where: { action: "STOCK_COUNT_CLOSE", entityId: id } });
    expect(closeAudit.entityType).toBe("StockCount");
    expect(JSON.parse(closeAudit.after)).toMatchObject({ status: "CLOSED", number: 2, lostQty: 3 });
  });

  it("«Как пропало» у завершённой: на момент счёта строки, а не от только что проставленной сверки", async () => {
    // После закрытия lastCountedAt «Флага» указывает на эту же инвентаризацию —
    // окно от него было бы пустым. Прошлой сверки не было → 60 дней до счёта строки.
    const lines = await linesOf(id);
    const flag = lineFor(lines, "C");
    const res = await request(app).get(`/api/stock-counts/${id}/lines/${flag.id}/trail`).set(auth(saToken));
    expect(res.status).toBe(200);
    expect(res.body.trail.windowIsDefault).toBe(true);
    expect(res.body.trail.windowFrom).toBe(new Date(new Date(flag.countedAt).getTime() - 60 * DAY).toISOString());
    expect(res.body.trail.bookings.map((b: any) => b.bookingId)).toContain(returnedBookingId);
  });

  it("потеряшка из инвентаризации уменьшает доступность", async () => {
    const res = await request(app)
      .get(`/api/availability?start=${encodeURIComponent(daysFromNow(10).toISOString())}&end=${encodeURIComponent(daysFromNow(11).toISOString())}`)
      .set(auth(saToken));
    expect(res.status).toBe(200);
    const flag = res.body.rows.find((r: any) => r.equipmentId === eq.C);
    expect(flag.availableQuantity).toBe(1);
  });

  it("после завершения: всё закрыто для изменений, решений нет", async () => {
    const lines = await linesOf(id);
    expect(lines.every((l) => l.allowedDecisions.length === 0)).toBe(true);

    const complete = await request(app).post(`/api/stock-counts/${id}/complete`).set(auth(saToken));
    expect(complete.status).toBe(409);
    expect(complete.body.code).toBe("STOCK_COUNT_NOT_OPEN");
    const recount = await count(id, lineFor(lines, "G").id, 8);
    expect(recount.status).toBe(409);
    expect(recount.body.code).toBe("STOCK_COUNT_NOT_OPEN");
    const decision = await decide(id, lineFor(lines, "C").id, { decision: null });
    expect(decision.status).toBe(409);
    const reset = await request(app).post(`/api/stock-counts/${id}/lines/${lineFor(lines, "C").id}/reset`).set(auth(saToken));
    expect(reset.status).toBe(409);
  });

  it("список: новые сверху, со сводкой; следующая — уже не первая", async () => {
    const list = await request(app).get("/api/stock-counts").set(auth(whToken));
    expect(list.status).toBe(200);
    expect(list.body.items.map((i: any) => [i.number, i.status])).toEqual([
      [2, "CLOSED"],
      [1, "CANCELLED"],
    ]);
    expect(list.body.items[0].totals.counted).toBe(8);
    expect(list.body.items[0].counters).toEqual(expect.arrayContaining(["sc_warehouse"]));

    const next = await request(app).post("/api/stock-counts").set(auth(whToken)).send({ categories: ["Свет"] });
    expect(next.status).toBe(201);
    expect(next.body.stockCount.number).toBe(3);
    expect(next.body.stockCount.isFirst).toBe(false);
    expect(next.body.stockCount.unitModeExcluded).toBe(1);

    // Ожидание «Кабеля» после сверки: выдача во время пересчёта теперь учтена живьём.
    const nextId = next.body.stockCount.id;
    const lines = await linesOf(nextId);
    const cable = lineFor(lines, "A");
    expect(cable.expected.issued).toBe(4);

    // Окно следа идущей № 3 — от момента, когда «Кабель» посчитали в № 2.
    const cable2 = await prisma.stockCountLine.findFirst({ where: { stockCountId: id, equipmentId: eq.A } });
    const trail = await request(app).get(`/api/stock-counts/${nextId}/lines/${cable.id}/trail`).set(auth(saToken));
    expect(trail.status).toBe(200);
    expect(trail.body.trail.windowIsDefault).toBe(false);
    expect(trail.body.trail.windowFrom).toBe(cable2.countedAt.toISOString());

    // «Кабель» посчитан и в № 3 — но она будет отменена и окно не сдвинет.
    const counted = await count(nextId, cable.id, cable.expected.expected);
    expect(counted.status).toBe(200);
    expect(counted.body.line.diff).toBe(0);

    const cancel = await request(app).post(`/api/stock-counts/${nextId}/cancel`).set(auth(saToken));
    expect(cancel.status).toBe(200);
  });

  it("окно следа — от прошлой ЗАВЕРШЁННОЙ со счётом позиции: отменённая и сама текущая не в счёт", async () => {
    const cable2 = await prisma.stockCountLine.findFirst({ where: { stockCountId: id, equipmentId: eq.A } });
    const start = await request(app).post("/api/stock-counts").set(auth(whToken)).send({ categories: ["Свет"] });
    expect(start.status).toBe(201);
    const fourthId = start.body.stockCount.id;
    expect(start.body.stockCount.number).toBe(4);

    const lines = await linesOf(fourthId);
    const cable = lineFor(lines, "A");
    const counted = await count(fourthId, cable.id, cable.expected.expected);
    expect(counted.body.line.diff).toBe(0);

    // Непосчитанные позиции завершению не мешают.
    const done = await request(app).post(`/api/stock-counts/${fourthId}/complete`).set(auth(whToken));
    expect(done.status).toBe(200);
    expect(done.body.result).toMatchObject({ matched: 1, verifiedPositions: 1, uncounted: 3 });

    // № 4 закрыта и «Кабель» в ней посчитан, но окно — от счёта в № 2:
    // отменённая № 3 пропущена, а № 4 не выбирает сама себя.
    const trail = await request(app).get(`/api/stock-counts/${fourthId}/lines/${cable.id}/trail`).set(auth(saToken));
    expect(trail.status).toBe(200);
    expect(trail.body.trail.windowIsDefault).toBe(false);
    expect(trail.body.trail.windowFrom).toBe(cable2.countedAt.toISOString());
  });
});

// ─── Штучный учёт посреди инвентаризации ─────────────────────────────────────

describe("позицию перевели на штучный учёт, пока идёт инвентаризация", () => {
  it("счёт и новое решение → 409 LINE_NOT_COUNT_MODE; завершение такие строки пропускает", async () => {
    await createEquipment("V", "Штатив лёгкий", "Проверка режима", 5, { sortOrder: 1 });
    await createEquipment("X", "Штатив тяжёлый", "Проверка режима", 4, { sortOrder: 2 });
    await createEquipment("Y", "Штатив низкий", "Проверка режима", 3, { sortOrder: 3 });
    await createEquipment("W", "Штатив мини", "Проверка режима", 2, { sortOrder: 4 });
    await createEquipment("R", "Штатив настольный", "Проверка режима", 2, { sortOrder: 5 });

    const start = await request(app).post("/api/stock-counts").set(auth(saToken)).send({ categories: ["Проверка режима"] });
    expect(start.status).toBe(201);
    const scId = start.body.stockCount.id;
    expect(start.body.stockCount.totals.lines).toBe(5);
    expect(start.body.stockCount.unitModeExcluded).toBe(0);

    // До перевода: V сошлось; X −1 «Ошибка учёта»; Y −2 «Пропало»; W −1 без
    // решения; R −1 «Ошибка учёта» (её снимут и пересчитают).
    const lines = await linesOf(scId);
    const lineId = (key: string) => lineFor(lines, key).id;
    expect((await count(scId, lineId("V"), 5)).body.line.diff).toBe(0);
    expect((await count(scId, lineId("X"), 3)).body.line.diff).toBe(-1);
    expect((await decide(scId, lineId("X"), { decision: "ADJUST", note: "Пересорт" })).status).toBe(200);
    expect((await count(scId, lineId("Y"), 1)).body.line.diff).toBe(-2);
    expect((await decide(scId, lineId("Y"), { decision: "LOST" })).status).toBe(200);
    expect((await count(scId, lineId("W"), 1)).body.line.diff).toBe(-1);
    expect((await count(scId, lineId("R"), 1)).body.line.diff).toBe(-1);
    expect((await decide(scId, lineId("R"), { decision: "ADJUST", note: "Пересорт" })).status).toBe(200);

    // Руководитель переводит четыре позиции на штучный учёт.
    for (const key of ["X", "Y", "W", "R"]) {
      const patch = await request(app)
        .patch(`/api/equipment/${eq[key]}`)
        .set(auth(saToken))
        .send({ stockTrackingMode: "UNIT" });
      expect(patch.status).toBe(200);
      expect(patch.body.equipment.stockTrackingMode).toBe("UNIT");
    }

    // Считать и решать количеством такую позицию больше нельзя — ни с десктопа, ни в киоске.
    const recount = await count(scId, lineId("X"), 4);
    expect(recount.status).toBe(409);
    expect(recount.body.code).toBe("LINE_NOT_COUNT_MODE");
    const kiosk = await request(app)
      .post(`/api/warehouse/stock-count/${scId}/lines/${lineId("X")}/count`)
      .set(auth(whToken))
      .send({ qty: 4 });
    expect(kiosk.status).toBe(409);
    expect(kiosk.body.code).toBe("LINE_NOT_COUNT_MODE");
    for (const body of [{ decision: "ADJUST", note: "Пересорт" }, { decision: "LOST" }]) {
      const res = await decide(scId, lineId("W"), body);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("LINE_NOT_COUNT_MODE");
    }

    // Снять решение и «Пересчитать» — можно: устаревшую строку должно быть чем убрать.
    const cleared = await decide(scId, lineId("R"), { decision: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.line.decision).toBeNull();
    const reset = await request(app).post(`/api/stock-counts/${scId}/lines/${lineId("R")}/reset`).set(auth(whToken));
    expect(reset.status).toBe(200);
    expect(reset.body.line.countedQty).toBeNull();

    // Решений таким строкам не предлагаем, завершение они не держат, и во
    // «штучных вне охвата» позиция из охвата второй раз не считается.
    const after = await linesOf(scId);
    for (const key of ["X", "Y", "W"]) expect(lineFor(after, key).allowedDecisions).toEqual([]);
    expect(await linesOf(scId, saToken, "?filter=undecided")).toEqual([]);
    const detail = await request(app).get(`/api/stock-counts/${scId}`).set(auth(saToken));
    expect(detail.body.stockCount.totals.undecided).toBe(0);
    expect(detail.body.stockCount.unitModeExcluded).toBe(0);
    expect(detail.body.stockCount.decisionsPlan).toMatchObject({ lostPositions: 0, adjustPositions: 0 });

    const done = await request(app).post(`/api/stock-counts/${scId}/complete`).set(auth(saToken));
    expect(done.status).toBe(200);
    expect(done.body.result).toMatchObject({
      matched: 1,
      unitModeSkipped: 3,
      lostPositions: 0,
      lostQty: 0,
      adjustedPositions: 0,
      createdProblemItemIds: [],
      verifiedPositions: 1,
      uncounted: 1,
    });

    // У штучной позиции totalQuantity выводится из единиц — поправка его не тронула,
    // потеряшки без единицы по ней не заведено, сверенной количеством она не считается.
    const rows = await prisma.equipment.findMany({ where: { id: { in: [eq.V, eq.X, eq.Y, eq.W, eq.R] } } });
    const byId = Object.fromEntries(rows.map((r: any) => [r.id, r]));
    expect(byId[eq.X].totalQuantity).toBe(4);
    expect(byId[eq.Y].totalQuantity).toBe(3);
    expect(await prisma.problemItem.count({ where: { equipmentId: { in: [eq.X, eq.Y, eq.W] } } })).toBe(0);
    for (const key of ["X", "Y", "W", "R"]) expect(byId[eq[key]].lastCountedAt).toBeNull();
    expect(byId[eq.V].lastCountedAt).toBeInstanceOf(Date);
    expect(await prisma.auditEntry.count({ where: { action: "STOCK_ADJUST", entityId: eq.X } })).toBe(0);

    const closeAudit = await prisma.auditEntry.findFirst({ where: { action: "STOCK_COUNT_CLOSE", entityId: scId } });
    expect(JSON.parse(closeAudit.after)).toMatchObject({ unitModeSkipped: 3 });
  });
});

// ─── Гонки: двойной клик ─────────────────────────────────────────────────────

describe("гонки: двойной клик", () => {
  let raceId: string;

  it("одновременный старт — ровно одна открытая инвентаризация", async () => {
    expect(await prisma.stockCount.count({ where: { status: "OPEN" } })).toBe(0);
    const before = await prisma.stockCount.count();
    const startAudits = await prisma.auditEntry.count({ where: { action: "STOCK_COUNT_START" } });

    const res = await Promise.all(
      [0, 1, 2].map((i) =>
        request(app)
          .post("/api/stock-counts")
          .set(auth(i % 2 ? saToken : whToken))
          .send({ categories: ["Грип"] }),
      ),
    );
    expect(res.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    for (const r of res.filter((x) => x.status === 409)) {
      expect(r.body.code).toBe("STOCK_COUNT_ALREADY_OPEN");
    }
    expect(await prisma.stockCount.count({ where: { status: "OPEN" } })).toBe(1);
    expect(await prisma.stockCount.count()).toBe(before + 1);
    expect(await prisma.auditEntry.count({ where: { action: "STOCK_COUNT_START" } })).toBe(startAudits + 1);
    raceId = res.find((r) => r.status === 201)!.body.stockCount.id;
  });

  it("одновременное завершение — решения применяются один раз", async () => {
    const lines = await linesOf(raceId);
    const flag = lineFor(lines, "C");
    const pins = lineFor(lines, "D");
    expect((await count(raceId, flag.id, flag.expected.expected - 1)).body.line.diff).toBe(-1);
    expect((await decide(raceId, flag.id, { decision: "LOST" })).status).toBe(200);
    expect((await count(raceId, pins.id, pins.expected.expected - 2)).body.line.diff).toBe(-2);
    expect((await decide(raceId, pins.id, { decision: "ADJUST", note: "Гонка: поправка" })).status).toBe(200);

    const dBefore = (await prisma.equipment.findUnique({ where: { id: eq.D } })).totalQuantity;
    const adjBefore = await prisma.auditEntry.count({ where: { action: "STOCK_ADJUST", entityId: eq.D } });

    const res = await Promise.all([
      request(app).post(`/api/stock-counts/${raceId}/complete`).set(auth(saToken)),
      request(app).post(`/api/stock-counts/${raceId}/complete`).set(auth(whToken)),
    ]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(res.find((r) => r.status === 409)!.body.code).toBe("STOCK_COUNT_NOT_OPEN");

    expect(await prisma.problemItem.count({ where: { stockCountId: raceId } })).toBe(1);
    expect(await prisma.auditEntry.count({ where: { action: "STOCK_ADJUST", entityId: eq.D } })).toBe(adjBefore + 1);
    expect((await prisma.equipment.findUnique({ where: { id: eq.D } })).totalQuantity).toBe(dBefore - 2);
    expect(await prisma.auditEntry.count({ where: { action: "STOCK_COUNT_CLOSE", entityId: raceId } })).toBe(1);
    expect((await prisma.stockCount.findUnique({ where: { id: raceId } })).status).toBe("CLOSED");
  });
});

// ─── Правка посчитанной строки ───────────────────────────────────────────────

describe("правка посчитанной строки сравнивается с тем же снапшотом", () => {
  let scId: string;
  const lineOf = async (key: string) => lineFor(await linesOf(scId), key);

  it("учёт догнал полку после счёта: правка → 409, строка как была; «Пересчитать» — сошлось", async () => {
    await createEquipment("EXT", "Удлинитель 10 м", "Проверка правки", 10, { sortOrder: 1 });
    await createEquipment("EDT", "Разветвитель", "Проверка правки", 8, { sortOrder: 2 });
    await createEquipment("SEEN", "Тройник", "Проверка правки", 7, { sortOrder: 3 });
    const client = await prisma.client.findFirst({ where: { name: "Клиент Инвентаризации" } });
    const out = await createBooking(client.id, "Удлинители на площадке", "ISSUED", -2, -1, [[eq.EXT, 3]]);

    const start = await request(app).post("/api/stock-counts").set(auth(saToken)).send({ categories: ["Проверка правки"] });
    expect(start.status).toBe(201);
    scId = start.body.stockCount.id;

    // Ожидание 7 (3 на съёмке), на полке 6 → −1.
    const ext = await lineOf("EXT");
    const first = await count(scId, ext.id, 6);
    expect(first.body.line).toMatchObject({ countedQty: 6, diff: -1 });
    expect(first.body.line.expected.expected).toBe(7);

    // Бронь вернули — 3 удлинителя снова на полке (живое ожидание 10).
    await prisma.booking.update({ where: { id: out.id }, data: { status: "RETURNED" } });

    // Кладовщик нашёл недостающий, руководитель жмёт «+»: 7 против нового учёта
    // — это −3, против старого — «сошлось». Ни то, ни другое не правда.
    const edit = await count(scId, ext.id, 7);
    expect(edit.status).toBe(409);
    expect(edit.body.code).toBe("EXPECTATION_CHANGED");
    expect(edit.body.details).toEqual({ snapshotExpected: 7, liveExpected: 10 });
    const row = await prisma.stockCountLine.findUnique({ where: { id: ext.id } });
    expect(row).toMatchObject({ countedQty: 6, expectedQty: 7 });

    const reset = await request(app).post(`/api/stock-counts/${scId}/lines/${ext.id}/reset`).set(auth(whToken));
    expect(reset.status).toBe(200);
    const recount = await count(scId, ext.id, 10);
    expect(recount.body.line).toMatchObject({ countedQty: 10, diff: 0 });
    expect(recount.body.line.expected.expected).toBe(10);
  });

  it("ожидание не менялось: правка сравнивается с прежним снапшотом и снимает решение", async () => {
    const edt = await lineOf("EDT");
    const first = await count(scId, edt.id, 6); // ожидание 8 → −2
    expect(first.body.line.diff).toBe(-2);
    const decided = await decide(scId, edt.id, { decision: "ADJUST", note: "пересорт" }, whToken);
    expect(decided.status).toBe(200);

    const edit = await count(scId, edt.id, 7);
    expect(edit.status).toBe(200);
    expect(edit.body.line).toMatchObject({ countedQty: 7, diff: -1, decision: null, decidedBy: null });
    const row = await prisma.stockCountLine.findUnique({ where: { id: edt.id } });
    expect(row).toMatchObject({ expectedQty: 8, totalAtCount: 8, decisionNote: null, decidedById: null });
  });

  it("решение привязано к тому, что видел руководитель: строку пересчитали → 409 LINE_CHANGED", async () => {
    const seen = await lineOf("SEEN");
    const counted = await count(scId, seen.id, 5); // ожидание 7 → −2
    expect(counted.body.line.diff).toBe(-2);
    // Тем временем кладовщик пересчитал: 8 → излишек +1.
    const recount = await count(scId, seen.id, 8);
    expect(recount.body.line.diff).toBe(1);

    const stale = await decide(scId, seen.id, {
      decision: "ADJUST",
      note: "2 шт списаны в 2024, в учёте не сняли",
      seenCountedQty: 5,
      seenExpectedQty: 7,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("LINE_CHANGED");
    expect(stale.body.details).toEqual({ countedQty: 8, expectedQty: 7, diff: 1 });
    expect((await prisma.stockCountLine.findUnique({ where: { id: seen.id } })).decision).toBeNull();

    // С тем, что на строке сейчас, — принимается; снять решение можно без seen-значений.
    const fresh = await decide(scId, seen.id, {
      decision: "ADJUST",
      note: "не завели при покупке",
      seenCountedQty: 8,
      seenExpectedQty: 7,
    });
    expect(fresh.status).toBe(200);
    expect(fresh.body.line.decision).toBe("ADJUST");
    const cleared = await request(app)
      .post(`/api/stock-counts/${scId}/lines/${seen.id}/decision`)
      .set(auth(saToken))
      .send({ decision: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.line.decision).toBeNull();

    const cancel = await request(app).post(`/api/stock-counts/${scId}/cancel`).set(auth(saToken));
    expect(cancel.status).toBe(200);
  });
});
