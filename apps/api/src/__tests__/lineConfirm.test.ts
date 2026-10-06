/**
 * Подтверждение брони и резерв штучных единиц — по сроку каждой позиции.
 *
 * Длинная позиция (свои смены сверх брони) проверяется на складе до своего
 * срока возврата, и единица под неё подбирается свободной на всё это время.
 * Заодно подбор единиц при подтверждении и при правке брони идёт через общий
 * stockCap, а не через свою копию правил: архив не держит единицы, брони
 * стык-в-стык не пересекаются, а бронь, вернувшаяся с подтверждения на
 * согласование, не резервирует единицы второй раз.
 *
 * BookingItem.shifts пока не пишет ни форма, ни API — здесь поле ставится
 * прямо в базе.
 */

import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-line-confirm.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-lcf";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-line-confirm";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-lcf";
process.env.JWT_SECRET = "test-jwt-line-confirm-16chars";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Ровный час через неделю — без зашитых календарных дат.
const T0 = Math.ceil((Date.now() + 7 * DAY) / HOUR) * HOUR;
const at = (ms: number) => new Date(T0 + ms);

let app: Express;
let prisma: any;
let saToken: string;
let confirmBooking: typeof import("../services/bookings").confirmBooking;
let formatMoscowDayTime: typeof import("../utils/moscowDate").formatMoscowDayTime;
let clientId: string;
let seq = 0;

const AUTH = () => ({ "X-API-Key": "test-key-lcf", Authorization: `Bearer ${saToken}` });

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, DATABASE_URL: `file:${TEST_DB_PATH}`, PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes" },
    stdio: "pipe",
  });
  app = (await import("../app")).app;
  prisma = (await import("../prisma")).prisma;
  ({ confirmBooking } = await import("../services/bookings"));
  ({ formatMoscowDayTime } = await import("../utils/moscowDate"));
  const { signSession } = await import("../services/auth");
  const sa = await prisma.adminUser.create({ data: { username: "sa-lcf", passwordHash: "x", role: "SUPER_ADMIN" } });
  saToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });
  clientId = (await prisma.client.create({ data: { name: "Клиент подтверждения" } })).id;
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
  for (const s of ["", "-wal", "-shm", "-journal"]) {
    try { fs.unlinkSync(TEST_DB_PATH + s); } catch { /* ignore */ }
  }
});

async function mkEq(name: string, totalQuantity: number, mode: "COUNT" | "UNIT" = "COUNT") {
  seq += 1;
  const id = (
    await prisma.equipment.create({
      data: { importKey: `lcf-${seq}`, name, category: "Свет", rentalRatePerShift: "1000", stockTrackingMode: mode, totalQuantity },
    })
  ).id as string;
  const units: string[] = [];
  if (mode === "UNIT") {
    for (let i = 0; i < totalQuantity; i++) {
      units.push((await prisma.equipmentUnit.create({ data: { equipmentId: id, status: "AVAILABLE", barcode: `LCF-${seq}-${i}` } })).id);
    }
  }
  return { id, units };
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
        items: { create: items.map((i) => ({ equipmentId: i.equipmentId, quantity: i.quantity, shifts: i.shifts ?? null })) },
        ...extra,
      },
    })
  ).id as string;
}

/** Живой резерв единицы за позицией брони. */
async function holdUnit(bookingId: string, unitId: string) {
  const item = await prisma.bookingItem.findFirst({ where: { bookingId } });
  await prisma.bookingItemUnit.create({ data: { bookingItemId: item.id, equipmentUnitId: unitId } });
}

const liveUnits = async (bookingId: string) =>
  (
    await prisma.bookingItemUnit.findMany({
      where: { returnedAt: null, bookingItem: { bookingId } },
      select: { equipmentUnitId: true },
    })
  ).map((r: { equipmentUnitId: string }) => r.equipmentUnitId);

async function confirmError(bookingId: string) {
  try {
    await confirmBooking(bookingId);
  } catch (err) {
    return err as { status: number; message: string; code?: string; details?: any };
  }
  throw new Error("ожидали отказ подтверждения");
}

describe("подтверждение: склад проверяется до срока позиции", () => {
  it("нехватка на дополнительные сутки длинной позиции — отказ с её сроком", async () => {
    const eq = await mkEq("Aputure STORM 400x", 1);
    // На вторые сутки прибор уже обещан другой брони.
    await mkBooking("CONFIRMED", at(DAY), at(2 * DAY), [{ equipmentId: eq.id, quantity: 1 }]);
    const mine = await mkBooking("DRAFT", at(0), at(DAY), [{ equipmentId: eq.id, quantity: 1, shifts: 2 }]);
    const err = await confirmError(mine);
    expect(err.status).toBe(409);
    const [conflict] = err.details.conflicts;
    expect(conflict.equipmentId).toBe(eq.id);
    expect(conflict.until).toBe(at(2 * DAY).toISOString());
    expect(err.message).toContain(`Aputure STORM 400x (до ${formatMoscowDayTime(at(2 * DAY))})`);
    expect((await prisma.booking.findUnique({ where: { id: mine } })).status).toBe("DRAFT");
  });

  it("та же бронь без своих смен подтверждается — соседка на вторые сутки не мешает", async () => {
    const eq = await mkEq("Nanlux Evoke 1200", 1);
    await mkBooking("CONFIRMED", at(DAY), at(2 * DAY), [{ equipmentId: eq.id, quantity: 1 }]);
    const mine = await mkBooking("DRAFT", at(0), at(DAY), [{ equipmentId: eq.id, quantity: 1 }]);
    const confirmed = await confirmBooking(mine);
    expect(confirmed.status).toBe("CONFIRMED");
  });

  it("длинная и обычная позиции одной брони — каждая на своём окне", async () => {
    const longEq = await mkEq("Прибор на 2 смены", 1);
    const shortEq = await mkEq("Стойка", 1);
    // На вторые сутки соседка берёт стойку: обычной позиции брони это не мешает.
    await mkBooking("CONFIRMED", at(DAY), at(2 * DAY), [{ equipmentId: shortEq.id, quantity: 1 }]);
    const mine = await mkBooking("DRAFT", at(0), at(DAY), [
      { equipmentId: longEq.id, quantity: 1, shifts: 2 },
      { equipmentId: shortEq.id, quantity: 1 },
    ]);
    expect((await confirmBooking(mine)).status).toBe("CONFIRMED");
  });
});

