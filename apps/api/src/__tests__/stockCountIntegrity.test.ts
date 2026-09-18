/**
 * Инвентаризация — целостность решений (финальное холистическое ревью).
 *
 * Каждый блок — своя категория и своя инвентаризация (открытая на систему одна,
 * поэтому блок её завершает или отменяет):
 *   учёт изменился после счёта → «Обновить ожидание» / «оставить как посчитано»;
 *   «Нашлось» закрывает только потеряшки из снапшота строки;
 *   «Нашлось» без открытых потеряшек ждёт решения;
 *   кто решил «Ошибку учёта» — в журнале отдельно от того, кто завершил;
 *   подсказки «Как пропало» батчем совпадают с полным следом строки;
 *   штучный учёт строки — явным флагом; охват для старта — только COUNT.
 *
 * Даты — только от Date.now().
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-stock-count-integrity.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-stock-integrity";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-stock-integrity";
process.env.WAREHOUSE_SECRET = "test-warehouse-stock-integrity";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-secret-stock-integrity-min16";

const DAY = 24 * 60 * 60 * 1000;
const daysFromNow = (d: number) => new Date(Date.now() + d * DAY);

let app: Express;
let prisma: any;
let saToken: string;
let whToken: string;
let saId: string;
let whId: string;
let clientId: string;

const eq: Record<string, string> = {};
const apiKey = { "X-API-Key": "test-key-stock-integrity" };
const auth = (token: string) => ({ ...apiKey, Authorization: `Bearer ${token}` });

async function createEquipment(key: string, category: string, totalQuantity: number, extra: Record<string, unknown> = {}) {
  const row = await prisma.equipment.create({
    data: {
      importKey: `sci-${key}`,
      name: `Позиция ${key}`,
      category,
      totalQuantity,
      rentalRatePerShift: "300",
      stockTrackingMode: "COUNT",
      ...extra,
    },
  });
  eq[key] = row.id;
  return row;
}

async function createBooking(
  projectName: string,
  status: string,
  startDays: number,
  endDays: number,
  items: Array<[string, number]>,
) {
  return prisma.booking.create({
    data: {
      clientId,
      projectName,
      status,
      startDate: daysFromNow(startDays),
      endDate: daysFromNow(endDays),
      items: { create: items.map(([equipmentId, quantity]) => ({ equipmentId, quantity })) },
    },
  });
}

async function start(categories: string[]) {
  const res = await request(app).post("/api/stock-counts").set(auth(saToken)).send({ categories });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.stockCount.id as string;
}

async function linesOf(id: string, query = "") {
  const res = await request(app).get(`/api/stock-counts/${id}/lines${query}`).set(auth(saToken));
  expect(res.status).toBe(200);
  return res.body.lines as any[];
}

async function lineOf(id: string, key: string) {
  const line = (await linesOf(id)).find((l) => l.equipmentId === eq[key]);
  expect(line, `строка ${key}`).toBeDefined();
  return line;
}

async function count(id: string, lineId: string, qty: number, token = whToken) {
  return request(app).post(`/api/stock-counts/${id}/lines/${lineId}/count`).set(auth(token)).send({ qty });
}

/** Решение с тем, что на строке сейчас (seen-значения — из базы). */
async function decide(id: string, lineId: string, body: Record<string, unknown>, token = saToken) {
  const row = await prisma.stockCountLine.findUnique({ where: { id: lineId } });
  const payload = body.decision == null ? body : { seenCountedQty: row.countedQty, seenExpectedQty: row.expectedQty, ...body };
  return request(app).post(`/api/stock-counts/${id}/lines/${lineId}/decision`).set(auth(token)).send(payload);
}

async function detailOf(id: string) {
  const res = await request(app).get(`/api/stock-counts/${id}`).set(auth(saToken));
  expect(res.status).toBe(200);
  return res.body.stockCount;
}

async function complete(id: string, token = saToken) {
  return request(app).post(`/api/stock-counts/${id}/complete`).set(auth(token));
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
  const hash = await hashPassword("stock-integrity-pass");
  const sa = await prisma.adminUser.create({ data: { username: "sci_super", passwordHash: hash, role: "SUPER_ADMIN" } });
  const wh = await prisma.adminUser.create({ data: { username: "sci_warehouse", passwordHash: hash, role: "WAREHOUSE" } });
  saId = sa.id;
  whId = wh.id;
  saToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });
  whToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });
  clientId = (await prisma.client.create({ data: { name: "Клиент Сверки" } })).id;
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

