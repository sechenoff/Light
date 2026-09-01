/**
 * Мастерская v2 — API: названия, риск, история, новые ручки.
 *
 * Главное, что тут зафиксировано:
 *  - у ремонта ВСЕГДА есть название (поломка позиции без штучного учёта роняла
 *    первый экран техника словом «Без позиции»);
 *  - риск имеет ЧЕТЫРЕ состояния, а не флажок «есть бронь»: экран, который
 *    одинаково кричит про сорванную съёмку и про ремонт, который успевает,
 *    перестают читать через неделю;
 *  - штучный ремонт вычитается из подмены РОВНО ОДИН РАЗ (юнит в MAINTENANCE
 *    уже выпал из наличия — наивный вычет посчитал бы его дважды);
 *  - первая запись работ сама переводит карточку в работу (раньше фронт форму
 *    показывал, а сервер отвечал 400 — человек заполнял и получал отказ).
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-repairs-api.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-repairs-api";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-repairs-api";
process.env.WAREHOUSE_SECRET = "test-warehouse-repairs-api";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-secret-repairs-api-min16";

let app: Express;
let prisma: any;

let superAdminToken: string;
let warehouseToken: string;
let technicianToken: string;

let superAdminId: string;
let warehouseId: string;
let technicianId: string;
let clientId: string;

const DAY = 24 * 60 * 60 * 1000;
const daysFromNow = (n: number) => new Date(Date.now() + n * DAY);

const apiKey = { "X-API-Key": "test-key-repairs-api" };
function auth(token: string) {
  return { ...apiKey, Authorization: `Bearer ${token}` };
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

  const mod = await import("../app");
  app = mod.app;
  prisma = (await import("../prisma")).prisma;

  const { hashPassword, signSession } = await import("../services/auth");
  const hash = await hashPassword("repairs-api-pass");

  const sa = await prisma.adminUser.create({
    data: { username: "Пётр Руководитель", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  const wh = await prisma.adminUser.create({
    data: { username: "Иван Кладовщик", passwordHash: hash, role: "WAREHOUSE" },
  });
  const tech = await prisma.adminUser.create({
    data: { username: "Сергей Техник", passwordHash: hash, role: "TECHNICIAN" },
  });
  superAdminId = sa.id;
  warehouseId = wh.id;
  technicianId = tech.id;

  superAdminToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });
  warehouseToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });
  technicianToken = signSession({ userId: tech.id, username: tech.username, role: "TECHNICIAN" });

  const client = await prisma.client.create({ data: { name: "ООО «Кинокомпания»" } });
  clientId = client.id;
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

// ─── Фикстуры ────────────────────────────────────────────────────────────────

let seq = 0;
const uniq = (prefix: string) => `${prefix}-${++seq}`;

async function makeEquipment(opts: {
  name: string;
  totalQuantity?: number;
  mode?: "COUNT" | "UNIT";
  rate?: string;
}) {
  return prisma.equipment.create({
    data: {
      importKey: uniq("repairs-api"),
      name: opts.name,
      category: "Осветительные приборы",
      rentalRatePerShift: opts.rate ?? "2000",
      stockTrackingMode: opts.mode ?? "COUNT",
      totalQuantity: opts.totalQuantity ?? 1,
    },
  });
}

/** Блокирующая бронь на позицию: startDate через `inDays` дней. */
async function makeBooking(equipmentId: string, inDays: number, quantity: number) {
  return prisma.booking.create({
    data: {
      clientId,
      projectName: "Съёмка «Рассвет»",
      startDate: daysFromNow(inDays),
      endDate: daysFromNow(inDays + 2),
      status: "CONFIRMED",
      items: { create: [{ equipmentId, quantity }] },
    },
    include: { items: true },
  });
}

async function makeRepair(data: Record<string, unknown>) {
  return prisma.repair.create({
    data: {
      reason: "Тестовая поломка",
      urgency: "NORMAL",
      createdBy: superAdminId,
      status: "WAITING_REPAIR",
      partsCost: 0,
      totalTimeHours: 0,
      ...data,
    },
  });
}

/** Одна карточка из списка — список фильтруем сервером по unitId нельзя для COUNT. */
async function fetchCard(repairId: string, token = superAdminToken) {
  const res = await request(app).get(`/api/repairs/${repairId}`).set(auth(token));
  expect(res.status).toBe(200);
  return res.body.repair;
}

