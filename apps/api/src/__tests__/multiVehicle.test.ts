/**
 * Интеграционные тесты multi-vehicle (несколько машин на бронь):
 *  (a) quoteEstimate с 2 distinct машинами → transport[].length === 2,
 *      transportSubtotal = сумма computeTransportPrice обеих, equipment не задет.
 *  (b) POST /api/bookings/draft с 2 машинами → 2 строки BookingVehicle,
 *      Booking.transportSubtotalRub = сумма, finalAmount её включает.
 *  (c) Zod отклоняет дубликат vehicleId в transport-массиве (400).
 *  (d) Пустой / без транспорта → 0 строк BookingVehicle, subtotal 0.
 *  (e) Чтение legacy-брони (vehicleId-колонка, без BookingVehicle) —
 *      транспорт пересчитывается через fallback на confirm.
 *  (f) dryRun POST /draft и PATCH /:id с 2 машинами → превью включает
 *      transport[], transportSubtotal, grandTotal; grandTotal совпадает
 *      с finalAmount реального сохранения (никакой записи в БД).
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-multivehicle.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-multivehicle";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-multivehicle";
process.env.JWT_SECRET = "test-jwt-secret-multivehicle-min16chars";

let app: Express;
let prisma: any;
let superAdminToken: string;
let warehouseToken: string;

let fordId: string;
let fotonId: string;
let ivecoId: string;
let equipmentId: string;

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

  const sa = await prisma.adminUser.create({
    data: { username: "mv_sa", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  superAdminToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });

  const wh = await prisma.adminUser.create({
    data: { username: "mv_wh", passwordHash: hash, role: "WAREHOUSE" },
  });
  warehouseToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });

  const ford = await prisma.vehicle.create({
    data: {
      slug: "ford",
      name: "Ford",
      shiftPriceRub: "20000",
      hasGeneratorOption: false,
      displayOrder: 1,
      shiftHours: 12,
      overtimePercent: "10",
      active: true,
    },
  });
  fordId = ford.id;

  const foton = await prisma.vehicle.create({
    data: {
      slug: "foton",
      name: "Фотон",
      shiftPriceRub: "25000",
      hasGeneratorOption: false,
      displayOrder: 2,
      shiftHours: 12,
      overtimePercent: "10",
      active: true,
    },
  });
  fotonId = foton.id;

  const iveco = await prisma.vehicle.create({
    data: {
      slug: "iveco",
      name: "Ивеко",
      shiftPriceRub: "24000",
      hasGeneratorOption: true,
      generatorPriceRub: "25000",
      displayOrder: 3,
      shiftHours: 12,
      overtimePercent: "10",
      active: true,
    },
  });
  ivecoId = iveco.id;

  const eq = await prisma.equipment.create({
    data: {
      importKey: "LED||ПАНЕЛЬ MV||GENERIC||LED-MV",
      name: "Панель MV",
      category: "LED",
      totalQuantity: 5,
      rentalRatePerShift: "3500",
      stockTrackingMode: "COUNT",
    },
  });
  equipmentId = eq.id;
});

afterAll(async () => {
  await prisma.$disconnect();
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = TEST_DB_PATH + suffix;
    if (fs.existsSync(f)) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }
});

function AUTH_SA() { return { "X-API-Key": "test-key-1", Authorization: `Bearer ${superAdminToken}` }; }
function AUTH_WH() { return { "X-API-Key": "test-key-1", Authorization: `Bearer ${warehouseToken}` }; }

const QUOTE_BASE = {
  client: { name: "Тест Клиент MV" },
  projectName: "Проект MV",
  startDate: "2026-07-01T09:00:00.000Z",
  endDate: "2026-07-02T09:00:00.000Z", // 1 сутки = 1 смена
};

// ── (a) quoteEstimate с 2 distinct машинами ───────────────────────────────────

describe("(a) POST /api/bookings/quote — 2 distinct машины", () => {
  it("transport[].length === 2, transportSubtotal = сумма обоих, equipment не задет", async () => {
    const body = {
      ...QUOTE_BASE,
      items: [{ equipmentId, quantity: 2 }],
      transport: [
        { vehicleId: fordId, withGenerator: false, shiftHours: 12, skipOvertime: false, kmOutsideMkad: 0, ttkEntry: false },
        { vehicleId: fotonId, withGenerator: false, shiftHours: 12, skipOvertime: false, kmOutsideMkad: 0, ttkEntry: false },
      ],
    };
    const res = await request(app).post("/api/bookings/quote").set(AUTH_WH()).send(body);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.transport)).toBe(true);
    expect(res.body.transport).toHaveLength(2);

    const names = res.body.transport.map((t: any) => t.vehicleName).sort();
    expect(names).toEqual(["Ford", "Фотон"]);

    const t0 = Number(res.body.transport[0].total);
    const t1 = Number(res.body.transport[1].total);
    // Ford 20000 + Фотон 25000 = 45000
    expect(t0 + t1).toBeCloseTo(45000, 2);
    expect(Number(res.body.transportSubtotal)).toBeCloseTo(t0 + t1, 2);

    // Equipment lines не задеты: 2 × 3500 = 7000
    expect(Number(res.body.equipmentSubtotal)).toBeCloseTo(7000, 2);
    expect(res.body.lines).toHaveLength(1);
    expect(res.body.lines[0].quantity).toBe(2);

    // grandTotal = equipmentTotal + transportSubtotal
    expect(Number(res.body.grandTotal)).toBeCloseTo(
      Number(res.body.equipmentTotal) + (t0 + t1),
      2,
    );
  });
});

// ── (b) POST /api/bookings/draft с 2 машинами ─────────────────────────────────

describe("(b) POST /api/bookings/draft — 2 машины персистятся", () => {
  it("создаёт 2 BookingVehicle, transportSubtotalRub = сумма, finalAmount её включает", async () => {
    const body = {
      client: { name: "Клиент Draft MV" },
      projectName: "Draft MV",
      startDate: "2026-07-10T09:00:00.000Z",
      endDate: "2026-07-11T09:00:00.000Z",
      items: [{ equipmentId, quantity: 2 }],
      transport: [
        { vehicleId: fordId, withGenerator: false, shiftHours: 12, skipOvertime: false, kmOutsideMkad: 0, ttkEntry: false },
        { vehicleId: ivecoId, withGenerator: true, shiftHours: 12, skipOvertime: false, kmOutsideMkad: 0, ttkEntry: true },
      ],
    };
    const res = await request(app).post("/api/bookings/draft").set(AUTH_WH()).send(body);

    expect(res.status).toBe(200);
    const bookingId = res.body.booking.id;

    const saved = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { vehicles: { include: { vehicle: true } } },
    });
    expect(saved.vehicles).toHaveLength(2);
    expect(saved.vehicleId).toBeNull(); // legacy column untouched for new bookings

    // Ford = 20000; Ивеко = 24000 + 25000 (gen) + 500 (ttk) = 49500 → 69500
    const expectedTransport = 20000 + 49500;
    expect(Number(saved.transportSubtotalRub)).toBeCloseTo(expectedTransport, 2);

    const fordRow = saved.vehicles.find((v: any) => v.vehicleId === fordId);
    const ivecoRow = saved.vehicles.find((v: any) => v.vehicleId === ivecoId);
    expect(Number(fordRow.subtotalRub)).toBeCloseTo(20000, 2);
    expect(Number(ivecoRow.subtotalRub)).toBeCloseTo(49500, 2);
    expect(ivecoRow.withGenerator).toBe(true);
    expect(ivecoRow.ttkEntry).toBe(true);

    // finalAmount = equipment-after-discount (2 × 3500 = 7000) + transport
    expect(Number(saved.finalAmount)).toBeCloseTo(7000 + expectedTransport, 2);

    // Serializer exposes vehicles[] with nested vehicle + string decimals
    expect(Array.isArray(res.body.booking.vehicles)).toBe(true);
    expect(res.body.booking.vehicles).toHaveLength(2);
    const serFord = res.body.booking.vehicles.find((v: any) => v.vehicleId === fordId);
    expect(typeof serFord.subtotalRub).toBe("string");
    expect(serFord.vehicle.name).toBe("Ford");
  });
});

// ── (c) Zod отклоняет дубликат vehicleId ──────────────────────────────────────

describe("(c) дубликат vehicleId в transport → 400", () => {
  it("две одинаковые машины отклоняются Zod-валидацией", async () => {
    const body = {
      ...QUOTE_BASE,
      items: [{ equipmentId, quantity: 1 }],
      transport: [
        { vehicleId: fordId, withGenerator: false, shiftHours: 12, skipOvertime: false, kmOutsideMkad: 0, ttkEntry: false },
        { vehicleId: fordId, withGenerator: true, shiftHours: 12, skipOvertime: false, kmOutsideMkad: 0, ttkEntry: false },
      ],
    };
    const res = await request(app).post("/api/bookings/quote").set(AUTH_WH()).send(body);
    expect(res.status).toBe(400);
  });
});

// ── (d) Пустой / без транспорта ───────────────────────────────────────────────

describe("(d) без транспорта → 0 BookingVehicle, subtotal 0", () => {
  it("пустой массив transport — нет строк, transportSubtotal 0", async () => {
    const res = await request(app)
      .post("/api/bookings/draft")
      .set(AUTH_WH())
      .send({
        client: { name: "Клиент Без транспорта MV" },
        projectName: "No transport MV",
        startDate: "2026-07-20T09:00:00.000Z",
        endDate: "2026-07-21T09:00:00.000Z",
        items: [{ equipmentId, quantity: 1 }],
        transport: [],
      });

    expect(res.status).toBe(200);
    const saved = await prisma.booking.findUnique({
      where: { id: res.body.booking.id },
      include: { vehicles: true },
    });
    expect(saved.vehicles).toHaveLength(0);
    expect(saved.transportSubtotalRub).toBeNull();
    // finalAmount == equipment only (3500)
    expect(Number(saved.finalAmount)).toBeCloseTo(3500, 2);
  });

  it("отсутствующий transport (undefined) — quote отдаёт пустой массив", async () => {
    const res = await request(app)
      .post("/api/bookings/quote")
      .set(AUTH_WH())
      .send({ ...QUOTE_BASE, items: [{ equipmentId, quantity: 1 }] });

    expect(res.status).toBe(200);
    expect(res.body.transport).toEqual([]);
    expect(res.body.transportSubtotal).toBe("0.00");
  });
});

// ── (e) legacy-бронь (vehicleId-колонка, без BookingVehicle) ──────────────────

describe("(e) legacy booking fallback на confirm", () => {
  it("старая бронь с одиночным vehicleId пересчитывает транспорт через fallback", async () => {
    const client = await prisma.client.create({ data: { name: "Клиент Legacy MV" } });
    // Бронь, имитирующая до-multi-vehicle состояние: заполнены legacy-колонки,
    // НЕТ строк BookingVehicle. transportSubtotalRub намеренно занижен —
    // confirm должен пересчитать его через fallback.
    const legacy = await prisma.booking.create({
      data: {
        clientId: client.id,
        projectName: "Legacy MV",
        startDate: new Date("2026-08-01T09:00:00.000Z"),
        endDate: new Date("2026-08-02T09:00:00.000Z"),
        status: "DRAFT",
        vehicleId: fordId,
        vehicleWithGenerator: false,
        vehicleShiftHours: "12",
        vehicleSkipOvertime: false,
        vehicleKmOutsideMkad: 0,
        vehicleTtkEntry: false,
        transportSubtotalRub: "1", // stale
        items: { create: [{ equipmentId, quantity: 1 }] },
      },
    });

    // Через штатный approval-флоу: submit (WH) → approve (SA) → confirmBooking
    const submitRes = await request(app)
      .post(`/api/bookings/${legacy.id}/submit-for-approval`)
      .set(AUTH_WH())
      .send({});
    expect(submitRes.status).toBe(200);

    const approveRes = await request(app)
      .post(`/api/bookings/${legacy.id}/approve`)
      .set(AUTH_SA())
      .send({});
    expect(approveRes.status).toBe(200);

    const after = await prisma.booking.findUnique({
      where: { id: legacy.id },
      include: { vehicles: true },
    });
    expect(after.status).toBe("CONFIRMED");
    // Никаких BookingVehicle (legacy путь) — но transport пересчитан из
    // одиночных колонок: Ford 20000.
    expect(after.vehicles).toHaveLength(0);
    expect(Number(after.transportSubtotalRub)).toBeCloseTo(20000, 2);
  });
});

// ── (f) dryRun превью включает транспорт + корректный grandTotal ──────────────

describe("(f) dryRun POST/PATCH — превью включает transport + grandTotal", () => {
  const TWO_VEHICLES = () => [
    { vehicleId: fordId, withGenerator: false, shiftHours: 12, skipOvertime: false, kmOutsideMkad: 0, ttkEntry: false },
    { vehicleId: ivecoId, withGenerator: true, shiftHours: 12, skipOvertime: false, kmOutsideMkad: 0, ttkEntry: true },
  ];
  // Ford 20000 + Ивеко (24000 + 25000 gen + 500 ttk = 49500) = 69500
  const EXPECTED_TRANSPORT = 69500;
  // equipment 2 × 3500 = 7000; grandTotal = 7000 + 69500 = 76500
  const EXPECTED_EQUIPMENT = 7000;
  const EXPECTED_GRAND = EXPECTED_EQUIPMENT + EXPECTED_TRANSPORT;

  it("POST /draft dryRun: transport[] + transportSubtotal + grandTotal, без записи в БД", async () => {
    const before = await prisma.booking.count();
    const res = await request(app)
      .post("/api/bookings/draft")
      .set(AUTH_WH())
      .send({
        client: { name: "Клиент DryRun MV" },
        projectName: "DryRun MV",
        startDate: "2026-09-01T09:00:00.000Z",
        endDate: "2026-09-02T09:00:00.000Z",
        items: [{ equipmentId, quantity: 2 }],
        transport: TWO_VEHICLES(),
        dryRun: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.booking.id).toBeNull();

    const est = res.body.booking.estimate;
    expect(Array.isArray(est.transport)).toBe(true);
    expect(est.transport).toHaveLength(2);
    expect(Number(est.transportSubtotal)).toBeCloseTo(EXPECTED_TRANSPORT, 2);
    expect(Number(est.totalAfterDiscount)).toBeCloseTo(EXPECTED_EQUIPMENT, 2);
    expect(Number(est.grandTotal)).toBeCloseTo(EXPECTED_GRAND, 2);

    // Никакой записи в БД
    expect(await prisma.booking.count()).toBe(before);

    // grandTotal превью == finalAmount реального сохранения тех же входных
    const realRes = await request(app)
      .post("/api/bookings/draft")
      .set(AUTH_WH())
      .send({
        client: { name: "Клиент DryRun MV Real" },
        projectName: "DryRun MV Real",
        startDate: "2026-09-01T09:00:00.000Z",
        endDate: "2026-09-02T09:00:00.000Z",
        items: [{ equipmentId, quantity: 2 }],
        transport: TWO_VEHICLES(),
      });
    expect(realRes.status).toBe(200);
    const saved = await prisma.booking.findUnique({ where: { id: realRes.body.booking.id } });
    expect(Number(saved.finalAmount)).toBeCloseTo(Number(est.grandTotal), 2);
  });

  it("PATCH /:id dryRun: transport[] + transportSubtotal + grandTotal, бронь не мутирована", async () => {
    // Реальная бронь без транспорта (equipment 7000)
    const created = await request(app)
      .post("/api/bookings/draft")
      .set(AUTH_WH())
      .send({
        client: { name: "Клиент PatchDry MV" },
        projectName: "PatchDry MV",
        startDate: "2026-09-10T09:00:00.000Z",
        endDate: "2026-09-11T09:00:00.000Z",
        items: [{ equipmentId, quantity: 2 }],
      });
    expect(created.status).toBe(200);
    const bookingId = created.body.booking.id;
    const beforeRow = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { vehicles: true },
    });

    const res = await request(app)
      .patch(`/api/bookings/${bookingId}`)
      .set(AUTH_WH())
      .send({
        items: [{ equipmentId, quantity: 2 }],
        transport: TWO_VEHICLES(),
        dryRun: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);

    const est = res.body.booking.estimate;
    expect(est.transport).toHaveLength(2);
    expect(Number(est.transportSubtotal)).toBeCloseTo(EXPECTED_TRANSPORT, 2);
    expect(Number(est.totalAfterDiscount)).toBeCloseTo(EXPECTED_EQUIPMENT, 2);
    expect(Number(est.grandTotal)).toBeCloseTo(EXPECTED_GRAND, 2);

    // Бронь НЕ мутирована dryRun-ом
    const afterRow = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { vehicles: true },
    });
    expect(afterRow.vehicles).toHaveLength(0);
    expect(afterRow.transportSubtotalRub).toEqual(beforeRow.transportSubtotalRub);
    expect(String(afterRow.finalAmount)).toEqual(String(beforeRow.finalAmount));
  });
});
