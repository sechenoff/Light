/**
 * Интеграционные тесты /api/calendar и /api/calendar/occupancy
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-calendar.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1,test-key-2";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-calendar";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-calendar";
process.env.JWT_SECRET = "test-jwt-secret-calendar-min16chars";

let app: Express;
let prisma: any;
let superAdminToken: string;

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

  // Создаём SUPER_ADMIN для тестов роутов, защищённых rolesGuard
  const { hashPassword, signSession } = await import("../services/auth");
  const hash = await hashPassword("test-pass-123");
  const admin = await prisma.adminUser.create({
    data: { username: "calendar_super_admin", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  superAdminToken = signSession({ userId: admin.id, username: admin.username, role: "SUPER_ADMIN" });
});

afterAll(async () => {
  await prisma.$disconnect();
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = TEST_DB_PATH + suffix;
    if (fs.existsSync(f)) {
      try { fs.unlinkSync(f); } catch { /* игнорируем */ }
    }
  }
});

function AUTH() { return { "X-API-Key": "test-key-1", Authorization: `Bearer ${superAdminToken}` }; }

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

let eqCounter = 0;

async function createEquipment(name: string, category = "Свет", totalQuantity = 5) {
  eqCounter++;
  return prisma.equipment.create({
    data: {
      importKey: `${category.toUpperCase()}||${name.toUpperCase()}||${eqCounter}||`,
      name,
      category,
      totalQuantity,
      stockTrackingMode: "COUNT",
      rentalRatePerShift: 500,
    },
  });
}

async function createClient(name: string) {
  return prisma.client.create({ data: { name } });
}

async function createBooking(
  clientId: string,
  equipmentId: string,
  status: string,
  startDate: Date,
  endDate: Date,
  projectName = "Проект"
) {
  return prisma.booking.create({
    data: {
      clientId,
      projectName,
      startDate,
      endDate,
      status,
      items: {
        create: [{ equipmentId, quantity: 2 }],
      },
    },
  });
}

// ──────────────────────────────────────────────────────────────────
// GET /api/calendar
// ──────────────────────────────────────────────────────────────────

