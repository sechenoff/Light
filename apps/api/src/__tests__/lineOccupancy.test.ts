/**
 * Длинная позиция держит склад до своего срока (смены по позициям, ядро).
 *
 * Бронь на 1 смену, а пару приборов берут на двое суток: BookingItem.shifts = 2.
 * Такая позиция занята до конца брони плюс лишние смены, остальные позиции —
 * до конца брони. Пока ни форма, ни API поле не пишут, поэтому здесь оно
 * ставится прямо в базе; без него всё считается как раньше.
 */

import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-line-occupancy.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-line-occupancy-16chars";
process.env.BARCODE_SECRET = "test-secret-line-occupancy";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Ровный час через неделю — без зашитых календарных дат.
const T0 = Math.ceil((Date.now() + 7 * DAY) / HOUR) * HOUR;
const at = (ms: number) => new Date(T0 + ms);

let prisma: any;
let getAvailability: typeof import("../services/availability").getAvailability;
let lineOccupancyInterval: typeof import("../services/availability").lineOccupancyInterval;
let computeAddCaps: typeof import("../services/stockCap").computeAddCaps;
let listFreeUnitIds: typeof import("../services/stockCap").listFreeUnitIds;
let findAddonConflict: typeof import("../services/addonAvailability").findAddonConflict;
let findHoldersBatch: typeof import("../services/addonAvailability").findHoldersBatch;
let clientId: string;
let seq = 0;

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, DATABASE_URL: `file:${TEST_DB_PATH}`, PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes" },
    stdio: "pipe",
  });
  prisma = (await import("../prisma")).prisma;
  ({ getAvailability, lineOccupancyInterval } = await import("../services/availability"));
  ({ computeAddCaps, listFreeUnitIds } = await import("../services/stockCap"));
  ({ findAddonConflict, findHoldersBatch } = await import("../services/addonAvailability"));
  clientId = (await prisma.client.create({ data: { name: "Клиент длинных позиций" } })).id;
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
      data: { importKey: `lo-${seq}`, name, category: "Свет", rentalRatePerShift: "1000", stockTrackingMode: mode, totalQuantity },
    })
  ).id as string;
}

async function mkBooking(
  status: string,
  start: Date,
  end: Date,
  items: Array<{ equipmentId: string; quantity: number; shifts?: number | null }>,
  extra: Record<string, unknown> = {},
) {
  seq += 1;
  return (
    await prisma.booking.create({
      data: {
        clientId,
        projectName: `Бронь ${seq}`,
        status,
        startDate: start,
        endDate: end,
        ...(status === "ISSUED" ? { issuedAt: start } : {}),
        items: { create: items.map((i) => ({ equipmentId: i.equipmentId, quantity: i.quantity, shifts: i.shifts ?? null })) },
        ...extra,
      },
    })
  ).id as string;
}

const occupied = async (equipmentId: string, start: Date, end: Date, excludeBookingId?: string) =>
  (await getAvailability({ startDate: start, endDate: end, equipmentIds: [equipmentId], excludeBookingId }))[0]
    .occupiedQuantity;

describe("lineOccupancyInterval", () => {
  const b = { status: "CONFIRMED" as const, startDate: at(0), endDate: at(DAY), issuedAt: null, skipPartialDay: false };
  it("без своих смен — как бронь", () => {
    expect(lineOccupancyInterval(b, null)).toEqual({ start: T0, end: T0 + DAY, dueAt: T0 + DAY });
  });
  it("2 смены на брони в 1 смену — на сутки дольше", () => {
    expect(lineOccupancyInterval(b, 2)).toEqual({ start: T0, end: T0 + 2 * DAY, dueAt: T0 + 2 * DAY });
  });
  it("своё число не больше смен брони — как бронь", () => {
    expect(lineOccupancyInterval({ ...b, endDate: at(3 * DAY) }, 2).end).toBe(T0 + 3 * DAY);
  });
  it("«не считать вторые сутки»: смены брони с прощённым хвостом", () => {
    // 1 сутки + 3 ч при прощении хвоста — 1 смена; строка на 2 смены ждёт сутками позже конца.
    const r = lineOccupancyInterval({ ...b, endDate: at(DAY + 3 * HOUR), skipPartialDay: true }, 2);
    expect(r.dueAt).toBe(T0 + 2 * DAY + 3 * HOUR);
  });
  it("выданная и просроченная длинная позиция держит склад до сейчас", () => {
    const now = T0 + 5 * DAY;
    const r = lineOccupancyInterval({ ...b, status: "ISSUED", issuedAt: at(0) }, 2, now);
    expect(r.dueAt).toBe(T0 + 2 * DAY);
    expect(r.end).toBe(now + 1);
  });
});

