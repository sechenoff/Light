/**
 * Интеграционные тесты сводки мастерской: GET /api/dashboard/repair-stats.
 *
 * Проверяем три вещи, в которых ошибиться дороже всего:
 *   1) деньги видит только руководитель — техник и кладовщик получают null;
 *   2) границы окон «этот месяц / прошлый месяц» — иначе база сравнения врёт
 *      ровно в первые дни месяца, когда на неё и смотрят;
 *   3) «Вернулось из ремонта» — окно ровно 7 суток и только починенное.
 *
 * База своя (TEST_DB_PATH), между тестами мастерская чистится: ручка считает
 * агрегаты по ВСЕЙ таблице, и остатки соседнего теста ломали бы счётчики.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-repair-stats.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-repair-stats";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-repair-stats";
process.env.JWT_SECRET = "test-jwt-secret-repair-stats-min16chars";

const DAY_MS = 86400000;

let app: Express;
let prisma: any;
let superAdminToken: string;
let warehouseToken: string;
let technicianToken: string;
/** AdminUser.id руководителя — им подписываем createdBy у расходов и ремонтов. */
let superAdminId: string;

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
  const pmod = await import("../prisma");
  prisma = pmod.prisma;

  const { hashPassword, signSession } = await import("../services/auth");
  const hash = await hashPassword("test-pass-123");

  const admin = await prisma.adminUser.create({
    data: { username: "rs_super_admin", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  superAdminId = admin.id;
  superAdminToken = signSession({ userId: admin.id, username: admin.username, role: "SUPER_ADMIN" });

  const warehouse = await prisma.adminUser.create({
    data: { username: "rs_warehouse", passwordHash: hash, role: "WAREHOUSE" },
  });
  warehouseToken = signSession({
    userId: warehouse.id,
    username: warehouse.username,
    role: "WAREHOUSE",
  });

  const tech = await prisma.adminUser.create({
    data: { username: "rs_technician", passwordHash: hash, role: "TECHNICIAN" },
  });
  technicianToken = signSession({ userId: tech.id, username: tech.username, role: "TECHNICIAN" });
});

afterAll(async () => {
  await prisma.$disconnect();
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = TEST_DB_PATH + suffix;
    if (fs.existsSync(f)) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* игнорируем */
      }
    }
  }
});

function AUTH_SA() {
  return { "X-API-Key": "test-key-1", Authorization: `Bearer ${superAdminToken}` };
}
function AUTH_WH() {
  return { "X-API-Key": "test-key-1", Authorization: `Bearer ${warehouseToken}` };
}
function AUTH_TECH() {
  return { "X-API-Key": "test-key-1", Authorization: `Bearer ${technicianToken}` };
}

// ── Хелперы ──────────────────────────────────────────────────────────────────

/**
 * Мастерская обнуляется перед каждым тестом: расходы → ремонты → брони.
 * Порядок важен — Expense.linkedRepairId и Repair.sourceBookingId держат ссылки.
 */
async function resetWorkshop() {
  await prisma.expense.deleteMany();
  await prisma.repairWorkLog.deleteMany();
  await prisma.repair.deleteMany();
  await prisma.bookingItem.deleteMany();
  await prisma.booking.deleteMany();
}

let equipmentSeq = 0;
async function createEquipment(name: string, totalQuantity = 5, mode = "COUNT") {
  equipmentSeq += 1;
  return prisma.equipment.create({
    data: {
      importKey: `СВЕТ||${name.toUpperCase()}||${equipmentSeq}||`,
      name,
      category: "Свет",
      totalQuantity,
      stockTrackingMode: mode,
      rentalRatePerShift: 1000,
    },
  });
}

async function createUnit(equipmentId: string, status = "MAINTENANCE") {
  return prisma.equipmentUnit.create({ data: { equipmentId, status } });
}

async function createRepair(data: Record<string, unknown>) {
  return prisma.repair.create({
    data: {
      reason: "Не включается",
      createdBy: superAdminId,
      ...data,
    },
  });
}

async function createExpense(data: Record<string, unknown>) {
  return prisma.expense.create({
    data: {
      name: "Замена блока питания",
      amount: 1000,
      expenseDate: new Date(),
      createdBy: superAdminId,
      ...data,
    },
  });
}

