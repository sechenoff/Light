/**
 * Чек-лист киоска (`GET /sessions/:id/state`) и отметки единиц — P5, P16, P1.
 *
 *  - Приёмка не показывает строки ×0: позицию сняли на выдаче до нуля, а экран
 *    приёмки требовал «Помечьте все 0 шт» и не пускал дальше («Дора»).
 *  - Произвольная позиция — своя категория и цена, а не «Добавлено на месте»
 *    за 0 ₽; с основной сметой сопоставляется по названию.
 *  - Чек-лист несёт всё, что нужно экрану без лишних запросов: сессию, бронь,
 *    цены строк основной сметы, добор этой сессии, версию состава.
 *  - Читать и отмечать можно только живую сессию: завершённая и прерванная
 *    отвечают своим кодом, устаревшая (бронь выдали кнопкой) закрывается.
 */

import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-checklist-state-return.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-cl-state-ret";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-cl-state-ret";
process.env.WAREHOUSE_SECRET = "test-warehouse-cl-state-ret-16";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-cl-state-ret-min16chars";
process.env.APPROVAL_MODE = "auto";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.now();

let app: any;
let prisma: any;
let saToken: string;
let whToken: string;
let clientId: string;
let seq = 0;

const H = (token: string) => ({ "X-API-Key": "test-key-cl-state-ret", Authorization: `Bearer ${token}` });

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, DATABASE_URL: `file:${TEST_DB_PATH}`, PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes" },
    stdio: "pipe",
  });
  prisma = (await import("../prisma")).prisma;
  app = (await import("../app")).app;
  const { hashPassword, signSession } = await import("../services/auth");
  const hash = await hashPassword("cl-state-ret-pass");
  const sa = await prisma.adminUser.create({ data: { username: "clsr_sa", passwordHash: hash, role: "SUPER_ADMIN" } });
  const wh = await prisma.adminUser.create({ data: { username: "clsr_wh", passwordHash: hash, role: "WAREHOUSE" } });
  saToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });
  whToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });
  clientId = (await prisma.client.create({ data: { name: "Клиент приёмки" } })).id;
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
  for (const s of ["", "-wal", "-shm", "-journal"]) {
    try { fs.unlinkSync(TEST_DB_PATH + s); } catch { /* ignore */ }
  }
});

async function mkEq(name: string, totalQuantity = 10, mode: "COUNT" | "UNIT" = "COUNT") {
  seq += 1;
  return (
    await prisma.equipment.create({
      data: { importKey: `clsr-${seq}`, name, category: "Грип", rentalRatePerShift: "150", stockTrackingMode: mode, totalQuantity },
    })
  ).id as string;
}

async function mkSession(bookingId: string, operation: "ISSUE" | "RETURN", extra: Record<string, unknown> = {}) {
  return (
    await prisma.scanSession.create({
      data: { bookingId, workerName: "Кладовщик Приёмка", operation, status: "ACTIVE", ...extra },
    })
  ).id as string;
}

const getState = (sessionId: string) =>
  request(app).get(`/api/warehouse/sessions/${sessionId}/state`).set(H(whToken));

describe("приёмка: строки ×0 в чек-лист не попадают", () => {
  it("обнулённая на выдаче строка не приходит в чек-лист приёмки; версия состава считается по всем строкам", async () => {
    const keep = await mkEq("Штатив");
    const zero = await mkEq("Удлинитель");
    const booking = await prisma.booking.create({
      data: {
        clientId,
        projectName: "Дора",
        startDate: new Date(NOW - DAY),
        endDate: new Date(NOW + DAY),
        status: "ISSUED",
        issuedAt: new Date(NOW - DAY),
        items: { create: [{ equipmentId: keep, quantity: 2 }, { equipmentId: zero, quantity: 0 }] },
      },
      include: { items: true },
    });
    const sessionId = await mkSession(booking.id, "RETURN");

    const res = await getState(sessionId);
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: any) => i.equipmentId)).toEqual([keep]);
    expect(res.body.items.every((i: any) => i.quantity > 0)).toBe(true);
    expect(res.body.progress.totalItems).toBe(1);
    expect(res.body.items[0]).toMatchObject({ addCap: 0, ackCap: 0, capHolder: null });

    const { computeItemsVersion } = await import("../services/scanSessionPolicy");
    expect(res.body.itemsVersion).toBe(computeItemsVersion(booking.items));
  });

  it("сквозной путь киоска: снятая при выдаче до 0 позиция не мешает приёмке", async () => {
    const clamp = await mkEq("Super Clamp", 5);
    const pin = await mkEq("Прищепка большая", 10);
    const start = new Date(NOW + HOUR);
    start.setUTCMinutes(0, 0, 0);
    const draft = await request(app).post("/api/bookings/draft").set(H(saToken)).send({
      client: { name: "Клиент приёмки" },
      projectName: "Обнуление на выдаче",
      startDate: start.toISOString(),
      endDate: new Date(start.getTime() + DAY).toISOString(),
      items: [{ equipmentId: pin, quantity: 3 }, { equipmentId: clamp, quantity: 2 }],
    });
    expect(draft.status, JSON.stringify(draft.body)).toBe(200);
    const bookingId = draft.body.booking?.id ?? draft.body.id;
    expect((await request(app).post(`/api/bookings/${bookingId}/submit-for-approval`).set(H(saToken)).send({})).status).toBe(200);

    const issue = await request(app).post("/api/warehouse/sessions").set(H(whToken)).send({ bookingId, operation: "ISSUE" });
    expect(issue.status, JSON.stringify(issue.body)).toBe(201);
    const clampItem = await prisma.bookingItem.findFirst({ where: { bookingId, equipmentId: clamp } });
    const done = await request(app)
      .post(`/api/warehouse/sessions/${issue.body.session.id}/complete`)
      .set(H(whToken))
      .send({ issuanceAdjustments: [{ bookingItemId: clampItem.id, actualQuantity: 0 }] });
    expect(done.status, JSON.stringify(done.body)).toBe(200);

    const ret = await request(app).post("/api/warehouse/sessions").set(H(whToken)).send({ bookingId, operation: "RETURN" });
    expect(ret.status, JSON.stringify(ret.body)).toBe(201);
    const st = await getState(ret.body.session.id);
    expect(st.status).toBe(200);
    expect(st.body.items.find((i: any) => i.bookingItemId === clampItem.id)).toBeUndefined();
    expect(st.body.items.every((i: any) => i.quantity > 0)).toBe(true);
  });
});