// ─── Учёт изменился после счёта ──────────────────────────────────────────────

describe("учёт изменился после счёта", () => {
  let id: string;
  let bookingId: string;

  beforeAll(async () => {
    await createEquipment("BK", "Учёт после счёта", 10, { sortOrder: 1 });
    await createEquipment("RP", "Учёт после счёта", 5, { sortOrder: 2 });
    // Оборудование разгрузили на полку, а возврат ещё не отметили.
    bookingId = (await createBooking("Разгрузили, не отметили", "ISSUED", -3, -1, [[eq.BK, 4]])).id;
    id = await start(["Учёт после счёта"]);
  });

  it("возврат кнопкой после счёта: строка видит расхождение с учётом, «Ошибка учёта» — только явно", async () => {
    const bk = await lineOf(id, "BK");
    const counted = await count(id, bk.id, 10); // ожидание 6 → +4
    expect(counted.body.line).toMatchObject({ diff: 4, allowedDecisions: ["ADJUST"], booksChangedSinceCount: false });
    expect(counted.body.line.live).toMatchObject({ issued: 4, expected: 6 });

    const returned = await request(app)
      .post(`/api/bookings/${bookingId}/status`)
      .set(auth(saToken))
      .send({ action: "return" });
    expect(returned.status, JSON.stringify(returned.body)).toBe(200);

    const line = await lineOf(id, "BK");
    expect(line.expected).toMatchObject({ issued: 4, expected: 6 });
    expect(line.live).toMatchObject({ issued: 0, expected: 10 });
    expect(line).toMatchObject({ diff: 4, booksChangedSinceCount: true, booksAcknowledged: false });

    const adjust = await decide(id, bk.id, { decision: "ADJUST", note: "излишек при счёте" });
    expect(adjust.status).toBe(409);
    expect(adjust.body.code).toBe("LINE_BOOKS_CHANGED");
    expect(adjust.body.details.snapshot).toMatchObject({ issued: 4, expected: 6 });
    expect(adjust.body.details.live).toMatchObject({ issued: 0, expected: 10 });

    // Оборудование уже лежало на полке — учёт лишь догнал: «Обновить ожидание».
    const refreshed = await request(app)
      .post(`/api/stock-counts/${id}/lines/${bk.id}/refresh-expected`)
      .set(auth(whToken));
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.line).toMatchObject({ countedQty: 10, diff: 0, booksChangedSinceCount: false, decision: null });
    expect(refreshed.body.line.expected).toMatchObject({ issued: 0, expected: 10 });
    const row = await prisma.stockCountLine.findUnique({ where: { id: bk.id } });
    // Полку посчитали тогда же — момент счёта не сдвигается.
    expect(row.countedAt.toISOString()).toBe(counted.body.line.countedAt);
  });

  it("ремонт заведён после счёта: «Пропало» без подтверждения → 409, с подтверждением — принято", async () => {
    const rp = await lineOf(id, "RP");
    expect((await count(id, rp.id, 4)).body.line.diff).toBe(-1);
    // Сломанный прибор нашли на полке и завели в мастерскую уже после счёта.
    await prisma.repair.create({ data: { equipmentId: eq.RP, quantity: 1, reason: "перебит", createdBy: saId } });

    const lost = await decide(id, rp.id, { decision: "LOST" });
    expect(lost.status).toBe(409);
    expect(lost.body.code).toBe("LINE_BOOKS_CHANGED");
    expect(lost.body.details.live.repair).toBe(1);

    const acked = await decide(id, rp.id, { decision: "LOST", acknowledgeBooksChanged: true });
    expect(acked.status).toBe(200);
    expect(acked.body.line).toMatchObject({ decision: "LOST", booksChangedSinceCount: true, booksAcknowledged: true });
  });

  it("учёт изменился ещё раз после подтверждения — завершение 409 и ничего не применяет", async () => {
    await prisma.repair.create({ data: { equipmentId: eq.RP, quantity: 1, reason: "ещё один", createdBy: saId } });
    const rp = await lineOf(id, "RP");
    expect(rp.booksAcknowledged).toBe(false);

    const blocked = await complete(id);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("LINE_BOOKS_CHANGED");
    expect(blocked.body.details).toEqual({ count: 1, lineIds: [rp.id] });
    expect(await prisma.problemItem.count({ where: { stockCountId: id } })).toBe(0);
    expect((await prisma.stockCount.findUnique({ where: { id } })).status).toBe("OPEN");

    expect((await decide(id, rp.id, { decision: "LOST", acknowledgeBooksChanged: true })).status).toBe(200);
    const done = await complete(id);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.result).toMatchObject({ lostPositions: 1, lostQty: 1, adjustedPositions: 0, matched: 1 });
    // Возврат кнопкой учёт догнал — поправки количества нет.
    expect((await prisma.equipment.findUnique({ where: { id: eq.BK } })).totalQuantity).toBe(10);
  });
});

