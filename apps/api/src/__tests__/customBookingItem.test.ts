/**
 * Тесты произвольных позиций в смете брони (custom line items).
 *
 * Unit-тесты: quoteEstimate с custom items.
 * Интеграционные тесты: POST /api/bookings/draft, PATCH /:id, approve workflow.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import Decimal from "decimal.js";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-custom-item.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-custom";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-custom";
process.env.JWT_SECRET = "test-jwt-secret-custom-min16chars";

let app: Express;
let prisma: any;
let superAdminToken: string;
let warehouseToken: string;

let _counter = 0;
function uid() { return `${Date.now()}_${++_counter}`; }

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
  const hash = await hashPassword("pass");

  const sa = await prisma.adminUser.create({
    data: { username: "cust_sa", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  superAdminToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });

  const wh = await prisma.adminUser.create({
    data: { username: "cust_wh", passwordHash: hash, role: "WAREHOUSE" },
  });
  warehouseToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });
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
// Unit-тесты для quoteEstimate
// ──────────────────────────────────────────────────────────────────────────────

describe("quoteEstimate — custom items (unit tests)", () => {
  it("1 custom item: lineSum = customUnitPrice * quantity (без умножения на shifts)", async () => {
    const { quoteEstimate } = await import("../services/bookings");

    // 1 смена
    const result1 = await quoteEstimate({
      startDate: new Date("2026-06-01T10:00:00Z"),
      endDate: new Date("2026-06-02T10:00:00Z"),
      clientId: "dummy",
      items: [{ customName: "Тележка долли", customUnitPrice: 70000, quantity: 2 }],
    });
    expect(result1.lines).toHaveLength(1);
    expect(result1.lines[0].lineSum.toString()).toBe("140000");
    expect(result1.lines[0].isCustom).toBe(true);
    expect(result1.lines[0].pricingMode).toBe("CUSTOM");
    expect(result1.lines[0].equipmentId).toBeNull();

    // 5 смен — lineSum должна быть та же (нет умножения на shifts)
    const result5 = await quoteEstimate({
      startDate: new Date("2026-06-01T10:00:00Z"),
      endDate: new Date("2026-06-06T10:00:00Z"),
      clientId: "dummy",
      items: [{ customName: "Тележка долли", customUnitPrice: 70000, quantity: 2 }],
    });
    expect(result5.lines[0].lineSum.toString()).toBe("140000");
  });

  it("смешанный: 1 каталожный + 1 custom → 2 lines, правильный subtotal", async () => {
    const { quoteEstimate } = await import("../services/bookings");

    // Создаём оборудование в БД для этого теста
    const eq = await prisma.equipment.create({
      data: {
        importKey: `СМЕШАННЫЙ||ТЕСТ||${uid()}||`,
        name: `Прибор ${uid()}`,
        category: "Свет",
        totalQuantity: 3,
        rentalRatePerShift: 5000,
      },
    });

    const result = await quoteEstimate({
      startDate: new Date("2026-06-01T10:00:00Z"),
      endDate: new Date("2026-06-02T10:00:00Z"),
      clientId: "dummy",
      items: [
        { equipmentId: eq.id, quantity: 1 },
        { customName: "Генератор субаренда", customUnitPrice: 15000, quantity: 1 },
      ],
    });

    expect(result.lines).toHaveLength(2);
    // Каталожная позиция первая
    expect(result.lines[0].isCustom).toBe(false);
    expect(result.lines[0].equipmentId).toBe(eq.id);
    // Custom позиция вторая
    expect(result.lines[1].isCustom).toBe(true);
    expect(result.lines[1].nameSnapshot).toBe("Генератор субаренда");
    // equipmentSubtotal = 5000 + 15000 = 20000
    expect(result.equipmentSubtotal.toString()).toBe("20000");
  });

  it("скидка 20% применяется к общей сумме включая custom", async () => {
    const { quoteEstimate } = await import("../services/bookings");

    const result = await quoteEstimate({
      startDate: new Date("2026-06-01T10:00:00Z"),
      endDate: new Date("2026-06-02T10:00:00Z"),
      clientId: "dummy",
      discountPercent: 20,
      items: [{ customName: "Услуга", customUnitPrice: 10000, quantity: 1 }],
    });

    // subtotal = 10000, скидка 20% = 2000, итог = 8000
    expect(result.equipmentSubtotal.toString()).toBe("10000");
    expect(result.discountAmount.toString()).toBe("2000");
    expect(result.equipmentTotal.toString()).toBe("8000");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Интеграционные тесты
// ──────────────────────────────────────────────────────────────────────────────

describe("POST /api/bookings/draft — custom item", () => {
  it("4. создаёт черновик с custom-позицией: 201, BookingItem(equipmentId=null, customName, customUnitPrice), finalAmount включает custom", async () => {
    const clientName = `Клиент ${uid()}`;

    const res = await request(app)
      .post("/api/bookings/draft")
      .set(AUTH_SA())
      .send({
        client: { name: clientName },
        projectName: "Тест custom item",
        startDate: "2026-07-01T10:00:00.000Z",
        endDate: "2026-07-02T10:00:00.000Z",
        items: [
          { customName: "Тележка долли", customUnitPrice: 70000, quantity: 1 },
        ],
      });

    expect(res.status).toBe(200);
    const booking = res.body.booking;
    expect(booking.id).toBeTruthy();
    expect(booking.status).toBe("DRAFT");

    // Проверяем BookingItem в БД
    const dbItem = await prisma.bookingItem.findFirst({
      where: { bookingId: booking.id },
    });
    expect(dbItem).toBeTruthy();
    expect(dbItem.equipmentId).toBeNull();
    expect(dbItem.customName).toBe("Тележка долли");
    expect(new Decimal(dbItem.customUnitPrice.toString()).toString()).toBe("70000");

    // finalAmount должен учитывать custom
    const dbBooking = await prisma.booking.findUnique({ where: { id: booking.id } });
    expect(new Decimal(dbBooking.finalAmount.toString()).toString()).toBe("70000");
  });

  it("6. две custom-позиции в одной брони → unique constraint не ломается, обе сохраняются", async () => {
    const clientName = `Клиент ${uid()}`;

    const res = await request(app)
      .post("/api/bookings/draft")
      .set(AUTH_SA())
      .send({
        client: { name: clientName },
        projectName: "Тест 2 custom items",
        startDate: "2026-07-01T10:00:00.000Z",
        endDate: "2026-07-02T10:00:00.000Z",
        items: [
          { customName: "Тележка долли", customUnitPrice: 70000, quantity: 1 },
          { customName: "Генератор субаренда", customUnitPrice: 15000, quantity: 2 },
        ],
      });

    expect(res.status).toBe(200);
    const items = await prisma.bookingItem.findMany({
      where: { bookingId: res.body.booking.id },
    });
    expect(items).toHaveLength(2);
    expect(items.every((i: any) => i.equipmentId === null)).toBe(true);
  });
});

describe("PATCH /api/bookings/:id — добавление custom к DRAFT", () => {
  it("7. rebuild работает, finalAmount пересчитан", async () => {
    const u = uid();
    const client = await prisma.client.create({ data: { name: `Клиент ${u}` } });
    const eq = await prisma.equipment.create({
      data: {
        importKey: `PATCH||CUSTOM||${u}||`,
        name: `Прожектор ${u}`,
        category: "Свет",
        totalQuantity: 5,
        rentalRatePerShift: 3000,
      },
    });
    const booking = await prisma.booking.create({
      data: {
        clientId: client.id,
        projectName: "Проект",
        startDate: new Date("2026-07-01T10:00:00Z"),
        endDate: new Date("2026-07-02T10:00:00Z"),
        status: "DRAFT",
        items: { create: [{ equipmentId: eq.id, quantity: 1 }] },
      },
    });

    const res = await request(app)
      .patch(`/api/bookings/${booking.id}`)
      .set(AUTH_SA())
      .send({
        items: [
          { equipmentId: eq.id, quantity: 1 },
          { customName: "Услуга доставки", customUnitPrice: 5000, quantity: 1 },
        ],
      });

    expect(res.status).toBe(200);

    const dbItems = await prisma.bookingItem.findMany({ where: { bookingId: booking.id } });
    expect(dbItems).toHaveLength(2);
    const customItem = dbItems.find((i: any) => i.equipmentId === null);
    expect(customItem).toBeTruthy();
    expect(customItem.customName).toBe("Услуга доставки");

    // finalAmount = 3000 (оборудование 1 смена) + 5000 (custom) = 8000
    const dbBooking = await prisma.booking.findUnique({ where: { id: booking.id } });
    expect(new Decimal(dbBooking.finalAmount.toString()).toString()).toBe("8000");
  });
});

describe("approve workflow с custom item", () => {
  it("5. полный флоу draft→submit→approve с custom item → EstimateLine(equipmentId=null, nameSnapshot=customName, lineSum=customUnitPrice*quantity)", async () => {
    const u = uid();
    const client = await prisma.client.create({ data: { name: `Клиент ${u}` } });
    const booking = await prisma.booking.create({
      data: {
        clientId: client.id,
        projectName: "Проект approve custom",
        startDate: new Date("2026-08-01T10:00:00Z"),
        endDate: new Date("2026-08-02T10:00:00Z"),
        status: "DRAFT",
        items: {
          create: [{ customName: "Тележка долли", customUnitPrice: 70000, quantity: 2 }],
        },
      },
    });

    // submit-for-approval
    const submitRes = await request(app)
      .post(`/api/bookings/${booking.id}/submit-for-approval`)
      .set(AUTH_WH())
      .send({});
    expect(submitRes.status).toBe(200);
    expect(submitRes.body.booking.status).toBe("PENDING_APPROVAL");

    // approve
    const approveRes = await request(app)
      .post(`/api/bookings/${booking.id}/approve`)
      .set(AUTH_SA())
      .send({});
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.booking.status).toBe("CONFIRMED");

    // Проверяем EstimateLine
    const estimate = await prisma.estimate.findUnique({
      where: { bookingId: booking.id },
      include: { lines: true },
    });
    expect(estimate).toBeTruthy();
    expect(estimate.lines).toHaveLength(1);
    const line = estimate.lines[0];
    expect(line.equipmentId).toBeNull();
    expect(line.nameSnapshot).toBe("Тележка долли");
    expect(new Decimal(line.lineSum.toString()).toString()).toBe("140000");
  });
});

describe("8. availability не вызывается для custom-only брони", () => {
  it("approve custom-only брони проходит без availability-конфликтов", async () => {
    const u = uid();
    const client = await prisma.client.create({ data: { name: `Клиент ${u}` } });
    const booking = await prisma.booking.create({
      data: {
        clientId: client.id,
        projectName: "Custom only проект",
        startDate: new Date("2026-09-01T10:00:00Z"),
        endDate: new Date("2026-09-10T10:00:00Z"),
        status: "DRAFT",
        items: {
          create: [
            { customName: "Субаренда 1", customUnitPrice: 10000, quantity: 3 },
            { customName: "Субаренда 2", customUnitPrice: 5000, quantity: 1 },
          ],
        },
      },
    });

    await request(app)
      .post(`/api/bookings/${booking.id}/submit-for-approval`)
      .set(AUTH_WH())
      .send({});

    const approveRes = await request(app)
      .post(`/api/bookings/${booking.id}/approve`)
      .set(AUTH_SA())
      .send({});

    expect(approveRes.status).toBe(200);
    expect(approveRes.body.booking.status).toBe("CONFIRMED");
  });
});

describe("Zod-валидация bookingItemSchema", () => {
  it("9. payload без equipmentId И без customName → 400", async () => {
    const res = await request(app)
      .post("/api/bookings/draft")
      .set(AUTH_SA())
      .send({
        client: { name: `Клиент ${uid()}` },
        projectName: "Тест",
        startDate: "2026-07-01T10:00:00.000Z",
        endDate: "2026-07-02T10:00:00.000Z",
        items: [{ quantity: 1 }],
      });
    expect(res.status).toBe(400);
  });

  it("10. payload с equipmentId И customName одновременно → 400", async () => {
    const u = uid();
    const eq = await prisma.equipment.create({
      data: {
        importKey: `ZOD||BOTH||${u}||`,
        name: `Прибор ${u}`,
        category: "Свет",
        totalQuantity: 1,
        rentalRatePerShift: 1000,
      },
    });
    const res = await request(app)
      .post("/api/bookings/draft")
      .set(AUTH_SA())
      .send({
        client: { name: `Клиент ${uid()}` },
        projectName: "Тест",
        startDate: "2026-07-01T10:00:00.000Z",
        endDate: "2026-07-02T10:00:00.000Z",
        items: [{ equipmentId: eq.id, customName: "Что-то", customUnitPrice: 1000, quantity: 1 }],
      });
    expect(res.status).toBe(400);
  });
});
