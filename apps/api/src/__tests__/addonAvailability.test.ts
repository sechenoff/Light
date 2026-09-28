/**
 * Интеграционный тест: findAddonConflict / findHoldersBatch — конфликт добора
 * и «кто держит» позицию.
 *
 * v2 (2026-09-28): конфликт считается той же формулой, что витрина
 * (getAvailability): пик занятости, а не сумма; черновик и архив не держат;
 * мастерская и потеряшки вычтены. Конфликт ⇔ в окне есть чужие брони И
 * свободно меньше, чем «уже в брони + запрошено». Карточка держателя говорит,
 * у кого прибор и можно ли его ждать: статус, дата выдачи, просрочка, сколько
 * свободно нам и сколько можно взять под ответственность.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-addon-avail.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-addon-avail";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-addon-avail";
process.env.WAREHOUSE_SECRET = "test-warehouse-addon-avail";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-addon-avail-min16chars";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.now();
const at = (days: number) => new Date(NOW + days * DAY);

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

  const pmod = await import("../prisma");
  prisma = pmod.prisma;
  clientId = (await prisma.client.create({ data: { name: "Гаффер Держатель" } })).id;
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

async function mkEq(name: string, totalQuantity: number) {
  seq += 1;
  return prisma.equipment.create({
    data: { importKey: `addon-eq-${seq}`, name, category: "Свет", rentalRatePerShift: 1000, stockTrackingMode: "COUNT", totalQuantity },
  });
}

async function mkBooking(
  projectName: string,
  status: string,
  start: Date,
  end: Date,
  items: Array<[string, number]>,
  extra: Record<string, unknown> = {},
) {
  return prisma.booking.create({
    data: {
      clientId,
      projectName,
      status,
      startDate: start,
      endDate: end,
      ...extra,
      items: { create: items.map(([equipmentId, quantity]) => ({ equipmentId, quantity })) },
    },
  });
}

describe("findAddonConflict", () => {
  it("вся позиция у другой подтверждённой брони — конфликт с карточкой держателя", async () => {
    const eq = await mkEq("Astera Titan", 1);
    const other = await mkBooking("Конфликт", "CONFIRMED", at(10), at(12), [[eq.id, 1]]);
    const target = await mkBooking("Целевая", "CONFIRMED", at(11), at(13), []);

    const { findAddonConflict } = await import("../services/addonAvailability");
    const c = await findAddonConflict(eq.id, target.startDate, target.endDate, target.id);
    expect(c).not.toBeNull();
    expect(c).toMatchObject({
      bookingId: other.id,
      bookingNo: "#" + other.id.slice(-6).toUpperCase(),
      projectName: "Конфликт",
      clientName: "Гаффер Держатель",
      from: at(10).toISOString(),
      to: at(12).toISOString(),
      freeFrom: at(12).toISOString(),
      holderStatus: "CONFIRMED",
      issuedAt: null,
      overdue: false,
      freeForUs: 0,
      ackCap: 1,
    });
  });

  it("свободно — конфликта нет", async () => {
    const eq = await mkEq("Свободный", 2);
    const target = await mkBooking("Ц2", "CONFIRMED", at(20), at(21), []);
    const { findAddonConflict } = await import("../services/addonAvailability");
    expect(await findAddonConflict(eq.id, target.startDate, target.endDate, target.id)).toBeNull();
  });

  it("частичная занятость: одна штука влезает, две — уже конфликт", async () => {
    const eq = await mkEq("Полу-свободный", 2);
    await mkBooking("Частичный конфликт", "CONFIRMED", at(30), at(32), [[eq.id, 1]]);
    const target = await mkBooking("Ц3", "CONFIRMED", at(31), at(33), []);
    const { findAddonConflict } = await import("../services/addonAvailability");

    expect(await findAddonConflict(eq.id, target.startDate, target.endDate, target.id)).toBeNull();
    const c = await findAddonConflict(eq.id, target.startDate, target.endDate, target.id, { requested: 2 });
    expect(c).toMatchObject({ projectName: "Частичный конфликт", freeForUs: 1, ackCap: 2 });
  });

  it("учитывает, сколько позиции уже в брони", async () => {
    const eq = await mkEq("Уже в брони", 2);
    await mkBooking("Держит одну", "CONFIRMED", at(40), at(42), [[eq.id, 1]]);
    const target = await mkBooking("Ц4", "CONFIRMED", at(40), at(42), [[eq.id, 1]]);
    const { findAddonConflict } = await import("../services/addonAvailability");

    // Свободна одна штука, и она уже в брони: добрать ещё одну — конфликт.
    const c = await findAddonConflict(eq.id, target.startDate, target.endDate, target.id, {
      requested: 1,
      alreadyInBooking: 1,
    });
    expect(c).toMatchObject({ projectName: "Держит одну", freeForUs: 0, ackCap: 1 });
  });

  it("чужая бронь вне окна — конфликта нет", async () => {
    const eq = await mkEq("Несовпадающий", 1);
    await mkBooking("Вне окна", "CONFIRMED", at(50), at(52), [[eq.id, 1]]);
    const target = await mkBooking("Ц5", "CONFIRMED", at(60), at(62), []);
    const { findAddonConflict } = await import("../services/addonAvailability");
    expect(await findAddonConflict(eq.id, target.startDate, target.endDate, target.id)).toBeNull();
  });

  it("пик, а не сумма: две непересекающиеся брони по 2 шт. из 4 оставляют 2 свободных", async () => {
    const eq = await mkEq("Пик", 4);
    await mkBooking("Первая половина", "CONFIRMED", at(70), new Date(at(70).getTime() + 20 * HOUR), [[eq.id, 2]]);
    await mkBooking("Вторая половина", "CONFIRMED", at(72), new Date(at(73).getTime() - HOUR), [[eq.id, 2]]);
    const target = await mkBooking("Ц6", "CONFIRMED", at(70), at(73), []);
    const { findAddonConflict } = await import("../services/addonAvailability");

    // Раньше сумма 2 + 2 = 4 давала ложный «занят» уже на первой штуке.
    expect(await findAddonConflict(eq.id, target.startDate, target.endDate, target.id, { requested: 2 })).toBeNull();
    expect(await findAddonConflict(eq.id, target.startDate, target.endDate, target.id, { requested: 3 })).not.toBeNull();
  });

  it("черновик и архивная бронь держателями не считаются", async () => {
    const draftEq = await mkEq("Под черновиком", 1);
    const archEq = await mkEq("Под архивом", 1);
    await mkBooking("Черновик", "DRAFT", at(80), at(82), [[draftEq.id, 1]]);
    await mkBooking("Архив", "CONFIRMED", at(80), at(82), [[archEq.id, 1]], { deletedAt: new Date() });
    const target = await mkBooking("Ц7", "CONFIRMED", at(80), at(82), []);
    const { findAddonConflict } = await import("../services/addonAvailability");

    expect(await findAddonConflict(draftEq.id, target.startDate, target.endDate, target.id)).toBeNull();
    expect(await findAddonConflict(archEq.id, target.startDate, target.endDate, target.id)).toBeNull();
  });

  it("бронь на согласовании — держатель", async () => {
    const eq = await mkEq("На согласовании", 1);
    await mkBooking("Ждёт руководителя", "PENDING_APPROVAL", at(90), at(92), [[eq.id, 1]]);
    const target = await mkBooking("Ц8", "CONFIRMED", at(90), at(92), []);
    const { findAddonConflict } = await import("../services/addonAvailability");
    const c = await findAddonConflict(eq.id, target.startDate, target.endDate, target.id);
    expect(c).toMatchObject({ holderStatus: "PENDING_APPROVAL", projectName: "Ждёт руководителя" });
  });

  it("прибор у клиента: видно дату выдачи; просроченный возврат — «свободно с» неизвестно", async () => {
    const onTime = await mkEq("У клиента в срок", 1);
    const late = await mkEq("У клиента просрочен", 1);
    const issuedAt = new Date(NOW - 3 * DAY);
    await mkBooking("Съёмка идёт", "ISSUED", new Date(NOW - 3 * DAY), at(2), [[onTime.id, 1]], { issuedAt });
    await mkBooking("Не вернули", "ISSUED", new Date(NOW - 3 * DAY), new Date(NOW - DAY), [[late.id, 1]], { issuedAt });
    const target = await mkBooking("Ц9", "CONFIRMED", new Date(NOW - 2 * DAY), at(1), []);
    const { findAddonConflict } = await import("../services/addonAvailability");

    const a = await findAddonConflict(onTime.id, target.startDate, target.endDate, target.id);
    expect(a).toMatchObject({
      projectName: "Съёмка идёт",
      holderStatus: "ISSUED",
      issuedAt: issuedAt.toISOString(),
      overdue: false,
      freeFrom: at(2).toISOString(),
    });

    const b = await findAddonConflict(late.id, target.startDate, target.endDate, target.id);
    expect(b).toMatchObject({
      projectName: "Не вернули",
      holderStatus: "ISSUED",
      overdue: true,
      freeFrom: null,
      to: new Date(NOW - DAY).toISOString(),
    });
  });

  it("выданная раньше срока бронь — держатель уже сейчас, хотя её плановые даты впереди", async () => {
    const eq = await mkEq("Уехал заранее", 1);
    const issuedAt = new Date(NOW - HOUR);
    const early = await mkBooking("Выдали заранее", "ISSUED", at(5), at(6), [[eq.id, 1]], { issuedAt });
    const target = await mkBooking("Ц-ранняя", "CONFIRMED", at(1), at(2), []);
    const { findAddonConflict } = await import("../services/addonAvailability");
    const c = await findAddonConflict(eq.id, target.startDate, target.endDate, target.id);
    expect(c).toMatchObject({
      bookingId: early.id,
      holderStatus: "ISSUED",
      issuedAt: issuedAt.toISOString(),
      overdue: false,
      freeFrom: at(6).toISOString(),
    });
  });

  it("стык-в-стык: бронь, которая кончается ровно в начале окна, не держатель", async () => {
    const eq = await mkEq("Стык держателя", 1);
    await mkBooking("До начала окна", "CONFIRMED", at(170), at(171), [[eq.id, 1]]);
    const target = await mkBooking("Ц-стык", "CONFIRMED", at(171), at(172), []);
    const { findAddonConflict } = await import("../services/addonAvailability");
    expect(await findAddonConflict(eq.id, target.startDate, target.endDate, target.id)).toBeNull();
    expect(
      await findAddonConflict(eq.id, new Date(target.startDate.getTime() - 1), target.endDate, target.id),
    ).toMatchObject({ projectName: "До начала окна" });
  });

  it("мастерская: подвинуть чужую бронь можно, а сломанное взять нельзя", async () => {
    const eq = await mkEq("Ветродуй", 3);
    await prisma.repair.create({ data: { equipmentId: eq.id, quantity: 1, reason: "сгорел мотор", createdBy: "tester" } });
    await mkBooking("Чужой проект", "CONFIRMED", at(100), at(102), [[eq.id, 1]]);
    const target = await mkBooking("Ц10", "ISSUED", at(100), at(102), [[eq.id, 1]], { issuedAt: new Date() });
    const { findAddonConflict } = await import("../services/addonAvailability");

    // Физически 2 (3 − 1 в мастерской), чужая держит 1, у нас уже 1.
    const c = await findAddonConflict(eq.id, target.startDate, target.endDate, target.id, {
      requested: 1,
      alreadyInBooking: 1,
    });
    expect(c).toMatchObject({ projectName: "Чужой проект", freeForUs: 0, ackCap: 1 });
  });

  it("нехватка только из-за мастерской — не конфликт (держателя нет, это отказ по складу)", async () => {
    const eq = await mkEq("Только ремонт", 1);
    await prisma.repair.create({ data: { equipmentId: eq.id, quantity: 1, reason: "разбит", createdBy: "tester" } });
    const target = await mkBooking("Ц11", "CONFIRMED", at(110), at(112), []);
    const { findAddonConflict } = await import("../services/addonAvailability");
    expect(await findAddonConflict(eq.id, target.startDate, target.endDate, target.id)).toBeNull();
  });

  it("несколько держателей — показан тот, что начинается раньше", async () => {
    const eq = await mkEq("Два держателя", 2);
    await mkBooking("Поздний", "CONFIRMED", at(121), at(123), [[eq.id, 1]]);
    const early = await mkBooking("Ранний", "CONFIRMED", at(120), at(122), [[eq.id, 1]]);
    const target = await mkBooking("Ц12", "CONFIRMED", at(120), at(123), []);
    const { findAddonConflict } = await import("../services/addonAvailability");
    const c = await findAddonConflict(eq.id, target.startDate, target.endDate, target.id);
    expect(c?.bookingId).toBe(early.id);
  });

  it("работает внутри транзакции", async () => {
    const eq = await mkEq("В транзакции", 1);
    await mkBooking("Держатель в tx", "CONFIRMED", at(130), at(132), [[eq.id, 1]]);
    const target = await mkBooking("Ц13", "CONFIRMED", at(130), at(132), []);
    const { findAddonConflict } = await import("../services/addonAvailability");
    const c = await prisma.$transaction((tx: any) =>
      findAddonConflict(eq.id, target.startDate, target.endDate, target.id, { tx }),
    );
    expect(c).toMatchObject({ projectName: "Держатель в tx" });
  });

  it("неизвестная позиция — null", async () => {
    const target = await mkBooking("Ц14", "CONFIRMED", at(140), at(141), []);
    const { findAddonConflict } = await import("../services/addonAvailability");
    expect(await findAddonConflict("no-such-equipment", target.startDate, target.endDate, target.id)).toBeNull();
  });
});

describe("findHoldersBatch", () => {
  it("держатели по нескольким позициям одним вызовом; «уже в брони» берётся из брони", async () => {
    const held = await mkEq("Занятая", 2);
    const free = await mkEq("Никем не занятая", 2);
    const holder = await mkBooking("Держит пакетно", "CONFIRMED", at(150), at(152), [[held.id, 1]]);
    await mkBooking("Черновик пакетно", "DRAFT", at(150), at(152), [[free.id, 2]]);
    const target = await mkBooking("Ц15", "CONFIRMED", at(150), at(152), [[held.id, 1]]);
    const { findHoldersBatch } = await import("../services/addonAvailability");

    const map = await findHoldersBatch(prisma, {
      equipmentIds: [held.id, free.id],
      start: target.startDate,
      end: target.endDate,
      excludeBookingId: target.id,
    });
    expect(map.has(free.id)).toBe(false);
    expect(map.get(held.id)).toMatchObject({
      bookingId: holder.id,
      projectName: "Держит пакетно",
      holderStatus: "CONFIRMED",
      freeForUs: 0, // 2 − 1 чужая − 1 уже наша
      ackCap: 1, // 2 − 1 наша
    });
  });

  it("саму бронь держателем не считает", async () => {
    const eq = await mkEq("Только своя", 1);
    const target = await mkBooking("Ц16", "CONFIRMED", at(160), at(162), [[eq.id, 1]]);
    const { findHoldersBatch } = await import("../services/addonAvailability");
    const map = await findHoldersBatch(prisma, {
      equipmentIds: [eq.id],
      start: target.startDate,
      end: target.endDate,
      excludeBookingId: target.id,
    });
    expect(map.size).toBe(0);
  });

  it("пустой список позиций — пустой ответ без запросов к базе", async () => {
    const { findHoldersBatch } = await import("../services/addonAvailability");
    const map = await findHoldersBatch(prisma, { equipmentIds: [], start: at(1), end: at(2), excludeBookingId: "x" });
    expect(map.size).toBe(0);
  });
});
