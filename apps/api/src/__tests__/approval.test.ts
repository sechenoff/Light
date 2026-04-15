/**
 * Интеграционные тесты approval workflow: submit-for-approval / approve / reject.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-approval.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-approval";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-approval";
process.env.JWT_SECRET = "test-jwt-secret-approval-min16chars";

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
    data: { username: "appr_sa", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  superAdminToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });

  const wh = await prisma.adminUser.create({
    data: { username: "appr_wh", passwordHash: hash, role: "WAREHOUSE" },
  });
  warehouseToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });

  const tech = await prisma.adminUser.create({
    data: { username: "appr_tech", passwordHash: hash, role: "TECHNICIAN" },
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

let _bookingCounter = 0;

async function createDraftBooking() {
  const uid = `${Date.now()}_${++_bookingCounter}`;
  const client = await prisma.client.create({ data: { name: `ТК Тест ${uid}` } });
  const equipment = await prisma.equipment.create({
    data: {
      importKey: `СВЕТ||ТЕСТ||${uid}||`,
      name: `Прожектор ${uid}`,
      category: "Свет",
      totalQuantity: 5,
      rentalRatePerShift: 1000,
    },
  });
  const booking = await prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: "Тестовый проект",
      startDate: new Date("2026-05-01T10:00:00Z"),
      endDate: new Date("2026-05-03T10:00:00Z"),
      status: "DRAFT",
      items: {
        create: [{ equipmentId: equipment.id, quantity: 2 }],
      },
    },
  });
  return booking;
}

describe("POST /api/bookings/:id/submit-for-approval", () => {
  it("WAREHOUSE переводит DRAFT → PENDING_APPROVAL и очищает rejectionReason", async () => {
    const booking = await createDraftBooking();
    // Предварительно выставим rejectionReason, чтобы проверить очистку
    await prisma.booking.update({ where: { id: booking.id }, data: { rejectionReason: "старая причина" } });

    const res = await request(app)
      .post(`/api/bookings/${booking.id}/submit-for-approval`)
      .set(AUTH_WH())
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.booking.status).toBe("PENDING_APPROVAL");
    expect(res.body.booking.rejectionReason).toBeNull();

    const audit = await prisma.auditEntry.findMany({
      where: { entityType: "Booking", entityId: booking.id, action: "BOOKING_SUBMITTED" },
    });
    expect(audit).toHaveLength(1);
  });

  it("SUPER_ADMIN тоже может отправить на согласование", async () => {
    const booking = await createDraftBooking();
    const res = await request(app)
      .post(`/api/bookings/${booking.id}/submit-for-approval`)
      .set(AUTH_SA())
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.booking.status).toBe("PENDING_APPROVAL");
  });

  it("TECHNICIAN получает 403", async () => {
    const booking = await createDraftBooking();
    const res = await request(app)
      .post(`/api/bookings/${booking.id}/submit-for-approval`)
      .set(AUTH_TECH())
      .send({});
    expect(res.status).toBe(403);
  });

  it("не-DRAFT бронь → 409", async () => {
    const booking = await createDraftBooking();
    await prisma.booking.update({ where: { id: booking.id }, data: { status: "CONFIRMED" } });
    const res = await request(app)
      .post(`/api/bookings/${booking.id}/submit-for-approval`)
      .set(AUTH_WH())
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.details).toBe("INVALID_BOOKING_STATE");
  });

  it("несуществующая бронь → 404", async () => {
    const res = await request(app)
      .post(`/api/bookings/does-not-exist/submit-for-approval`)
      .set(AUTH_WH())
      .send({});
    expect(res.status).toBe(404);
  });
});

describe("POST /api/bookings/:id/approve", () => {
  it("SUPER_ADMIN переводит PENDING_APPROVAL → CONFIRMED", async () => {
    const booking = await createDraftBooking();
    await prisma.booking.update({ where: { id: booking.id }, data: { status: "PENDING_APPROVAL" } });

    const res = await request(app)
      .post(`/api/bookings/${booking.id}/approve`)
      .set(AUTH_SA())
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.booking.status).toBe("CONFIRMED");

    const fresh = await prisma.booking.findUnique({ where: { id: booking.id } });
    expect(fresh.confirmedAt).not.toBeNull();

    const audit = await prisma.auditEntry.findMany({
      where: { entityType: "Booking", entityId: booking.id, action: "BOOKING_APPROVED" },
    });
    expect(audit).toHaveLength(1);
  });

  it("WAREHOUSE получает 403", async () => {
    const booking = await createDraftBooking();
    await prisma.booking.update({ where: { id: booking.id }, data: { status: "PENDING_APPROVAL" } });
    const res = await request(app)
      .post(`/api/bookings/${booking.id}/approve`)
      .set(AUTH_WH())
      .send({});
    expect(res.status).toBe(403);
  });

  it("не-PENDING_APPROVAL → 409", async () => {
    const booking = await createDraftBooking(); // DRAFT
    const res = await request(app)
      .post(`/api/bookings/${booking.id}/approve`)
      .set(AUTH_SA())
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.details).toBe("INVALID_BOOKING_STATE");
  });
});

describe("POST /api/bookings/:id/reject", () => {
  it("SUPER_ADMIN отклоняет с причиной: PENDING_APPROVAL → DRAFT + rejectionReason", async () => {
    const booking = await createDraftBooking();
    await prisma.booking.update({ where: { id: booking.id }, data: { status: "PENDING_APPROVAL" } });

    const res = await request(app)
      .post(`/api/bookings/${booking.id}/reject`)
      .set(AUTH_SA())
      .send({ reason: "Слишком высокая скидка, пересчитайте" });

    expect(res.status).toBe(200);
    expect(res.body.booking.status).toBe("DRAFT");
    expect(res.body.booking.rejectionReason).toBe("Слишком высокая скидка, пересчитайте");

    const audit = await prisma.auditEntry.findMany({
      where: { entityType: "Booking", entityId: booking.id, action: "BOOKING_REJECTED" },
    });
    expect(audit).toHaveLength(1);
  });

  it("пустая причина → 400", async () => {
    const booking = await createDraftBooking();
    await prisma.booking.update({ where: { id: booking.id }, data: { status: "PENDING_APPROVAL" } });
    const res = await request(app)
      .post(`/api/bookings/${booking.id}/reject`)
      .set(AUTH_SA())
      .send({ reason: "" });
    expect(res.status).toBe(400);
  });

  it("отсутствие reason в теле → 400", async () => {
    const booking = await createDraftBooking();
    await prisma.booking.update({ where: { id: booking.id }, data: { status: "PENDING_APPROVAL" } });
    const res = await request(app)
      .post(`/api/bookings/${booking.id}/reject`)
      .set(AUTH_SA())
      .send({});
    expect(res.status).toBe(400);
  });

  it("WAREHOUSE получает 403", async () => {
    const booking = await createDraftBooking();
    await prisma.booking.update({ where: { id: booking.id }, data: { status: "PENDING_APPROVAL" } });
    const res = await request(app)
      .post(`/api/bookings/${booking.id}/reject`)
      .set(AUTH_WH())
      .send({ reason: "test" });
    expect(res.status).toBe(403);
  });

  it("не-PENDING_APPROVAL → 409", async () => {
    const booking = await createDraftBooking(); // DRAFT
    const res = await request(app)
      .post(`/api/bookings/${booking.id}/reject`)
      .set(AUTH_SA())
      .send({ reason: "test" });
    expect(res.status).toBe(409);
    expect(res.body.details).toBe("INVALID_BOOKING_STATE");
  });
});

describe("PATCH /api/bookings/:id — edit-prevention для PENDING_APPROVAL", () => {
  it("PATCH по PENDING_APPROVAL возвращает 409", async () => {
    const booking = await createDraftBooking();
    await prisma.booking.update({ where: { id: booking.id }, data: { status: "PENDING_APPROVAL" } });

    const res = await request(app)
      .patch(`/api/bookings/${booking.id}`)
      .set(AUTH_WH())
      .send({ projectName: "Новое имя" });

    expect(res.status).toBe(409);
  });

  it("PATCH по DRAFT по-прежнему разрешён", async () => {
    const booking = await createDraftBooking();
    const res = await request(app)
      .patch(`/api/bookings/${booking.id}`)
      .set(AUTH_WH())
      .send({ projectName: "Обновлённое имя" });
    expect(res.status).toBe(200);
    expect(res.body.booking.projectName).toBe("Обновлённое имя");
  });
});

describe("GET /api/bookings?status=PENDING_APPROVAL", () => {
  it("фильтрация по PENDING_APPROVAL возвращает только брони на согласовании", async () => {
    const b1 = await createDraftBooking(); // DRAFT
    const b2 = await createDraftBooking();
    await prisma.booking.update({ where: { id: b2.id }, data: { status: "PENDING_APPROVAL" } });
    const b3 = await createDraftBooking();
    await prisma.booking.update({ where: { id: b3.id }, data: { status: "PENDING_APPROVAL" } });

    const res = await request(app)
      .get(`/api/bookings?status=PENDING_APPROVAL&limit=100`)
      .set(AUTH_WH());

    expect(res.status).toBe(200);
    const ids = res.body.bookings.map((b: any) => b.id);
    expect(ids).toContain(b2.id);
    expect(ids).toContain(b3.id);
    expect(ids).not.toContain(b1.id);
    for (const b of res.body.bookings) {
      expect(b.status).toBe("PENDING_APPROVAL");
    }
  });
});
