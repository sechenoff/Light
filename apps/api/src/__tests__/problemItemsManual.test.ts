/**
 * «Завести потеряшку» вручную + дополнения реестра (спека инвентаризации §6, §7).
 *
 *  - POST /api/problem-items: позиция без штучного учёта — количеством до «на
 *    полке должно быть», штучная — единицей; причины → статусы; валидации;
 *    аудит; падение доступности.
 *  - Сторож двойного счёта: позиция, посчитанная в идущей инвентаризации, не
 *    принимает ни ручную потеряшку, ни «Найдено» безъюнитной карточки.
 *  - GET /api/problem-items: источник, инвентаризация, позиция у ручных карточек,
 *    фильтр ?source=.
 *  - GET /api/problem-items/trail — «Где видели в последний раз».
 *  - Вещь ещё не на складе: бронь на съёмке (ISSUED / CONFIRMED в окне),
 *    единица на съёмке или в мастерской — ручную потеряшку не принимаем.
 *
 * Тесты идут сверху вниз на одной базе: количество «на полке» уменьшается по
 * мере заведения карточек. Даты — только от Date.now().
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-problem-manual.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-problem-manual";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-problem-manual";
process.env.WAREHOUSE_SECRET = "test-warehouse-problem-manual";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-secret-problem-manual-min16chars";

const DAY = 24 * 60 * 60 * 1000;
const daysFromNow = (d: number) => new Date(Date.now() + d * DAY);

let app: Express;
let prisma: any;

let saToken: string;
let whToken: string;
let techToken: string;
let saId: string;
let whId: string;

const eq: Record<string, string> = {};
const unit: Record<string, string> = {};
let clientId: string;
let issuedBookingId: string;
let returnedBookingId: string;
let returnProblemId: string;
let confirmedNowBookingId: string;
let archivedIssuedBookingId: string;
let lampRepairId: string;

const apiKey = { "X-API-Key": "test-key-problem-manual" };
const auth = (token: string) => ({ ...apiKey, Authorization: `Bearer ${token}` });

async function createEquipment(
  key: string,
  name: string,
  category: string,
  totalQuantity: number,
  mode: "COUNT" | "UNIT" = "COUNT",
) {
  const row = await prisma.equipment.create({
    data: {
      importKey: `pm-${key}`,
      name,
      category,
      totalQuantity,
      rentalRatePerShift: "500",
      stockTrackingMode: mode,
    },
  });
  eq[key] = row.id;
  return row;
}

/** Доступно по /api/availability на окно в будущем, где броней нет. */
async function availableViaApi(equipmentId: string): Promise<number> {
  const start = encodeURIComponent(daysFromNow(14).toISOString());
  const end = encodeURIComponent(daysFromNow(21).toISOString());
  const res = await request(app).get(`/api/availability?start=${start}&end=${end}`).set(auth(saToken));
  expect(res.status).toBe(200);
  const row = res.body.rows.find((r: any) => r.equipmentId === equipmentId);
  expect(row).toBeDefined();
  return row.availableQuantity;
}

async function onShelfExpected(equipmentId: string): Promise<number> {
  const res = await request(app).get(`/api/problem-items/trail?equipmentId=${equipmentId}`).set(auth(saToken));
  expect(res.status).toBe(200);
  return res.body.trail.onShelf.expected;
}