// ─── «Нашлось» — только потеряшки из снапшота ────────────────────────────────

describe("«Нашлось» закрывает только потеряшки, заведённые не позже счёта строки", () => {
  let id: string;
  let oldCardId: string;
  let lateCardId: string;

  beforeAll(async () => {
    await createEquipment("FA", "Нашлось", 20, { sortOrder: 1 });
    await createEquipment("FB", "Нашлось", 5, { sortOrder: 2 });
    oldCardId = (
      await prisma.problemItem.create({
        data: {
          equipmentId: eq.FA, quantity: 1, reason: "LOST", status: "SEARCHING", source: "MANUAL",
          comment: "старая пропажа", createdBy: "sci_super", createdAt: daysFromNow(-10),
        },
      })
    ).id;
    id = await start(["Нашлось"]);
  });

  it("карточка, заведённая после счёта, не закрывается и в план не входит", async () => {
    const fa = await lineOf(id, "FA");
    const counted = await count(id, fa.id, 21); // ожидание 19 → +2
    expect(counted.body.line).toMatchObject({ diff: 2, openProblemQty: 1, allowedDecisions: ["ADJUST", "FOUND"] });
    expect((await decide(id, fa.id, { decision: "FOUND" })).status).toBe(200);
    expect((await detailOf(id)).decisionsPlan).toMatchObject({ foundPositions: 1, foundQty: 1 });

    // Во время инвентаризации приёмка отметила ещё одну «осталась на площадке».
    const countedAt = new Date(counted.body.line.countedAt);
    lateCardId = (
      await prisma.problemItem.create({
        data: {
          equipmentId: eq.FA, quantity: 1, reason: "LEFT_ON_SITE", status: "EXPECTED", source: "RETURN",
          comment: "осталась на площадке", createdBy: "Иван", createdAt: new Date(countedAt.getTime() + 1),
        },
      })
    ).id;

    const line = await lineOf(id, "FA");
    expect(line.openProblemQty).toBe(1);
    expect((await detailOf(id)).decisionsPlan).toMatchObject({ foundPositions: 1, foundQty: 1 });
  });

  it("после счёта завели карточку по излишку без потеряшек — «Нашлось» так и не доступно", async () => {
    const fb = await lineOf(id, "FB");
    const counted = await count(id, fb.id, 6); // ожидание 5 → +1
    expect(counted.body.line).toMatchObject({ diff: 1, openProblemQty: 0, allowedDecisions: ["ADJUST"] });
    await prisma.problemItem.create({
      data: {
        equipmentId: eq.FB, quantity: 1, reason: "LOST", status: "SEARCHING", source: "MANUAL",
        comment: "заведена после счёта", createdBy: "sci_super",
        createdAt: new Date(new Date(counted.body.line.countedAt).getTime() + 1),
      },
    });
    const line = await lineOf(id, "FB");
    expect(line).toMatchObject({ openProblemQty: 0, allowedDecisions: ["ADJUST"] });
    const found = await decide(id, fb.id, { decision: "FOUND" });
    expect(found.status).toBe(400);
    expect(found.body.code).toBe("DECISION_NOT_APPLICABLE");
  });

  it("после «Пересчитать» и нового счёта карточка до пересчёта уже в снапшоте — «Нашлось» доступно", async () => {
    const fb = await lineOf(id, "FB");
    const reset = await request(app).post(`/api/stock-counts/${id}/lines/${fb.id}/reset`).set(auth(whToken));
    expect(reset.status).toBe(200);
    const recount = await count(id, fb.id, 6); // ожидание 4 (1 в потеряшках) → +2
    expect(recount.body.line).toMatchObject({ diff: 2, openProblemQty: 1, allowedDecisions: ["ADJUST", "FOUND"] });
    expect((await decide(id, fb.id, { decision: "FOUND" })).status).toBe(200);
  });

  it("завершение закрывает старую карточку, поздняя остаётся открытой, остаток — без объяснения", async () => {
    const done = await complete(id);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.result).toMatchObject({ foundPositions: 2, foundQty: 2, unexplainedSurplusQty: 2 });
    expect((await prisma.problemItem.findUnique({ where: { id: oldCardId } })).status).toBe("FOUND");
    expect((await prisma.problemItem.findUnique({ where: { id: lateCardId } })).status).toBe("EXPECTED");
  });
});

