/**
 * Потолок добора в киоске — одна формула со складом (stockCap, P4).
 *
 * Раньше киоск считал сам: сумма пересекающихся броней вместо пика, черновики
 * и архив держали склад, брони на согласовании — нет, «под ответственность»
 * открывалось только при полной занятости. Поиск писал «свободно ×2», а
 * «Добавить» — «Не хватает» (прод, 24.09, «Колёса для А100»). Теперь степпер
 * (`/state` → addCap / ackCap / capHolder), «+» (`POST /items`) и положительная
 * дельта «Готово» (`/complete`) считаются от той же доступности, что витрина.
 *
 * Окно киоска — «выдаю сейчас»: с текущего момента до конца брони.
 */

import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-kiosk-stock-cap.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-kiosk-cap";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-kiosk-cap";
process.env.WAREHOUSE_SECRET = "test-warehouse-kiosk-cap-16";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-kiosk-cap-min16chars";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.now();
// Окно целевых броней — в будущем: киоск выдаёт заранее, окно [сейчас, E).
const S = new Date(NOW + 2 * DAY);
const E = new Date(S.getTime() + 3 * DAY);

let app: any;
let prisma: any;
let whToken: string;
let pinToken: string;
let clientId: string;
let seq = 0;

const H = (token: string) => ({ "X-API-Key": "test-key-kiosk-cap", Authorization: `Bearer ${token}` });

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, DATABASE_URL: `file:${TEST_DB_PATH}`, PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes" },
    stdio: "pipe",
  });
  prisma = (await import("../prisma")).prisma;
  app = (await import("../app")).app;

  const { hashPassword, signSession } = await import("../services/auth");
  const { hashPin, generateToken } = await import("../services/warehouseAuth");
  const wh = await prisma.adminUser.create({
    data: { username: "kcap_wh", passwordHash: await hashPassword("kcap-pass-12345"), role: "WAREHOUSE" },
  });
  whToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });
  // `_system_` сознательно НЕ создаём: аудит PIN-добора должен завести его сам.
  await prisma.warehousePin.create({ data: { name: "Кладовщик Склад", pinHash: await hashPin("246810"), isActive: true } });
  pinToken = generateToken("Кладовщик Склад");
  clientId = (await prisma.client.create({ data: { name: "Клиент киоска" } })).id;
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
  for (const s of ["", "-wal", "-shm", "-journal"]) {
    try { fs.unlinkSync(TEST_DB_PATH + s); } catch { /* ignore */ }
  }
});

async function mkEq(name: string, totalQuantity: number, mode: "COUNT" | "UNIT" = "COUNT") {
  seq += 1;
  return (
    await prisma.equipment.create({
      data: { importKey: `kcap-${seq}`, name, category: "Свет", rentalRatePerShift: "1000", stockTrackingMode: mode, totalQuantity },
    })
  ).id as string;
}

async function mkBooking(
  name: string,
  status: string,
  start: Date,
  end: Date,
  items: Array<[string, number]>,
  extra: Record<string, unknown> = {},
) {
  const b = await prisma.booking.create({
    data: {
      clientId,
      projectName: name,
      startDate: start,
      endDate: end,
      status,
      legacyFinance: false,
      ...(status === "ISSUED" ? { issuedAt: start } : {}),
      ...extra,
      items: { create: items.map(([equipmentId, quantity]) => ({ equipmentId, quantity })) },
      estimates: {
        create: {
          kind: "MAIN",
          shifts: 3,
          subtotal: "0",
          discountAmount: "0",
          totalAfterDiscount: "0",
          lines: {
            create: items.map(([equipmentId, quantity]) => ({
              equipmentId,
              categorySnapshot: "Свет",
              nameSnapshot: name,
              quantity,
              unitPrice: "3000",
              lineSum: String(3000 * quantity),
            })),
          },
        },
      },
    },
  });
  return b.id as string;
}

