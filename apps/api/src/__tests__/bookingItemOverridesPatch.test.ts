/**
 * PATCH /api/bookings/:id с items пересоздаёт позиции целиком. Настройка
 * позиции, которую клиент не прислал, не должна пропадать.
 *
 * До фикса ретро-правка (useRetroEdit шлёт только количество) сбрасывала
 * договорную цену на прайс, а превью и пересчёт брони на согласовании без
 * items считали сумму по прайсу. Ретро-правка брони с произвольной позицией
 * падала с 400: форма слала equipmentId: null, а схема ждала строку.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-item-overrides-patch.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-iop";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-iop";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-iop";
process.env.JWT_SECRET = "test-jwt-secret-item-overrides16";

let app: Express;
let prisma: any;
let saToken: string;
let carryItemOverrides: typeof import("../services/bookingItemOverrides").carryItemOverrides;

const RATE = 10000;
const NEGOTIATED = 7000;
const DAY = 86_400_000;
// Две смены по 24 ч, от «через неделю» — без зашитых календарных дат.
const START = new Date(Math.ceil((Date.now() + 7 * DAY) / 3_600_000) * 3_600_000);
const END = new Date(START.getTime() + 2 * DAY);
const SHIFTS = 2;

let skyId: string;
let apuId: string;
let clientId: string;

const AUTH = () => ({ "X-API-Key": "test-key-iop", Authorization: `Bearer ${saToken}` });

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, DATABASE_URL: `file:${TEST_DB_PATH}`, PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes" },
    stdio: "pipe",
  });
  app = (await import("../app")).app;
  prisma = (await import("../prisma")).prisma;
  carryItemOverrides = (await import("../services/bookingItemOverrides")).carryItemOverrides;
  const { signSession } = await import("../services/auth");
  const sa = await prisma.adminUser.create({ data: { username: "sa-iop", passwordHash: "x", role: "SUPER_ADMIN" } });
  saToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });
  const mk = (key: string, name: string, rate: number) =>
    prisma.equipment.create({
      data: { importKey: key, name, category: "Свет", totalQuantity: 20, rentalRatePerShift: rate, stockTrackingMode: "COUNT" },
    });
  skyId = (await mk("iop-sky", "ARRI SkyPanel S60-C", RATE)).id;
  apuId = (await mk("iop-apu", "Aputure LS 600d Pro", 5000)).id;
  clientId = (await prisma.client.create({ data: { name: "Гаффер Петя" } })).id;
});

afterAll(async () => {
  await prisma?.$disconnect();
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    const f = `${TEST_DB_PATH}${suffix}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

/** Черновик: SkyPanel по договорной цене, Aputure по прайсу, без скидки. */
async function createDraft(extraItems: unknown[] = []) {
  const res = await request(app)
    .post("/api/bookings/draft")
    .set(AUTH())
    .send({
      client: { name: "Гаффер Петя" },
      projectName: "Смена с уступкой",
      startDate: START.toISOString(),
      endDate: END.toISOString(),
      discountPercent: 0,
      items: [
        { equipmentId: skyId, quantity: 2, negotiatedRatePerShift: NEGOTIATED },
        { equipmentId: apuId, quantity: 1 },
        ...extraItems,
      ],
    });
  expect(res.status).toBe(200);
  return res.body.booking?.id ?? res.body.id;
}

const skyRate = async (bookingId: string) =>
  (await prisma.bookingItem.findFirst({ where: { bookingId, equipmentId: skyId } }))?.negotiatedRatePerShift?.toString() ?? null;

const mainLine = async (bookingId: string, equipmentId: string) => {
  const main = await prisma.estimate.findFirst({ where: { bookingId, kind: "MAIN" }, include: { lines: true } });
  return main?.lines.find((l: any) => l.equipmentId === equipmentId);
};

describe("carryItemOverrides — правило трёх состояний", () => {
  const existing = [{ equipmentId: "sky", negotiatedRatePerShift: "7000" }];
  it("не передано — как было; null — сброс; число — новое значение", () => {
    const out = carryItemOverrides(
      [
        { equipmentId: "sky", quantity: 3 },
        { equipmentId: "sky", quantity: 3, negotiatedRatePerShift: null },
        { equipmentId: "sky", quantity: 3, negotiatedRatePerShift: 6500 },
        { equipmentId: "new", quantity: 1 },
      ],
      existing,
    );
    expect(out.map((i) => i.negotiatedRatePerShift)).toEqual([7000, null, 6500, null]);
  });
  it("у произвольной позиции договорной цены нет", () => {
    const [out] = carryItemOverrides([{ quantity: 1 } as { equipmentId?: string; quantity: number }], existing);
    expect(out.negotiatedRatePerShift).toBeNull();
  });
});

