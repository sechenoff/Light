/**
 * Интеграционные тесты PATCH /api/bookings/:id/vehicles/:bookingVehicleId/driver:
 *  (a) WAREHOUSE может выставить ФИО + телефон водителя.
 *  (b) После повторного PATCH с новыми значениями — оба поля обновляются.
 *  (c) `null` очищает поле; `undefined` (не передано) — не трогает другое.
 *  (d) Пустая строка трактуется как null (пользователь стёр поле).
 *  (e) Idempotent: тот же payload → не пишет лишний AuditEntry.
 *  (f) Аудит-запись BOOKING_VEHICLE_DRIVER_SET создаётся при изменении.
 *  (g) TECHNICIAN → 403; неверная booking ↔ vehicle связь → 404.
 *  (h) Пустой body → 400.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-bv-driver.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-bv-driver";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-bv-driver";
process.env.JWT_SECRET = "test-jwt-secret-bv-driver-min16chars";

let app: Express;
let prisma: any;
let superAdminToken: string;
let warehouseToken: string;
let technicianToken: string;
let vehicleId: string;
let secondVehicleId: string;
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
    data: { username: "bvd_sa", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  superAdminToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });

  const wh = await prisma.adminUser.create({
    data: { username: "bvd_wh", passwordHash: hash, role: "WAREHOUSE" },
  });
  warehouseToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });

  const tech = await prisma.adminUser.create({
    data: { username: "bvd_tech", passwordHash: hash, role: "TECHNICIAN" },
  });
  technicianToken = signSession({ userId: tech.id, username: tech.username, role: "TECHNICIAN" });

  const sprinter = await prisma.vehicle.create({
    data: {
      slug: "sprinter",
      name: "Mercedes Sprinter",
      shiftPriceRub: "20000",
      hasGeneratorOption: false,
      displayOrder: 1,
      shiftHours: 12,
      overtimePercent: "10",
      active: true,
    },
  });
  vehicleId = sprinter.id;

  const ford = await prisma.vehicle.create({
    data: {
      slug: "ford-bvd",
      name: "Ford BVD",
      shiftPriceRub: "18000",
      hasGeneratorOption: false,
      displayOrder: 2,
      shiftHours: 12,
      overtimePercent: "10",
      active: true,
    },
  });
  secondVehicleId = ford.id;

  const eq = await prisma.equipment.create({
    data: {
      importKey: "LED||ПАНЕЛЬ BVD||GENERIC||LED-BVD",
      name: "Панель BVD",
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
const AUTH_TECH = () => ({ "X-API-Key": "test-key-1", Authorization: `Bearer ${technicianToken}` });

async function createBookingWithTwoVehicles() {
  const res = await request(app)
    .post("/api/bookings/draft")
    .set(AUTH_WH())
    .send({
      client: { name: "Тест-Клиент Driver" },
      projectName: "Проект Driver",
      startDate: "2026-07-10T09:00:00.000Z",
      endDate: "2026-07-11T09:00:00.000Z",
      items: [{ equipmentId, quantity: 1 }],
      transport: [
        { vehicleId, withGenerator: false, shiftHours: 12, skipOvertime: false, kmOutsideMkad: 0, ttkEntry: false },
        { vehicleId: secondVehicleId, withGenerator: false, shiftHours: 12, skipOvertime: false, kmOutsideMkad: 0, ttkEntry: false },
      ],
    });
  expect([200, 201]).toContain(res.status);
  return res.body.booking;
}

describe("PATCH /api/bookings/:id/vehicles/:bookingVehicleId/driver", () => {
  it("(a) WAREHOUSE может выставить ФИО и телефон водителя", async () => {
    const booking = await createBookingWithTwoVehicles();
    const bv = booking.vehicles[0];

    const res = await request(app)
      .patch(`/api/bookings/${booking.id}/vehicles/${bv.id}/driver`)
      .set(AUTH_WH())
      .send({ driverName: "Иван Водитель", driverPhone: "+7 (916) 555-22-11" });

    expect(res.status).toBe(200);
    expect(res.body.vehicle.driverName).toBe("Иван Водитель");
    expect(res.body.vehicle.driverPhone).toBe("+7 (916) 555-22-11");

    const persisted = await prisma.bookingVehicle.findUnique({ where: { id: bv.id } });
    expect(persisted.driverName).toBe("Иван Водитель");
    expect(persisted.driverPhone).toBe("+7 (916) 555-22-11");
  });

  it("(b) повторный PATCH обновляет оба поля", async () => {
    const booking = await createBookingWithTwoVehicles();
    const bv = booking.vehicles[0];

    await request(app)
      .patch(`/api/bookings/${booking.id}/vehicles/${bv.id}/driver`)
      .set(AUTH_SA())
      .send({ driverName: "Первый", driverPhone: "111" });

    const res = await request(app)
      .patch(`/api/bookings/${booking.id}/vehicles/${bv.id}/driver`)
      .set(AUTH_SA())
      .send({ driverName: "Второй", driverPhone: "222" });

    expect(res.status).toBe(200);
    expect(res.body.vehicle.driverName).toBe("Второй");
    expect(res.body.vehicle.driverPhone).toBe("222");
  });

  it("(c) null очищает поле; не переданное (undefined) поле не трогает другое", async () => {
    const booking = await createBookingWithTwoVehicles();
    const bv = booking.vehicles[0];

    await request(app)
      .patch(`/api/bookings/${booking.id}/vehicles/${bv.id}/driver`)
      .set(AUTH_SA())
      .send({ driverName: "Алексей", driverPhone: "+7-916-000-00-00" });

    const cleared = await request(app)
      .patch(`/api/bookings/${booking.id}/vehicles/${bv.id}/driver`)
      .set(AUTH_SA())
      .send({ driverName: null });

    expect(cleared.status).toBe(200);
    expect(cleared.body.vehicle.driverName).toBeNull();
    // driverPhone остался прежним — undefined в payload его не задел
    expect(cleared.body.vehicle.driverPhone).toBe("+7-916-000-00-00");
  });

  it("(d) пустая строка после trim трактуется как null", async () => {
    const booking = await createBookingWithTwoVehicles();
    const bv = booking.vehicles[0];

    await request(app)
      .patch(`/api/bookings/${booking.id}/vehicles/${bv.id}/driver`)
      .set(AUTH_SA())
      .send({ driverName: "Тест", driverPhone: "555" });

    const res = await request(app)
      .patch(`/api/bookings/${booking.id}/vehicles/${bv.id}/driver`)
      .set(AUTH_SA())
      .send({ driverName: "   ", driverPhone: "" });

    expect(res.status).toBe(200);
    expect(res.body.vehicle.driverName).toBeNull();
    expect(res.body.vehicle.driverPhone).toBeNull();
  });

  it("(e) Idempotent: тот же payload — не плодит audit-записи", async () => {
    const booking = await createBookingWithTwoVehicles();
    const bv = booking.vehicles[0];

    await request(app)
      .patch(`/api/bookings/${booking.id}/vehicles/${bv.id}/driver`)
      .set(AUTH_SA())
      .send({ driverName: "Идемпотент", driverPhone: "777" });

    const before = await prisma.auditEntry.count({
      where: { action: "BOOKING_VEHICLE_DRIVER_SET", entityId: booking.id },
    });

    // Повторный одинаковый payload
    const res = await request(app)
      .patch(`/api/bookings/${booking.id}/vehicles/${bv.id}/driver`)
      .set(AUTH_SA())
      .send({ driverName: "Идемпотент", driverPhone: "777" });

    expect(res.status).toBe(200);

    const after = await prisma.auditEntry.count({
      where: { action: "BOOKING_VEHICLE_DRIVER_SET", entityId: booking.id },
    });
    expect(after).toBe(before);
  });

  it("(f) Аудит BOOKING_VEHICLE_DRIVER_SET создаётся при изменении", async () => {
    const booking = await createBookingWithTwoVehicles();
    const bv = booking.vehicles[0];

    await request(app)
      .patch(`/api/bookings/${booking.id}/vehicles/${bv.id}/driver`)
      .set(AUTH_SA())
      .send({ driverName: "Аудитор", driverPhone: "999" });

    const entries = await prisma.auditEntry.findMany({
      where: { action: "BOOKING_VEHICLE_DRIVER_SET", entityId: booking.id },
      orderBy: { createdAt: "desc" },
    });
    expect(entries.length).toBe(1);
    expect(entries[0].entityType).toBe("Booking");
    const after = JSON.parse(entries[0].after);
    expect(after.driverName).toBe("Аудитор");
    expect(after.driverPhone).toBe("999");
  });

  it("(g) TECHNICIAN → 403", async () => {
    const booking = await createBookingWithTwoVehicles();
    const bv = booking.vehicles[0];

    const res = await request(app)
      .patch(`/api/bookings/${booking.id}/vehicles/${bv.id}/driver`)
      .set(AUTH_TECH())
      .send({ driverName: "Хакер" });

    expect(res.status).toBe(403);
  });

  it("(g2) Машина другой брони → 404", async () => {
    const a = await createBookingWithTwoVehicles();
    const b = await createBookingWithTwoVehicles();
    const vehicleOfB = b.vehicles[0];

    const res = await request(app)
      .patch(`/api/bookings/${a.id}/vehicles/${vehicleOfB.id}/driver`)
      .set(AUTH_SA())
      .send({ driverName: "Чужой" });

    expect(res.status).toBe(404);
  });

  it("(h) Пустой body — 400", async () => {
    const booking = await createBookingWithTwoVehicles();
    const bv = booking.vehicles[0];

    const res = await request(app)
      .patch(`/api/bookings/${booking.id}/vehicles/${bv.id}/driver`)
      .set(AUTH_SA())
      .send({});

    expect(res.status).toBe(400);
  });
});