function createManual(token: string, body: Record<string, unknown>) {
  return request(app).post("/api/problem-items").set(auth(token)).send(body);
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
  const hash = await hashPassword("problem-manual-pass");
  const sa = await prisma.adminUser.create({ data: { username: "pm_super", passwordHash: hash, role: "SUPER_ADMIN" } });
  const wh = await prisma.adminUser.create({ data: { username: "pm_warehouse", passwordHash: hash, role: "WAREHOUSE" } });
  const tech = await prisma.adminUser.create({ data: { username: "pm_tech", passwordHash: hash, role: "TECHNICIAN" } });
  saId = sa.id;
  whId = wh.id;
  saToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });
  whToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });
  techToken = signSession({ userId: tech.id, username: tech.username, role: "TECHNICIAN" });

  await createEquipment("cable", "Кабель 10 м", "Свет", 5);
  await createEquipment("stand", "Стойка C-stand", "Свет", 4);
  await createEquipment("flag", "Флаг 18×24", "Грип", 3);
  await createEquipment("hmi", "Прожектор HMI", "Свет", 2, "UNIT");
  await createEquipment("other", "Прожектор LED", "Свет", 1, "UNIT");
  await createEquipment("guardCounted", "Сэндбэг", "Сторож", 6);
  await createEquipment("guardFree", "Грузик", "Сторож", 6);

  unit.hmi1 = (await prisma.equipmentUnit.create({ data: { equipmentId: eq.hmi, serialNumber: "SN-HMI-1" } })).id;
  unit.hmi2 = (await prisma.equipmentUnit.create({ data: { equipmentId: eq.hmi, serialNumber: "SN-HMI-2" } })).id;
  unit.other = (await prisma.equipmentUnit.create({ data: { equipmentId: eq.other } })).id;

  const client = await prisma.client.create({ data: { name: "Кинокомпания «Север»" } });
  clientId = client.id;

  // Кабель: 2 у клиента (ISSUED) → на полке должно быть 5 − 2 = 3.
  const issued = await prisma.booking.create({
    data: {
      clientId,
      projectName: "Сериал «Тихий дом»",
      status: "ISSUED",
      startDate: daysFromNow(-3),
      endDate: daysFromNow(2),
      items: { create: [{ equipmentId: eq.cable, quantity: 2 }] },
    },
  });
  issuedBookingId = issued.id;
  // Возвращённая кнопкой бронь с кабелем — единственный кандидат следа.
  const returned = await prisma.booking.create({
    data: {
      clientId,
      projectName: "Клип «Лето»",
      status: "RETURNED",
      startDate: daysFromNow(-10),
      endDate: daysFromNow(-8),
      items: { create: [{ equipmentId: eq.flag, quantity: 1 }, { equipmentId: eq.cable, quantity: 1 }] },
    },
    include: { items: true },
  });
  returnedBookingId = returned.id;

  // Карточка с приёмки (COUNT, через позицию брони, без прямой ссылки) — для
  // фильтра по источнику и имени через bookingItem. Флаг: 3 − 1 = 2 на полке.
  const flagItem = returned.items.find((i: any) => i.equipmentId === eq.flag);
  returnProblemId = (
    await prisma.problemItem.create({
      data: {
        bookingItemId: flagItem.id,
        sourceBookingId: returned.id,
        quantity: 1,
        reason: "LOST",
        status: "SEARCHING",
        comment: "не вернули с площадки",
        createdBy: "Иван",
      },
    })
  ).id;

  // ── «Вещь ещё не на складе» — свои позиции, чтобы не сдвигать полку кабеля ──
  // Скотч: CONFIRMED с окном вокруг «сейчас» — по календарю 1 на съёмке, 4 − 1 = 3.
  await createEquipment("tape", "Скотч гафферный", "Расходники", 4);
  confirmedNowBookingId = (
    await prisma.booking.create({
      data: {
        clientId,
        projectName: "Реклама «Осень»",
        status: "CONFIRMED",
        startDate: daysFromNow(-1),
        endDate: daysFromNow(1),
        items: { create: [{ equipmentId: eq.tape, quantity: 1 }] },
      },
    })
  ).id;
  // Архивная выданная бронь: в архиве бронь не держит ничего (как в доступности).
  archivedIssuedBookingId = (
    await prisma.booking.create({
      data: {
        clientId,
        projectName: "Короткий метр «Архив»",
        status: "ISSUED",
        startDate: daysFromNow(-6),
        endDate: daysFromNow(-4),
        deletedAt: daysFromNow(-1),
        items: { create: [{ equipmentId: eq.tape, quantity: 1 }] },
      },
    })
  ).id;

  // Прибор: одна единица в мастерской (открытый ремонт), одна на съёмке.
  await createEquipment("lamp", "Прибор Aputure 600d", "Свет", 2, "UNIT");
  unit.lampRepair = (
    await prisma.equipmentUnit.create({ data: { equipmentId: eq.lamp, serialNumber: "SN-AP-1", status: "MAINTENANCE" } })
  ).id;
  unit.lampIssued = (
    await prisma.equipmentUnit.create({ data: { equipmentId: eq.lamp, serialNumber: "SN-AP-2", status: "ISSUED" } })
  ).id;
  lampRepairId = (
    await prisma.repair.create({
      data: {
        unitId: unit.lampRepair,
        equipmentId: eq.lamp,
        status: "WAITING_REPAIR",
        reason: "мигает на полной мощности",
        createdBy: saId,
      },
    })
  ).id;
});

afterAll(async () => {
  await prisma.$disconnect();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const f = TEST_DB_PATH + suffix;
    if (fs.existsSync(f)) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
  }
});