// ─── п.1: название в три ступени ─────────────────────────────────────────────

describe("Название ремонтируемой позиции", () => {
  it("unit → название с единицы, titleSource=unit", async () => {
    const eq = await makeEquipment({ name: "Aputure 600D", mode: "UNIT" });
    const unit = await prisma.equipmentUnit.create({
      data: { equipmentId: eq.id, barcode: uniq("BC"), status: "MAINTENANCE" },
    });
    const repair = await makeRepair({ unitId: unit.id, equipmentId: eq.id });

    const card = await fetchCard(repair.id);
    expect(card.title).toBe("Aputure 600D");
    expect(card.titleSource).toBe("unit");
  });

  it("без юнита, но со строкой сметы → titleSource=estimate", async () => {
    const eq = await makeEquipment({ name: "Кабель 16А 20м", totalQuantity: 5 });
    const booking = await makeBooking(eq.id, 20, 1);
    const repair = await makeRepair({ bookingItemId: booking.items[0].id });

    const card = await fetchCard(repair.id);
    expect(card.title).toBe("Кабель 16А 20м");
    expect(card.titleSource).toBe("estimate");
  });

  it("только прямая ссылка на каталог → titleSource=catalog", async () => {
    const eq = await makeEquipment({ name: "Стойка Manfrotto", totalQuantity: 4 });
    const repair = await makeRepair({ equipmentId: eq.id });

    const card = await fetchCard(repair.id);
    expect(card.title).toBe("Стойка Manfrotto");
    expect(card.titleSource).toBe("catalog");
  });

  it("позиции не осталось вовсе → название не пустое", async () => {
    const repair = await makeRepair({});
    const card = await fetchCard(repair.id);
    expect(card.title).toBe("Позиция удалена из каталога");
    expect(card.titleSource).toBe("gone");
    // Никакой риск на исчезнувшую позицию не считается — считать нечего.
    expect(card.risk.level).toBe("NONE");
  });
});

// ─── п.3: четыре состояния риска ─────────────────────────────────────────────

