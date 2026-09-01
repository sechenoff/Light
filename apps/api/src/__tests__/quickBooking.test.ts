/**
 * Интеграционные тесты быстрой брони: POST /api/bookings/quick.
 *
 * Сценарий — «клиент + произвольная сумма, без оборудования». Проверяем:
 * сумма-override живёт в manualFinalAmount и переживает финансовый пересчёт,
 * бронь сразу CONFIRMED, позиций нет, склад её не видит, роли соблюдены.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-quick-booking.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-quick";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-quick";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-quick";
process.env.JWT_SECRET = "test-jwt-secret-quick-min16chars";

let app: Express;
let prisma: any;
let superAdminToken: string;
let warehouseToken: string;
let technicianToken: string;
let warehousePinToken: string;

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
    data: { username: "quick_sa", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  superAdminToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });

  const wh = await prisma.adminUser.create({
    data: { username: "quick_wh", passwordHash: hash, role: "WAREHOUSE" },
  });
  warehouseToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });

  const tech = await prisma.adminUser.create({
    data: { username: "quick_tech", passwordHash: hash, role: "TECHNICIAN" },
  });
  technicianToken = signSession({ userId: tech.id, username: tech.username, role: "TECHNICIAN" });

  const { generateToken } = await import("../services/warehouseAuth");
  warehousePinToken = generateToken("Кладовщик Тест");
});

afterAll(async () => {
  await prisma.$disconnect();
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = TEST_DB_PATH + suffix;
    if (fs.existsSync(f)) {
      try { fs.unlinkSync(f); } catch { /* игнор */ }
    }
  }
});

function SA() {
  return { "X-API-Key": "test-key-quick", Authorization: `Bearer ${superAdminToken}` };
}
function WH() {
  return { "X-API-Key": "test-key-quick", Authorization: `Bearer ${warehouseToken}` };
}
function TECH() {
  return { "X-API-Key": "test-key-quick", Authorization: `Bearer ${technicianToken}` };
}