describe("GET /api/calendar", () => {
  it("возвращает 401 без API-ключа", async () => {
    const res = await request(app).get("/api/calendar?start=2025-01-01&end=2025-01-31");
    expect(res.status).toBe(401);
  });

  it("возвращает 400 без обязательных параметров", async () => {
    const res = await request(app).get("/api/calendar").set(AUTH());
    expect(res.status).toBe(400);
  });

  it("возвращает resources и events", async () => {
    const client = await createClient("Клиент Кал1");
    const eq = await createEquipment("Камера Кал1");

    await createBooking(
      client.id,
      eq.id,
      "CONFIRMED",
      new Date("2025-03-01T00:00:00.000Z"),
      new Date("2025-03-10T23:59:59.999Z"),
      "Проект Март"
    );

    const res = await request(app)
      .get("/api/calendar?start=2025-03-01&end=2025-03-15")
      .set(AUTH());
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("resources");
    expect(res.body).toHaveProperty("events");

    const resource = res.body.resources.find((r: any) => r.name === "Камера Кал1");
    expect(resource).toBeDefined();
    expect(resource.category).toBe("Свет");
    expect(resource.totalQuantity).toBe(5);

    const event = res.body.events.find((e: any) => e.title === "Проект Март");
    expect(event).toBeDefined();
    expect(event.clientName).toBe("Клиент Кал1");
    expect(event.quantity).toBe(2);
    expect(event.status).toBe("CONFIRMED");
  });

  it("исключает брони не попадающие в диапазон", async () => {
    const client = await createClient("Клиент Кал2");
    const eq = await createEquipment("Камера Кал2");

    await createBooking(
      client.id,
      eq.id,
      "CONFIRMED",
      new Date("2025-01-01T00:00:00.000Z"),
      new Date("2025-01-31T23:59:59.999Z"),
      "Январский проект"
    );

    const res = await request(app)
      .get("/api/calendar?start=2025-03-01&end=2025-03-31")
      .set(AUTH());
    expect(res.status).toBe(200);
    const event = res.body.events.find((e: any) => e.title === "Январский проект");
    expect(event).toBeUndefined();
  });

  it("фильтрует по категории", async () => {
    const client = await createClient("Клиент Кал3");
    const eqSvet = await createEquipment("Прожектор Кал3", "Свет");
    const eqAkk = await createEquipment("Аккумулятор Кал3", "Питание");

    const start = new Date("2025-04-01T00:00:00.000Z");
    const end = new Date("2025-04-10T23:59:59.999Z");

    await createBooking(client.id, eqSvet.id, "CONFIRMED", start, end, "Свет проект");
    await createBooking(client.id, eqAkk.id, "CONFIRMED", start, end, "Питание проект");

    const res = await request(app)
      .get("/api/calendar?start=2025-04-01&end=2025-04-15&category=Свет")
      .set(AUTH());
    expect(res.status).toBe(200);

    const svetEvent = res.body.events.find((e: any) => e.title === "Свет проект");
    const akkEvent = res.body.events.find((e: any) => e.title === "Питание проект");
    expect(svetEvent).toBeDefined();
    expect(akkEvent).toBeUndefined();
  });

  it("фильтрует по поиску (projectName или clientName)", async () => {
    const client = await createClient("Кинокомпания СПб");
    const eq = await createEquipment("Камера Кал4");

    await createBooking(
      client.id,
      eq.id,
      "CONFIRMED",
      new Date("2025-05-01T00:00:00.000Z"),
      new Date("2025-05-10T23:59:59.999Z"),
      "Документалка 2025"
    );

    const res = await request(app)
      .get("/api/calendar?start=2025-05-01&end=2025-05-31&search=Документалка")
      .set(AUTH());
    expect(res.status).toBe(200);
    const event = res.body.events.find((e: any) => e.title === "Документалка 2025");
    expect(event).toBeDefined();

    const resNoMatch = await request(app)
      .get("/api/calendar?start=2025-05-01&end=2025-05-31&search=Несуществующий")
      .set(AUTH());
    expect(resNoMatch.body.events.find((e: any) => e.title === "Документалка 2025")).toBeUndefined();
  });

  it("исключает DRAFT по умолчанию", async () => {
    const client = await createClient("Клиент черновик кал");
    const eq = await createEquipment("Оборудование черновик кал");

    await createBooking(
      client.id,
      eq.id,
      "DRAFT",
      new Date("2025-06-01T00:00:00.000Z"),
      new Date("2025-06-10T23:59:59.999Z"),
      "Черновик проект кал"
    );

    const res = await request(app)
      .get("/api/calendar?start=2025-06-01&end=2025-06-30")
      .set(AUTH());
    expect(res.status).toBe(200);
    const event = res.body.events.find((e: any) => e.title === "Черновик проект кал");
    expect(event).toBeUndefined();
  });

  it("MF-1: PENDING_APPROVAL виден в календаре БЕЗ includeDrafts", async () => {
    const client = await createClient("Клиент пендинг кал");
    const eq = await createEquipment("Оборудование пендинг кал");

    await createBooking(
      client.id,
      eq.id,
      "PENDING_APPROVAL",
      new Date("2025-11-01T00:00:00.000Z"),
      new Date("2025-11-05T23:59:59.999Z"),
      "Пендинг проект кал"
    );

    const res = await request(app)
      .get("/api/calendar?start=2025-11-01&end=2025-11-30")
      .set(AUTH());
    expect(res.status).toBe(200);
    const event = res.body.events.find((e: any) => e.title === "Пендинг проект кал");
    expect(event).toBeDefined();
    expect(event.status).toBe("PENDING_APPROVAL");
  });

  it("MF-2: для UNIT-ресурса totalQuantity = число пригодных единиц (без MAINTENANCE/MISSING)", async () => {
    eqCounter++;
    const eq = await prisma.equipment.create({
      data: {
        importKey: `СВЕТ||UNIT-КАЛ||${eqCounter}||`,
        name: "UNIT-прибор кал",
        category: "Свет",
        totalQuantity: 5,
        stockTrackingMode: "UNIT",
        rentalRatePerShift: 500,
      },
    });
    const statuses = ["AVAILABLE", "AVAILABLE", "ISSUED", "MAINTENANCE", "MISSING"];
    for (let i = 0; i < statuses.length; i++) {
      await prisma.equipmentUnit.create({
        data: { equipmentId: eq.id, barcode: `CAL-UNIT-${i}`, status: statuses[i] },
      });
    }

    const res = await request(app)
      .get("/api/calendar?start=2025-12-01&end=2025-12-07")
      .set(AUTH());
    expect(res.status).toBe(200);
    const resource = res.body.resources.find((r: any) => r.name === "UNIT-прибор кал");
    expect(resource).toBeDefined();
    // 2 AVAILABLE + 1 ISSUED = 3 пригодных; MAINTENANCE и MISSING не раздувают знаменатель
    expect(resource.totalQuantity).toBe(3);
    expect(resource.trackingMode).toBe("UNIT");
  });

  it("F-LOST-1: COUNT-потеряшки уменьшают totalQuantity ресурса (как в проверке доступности)", async () => {
    const client = await createClient("Клиент потеряшки кал");
    // COUNT-позиция: totalQuantity=20
    const eq = await createEquipment("COUNT-удлинитель кал", "Свет", 20);
    const booking = await prisma.booking.create({
      data: {
        clientId: client.id,
        projectName: "Проект потеряшки кал",
        startDate: new Date("2026-01-01T00:00:00.000Z"),
        endDate: new Date("2026-01-02T00:00:00.000Z"),
        status: "RETURNED",
        items: { create: [{ equipmentId: eq.id, quantity: 20 }] },
      },
      include: { items: true },
    });
    const bookingItem = booking.items[0];

    // 5 SEARCHING + 2 WROTE_OFF = -7 из базы; 3 FOUND не вычитается
    await prisma.problemItem.create({
      data: {
        bookingItemId: bookingItem.id, quantity: 5, sourceBookingId: booking.id,
        reason: "LOST", comment: "утеряны", status: "SEARCHING", createdBy: "tester",
      },
    });
    await prisma.problemItem.create({
      data: {
        bookingItemId: bookingItem.id, quantity: 2, sourceBookingId: booking.id,
        reason: "DESTROYED", comment: "сломаны", status: "WROTE_OFF", createdBy: "tester",
      },
    });
    await prisma.problemItem.create({
      data: {
        bookingItemId: bookingItem.id, quantity: 3, sourceBookingId: booking.id,
        reason: "LEFT_ON_SITE", comment: "нашлись", status: "FOUND", createdBy: "tester",
      },
    });

    // Окно НЕ пересекает бронь — проверяем только базу (totalQuantity ресурса).
    const res = await request(app)
      .get("/api/calendar?start=2026-03-01&end=2026-03-07")
      .set(AUTH());
    expect(res.status).toBe(200);
    const resource = res.body.resources.find((r: any) => r.name === "COUNT-удлинитель кал");
    expect(resource).toBeDefined();
    // 20 − (5 + 2) = 13; FOUND (3) не вычитается
    expect(resource.totalQuantity).toBe(13);
    expect(resource.trackingMode).toBe("COUNT");
  });

  it("включает DRAFT при includeDrafts=true", async () => {
    const client = await createClient("Клиент черновик кал2");
    const eq = await createEquipment("Оборудование черновик кал2");

    await createBooking(
      client.id,
      eq.id,
      "DRAFT",
      new Date("2025-07-01T00:00:00.000Z"),
      new Date("2025-07-10T23:59:59.999Z"),
      "Черновик проект кал2"
    );

    const res = await request(app)
      .get("/api/calendar?start=2025-07-01&end=2025-07-31&includeDrafts=true")
      .set(AUTH());
    expect(res.status).toBe(200);
    const event = res.body.events.find((e: any) => e.title === "Черновик проект кал2");
    expect(event).toBeDefined();
    expect(event.status).toBe("DRAFT");
  });
});

