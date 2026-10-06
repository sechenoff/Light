/**
 * Календарь, инвентаризация, ручные потеряшки и «как пропало» видят длинную
 * позицию до её срока, а не до конца брони.
 *
 * Длинная позиция — свои смены сверх брони (BookingItem.shifts). Пока поле не
 * пишет ни форма, ни API, оно ставится прямо в базе; без него всё как раньше.
 */

import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-line-calendar-count.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-lcc";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-line-calendar";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-lcc";
process.env.JWT_SECRET = "test-jwt-line-calendar-16chars";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Будущее — от ровного часа через неделю, прошлое — от текущего часа.
const T0 = Math.ceil((Date.now() + 7 * DAY) / HOUR) * HOUR;
const N = Math.floor(Date.now() / HOUR) * HOUR;
const at = (ms: number) => new Date(T0 + ms);

let app: Express;
let prisma: any;
let saToken: string;
let saId: string;
let computeExpectedOnShelf: typeof import("../services/stockCount/expected").computeExpectedOnShelf;
let createManualProblemItem: typeof import("../services/problemItemService").createManualProblemItem;
let loadTrailCores: typeof import("../services/stockCount/equipmentTrail").loadTrailCores;
let clientId: string;
let seq = 0;

const AUTH = () => ({ "X-API-Key": "test-key-lcc", Authorization: `Bearer ${saToken}` });

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, DATABASE_URL: `file:${TEST_DB_PATH}`, PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes" },
    stdio: "pipe",
  });
  app = (await import("../app")).app;
  prisma = (await import("../prisma")).prisma;
  ({ computeExpectedOnShelf } = await import("../services/stockCount/expected"));
  ({ createManualProblemItem } = await import("../services/problemItemService"));
  ({ loadTrailCores } = await import("../services/stockCount/equipmentTrail"));
  const { signSession } = await import("../services/auth");
  const sa = await prisma.adminUser.create({ data: { username: "sa-lcc", passwordHash: "x", role: "SUPER_ADMIN" } });
  saId = sa.id;
  saToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });
  clientId = (await prisma.client.create({ data: { name: "Клиент календаря" } })).id;
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
  for (const s of ["", "-wal", "-shm", "-journal"]) {
    try { fs.unlinkSync(TEST_DB_PATH + s); } catch { /* ignore */ }
  }
});

async function mkEq(name: string, totalQuantity: number) {
  seq += 1;
  return (
    await prisma.equipment.create({
      data: { importKey: `lcc-${seq}`, name, category: "Свет", rentalRatePerShift: "1000", stockTrackingMode: "COUNT", totalQuantity },
    })
  ).id as string;
}

async function mkBooking(
  status: string,
  start: Date,
  end: Date,
  items: Array<{ equipmentId: string; quantity: number; shifts?: number | null }>,
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
        items: { create: items.map((i) => ({ equipmentId: i.equipmentId, quantity: i.quantity, shifts: i.shifts ?? null })) },
      },
    })
  ).id as string;
}

describe("календарь", () => {
  it("длинная позиция видна до своего срока, обычная — до конца брони", async () => {
    const longEq = await mkEq("Aputure STORM 400x", 2);
    const shortEq = await mkEq("Стойка C-Stand", 10);
    const booking = await mkBooking("CONFIRMED", at(0), at(DAY), [
      { equipmentId: longEq, quantity: 2, shifts: 2 },
      { equipmentId: shortEq, quantity: 6 },
    ]);
    // Период — вторые сутки: бронь уже кончилась, длинная позиция ещё у клиента.
    const res = await request(app)
      .get("/api/calendar")
      .query({ start: at(DAY + HOUR).toISOString(), end: at(2 * DAY - HOUR).toISOString() })
      .set(AUTH());
    expect(res.status).toBe(200);
    const mine = res.body.events.filter((e: { bookingId: string }) => e.bookingId === booking);
    expect(mine).toHaveLength(1);
    expect(mine[0].resourceId).toBe(longEq);
    expect(mine[0].end).toBe(at(2 * DAY).toISOString());
  });

  it("в периоде самой брони обе позиции, у длинной — свой конец", async () => {
    const longEq = await mkEq("Nanlux Evoke 1200", 1);
    const shortEq = await mkEq("Флаг 60×90", 4);
    const booking = await mkBooking("CONFIRMED", at(0), at(DAY), [
      { equipmentId: longEq, quantity: 1, shifts: 3 },
      { equipmentId: shortEq, quantity: 2 },
    ]);
    const res = await request(app)
      .get("/api/calendar")
      .query({ start: at(0).toISOString(), end: at(DAY).toISOString() })
      .set(AUTH());
    const ends = Object.fromEntries(
      res.body.events
        .filter((e: { bookingId: string }) => e.bookingId === booking)
        .map((e: { resourceId: string; end: string }) => [e.resourceId, e.end]),
    );
    expect(ends[longEq]).toBe(at(3 * DAY).toISOString());
    expect(ends[shortEq]).toBe(at(DAY).toISOString());
  });
});

