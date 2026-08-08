/**
 * Договорная цена через HTTP — слой, которого не хватало.
 *
 * Сервисные тесты (`negotiatedPrice.test.ts`) звали quoteEstimate и
 * createBookingDraft напрямую и были зелёными, пока маршруты выбрасывали
 * negotiatedRatePerShift из items whitelist-мэппингом: фича не работала
 * end-to-end, и ни один из 1411 тестов этого не видел. Здесь всё идёт
 * через request(app), как из браузера.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-negotiated-routes.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-npr";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-npr";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-npr";
process.env.JWT_SECRET = "test-jwt-secret-negotiated-routes16";

let app: Express;
let prisma: any;
let saToken: string;
let whToken: string;

const RATE = 25000;
const SHIFTS = 3;
const START = "2026-09-10T09:00:00.000Z";
const END = "2026-09-12T21:00:00.000Z";

let skyId: string;
let apuId: string;
let vehicleId: string;

const AUTH_SA = () => ({ "X-API-Key": "test-key-npr", Authorization: `Bearer ${saToken}` });
const AUTH_WH = () => ({ "X-API-Key": "test-key-npr", Authorization: `Bearer ${whToken}` });

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

  app = (await import("../app")).app;
  prisma = (await import("../prisma")).prisma;
  const { signSession } = await import("../services/auth");

  const sa = await prisma.adminUser.create({
    data: { username: "sa-npr", passwordHash: "x", role: "SUPER_ADMIN" },
  });
  const wh = await prisma.adminUser.create({
    data: { username: "wh-npr", passwordHash: "x", role: "WAREHOUSE" },
  });
  saToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });
  whToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });

  skyId = (
    await prisma.equipment.create({
      data: {
        importKey: "npr-sky", name: "ARRI SkyPanel S60-C", category: "Свет",
        totalQuantity: 10, rentalRatePerShift: RATE, stockTrackingMode: "COUNT",
      },
    })
  ).id;
  apuId = (
    await prisma.equipment.create({
      data: {
        importKey: "npr-apu", name: "Aputure LS 600d Pro", category: "Свет",
        totalQuantity: 10, rentalRatePerShift: 12000, stockTrackingMode: "COUNT",
      },
    })
  ).id;
  vehicleId = (
    await prisma.vehicle.create({
      data: { slug: "npr-gazelle", name: "Газель", shiftPriceRub: 18000, shiftHours: 12, overtimePercent: 0 },
    })
  ).id;
});

afterAll(async () => {
  await prisma?.$disconnect();
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    const f = `${TEST_DB_PATH}${suffix}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

/** Тело брони с договорной ценой по SkyPanel и прайсовым Aputure. */
function bodyWithNegotiated(extra: Record<string, unknown> = {}) {
  return {
    client: { name: "Гаффер Петя" },
    projectName: "Смена с уступкой",
    startDate: START,
    endDate: END,
    discountPercent: 50,
    items: [
      { equipmentId: skyId, quantity: 2, negotiatedRatePerShift: 18000 },
      { equipmentId: apuId, quantity: 3 },
    ],
    ...extra,
  };
}

describe("POST /api/bookings/quote", () => {
  it("считает договорную цену и отдаёт раскладку на прайсовую и договорную части", async () => {
    const res = await request(app).post("/api/bookings/quote").set(AUTH_SA()).send(bodyWithNegotiated());
    expect(res.status).toBe(200);
    // 18 000 × 2 × 3 = 108 000 договорных (без процента)
    expect(Number(res.body.negotiatedSubtotal)).toBe(108000);
    // 12 000 × 3 × 3 = 108 000 прайсовых, минус 50%
    expect(Number(res.body.listedSubtotal)).toBe(108000);
    expect(Number(res.body.discountAmount)).toBe(54000);
    expect(Number(res.body.totalAfterDiscount)).toBe(162000);

    const line = res.body.lines.find((l: any) => l.equipmentId === skyId);
    expect(line.isNegotiated).toBe(true);
    expect(Number(line.listUnitPrice)).toBe(RATE * SHIFTS);
  });

  it("транспорт: договорная сумма машины заменяет расчёт по прайсу", async () => {
    const res = await request(app)
      .post("/api/bookings/quote")
      .set(AUTH_SA())
      .send(
        bodyWithNegotiated({
          transport: [
            {
              vehicleId, withGenerator: false, shiftHours: 12,
              skipOvertime: false, kmOutsideMkad: 0, ttkEntry: false,
              negotiatedTotalRub: 12000,
            },
          ],
        }),
      );
    expect(res.status).toBe(200);
    expect(Number(res.body.transportSubtotal)).toBe(12000);
    expect(Number(res.body.transport[0].listTotal)).toBe(18000);
  });
});

