/**
 * Цена позиции по её своим сменам (BookingItem.shifts, «не меньше N»).
 *
 * Все построители сметы — черновик, пересборка, подтверждение, добор, вливание
 * добора и превью правки — считают каталожную строку на её смены: большее из
 * своих и смен брони. Число смен строки пишется в EstimateLine.shifts (по нему
 * документы делят цену). Правка брони переносит свои смены позиции, как и
 * договорную цену.
 *
 * Поле пока не пишет ни форма, ни API — здесь оно ставится прямо в базе.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-line-pricing.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-lpr";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-line-pricing";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-lpr";
process.env.JWT_SECRET = "test-jwt-line-pricing-16chars";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Бронь на 1 смену от ровного часа через неделю — без зашитых календарных дат.
const START = new Date(Math.ceil((Date.now() + 7 * DAY) / HOUR) * HOUR);
const END = new Date(START.getTime() + DAY);

let app: Express;
let prisma: any;
let saToken: string;
let saId: string;
let svc: typeof import("../services/bookings");
let addon: typeof import("../services/bookingAddon");
let carryItemOverrides: typeof import("../services/bookingItemOverrides").carryItemOverrides;
let storm: string; // 1 000 ₽ / смена
let stand: string; //   500 ₽ / смена

const AUTH = () => ({ "X-API-Key": "test-key-lpr", Authorization: `Bearer ${saToken}` });

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, DATABASE_URL: `file:${TEST_DB_PATH}`, PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes" },
    stdio: "pipe",
  });
  app = (await import("../app")).app;
  prisma = (await import("../prisma")).prisma;
  svc = await import("../services/bookings");
  addon = await import("../services/bookingAddon");
  carryItemOverrides = (await import("../services/bookingItemOverrides")).carryItemOverrides;
  const { signSession } = await import("../services/auth");
  const sa = await prisma.adminUser.create({ data: { username: "sa-lpr", passwordHash: "x", role: "SUPER_ADMIN" } });
  saId = sa.id;
  saToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });
  const mk = (key: string, name: string, rate: number) =>
    prisma.equipment.create({
      data: { importKey: key, name, category: "Свет", totalQuantity: 20, rentalRatePerShift: rate, stockTrackingMode: "COUNT" },
    });
  storm = (await mk("lpr-storm", "Aputure STORM 400x", 1000)).id;
  stand = (await mk("lpr-stand", "Стойка C-Stand", 500)).id;
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    const f = `${TEST_DB_PATH}${suffix}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

/** Черновик на 1 смену: STORM ×2, стойка ×1, своя позиция, скидка 50 %. */
async function createDraft(opts: { negotiated?: number } = {}) {
  const res = await request(app)
    .post("/api/bookings/draft")
    .set(AUTH())
    .send({
      client: { name: "Продакшн «Сфера»" },
      projectName: "Реклама кофейни «Зерно»",
      startDate: START.toISOString(),
      endDate: END.toISOString(),
      discountPercent: 50,
      items: [
        { equipmentId: storm, quantity: 2, ...(opts.negotiated ? { negotiatedRatePerShift: opts.negotiated } : {}) },
        { equipmentId: stand, quantity: 1 },
        { customName: "Расходники", customUnitPrice: 1500, quantity: 1 },
      ],
    });
  expect(res.status).toBe(200);
  return (res.body.booking?.id ?? res.body.id) as string;
}

const setLineShifts = (bookingId: string, equipmentId: string, shifts: number | null) =>
  prisma.bookingItem.update({ where: { bookingId_equipmentId: { bookingId, equipmentId } }, data: { shifts } });

async function estimate(bookingId: string, kind: "MAIN" | "ADDON" = "MAIN") {
  return prisma.estimate.findFirst({ where: { bookingId, kind }, include: { lines: true } });
}
const lineOf = (est: any, name: string) => est.lines.find((l: any) => l.nameSnapshot === name);

describe("черновик", () => {
  it("строки сметы хранят число смен; у своей позиции — пусто", async () => {
    const id = await createDraft();
    const main = await estimate(id);
    expect(main.shifts).toBe(1);
    expect(lineOf(main, "Aputure STORM 400x").shifts).toBe(1);
    expect(lineOf(main, "Стойка C-Stand").shifts).toBe(1);
    expect(lineOf(main, "Расходники").shifts).toBeNull();
  });
});

