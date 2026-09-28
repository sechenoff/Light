/**
 * Единая формула потолка добора (stockCap): «сколько ещё можно довезти в эту
 * бронь» одинаково для киоска (поиск, «+», степпер, /complete) и для страницы
 * брони. Раньше киоск считал сам: сумма вместо пика, черновики и архив занимали
 * склад, брони на согласовании — нет, мастерская не вычиталась. Отсюда «свободно
 * ×2» в поиске и «Не хватает» на кнопке (24.09).
 *
 * Формула поверх той же доступности, что у витрины:
 *   addCap = max(0, физически − занято чужими (пик) − уже в брони)
 *   ackCap = max(0, физически − уже в брони)   — потолок «под ответственность»
 *   UNIT: оба не больше числа реально свободных экземпляров.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-stock-cap.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-stock-cap";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-stock-cap";
process.env.WAREHOUSE_SECRET = "test-warehouse-stock-cap";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-stock-cap-min16chars";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.now();
// Окно целевой брони — в будущем, чтобы «сейчас» не попадало внутрь.
const S = new Date(NOW + 10 * DAY);
const E = new Date(S.getTime() + 3 * DAY);

let prisma: any;
let clientId: string;
let seq = 0;

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
  clientId = (await prisma.client.create({ data: { name: "Клиент stockCap" } })).id;
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

async function mkEq(name: string, totalQuantity: number, mode: "COUNT" | "UNIT" = "COUNT") {
  seq += 1;
  return prisma.equipment.create({
    data: {
      importKey: `stock-cap-${seq}`,
      name,
      category: "Свет",
      rentalRatePerShift: "1000",
      stockTrackingMode: mode,
      totalQuantity,
    },
  });
}

async function mkBooking(
  status: string,
  start: Date,
  end: Date,
  items: Array<[string, number]>,
  extra: Record<string, unknown> = {},
) {
  return prisma.booking.create({
    data: {
      clientId,
      projectName: `Проект ${status} ${++seq}`,
      status,
      startDate: start,
      endDate: end,
      ...extra,
      items: { create: items.map(([equipmentId, quantity]) => ({ equipmentId, quantity })) },
    },
    include: { items: true },
  });
}

async function mkUnits(equipmentId: string, n: number, status = "AVAILABLE") {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const u = await prisma.equipmentUnit.create({ data: { equipmentId, status } });
    ids.push(u.id);
  }
  return ids;
}

describe("addonWindow", () => {
  it("по плану (страница, CONFIRMED) — даты брони", async () => {
    const { addonWindow } = await import("../services/stockCap");
    const w = addonWindow({ startDate: S, endDate: E }, { issuingNow: false });
    expect(w.start.getTime()).toBe(S.getTime());
    expect(w.end.getTime()).toBe(E.getTime());
  });

  it("выдача сейчас: с текущего момента до конца брони", async () => {
    const { addonWindow } = await import("../services/stockCap");
    const now = new Date(NOW);
    const w = addonWindow({ startDate: new Date(NOW - DAY), endDate: new Date(NOW + 2 * DAY) }, { issuingNow: true, now });
    expect(w.start.getTime()).toBe(now.getTime());
    expect(w.end.getTime()).toBe(NOW + 2 * DAY);
  });

  it("выдача раньше срока: окно начинается сейчас, а не в день начала", async () => {
    const { addonWindow } = await import("../services/stockCap");
    const now = new Date(NOW);
    const w = addonWindow({ startDate: S, endDate: E }, { issuingNow: true, now });
    expect(w.start.getTime()).toBe(now.getTime());
    expect(w.end.getTime()).toBe(E.getTime());
  });

  it("просроченная выданная бронь: окно не пустое — [сейчас, сейчас + 1 мс)", async () => {
    const { addonWindow } = await import("../services/stockCap");
    const now = new Date(NOW);
    const w = addonWindow({ startDate: new Date(NOW - 5 * DAY), endDate: new Date(NOW - DAY) }, { issuingNow: true, now });
    expect(w.start.getTime()).toBe(now.getTime());
    expect(w.end.getTime()).toBe(now.getTime() + 1);
  });
});

describe("computeAddCaps — COUNT", () => {
  it("занятость — пик, а не сумма: две непересекающиеся чужие брони по 2 шт. из 4", async () => {
    const { computeAddCaps } = await import("../services/stockCap");
    const eq = await mkEq("Пик-не-сумма", 4);
    await mkBooking("CONFIRMED", S, new Date(S.getTime() + 20 * HOUR), [[eq.id, 2]]);
    await mkBooking("CONFIRMED", new Date(S.getTime() + 2 * DAY), new Date(E.getTime() - HOUR), [[eq.id, 2]]);
    const target = await mkBooking("CONFIRMED", S, E, [[eq.id, 1]]);

    const caps = await computeAddCaps(prisma, { bookingId: target.id, equipmentIds: [eq.id], window: { start: S, end: E } });
    const c = caps.get(eq.id)!;
    expect(c).toMatchObject({
      equipmentId: eq.id,
      physicalStock: 4,
      occupiedByOthers: 2,
      alreadyInBooking: 1,
      addCap: 1,
      ackCap: 3,
    });
  });

  it("черновик и архив склад не занимают, бронь на согласовании — занимает", async () => {
    const { computeAddCaps } = await import("../services/stockCap");
    const draftEq = await mkEq("Под черновиком", 3);
    const archEq = await mkEq("Под архивом", 2);
    const pendEq = await mkEq("Под согласованием", 2);
    await mkBooking("DRAFT", S, E, [[draftEq.id, 3]]);
    await mkBooking("CONFIRMED", S, E, [[archEq.id, 2]], { deletedAt: new Date() });
    await mkBooking("PENDING_APPROVAL", S, E, [[pendEq.id, 1]]);
    const target = await mkBooking("CONFIRMED", S, E, [[pendEq.id, 1]]);

    const caps = await computeAddCaps(prisma, {
      bookingId: target.id,
      equipmentIds: [draftEq.id, archEq.id, pendEq.id],
      window: { start: S, end: E },
    });
    expect(caps.get(draftEq.id)).toMatchObject({ occupiedByOthers: 0, addCap: 3, ackCap: 3 });
    expect(caps.get(archEq.id)).toMatchObject({ occupiedByOthers: 0, addCap: 2, ackCap: 2 });
    expect(caps.get(pendEq.id)).toMatchObject({ occupiedByOthers: 1, alreadyInBooking: 1, addCap: 0, ackCap: 1 });
  });

  it("мастерская и потеряшки уменьшают физический склад — и «под ответственность» тоже", async () => {
    const { computeAddCaps } = await import("../services/stockCap");
    const eq = await mkEq("Со сломанными", 5);
    await prisma.repair.create({ data: { equipmentId: eq.id, quantity: 2, reason: "сгорел", createdBy: "tester" } });
    await prisma.problemItem.create({
      data: { equipmentId: eq.id, quantity: 1, reason: "LOST", comment: "не вернули", createdBy: "tester" },
    });
    await mkBooking("CONFIRMED", S, E, [[eq.id, 1]]);
    const target = await mkBooking("CONFIRMED", S, E, [[eq.id, 1]]);

    const c = (await computeAddCaps(prisma, { bookingId: target.id, equipmentIds: [eq.id], window: { start: S, end: E } })).get(eq.id)!;
    expect(c.physicalStock).toBe(2); // 5 − 2 в мастерской − 1 потеряна
    expect(c.occupiedByOthers).toBe(1);
    expect(c.addCap).toBe(0); // 2 − 1 − 1
    expect(c.ackCap).toBe(1); // 2 − 1: чужую бронь подвинуть можно, мастерскую — нет
  });

  it("позиции ещё нет в брони: alreadyInBooking = 0", async () => {
    const { computeAddCaps } = await import("../services/stockCap");
    const eq = await mkEq("Новая в брони", 3);
    await mkBooking("ISSUED", S, E, [[eq.id, 1]], { issuedAt: new Date() });
    const target = await mkBooking("CONFIRMED", S, E, []);

    const c = (await computeAddCaps(prisma, { bookingId: target.id, equipmentIds: [eq.id], window: { start: S, end: E } })).get(eq.id)!;
    expect(c).toMatchObject({ alreadyInBooking: 0, occupiedByOthers: 1, addCap: 2, ackCap: 3 });
  });

  it("«уже в брони» можно передать явно — например, количество со степпера", async () => {
    const { computeAddCaps } = await import("../services/stockCap");
    const eq = await mkEq("Степпер", 6);
    const target = await mkBooking("CONFIRMED", S, E, [[eq.id, 1]]);

    const c = (await computeAddCaps(prisma, {
      bookingId: target.id,
      equipmentIds: [eq.id],
      window: { start: S, end: E },
      alreadyInBooking: new Map([[eq.id, 4]]),
    })).get(eq.id)!;
    expect(c).toMatchObject({ alreadyInBooking: 4, addCap: 2, ackCap: 2 });
  });

  it("чужая бронь вне окна не занимает; неизвестная позиция в ответ не попадает", async () => {
    const { computeAddCaps } = await import("../services/stockCap");
    const eq = await mkEq("Вне окна", 1);
    await mkBooking("CONFIRMED", new Date(E.getTime() + 5 * DAY), new Date(E.getTime() + 6 * DAY), [[eq.id, 1]]);
    const target = await mkBooking("CONFIRMED", S, E, []);

    const caps = await computeAddCaps(prisma, {
      bookingId: target.id,
      equipmentIds: [eq.id, "no-such-equipment"],
      window: { start: S, end: E },
    });
    expect(caps.get(eq.id)).toMatchObject({ occupiedByOthers: 0, addCap: 1, ackCap: 1 });
    expect(caps.has("no-such-equipment")).toBe(false);
  });

  it("работает внутри транзакции", async () => {
    const { computeAddCaps } = await import("../services/stockCap");
    const eq = await mkEq("В транзакции", 2);
    const target = await mkBooking("CONFIRMED", S, E, []);
    const c = await prisma.$transaction(async (tx: any) =>
      (await computeAddCaps(tx, { bookingId: target.id, equipmentIds: [eq.id], window: { start: S, end: E } })).get(eq.id),
    );
    expect(c).toMatchObject({ addCap: 2, ackCap: 2 });
  });
});

describe("computeAddCaps — UNIT", () => {
  it("потолок не больше реально свободных экземпляров (и «под ответственность» тоже)", async () => {
    const { computeAddCaps } = await import("../services/stockCap");
    const eq = await mkEq("Штучный", 0, "UNIT");
    const [u1] = await mkUnits(eq.id, 3);
    // Чужая подтверждённая бронь в окне держит один конкретный экземпляр.
    const other = await mkBooking("CONFIRMED", S, E, [[eq.id, 1]]);
    await prisma.bookingItemUnit.create({ data: { bookingItemId: other.items[0].id, equipmentUnitId: u1 } });
    // Экземпляр застрял у просроченной выдачи с чужими датами: агрегат по датам
    // его не видит, но на полке его нет.
    const stuck = await mkBooking("ISSUED", new Date(NOW - 10 * DAY), new Date(NOW - 8 * DAY), [[eq.id, 1]], { issuedAt: new Date(NOW - 10 * DAY) });
    const [u4] = await mkUnits(eq.id, 1, "ISSUED");
    await prisma.bookingItemUnit.create({ data: { bookingItemId: stuck.items[0].id, equipmentUnitId: u4 } });
    const target = await mkBooking("CONFIRMED", S, E, []);

    const c = (await computeAddCaps(prisma, { bookingId: target.id, equipmentIds: [eq.id], window: { start: S, end: E } })).get(eq.id)!;
    expect(c.physicalStock).toBe(4); // AVAILABLE + ISSUED
    expect(c.occupiedByOthers).toBe(1);
    // Агрегат дал бы 3 и 4, а свободных AVAILABLE и не занятых — 2.
    expect(c.addCap).toBe(2);
    expect(c.ackCap).toBe(2);
  });
});

describe("listFreeUnitIds", () => {
  it("окно полуоткрытое: бронь, закончившаяся ровно в начале окна, экземпляр не держит", async () => {
    const { listFreeUnitIds } = await import("../services/stockCap");
    const eq = await mkEq("Стык", 0, "UNIT");
    const [a, b, c] = await mkUnits(eq.id, 3);
    const before = await mkBooking("CONFIRMED", new Date(S.getTime() - DAY), S, [[eq.id, 1]]);
    await prisma.bookingItemUnit.create({ data: { bookingItemId: before.items[0].id, equipmentUnitId: a } });
    const after = await mkBooking("CONFIRMED", E, new Date(E.getTime() + DAY), [[eq.id, 1]]);
    await prisma.bookingItemUnit.create({ data: { bookingItemId: after.items[0].id, equipmentUnitId: b } });
    const inside = await mkBooking("CONFIRMED", new Date(S.getTime() + HOUR), new Date(S.getTime() + 2 * HOUR), [[eq.id, 1]]);
    await prisma.bookingItemUnit.create({ data: { bookingItemId: inside.items[0].id, equipmentUnitId: c } });
    const target = await mkBooking("CONFIRMED", S, E, []);

    const free = await listFreeUnitIds(prisma, { bookingId: target.id, bookingItemId: null, equipmentId: eq.id, start: S, end: E });
    expect(free.sort()).toEqual([a, b].sort());
  });

  it("свои живые резервы позиции не считаются свободными, возвращённые — считаются", async () => {
    const { listFreeUnitIds } = await import("../services/stockCap");
    const eq = await mkEq("Свои резервы", 0, "UNIT");
    const [a, b, c] = await mkUnits(eq.id, 3);
    const target = await mkBooking("CONFIRMED", S, E, [[eq.id, 2]]);
    await prisma.bookingItemUnit.create({ data: { bookingItemId: target.items[0].id, equipmentUnitId: a } });
    await prisma.bookingItemUnit.create({ data: { bookingItemId: target.items[0].id, equipmentUnitId: b, returnedAt: new Date() } });

    const free = await listFreeUnitIds(prisma, {
      bookingId: target.id,
      bookingItemId: target.items[0].id,
      equipmentId: eq.id,
      start: S,
      end: E,
    });
    expect(free.sort()).toEqual([b, c].sort());
  });
});

describe("reserveUnits", () => {
  it("резервирует свободные экземпляры и при выдаче сразу переводит их в «Выдан»", async () => {
    const { reserveUnits } = await import("../services/stockCap");
    const eq = await mkEq("Резерв", 0, "UNIT");
    await mkUnits(eq.id, 3);
    const target = await mkBooking("ISSUED", S, E, [[eq.id, 2]], { issuedAt: new Date() });

    const picked: string[] = await prisma.$transaction((tx: any) =>
      reserveUnits(tx, {
        bookingId: target.id,
        bookingItemId: target.items[0].id,
        equipmentId: eq.id,
        equipmentName: eq.name,
        quantity: 2,
        start: S,
        end: E,
        issueNow: true,
      }),
    );
    expect(picked).toHaveLength(2);
    const rows = await prisma.bookingItemUnit.findMany({ where: { bookingItemId: target.items[0].id } });
    expect(rows.map((r: any) => r.equipmentUnitId).sort()).toEqual([...picked].sort());
    const units = await prisma.equipmentUnit.findMany({ where: { id: { in: picked } } });
    expect(units.every((u: any) => u.status === "ISSUED")).toBe(true);
  });

  it("без выдачи статус экземпляров не меняется", async () => {
    const { reserveUnits } = await import("../services/stockCap");
    const eq = await mkEq("Резерв без выдачи", 0, "UNIT");
    await mkUnits(eq.id, 1);
    const target = await mkBooking("CONFIRMED", S, E, [[eq.id, 1]]);
    const picked: string[] = await prisma.$transaction((tx: any) =>
      reserveUnits(tx, {
        bookingId: target.id,
        bookingItemId: target.items[0].id,
        equipmentId: eq.id,
        equipmentName: eq.name,
        quantity: 1,
        start: S,
        end: E,
        issueNow: false,
      }),
    );
    const unit = await prisma.equipmentUnit.findUnique({ where: { id: picked[0] } });
    expect(unit.status).toBe("AVAILABLE");
  });

  it("свободных меньше, чем нужно — 409 NOT_ENOUGH_UNITS по-русски, ничего не записано", async () => {
    const { reserveUnits } = await import("../services/stockCap");
    const eq = await mkEq("Мало экземпляров", 0, "UNIT");
    await mkUnits(eq.id, 1);
    const target = await mkBooking("CONFIRMED", S, E, [[eq.id, 3]]);

    await expect(
      prisma.$transaction((tx: any) =>
        reserveUnits(tx, {
          bookingId: target.id,
          bookingItemId: target.items[0].id,
          equipmentId: eq.id,
          equipmentName: eq.name,
          quantity: 3,
          start: S,
          end: E,
          issueNow: false,
        }),
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: "NOT_ENOUGH_UNITS",
      message: "«Мало экземпляров»: свободных экземпляров 1, нужно 3",
      details: { equipmentId: eq.id, available: 1, requested: 3 },
    });
    expect(await prisma.bookingItemUnit.count({ where: { bookingItemId: target.items[0].id } })).toBe(0);
  });
});

describe("overStockError", () => {
  it("текст и details по общему контракту", async () => {
    const { overStockError } = await import("../services/stockCap");
    const err = overStockError({
      bookingItemId: "bi-1",
      equipmentId: "eq-1",
      name: "Колёса для А100",
      addCap: 0,
      requested: 1,
      alreadyInBooking: 2,
    });
    expect(err).toMatchObject({
      status: 409,
      code: "ADDON_OVER_STOCK",
      message: "«Колёса для А100»: не хватает на складе — можно добрать ещё 0",
      details: { bookingItemId: "bi-1", equipmentId: "eq-1", name: "Колёса для А100", addCap: 0, requested: 1, alreadyInBooking: 2 },
    });
  });

  it("без bookingItemId поле не появляется", async () => {
    const { overStockError } = await import("../services/stockCap");
    const err = overStockError({ equipmentId: "eq-1", name: "X", addCap: 1, requested: 2, alreadyInBooking: 0 });
    expect(err.details).not.toHaveProperty("bookingItemId");
  });
});

describe("availability: baseQuantity и standardReservations", () => {
  it("строка доступности знает физический склад", async () => {
    const { getAvailability } = await import("../services/availability");
    const eq = await mkEq("База", 5);
    await prisma.repair.create({ data: { equipmentId: eq.id, quantity: 1, reason: "ремонт", createdBy: "tester" } });
    await mkBooking("CONFIRMED", S, E, [[eq.id, 2]]);
    const [row] = await getAvailability({ startDate: S, endDate: E, equipmentIds: [eq.id] });
    expect(row.baseQuantity).toBe(4);
    expect(row.occupiedQuantity).toBe(2);
    expect(row.availableQuantity).toBe(2);
  });

  it("standardReservations отдаёт резервы обычных броней в окне по блокирующим статусам", async () => {
    const { standardReservations } = await import("../services/availability");
    const eq = await mkEq("Резервы", 5);
    const confirmed = await mkBooking("CONFIRMED", S, E, [[eq.id, 2]]);
    const excluded = await mkBooking("CONFIRMED", S, E, [[eq.id, 1]]);
    await mkBooking("DRAFT", S, E, [[eq.id, 3]]);
    await mkBooking("CONFIRMED", new Date(E.getTime() + 5 * DAY), new Date(E.getTime() + 6 * DAY), [[eq.id, 4]]);

    const rows = await standardReservations(prisma, { start: S, end: E, equipmentIds: [eq.id], excludeBookingId: excluded.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ bookingId: confirmed.id, equipmentId: eq.id, quantity: 2, start: S.getTime() });
  });
});