describe("доступность", () => {
  it("на вторые сутки занята только длинная позиция", async () => {
    const longEq = await mkEq("Aputure STORM 400x", 2);
    const shortEq = await mkEq("Стойка C-Stand", 10);
    await mkBooking("CONFIRMED", at(0), at(DAY), [
      { equipmentId: longEq, quantity: 2, shifts: 2 },
      { equipmentId: shortEq, quantity: 6 },
    ]);
    expect(await occupied(longEq, at(DAY), at(2 * DAY))).toBe(2);
    expect(await occupied(shortEq, at(DAY), at(2 * DAY))).toBe(0);
    expect(await occupied(longEq, at(2 * DAY), at(3 * DAY))).toBe(0); // стык-в-стык
  });

  it("без своих смен — ровно как раньше", async () => {
    const eq = await mkEq("Nanlux Evoke 1200", 3);
    await mkBooking("CONFIRMED", at(0), at(DAY), [{ equipmentId: eq, quantity: 2 }]);
    expect(await occupied(eq, at(0), at(DAY))).toBe(2);
    expect(await occupied(eq, at(DAY), at(2 * DAY))).toBe(0);
  });

  it("бронь кончилась до окна, а длинная позиция ещё в нём — её видно", async () => {
    const eq = await mkEq("Дым-машина", 1);
    // Бронь на 1 смену, позиция на 10 смен: окно с 5-х по 6-е сутки.
    await mkBooking("CONFIRMED", at(0), at(DAY), [{ equipmentId: eq, quantity: 1, shifts: 10 }]);
    expect(await occupied(eq, at(5 * DAY), at(6 * DAY))).toBe(1);
    expect(await occupied(eq, at(10 * DAY), at(11 * DAY))).toBe(0);
  });

  it("черновик длинной позицией склад не держит", async () => {
    const eq = await mkEq("Флаг 60×90", 1);
    await mkBooking("DRAFT", at(0), at(DAY), [{ equipmentId: eq, quantity: 1, shifts: 3 }]);
    expect(await occupied(eq, at(DAY), at(2 * DAY))).toBe(0);
  });
});

describe("потолок добора и держатель", () => {
  it("добор в длинную позицию считается на её окне до срока", async () => {
    const eq = await mkEq("ARRI SkyPanel S60", 3);
    const mine = await mkBooking("CONFIRMED", at(0), at(DAY), [{ equipmentId: eq, quantity: 1, shifts: 2 }]);
    // Чужая бронь берёт 2 шт на вторые сутки — пересекается только с длинным хвостом.
    await mkBooking("CONFIRMED", at(DAY), at(2 * DAY), [{ equipmentId: eq, quantity: 2 }]);
    const caps = await computeAddCaps(prisma, {
      bookingId: mine,
      equipmentIds: [eq],
      window: { start: at(0), end: at(DAY) },
    });
    const cap = caps.get(eq)!;
    expect(cap.occupiedByOthers).toBe(2);
    expect(cap.addCap).toBe(0); // 3 всего − 2 у соседа − 1 уже в брони
  });

  it("у обычной позиции той же брони окно — до конца брони", async () => {
    const eq = await mkEq("Aputure LS 60x", 3);
    const other = await mkEq("Свет-заглушка", 1);
    const mine = await mkBooking("CONFIRMED", at(0), at(DAY), [
      { equipmentId: eq, quantity: 1 },
      { equipmentId: other, quantity: 1, shifts: 2 },
    ]);
    await mkBooking("CONFIRMED", at(DAY), at(2 * DAY), [{ equipmentId: eq, quantity: 2 }]);
    const cap = (await computeAddCaps(prisma, { bookingId: mine, equipmentIds: [eq], window: { start: at(0), end: at(DAY) } })).get(eq)!;
    expect(cap.occupiedByOthers).toBe(0);
    expect(cap.addCap).toBe(2);
  });

  it("карточка держателя: «освободится» — срок длинной позиции, а не конец брони", async () => {
    const eq = await mkEq("Hazer Look", 1);
    await mkBooking("CONFIRMED", at(0), at(DAY), [{ equipmentId: eq, quantity: 1, shifts: 3 }]);
    const asker = await mkBooking("CONFIRMED", at(DAY), at(2 * DAY), []);
    const conflict = await findAddonConflict(eq, at(DAY), at(2 * DAY), asker, { requested: 1 });
    expect(conflict).not.toBeNull();
    expect(conflict!.to).toBe(at(3 * DAY).toISOString());
    expect(conflict!.freeFrom).toBe(at(3 * DAY).toISOString());
    expect(conflict!.overdue).toBe(false);
  });
});