describe("PATCH /api/bookings/:id — договорная цена переживает правку состава", () => {
  it("items без поля: договорная цена остаётся, смета считается по ней", async () => {
    const id = await createDraft();
    const res = await request(app)
      .patch(`/api/bookings/${id}`)
      .set(AUTH())
      .send({ items: [{ equipmentId: skyId, quantity: 3 }, { equipmentId: apuId, quantity: 1 }] });
    expect(res.status).toBe(200);
    expect(Number(await skyRate(id))).toBe(NEGOTIATED);
    const line = await mainLine(id, skyId);
    expect(line.quantity).toBe(3);
    expect(Number(line.unitPrice)).toBe(NEGOTIATED * SHIFTS);
  });

  it("явный null возвращает позицию к прайсу", async () => {
    const id = await createDraft();
    const res = await request(app)
      .patch(`/api/bookings/${id}`)
      .set(AUTH())
      .send({ items: [{ equipmentId: skyId, quantity: 2, negotiatedRatePerShift: null }, { equipmentId: apuId, quantity: 1 }] });
    expect(res.status).toBe(200);
    expect(await skyRate(id)).toBeNull();
    expect(Number((await mainLine(id, skyId)).unitPrice)).toBe(RATE * SHIFTS);
  });

  it("новое число заменяет прежнюю договорную цену", async () => {
    const id = await createDraft();
    const res = await request(app)
      .patch(`/api/bookings/${id}`)
      .set(AUTH())
      .send({ items: [{ equipmentId: skyId, quantity: 2, negotiatedRatePerShift: 6500 }, { equipmentId: apuId, quantity: 1 }] });
    expect(res.status).toBe(200);
    expect(Number(await skyRate(id))).toBe(6500);
  });

  it("dryRun без items показывает сумму с договорной ценой", async () => {
    const id = await createDraft();
    const res = await request(app)
      .patch(`/api/bookings/${id}`)
      .set(AUTH())
      .send({ dryRun: true, discountPercent: 0 });
    expect(res.status).toBe(200);
    const line = res.body.booking.estimate.lines.find((l: any) => l.equipmentId === skyId);
    expect(Number(line.unitPrice)).toBe(NEGOTIATED * SHIFTS);
  });

  it("dryRun с items без поля считает по прежней договорной цене", async () => {
    const id = await createDraft();
    const res = await request(app)
      .patch(`/api/bookings/${id}`)
      .set(AUTH())
      .send({ dryRun: true, items: [{ equipmentId: skyId, quantity: 4 }, { equipmentId: apuId, quantity: 1 }] });
    expect(res.status).toBe(200);
    const line = res.body.booking.estimate.lines.find((l: any) => l.equipmentId === skyId);
    expect(Number(line.unitPrice)).toBe(NEGOTIATED * SHIFTS);
  });

  it("бронь на согласовании: пересчёт после смены скидки не теряет договорную цену", async () => {
    const id = await createDraft();
    await prisma.booking.update({ where: { id }, data: { status: "PENDING_APPROVAL" } });
    const res = await request(app).patch(`/api/bookings/${id}`).set(AUTH()).send({ discountPercent: 10 });
    expect(res.status).toBe(200);
    // Договорная строка без процента: 7 000 × 2 × 2 = 28 000; прайсовая 5 000 × 2 − 10 % = 9 000.
    const booking = await prisma.booking.findUnique({ where: { id } });
    expect(Number(booking.finalAmount)).toBe(37000);
  });
  it("бронь на согласовании: правка состава без поля считает по договорной цене", async () => {
    const id = await createDraft();
    await prisma.booking.update({ where: { id }, data: { status: "PENDING_APPROVAL" } });
    const res = await request(app)
      .patch(`/api/bookings/${id}`)
      .set(AUTH())
      .send({ items: [{ equipmentId: skyId, quantity: 3 }, { equipmentId: apuId, quantity: 1 }] });
    expect(res.status).toBe(200);
    // 7 000 × 3 × 2 = 42 000 договорных + 5 000 × 2 = 10 000 прайсовых, скидки нет.
    const booking = await prisma.booking.findUnique({ where: { id } });
    expect(Number(booking.finalAmount)).toBe(52000);
  });

  it("договорная цена у произвольной позиции по-прежнему отклоняется", async () => {
    const id = await createDraft();
    const res = await request(app)
      .patch(`/api/bookings/${id}`)
      .set(AUTH())
      .send({ items: [{ equipmentId: null, customName: "Расходники", customUnitPrice: 1500, quantity: 1, negotiatedRatePerShift: 900 }] });
    expect(res.status).toBe(400);
  });
});

describe("ретро-правка возвращённой брони", () => {
  async function returnedBooking(extraItems: unknown[] = []) {
    const id = await createDraft(extraItems);
    await prisma.booking.update({ where: { id }, data: { status: "RETURNED", confirmedAt: new Date(), issuedAt: START } });
    return id;
  }

  it("изменение количества не сбрасывает договорную цену", async () => {
    const id = await returnedBooking();
    const res = await request(app)
      .patch(`/api/bookings/${id}`)
      .set(AUTH())
      .send({ retroactive: true, items: [{ equipmentId: skyId, quantity: 1 }, { equipmentId: apuId, quantity: 1 }] });
    expect(res.status).toBe(200);
    expect(Number(await skyRate(id))).toBe(NEGOTIATED);
    expect(Number((await mainLine(id, skyId)).unitPrice)).toBe(NEGOTIATED * SHIFTS);
  });

  it("бронь с произвольной позицией: equipmentId: null принимается как «нет позиции каталога»", async () => {
    const id = await returnedBooking([{ customName: "Расходники", customUnitPrice: 1500, quantity: 1 }]);
    const res = await request(app)
      .patch(`/api/bookings/${id}`)
      .set(AUTH())
      .send({
        retroactive: true,
        items: [
          { equipmentId: skyId, quantity: 2 },
          { equipmentId: apuId, quantity: 2 },
          { equipmentId: null, customName: "Расходники", customUnitPrice: 1500, quantity: 2 },
        ],
      });
    expect(res.status).toBe(200);
    const custom = await prisma.bookingItem.findFirst({ where: { bookingId: id, equipmentId: null } });
    expect(custom.quantity).toBe(2);
    expect(Number(await skyRate(id))).toBe(NEGOTIATED);
  });
});

// clientId держим живым: черновики создаются по имени клиента.
it("клиент существует", () => expect(clientId).toBeTruthy());