async function statsAs(headers: Record<string, string>) {
  const res = await request(app).get("/api/dashboard/repair-stats").set(headers);
  expect(res.status).toBe(200);
  return res.body;
}

// Границы окон считаем ровно так же, как роут: локальный календарный месяц.
function monthStart(offset = 0) {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + offset, 1, 0, 0, 0, 0);
}

beforeEach(async () => {
  await resetWorkshop();
});

// ── Роли ─────────────────────────────────────────────────────────────────────

describe("repair-stats: денежные поля — только руководителю", () => {
  beforeEach(async () => {
    const repair = await createRepair({ status: "IN_REPAIR" });
    await createExpense({ linkedRepairId: repair.id, approved: true, amount: 5000 });
    await createExpense({ linkedRepairId: repair.id, approved: false, amount: 700 });
  });

  it("SUPER_ADMIN получает суммы и состав неутверждённых расходов", async () => {
    const body = await statsAs(AUTH_SA());

    expect(body.spentThisMonth).toBe("5000");
    expect(body.spentPrevMonth).toBe("0");
    expect(body.pendingExpenses.count).toBe(1);
    expect(body.pendingExpenses.total).toBe("700");
    expect(body.pendingExpenses.items).toHaveLength(1);
    expect(body.pendingExpenses.items[0]).toMatchObject({
      title: "Замена блока питания",
      amount: "700",
      createdByName: "rs_super_admin",
    });
  });

  it("TECHNICIAN видит операционные счётчики, но не деньги", async () => {
    const body = await statsAs(AUTH_TECH());

    expect(body.spentThisMonth).toBeNull();
    expect(body.spentPrevMonth).toBeNull();
    expect(body.pendingExpenses).toBeNull();
    // Операционная часть та же — сводка не должна пустеть целиком.
    expect(body.openCount).toBe(1);
    expect(body.noEtaCount).toBe(1);
  });

  it("WAREHOUSE тоже не видит денег", async () => {
    const body = await statsAs(AUTH_WH());

    expect(body.spentThisMonth).toBeNull();
    expect(body.spentPrevMonth).toBeNull();
    expect(body.pendingExpenses).toBeNull();
    expect(body.openCount).toBe(1);
  });
});

// ── Границы окон «этот месяц / прошлый месяц» ────────────────────────────────

describe("repair-stats: окна расходов", () => {
  it("расход прошлого месяца уходит в spentPrevMonth, а не в spentThisMonth", async () => {
    const repair = await createRepair({ status: "IN_REPAIR" });
    await createExpense({
      linkedRepairId: repair.id,
      approved: true,
      amount: 4200,
      // Второе число прошлого месяца — заведомо внутри окна при любой длине месяца.
      expenseDate: new Date(monthStart(-1).getTime() + DAY_MS),
    });

    const body = await statsAs(AUTH_SA());
    expect(body.spentThisMonth).toBe("0");
    expect(body.spentPrevMonth).toBe("4200");
  });

  it("первая секунда месяца принадлежит текущему месяцу, последняя прошлого — прошлому", async () => {
    const repair = await createRepair({ status: "IN_REPAIR" });
    await createExpense({
      linkedRepairId: repair.id,
      approved: true,
      amount: 100,
      expenseDate: monthStart(), // ровно граница — включительно в этот месяц
    });
    await createExpense({
      linkedRepairId: repair.id,
      approved: true,
      amount: 200,
      expenseDate: new Date(monthStart().getTime() - 1), // на миллисекунду раньше
    });

    const body = await statsAs(AUTH_SA());
    expect(body.spentThisMonth).toBe("100");
    expect(body.spentPrevMonth).toBe("200");
  });

  it("позапрошлый месяц не попадает никуда", async () => {
    const repair = await createRepair({ status: "IN_REPAIR" });
    await createExpense({
      linkedRepairId: repair.id,
      approved: true,
      amount: 9999,
      expenseDate: new Date(monthStart(-2).getTime() + DAY_MS),
    });

    const body = await statsAs(AUTH_SA());
    expect(body.spentThisMonth).toBe("0");
    expect(body.spentPrevMonth).toBe("0");
  });

  it("расход без linkedRepairId в сводку мастерской не входит", async () => {
    await createExpense({ approved: true, amount: 50000 });
    await createExpense({ approved: false, amount: 3000 });

    const body = await statsAs(AUTH_SA());
    expect(body.spentThisMonth).toBe("0");
    expect(body.pendingExpenses.count).toBe(0);
    expect(body.pendingExpenses.total).toBe("0");
  });

  it("неутверждённый расход не входит в spent* ни в одном месяце", async () => {
    const repair = await createRepair({ status: "IN_REPAIR" });
    await createExpense({ linkedRepairId: repair.id, approved: false, amount: 800 });
    await createExpense({
      linkedRepairId: repair.id,
      approved: false,
      amount: 900,
      expenseDate: new Date(monthStart(-1).getTime() + DAY_MS),
    });

    const body = await statsAs(AUTH_SA());
    expect(body.spentThisMonth).toBe("0");
    expect(body.spentPrevMonth).toBe("0");
    // Зато оба висят непринятыми — ради этого поле и появилось.
    expect(body.pendingExpenses.count).toBe(2);
    expect(body.pendingExpenses.total).toBe("1700");
  });
});