describe("окно длинной позиции у той брони, что добирает", () => {
  it("держатель хвоста длинной позиции виден и в карточке, и в пакетном поиске", async () => {
    const eq = await mkEq("Кран Jimmy Jib", 1);
    // Добираем в бронь на 1 смену, где эта позиция взята на 2 смены.
    const mine = await mkBooking("CONFIRMED", at(0), at(DAY), [{ equipmentId: eq, quantity: 1, shifts: 2 }]);
    const other = await mkBooking("CONFIRMED", at(DAY), at(2 * DAY), [{ equipmentId: eq, quantity: 1 }]);
    const conflict = await findAddonConflict(eq, at(0), at(DAY), mine, { requested: 1, alreadyInBooking: 1 });
    expect(conflict?.bookingId).toBe(other);
    const batch = await findHoldersBatch(prisma, { equipmentIds: [eq], start: at(0), end: at(DAY), excludeBookingId: mine });
    expect(batch.get(eq)?.bookingId).toBe(other);
  });

  it("единица под длинную позицию подбирается свободной на всё её время", async () => {
    const eq = await mkEq("Объектив Zeiss", 2, "UNIT");
    const units: string[] = [];
    for (let i = 0; i < 2; i++) {
      units.push((await prisma.equipmentUnit.create({ data: { equipmentId: eq, status: "AVAILABLE", barcode: `LO-Z-${seq}-${i}` } })).id);
    }
    // Чужая бронь на вторые сутки уже держит первую единицу.
    const other = await mkBooking("CONFIRMED", at(DAY), at(2 * DAY), [{ equipmentId: eq, quantity: 1 }]);
    const otherItem = await prisma.bookingItem.findFirst({ where: { bookingId: other } });
    await prisma.bookingItemUnit.create({ data: { bookingItemId: otherItem.id, equipmentUnitId: units[0] } });
    const mine = await mkBooking("CONFIRMED", at(0), at(DAY), [{ equipmentId: eq, quantity: 1, shifts: 2 }]);
    const mineItem = await prisma.bookingItem.findFirst({ where: { bookingId: mine } });
    const free = await listFreeUnitIds(prisma, { bookingId: mine, bookingItemId: mineItem.id, equipmentId: eq, start: at(0), end: at(DAY) });
    expect(free).toEqual([units[1]]);
  });
});