describe("поля чек-листа для экрана выдачи", () => {
  it("сессия, бронь, черновик и цены строк основной сметы", async () => {
    const light = await mkEq("Astera Titan", 10);
    const flag = await mkEq("Флаг 4×4", 10);
    const booking = await prisma.booking.create({
      data: {
        clientId,
        projectName: "Цены строк",
        startDate: new Date(NOW + DAY),
        endDate: new Date(NOW + 3 * DAY),
        status: "CONFIRMED",
        finalAmount: "12345.5",
        manualFinalAmount: "12000",
        items: {
          create: [
            { equipmentId: light, quantity: 2 },
            { equipmentId: flag, quantity: 3 },
            { customName: "Пиротехник на площадке", customCategory: "Услуги", customUnitPrice: "7000", quantity: 1 },
            { customName: "Сухой лёд", customUnitPrice: "2500", quantity: 1 },
          ],
        },
        estimates: {
          create: {
            kind: "MAIN",
            shifts: 2,
            subtotal: "0",
            discountPercent: "50",
            discountAmount: "0",
            totalAfterDiscount: "9000",
            lines: {
              create: [
                { equipmentId: light, categorySnapshot: "Грип", nameSnapshot: "Astera Titan", quantity: 2, unitPrice: "2000", lineSum: "4000", listUnitPrice: "3000" },
                { equipmentId: flag, categorySnapshot: "Грип", nameSnapshot: "Флаг 4×4", quantity: 1, unitPrice: "300", lineSum: "300" },
                { equipmentId: null, categorySnapshot: "Услуги", nameSnapshot: "Пиротехник на площадке", quantity: 1, unitPrice: "7000", lineSum: "7000" },
              ],
            },
          },
        },
      },
      include: { items: true },
    });
    const sessionId = await mkSession(booking.id, "ISSUE");
    const flagItem = booking.items.find((i: any) => i.equipmentId === flag);
    // Добор этой сессии и добор чужой (прошлой) сессии — видна только своя дельта.
    await prisma.addonRecord.create({ data: { bookingId: booking.id, sessionId, bookingItemId: flagItem.id, equipmentId: flag, quantity: 2, createdBy: "Кладовщик Приёмка" } });
    const oldSession = await mkSession(booking.id, "ISSUE", { status: "CANCELLED" });
    await prisma.addonRecord.create({ data: { bookingId: booking.id, sessionId: oldSession, bookingItemId: flagItem.id, equipmentId: flag, quantity: 5, createdBy: "кто-то" } });

    const res = await getState(sessionId);
    expect(res.status).toBe(200);
    const body = res.body;
    expect(body.session).toMatchObject({ status: "ACTIVE", operation: "ISSUE", workerName: "Кладовщик Приёмка" });
    expect(typeof body.session.startedAt).toBe("string");
    expect(body.booking).toMatchObject({
      status: "CONFIRMED",
      startDate: booking.startDate.toISOString(),
      endDate: booking.endDate.toISOString(),
      finalAmount: "12345.5",
      manualFinalAmount: "12000",
    });
    expect(body).toMatchObject({ draft: null, draftRevision: 0, draftSavedAt: null, draftSavedBy: null, shifts: 2, discountPercent: "50" });
    expect(typeof body.itemsVersion).toBe("string");

    const byName = (n: string) => body.items.find((i: any) => i.equipmentName === n);
    expect(byName("Astera Titan")).toMatchObject({ mainUnitPrice: "2000", mainNegotiated: true, originalQuantity: 2, addedOnSite: 0, customUnitPrice: null });
    expect(byName("Флаг 4×4")).toMatchObject({ mainUnitPrice: "300", mainNegotiated: false, originalQuantity: 1, addedOnSite: 2 });
    expect(byName("Пиротехник на площадке")).toMatchObject({
      category: "Услуги",
      isExtra: false,
      customUnitPrice: "7000",
      mainUnitPrice: "7000",
      originalQuantity: 1,
      rentalRatePerShift: "0",
      addCap: 0,
      ackCap: 0,
    });
    // Своей категории нет — «Прочее», в основной смете строки нет.
    expect(byName("Сухой лёд")).toMatchObject({ category: "Прочее", customUnitPrice: "2500", mainUnitPrice: null, originalQuantity: 0 });
  });
});