// ─── Вещь ещё не на складе ───────────────────────────────────────────────────
// Идёт первым: полка кабеля ещё 3, и без сторожа карточка бы завелась.

describe("POST /api/problem-items — вещь ещё не вернулась на склад", () => {
  it("409 BOOKING_STILL_OUT: выданная бронь держит позицию — пропажу по ней отметят на приёмке", async () => {
    expect(await onShelfExpected(eq.cable)).toBe(3);

    const res = await createManual(saToken, {
      equipmentId: eq.cable,
      quantity: 1,
      reason: "LEFT_ON_SITE",
      comment: "забыли на площадке",
      sourceBookingId: issuedBookingId,
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("BOOKING_STILL_OUT");
    expect(res.body.details).toEqual({ bookingId: issuedBookingId });

    // Ни карточки, ни второго вычета из полки.
    expect(await prisma.problemItem.count({ where: { equipmentId: eq.cable } })).toBe(0);
    expect(await onShelfExpected(eq.cable)).toBe(3);
  });

  it("409 BOOKING_STILL_OUT: подтверждённая бронь, окно которой накрывает «сейчас»", async () => {
    expect(await onShelfExpected(eq.tape)).toBe(3);

    const res = await createManual(whToken, {
      equipmentId: eq.tape,
      quantity: 1,
      reason: "LOST",
      comment: "гаффер говорит, что потеряли",
      sourceBookingId: confirmedNowBookingId,
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("BOOKING_STILL_OUT");
    expect(await prisma.problemItem.count({ where: { equipmentId: eq.tape } })).toBe(0);
    expect(await onShelfExpected(eq.tape)).toBe(3);
  });

  it("архивная выданная бронь и бронь на съёмке без этой позиции — не мешают", async () => {
    const archived = await createManual(saToken, {
      equipmentId: eq.tape,
      quantity: 1,
      reason: "LOST",
      comment: "в архивной брони значился, на полке нет",
      sourceBookingId: archivedIssuedBookingId,
    });
    expect(archived.status).toBe(201);
    expect(archived.body.item.sourceBookingId).toBe(archivedIssuedBookingId);

    // «Тихий дом» на съёмке, но скотча в его составе нет.
    const otherOut = await createManual(saToken, {
      equipmentId: eq.tape,
      quantity: 1,
      reason: "NOT_ON_SHELF",
      comment: "не нашли при сверке",
      sourceBookingId: issuedBookingId,
    });
    expect(otherOut.status).toBe(201);
    expect(await onShelfExpected(eq.tape)).toBe(1);
  });

  it("409 UNIT_ISSUED: единица на съёмке — её пропажу отметят на приёмке", async () => {
    const res = await createManual(saToken, {
      equipmentId: eq.lamp,
      equipmentUnitId: unit.lampIssued,
      reason: "LOST",
      comment: "клиент звонил, не может найти",
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("UNIT_ISSUED");
    expect(await prisma.problemItem.count({ where: { equipmentUnitId: unit.lampIssued } })).toBe(0);
    const u = await prisma.equipmentUnit.findUnique({ where: { id: unit.lampIssued } });
    expect(u.status).toBe("ISSUED");
  });

  it("409 UNIT_IN_REPAIR: единицу из мастерской не списать и не потерять мимо ремонта", async () => {
    for (const reason of ["DESTROYED", "LOST"]) {
      const res = await createManual(saToken, {
        equipmentId: eq.lamp,
        equipmentUnitId: unit.lampRepair,
        reason,
        comment: "уронили при разборе",
      });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("UNIT_IN_REPAIR");
      expect(res.body.details).toEqual({ repairId: lampRepairId });
    }
    // Ни карточки, ни смены статуса: закрытие ремонта не вернёт в прокат списанное.
    expect(await prisma.problemItem.count({ where: { equipmentUnitId: unit.lampRepair } })).toBe(0);
    const u = await prisma.equipmentUnit.findUnique({ where: { id: unit.lampRepair } });
    expect(u.status).toBe("MAINTENANCE");
    const repair = await prisma.repair.findUnique({ where: { id: lampRepairId } });
    expect(repair.status).toBe("WAITING_REPAIR");
  });

  it("409 UNIT_IN_REPAIR и для единицы, чей статус «доступна», если ремонт по ней открыт", async () => {
    await prisma.equipmentUnit.update({ where: { id: unit.lampIssued }, data: { status: "AVAILABLE" } });
    const repair = await prisma.repair.create({
      data: {
        unitId: unit.lampIssued,
        equipmentId: eq.lamp,
        status: "IN_REPAIR",
        reason: "треснул френель",
        createdBy: saId,
      },
    });
    const res = await createManual(saToken, {
      equipmentId: eq.lamp,
      equipmentUnitId: unit.lampIssued,
      reason: "STOLEN",
      comment: "пропал из мастерской",
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("UNIT_IN_REPAIR");
    expect(res.body.details).toEqual({ repairId: repair.id });
    expect(await prisma.problemItem.count({ where: { equipmentUnitId: unit.lampIssued } })).toBe(0);
  });
});

// ─── Позиция без штучного учёта ──────────────────────────────────────────────

describe("POST /api/problem-items — позиция без штучного учёта", () => {
  it("201: заводит количеством, источник «вручную», доступность падает, аудит от сотрудника", async () => {
    expect(await onShelfExpected(eq.cable)).toBe(3);
    expect(await availableViaApi(eq.cable)).toBe(5);

    const res = await createManual(saToken, {
      equipmentId: eq.cable,
      quantity: 2,
      reason: "NOT_ON_SHELF",
      comment: "  при сверке двух не хватает  ",
      sourceBookingId: returnedBookingId,
    });
    expect(res.status).toBe(201);
    const item = res.body.item;
    expect(item).toMatchObject({
      equipmentId: eq.cable,
      equipmentUnitId: null,
      quantity: 2,
      reason: "NOT_ON_SHELF",
      status: "SEARCHING",
      source: "MANUAL",
      stockCount: null,
      comment: "при сверке двух не хватает",
      createdBy: "pm_super",
      resolvedAt: null,
      equipment: { name: "Кабель 10 м", category: "Свет" },
      booking: { id: returnedBookingId, projectName: "Клип «Лето»" },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/"barcode"/);

    // Доступность и «на полке» уменьшились на 2.
    expect(await availableViaApi(eq.cable)).toBe(3);
    expect(await onShelfExpected(eq.cable)).toBe(1);

    const audit = await prisma.auditEntry.findFirst({
      where: { action: "PROBLEM_ITEM_CREATE", entityId: item.id },
    });
    expect(audit).not.toBeNull();
    expect(audit.userId).toBe(saId);
    expect(audit.entityType).toBe("ProblemItem");
    expect(JSON.parse(audit.after)).toMatchObject({ source: "MANUAL", quantity: 2, equipmentId: eq.cable });
  });

  it("400 QUANTITY_EXCEEDS_SHELF: больше, чем должно лежать на полке", async () => {
    const res = await createManual(saToken, {
      equipmentId: eq.cable,
      quantity: 2,
      reason: "LOST",
      comment: "не нашли",
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("QUANTITY_EXCEEDS_SHELF");
    expect(res.body.details).toEqual({ expected: 1 });
    expect(await prisma.problemItem.count({ where: { equipmentId: eq.cable } })).toBe(1);
  });

  it("201 кладовщику — ровно остаток полки; дальше заводить не из чего", async () => {
    const ok = await createManual(whToken, {
      equipmentId: eq.cable,
      reason: "STOLEN",
      comment: "пропал из машины",
    });
    expect(ok.status).toBe(201);
    expect(ok.body.item).toMatchObject({ quantity: 1, status: "SEARCHING", createdBy: "pm_warehouse" });
    const audit = await prisma.auditEntry.findFirst({
      where: { action: "PROBLEM_ITEM_CREATE", entityId: ok.body.item.id },
    });
    expect(audit.userId).toBe(whId);

    const empty = await createManual(whToken, {
      equipmentId: eq.cable,
      quantity: 1,
      reason: "LOST",
      comment: "ещё один",
    });
    expect(empty.status).toBe(400);
    expect(empty.body.code).toBe("QUANTITY_EXCEEDS_SHELF");
    expect(empty.body.details).toEqual({ expected: 0 });
  });

  it("«Уничтожен» → сразу «Списано», с отметкой разбора; доступность всё равно падает", async () => {
    const res = await createManual(saToken, {
      equipmentId: eq.stand,
      quantity: 1,
      reason: "DESTROYED",
      comment: "раздавили при погрузке",
    });
    expect(res.status).toBe(201);
    expect(res.body.item).toMatchObject({
      status: "WROTE_OFF",
      resolvedBy: "pm_super",
      resolutionNote: "Списано вручную (уничтожено)",
    });
    expect(res.body.item.resolvedAt).not.toBeNull();
    expect(await availableViaApi(eq.stand)).toBe(3);
  });

  it("«Остался на площадке» → «Ожидается» со сроком", async () => {
    const back = daysFromNow(3);
    back.setUTCHours(0, 0, 0, 0);
    const res = await createManual(saToken, {
      equipmentId: eq.flag,
      quantity: 1,
      reason: "LEFT_ON_SITE",
      comment: "гаффер обещал завезти",
      expectedBackDate: back.toISOString(),
      sourceBookingId: returnedBookingId,
    });
    expect(res.status).toBe(201);
    expect(res.body.item.status).toBe("EXPECTED");
    expect(res.body.item.expectedBackDate).toBe(back.toISOString());
    expect(res.body.item.sourceBookingId).toBe(returnedBookingId);
  });
});

// ─── Валидации ───────────────────────────────────────────────────────────────

describe("POST /api/problem-items — валидации", () => {
  it("400 COMMENT_REQUIRED: комментарий короче 3 символов после trim", async () => {
    const res = await createManual(saToken, { equipmentId: eq.stand, reason: "LOST", comment: "  ab  " });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("COMMENT_REQUIRED");
  });

  it("400 EXPECTED_BACK_DATE_NOT_APPLICABLE: срок — только для «Остался на площадке»", async () => {
    const res = await createManual(saToken, {
      equipmentId: eq.stand,
      reason: "LOST",
      comment: "не нашли",
      expectedBackDate: daysFromNow(2).toISOString(),
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("EXPECTED_BACK_DATE_NOT_APPLICABLE");
  });

  it("404: несуществующие позиция и бронь", async () => {
    const noEq = await createManual(saToken, { equipmentId: "nope", reason: "LOST", comment: "не нашли" });
    expect(noEq.status).toBe(404);
    expect(noEq.body.code).toBe("EQUIPMENT_NOT_FOUND");

    const noBooking = await createManual(saToken, {
      equipmentId: eq.stand,
      reason: "LOST",
      comment: "не нашли",
      sourceBookingId: "no-such-booking",
    });
    expect(noBooking.status).toBe(404);
    expect(noBooking.body.code).toBe("BOOKING_NOT_FOUND");
  });

  it("400 (Zod): неизвестная причина, нулевое количество, дата не ISO, нет позиции", async () => {
    for (const body of [
      { equipmentId: eq.stand, reason: "BROKEN", comment: "не нашли" },
      { equipmentId: eq.stand, reason: "LOST", comment: "не нашли", quantity: 0 },
      { equipmentId: eq.stand, reason: "LEFT_ON_SITE", comment: "не нашли", expectedBackDate: "завтра" },
      { reason: "LOST", comment: "не нашли" },
    ]) {
      const res = await createManual(saToken, body);
      expect(res.status).toBe(400);
    }
  });

  it("400 UNIT_NOT_APPLICABLE: единицу у позиции без штучного учёта выбрать нельзя", async () => {
    const res = await createManual(saToken, {
      equipmentId: eq.stand,
      equipmentUnitId: unit.hmi2,
      reason: "LOST",
      comment: "не нашли",
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("UNIT_NOT_APPLICABLE");
  });
});

// ─── Штучная позиция ─────────────────────────────────────────────────────────

describe("POST /api/problem-items — позиция со штучным учётом", () => {
  it("400 UNIT_REQUIRED без единицы и UNIT_NOT_OF_EQUIPMENT для чужой единицы", async () => {
    const noUnit = await createManual(saToken, { equipmentId: eq.hmi, reason: "LOST", comment: "не нашли" });
    expect(noUnit.status).toBe(400);
    expect(noUnit.body.code).toBe("UNIT_REQUIRED");

    const foreign = await createManual(saToken, {
      equipmentId: eq.hmi,
      equipmentUnitId: unit.other,
      reason: "LOST",
      comment: "не нашли",
    });
    expect(foreign.status).toBe(400);
    expect(foreign.body.code).toBe("UNIT_NOT_OF_EQUIPMENT");
  });

  it("400 INVALID_QUANTITY: для единицы — только одна штука", async () => {
    const res = await createManual(saToken, {
      equipmentId: eq.hmi,
      equipmentUnitId: unit.hmi2,
      quantity: 2,
      reason: "LOST",
      comment: "не нашли",
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_QUANTITY");
  });

  it("201: единица уходит в «не найдена», карточка «вручную», аудит в транзакции", async () => {
    const res = await createManual(saToken, {
      equipmentId: eq.hmi,
      equipmentUnitId: unit.hmi1,
      reason: "LOST",
      comment: "не вернулся из павильона",
    });
    expect(res.status).toBe(201);
    expect(res.body.item).toMatchObject({
      equipmentUnitId: unit.hmi1,
      equipmentId: eq.hmi,
      quantity: 1,
      status: "SEARCHING",
      source: "MANUAL",
      createdBy: "pm_super",
      equipment: { name: "Прожектор HMI", category: "Свет" },
    });
    const u = await prisma.equipmentUnit.findUnique({ where: { id: unit.hmi1 } });
    expect(u.status).toBe("MISSING");
    const audit = await prisma.auditEntry.findFirst({
      where: { action: "PROBLEM_ITEM_CREATE", entityId: res.body.item.id },
    });
    expect(audit.userId).toBe(saId);
  });

  it("409 UNIT_ALREADY_MISSING: вторая карточка на пропавшую единицу", async () => {
    const res = await createManual(saToken, {
      equipmentId: eq.hmi,
      equipmentUnitId: unit.hmi1,
      reason: "STOLEN",
      comment: "ещё раз",
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("UNIT_ALREADY_MISSING");
  });
});

// ─── Реестр: источник, позиция, фильтр ───────────────────────────────────────

describe("GET /api/problem-items — источник и позиция", () => {
  it("каждая карточка несёт source, stockCount и позицию; ручные — с названием", async () => {
    const res = await request(app).get("/api/problem-items").set(auth(saToken));
    expect(res.status).toBe(200);
    for (const item of res.body.items) {
      expect(["RETURN", "STOCK_COUNT", "MANUAL"]).toContain(item.source);
      expect("stockCount" in item).toBe(true);
      expect(item.equipment).toEqual(expect.objectContaining({ name: expect.any(String) }));
    }
    const fromReturn = res.body.items.find((i: any) => i.id === returnProblemId);
    expect(fromReturn).toMatchObject({
      source: "RETURN",
      equipment: { name: "Флаг 18×24", category: "Грип" },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/"barcode"/);
  });

  it("?source=MANUAL — только ручные; ?source=RETURN — только с приёмки", async () => {
    const manual = await request(app).get("/api/problem-items?source=MANUAL").set(auth(saToken));
    expect(manual.status).toBe(200);
    expect(manual.body.items.length).toBeGreaterThanOrEqual(5);
    expect(manual.body.items.every((i: any) => i.source === "MANUAL")).toBe(true);
    expect(manual.body.items.map((i: any) => i.id)).not.toContain(returnProblemId);
    expect(manual.body.items.find((i: any) => i.equipmentId === eq.cable).equipment.name).toBe("Кабель 10 м");

    const fromReturn = await request(app).get("/api/problem-items?source=RETURN").set(auth(saToken));
    expect(fromReturn.body.items.map((i: any) => i.id)).toEqual([returnProblemId]);
  });

  it("?source= и ?status= сочетаются; неизвестный источник — 400", async () => {
    const both = await request(app)
      .get("/api/problem-items?source=MANUAL&status=WROTE_OFF")
      .set(auth(saToken));
    expect(both.status).toBe(200);
    expect(both.body.items).toHaveLength(1);
    expect(both.body.items[0].equipment.name).toBe("Стойка C-stand");

    const bad = await request(app).get("/api/problem-items?source=KIOSK").set(auth(saToken));
    expect(bad.status).toBe(400);
  });
});

// ─── Имена за пределами реестра ──────────────────────────────────────────────

describe("позиция ручной карточки видна и вне реестра", () => {
  it("киоск «Поломки» (/api/warehouse/problems) называет позицию, а не «Оборудование»", async () => {
    const res = await request(app).get("/api/warehouse/problems").set(auth(whToken));
    expect(res.status).toBe(200);
    const names = res.body.problems.map((p: any) => p.equipmentName);
    expect(names).toContain("Кабель 10 м");
    expect(names).toContain("Флаг 18×24");
    expect(names).not.toContain("Оборудование");
  });

  it("статистика техники считает безъюнитные карточки инцидентами позиции", async () => {
    const res = await request(app).get("/api/equipment-stats?period=30").set(auth(saToken));
    expect(res.status).toBe(200);
    const row = (key: string) => res.body.table.find((r: any) => r.id === eq[key]);
    expect(row("cable").problemCount).toBe(2); // две ручные карточки
    expect(row("flag").problemCount).toBe(2); // с приёмки (через бронь) + ручная
    expect(row("hmi").problemCount).toBe(1); // через единицу
  });
});

// ─── След ────────────────────────────────────────────────────────────────────

describe("GET /api/problem-items/trail", () => {
  it("отдаёт след позиции: брони окна, подсказку, наличие на полке", async () => {
    const res = await request(app).get(`/api/problem-items/trail?equipmentId=${eq.cable}`).set(auth(whToken));
    expect(res.status).toBe(200);
    const trail = res.body.trail;
    expect(trail).toMatchObject({ equipmentId: eq.cable, name: "Кабель 10 м", windowIsDefault: true });
    expect(trail.onShelf).toMatchObject({ total: 5, issued: 2, lost: 3, expected: 0 });
    expect(trail.bookings.map((b: any) => b.bookingId)).toContain(returnedBookingId);
    // Единственная бронь, принятая не в киоске и не у клиента, — подсказка.
    expect(trail.suggestedBookingId).toBe(returnedBookingId);
    expect(trail.openProblems.reduce((s: number, p: any) => s + p.quantity, 0)).toBe(3);
  });

  it("400 без позиции, 404 для неизвестной", async () => {
    const noParam = await request(app).get("/api/problem-items/trail").set(auth(saToken));
    expect(noParam.status).toBe(400);
    const unknown = await request(app).get("/api/problem-items/trail?equipmentId=nope").set(auth(saToken));
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe("EQUIPMENT_NOT_FOUND");
  });
});

// ─── Сторож двойного счёта ───────────────────────────────────────────────────

describe("сторож двойного счёта с идущей инвентаризацией", () => {
  let stockCountId: string;
  let stockCountNumber: number;
  let foundTargetId: string;
  let notFoundTargetId: string;
  let freeFoundTargetId: string;
  let freeNotFoundTargetId: string;

  const openProblem = async (equipmentId: string, comment: string) =>
    (
      await prisma.problemItem.create({
        data: {
          equipmentId,
          quantity: 1,
          reason: "NOT_ON_SHELF",
          status: "SEARCHING",
          source: "MANUAL",
          comment,
          createdBy: "pm_super",
        },
      })
    ).id;

  beforeAll(async () => {
    foundTargetId = await openProblem(eq.guardCounted, "для «Найдено» по посчитанной");
    notFoundTargetId = await openProblem(eq.guardCounted, "для «Не найдено» по посчитанной");
    freeFoundTargetId = await openProblem(eq.guardFree, "для «Найдено» по непосчитанной");
    freeNotFoundTargetId = await openProblem(eq.guardFree, "для «Не найдено» по непосчитанной");

    const start = await request(app)
      .post("/api/stock-counts")
      .set(auth(saToken))
      .send({ categories: ["Сторож"] });
    expect(start.status).toBe(201);
    stockCountId = start.body.stockCount.id;
    stockCountNumber = start.body.stockCount.number;

    const lines = await request(app).get(`/api/stock-counts/${stockCountId}/lines`).set(auth(saToken));
    const counted = lines.body.lines.find((l: any) => l.equipmentId === eq.guardCounted);
    const count = await request(app)
      .post(`/api/stock-counts/${stockCountId}/lines/${counted.id}/count`)
      .set(auth(saToken))
      .send({ qty: 3 });
    expect(count.status).toBe(200);
  });

  it("409 STOCK_COUNT_LINE_COUNTED: ручная потеряшка по посчитанной позиции", async () => {
    const res = await createManual(saToken, {
      equipmentId: eq.guardCounted,
      quantity: 1,
      reason: "NOT_ON_SHELF",
      comment: "не нашли",
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("STOCK_COUNT_LINE_COUNTED");
    expect(res.body.message).toBe(
      `Позиция уже посчитана в идущей инвентаризации № ${stockCountNumber} — отметьте недостачу там`,
    );
    expect(res.body.details).toEqual({ stockCountId, stockCountNumber });
  });

  it("201: непосчитанная строка не мешает — её ожидание берётся живым", async () => {
    const res = await createManual(whToken, {
      equipmentId: eq.guardFree,
      quantity: 1,
      reason: "LOST",
      comment: "не нашли на полке",
    });
    expect(res.status).toBe(201);
  });

  it("карточка из инвентаризации — в фильтре «инвентаризация» с номером", async () => {
    const sc = await prisma.problemItem.create({
      data: {
        equipmentId: eq.guardFree,
        quantity: 1,
        reason: "NOT_ON_SHELF",
        status: "SEARCHING",
        source: "STOCK_COUNT",
        stockCountId,
        comment: `Не нашли при инвентаризации № ${stockCountNumber}`,
        createdBy: "pm_super",
      },
    });
    const res = await request(app).get("/api/problem-items?source=STOCK_COUNT").set(auth(saToken));
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      id: sc.id,
      source: "STOCK_COUNT",
      stockCount: { id: stockCountId, number: stockCountNumber },
      equipment: { name: "Грузик", category: "Сторож" },
    });
  });

  it("409 на «Найдено» безъюнитной карточки посчитанной позиции; карточка остаётся открытой", async () => {
    const res = await request(app)
      .post(`/api/problem-items/${foundTargetId}/resolve`)
      .set(auth(saToken))
      .send({ outcome: "FOUND", note: "нашёлся за стеллажом" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("STOCK_COUNT_LINE_COUNTED");
    expect(res.body.message).toBe(
      `Позиция уже посчитана в идущей инвентаризации № ${stockCountNumber} — решите там («Нашлось»)`,
    );
    const row = await prisma.problemItem.findUnique({ where: { id: foundTargetId } });
    expect(row.status).toBe("SEARCHING");
  });

  it("409 и на «Не найдено» посчитанной позиции: иначе «Нашлось» строки нечего будет закрыть", async () => {
    const res = await request(app)
      .post(`/api/problem-items/${notFoundTargetId}/resolve`)
      .set(auth(whToken))
      .send({ outcome: "NOT_FOUND", note: "клиент не отвечает" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("STOCK_COUNT_LINE_COUNTED");
    expect(res.body.message).toBe(
      `Позиция уже посчитана в идущей инвентаризации № ${stockCountNumber} — разберите карточку после её завершения — если вещь на полке, это «Нашлось» там`,
    );
    expect(res.body.details).toEqual({ stockCountId, stockCountNumber });
    const row = await prisma.problemItem.findUnique({ where: { id: notFoundTargetId } });
    expect(row.status).toBe("SEARCHING");
  });

  it("«Не найдено» по непосчитанной позиции разрешено", async () => {
    const res = await request(app)
      .post(`/api/problem-items/${freeNotFoundTargetId}/resolve`)
      .set(auth(whToken))
      .send({ outcome: "NOT_FOUND", note: "клиент не отвечает" });
    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({ status: "NOT_FOUND", resolvedBy: "pm_warehouse" });
  });

  it("«Найдено» по непосчитанной позиции разрешено; в журнал — id сотрудника", async () => {
    const res = await request(app)
      .post(`/api/problem-items/${freeFoundTargetId}/resolve`)
      .set(auth(saToken))
      .send({ outcome: "FOUND", note: "нашёлся в кофре" });
    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({ status: "FOUND", resolvedBy: "pm_super" });
    const audit = await prisma.auditEntry.findFirst({
      where: { action: "PROBLEM_ITEM_RESOLVE", entityId: freeFoundTargetId },
    });
    expect(audit.userId).toBe(saId);
  });

  it("после отмены инвентаризации сторож снимается", async () => {
    const cancel = await request(app).post(`/api/stock-counts/${stockCountId}/cancel`).set(auth(saToken));
    expect(cancel.status).toBe(200);

    const created = await createManual(saToken, {
      equipmentId: eq.guardCounted,
      quantity: 1,
      reason: "NOT_ON_SHELF",
      comment: "не нашли",
    });
    expect(created.status).toBe(201);
    const resolved = await request(app)
      .post(`/api/problem-items/${foundTargetId}/resolve`)
      .set(auth(saToken))
      .send({ outcome: "FOUND", note: "нашёлся за стеллажом" });
    expect(resolved.status).toBe(200);
    const notFound = await request(app)
      .post(`/api/problem-items/${notFoundTargetId}/resolve`)
      .set(auth(saToken))
      .send({ outcome: "NOT_FOUND", note: "клиент не отвечает" });
    expect(notFound.status).toBe(200);
    expect(notFound.body.item.status).toBe("NOT_FOUND");
  });
});

// ─── Права ───────────────────────────────────────────────────────────────────

describe("права", () => {
  it("TECHNICIAN → 403 на создание и след; без сессии → 401", async () => {
    const create = await createManual(techToken, { equipmentId: eq.stand, reason: "LOST", comment: "не нашли" });
    expect(create.status).toBe(403);
    expect(create.body.code).toBe("FORBIDDEN_BY_ROLE");

    const trail = await request(app).get(`/api/problem-items/trail?equipmentId=${eq.stand}`).set(auth(techToken));
    expect(trail.status).toBe(403);

    const anon = await request(app)
      .post("/api/problem-items")
      .set(apiKey)
      .send({ equipmentId: eq.stand, reason: "LOST", comment: "не нашли" });
    expect(anon.status).toBe(401);
  });
});
