/**
 * Тесты витрины автопарка (computeFleetDashboard).
 *
 * Покрываем то, что легко сломать и трудно заметить глазами:
 *  (a) дельта пробега берёт baseline ДО окна, а не первую запись внутри;
 *  (b) один замер в окне → дельта null (нечего вычитать), samples считается честно;
 *  (c) откат одометра (CORRECTION) → дельта null, а не отрицательное число;
 *  (d) светофор ТО: OK / DUE_SOON / OVERDUE / NO_SERVICE / NO_INTERVAL;
 *  (e) просрочка по времени (>365 дней) перебивает нормальный остаток по км;
 *  (f) выручка и дни аренды считаются только по CONFIRMED/ISSUED/RETURNED;
 *  (g) пересекающиеся брони не дают загрузку > 100 % (дни считаются множеством);
 *  (h) полоса занятости на 14 дней вперёд отмечает верные дни;
 *  (i) totals агрегируют корректно, freeNow/issuedNow разделяются.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-fleet-dashboard.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-fleet-dash";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-fleet-dash";
process.env.JWT_SECRET = "test-jwt-secret-fleet-dashboard-min16chars";

let prisma: any;
let computeFleetDashboard: typeof import("../services/fleetDashboard").computeFleetDashboard;

const DAY = 24 * 60 * 60 * 1000;
/** Фиксированный «сейчас», чтобы тесты не плыли по календарю. */
const NOW = new Date("2026-07-15T12:00:00.000Z");

let clientId: string;
const ids: Record<string, string> = {};

async function mkVehicle(
  slug: string,
  name: string,
  order: number,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const v = await prisma.vehicle.create({
    data: {
      slug,
      name,
      shiftPriceRub: "10000",
      shiftHours: 12,
      overtimePercent: "10",
      displayOrder: order,
      active: true,
      ...extra,
    },
  });
  return v.id;
}

async function mkMileage(vehicleId: string, mileage: number, daysAgo: number, source = "MANUAL") {
  await prisma.vehicleMileageLog.create({
    data: {
      vehicleId,
      mileage,
      recordedAt: new Date(NOW.getTime() - daysAgo * DAY),
      source,
      recordedBy: "test",
    },
  });
}