// ── «Вернулось из ремонта» ───────────────────────────────────────────────────

describe("repair-stats: readyForPickup — окно 7 суток", () => {
  it("закрытый два дня назад показывается, закрытый десять — нет", async () => {
    const eq = await createEquipment("Свежий ремонт");
    const fresh = await createRepair({
      equipmentId: eq.id,
      status: "CLOSED",
      closedAt: new Date(Date.now() - 2 * DAY_MS),
    });
    await createRepair({
      equipmentId: eq.id,
      status: "CLOSED",
      closedAt: new Date(Date.now() - 10 * DAY_MS),
    });

    const body = await statsAs(AUTH_SA());
    expect(body.readyForPickup.map((r: any) => r.repairId)).toEqual([fresh.id]);
  });

  it("граница ровно 7 суток: чуть внутри — показываем, чуть снаружи — нет", async () => {
    const eq = await createEquipment("Граница недели");
    const inside = await createRepair({
      equipmentId: eq.id,
      status: "CLOSED",
      closedAt: new Date(Date.now() - 7 * DAY_MS + 60_000),
    });
    await createRepair({
      equipmentId: eq.id,
      status: "CLOSED",
      closedAt: new Date(Date.now() - 7 * DAY_MS - 60_000),
    });

    const body = await statsAs(AUTH_SA());
    expect(body.readyForPickup.map((r: any) => r.repairId)).toEqual([inside.id]);
  });

  it("списанное на полку не возвращается", async () => {
    const eq = await createEquipment("Списанный прибор");
    await createRepair({
      equipmentId: eq.id,
      status: "WROTE_OFF",
      closedAt: new Date(Date.now() - DAY_MS),
    });

    const body = await statsAs(AUTH_SA());
    expect(body.readyForPickup).toEqual([]);
  });

  it("название берётся из единицы, а без единицы — из каталога", async () => {
    const withUnitEq = await createEquipment("Прожектор SkyPanel", 3, "UNIT");
    const unit = await createUnit(withUnitEq.id);
    await createRepair({
      unitId: unit.id,
      status: "CLOSED",
      closedAt: new Date(Date.now() - DAY_MS),
    });

    const countEq = await createEquipment("Силовой кабель 25 м");
    await createRepair({
      equipmentId: countEq.id,
      status: "CLOSED",
      closedAt: new Date(Date.now() - 2 * DAY_MS),
    });

    const body = await statsAs(AUTH_SA());
    // Порядок — closedAt desc: сначала вчерашний штучный, потом позавчерашний.
    expect(body.readyForPickup.map((r: any) => r.title)).toEqual([
      "Прожектор SkyPanel",
      "Силовой кабель 25 м",
    ]);
  });

  it("кладовщик видит тот же список — блок живёт на его экране «Смена»", async () => {
    const eq = await createEquipment("Общий источник");
    const repair = await createRepair({
      equipmentId: eq.id,
      status: "CLOSED",
      closedAt: new Date(Date.now() - DAY_MS),
    });

    const body = await statsAs(AUTH_WH());
    expect(body.readyForPickup).toHaveLength(1);
    expect(body.readyForPickup[0].repairId).toBe(repair.id);

    // Тот же список приходит и в сводку смены — общий listReadyForPickup.
    const { computeShift } = await import("../services/warehouseWorkstation");
    const shift = await computeShift("Иван Кладовщик");
    expect(shift.readyForPickup.map((r) => r.repairId)).toEqual([repair.id]);
  });
});