describe("инвентаризация: «на полке должно быть»", () => {
  it("подтверждённая бронь кончилась, длинная позиция ещё у клиента по календарю", async () => {
    const longEq = await mkEq("Дым-машина", 3);
    const shortEq = await mkEq("Удлинитель", 5);
    await mkBooking("CONFIRMED", at(0), at(DAY), [
      { equipmentId: longEq, quantity: 1, shifts: 3 },
      { equipmentId: shortEq, quantity: 2 },
    ]);
    const map = await computeExpectedOnShelf([longEq, shortEq], at(2 * DAY));
    expect(map.get(longEq)!.calendar).toBe(1);
    expect(map.get(longEq)!.expected).toBe(2);
    expect(map.get(longEq)!.calendarBookings[0].endDate).toBe(at(3 * DAY).toISOString());
    expect(map.get(shortEq)!.calendar).toBe(0);
    expect(map.get(shortEq)!.expected).toBe(5);
  });

  it("после срока длинной позиции её уже ждут на полке", async () => {
    const eq = await mkEq("Хейзер", 2);
    await mkBooking("CONFIRMED", at(0), at(DAY), [{ equipmentId: eq, quantity: 1, shifts: 2 }]);
    expect((await computeExpectedOnShelf([eq], at(2 * DAY + HOUR))).get(eq)!.calendar).toBe(0);
  });
});

describe("ручная потеряшка по брони", () => {
  it("бронь кончилась, но длинная позиция ещё по плану у клиента — карточку не заводим", async () => {
    const eq = await mkEq("Кран Jimmy Jib", 2);
    // Бронь на 1 смену кончилась вчера, позиция взята на 3 смены — ждём её завтра.
    const booking = await mkBooking("CONFIRMED", new Date(N - 2 * DAY), new Date(N - DAY), [
      { equipmentId: eq, quantity: 1, shifts: 3 },
    ]);
    await expect(
      createManualProblemItem(
        { equipmentId: eq, quantity: 1, reason: "LOST", comment: "Не нашли на складе", sourceBookingId: booking },
        { userId: saId, username: "sa-lcc" },
      ),
    ).rejects.toMatchObject({ status: 409, code: "BOOKING_STILL_OUT" });
  });

  it("та же бронь без своих смен уже не на съёмке — карточку можно завести", async () => {
    const eq = await mkEq("Кран Polecat", 2);
    const booking = await mkBooking("CONFIRMED", new Date(N - 2 * DAY), new Date(N - DAY), [
      { equipmentId: eq, quantity: 1 },
    ]);
    const created = await createManualProblemItem(
      { equipmentId: eq, quantity: 1, reason: "LOST", comment: "Не нашли на складе", sourceBookingId: booking },
      { userId: saId, username: "sa-lcc" },
    );
    expect(created).toBeTruthy();
  });
});

describe("«как пропало»: брони окна", () => {
  it("бронь кончилась до окна, а длинная позиция была в нём — бронь в списке", async () => {
    const eq = await mkEq("Объектив Zeiss", 2);
    const booking = await mkBooking("CONFIRMED", new Date(N - 10 * DAY), new Date(N - 9 * DAY), [
      { equipmentId: eq, quantity: 1, shifts: 3 },
    ]);
    // Окно с прошлого пересчёта — 8 суток назад: конец брони раньше, срок позиции — внутри.
    const { cores } = await loadTrailCores([{ equipmentId: eq, windowFrom: new Date(N - 8 * DAY), at: new Date(N) }]);
    expect(cores.get(eq)!.items.map((i) => i.booking.id)).toEqual([booking]);
  });

  it("без своих смен такая бронь в окно не попадает", async () => {
    const eq = await mkEq("Объектив Cooke", 2);
    await mkBooking("CONFIRMED", new Date(N - 10 * DAY), new Date(N - 9 * DAY), [{ equipmentId: eq, quantity: 1 }]);
    const { cores } = await loadTrailCores([{ equipmentId: eq, windowFrom: new Date(N - 8 * DAY), at: new Date(N) }]);
    expect(cores.get(eq)!.items).toHaveLength(0);
  });
});