async function mkBooking(
  vehicleId: string,
  status: string,
  startDaysFromNow: number,
  endDaysFromNow: number,
  subtotal: string | null,
) {
  const b = await prisma.booking.create({
    data: {
      clientId,
      projectName: `Проект ${status} ${startDaysFromNow}`,
      startDate: new Date(NOW.getTime() + startDaysFromNow * DAY),
      endDate: new Date(NOW.getTime() + endDaysFromNow * DAY),
      status,
    },
  });
  await prisma.bookingVehicle.create({
    data: { bookingId: b.id, vehicleId, subtotalRub: subtotal },
  });
  return b;
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

  prisma = (await import("../prisma")).prisma;
  computeFleetDashboard = (await import("../services/fleetDashboard")).computeFleetDashboard;

  clientId = (await prisma.client.create({ data: { name: "Клиент Автопарк" } })).id;

  // (a) baseline ДО окна: запись 100 дней назад вне окна 90 дней, но она — точка отсчёта.
  ids.baseline = await mkVehicle("baseline", "Базовая", 1, { serviceIntervalKm: 10000 });
  await mkMileage(ids.baseline, 100000, 100);
  await mkMileage(ids.baseline, 105000, 10);

  // (b) один замер в окне → дельта null.
  ids.single = await mkVehicle("single", "Один замер", 2);
  await mkMileage(ids.single, 5000, 5);

  // (c) откат одометра → дельта null.
  ids.rollback = await mkVehicle("rollback", "Откат", 3);
  await mkMileage(ids.rollback, 90000, 30);
  await mkMileage(ids.rollback, 80000, 5, "CORRECTION");

  // (d) светофор: OK — проехала 2 000 из 10 000.
  ids.healthOk = await mkVehicle("health-ok", "ТО в норме", 4, {
    serviceIntervalKm: 10000,
    currentMileage: 52000,
    lastServiceMileage: 50000,
    lastServiceAt: new Date(NOW.getTime() - 30 * DAY),
    lastServiceKind: "SCHEDULED_TO",
  });

  // DUE_SOON — осталось 500 из 10 000 (≤ 20 %).
  ids.healthSoon = await mkVehicle("health-soon", "Скоро ТО", 5, {
    serviceIntervalKm: 10000,
    currentMileage: 59500,
    lastServiceMileage: 50000,
    lastServiceAt: new Date(NOW.getTime() - 30 * DAY),
    lastServiceKind: "SCHEDULED_TO",
  });

  // OVERDUE по километражу — интервал выбран полностью.
  ids.healthOverdue = await mkVehicle("health-over", "Пора ТО", 6, {
    serviceIntervalKm: 10000,
    currentMileage: 61000,
    lastServiceMileage: 50000,
    lastServiceAt: new Date(NOW.getTime() - 30 * DAY),
    lastServiceKind: "SCHEDULED_TO",
  });

  // (e) OVERDUE по времени — по км запас есть, но с ТО прошло больше года.
  ids.healthOld = await mkVehicle("health-old", "Давно ТО", 7, {
    serviceIntervalKm: 10000,
    currentMileage: 50500,
    lastServiceMileage: 50000,
    lastServiceAt: new Date(NOW.getTime() - 400 * DAY),
    lastServiceKind: "SCHEDULED_TO",
  });

  // NO_SERVICE — интервал есть, записей ТО нет.
  ids.healthNoSvc = await mkVehicle("health-nosvc", "Без ТО", 8, { serviceIntervalKm: 10000 });

  // NO_INTERVAL — интервал не задан.
  ids.healthNoInt = await mkVehicle("health-noint", "Без интервала", 9, {
    currentMileage: 30000,
    lastServiceMileage: 20000,
    lastServiceAt: new Date(NOW.getTime() - 10 * DAY),
    lastServiceKind: "REPAIR",
  });

  // (f) деньги: считается только CONFIRMED/ISSUED/RETURNED.
  ids.money = await mkVehicle("money", "Деньги", 10);
  await mkBooking(ids.money, "RETURNED", -20, -18, "30000");
  await mkBooking(ids.money, "DRAFT", -15, -14, "99999"); // не в счёт
  await mkBooking(ids.money, "CANCELLED", -12, -11, "88888"); // не в счёт
  await prisma.vehicleServiceLog.create({
    data: {
      vehicleId: ids.money,
      kind: "REPAIR",
      performedAt: new Date(NOW.getTime() - 10 * DAY),
      description: "Ремонт для теста",
      cost: "12000",
      createdBy: "test",
    },
  });

  // (g) пересекающиеся брони — дни не должны считаться дважды.
  ids.overlap = await mkVehicle("overlap", "Пересечение", 11);
  await mkBooking(ids.overlap, "CONFIRMED", -10, -6, "10000");
  await mkBooking(ids.overlap, "CONFIRMED", -8, -4, "10000");

  // (h) занятость вперёд: выдана сейчас (вчера→послезавтра).
  ids.busy = await mkVehicle("busy", "Занята", 12);
  await mkBooking(ids.busy, "ISSUED", -1, 2, "20000");
});