describe("длинная позиция в смете", () => {
  it("пересборка считает позицию на её смены, скидка брони действует", async () => {
    const id = await createDraft();
    await setLineShifts(id, storm, 2);
    await svc.rebuildBookingEstimate(id);
    const main = await estimate(id);
    const line = lineOf(main, "Aputure STORM 400x");
    expect(main.shifts).toBe(1);
    expect(line.shifts).toBe(2);
    expect(Number(line.unitPrice)).toBe(2000);
    expect(Number(line.lineSum)).toBe(4000);
    expect(lineOf(main, "Стойка C-Stand").shifts).toBe(1);
    // 4 000 + 500 + 1 500 = 6 000, скидка 50 % на прайсовые строки.
    expect(Number(main.subtotal)).toBe(6000);
    expect(Number(main.totalAfterDiscount)).toBe(3000);
  });

  it("договорная ставка умножается на свои смены позиции, без скидки", async () => {
    const id = await createDraft({ negotiated: 700 });
    await setLineShifts(id, storm, 2);
    await svc.rebuildBookingEstimate(id);
    const line = lineOf(await estimate(id), "Aputure STORM 400x");
    expect(Number(line.unitPrice)).toBe(1400);
    expect(Number(line.listUnitPrice)).toBe(2000);
  });

  it("подтверждение пишет смены строки и цену на них", async () => {
    const id = await createDraft();
    await setLineShifts(id, storm, 3);
    await svc.confirmBooking(id);
    const line = lineOf(await estimate(id), "Aputure STORM 400x");
    expect(line.shifts).toBe(3);
    expect(Number(line.unitPrice)).toBe(3000);
  });
});

describe("правка брони", () => {
  it("правка состава без смен сохраняет свои смены позиции", async () => {
    const id = await createDraft();
    await setLineShifts(id, storm, 2);
    const res = await request(app)
      .patch(`/api/bookings/${id}`)
      .set(AUTH())
      .send({ items: [{ equipmentId: storm, quantity: 3 }, { equipmentId: stand, quantity: 1 }] });
    expect(res.status).toBe(200);
    const item = await prisma.bookingItem.findFirst({ where: { bookingId: id, equipmentId: storm } });
    expect(item.shifts).toBe(2);
    const line = lineOf(await estimate(id), "Aputure STORM 400x");
    expect(line.shifts).toBe(2);
    expect(line.quantity).toBe(3);
    expect(Number(line.unitPrice)).toBe(2000);
  });

  it("превью правки без состава считает длинную позицию по её сменам", async () => {
    const id = await createDraft();
    await setLineShifts(id, storm, 2);
    const res = await request(app).patch(`/api/bookings/${id}`).set(AUTH()).send({ dryRun: true, discountPercent: 0 });
    expect(res.status).toBe(200);
    // 2 × 2 000 + 500 + 1 500 = 6 000.
    expect(res.body.booking.estimate.subtotal).toBe("6000");
  });

  it("срок брони догнал позицию — она идёт со всей бронью, своё значение не стирается", async () => {
    const id = await createDraft();
    await setLineShifts(id, storm, 2);
    const res = await request(app)
      .patch(`/api/bookings/${id}`)
      .set(AUTH())
      .send({ endDate: new Date(START.getTime() + 3 * DAY).toISOString() });
    expect(res.status).toBe(200);
    const main = await estimate(id);
    expect(main.shifts).toBe(3);
    expect(lineOf(main, "Aputure STORM 400x").shifts).toBe(3);
    expect((await prisma.bookingItem.findFirst({ where: { bookingId: id, equipmentId: storm } })).shifts).toBe(2);
  });
});

describe("добор и вливание", () => {
  async function issuedWithLongLine() {
    const id = await createDraft();
    await setLineShifts(id, storm, 2);
    await svc.confirmBooking(id);
    await prisma.booking.update({ where: { id }, data: { status: "ISSUED", issuedAt: START } });
    return id;
  }

  it("добор отдельной сметой: длинная позиция — на свои смены, обычная — на смены брони", async () => {
    const id = await issuedWithLongLine();
    await addon.addAddonItems({
      bookingId: id,
      items: [{ equipmentId: storm, quantity: 1 }, { equipmentId: stand, quantity: 1 }],
      mode: "ADDON",
      userId: saId,
      createdBy: "sa-lpr",
    });
    const add = await estimate(id, "ADDON");
    expect(lineOf(add, "Aputure STORM 400x").shifts).toBe(2);
    expect(Number(lineOf(add, "Aputure STORM 400x").unitPrice)).toBe(2000);
    expect(lineOf(add, "Стойка C-Stand").shifts).toBe(1);
  });

  it("вливание добора в основную смету переносит смены строки", async () => {
    const id = await issuedWithLongLine();
    // В основной смете стойки нет — её строка придёт из добора.
    await prisma.bookingItem.delete({ where: { bookingId_equipmentId: { bookingId: id, equipmentId: stand } } });
    await svc.rebuildBookingEstimate(id);
    await prisma.bookingItem.create({ data: { bookingId: id, equipmentId: stand, quantity: 1, shifts: 2 } });
    await (await import("../services/addonEstimate")).recomputeAddonEstimate(id);
    expect(lineOf(await estimate(id, "ADDON"), "Стойка C-Stand").shifts).toBe(2);
    await addon.mergeAddonIntoMain({ bookingId: id, userId: saId });
    const line = lineOf(await estimate(id), "Стойка C-Stand");
    expect(line.shifts).toBe(2);
    expect(Number(line.unitPrice)).toBe(1000);
  });
});