// ── Операционные счётчики ────────────────────────────────────────────────────

describe("repair-stats: noEtaCount и quietCount", () => {
  it("срок не назначен считается только у активных ремонтов", async () => {
    await createRepair({ status: "WAITING_PARTS" }); // без срока → в счётчик
    await createRepair({
      status: "IN_REPAIR",
      expectedReadyAt: new Date(Date.now() + 3 * DAY_MS),
    });
    await createRepair({ status: "CLOSED", closedAt: new Date() }); // закрытый не в счёт

    const body = await statsAs(AUTH_SA());
    expect(body.openCount).toBe(2);
    expect(body.noEtaCount).toBe(1);
  });

  it("«тихим» становится ремонт без записей 5+ суток, свежая запись его снимает", async () => {
    // Взяли в работу неделю назад и забыли — журнала нет вовсе.
    await createRepair({ status: "IN_REPAIR", createdAt: new Date(Date.now() - 7 * DAY_MS) });

    // Тоже старый, но вчера по нему что-то делали — это не «тихий».
    const active = await createRepair({
      status: "IN_REPAIR",
      createdAt: new Date(Date.now() - 20 * DAY_MS),
    });
    await prisma.repairWorkLog.create({
      data: {
        repairId: active.id,
        description: "Перепаял разъём",
        timeSpentHours: 1,
        loggedBy: superAdminId,
        loggedAt: new Date(Date.now() - DAY_MS),
      },
    });

    // Свежий — молчит меньше пяти суток, ещё не «тихий».
    await createRepair({ status: "IN_REPAIR", createdAt: new Date(Date.now() - DAY_MS) });

    const body = await statsAs(AUTH_SA());
    expect(body.quietCount).toBe(1);
  });
});

// ── «Под угрозой» ────────────────────────────────────────────────────────────

describe("repair-stats: atRiskCount", () => {
  /** Бронь на послезавтра, которая просит `quantity` штук позиции. */
  async function createBlockingBooking(equipmentId: string, quantity: number) {
    const client = await prisma.client.create({ data: { name: `Клиент ${Date.now()}` } });
    const start = new Date(Date.now() + 2 * DAY_MS);
    return prisma.booking.create({
      data: {
        clientId: client.id,
        projectName: "Съёмка",
        startDate: start,
        endDate: new Date(start.getTime() + DAY_MS),
        status: "CONFIRMED",
        items: { create: [{ equipmentId, quantity }] },
      },
    });
  }

  it("подмены нет и срок не назначен → ремонт под угрозой", async () => {
    const eq = await createEquipment("Единственный генератор", 1);
    await createRepair({ equipmentId: eq.id, status: "WAITING_REPAIR", quantity: 1 });
    await createBlockingBooking(eq.id, 1);

    const body = await statsAs(AUTH_SA());
    expect(body.atRiskCount).toBe(1);
  });

  it("успеваем к выдаче → не под угрозой (это «впритык», а не «сорвано»)", async () => {
    const eq = await createEquipment("Генератор со сроком", 1);
    await createRepair({
      equipmentId: eq.id,
      status: "WAITING_REPAIR",
      quantity: 1,
      expectedReadyAt: new Date(Date.now() + DAY_MS), // на сутки раньше выдачи
    });
    await createBlockingBooking(eq.id, 1);

    const body = await statsAs(AUTH_SA());
    expect(body.atRiskCount).toBe(0);
  });

  it("подмена на складе есть → бронь не срывается", async () => {
    const eq = await createEquipment("Есть запасной", 5);
    await createRepair({ equipmentId: eq.id, status: "WAITING_REPAIR", quantity: 1 });
    await createBlockingBooking(eq.id, 2);

    const body = await statsAs(AUTH_SA());
    expect(body.atRiskCount).toBe(0);
  });

  it("блокирующих броней нет → счётчик пуст", async () => {
    const eq = await createEquipment("Никому не нужен", 1);
    await createRepair({ equipmentId: eq.id, status: "WAITING_REPAIR", quantity: 1 });

    const body = await statsAs(AUTH_SA());
    expect(body.atRiskCount).toBe(0);
  });
});