describe("POST /api/bookings/quick", () => {
  it("создаёт подтверждённую бронь без позиций с произвольной суммой", async () => {
    const res = await request(app)
      .post("/api/bookings/quick")
      .set(SA())
      .send({ client: { name: "ООО «Быстрый клиент»" }, amount: 40000 });

    expect(res.status).toBe(201);
    const b = res.body.booking;
    expect(b.status).toBe("CONFIRMED");
    expect(b.finalAmount).toBe("40000");
    expect(b.items).toHaveLength(0);

    const row = await prisma.booking.findUnique({
      where: { id: b.id },
      include: { items: true, estimates: true, client: true },
    });
    expect(row.items).toHaveLength(0);
    // Смета не создаётся — снапшотить нечего
    expect(row.estimates).toHaveLength(0);
    expect(row.manualFinalAmount.toString()).toBe("40000");
    expect(row.confirmedAt).not.toBeNull();
    // Новая бронь живёт в invoice-модели, счета должны быть доступны
    expect(row.legacyFinance).toBe(false);
    expect(row.client.name).toBe("ООО «Быстрый клиент»");
    // Долг равен сумме — платежей ещё нет
    expect(row.amountOutstanding.toString()).toBe("40000");
    expect(row.paymentStatus).toBe("NOT_PAID");
  });

  it("сумма переживает финансовый пересчёт (manualFinalAmount авторитетен)", async () => {
    const res = await request(app)
      .post("/api/bookings/quick")
      .set(SA())
      .send({ client: { name: "Клиент пересчёта" }, amount: 12345.67 });
    expect(res.status).toBe(201);

    const { recomputeBookingFinance } = await import("../services/finance");
    await recomputeBookingFinance(res.body.booking.id);

    const row = await prisma.booking.findUnique({ where: { id: res.body.booking.id } });
    // Без override пересчёт обнулил бы finalAmount (позиций нет)
    expect(row.finalAmount.toString()).toBe("12345.67");
  });

  it("подставляет проект «Без описания» и период сегодня→завтра", async () => {
    const res = await request(app)
      .post("/api/bookings/quick")
      .set(SA())
      .send({ client: { name: "Клиент без проекта" }, amount: 1000 });

    expect(res.status).toBe(201);
    expect(res.body.booking.projectName).toBe("Без описания");
    const row = await prisma.booking.findUnique({ where: { id: res.body.booking.id } });
    const days = (row.endDate.getTime() - row.startDate.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBeCloseTo(1, 5);
  });

  it("принимает явные проект, период и комментарий", async () => {
    const res = await request(app)
      .post("/api/bookings/quick")
      .set(SA())
      .send({
        client: { name: "Клиент с деталями" },
        amount: 5000,
        projectName: "Клип «Осень»",
        comment: "Договорились по телефону",
        startDate: "2026-09-10T10:00",
        endDate: "2026-09-12T10:00",
      });

    expect(res.status).toBe(201);
    expect(res.body.booking.projectName).toBe("Клип «Осень»");
    const row = await prisma.booking.findUnique({ where: { id: res.body.booking.id } });
    expect(row.comment).toBe("Договорились по телефону");
    const days = (row.endDate.getTime() - row.startDate.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBeCloseTo(2, 5);
  });

  it("сумма 0 допустима (бартер / сумма позже)", async () => {
    const res = await request(app)
      .post("/api/bookings/quick")
      .set(SA())
      .send({ client: { name: "Бартерный клиент" }, amount: 0 });
    expect(res.status).toBe(201);
    expect(res.body.booking.finalAmount).toBe("0");
  });

  it("переиспользует существующего клиента, не плодит дубли", async () => {
    const name = "ООО «Повторный»";
    const first = await request(app).post("/api/bookings/quick").set(SA())
      .send({ client: { name }, amount: 100 });
    const second = await request(app).post("/api/bookings/quick").set(SA())
      .send({ client: { name }, amount: 200 });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const clients = await prisma.client.findMany({ where: { name } });
    expect(clients).toHaveLength(1);
  });

  it("телефон дозаполняется новому клиенту, но не перетирает существующий", async () => {
    const name = "Клиент с телефоном";
    await request(app).post("/api/bookings/quick").set(SA())
      .send({ client: { name, phone: "+7 916 111-11-11" }, amount: 100 });
    let c = await prisma.client.findUnique({ where: { name } });
    expect(c.phone).toBe("+7 916 111-11-11");

    await request(app).post("/api/bookings/quick").set(SA())
      .send({ client: { name, phone: "+7 916 222-22-22" }, amount: 100 });
    c = await prisma.client.findUnique({ where: { name } });
    expect(c.phone).toBe("+7 916 111-11-11");
  });

  it("пишет аудит BOOKING_QUICK_CREATE", async () => {
    const res = await request(app).post("/api/bookings/quick").set(SA())
      .send({ client: { name: "Клиент аудита" }, amount: 777 });
    const audit = await prisma.auditEntry.findMany({
      where: { entityType: "Booking", entityId: res.body.booking.id, action: "BOOKING_QUICK_CREATE" },
    });
    expect(audit).toHaveLength(1);
    const after = typeof audit[0].after === "string" ? JSON.parse(audit[0].after) : audit[0].after;
    expect(after.amount).toBe(777);
    expect(after.clientName).toBe("Клиент аудита");
  });

  // ── Валидация ──────────────────────────────────────────────────────────────

  it("пустое имя клиента → 400", async () => {
    const res = await request(app).post("/api/bookings/quick").set(SA())
      .send({ client: { name: "   " }, amount: 100 });
    expect(res.status).toBe(400);
  });

  it("отрицательная сумма → 400", async () => {
    const res = await request(app).post("/api/bookings/quick").set(SA())
      .send({ client: { name: "Минус" }, amount: -5 });
    expect(res.status).toBe(400);
  });

  it("сумма не числом → 400", async () => {
    const res = await request(app).post("/api/bookings/quick").set(SA())
      .send({ client: { name: "Строка" }, amount: "40000" });
    expect(res.status).toBe(400);
  });

  it("возврат раньше выдачи → 400", async () => {
    const res = await request(app).post("/api/bookings/quick").set(SA())
      .send({
        client: { name: "Обратный период" },
        amount: 100,
        startDate: "2026-09-12T10:00",
        endDate: "2026-09-10T10:00",
      });
    expect(res.status).toBe(400);
  });

  // ── Роли ───────────────────────────────────────────────────────────────────

  it("WAREHOUSE может создать быструю бронь", async () => {
    const res = await request(app).post("/api/bookings/quick").set(WH())
      .send({ client: { name: "Клиент кладовщика" }, amount: 3000 });
    expect(res.status).toBe(201);
  });

  it("TECHNICIAN → 403", async () => {
    const res = await request(app).post("/api/bookings/quick").set(TECH())
      .send({ client: { name: "Клиент техника" }, amount: 3000 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN_BY_ROLE");
  });

  it("без сессии → 401", async () => {
    const res = await request(app).post("/api/bookings/quick")
      .set({ "X-API-Key": "test-key-quick" })
      .send({ client: { name: "Аноним" }, amount: 100 });
    expect(res.status).toBe(401);
  });
});

// ── Склад не видит брони без оборудования ────────────────────────────────────

describe("Быстрая бронь скрыта на складских экранах", () => {
  it("не попадает в очередь выдачи, а обычная бронь — попадает", async () => {
    const quick = await request(app).post("/api/bookings/quick").set(SA())
      .send({ client: { name: "Склад-невидимка" }, amount: 9000 });
    expect(quick.status).toBe(201);

    // Контрольная бронь С оборудованием в том же статусе CONFIRMED
    const eq = await prisma.equipment.create({
      data: {
        importKey: "quick-test-eq",
        name: "Контрольный прибор",
        category: "Свет",
        rentalRatePerShift: 1000,
        stockTrackingMode: "COUNT",
        totalQuantity: 3,
      },
    });
    const client = await prisma.client.findFirst({ where: { name: "Склад-невидимка" } });
    const withItems = await prisma.booking.create({
      data: {
        clientId: client.id,
        projectName: "Обычная бронь",
        startDate: new Date(),
        endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
        status: "CONFIRMED",
        amountPaid: 0,
        amountOutstanding: 0,
        items: { create: [{ equipmentId: eq.id, quantity: 1 }] },
      },
    });

    const res = await request(app)
      .get("/api/warehouse/bookings?operation=ISSUE")
      .set("Authorization", `Bearer ${warehousePinToken}`);
    expect(res.status).toBe(200);

    const ids = res.body.bookings.map((b: { id: string }) => b.id);
    expect(ids).toContain(withItems.id);
    expect(ids).not.toContain(quick.body.booking.id);
  });

  it("остаётся видимой в обычном списке броней", async () => {
    const quick = await request(app).post("/api/bookings/quick").set(SA())
      .send({ client: { name: "Виден в списке" }, amount: 4200 });

    const list = await request(app).get("/api/bookings?limit=200").set(SA());
    expect(list.status).toBe(200);
    const ids = list.body.bookings.map((b: { id: string }) => b.id);
    expect(ids).toContain(quick.body.booking.id);
  });
});