describe("risk — четыре состояния", () => {
  it("NONE — блокирующих броней нет", async () => {
    const eq = await makeEquipment({ name: "Риск: без броней", totalQuantity: 3 });
    const repair = await makeRepair({ equipmentId: eq.id, quantity: 1 });

    const { risk } = await fetchCard(repair.id);
    expect(risk.level).toBe("NONE");
    expect(risk.booking).toBeNull();
    expect(risk.inPark).toBe(3);
    expect(risk.inRepair).toBe(1);
    expect(risk.sparesLeft).toBe(2);
    expect(risk.shortfall).toBe(0);
  });

  it("COVERED — подмены хватает, бронь не тронута", async () => {
    const eq = await makeEquipment({ name: "Риск: подмена есть", totalQuantity: 5 });
    await makeBooking(eq.id, 5, 2);
    const repair = await makeRepair({ equipmentId: eq.id, quantity: 1 });

    const { risk } = await fetchCard(repair.id);
    expect(risk.level).toBe("COVERED");
    expect(risk.booking).not.toBeNull();
    expect(risk.booking.projectName).toBe("Съёмка «Рассвет»");
    expect(risk.booking.clientName).toBe("ООО «Кинокомпания»");
    expect(risk.booked).toBe(2);
    expect(risk.sparesLeft).toBe(4);
    expect(risk.shortfall).toBe(0);
  });

  it("BLOCKS — подмены нет и срок не назначен", async () => {
    const eq = await makeEquipment({ name: "Риск: единственный", totalQuantity: 1 });
    await makeBooking(eq.id, 5, 1);
    const repair = await makeRepair({ equipmentId: eq.id, quantity: 1 });

    const { risk } = await fetchCard(repair.id);
    expect(risk.level).toBe("BLOCKS");
    expect(risk.shortfall).toBe(1);
    expect(risk.sparesLeft).toBe(0);
    expect(risk.slackDays).toBeNull();
  });

  it("TIGHT — подмены нет, но срок раньше выдачи; запас в днях", async () => {
    const eq = await makeEquipment({ name: "Риск: успеваем", totalQuantity: 1 });
    await makeBooking(eq.id, 5, 1);
    const repair = await makeRepair({
      equipmentId: eq.id,
      quantity: 1,
      expectedReadyAt: daysFromNow(1),
    });

    const { risk } = await fetchCard(repair.id);
    expect(risk.level).toBe("TIGHT");
    expect(risk.shortfall).toBe(1);
    expect(risk.slackDays).toBe(4);
  });

  it("BLOCKS — срок назначен, но ПОЗЖЕ выдачи", async () => {
    const eq = await makeEquipment({ name: "Риск: опаздываем", totalQuantity: 1 });
    await makeBooking(eq.id, 5, 1);
    const repair = await makeRepair({
      equipmentId: eq.id,
      quantity: 1,
      expectedReadyAt: daysFromNow(9),
    });

    const { risk } = await fetchCard(repair.id);
    expect(risk.level).toBe("BLOCKS");
    expect(risk.slackDays).toBe(-4);
  });

  it("штучный ремонт вычитается ровно один раз (юнит в MAINTENANCE + вычет ремонтов)", async () => {
    const eq = await makeEquipment({ name: "Риск: два юнита", mode: "UNIT", totalQuantity: 2 });
    const broken = await prisma.equipmentUnit.create({
      data: { equipmentId: eq.id, barcode: uniq("BC"), status: "MAINTENANCE" },
    });
    await prisma.equipmentUnit.create({
      data: { equipmentId: eq.id, barcode: uniq("BC"), status: "AVAILABLE" },
    });
    await makeBooking(eq.id, 6, 1);
    const repair = await makeRepair({ unitId: broken.id, equipmentId: eq.id });

    const { risk } = await fetchCard(repair.id);
    // Наивный двойной вычет дал бы sparesLeft = 0 и BLOCKS.
    expect(risk.inPark).toBe(2);
    expect(risk.inRepair).toBe(1);
    expect(risk.sparesLeft).toBe(1);
    expect(risk.level).toBe("COVERED");
  });

  it("бронь на согласовании тоже блокирует (общий BLOCKING_STATUSES)", async () => {
    const eq = await makeEquipment({ name: "Риск: на согласовании", totalQuantity: 1 });
    await prisma.booking.create({
      data: {
        clientId,
        projectName: "Ждёт согласования",
        startDate: daysFromNow(4),
        endDate: daysFromNow(5),
        status: "PENDING_APPROVAL",
        items: { create: [{ equipmentId: eq.id, quantity: 1 }] },
      },
    });
    const repair = await makeRepair({ equipmentId: eq.id, quantity: 1 });

    const { risk } = await fetchCard(repair.id);
    expect(risk.level).toBe("BLOCKS");
  });

  it("закрытый ремонт риска не имеет", async () => {
    const eq = await makeEquipment({ name: "Риск: закрытый", totalQuantity: 1 });
    await makeBooking(eq.id, 5, 1);
    const repair = await makeRepair({
      equipmentId: eq.id,
      status: "CLOSED",
      closedAt: new Date(),
    });

    const { risk } = await fetchCard(repair.id);
    expect(risk.level).toBe("NONE");
    expect(risk.booking).toBeNull();
  });
});

// ─── п.2: обогащение списка ──────────────────────────────────────────────────