// ─── «Нашлось» без открытых потеряшек ────────────────────────────────────────

describe("«Нашлось», которому больше нечего закрывать, ждёт решения", () => {
  it("карточку закрыли другим путём — строка снова «без решения», завершение 409, план пуст", async () => {
    await createEquipment("FX", "Нечего закрыть", 3);
    const card = await prisma.problemItem.create({
      data: {
        equipmentId: eq.FX, quantity: 1, reason: "LOST", status: "SEARCHING", source: "MANUAL",
        comment: "пропал", createdBy: "sci_super", createdAt: daysFromNow(-3),
      },
    });
    const id = await start(["Нечего закрыть"]);
    const fx = await lineOf(id, "FX");
    expect((await count(id, fx.id, 3)).body.line.diff).toBe(1); // ожидание 2 → +1
    expect((await decide(id, fx.id, { decision: "FOUND" })).status).toBe(200);
    expect((await detailOf(id)).totals.undecided).toBe(0);

    await prisma.problemItem.update({ where: { id: card.id }, data: { status: "NOT_FOUND", resolvedAt: new Date() } });

    const detail = await detailOf(id);
    expect(detail.totals.undecided).toBe(1);
    expect(detail.decisionsPlan).toMatchObject({ foundPositions: 0, foundQty: 0 });
    expect((await linesOf(id, "?filter=undecided")).map((l) => l.id)).toEqual([fx.id]);
    const line = await lineOf(id, "FX");
    expect(line).toMatchObject({ decision: "FOUND", allowedDecisions: ["ADJUST"] });

    const blocked = await complete(id);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("UNDECIDED_LINES");
    expect(blocked.body.details).toEqual({ count: 1 });

    expect((await request(app).post(`/api/stock-counts/${id}/cancel`).set(auth(saToken))).status).toBe(200);
  });
});

// ─── Кто решил «Ошибку учёта» ────────────────────────────────────────────────

describe("«Ошибка учёта»: в журнале — кто решил, а не только кто завершил", () => {
  it("кладовщик решает, руководитель завершает; пересчёт снимает решившего", async () => {
    await createEquipment("AJ", "Журнал решений", 5);
    const id = await start(["Журнал решений"]);
    const aj = await lineOf(id, "AJ");
    expect((await count(id, aj.id, 3)).body.line.diff).toBe(-2);

    expect((await decide(id, aj.id, { decision: "ADJUST", note: "пересорт" }, whToken)).status).toBe(200);
    expect((await prisma.stockCountLine.findUnique({ where: { id: aj.id } })).decidedById).toBe(whId);
    const decisionAudit = await prisma.auditEntry.findFirst({ where: { action: "STOCK_COUNT_DECISION", entityId: id } });
    expect(decisionAudit.userId).toBe(whId);
    expect(JSON.parse(decisionAudit.after)).toMatchObject({ lineId: aj.id, diff: -2, reason: "пересорт" });

    // Пересчитали (ожидание то же) — решение и решивший сняты.
    const edit = await count(id, aj.id, 4);
    expect(edit.body.line).toMatchObject({ diff: -1, decision: null });
    expect((await prisma.stockCountLine.findUnique({ where: { id: aj.id } })).decidedById).toBeNull();

    expect((await decide(id, aj.id, { decision: "ADJUST", note: "пересорт при закупке" }, whToken)).status).toBe(200);
    const done = await complete(id, saToken);
    expect(done.status, JSON.stringify(done.body)).toBe(200);

    const adjust = await prisma.auditEntry.findFirst({ where: { action: "STOCK_ADJUST", entityId: eq.AJ } });
    expect(adjust.userId).toBe(saId);
    expect(JSON.parse(adjust.after)).toMatchObject({
      totalQuantity: 4,
      reason: "пересорт при закупке",
      decidedBy: "sci_warehouse",
      decidedById: whId,
    });
  });
});