describe("добор в основную смету", () => {
  it("новая строка в основной смете — на смены позиции", async () => {
    const id = await createDraft();
    await svc.confirmBooking(id);
    await prisma.booking.update({ where: { id }, data: { status: "ISSUED", issuedAt: START } });
    // Стойка целиком в доборе (в основной смете её строки нет), позиция — на 2 смены.
    await prisma.bookingItem.delete({ where: { bookingId_equipmentId: { bookingId: id, equipmentId: stand } } });
    await svc.rebuildBookingEstimate(id);
    await prisma.bookingItem.create({ data: { bookingId: id, equipmentId: stand, quantity: 1, shifts: 2 } });
    await addon.addAddonItems({
      bookingId: id,
      items: [{ equipmentId: stand, quantity: 1 }],
      mode: "MERGE",
      userId: saId,
      createdBy: "sa-lpr",
    });
    const line = lineOf(await estimate(id), "Стойка C-Stand");
    expect(line.shifts).toBe(2);
    expect(Number(line.unitPrice)).toBe(1000);
  });

  it("строка основной сметы на другое число смен — в одну строку не сливается", async () => {
    const id = await createDraft();
    await svc.confirmBooking(id);
    await prisma.booking.update({ where: { id }, data: { status: "ISSUED", issuedAt: START } });
    // Свои смены поменяли без пересборки основной сметы: в ней STORM на 1 смену.
    await setLineShifts(id, storm, 2);
    await expect(
      addon.addAddonItems({
        bookingId: id,
        items: [{ equipmentId: storm, quantity: 1 }],
        mode: "MERGE",
        userId: saId,
        createdBy: "sa-lpr",
      }),
    ).rejects.toMatchObject({ status: 409, code: "ADDON_MERGE_SHIFTS_MISMATCH" });
    expect(lineOf(await estimate(id), "Aputure STORM 400x").quantity).toBe(2);
  });
});

describe("тело запроса своих смен пока не принимает", () => {
  it("черновик и правка игнорируют shifts в позициях — смены по позиции включатся с формой", async () => {
    const res = await request(app)
      .post("/api/bookings/draft")
      .set(AUTH())
      .send({
        client: { name: "Продакшн «Сфера»" },
        projectName: "Проверка тела",
        startDate: START.toISOString(),
        endDate: END.toISOString(),
        items: [{ equipmentId: storm, quantity: 1, shifts: 5 }],
      });
    expect(res.status).toBe(200);
    const id = (res.body.booking?.id ?? res.body.id) as string;
    expect((await prisma.bookingItem.findFirst({ where: { bookingId: id } })).shifts).toBeNull();
    expect(lineOf(await estimate(id), "Aputure STORM 400x").shifts).toBe(1);
    const patched = await request(app)
      .patch(`/api/bookings/${id}`)
      .set(AUTH())
      .send({ items: [{ equipmentId: storm, quantity: 2, shifts: 5 }] });
    expect(patched.status).toBe(200);
    expect((await prisma.bookingItem.findFirst({ where: { bookingId: id } })).shifts).toBeNull();
  });
});

describe("перенос своих смен при правке", () => {
  const existing = [{ equipmentId: "a", negotiatedRatePerShift: null, shifts: 2 }];
  it("не передано — как было, null — сброс, число — записать, у своей позиции — пусто", () => {
    expect(carryItemOverrides([{ equipmentId: "a" }], existing)[0].shifts).toBe(2);
    expect(carryItemOverrides([{ equipmentId: "a", shifts: null }], existing)[0].shifts).toBeNull();
    expect(carryItemOverrides([{ equipmentId: "a", shifts: 4 }], existing)[0].shifts).toBe(4);
    expect(carryItemOverrides([{ shifts: 4 } as { equipmentId?: string; shifts?: number }], existing)[0].shifts).toBeNull();
  });
});