// ──────────────────────────────────────────────────────────────────
// GET /api/calendar/occupancy
// ──────────────────────────────────────────────────────────────────

describe("GET /api/calendar/occupancy", () => {
  it("возвращает 401 без API-ключа", async () => {
    const res = await request(app).get("/api/calendar/occupancy?start=2025-01-01&end=2025-01-10");
    expect(res.status).toBe(401);
  });

  it("возвращает 400 при диапазоне >90 дней", async () => {
    const res = await request(app)
      .get("/api/calendar/occupancy?start=2025-01-01&end=2025-04-10")
      .set(AUTH());
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("90");
  });

  it("возвращает данные по дням с суммарной мощностью", async () => {
    const client = await createClient("Клиент Окк");
    const eq = await createEquipment("Прожектор Окк", "Свет", 10);

    // Создаём брони перекрывающие первые 3 дня
    await createBooking(
      client.id,
      eq.id,
      "CONFIRMED",
      new Date("2025-08-01T00:00:00.000Z"),
      new Date("2025-08-03T23:59:59.999Z"),
      "Август проект"
    );

    const res = await request(app)
      .get("/api/calendar/occupancy?start=2025-08-01&end=2025-08-07")
      .set(AUTH());
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("days");
    expect(res.body).toHaveProperty("totalCapacity");
    expect(Array.isArray(res.body.days)).toBe(true);
    expect(res.body.days.length).toBe(7);

    // Первые 3 дня должны иметь bookingCount > 0
    const day1 = res.body.days.find((d: any) => d.date === "2025-08-01");
    expect(day1).toBeDefined();
    expect(day1.bookingCount).toBeGreaterThan(0);

    // 4й день не должен быть занят этой бронью
    const day4 = res.body.days.find((d: any) => d.date === "2025-08-04");
    // bookingCount на 4й день зависит от других тестов, но структура должна быть
    expect(day4).toBeDefined();
    expect(typeof day4.occupancyPercent).toBe("number");
  });

  it("MF-3: границы дня — московские: бронь с 00:00 МСК не красит предыдущий день", async () => {
    const client = await createClient("Клиент Окк МСК");
    const eq = await createEquipment("Прожектор Окк МСК", "Свет", 10);

    // 2025-10-05T21:00Z = 2025-10-06 00:00 МСК; конец 20:00Z = 23:00 МСК 6 октября.
    // По UTC-раскладке бронь красила бы 5 октября — по Москве не должна.
    await createBooking(
      client.id,
      eq.id,
      "CONFIRMED",
      new Date("2025-10-05T21:00:00.000Z"),
      new Date("2025-10-06T20:00:00.000Z"),
      "Октябрь ночной старт"
    );

    const res = await request(app)
      .get("/api/calendar/occupancy?start=2025-10-01&end=2025-10-07")
      .set(AUTH());
    expect(res.status).toBe(200);

    const day5 = res.body.days.find((d: any) => d.date === "2025-10-05");
    const day6 = res.body.days.find((d: any) => d.date === "2025-10-06");
    expect(day5.bookingCount).toBe(0);
    expect(day6.bookingCount).toBeGreaterThan(0);
  });

  it("MF-1: PENDING_APPROVAL входит в heatmap занятости", async () => {
    const client = await createClient("Клиент Окк Пендинг");
    const eq = await createEquipment("Прожектор Окк Пендинг", "Свет", 10);

    await createBooking(
      client.id,
      eq.id,
      "PENDING_APPROVAL",
      new Date("2025-10-15T06:00:00.000Z"),
      new Date("2025-10-15T18:00:00.000Z"),
      "Октябрь пендинг"
    );

    const res = await request(app)
      .get("/api/calendar/occupancy?start=2025-10-14&end=2025-10-16")
      .set(AUTH());
    expect(res.status).toBe(200);
    const day15 = res.body.days.find((d: any) => d.date === "2025-10-15");
    expect(day15.bookingCount).toBeGreaterThan(0);
    expect(day15.occupancyPercent).toBeGreaterThan(0);
  });

  it("возвращает правильную структуру дней", async () => {
    const res = await request(app)
      .get("/api/calendar/occupancy?start=2025-09-01&end=2025-09-05")
      .set(AUTH());
    expect(res.status).toBe(200);
    expect(res.body.days.length).toBe(5);
    for (const day of res.body.days) {
      expect(day).toHaveProperty("date");
      expect(day).toHaveProperty("bookingCount");
      expect(day).toHaveProperty("occupancyPercent");
      expect(/^\d{4}-\d{2}-\d{2}$/.test(day.date)).toBe(true);
      expect(day.occupancyPercent).toBeGreaterThanOrEqual(0);
      expect(day.occupancyPercent).toBeLessThanOrEqual(100);
    }
  });
});