describe("штучный учёт", () => {
  it("единицу держит длинная позиция чужой брони и после конца той брони", async () => {
    const eq = await mkEq("Объектив Cooke", 2, "UNIT");
    const units = [];
    for (let i = 0; i < 2; i++) {
      units.push(
        (await prisma.equipmentUnit.create({ data: { equipmentId: eq, status: "AVAILABLE", barcode: `LO-U-${seq}-${i}` } })).id,
      );
    }
    const holder = await mkBooking("CONFIRMED", at(0), at(DAY), [{ equipmentId: eq, quantity: 1, shifts: 2 }]);
    const holderItem = await prisma.bookingItem.findFirst({ where: { bookingId: holder } });
    await prisma.bookingItemUnit.create({ data: { bookingItemId: holderItem.id, equipmentUnitId: units[0] } });
    const asker = await mkBooking("CONFIRMED", at(DAY), at(2 * DAY), []);
    const free = await listFreeUnitIds(prisma, { bookingId: asker, bookingItemId: null, equipmentId: eq, start: at(DAY), end: at(2 * DAY) });
    expect(free).toEqual([units[1]]);
    // После срока длинной позиции свободны обе.
    const later = await listFreeUnitIds(prisma, { bookingId: asker, bookingItemId: null, equipmentId: eq, start: at(2 * DAY), end: at(3 * DAY) });
    expect(later.sort()).toEqual([...units].sort());
  });
});

describe("выданная бронь с длинной позицией (по текущему моменту)", () => {
  // Окно «сейчас»: просроченная выданная держит склад, пока в окне текущий момент.
  const N = Math.floor(Date.now() / HOUR) * HOUR;
  const nowWindow = () => ({ start: new Date(Date.now()), end: new Date(Date.now() + HOUR) });

  it("срок брони прошёл, а позиции — ещё нет: не просрочено, освободится в срок позиции", async () => {
    const eq = await mkEq("Aputure 1200d", 1);
    // Бронь на 1 смену закончилась вчера, позиция взята на 3 смены — ждём её завтра.
    await mkBooking("ISSUED", new Date(N - 2 * DAY), new Date(N - DAY), [{ equipmentId: eq, quantity: 1, shifts: 3 }]);
    const w = nowWindow();
    expect(await occupied(eq, w.start, w.end)).toBe(1);
    const asker = await mkBooking("CONFIRMED", w.start, w.end, []);
    const conflict = await findAddonConflict(eq, w.start, w.end, asker, { requested: 1 });
    expect(conflict?.holderStatus).toBe("ISSUED");
    expect(conflict?.overdue).toBe(false);
    expect(conflict?.freeFrom).toBe(new Date(N + DAY).toISOString());
  });

  it("срок позиции тоже прошёл: просрочено, держит склад до приёмки", async () => {
    const eq = await mkEq("Godox M600d", 1);
    await mkBooking("ISSUED", new Date(N - 3 * DAY), new Date(N - 2 * DAY), [{ equipmentId: eq, quantity: 1, shifts: 2 }]);
    const w = nowWindow();
    expect(await occupied(eq, w.start, w.end)).toBe(1);
    const asker = await mkBooking("CONFIRMED", w.start, w.end, []);
    const conflict = await findAddonConflict(eq, w.start, w.end, asker, { requested: 1 });
    expect(conflict?.overdue).toBe(true);
    expect(conflict?.freeFrom).toBeNull();
    expect(conflict?.to).toBe(new Date(N - DAY).toISOString());
  });

  it("выданная раньше начала: длинная позиция занята с момента выдачи", async () => {
    const eq = await mkEq("Kino Flo Celeb", 1);
    // Начало брони — завтра, но выдали уже сейчас.
    await mkBooking("ISSUED", new Date(N + DAY), new Date(N + 2 * DAY), [{ equipmentId: eq, quantity: 1, shifts: 2 }], {
      issuedAt: new Date(N - HOUR),
    });
    const w = nowWindow();
    expect(await occupied(eq, w.start, w.end)).toBe(1);
    expect(await occupied(eq, new Date(N + 2 * DAY + HOUR), new Date(N + 2 * DAY + 2 * HOUR))).toBe(1);
    expect(await occupied(eq, new Date(N + 3 * DAY), new Date(N + 3 * DAY + HOUR))).toBe(0);
  });
});

