/**
 * Интеграционные тесты водителя в kiosk-сценарии:
 *  (a) GET /api/warehouse/sessions/:id/vehicles — список машин брони с driverName/Phone.
 *  (b) PATCH /api/warehouse/sessions/:id/vehicles/:bvId/driver через PIN-кузовщика
 *      сохраняет и пишет AuditEntry с workerName + sessionId в payload.
 *  (c) То же через SA-JWT (fallback на warehouseAuth) — userId = adminUser, не _system_.
 *  (d) Idempotent: тот же payload — без audit-инсерта.
 *  (e) Машина другой брони → 404.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-wh-driver.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-wh-driver";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-wh-driver-min16chars";
process.env.JWT_SECRET = "test-jwt-secret-wh-driver-min16chars";

let app: Express;
let prisma: any;
let superAdminToken: string;
let warehouseToken: string;
let pinAuthToken: string;
let vehicleId: string;
let equipmentId: string;
let workerId: string;

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
  const { hashPin } = await import("../services/warehouseAuth");
  const hash = await hashPassword("test-pass-123");

  // Seed _system_ user — нужен для audit attribution при PIN-only кузовщике
  await prisma.adminUser.upsert({
    where: { id: "_system_" },
    update: {},
    create: { id: "_system_", username: "_system_", passwordHash: hash, role: "SUPER_ADMIN" },
  });

  const sa = await prisma.adminUser.create({
    data: { username: "wd_sa", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  superAdminToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });

  const wh = await prisma.adminUser.create({
    data: { username: "wd_wh", passwordHash: hash, role: "WAREHOUSE" },
  });
  warehouseToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });

  // PIN-кузовщик (отдельный — без AdminUser-записи, как настоящий кузовщик на проде)
  const pinHash = await hashPin("1234");
  const worker = await prisma.warehousePin.create({
    data: { name: "Иван Кузовщик", pinHash, isActive: true },
  });
  workerId = worker.id;

  // Получаем kiosk-токен через настоящий /api/warehouse/auth
  const authRes = await request(app)
    .post("/api/warehouse/auth")
    .set({ "X-API-Key": "test-key-1" })
    .send({ name: "Иван Кузовщик", pin: "1234" });
  expect(authRes.status).toBe(200);
  pinAuthToken = authRes.body.token;

  const sprinter = await prisma.vehicle.create({
    data: {
      slug: "sprinter-wd",
      name: "Sprinter WD",
      shiftPriceRub: "20000",
      hasGeneratorOption: false,
      displayOrder: 1,
      shiftHours: 12,
      overtimePercent: "10",
      active: true,
    },
  });
  vehicleId = sprinter.id;

  const eq = await prisma.equipment.create({
    data: {
      importKey: "LED||ПАНЕЛЬ WD||GENERIC||LED-WD",
      name: "Панель WD",
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

const AUTH_SA = () => ({ "X-API-Key": "test-key-1", Authorization: `Bearer ${superAdminToken}` });
const AUTH_WH = () => ({ "X-API-Key": "test-key-1", Authorization: `Bearer ${warehouseToken}` });
const AUTH_PIN = () => ({ "X-API-Key": "test-key-1", Authorization: `Bearer ${pinAuthToken}` });

let bookingSeq = 0;
function nextBookingDates(): { startDate: string; endDate: string } {
  bookingSeq += 1;
  // Каждой брони уникальное окно: 10+N июля → 11+N (1 смена) — без overlap.
  const day = 10 + bookingSeq;
  return {
    startDate: `2026-07-${String(day).padStart(2, "0")}T09:00:00.000Z`,
    endDate: `2026-07-${String(day + 1).padStart(2, "0")}T09:00:00.000Z`,
  };
}

async function createBookingAndIssueSession() {
  const { startDate, endDate } = nextBookingDates();
  const draftRes = await request(app)
    .post("/api/bookings/draft")
    .set(AUTH_WH())
    .send({
      client: { name: "Тест-Клиент WD" },
      projectName: "Проект WD",
      startDate,
      endDate,
      items: [{ equipmentId, quantity: 1 }],
      transport: [
        { vehicleId, withGenerator: false, shiftHours: 12, skipOvertime: false, kmOutsideMkad: 0, ttkEntry: false },
      ],
    });
  expect([200, 201]).toContain(draftRes.status);
  const booking = draftRes.body.booking;

  // DRAFT → PENDING_APPROVAL → CONFIRMED (approval workflow)
  const submitRes = await request(app)
    .post(`/api/bookings/${booking.id}/submit-for-approval`)
    .set(AUTH_WH())
    .send({});
  expect([200, 201]).toContain(submitRes.status);
  const approveRes = await request(app)
    .post(`/api/bookings/${booking.id}/approve`)
    .set(AUTH_SA())
    .send({});
  expect([200, 201]).toContain(approveRes.status);

  // Start scan session (через PIN)
  const sessionRes = await request(app)
    .post("/api/warehouse/sessions")
    .set(AUTH_PIN())
    .send({ bookingId: booking.id, operation: "ISSUE" });
  expect(sessionRes.status).toBe(201);

  return { booking, session: sessionRes.body.session };
}

describe("Kiosk driver — GET /api/warehouse/sessions/:id/vehicles", () => {
  it("(a) PIN-кузовщик видит машины брони + driverName/Phone", async () => {
    const { session } = await createBookingAndIssueSession();
    const res = await request(app)
      .get(`/api/warehouse/sessions/${session.id}/vehicles`)
      .set(AUTH_PIN());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.vehicles)).toBe(true);
    expect(res.body.vehicles).toHaveLength(1);
    const v = res.body.vehicles[0];
    expect(v.vehicle.name).toBe("Sprinter WD");
    expect(v.driverName).toBeNull();
    expect(v.driverPhone).toBeNull();
  });
});

describe("Kiosk driver — PATCH через PIN-кузовщика", () => {
  it("(b) сохраняет водителя и пишет audit с workerName + sessionId в payload", async () => {
    const { booking, session } = await createBookingAndIssueSession();

    const vehicles = await request(app)
      .get(`/api/warehouse/sessions/${session.id}/vehicles`)
      .set(AUTH_PIN());
    const bv = vehicles.body.vehicles[0];

    const res = await request(app)
      .patch(`/api/warehouse/sessions/${session.id}/vehicles/${bv.id}/driver`)
      .set(AUTH_PIN())
      .send({ driverName: "Лёша Водитель", driverPhone: "+7 (916) 555-22-11" });

    expect(res.status).toBe(200);
    expect(res.body.vehicle.driverName).toBe("Лёша Водитель");
    expect(res.body.vehicle.driverPhone).toBe("+7 (916) 555-22-11");

    const auditEntries = await prisma.auditEntry.findMany({
      where: { action: "BOOKING_VEHICLE_DRIVER_SET", entityId: booking.id },
      orderBy: { createdAt: "desc" },
    });
    expect(auditEntries.length).toBe(1);
    const audit = auditEntries[0];
    // PIN-only — атрибуция идёт на _system_, но workerName в payload
    expect(audit.userId).toBe("_system_");
    const after = JSON.parse(audit.after);
    expect(after.workerName).toBe("Иван Кузовщик");
    expect(after.scanSessionId).toBe(session.id);
    expect(after.via).toBe("kiosk-issue");
    expect(after.driverName).toBe("Лёша Водитель");
  });
});

describe("Kiosk driver — PATCH через SA-JWT (fallback)", () => {
  it("(c) audit.userId = adminUser, не _system_", async () => {
    const { booking, session } = await createBookingAndIssueSession();
    const vehicles = await request(app)
      .get(`/api/warehouse/sessions/${session.id}/vehicles`)
      .set(AUTH_PIN());
    const bv = vehicles.body.vehicles[0];

    const res = await request(app)
      .patch(`/api/warehouse/sessions/${session.id}/vehicles/${bv.id}/driver`)
      .set(AUTH_SA())
      .send({ driverName: "Через JWT" });

    expect(res.status).toBe(200);

    const audit = await prisma.auditEntry.findFirst({
      where: { action: "BOOKING_VEHICLE_DRIVER_SET", entityId: booking.id },
      orderBy: { createdAt: "desc" },
    });
    expect(audit.userId).not.toBe("_system_");
    const sa = await prisma.adminUser.findUnique({ where: { username: "wd_sa" } });
    expect(audit.userId).toBe(sa.id);
  });
});

describe("Kiosk driver — edge cases", () => {
  it("(d) Idempotent: тот же payload — без новой audit-записи", async () => {
    const { booking, session } = await createBookingAndIssueSession();
    const vehicles = await request(app)
      .get(`/api/warehouse/sessions/${session.id}/vehicles`)
      .set(AUTH_PIN());
    const bv = vehicles.body.vehicles[0];

    await request(app)
      .patch(`/api/warehouse/sessions/${session.id}/vehicles/${bv.id}/driver`)
      .set(AUTH_PIN())
      .send({ driverName: "Идемпотент", driverPhone: "111" });

    const before = await prisma.auditEntry.count({
      where: { action: "BOOKING_VEHICLE_DRIVER_SET", entityId: booking.id },
    });

    const res = await request(app)
      .patch(`/api/warehouse/sessions/${session.id}/vehicles/${bv.id}/driver`)
      .set(AUTH_PIN())
      .send({ driverName: "Идемпотент", driverPhone: "111" });

    expect(res.status).toBe(200);
    const after = await prisma.auditEntry.count({
      where: { action: "BOOKING_VEHICLE_DRIVER_SET", entityId: booking.id },
    });
    expect(after).toBe(before);
  });

  it("(e) Машина другой брони → 404", async () => {
    const a = await createBookingAndIssueSession();
    const b = await createBookingAndIssueSession();
    const vehiclesB = await request(app)
      .get(`/api/warehouse/sessions/${b.session.id}/vehicles`)
      .set(AUTH_PIN());
    const vehicleOfB = vehiclesB.body.vehicles[0];

    const res = await request(app)
      .patch(`/api/warehouse/sessions/${a.session.id}/vehicles/${vehicleOfB.id}/driver`)
      .set(AUTH_PIN())
      .send({ driverName: "Чужой" });

    expect(res.status).toBe(404);
  });

  it("(f) Пустая строка после trim → null", async () => {
    const { session } = await createBookingAndIssueSession();
    const vehicles = await request(app)
      .get(`/api/warehouse/sessions/${session.id}/vehicles`)
      .set(AUTH_PIN());
    const bv = vehicles.body.vehicles[0];

    await request(app)
      .patch(`/api/warehouse/sessions/${session.id}/vehicles/${bv.id}/driver`)
      .set(AUTH_PIN())
      .send({ driverName: "Тест", driverPhone: "999" });

    const res = await request(app)
      .patch(`/api/warehouse/sessions/${session.id}/vehicles/${bv.id}/driver`)
      .set(AUTH_PIN())
      .send({ driverName: "   ", driverPhone: "" });

    expect(res.status).toBe(200);
    expect(res.body.vehicle.driverName).toBeNull();
    expect(res.body.vehicle.driverPhone).toBeNull();
  });
});