describe("GET /api/repairs — элемент списка", () => {
  let listRepairId: string;

  beforeAll(async () => {
    const eq = await makeEquipment({ name: "Список: Skypanel S60", totalQuantity: 2 });
    const repair = await makeRepair({
      equipmentId: eq.id,
      createdBy: warehouseId,
      assignedTo: technicianId,
      status: "IN_REPAIR",
      expectedReadyAt: daysFromNow(3),
      partsNote: "Ждём баллас 4Bank",
    });
    listRepairId = repair.id;

    await prisma.repairWorkLog.create({
      data: {
        repairId: repair.id,
        description: "Разобрал корпус",
        timeSpentHours: 1,
        partCost: 0,
        loggedBy: technicianId,
        loggedAt: new Date("2026-08-01T10:00:00.000Z"),
      },
    });
    await prisma.repairWorkLog.create({
      data: {
        repairId: repair.id,
        description: "Заказал запчасть",
        timeSpentHours: 0.5,
        partCost: 0,
        loggedBy: technicianId,
        loggedAt: new Date("2026-08-03T12:00:00.000Z"),
      },
    });
    await prisma.repairPhoto.create({
      data: { repairId: repair.id, filePath: `repairs/${repair.id}/a.jpg`, createdBy: warehouseId },
    });
  });

  it("отдаёт имена вместо cuid, счётчики и срок", async () => {
    const res = await request(app).get("/api/repairs?limit=200").set(auth(superAdminToken));
    expect(res.status).toBe(200);
    const item = res.body.repairs.find((r: any) => r.id === listRepairId);
    expect(item).toBeTruthy();

    expect(item.title).toBe("Список: Skypanel S60");
    expect(item.titleSource).toBe("catalog");
    expect(item.assignedToName).toBe("Сергей Техник");
    expect(item.createdByName).toBe("Иван Кладовщик");
    expect(item.photoCount).toBe(1);
    expect(item.workLogCount).toBe(2);
    expect(item.lastWorkLogAt).toBe("2026-08-03T12:00:00.000Z");
    expect(item.partsNote).toBe("Ждём баллас 4Bank");
    expect(typeof item.expectedReadyAt).toBe("string");
    expect(item.risk).toBeTruthy();
  });

  it("имя с PIN-входа кладовщика печатается как есть", async () => {
    const eq = await makeEquipment({ name: "Список: PIN-автор", totalQuantity: 1 });
    const repair = await makeRepair({ equipmentId: eq.id, createdBy: "Марина Кладовщик" });

    const card = await fetchCard(repair.id);
    expect(card.createdByName).toBe("Марина Кладовщик");
  });

  it("осиротевший идентификатор не показывается вместо имени", async () => {
    const eq = await makeEquipment({ name: "Список: удалённый автор", totalQuantity: 1 });
    const repair = await makeRepair({ equipmentId: eq.id, createdBy: "cksirotaaaaaaaaaaaaaaaaaa" });

    const card = await fetchCard(repair.id);
    expect(card.createdByName).toBeNull();
  });

  it("?active=true прячет архив, ?active=false показывает только его", async () => {
    const eq = await makeEquipment({ name: "Фильтр активных", totalQuantity: 2 });
    const open = await makeRepair({ equipmentId: eq.id });
    const closed = await makeRepair({
      equipmentId: eq.id,
      status: "CLOSED",
      closedAt: new Date(),
    });

    const active = await request(app).get("/api/repairs?active=true&limit=200").set(auth(superAdminToken));
    const activeIds = active.body.repairs.map((r: any) => r.id);
    expect(activeIds).toContain(open.id);
    expect(activeIds).not.toContain(closed.id);

    const archive = await request(app).get("/api/repairs?active=false&limit=200").set(auth(superAdminToken));
    const archiveIds = archive.body.repairs.map((r: any) => r.id);
    expect(archiveIds).toContain(closed.id);
    expect(archiveIds).not.toContain(open.id);
  });
});

// ─── п.4: история «раньше чинили» ────────────────────────────────────────────