describe("читать и отмечать можно только живую сессию", () => {
  it("бронь выдали кнопкой — /state закрывает устаревшую выдачу и отвечает SESSION_STALE", async () => {
    const eq = await mkEq("Устаревшая выдача", 5);
    const booking = await prisma.booking.create({
      data: {
        clientId, projectName: "Выдали кнопкой", startDate: new Date(NOW - HOUR), endDate: new Date(NOW + DAY),
        status: "ISSUED", issuedAt: new Date(), items: { create: [{ equipmentId: eq, quantity: 1 }] },
      },
    });
    const sessionId = await mkSession(booking.id, "ISSUE");

    const res = await getState(sessionId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("SESSION_STALE");
    expect(res.body.details).toMatchObject({ sessionId, operation: "ISSUE", bookingStatus: "ISSUED" });
    expect(await prisma.scanSession.findUnique({ where: { id: sessionId } })).toMatchObject({ status: "CANCELLED", cancelReason: "STALE" });

    // Повторное обращение — уже прерванная сессия.
    const again = await getState(sessionId);
    expect(again.body.code).toBe("SESSION_CANCELLED");
  });

  it("завершённая сессия: /state, отметка и снятие отметки — SESSION_ALREADY_COMPLETED", async () => {
    const eq = await mkEq("Завершённая", 5);
    const booking = await prisma.booking.create({
      data: {
        clientId, projectName: "Уже выдано", startDate: new Date(NOW - HOUR), endDate: new Date(NOW + DAY),
        status: "CONFIRMED", items: { create: [{ equipmentId: eq, quantity: 1 }] },
      },
    });
    const sessionId = await mkSession(booking.id, "ISSUE", { status: "COMPLETED", completedAt: new Date(), completedBy: "Иван" });
    const res = await getState(sessionId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("SESSION_ALREADY_COMPLETED");
    expect(res.body.details).toMatchObject({ completedBy: "Иван" });

    const { checkUnit, uncheckUnit } = await import("../services/checklistService");
    await expect(checkUnit(sessionId, "any-unit")).rejects.toMatchObject({ status: 409, code: "SESSION_ALREADY_COMPLETED" });
    await expect(uncheckUnit(sessionId, "any-unit")).rejects.toMatchObject({ status: 409, code: "SESSION_ALREADY_COMPLETED" });
  });

  it("несуществующая сессия — 404 SESSION_NOT_FOUND", async () => {
    const res = await getState("no-such-session");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("SESSION_NOT_FOUND");
  });

  it("приёмка: отметить можно только единицу, выданную по этой брони", async () => {
    const eq = await mkEq("Штучный прибор", 0, "UNIT");
    const mine = await prisma.equipmentUnit.create({ data: { equipmentId: eq, status: "ISSUED", internalInventoryNumber: "CLSR-U-1" } });
    const other = await prisma.equipmentUnit.create({ data: { equipmentId: eq, status: "AVAILABLE", internalInventoryNumber: "CLSR-U-2" } });
    const booking = await prisma.booking.create({
      data: {
        clientId, projectName: "Штучная приёмка", startDate: new Date(NOW - DAY), endDate: new Date(NOW + DAY),
        status: "ISSUED", issuedAt: new Date(NOW - DAY),
        items: { create: [{ equipmentId: eq, quantity: 1, unitReservations: { create: [{ equipmentUnitId: mine.id }] } }] },
      },
    });
    const sessionId = await mkSession(booking.id, "RETURN");
    const { checkUnit, uncheckUnit } = await import("../services/checklistService");

    await expect(checkUnit(sessionId, other.id)).rejects.toMatchObject({ status: 409, code: "UNIT_NOT_RESERVED" });
    expect(await checkUnit(sessionId, mine.id)).toEqual({ alreadyChecked: false });
    expect(await checkUnit(sessionId, mine.id)).toEqual({ alreadyChecked: true });

    const st = await getState(sessionId);
    expect(st.body.items[0].units).toEqual([expect.objectContaining({ unitId: mine.id, checked: true })]);
    expect(await uncheckUnit(sessionId, mine.id)).toEqual({ wasChecked: true });
    expect(await uncheckUnit(sessionId, mine.id)).toEqual({ wasChecked: false });
  });
});