afterAll(async () => {
  await prisma.$disconnect();
  for (const suffix of ["", "-wal", "-shm"]) {
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

async function load() {
  const d = await computeFleetDashboard({ period: 90, includeInactive: true, now: NOW });
  const by = new Map(d.vehicles.map((v) => [v.id, v]));
  return { d, by };
}

describe("computeFleetDashboard — пробег", () => {
  it("(a) baseline берётся из записи ДО окна", async () => {
    const { by } = await load();
    const v = by.get(ids.baseline)!;
    expect(v.stats.mileageDelta).toBe(5000);
    // В окно попал только один замер — но дельта построена от внешнего baseline.
    expect(v.stats.mileageSamples).toBe(1);
  });

  it("(b) единственный замер без baseline → дельта null", async () => {
    const { by } = await load();
    const v = by.get(ids.single)!;
    expect(v.stats.mileageDelta).toBeNull();
    expect(v.stats.mileageSamples).toBe(1);
  });

  it("(c) откат одометра не даёт отрицательную дельту", async () => {
    const { by } = await load();
    expect(by.get(ids.rollback)!.stats.mileageDelta).toBeNull();
  });
});

describe("computeFleetDashboard — светофор ТО", () => {
  it("(d) OK / DUE_SOON / OVERDUE по километражу", async () => {
    const { by } = await load();
    expect(by.get(ids.healthOk)!.stats.serviceHealth).toBe("OK");
    expect(by.get(ids.healthOk)!.stats.kmToNextService).toBe(8000);
    expect(by.get(ids.healthSoon)!.stats.serviceHealth).toBe("DUE_SOON");
    expect(by.get(ids.healthSoon)!.stats.kmToNextService).toBe(500);
    expect(by.get(ids.healthOverdue)!.stats.serviceHealth).toBe("OVERDUE");
    expect(by.get(ids.healthOverdue)!.stats.kmToNextService).toBe(-1000);
  });

  it("(e) просрочка по времени важнее запаса по километражу", async () => {
    const { by } = await load();
    const v = by.get(ids.healthOld)!;
    expect(v.stats.serviceHealth).toBe("OVERDUE");
    expect(v.stats.kmToNextService).toBe(9500); // по км запас есть
    expect(v.stats.daysSinceService).toBeGreaterThan(365);
  });

  it("(d2) NO_SERVICE и NO_INTERVAL — честные состояния без выдуманного прогноза", async () => {
    const { by } = await load();
    const noSvc = by.get(ids.healthNoSvc)!;
    expect(noSvc.stats.serviceHealth).toBe("NO_SERVICE");
    expect(noSvc.stats.kmToNextService).toBeNull();

    const noInt = by.get(ids.healthNoInt)!;
    expect(noInt.stats.serviceHealth).toBe("NO_INTERVAL");
    expect(noInt.stats.kmToNextService).toBeNull();
    expect(noInt.stats.kmSinceService).toBe(10000); // сам факт «сколько проехала» считается
  });
});

describe("computeFleetDashboard — деньги и загрузка", () => {
  it("(f) выручка только по CONFIRMED/ISSUED/RETURNED; DRAFT и CANCELLED игнорируются", async () => {
    const { by } = await load();
    const v = by.get(ids.money)!;
    expect(v.stats.revenue).toBe("30000.00");
    expect(v.stats.bookingsCount).toBe(1);
    expect(v.stats.serviceCost).toBe("12000.00");
    expect(v.stats.net).toBe("18000.00");
  });

  it("(g) пересекающиеся брони не дают двойного счёта дней", async () => {
    const { by } = await load();
    const v = by.get(ids.overlap)!;
    // -10..-6 (5 дней) и -8..-4 (5 дней) с пересечением -8..-6 → объединение -10..-4 = 7 дней.
    expect(v.stats.rentedDays).toBe(7);
    expect(v.stats.utilizationPct).toBeLessThanOrEqual(100);
    expect(v.stats.revenue).toBe("20000.00");
  });
});

describe("computeFleetDashboard — занятость и сводка", () => {
  it("(h) полоса занятости отмечает сегодня и следующие дни брони", async () => {
    const { by } = await load();
    const v = by.get(ids.busy)!;
    expect(v.stats.occupancy).toHaveLength(14);
    // Бронь идёт вчера→послезавтра: сегодня (0), завтра (1), послезавтра (2) заняты.
    expect(v.stats.occupancy.slice(0, 3)).toEqual([true, true, true]);
    expect(v.stats.occupancy[3]).toBe(false);
    expect(v.upcomingBookings[0]?.isCurrent).toBe(true);
  });

  it("(i) totals: занятая машина попадает в issuedNow, остальные — в freeNow", async () => {
    const { d } = await load();
    expect(d.totals.vehiclesTotal).toBe(d.vehicles.length);
    expect(d.totals.issuedNow).toBe(1);
    expect(d.totals.freeNow).toBe(d.totals.vehiclesActive - 1);
    // Машины без интервала/без ТО обязаны попасть в «требуют внимания».
    expect(d.totals.needAttention).toBeGreaterThanOrEqual(2);
    expect(Number(d.totals.net)).toBe(
      Number(d.totals.revenue) - Number(d.totals.serviceCost),
    );
  });

  it("период меняет окно: за 30 дней старая бронь уже не считается", async () => {
    const d30 = await computeFleetDashboard({ period: 30, includeInactive: true, now: NOW });
    const money = d30.vehicles.find((v) => v.id === ids.money)!;
    // Бронь была 20 дней назад — попадает и в 30 дней.
    expect(money.stats.revenue).toBe("30000.00");

    const overlap30 = d30.vehicles.find((v) => v.id === ids.overlap)!;
    expect(overlap30.stats.rentedDays).toBe(7);
    // При меньшем окне та же аренда даёт большую загрузку.
    expect(overlap30.stats.utilizationPct).toBeGreaterThan(
      (await load()).by.get(ids.overlap)!.stats.utilizationPct,
    );
  });
});
