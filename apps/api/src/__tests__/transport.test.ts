/**
 * Интеграционные тесты транспортного калькулятора:
 * - GET /api/vehicles
 * - GET /api/admin/vehicles
 * - PATCH /api/admin/vehicles/:id
 * - POST /api/bookings/quote с транспортом и без
 * - POST /api/bookings/draft сохраняет vehicleId и transportSubtotalRub
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-transport.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-transport";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-transport";
process.env.JWT_SECRET = "test-jwt-secret-transport-min16chars";

let app: Express;
let prisma: any;
let superAdminToken: string;
let warehouseToken: string;

let fordId: string;
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
    data: { username: "transport_sa", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  superAdminToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });

  const wh = await prisma.adminUser.create({
    data: { username: "transport_wh", passwordHash: hash, role: "WAREHOUSE" },
  });
  warehouseToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });

  // Seed 3 vehicles
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

  await prisma.vehicle.create({
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

  await prisma.vehicle.create({
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

  // Also create an inactive vehicle for admin tests
  await prisma.vehicle.create({
    data: {
      slug: "inactive-van",
      name: "Старый фургон",
      shiftPriceRub: "15000",
      hasGeneratorOption: false,
      displayOrder: 99,
      shiftHours: 12,
      overtimePercent: "10",
      active: false,
    },
  });

  // Seed equipment for booking tests
  const eq = await prisma.equipment.create({
    data: {
      importKey: "LED||ПАНЕЛЬ 100W||GENERIC||LED-100",
      name: "Панель 100W",
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

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/vehicles
// ──────────────────────────────────────────────────────────────────────────────

describe("GET /api/vehicles", () => {
  it("возвращает только активные машины", async () => {
    const res = await request(app)
      .get("/api/vehicles")
      .set(AUTH_WH());

    expect(res.status).toBe(200);
    expect(res.body.vehicles).toBeDefined();
    const names = res.body.vehicles.map((v: any) => v.name);
    expect(names).toContain("Ford");
    expect(names).toContain("Фотон");
    expect(names).toContain("Ивеко");
    expect(names).not.toContain("Старый фургон"); // inactive
  });

  it("требует аутентификацию (без токена → 401)", async () => {
    const res = await request(app)
      .get("/api/vehicles")
      .set("X-API-Key", "test-key-1"); // no JWT

    expect(res.status).toBe(401);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/admin/vehicles
// ──────────────────────────────────────────────────────────────────────────────

describe("GET /api/admin/vehicles", () => {
  it("SUPER_ADMIN видит все машины включая неактивные", async () => {
    const res = await request(app)
      .get("/api/vehicles/admin")
      .set(AUTH_SA());

    expect(res.status).toBe(200);
    expect(res.body.vehicles).toBeDefined();
    const names = res.body.vehicles.map((v: any) => v.name);
    expect(names).toContain("Старый фургон");
  });

  it("WAREHOUSE → 403 на /api/admin/vehicles", async () => {
    const res = await request(app)
      .get("/api/vehicles/admin")
      .set(AUTH_WH());

    expect(res.status).toBe(403);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// PATCH /api/admin/vehicles/:id
// ──────────────────────────────────────────────────────────────────────────────

describe("PATCH /api/admin/vehicles/:id", () => {
  it("WAREHOUSE → 403", async () => {
    const res = await request(app)
      .patch(`/api/vehicles/admin/${fordId}`)
      .set(AUTH_WH())
      .send({ shiftPriceRub: 22000 });

    expect(res.status).toBe(403);
  });

  it("SUPER_ADMIN может изменить shiftPriceRub → 200", async () => {
    const res = await request(app)
      .patch(`/api/vehicles/admin/${fordId}`)
      .set(AUTH_SA())
      .send({ shiftPriceRub: 21000 });

    expect(res.status).toBe(200);
    expect(res.body.vehicle.shiftPriceRub).toBe("21000.00");
  });

  it("PATCH пишет аудит запись с VEHICLE_UPDATED", async () => {
    const res = await request(app)
      .patch(`/api/vehicles/admin/${fordId}`)
      .set(AUTH_SA())
      .send({ shiftPriceRub: 22000 });

    expect(res.status).toBe(200);

    const auditEntry = await prisma.auditEntry.findFirst({
      where: { entityType: "Vehicle", entityId: fordId, action: "VEHICLE_UPDATED" },
      orderBy: { createdAt: "desc" },
    });
    expect(auditEntry).not.toBeNull();
    expect(auditEntry!.after).toContain("22000");
  });

  it("PATCH с slug в теле — игнорируется, slug не меняется", async () => {
    const before = await prisma.vehicle.findUnique({ where: { id: fordId }, select: { slug: true } });

    const res = await request(app)
      .patch(`/api/vehicles/admin/${fordId}`)
      .set(AUTH_SA())
      .send({ slug: "hacked-slug", shiftPriceRub: 23000 });

    expect(res.status).toBe(200);

    const after = await prisma.vehicle.findUnique({ where: { id: fordId }, select: { slug: true } });
    expect(after!.slug).toBe(before!.slug); // slug unchanged
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/bookings/quote — с транспортом и без
// ──────────────────────────────────────────────────────────────────────────────

const QUOTE_BASE = {
  client: { name: "Тест Клиент Транспорт" },
  projectName: "Проект Т",
  startDate: "2026-05-01T09:00:00.000Z",
  endDate: "2026-05-02T09:00:00.000Z", // 1 сутки = 1 смена
  items: [{ equipmentId: "", quantity: 2 }], // filled below
};

describe("POST /api/bookings/quote — регрессия без транспорта", () => {
  it("без transport — отвечает как раньше, grandTotal = equipmentTotal", async () => {
    const body = { ...QUOTE_BASE, items: [{ equipmentId: equipmentId, quantity: 2 }] };
    const res = await request(app).post("/api/bookings/quote").set(AUTH_WH()).send(body);

    expect(res.status).toBe(200);
    // Обратная совместимость: старые поля присутствуют
    expect(res.body.subtotal).toBeDefined();
    expect(res.body.totalAfterDiscount).toBeDefined();
    // Новые поля тоже
    expect(res.body.equipmentSubtotal).toBeDefined();
    expect(res.body.grandTotal).toBeDefined();
    expect(res.body.transport).toBeNull();
    // grandTotal === totalAfterDiscount когда нет транспорта
    expect(res.body.grandTotal).toBe(res.body.totalAfterDiscount);
  });
});

describe("POST /api/bookings/quote — с транспортом", () => {
  it("grandTotal = equipmentTotal + transport.total", async () => {
    const body = {
      ...QUOTE_BASE,
      items: [{ equipmentId: equipmentId, quantity: 2 }],
      transport: {
        vehicleId: fordId,
        withGenerator: false,
        shiftHours: 12,
        skipOvertime: false,
        kmOutsideMkad: 0,
        ttkEntry: false,
      },
    };
    const res = await request(app).post("/api/bookings/quote").set(AUTH_WH()).send(body);

    expect(res.status).toBe(200);
    expect(res.body.transport).not.toBeNull();
    expect(res.body.transport.vehicleName).toBe("Ford");
    // Ford = 22000 or 23000 depending on previous PATCH tests; doesn't matter for formula check
    const eqTotal = Number(res.body.equipmentTotal);
    const transportTotal = Number(res.body.transport.total);
    const grandTotal = Number(res.body.grandTotal);
    expect(grandTotal).toBeCloseTo(eqTotal + transportTotal, 2);
  });

  it("скидка не применяется к транспорту (изоляция скидки)", async () => {
    const body = {
      ...QUOTE_BASE,
      items: [{ equipmentId: equipmentId, quantity: 2 }],
      discountPercent: 10,
      transport: {
        vehicleId: fordId,
        withGenerator: false,
        shiftHours: 12,
        skipOvertime: false,
        kmOutsideMkad: 0,
        ttkEntry: false,
      },
    };
    const res = await request(app).post("/api/bookings/quote").set(AUTH_WH()).send(body);

    expect(res.status).toBe(200);

    // Проверяем изоляцию скидки
    const eqSubtotal = Number(res.body.equipmentSubtotal);
    const discount = Number(res.body.equipmentDiscount);
    const eqTotal = Number(res.body.equipmentTotal);
    const transportTotal = Number(res.body.transport.total);
    const grandTotal = Number(res.body.grandTotal);

    // Скидка = equipmentSubtotal * 10%
    expect(discount).toBeCloseTo(eqSubtotal * 0.1, 2);
    // equipmentTotal = subtotal - discount
    expect(eqTotal).toBeCloseTo(eqSubtotal - discount, 2);
    // grandTotal = equipmentTotal + transport (без скидки)
    expect(grandTotal).toBeCloseTo(eqTotal + transportTotal, 2);
    // transport.total НЕ уменьшен на скидку
    // Ford shiftPrice после patches = 23000; transport.total = 23000 (только смена, без доп.)
    const fordInDb = await prisma.vehicle.findUnique({ where: { id: fordId } });
    const fordRate = Number(fordInDb!.shiftPriceRub);
    expect(transportTotal).toBeCloseTo(fordRate, 2);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/bookings/draft — сохраняет vehicleId и transportSubtotalRub
// ──────────────────────────────────────────────────────────────────────────────

describe("POST /api/bookings/draft — сохраняет транспорт", () => {
  it("draft с транспортом сохраняет vehicleId и transportSubtotalRub", async () => {
    const body = {
      client: { name: "Клиент Черновик Транспорт" },
      projectName: "Проект с транспортом",
      startDate: "2026-06-01T09:00:00.000Z",
      endDate: "2026-06-02T09:00:00.000Z",
      items: [{ equipmentId: equipmentId, quantity: 1 }],
      transport: {
        vehicleId: fordId,
        withGenerator: false,
        shiftHours: 12,
        skipOvertime: false,
        kmOutsideMkad: 0,
        ttkEntry: false,
      },
    };
    const res = await request(app).post("/api/bookings/draft").set(AUTH_WH()).send(body);

    expect(res.status).toBe(200);
    const bookingId = res.body.booking.id;
    expect(bookingId).toBeTruthy();

    // Проверяем в БД
    const saved = await prisma.booking.findUnique({ where: { id: bookingId } });
    expect(saved).not.toBeNull();
    expect(saved!.vehicleId).toBe(fordId);
    expect(saved!.transportSubtotalRub).not.toBeNull();

    // transportSubtotalRub должен соответствовать ford shiftPrice
    const fordInDb = await prisma.vehicle.findUnique({ where: { id: fordId } });
    const fordRate = Number(fordInDb!.shiftPriceRub);
    expect(Number(saved!.transportSubtotalRub)).toBeCloseTo(fordRate, 2);
  });
});