/** Целевая подтверждённая бронь + открытая в киоске выдача. */
async function issueTarget(name: string, items: Array<[string, number]>) {
  const bookingId = await mkBooking(name, "CONFIRMED", S, E, items);
  const session = await prisma.scanSession.create({
    data: { bookingId, workerName: "Кладовщик Склад", operation: "ISSUE", status: "ACTIVE" },
  });
  return { bookingId, sessionId: session.id as string };
}

async function stateRow(sessionId: string, equipmentId: string) {
  const res = await request(app).get(`/api/warehouse/sessions/${sessionId}/state`).set(H(whToken));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.items.find((i: any) => i.equipmentId === equipmentId);
}

const addItem = (sessionId: string, body: Record<string, unknown>, token = whToken) =>
  request(app).post(`/api/warehouse/sessions/${sessionId}/items`).set(H(token)).send(body);

async function kioskSearchRow(sessionId: string, q: string, equipmentId: string) {
  const res = await request(app).get(`/api/warehouse/sessions/${sessionId}/addon-search`).query({ q }).set(H(whToken));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.results.find((r: any) => r.equipmentId === equipmentId);
}

async function available(equipmentId: string, excludeBookingId: string) {
  const { getAvailability } = await import("../services/availability");
  const [row] = await getAvailability({ startDate: new Date(), endDate: E, equipmentIds: [equipmentId], excludeBookingId });
  return row.availableQuantity as number;
}

describe("степпер /state — та же доступность, что у витрины", () => {
  it("пик, а не сумма: две непересекающиеся чужие брони по 2 из 4 оставляют свободными 2", async () => {
    const eq = await mkEq("Пик 4", 4);
    const first = await mkBooking("Первая половина", "CONFIRMED", S, new Date(S.getTime() + 20 * HOUR), [[eq, 2]]);
    await mkBooking("Вторая половина", "CONFIRMED", new Date(S.getTime() + 2 * DAY), new Date(E.getTime() - HOUR), [[eq, 2]]);
    const { bookingId, sessionId } = await issueTarget("Пик: выдача", [[eq, 1]]);

    const row = await stateRow(sessionId, eq);
    expect(await available(eq, bookingId)).toBe(2);
    expect(row.addCap).toBe(1); // 4 − пик 2 − уже 1 (раньше 4 − 2 − 2 − 1 → 0)
    expect(row.ackCap).toBe(3); // 4 − уже 1
    expect(row.capHolder).toMatchObject({ bookingId: first, projectName: "Первая половина", holderStatus: "CONFIRMED" });
  });

  it("черновик соседа склад не занимает — степпер даёт всё свободное", async () => {
    const eq = await mkEq("Под черновиком 10", 10);
    await mkBooking("Черновик соседа", "DRAFT", S, E, [[eq, 6]]);
    const { sessionId } = await issueTarget("Черновик: выдача", [[eq, 2]]);
    const row = await stateRow(sessionId, eq);
    expect(row.addCap).toBe(8); // раньше 10 − 6 − 2 = 2
    expect(row.ackCap).toBe(8);
    expect(row.capHolder).toBeNull();
  });

  it("бронь на согласовании держит склад — «+» только под ответственность, с держателем", async () => {
    const eq = await mkEq("Согласование 2", 2);
    await mkBooking("Ждёт руководителя", "PENDING_APPROVAL", S, E, [[eq, 2]]);
    const { sessionId } = await issueTarget("Согласование: выдача", [[eq, 1]]);
    const row = await stateRow(sessionId, eq);
    expect(row.addCap).toBe(0); // раньше 1: PENDING_APPROVAL степпер не видел
    expect(row.ackCap).toBe(1);
    expect(row.capHolder).toMatchObject({ holderStatus: "PENDING_APPROVAL", projectName: "Ждёт руководителя" });
  });

  it("мастерская вычитается и из «под ответственность»", async () => {
    const eq = await mkEq("Ремонт 4", 4);
    await prisma.repair.create({ data: { equipmentId: eq, quantity: 2, reason: "сгорел", createdBy: "tester" } });
    const { sessionId } = await issueTarget("Ремонт: выдача", [[eq, 1]]);
    const row = await stateRow(sessionId, eq);
    expect(row.addCap).toBe(1);
    expect(row.ackCap).toBe(1);
    expect(row.capHolder).toBeNull();
  });
});

