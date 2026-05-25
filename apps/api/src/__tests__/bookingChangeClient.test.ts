/**
 * Интеграционные тесты: POST /api/bookings/:id/change-client
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-change-client.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1,openclaw-test-bot";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-change-client";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-cc";
process.env.JWT_SECRET = "test-jwt-secret-change-client-x16";

let app: Express;
let prisma: any;
let superAdminToken: string;
let warehouseToken: string;
let technicianToken: string;

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
    data: { username: "cc_sa", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  superAdminToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });

  const wh = await prisma.adminUser.create({
    data: { username: "cc_wh", passwordHash: hash, role: "WAREHOUSE" },
  });
  warehouseToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });

  const tech = await prisma.adminUser.create({
    data: { username: "cc_tech", passwordHash: hash, role: "TECHNICIAN" },
  });
  technicianToken = signSession({ userId: tech.id, username: tech.username, role: "TECHNICIAN" });
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
function AUTH_TECH() { return { "X-API-Key": "test-key-1", Authorization: `Bearer ${technicianToken}` }; }

let _counter = 0;

async function createBookingWithClient(status: string = "DRAFT") {
  const uid = `${Date.now()}_${++_counter}`;
  const clientA = await prisma.client.create({ data: { name: `Клиент А ${uid}` } });
  const clientB = await prisma.client.create({ data: { name: `Клиент Б ${uid}` } });
  const equipment = await prisma.equipment.create({
    data: {
      importKey: `СВЕТ||ТЕСТ||CC||${uid}||`,
      name: `Прожектор CC ${uid}`,
      category: "Свет",
      totalQuantity: 5,
      rentalRatePerShift: 1000,
    },
  });
  const booking = await prisma.booking.create({
    data: {
      clientId: clientA.id,
      projectName: "Тест Смена Клиента",
      startDate: new Date("2026-06-01T10:00:00Z"),
      endDate: new Date("2026-06-03T10:00:00Z"),
      status,
      items: {
        create: [{ equipmentId: equipment.id, quantity: 1 }],
      },
    },
  });
  return { booking, clientA, clientB };
}

describe("POST /api/bookings/:id/change-client", () => {
  it("SA переназначает бронь на нового клиента + создаёт AuditEntry", async () => {
    const { booking, clientA, clientB } = await createBookingWithClient();

    const res = await request(app)
      .post(`/api/bookings/${booking.id}/change-client`)
      .set(AUTH_SA())
      .send({ clientId: clientB.id });

    expect(res.status).toBe(200);
    expect(res.body.booking.clientId ?? res.body.booking.client?.id).toBe(clientB.id);

    // Проверяем AuditEntry
    const audit = await prisma.auditEntry.findFirst({
      where: { entityId: booking.id, action: "BOOKING_CLIENT_CHANGED" },
    });
    expect(audit).not.toBeNull();
    const before = JSON.parse(audit.before);
    const after = JSON.parse(audit.after);
    expect(before.clientId).toBe(clientA.id);
    expect(after.clientId).toBe(clientB.id);
    expect(after.clientName).toBe(clientB.name);
  });

  it("WAREHOUSE → 403 FORBIDDEN_BY_ROLE", async () => {
    const { booking, clientB } = await createBookingWithClient();

    const res = await request(app)
      .post(`/api/bookings/${booking.id}/change-client`)
      .set(AUTH_WH())
      .send({ clientId: clientB.id });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN_BY_ROLE");
  });

  it("TECHNICIAN → 403 FORBIDDEN_BY_ROLE", async () => {
    const { booking, clientB } = await createBookingWithClient();

    const res = await request(app)
      .post(`/api/bookings/${booking.id}/change-client`)
      .set(AUTH_TECH())
      .send({ clientId: clientB.id });

    expect(res.status).toBe(403);
  });

  it("несуществующий newClientId → 400 INVALID_CLIENT_ID", async () => {
    const { booking } = await createBookingWithClient();

    const res = await request(app)
      .post(`/api/bookings/${booking.id}/change-client`)
      .set(AUTH_SA())
      .send({ clientId: "non-existent-client-id" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_CLIENT_ID");
  });

  it("тот же clientId → 400 NO_CHANGE", async () => {
    const { booking, clientA } = await createBookingWithClient();

    const res = await request(app)
      .post(`/api/bookings/${booking.id}/change-client`)
      .set(AUTH_SA())
      .send({ clientId: clientA.id });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("NO_CHANGE");
  });

  it("бронь в PENDING_APPROVAL → 409 BOOKING_EDIT_FORBIDDEN", async () => {
    const { booking, clientB } = await createBookingWithClient("PENDING_APPROVAL");

    const res = await request(app)
      .post(`/api/bookings/${booking.id}/change-client`)
      .set(AUTH_SA())
      .send({ clientId: clientB.id });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("BOOKING_EDIT_FORBIDDEN");
  });

  it("несуществующий bookingId → 404 BOOKING_NOT_FOUND", async () => {
    const { clientB } = await createBookingWithClient();

    const res = await request(app)
      .post("/api/bookings/non-existent-booking-id/change-client")
      .set(AUTH_SA())
      .send({ clientId: clientB.id });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("BOOKING_NOT_FOUND");
  });
});
