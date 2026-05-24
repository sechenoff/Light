/**
 * Интеграционный тест: обязательный ввод пробега на возврате брони с
 * машинами. Покрывает критический happy path + ключевые ошибки контракта.
 *
 * Сценарии:
 *  (a) POST /complete без vehicleMileages, но в брони есть BookingVehicle
 *      → 400 VEHICLE_MILEAGE_REQUIRED, details.missing[] содержит vehicleId+name.
 *  (b) POST /complete с пробегом < currentMileage → 409 MILEAGE_DECREASE.
 *  (c) POST /complete с лишним vehicleId (не в брони) → 400 VEHICLE_NOT_IN_BOOKING.
 *  (d) Happy path: complete с валидным пробегом записывает VehicleMileageLog
 *      (source=RETURN, bookingId), обновляет Vehicle.currentMileage и
 *      завершает сессию (бронь → RETURNED).
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-wh-vmileage.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-wh-vmileage";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-wh-vmileage-min16chars";
process.env.JWT_SECRET = "test-jwt-secret-wh-vmileage-min16chars";

let app: Express;
let prisma: any;
let superAdminToken: string;
let warehouseToken: string;
let pinAuthToken: string;
let vehicleId: string;
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
  const { hashPin } = await import("../services/warehouseAuth");
  const hash = await hashPassword("test-pass-123");

  await prisma.adminUser.upsert({
    where: { id: "_system_" },
    update: {},
    create: { id: "_system_", username: "_system_", passwordHash: hash, role: "SUPER_ADMIN" },
  });

  const sa = await prisma.adminUser.create({
    data: { username: "vm_sa", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  superAdminToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });

  const wh = await prisma.adminUser.create({
    data: { username: "vm_wh", passwordHash: hash, role: "WAREHOUSE" },
  });
  warehouseToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });

  const pinHash = await hashPin("4242");
  await prisma.warehousePin.create({
    data: { name: "Сидор Кладовщик", pinHash, isActive: true },
  });

  const authRes = await request(app)
    .post("/api/warehouse/auth")
    .set({ "X-API-Key": "test-key-1" })
    .send({ name: "Сидор Кладовщик", pin: "4242" });
  expect(authRes.status).toBe(200);
  pinAuthToken = authRes.body.token;

  const sprinter = await prisma.vehicle.create({
    data: {
      slug: "sprinter-vm",
      name: "Sprinter VM",
      shiftPriceRub: "20000",
      hasGeneratorOption: false,
      displayOrder: 1,
      shiftHours: 12,
      overtimePercent: "10",
      active: true,
      currentMileage: 50_000,
    },
  });
  vehicleId = sprinter.id;

  const eq = await prisma.equipment.create({
    data: {
      importKey: "LED||ПАНЕЛЬ VM||GENERIC||LED-VM",
      name: "Панель VM",
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
function nextDates() {
  bookingSeq += 1;
  const day = 10 + bookingSeq;
  return {
    startDate: `2026-08-${String(day).padStart(2, "0")}T09:00:00.000Z`,
    endDate: `2026-08-${String(day + 1).padStart(2, "0")}T09:00:00.000Z`,
  };
}

/**
 * Создаёт DRAFT→approve→ISSUE-сессию→ISSUE complete→RETURN-сессию.
 * Возвращает id готовой к /complete RETURN-сессии и id брони.
 */