describe("подтверждение: подбор штучных единиц", () => {
  it("единица под длинную позицию свободна на всё её время", async () => {
    const eq = await mkEq("Объектив Zeiss", 2, "UNIT");
    const other = await mkBooking("CONFIRMED", at(DAY), at(2 * DAY), [{ equipmentId: eq.id, quantity: 1 }]);
    await holdUnit(other, eq.units[0]);
    const mine = await mkBooking("DRAFT", at(0), at(DAY), [{ equipmentId: eq.id, quantity: 1, shifts: 2 }]);
    await confirmBooking(mine);
    expect(await liveUnits(mine)).toEqual([eq.units[1]]);
  });

  it("бронь стык-в-стык единицу не держит", async () => {
    const eq = await mkEq("Объектив Cooke", 1, "UNIT");
    const next = await mkBooking("CONFIRMED", at(DAY), at(2 * DAY), [{ equipmentId: eq.id, quantity: 1 }]);
    await holdUnit(next, eq.units[0]);
    const mine = await mkBooking("DRAFT", at(0), at(DAY), [{ equipmentId: eq.id, quantity: 1 }]);
    await confirmBooking(mine);
    expect(await liveUnits(mine)).toEqual([eq.units[0]]);
  });

  it("бронь в архиве единицу не держит", async () => {
    const eq = await mkEq("Объектив Leica", 1, "UNIT");
    const archived = await mkBooking("CONFIRMED", at(0), at(DAY), [{ equipmentId: eq.id, quantity: 1 }], {
      deletedAt: new Date(),
    });
    await holdUnit(archived, eq.units[0]);
    const mine = await mkBooking("DRAFT", at(0), at(DAY), [{ equipmentId: eq.id, quantity: 1 }]);
    await confirmBooking(mine);
    expect(await liveUnits(mine)).toEqual([eq.units[0]]);
  });

  it("вернули с подтверждения на согласование и одобрили снова — без второго резерва", async () => {
    const eq = await mkEq("Объектив Angenieux", 2, "UNIT");
    const mine = await mkBooking("DRAFT", at(0), at(DAY), [{ equipmentId: eq.id, quantity: 1 }]);
    await confirmBooking(mine);
    const first = await liveUnits(mine);
    expect(first).toHaveLength(1);
    // «Отправить на согласование» у подтверждённой брони резервы не снимает.
    await prisma.booking.update({ where: { id: mine }, data: { status: "PENDING_APPROVAL" } });
    expect((await confirmBooking(mine)).status).toBe("CONFIRMED");
    expect(await liveUnits(mine)).toEqual(first);
  });
});

describe("правка подтверждённой брони: перерезерв единиц на новых датах", () => {
  it("сдвиг брони к соседке стык-в-стык не упирается в её единицу", async () => {
    const eq = await mkEq("Объектив Sigma", 1, "UNIT");
    const mine = await mkBooking("DRAFT", at(0), at(DAY), [{ equipmentId: eq.id, quantity: 1 }]);
    await confirmBooking(mine);
    // Соседка со следующих суток держит ту же единицу (до её начала она на полке).
    const next = await mkBooking("CONFIRMED", at(2 * DAY), at(3 * DAY), [{ equipmentId: eq.id, quantity: 1 }]);
    await holdUnit(next, eq.units[0]);
    // Сдвигаем бронь вплотную к соседке: конец ровно в её начало.
    const res = await request(app)
      .patch(`/api/bookings/${mine}`)
      .set(AUTH())
      .send({
        startDate: at(DAY).toISOString(),
        endDate: at(2 * DAY).toISOString(),
        items: [{ equipmentId: eq.id, quantity: 1 }],
      });
    expect(res.status).toBe(200);
    expect(await liveUnits(mine)).toEqual([eq.units[0]]);
  });

  it("правка, где единицы действительно нет, — отказ NOT_ENOUGH_UNITS", async () => {
    const eq = await mkEq("Объектив Tokina", 1, "UNIT");
    const mine = await mkBooking("DRAFT", at(0), at(DAY), [{ equipmentId: eq.id, quantity: 1 }]);
    await confirmBooking(mine);
    const other = await mkBooking("CONFIRMED", at(2 * DAY), at(3 * DAY), [{ equipmentId: eq.id, quantity: 1 }]);
    await holdUnit(other, eq.units[0]);
    const res = await request(app)
      .patch(`/api/bookings/${mine}`)
      .set(AUTH())
      .send({
        startDate: at(2 * DAY).toISOString(),
        endDate: at(3 * DAY).toISOString(),
        items: [{ equipmentId: eq.id, quantity: 1 }],
      });
    expect(res.status).toBe(409);
  });
});