// ─── Подсказки «Как пропало» батчем ──────────────────────────────────────────

describe("подсказки «Как пропало» для «Итога» — те же, что в полном следе строки", () => {
  let id: string;
  const bookingOf: Record<string, string> = {};

  async function returnedByButton(key: string, equipmentId: string, startDays: number, endDays: number, qty: number) {
    const b = await createBooking(`Проект ${key}`, "RETURNED", startDays, endDays, [[equipmentId, qty]]);
    await prisma.auditEntry.create({
      data: {
        userId: saId, action: "BOOKING_RETURNED", entityType: "Booking", entityId: b.id,
        createdAt: daysFromNow(endDays),
      },
    });
    bookingOf[key] = b.id;
    return b;
  }

  beforeAll(async () => {
    const cat = "Подсказки";
    // Окно по умолчанию (60 дней): одна бронь, вернули кнопкой.
    await createEquipment("PD", cat, 10, { sortOrder: 1 });
    await returnedByButton("pd", eq.PD, -6, -5, 2);
    // Прошлая завершённая сверка 5 дней назад: старая бронь вне окна, свежая — в окне.
    await createEquipment("PP", cat, 10, { sortOrder: 2 });
    await returnedByButton("ppOld", eq.PP, -12, -10, 1);
    await returnedByButton("ppNew", eq.PP, -3, -2, 1);
    // lastCountedAt без строки прошлой инвентаризации (старые данные).
    await createEquipment("PL", cat, 10, { sortOrder: 3 });
    await prisma.equipment.update({ where: { id: eq.PL }, data: { lastCountedAt: daysFromNow(-5) } });
    await returnedByButton("plOld", eq.PL, -12, -10, 1);
    await returnedByButton("plNew", eq.PL, -3, -2, 1);
    // Две брони без пересчёта — подсказки нет.
    await createEquipment("PN", cat, 10, { sortOrder: 4 });
    await returnedByButton("pn1", eq.PN, -6, -5, 1);
    await returnedByButton("pn2", eq.PN, -4, -3, 1);
    // Одна бронь, но в мастерской списали и починили — подсказку не даём.
    await createEquipment("PR", cat, 10, { sortOrder: 5 });
    await returnedByButton("pr", eq.PR, -6, -5, 1);
    await prisma.repair.create({
      data: {
        equipmentId: eq.PR, quantity: 1, reason: "сгорел", status: "WROTE_OFF", closedAt: daysFromNow(-4),
        createdBy: saId,
      },
    });
    await prisma.repair.create({
      data: {
        equipmentId: eq.PR, quantity: 2, reason: "перепаяли", status: "CLOSED", closedAt: daysFromNow(-1),
        createdBy: saId,
      },
    });

    // Прошлая инвентаризация: «PP» посчитан и сошёлся; счёт — 5 дней назад.
    const prevId = await start(["Подсказки"]);
    const pp = await lineOf(prevId, "PP");
    expect((await count(prevId, pp.id, 10)).body.line.diff).toBe(0);
    expect((await complete(prevId)).status).toBe(200);
    await prisma.stockCountLine.update({ where: { id: pp.id }, data: { countedAt: daysFromNow(-5) } });
    await prisma.equipment.update({ where: { id: eq.PP }, data: { lastCountedAt: daysFromNow(-5) } });

    id = await start(["Подсказки"]);
    for (const key of ["PD", "PP", "PL", "PN", "PR"]) {
      const line = await lineOf(id, key);
      expect((await count(id, line.id, line.expected.expected - 1)).body.line.diff).toBe(-1);
    }
  });

  it("для каждой недостачи — ровно видимая подсказка полного следа", async () => {
    const res = await request(app).get(`/api/stock-counts/${id}/trail-suggestions`).set(auth(whToken));
    expect(res.status).toBe(200);
    const suggestions = res.body.suggestions as Record<string, any>;
    const lines = await linesOf(id);
    expect(Object.keys(suggestions).sort()).toEqual(lines.map((l) => l.id).sort());

    for (const line of lines) {
      const trailRes = await request(app).get(`/api/stock-counts/${id}/lines/${line.id}/trail`).set(auth(saToken));
      expect(trailRes.status).toBe(200);
      const trail = trailRes.body.trail;
      const visible = trail.bookings.find((b: any) => b.bookingId === trail.suggestedBookingId) ?? null;
      const expected = visible
        ? {
            bookingId: visible.bookingId,
            projectName: visible.projectName,
            clientName: visible.clientName,
            quantity: visible.quantity,
            startDate: visible.startDate,
            endDate: visible.endDate,
          }
        : null;
      expect(suggestions[line.id], line.name).toEqual(expected);
    }

    const byKey = (key: string) => suggestions[lines.find((l) => l.equipmentId === eq[key]).id];
    expect(byKey("PD")?.bookingId).toBe(bookingOf.pd);
    expect(byKey("PP")?.bookingId).toBe(bookingOf.ppNew);
    expect(byKey("PL")?.bookingId).toBe(bookingOf.plNew);
    expect(byKey("PN")).toBeNull();
    expect(byKey("PR")).toBeNull();
  });

  it("мастерская в окне — в следе и в строке: списано / починено за неделю", async () => {
    const pr = await lineOf(id, "PR");
    expect(pr.readyForPickupQty).toBe(2);
    const trail = await request(app).get(`/api/stock-counts/${id}/lines/${pr.id}/trail`).set(auth(saToken));
    expect(trail.body.trail.repairEvents).toEqual({ writtenOffQty: 1, readyForPickupQty: 2 });
    expect(trail.body.trail.suggestedBookingId).toBeNull();
    expect((await lineOf(id, "PD")).readyForPickupQty).toBe(0);
  });

  it("у завершённой / отменённой подсказок не отдаём", async () => {
    expect((await request(app).post(`/api/stock-counts/${id}/cancel`).set(auth(saToken))).status).toBe(200);
    const res = await request(app).get(`/api/stock-counts/${id}/trail-suggestions`).set(auth(saToken));
    expect(res.status).toBe(200);
    expect(res.body.suggestions).toEqual({});
  });
});