describe("«+ Добор» в киоске (POST /items)", () => {
  it("поиск «свободно ×2» и «Добавить» больше не расходятся: две непересекающиеся брони не дают ложного конфликта", async () => {
    const eq = await mkEq("Пик без ложного конфликта", 4);
    await mkBooking("Соседи А", "CONFIRMED", S, new Date(S.getTime() + 20 * HOUR), [[eq, 2]]);
    await mkBooking("Соседи Б", "CONFIRMED", new Date(S.getTime() + 2 * DAY), new Date(E.getTime() - HOUR), [[eq, 2]]);
    const { bookingId, sessionId } = await issueTarget("Ложный конфликт: выдача", [[await mkEq("База", 5), 1]]);

    expect((await addItem(sessionId, { equipmentId: eq, quantity: 1 })).status).toBe(201);
    // Вторая и третья штуки сверх свободного — уже настоящий конфликт с держателем.
    const over = await addItem(sessionId, { equipmentId: eq, quantity: 2 });
    expect(over.status).toBe(409);
    expect(over.body.code).toBe("ADDON_CONFLICT");
    expect(over.body.message).toBe("«Пик без ложного конфликта» занят на даты брони");
    expect(over.body.details).toMatchObject({
      projectName: "Соседи А",
      holderStatus: "CONFIRMED",
      freeForUs: 1,
      ackCap: 3,
      equipmentId: eq,
      name: "Пик без ложного конфликта",
      quantity: 2,
    });
    const bi = await prisma.bookingItem.findFirst({ where: { bookingId, equipmentId: eq } });
    expect(bi.quantity).toBe(1);
  });

  it("черновик соседа не мешает «+» (прод 24.09, «Колёса для А100»)", async () => {
    const wheels = await mkEq("Колёса для А100", 2);
    await mkBooking("Чужой черновик", "DRAFT", new Date(S.getTime() - 15 * HOUR), new Date(S.getTime() + 12 * HOUR), [[wheels, 2]]);
    const { sessionId } = await issueTarget("Колёса: выдача", [[await mkEq("База колёс", 5), 1]]);
    const row = await kioskSearchRow(sessionId, "Колёса для А100", wheels);
    expect(row).toMatchObject({ availability: "AVAILABLE", addCap: 2 });
    const add = await addItem(sessionId, { equipmentId: wheels, quantity: 2 });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
  });

  it("архивная бронь соседа склад не занимает", async () => {
    const eq = await mkEq("Под архивом 1", 1);
    await mkBooking("Архив соседа", "CONFIRMED", S, E, [[eq, 1]], { deletedAt: new Date() });
    const { sessionId } = await issueTarget("Архив: выдача", [[await mkEq("База архива", 5), 1]]);
    expect((await kioskSearchRow(sessionId, "Под архивом 1", eq)).addCap).toBe(1);
    expect((await addItem(sessionId, { equipmentId: eq, quantity: 1 })).status).toBe(201);
  });

  it("свободно 2 из 3, нужно 3: предлагается «под ответственность», как и при 0 свободных", async () => {
    const eq = await mkEq("Частично 3", 3);
    await mkBooking("Сосед с одной", "CONFIRMED", S, E, [[eq, 1]]);
    const { bookingId, sessionId } = await issueTarget("Частично: выдача", [[await mkEq("База частично", 5), 1]]);

    const plain = await addItem(sessionId, { equipmentId: eq, quantity: 3 });
    expect(plain.status).toBe(409);
    expect(plain.body.code).toBe("ADDON_CONFLICT"); // раньше ADDON_OVER_STOCK без карточки
    expect(plain.body.details).toMatchObject({ freeForUs: 2, ackCap: 3 });

    const ack = await addItem(sessionId, { equipmentId: eq, quantity: 3, acknowledgedConflict: true });
    expect(ack.status).toBe(201);
    const rec = await prisma.addonRecord.findFirst({ where: { bookingId, equipmentId: eq } });
    expect(rec).toMatchObject({ quantity: 3, acknowledgedConflict: true, sessionId });
  });

  it("под ответственность можно взять и у выданной брони — карточка говорит, что прибор у клиента", async () => {
    const eq = await mkEq("Сетка у клиента", 1);
    const issuedAt = new Date(NOW - DAY);
    await mkBooking("Съёмка идёт", "ISSUED", new Date(NOW - DAY), E, [[eq, 1]], { issuedAt });
    const { sessionId } = await issueTarget("Сетка: выдача", [[await mkEq("База сетки", 5), 1]]);

    const plain = await addItem(sessionId, { equipmentId: eq, quantity: 1 });
    expect(plain.body.code).toBe("ADDON_CONFLICT");
    expect(plain.body.details).toMatchObject({
      holderStatus: "ISSUED",
      issuedAt: issuedAt.toISOString(),
      overdue: false,
      clientName: "Клиент киоска",
    });
    expect((await addItem(sessionId, { equipmentId: eq, quantity: 1, acknowledgedConflict: true })).status).toBe(201);
  });

  it("после добора под ответственность степпер показывает остаток «под ответственность» и держателя", async () => {
    const eq = await mkEq("Две штуки", 2);
    await mkBooking("Держит обе", "CONFIRMED", S, E, [[eq, 2]]);
    const { sessionId } = await issueTarget("Две штуки: выдача", [[await mkEq("База двух", 5), 1]]);
    expect((await addItem(sessionId, { equipmentId: eq, quantity: 1, acknowledgedConflict: true })).status).toBe(201);

    const row = await stateRow(sessionId, eq);
    expect(row).toMatchObject({ quantity: 1, addCap: 0, ackCap: 1, addedOnSite: 1, originalQuantity: 0 });
    expect(row.capHolder).toMatchObject({ projectName: "Держит обе" });
    expect((await addItem(sessionId, { equipmentId: eq, quantity: 1, acknowledgedConflict: true })).status).toBe(201);
    expect((await addItem(sessionId, { equipmentId: eq, quantity: 1, acknowledgedConflict: true })).body.code).toBe("ADDON_OVER_STOCK");
  });

  it("сверх физического склада — ADDON_OVER_STOCK с названием; подтверждение без держателя ничего не расширяет", async () => {
    const eq = await mkEq("Одинокий штатив", 2);
    const { sessionId } = await issueTarget("Штатив: выдача", [[await mkEq("База штатива", 5), 1]]);
    const res = await addItem(sessionId, { equipmentId: eq, quantity: 3, acknowledgedConflict: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ADDON_OVER_STOCK");
    expect(res.body.message).toBe("«Одинокий штатив»: не хватает на складе — можно добрать ещё 2");
    expect(res.body.details).toMatchObject({ equipmentId: eq, name: "Одинокий штатив", addCap: 2, requested: 3, alreadyInBooking: 0 });
  });

  it("на приёмке добор на месте запрещён — ADDON_ONLY_ON_ISSUE", async () => {
    const eq = await mkEq("На приёмке", 5);
    const bookingId = await mkBooking("Приёмка", "ISSUED", new Date(NOW - DAY), E, [[eq, 1]]);
    const ret = await prisma.scanSession.create({ data: { bookingId, workerName: "Кладовщик Склад", operation: "RETURN", status: "ACTIVE" } });
    const res = await addItem(ret.id, { equipmentId: eq, quantity: 1 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ADDON_ONLY_ON_ISSUE");
    expect(res.body.message).toBe("Добор на месте — только при выдаче");
  });

  it("PIN-вход: добор и его аудит в одной транзакции, автор `_system_` с именем кладовщика", async () => {
    expect(await prisma.adminUser.findUnique({ where: { id: "_system_" } })).toBeNull();
    const eq = await mkEq("Аудит PIN", 5);
    const { bookingId, sessionId } = await issueTarget("Аудит: выдача", [[await mkEq("База аудита", 5), 1]]);
    const res = await addItem(sessionId, { equipmentId: eq, quantity: 2 }, pinToken);
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const audit = await prisma.auditEntry.findFirst({ where: { entityId: bookingId, action: "BOOKING_ITEM_ADDED_ON_SITE" } });
    expect(audit.userId).toBe("_system_");
    expect(JSON.parse(audit.after)).toMatchObject({
      via: "kiosk",
      sessionId,
      workerName: "Кладовщик Склад",
      equipmentName: "Аудит PIN",
      quantity: 2,
    });
  });

  it("главная сессия: автор аудита — сотрудник", async () => {
    const eq = await mkEq("Аудит сотрудника", 5);
    const { bookingId, sessionId } = await issueTarget("Аудит сотрудника: выдача", [[await mkEq("База сотрудника", 5), 1]]);
    expect((await addItem(sessionId, { equipmentId: eq, quantity: 1 })).status).toBe(201);
    const audit = await prisma.auditEntry.findFirst({ where: { entityId: bookingId, action: "BOOKING_ITEM_ADDED_ON_SITE" } });
    const wh = await prisma.adminUser.findFirst({ where: { username: "kcap_wh" } });
    expect(audit.userId).toBe(wh.id);
  });
});

describe("штучный учёт (UNIT): добор на месте резервирует экземпляры", () => {
  it("вместо «заглушек» в чек-листе — настоящие свободные экземпляры, их можно отметить", async () => {
    const eq = await mkEq("SkyPanel", 0, "UNIT");
    for (let i = 1; i <= 4; i++) {
      await prisma.equipmentUnit.create({ data: { equipmentId: eq, status: "AVAILABLE", internalInventoryNumber: `KCAP-SKY-${i}` } });
    }
    const { bookingId, sessionId } = await issueTarget("SkyPanel: выдача", [[await mkEq("База SkyPanel", 5), 1]]);

    expect((await addItem(sessionId, { equipmentId: eq, quantity: 2 }, pinToken)).status).toBe(201);
    const reserved = await prisma.bookingItemUnit.findMany({ where: { bookingItem: { bookingId, equipmentId: eq } } });
    expect(reserved).toHaveLength(2);

    const row = await stateRow(sessionId, eq);
    expect(row.trackingMode).toBe("UNIT");
    expect(row.units).toHaveLength(2);
    expect(row.units.some((u: any) => u.unitId.startsWith("placeholder-"))).toBe(false);
    for (const u of row.units) {
      const chk = await request(app).post(`/api/warehouse/sessions/${sessionId}/check`).set(H(pinToken)).send({ equipmentUnitId: u.unitId });
      expect(chk.status).toBe(200);
    }
    // Потолок — оставшиеся свободные экземпляры.
    expect(row.addCap).toBe(2);
    const over = await addItem(sessionId, { equipmentId: eq, quantity: 3 }, pinToken);
    expect(over.body.code).toBe("ADDON_OVER_STOCK");
    expect(over.body.details.addCap).toBe(2);
  });
});

describe("«Готово» со степпером (положительная дельта /complete) — та же формула", () => {
  // Эти проверки завязаны на completeSession (warehouseScan.ts): потолок
  // положительной дельты — stockCap.computeAddCaps, ошибка называет строку.
  it("черновик соседа не гасит «+»: +1 сверх плана проходит", async () => {
    const eq = await mkEq("Степпер под черновиком", 3);
    await mkBooking("Черновик соседа степпера", "DRAFT", S, E, [[eq, 2]]);
    const { sessionId } = await issueTarget("Степпер: выдача", [[eq, 1]]);
    const row = await stateRow(sessionId, eq);
    expect(row.addCap).toBe(2);
    const done = await request(app)
      .post(`/api/warehouse/sessions/${sessionId}/complete`)
      .set(H(whToken))
      .send({ force: true, issuanceAdjustments: [{ bookingItemId: row.bookingItemId, actualQuantity: 2 }] });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
  });

  it("сверх склада — ADDON_OVER_STOCK с bookingItemId строки", async () => {
    const eq = await mkEq("Потолок одной", 1);
    const { sessionId } = await issueTarget("Потолок: выдача", [[eq, 1]]);
    const row = await stateRow(sessionId, eq);
    const done = await request(app)
      .post(`/api/warehouse/sessions/${sessionId}/complete`)
      .set(H(whToken))
      .send({ force: true, issuanceAdjustments: [{ bookingItemId: row.bookingItemId, actualQuantity: 2 }] });
    expect(done.status).toBe(409);
    expect(done.body.code).toBe("ADDON_OVER_STOCK");
    expect(done.body.details).toMatchObject({ bookingItemId: row.bookingItemId, equipmentId: eq, name: "Потолок одной" });
  });

  it("мастерская вычитается и на «Готово»: 4 из 4 при двух в ремонте не проходит", async () => {
    const eq = await mkEq("Ремонт на Готово", 4);
    await prisma.repair.create({ data: { equipmentId: eq, quantity: 2, reason: "треснул корпус", createdBy: "tester" } });
    const { sessionId } = await issueTarget("Ремонт на Готово: выдача", [[eq, 1]]);
    const row = await stateRow(sessionId, eq);
    const done = await request(app)
      .post(`/api/warehouse/sessions/${sessionId}/complete`)
      .set(H(whToken))
      .send({ force: true, issuanceAdjustments: [{ bookingItemId: row.bookingItemId, actualQuantity: 4 }] });
    expect(done.status).toBe(409); // раньше 200: сервер не вычитал мастерскую
    expect(done.body.code).toBe("ADDON_OVER_STOCK");
    expect(done.body.details).toMatchObject({ bookingItemId: row.bookingItemId, addCap: 1 });
  });

  it("добор из «+» остаётся доп-сметой и после правки степпера другой строки", async () => {
    const base = await mkEq("Основной прибор", 10);
    const extra = await mkEq("Добор на месте", 10);
    const { bookingId, sessionId } = await issueTarget("Доп-смета: выдача", [[base, 2]]);
    expect((await addItem(sessionId, { equipmentId: extra, quantity: 2 })).status).toBe(201);
    const row = await stateRow(sessionId, base);
    const done = await request(app)
      .post(`/api/warehouse/sessions/${sessionId}/complete`)
      .set(H(whToken))
      .send({ force: true, issuanceAdjustments: [{ bookingItemId: row.bookingItemId, actualQuantity: 1 }] });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const kinds = (await prisma.estimate.findMany({ where: { bookingId } })).map((e: any) => e.kind).sort();
    expect(kinds).toEqual(["ADDON", "MAIN"]); // раньше добор вливался в MAIN
    const main = await prisma.estimate.findFirst({ where: { bookingId, kind: "MAIN" }, include: { lines: true } });
    expect(main.lines.find((l: any) => l.equipmentId === extra)).toBeUndefined();
  });

  it("бронь соседа на согласовании степпер учитывает: +1 сверх склада без подтверждения не проходит", async () => {
    const eq = await mkEq("Степпер на согласовании", 2);
    await mkBooking("Сосед на согласовании", "PENDING_APPROVAL", S, E, [[eq, 2]]);
    const { sessionId } = await issueTarget("Согласование степпер: выдача", [[eq, 1]]);
    const row = await stateRow(sessionId, eq);
    const done = await request(app)
      .post(`/api/warehouse/sessions/${sessionId}/complete`)
      .set(H(whToken))
      .send({ force: true, issuanceAdjustments: [{ bookingItemId: row.bookingItemId, actualQuantity: 2 }] });
    expect(done.status).toBe(409);
  });
});