describe("GET /api/repairs/:id — история", () => {
  it("считает закрытые ремонты, деньги и смены аренды", async () => {
    const eq = await makeEquipment({ name: "История: Aputure", mode: "UNIT", rate: "2000" });
    const unit = await prisma.equipmentUnit.create({
      data: { equipmentId: eq.id, barcode: uniq("BC"), status: "MAINTENANCE" },
    });

    const past1 = await makeRepair({
      unitId: unit.id,
      equipmentId: eq.id,
      reason: "Сгорел баллас",
      status: "CLOSED",
      closedAt: daysFromNow(-40),
      partsCost: "3000",
    });
    await prisma.expense.create({
      data: {
        category: "REPAIR",
        amount: "1000",
        name: "Запчасть",
        expenseDate: daysFromNow(-40),
        linkedRepairId: past1.id,
        approved: true,
      },
    });
    await makeRepair({
      unitId: unit.id,
      equipmentId: eq.id,
      reason: "Разбит рассеиватель",
      status: "WROTE_OFF",
      closedAt: daysFromNow(-10),
      partsCost: "2000",
    });

    const current = await makeRepair({ unitId: unit.id, equipmentId: eq.id });
    const card = await fetchCard(current.id);

    expect(card.history.count).toBe(2);
    // 3000 + 1000 + 2000
    expect(card.history.totalCost).toBe("6000");
    expect(card.history.shiftsEquivalent).toBe("3.0");
    // Два закрытых плюс текущий — третий заход по одной позиции.
    expect(card.history.repeated).toBe(true);
    expect(card.history.items).toHaveLength(2);
    const outcomes = card.history.items.map((i: any) => i.outcome).sort();
    expect(outcomes).toEqual(["CLOSED", "WROTE_OFF"]);
    // Сам текущий ремонт в свою же историю не попадает.
    expect(card.history.items.map((i: any) => i.id)).not.toContain(current.id);
  });

  it("нулевая ставка — shiftsEquivalent = null, а не деление на ноль", async () => {
    const eq = await makeEquipment({ name: "История: без ставки", rate: "0", totalQuantity: 2 });
    await makeRepair({
      equipmentId: eq.id,
      status: "CLOSED",
      closedAt: daysFromNow(-5),
      partsCost: "700",
    });
    const current = await makeRepair({ equipmentId: eq.id });

    const card = await fetchCard(current.id);
    expect(card.history.count).toBe(1);
    expect(card.history.totalCost).toBe("700");
    expect(card.history.shiftsEquivalent).toBeNull();
  });

  it("первый ремонт позиции — пустая история", async () => {
    const eq = await makeEquipment({ name: "История: впервые", totalQuantity: 1 });
    const current = await makeRepair({ equipmentId: eq.id });

    const card = await fetchCard(current.id);
    expect(card.history.count).toBe(0);
    expect(card.history.repeated).toBe(false);
    expect(card.history.items).toEqual([]);
  });

  it("журнал работ подписан именем, а не идентификатором", async () => {
    const eq = await makeEquipment({ name: "Журнал: имена", totalQuantity: 1 });
    const repair = await makeRepair({ equipmentId: eq.id, status: "IN_REPAIR", assignedTo: technicianId });
    await prisma.repairWorkLog.create({
      data: {
        repairId: repair.id,
        description: "Пропаял разъём",
        timeSpentHours: 2,
        partCost: 0,
        loggedBy: technicianId,
      },
    });

    const card = await fetchCard(repair.id);
    expect(card.workLog[0].loggedByName).toBe("Сергей Техник");
  });
});

// ─── п.5: POST /api/repairs ──────────────────────────────────────────────────