describe("POST /api/bookings/draft", () => {
  it("сохраняет договорную цену позиции и считает по ней деньги брони", async () => {
    const res = await request(app).post("/api/bookings/draft").set(AUTH_SA()).send(bodyWithNegotiated());
    expect(res.status).toBe(200);
    const bookingId = res.body.booking.id;

    const item = await prisma.bookingItem.findFirst({ where: { bookingId, equipmentId: skyId } });
    expect(Number(item.negotiatedRatePerShift)).toBe(18000);

    const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
    expect(Number(booking.finalAmount)).toBe(162000);
  });

  it("сохраняет договорную сумму машины и не откатывает её к прайсу", async () => {
    const res = await request(app)
      .post("/api/bookings/draft")
      .set(AUTH_SA())
      .send(
        bodyWithNegotiated({
          projectName: "С машиной",
          transport: [
            {
              vehicleId, withGenerator: false, shiftHours: 12,
              skipOvertime: false, kmOutsideMkad: 0, ttkEntry: false,
              negotiatedTotalRub: 12000,
            },
          ],
        }),
      );
    expect(res.status).toBe(200);
    const bookingId = res.body.booking.id;

    const bv = await prisma.bookingVehicle.findFirst({ where: { bookingId } });
    expect(Number(bv.negotiatedTotalRub)).toBe(12000);
    expect(Number(bv.subtotalRub)).toBe(12000);

    const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
    // 162 000 оборудование + 12 000 транспорт
    expect(Number(booking.finalAmount)).toBe(174000);
  });

  it("SUPER_ADMIN фиксирует договорной итог при создании", async () => {
    const res = await request(app)
      .post("/api/bookings/draft")
      .set(AUTH_SA())
      .send(bodyWithNegotiated({ projectName: "С итогом", manualFinalAmount: 150000 }));
    expect(res.status).toBe(200);

    const booking = await prisma.booking.findUnique({ where: { id: res.body.booking.id } });
    expect(Number(booking.manualFinalAmount)).toBe(150000);
    expect(Number(booking.finalAmount)).toBe(150000);
    expect(Number(booking.amountOutstanding)).toBe(150000);
  });

  it("WAREHOUSE итог не фиксирует — поле игнорируется, бронь считается по смете", async () => {
    const res = await request(app)
      .post("/api/bookings/draft")
      .set(AUTH_WH())
      .send(bodyWithNegotiated({ projectName: "WH итог", manualFinalAmount: 1 }));
    expect(res.status).toBe(200);

    const booking = await prisma.booking.findUnique({ where: { id: res.body.booking.id } });
    expect(booking.manualFinalAmount).toBeNull();
    expect(Number(booking.finalAmount)).toBe(162000);
  });
});

describe("PATCH /api/bookings/:id", () => {
  it("правка брони не стирает договорные цены позиции и машины", async () => {
    const created = await request(app)
      .post("/api/bookings/draft")
      .set(AUTH_SA())
      .send(
        bodyWithNegotiated({
          projectName: "Правка",
          transport: [
            {
              vehicleId, withGenerator: false, shiftHours: 12,
              skipOvertime: false, kmOutsideMkad: 0, ttkEntry: false,
              negotiatedTotalRub: 12000,
            },
          ],
        }),
      );
    const bookingId = created.body.booking.id;

    // Форма присылает состав целиком — вместе с договорными ценами.
    const res = await request(app)
      .patch(`/api/bookings/${bookingId}`)
      .set(AUTH_SA())
      .send({
        projectName: "Правка (изменено)",
        startDate: START,
        endDate: END,
        discountPercent: 50,
        items: [
          { equipmentId: skyId, quantity: 2, negotiatedRatePerShift: 18000 },
          { equipmentId: apuId, quantity: 3 },
        ],
        transport: [
          {
            vehicleId, withGenerator: false, shiftHours: 12,
            skipOvertime: false, kmOutsideMkad: 0, ttkEntry: false,
            negotiatedTotalRub: 12000,
          },
        ],
      });
    expect(res.status).toBe(200);

    const item = await prisma.bookingItem.findFirst({ where: { bookingId, equipmentId: skyId } });
    expect(Number(item.negotiatedRatePerShift)).toBe(18000);
    const bv = await prisma.bookingVehicle.findFirst({ where: { bookingId } });
    expect(Number(bv.negotiatedTotalRub)).toBe(12000);

    const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
    expect(Number(booking.finalAmount)).toBe(174000);
  });
});

describe("GET /api/bookings/:id", () => {
  it("отдаёт договорные цены — форма правки должна их восстановить", async () => {
    const created = await request(app)
      .post("/api/bookings/draft")
      .set(AUTH_SA())
      .send(
        bodyWithNegotiated({
          projectName: "Отдача",
          manualFinalAmount: 150000,
          transport: [
            {
              vehicleId, withGenerator: false, shiftHours: 12,
              skipOvertime: false, kmOutsideMkad: 0, ttkEntry: false,
              negotiatedTotalRub: 12000,
            },
          ],
        }),
      );
    const res = await request(app)
      .get(`/api/bookings/${created.body.booking.id}`)
      .set(AUTH_SA());
    expect(res.status).toBe(200);

    const b = res.body.booking ?? res.body;
    expect(Number(b.manualFinalAmount)).toBe(150000);
    const item = b.items.find((i: any) => i.equipmentId === skyId);
    expect(Number(item.negotiatedRatePerShift)).toBe(18000);
    expect(Number(b.vehicles[0].negotiatedTotalRub)).toBe(12000);
  });
});