// ─── Штучный учёт строки — явным флагом ──────────────────────────────────────

describe("строка отменённой инвентаризации знает, что она штучная", () => {
  it("isUnitMode — по текущему режиму позиции, у всех статусов", async () => {
    await createEquipment("UA", "Режим строки", 4, { sortOrder: 1 });
    await createEquipment("UB", "Режим строки", 4, { sortOrder: 2 });
    const id = await start(["Режим строки"]);
    for (const key of ["UA", "UB"]) {
      const line = await lineOf(id, key);
      expect((await count(id, line.id, 3)).body.line.diff).toBe(-1);
    }
    await prisma.equipment.update({ where: { id: eq.UB }, data: { stockTrackingMode: "UNIT" } });
    expect((await request(app).post(`/api/stock-counts/${id}/cancel`).set(auth(saToken))).status).toBe(200);

    const lines = await linesOf(id);
    const byKey = (key: string) => lines.find((l) => l.equipmentId === eq[key]);
    expect(byKey("UA")).toMatchObject({ isUnitMode: false, allowedDecisions: [] });
    expect(byKey("UB")).toMatchObject({ isUnitMode: true, allowedDecisions: [] });
  });
});

// ─── Охват для старта ────────────────────────────────────────────────────────

describe("GET /api/stock-counts/scope — только то, что инвентаризация посчитает", () => {
  it("штучная категория — 0 к пересчёту, смешанная — только позиции количеством", async () => {
    await createEquipment("SU", "Только штучные", 1, { stockTrackingMode: "UNIT" });
    await createEquipment("SM1", "Смешанная", 3);
    await createEquipment("SM2", "Смешанная", 1, { stockTrackingMode: "UNIT" });

    const res = await request(app).get("/api/stock-counts/scope").set(auth(whToken));
    expect(res.status).toBe(200);
    expect(res.body.categories).toEqual(expect.arrayContaining(["Только штучные", "Смешанная"]));
    expect(res.body.counts["Только штучные"]).toBe(0);
    expect(res.body.unitCounts["Только штучные"]).toBe(1);
    expect(res.body.counts["Смешанная"]).toBe(1);
    expect(res.body.unitCounts["Смешанная"]).toBe(1);

    const anon = await request(app).get("/api/stock-counts/scope").set(apiKey);
    expect(anon.status).toBe(401);
  });
});