async function setupReturnSession(): Promise<{ bookingId: string; sessionId: string }> {
  const { startDate, endDate } = nextDates();
  const draftRes = await request(app)
    .post("/api/bookings/draft")
    .set(AUTH_WH())
    .send({
      client: { name: "Тест-Клиент VM" },
      projectName: "Проект VM",
      startDate,
      endDate,
      items: [{ equipmentId, quantity: 1 }],
      transport: [
        {
          vehicleId,
          withGenerator: false,
          shiftHours: 12,
          skipOvertime: false,
          kmOutsideMkad: 0,
          ttkEntry: false,
        },
      ],
    });
  expect([200, 201]).toContain(draftRes.status);
  const booking = draftRes.body.booking;

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

  // ISSUE session + complete (COUNT, пустой scan) → бронь становится ISSUED.
  const issueSession = await request(app)
    .post("/api/warehouse/sessions")
    .set(AUTH_PIN())
    .send({ bookingId: booking.id, operation: "ISSUE" });
  expect(issueSession.status).toBe(201);
  const issueComplete = await request(app)
    .post(`/api/warehouse/sessions/${issueSession.body.session.id}/complete`)
    .set(AUTH_PIN())
    .send({});
  expect(issueComplete.status).toBe(200);

  // RETURN session — НЕ завершаем, отдадим вызывающему.
  const returnSession = await request(app)
    .post("/api/warehouse/sessions")
    .set(AUTH_PIN())
    .send({ bookingId: booking.id, operation: "RETURN" });
  expect(returnSession.status).toBe(201);
  return {
    bookingId: booking.id,
    sessionId: returnSession.body.session.id,
  };
}

describe("Vehicle mileage on RETURN — обязательный ввод", () => {
  it("(a) пустой vehicleMileages при наличии BookingVehicle → 400 VEHICLE_MILEAGE_REQUIRED", async () => {
    const { sessionId } = await setupReturnSession();
    const res = await request(app)
      .post(`/api/warehouse/sessions/${sessionId}/complete`)
      .set(AUTH_PIN())
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VEHICLE_MILEAGE_REQUIRED");
    expect(Array.isArray(res.body.details?.missing)).toBe(true);
    expect(res.body.details.missing.length).toBeGreaterThan(0);
    expect(res.body.details.missing[0]).toMatchObject({
      vehicleId,
      name: "Sprinter VM",
    });
  });

  it("(b) mileage < currentMileage → 409 MILEAGE_DECREASE", async () => {
    // currentMileage сейчас 50_000 (или больше после предыдущих тестов).
    const v = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
    const tooLow = v.currentMileage - 1;
    const { sessionId } = await setupReturnSession();
    const res = await request(app)
      .post(`/api/warehouse/sessions/${sessionId}/complete`)
      .set(AUTH_PIN())
      .send({ vehicleMileages: [{ vehicleId, mileage: tooLow }] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("MILEAGE_DECREASE");
  });

  it("(c) лишний vehicleId (не в брони) → 400 VEHICLE_NOT_IN_BOOKING", async () => {
    const { sessionId } = await setupReturnSession();
    const res = await request(app)
      .post(`/api/warehouse/sessions/${sessionId}/complete`)
      .set(AUTH_PIN())
      .send({
        vehicleMileages: [
          { vehicleId, mileage: 99_999 },
          { vehicleId: "vehicle-does-not-exist", mileage: 100_000 },
        ],
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VEHICLE_NOT_IN_BOOKING");
  });

  it("(d) happy path: complete с валидным пробегом → лог + currentMileage обновлён + бронь RETURNED", async () => {
    const before = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
    const newMileage = before.currentMileage + 120;
    const { bookingId, sessionId } = await setupReturnSession();
    const res = await request(app)
      .post(`/api/warehouse/sessions/${sessionId}/complete`)
      .set(AUTH_PIN())
      .send({ vehicleMileages: [{ vehicleId, mileage: newMileage }] });
    expect(res.status).toBe(200);

    // Vehicle.currentMileage обновлён
    const after = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
    expect(after.currentMileage).toBe(newMileage);

    // VehicleMileageLog создан, source=RETURN, bookingId привязан, recordedBy = имя PIN-кладовщика
    const logs = await prisma.vehicleMileageLog.findMany({
      where: { vehicleId, bookingId },
      orderBy: { recordedAt: "desc" },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].mileage).toBe(newMileage);
    expect(logs[0].source).toBe("RETURN");
    expect(logs[0].recordedBy).toBe("Сидор Кладовщик");

    // Бронь перешла в RETURNED
    const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
    expect(booking?.status).toBe("RETURNED");
  });
});