describe("POST /api/repairs", () => {
  it("201 — WAREHOUSE заводит поломку позиции без штучного учёта", async () => {
    const eq = await makeEquipment({ name: "Создание: зарядка астера", totalQuantity: 4 });
    const res = await request(app)
      .post("/api/repairs")
      .set(auth(warehouseToken))
      .send({ equipmentId: eq.id, quantity: 2, reason: "Не заряжает", urgency: "URGENT" });

    expect(res.status).toBe(201);
    expect(res.body.repair.title).toBe("Создание: зарядка астера");
    expect(res.body.repair.titleSource).toBe("catalog");
    expect(res.body.repair.status).toBe("WAITING_REPAIR");
    expect(res.body.repair.quantity).toBe(2);
    expect(res.body.repair.createdByName).toBe("Иван Кладовщик");
    expect(res.body.repair.risk).toBeTruthy();
  });

  it("201 — TECHNICIAN заводит поломку и сразу назначает срок голой датой", async () => {
    const eq = await makeEquipment({ name: "Создание: срок датой", totalQuantity: 1 });
    const res = await request(app)
      .post("/api/repairs")
      .set(auth(technicianToken))
      .send({
        equipmentId: eq.id,
        reason: "Стучит вентилятор",
        expectedReadyAt: "2026-12-31",
        partsNote: "Вентилятор 80мм",
      });

    expect(res.status).toBe(201);
    // YYYY-MM-DD трактуется как полночь по Москве — единая семантика date-only.
    expect(res.body.repair.expectedReadyAt).toBe("2026-12-30T21:00:00.000Z");
    expect(res.body.repair.partsNote).toBe("Вентилятор 80мм");
  });

  it("201 — конфликт с бронью НЕ блокирует создание, риск приезжает в ответе", async () => {
    const eq = await makeEquipment({ name: "Создание: конфликт", totalQuantity: 1 });
    await makeBooking(eq.id, 3, 1);

    const res = await request(app)
      .post("/api/repairs")
      .set(auth(superAdminToken))
      .send({ equipmentId: eq.id, reason: "Сломан по факту" });

    expect(res.status).toBe(201);
    expect(res.body.repair.risk.level).toBe("BLOCKS");
    expect(res.body.repair.risk.booking).not.toBeNull();
    expect(res.body.repair.risk.booking.no).toMatch(/^#[0-9A-Z]{6}$/);
  });

  it("409 REPAIR_ACTIVE_EXISTS — на единице уже есть активный ремонт", async () => {
    const eq = await makeEquipment({ name: "Создание: занятая единица", mode: "UNIT" });
    const unit = await prisma.equipmentUnit.create({
      data: { equipmentId: eq.id, barcode: uniq("BC"), status: "AVAILABLE" },
    });

    const first = await request(app)
      .post("/api/repairs")
      .set(auth(superAdminToken))
      .send({ equipmentId: eq.id, unitId: unit.id, reason: "Первая карточка" });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post("/api/repairs")
      .set(auth(superAdminToken))
      .send({ equipmentId: eq.id, unitId: unit.id, reason: "Дубль" });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("REPAIR_ACTIVE_EXISTS");
    expect(second.body.details.repairId).toBe(first.body.repair.id);

    // Единица ушла в мастерскую первой же карточкой.
    const unitAfter = await prisma.equipmentUnit.findUnique({ where: { id: unit.id } });
    expect(unitAfter.status).toBe("MAINTENANCE");
  });

  it("400 — не указано, что ремонтируем", async () => {
    const res = await request(app)
      .post("/api/repairs")
      .set(auth(superAdminToken))
      .send({ reason: "Что-то сломалось" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("REPAIR_TARGET_REQUIRED");
  });

  it("аудит REPAIR_CREATE записан", async () => {
    const eq = await makeEquipment({ name: "Создание: аудит", totalQuantity: 1 });
    const res = await request(app)
      .post("/api/repairs")
      .set(auth(superAdminToken))
      .send({ equipmentId: eq.id, reason: "Аудит-тест" });
    expect(res.status).toBe(201);

    const entry = await prisma.auditEntry.findFirst({
      where: { action: "REPAIR_CREATE", entityId: res.body.repair.id },
    });
    expect(entry).not.toBeNull();
    expect(entry.entityType).toBe("Repair");
  });
});

// ─── п.5: PATCH /api/repairs/:id/eta ─────────────────────────────────────────

describe("PATCH /api/repairs/:id/eta", () => {
  it("200 — TECHNICIAN назначает срок: BLOCKS превращается в TIGHT", async () => {
    const eq = await makeEquipment({ name: "Срок: единственный", totalQuantity: 1 });
    await makeBooking(eq.id, 7, 1);
    const repair = await makeRepair({ equipmentId: eq.id });

    const before = await fetchCard(repair.id);
    expect(before.risk.level).toBe("BLOCKS");

    const res = await request(app)
      .patch(`/api/repairs/${repair.id}/eta`)
      .set(auth(technicianToken))
      .send({ expectedReadyAt: daysFromNow(4).toISOString(), partsNote: "Разъём Neutrik NL4" });

    expect(res.status).toBe(200);
    expect(res.body.repair.risk.level).toBe("TIGHT");
    expect(res.body.repair.risk.slackDays).toBe(3);
    expect(res.body.repair.partsNote).toBe("Разъём Neutrik NL4");
  });

  it("200 — срок можно снять (null), риск возвращается в BLOCKS", async () => {
    const eq = await makeEquipment({ name: "Срок: снять", totalQuantity: 1 });
    await makeBooking(eq.id, 7, 1);
    const repair = await makeRepair({ equipmentId: eq.id, expectedReadyAt: daysFromNow(2) });

    const res = await request(app)
      .patch(`/api/repairs/${repair.id}/eta`)
      .set(auth(superAdminToken))
      .send({ expectedReadyAt: null });

    expect(res.status).toBe(200);
    expect(res.body.repair.expectedReadyAt).toBeNull();
    expect(res.body.repair.risk.level).toBe("BLOCKS");
  });

  it("403 — кладовщик срок не назначает", async () => {
    const eq = await makeEquipment({ name: "Срок: роли", totalQuantity: 1 });
    const repair = await makeRepair({ equipmentId: eq.id });

    const res = await request(app)
      .patch(`/api/repairs/${repair.id}/eta`)
      .set(auth(warehouseToken))
      .send({ expectedReadyAt: daysFromNow(3).toISOString() });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN_BY_ROLE");
  });

  it("400 — пустое тело: нечего менять", async () => {
    const eq = await makeEquipment({ name: "Срок: пустое тело", totalQuantity: 1 });
    const repair = await makeRepair({ equipmentId: eq.id });

    const res = await request(app)
      .patch(`/api/repairs/${repair.id}/eta`)
      .set(auth(superAdminToken))
      .send({});
    expect(res.status).toBe(400);
  });

  it("400 — мусор вместо даты", async () => {
    const eq = await makeEquipment({ name: "Срок: мусор", totalQuantity: 1 });
    const repair = await makeRepair({ equipmentId: eq.id });

    const res = await request(app)
      .patch(`/api/repairs/${repair.id}/eta`)
      .set(auth(superAdminToken))
      .send({ expectedReadyAt: "как-нибудь на неделе" });
    expect(res.status).toBe(400);
  });

  it("400 — закрытому ремонту срок не назначают", async () => {
    const eq = await makeEquipment({ name: "Срок: закрытый", totalQuantity: 1 });
    const repair = await makeRepair({
      equipmentId: eq.id,
      status: "CLOSED",
      closedAt: new Date(),
    });

    const res = await request(app)
      .patch(`/api/repairs/${repair.id}/eta`)
      .set(auth(superAdminToken))
      .send({ expectedReadyAt: daysFromNow(3).toISOString() });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("REPAIR_ALREADY_CLOSED");
  });
});

// ─── п.8.3: первая запись работ стартует ремонт ──────────────────────────────

describe("POST /api/repairs/:id/work-log — автостарт", () => {
  it("201 — запись в статусе «Ждёт ремонта» переводит в работу и назначает автора", async () => {
    const eq = await makeEquipment({ name: "Автостарт: свободная карточка", totalQuantity: 1 });
    const repair = await makeRepair({ equipmentId: eq.id });

    const res = await request(app)
      .post(`/api/repairs/${repair.id}/work-log`)
      .set(auth(technicianToken))
      .send({ description: "Продиагностировал", timeSpentHours: 1.5, partCost: 300 });

    expect(res.status).toBe(201);
    expect(res.body.repair.status).toBe("IN_REPAIR");
    expect(res.body.repair.assignedTo).toBe(technicianId);

    // Смена статуса видна в аудите отдельной записью.
    const entry = await prisma.auditEntry.findFirst({
      where: { action: "REPAIR_STATUS_CHANGE", entityId: repair.id },
    });
    expect(entry).not.toBeNull();

    // Вторая запись работ проходит уже обычным путём.
    const second = await request(app)
      .post(`/api/repairs/${repair.id}/work-log`)
      .set(auth(technicianToken))
      .send({ description: "Собрал обратно", timeSpentHours: 0.5, partCost: 0 });
    expect(second.status).toBe(201);
    expect(Number(second.body.repair.totalTimeHours)).toBe(2);
  });

  it("403 — карточку уже взял другой техник", async () => {
    const eq = await makeEquipment({ name: "Автостарт: чужая карточка", totalQuantity: 1 });
    const repair = await makeRepair({ equipmentId: eq.id, assignedTo: superAdminId });

    const res = await request(app)
      .post(`/api/repairs/${repair.id}/work-log`)
      .set(auth(technicianToken))
      .send({ description: "Влез в чужой ремонт", timeSpentHours: 1, partCost: 0 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("WORK_LOG_FORBIDDEN");
  });

  it("400 — записать работы в закрытый ремонт нельзя", async () => {
    const eq = await makeEquipment({ name: "Автостарт: закрытый", totalQuantity: 1 });
    const repair = await makeRepair({
      equipmentId: eq.id,
      status: "CLOSED",
      closedAt: new Date(),
      assignedTo: technicianId,
    });

    const res = await request(app)
      .post(`/api/repairs/${repair.id}/work-log`)
      .set(auth(technicianToken))
      .send({ description: "Поздно", timeSpentHours: 1, partCost: 0 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("REPAIR_ALREADY_CLOSED");
  });
});