describe("разные сроки строк и «не считать вторые сутки» через выборку", () => {
  it("две длинные позиции одной брони — каждая на своём окне", async () => {
    const eqA = await mkEq("Прибор на 2 смены", 1);
    const eqB = await mkEq("Прибор на 3 смены", 1);
    const eqC = await mkEq("Обычная позиция", 1);
    const mine = await mkBooking("CONFIRMED", at(0), at(DAY), [
      { equipmentId: eqA, quantity: 1, shifts: 2 },
      { equipmentId: eqB, quantity: 1, shifts: 3 },
      { equipmentId: eqC, quantity: 1 },
    ]);
    // Вторые сутки: соседи берут A и C. Третьи сутки: сосед берёт B.
    const day2 = await mkBooking("CONFIRMED", at(DAY), at(2 * DAY), [
      { equipmentId: eqA, quantity: 1 },
      { equipmentId: eqC, quantity: 1 },
    ]);
    const day3 = await mkBooking("CONFIRMED", at(2 * DAY), at(3 * DAY), [{ equipmentId: eqB, quantity: 1 }]);
    const caps = await computeAddCaps(prisma, {
      bookingId: mine,
      equipmentIds: [eqA, eqB, eqC],
      window: { start: at(0), end: at(DAY) },
    });
    expect(caps.get(eqA)!.occupiedByOthers).toBe(1);
    expect(caps.get(eqB)!.occupiedByOthers).toBe(1);
    expect(caps.get(eqC)!.occupiedByOthers).toBe(0);
    const batch = await findHoldersBatch(prisma, {
      equipmentIds: [eqA, eqB, eqC],
      start: at(0),
      end: at(DAY),
      excludeBookingId: mine,
    });
    expect(batch.get(eqA)?.bookingId).toBe(day2);
    expect(batch.get(eqB)?.bookingId).toBe(day3);
    expect(batch.has(eqC)).toBe(false);
  });

  it("«не считать вторые сутки» у брони сдвигает срок длинной позиции", async () => {
    const forgiven = await mkEq("Прощённый хвост", 1);
    const counted = await mkEq("Хвост считается", 1);
    // Сутки + 3 ч. С прощением хвоста это 1 смена, позиция на 2 смены ждёт до 2 сут + 3 ч.
    await mkBooking("CONFIRMED", at(0), at(DAY + 3 * HOUR), [{ equipmentId: forgiven, quantity: 1, shifts: 2 }], {
      skipPartialDay: true,
    });
    // Без прощения это уже 2 смены: позиция на 2 смены идёт со всей бронью.
    await mkBooking("CONFIRMED", at(0), at(DAY + 3 * HOUR), [{ equipmentId: counted, quantity: 1, shifts: 2 }]);
    expect(await occupied(forgiven, at(2 * DAY + HOUR), at(2 * DAY + 2 * HOUR))).toBe(1);
    expect(await occupied(forgiven, at(2 * DAY + 3 * HOUR), at(2 * DAY + 4 * HOUR))).toBe(0);
    expect(await occupied(counted, at(2 * DAY + HOUR), at(2 * DAY + 2 * HOUR))).toBe(0);
  });

  it("предел своих смен: дальний хвост виден в выборке, сверх предела — обрезан", async () => {
    const atLimit = await mkEq("Позиция на предел", 1);
    const overLimit = await mkEq("Позиция сверх предела", 1);
    await mkBooking("CONFIRMED", at(0), at(DAY), [{ equipmentId: atLimit, quantity: 1, shifts: 60 }]);
    await mkBooking("CONFIRMED", at(0), at(DAY), [{ equipmentId: overLimit, quantity: 1, shifts: 100 }]);
    // Срок обеих — 60-е сутки: бронь кончилась за 58 суток до окна, а выборка её находит.
    expect(await occupied(atLimit, at(59 * DAY), at(59 * DAY + HOUR))).toBe(1);
    expect(await occupied(overLimit, at(59 * DAY), at(59 * DAY + HOUR))).toBe(1);
    expect(await occupied(atLimit, at(60 * DAY), at(60 * DAY + HOUR))).toBe(0);
    // Без обрезки 100 смен держали бы позицию до 100-х суток: на 61-х выборка её ещё находит.
    expect(await occupied(overLimit, at(61 * DAY), at(61 * DAY + HOUR))).toBe(0);
  });
});
