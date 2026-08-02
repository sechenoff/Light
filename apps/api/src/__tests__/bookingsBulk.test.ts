/**
 * Интеграционные тесты группового действия POST /api/bookings/bulk
 * (мультивыбор на странице /bookings): approve / submit / cancel / archive.
 *
 * Главное свойство контракта, которое здесь фиксируется: пачка НЕ падает
 * целиком. Одна негодная бронь возвращается в `results` с кодом ошибки,
 * остальные выполняются.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-bookings-bulk.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-bulk";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-bulk";
process.env.JWT_SECRET = "test-jwt-secret-bulk-min16chars";

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
    data: { username: "bulk_sa", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  superAdminToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });

  const wh = await prisma.adminUser.create({
    data: { username: "bulk_wh", passwordHash: hash, role: "WAREHOUSE" },
  });
  warehouseToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });

  const tech = await prisma.adminUser.create({
    data: { username: "bulk_tech", passwordHash: hash, role: "TECHNICIAN" },
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

async function createBooking(status = "DRAFT", extra: Record<string, unknown> = {}) {
  const uid = `${Date.now()}_${++_counter}`;
  const client = await prisma.client.create({ data: { name: `ТК Пачка ${uid}` } });
  const equipment = await prisma.equipment.create({
    data: {
      importKey: `СВЕТ||ПАЧКА||${uid}||`,
      name: `Прожектор ${uid}`,
      category: "Свет",
      totalQuantity: 5,
      rentalRatePerShift: 1000,
    },
  });
  return prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: `Пачка ${uid}`,
      startDate: new Date("2026-05-01T10:00:00Z"),
      endDate: new Date("2026-05-03T10:00:00Z"),
      status,
      items: { create: [{ equipmentId: equipment.id, quantity: 2 }] },
      ...extra,
    },
  });
}

function post(ids: string[], action: string, auth: Record<string, string>) {
  return request(app).post("/api/bookings/bulk").set(auth).send({ ids, action });
}

describe("POST /api/bookings/bulk — согласование пачкой", () => {
  it("SUPER_ADMIN согласовывает несколько броней разом", async () => {
    const a = await createBooking("PENDING_APPROVAL");
    const b = await createBooking("PENDING_APPROVAL");

    const res = await post([a.id, b.id], "approve", AUTH_SA());

    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ total: 2, ok: 2, failed: 0 });
    expect(res.body.results.every((r: any) => r.ok && r.status === "CONFIRMED")).toBe(true);

    const after = await prisma.booking.findMany({ where: { id: { in: [a.id, b.id] } } });
    expect(after.map((x: any) => x.status).sort()).toEqual(["CONFIRMED", "CONFIRMED"]);
  });

  it("негодная бронь не роняет пачку: остальные согласованы, у неё код INVALID_BOOKING_STATE", async () => {
    const good = await createBooking("PENDING_APPROVAL");
    const wrongState = await createBooking("DRAFT");

    const res = await post([good.id, wrongState.id], "approve", AUTH_SA());

    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ total: 2, ok: 1, failed: 1 });
    const failed = res.body.results.find((r: any) => !r.ok);
    expect(failed.id).toBe(wrongState.id);
    expect(failed.code).toBe("INVALID_BOOKING_STATE");

    // Годная бронь реально подтверждена, несмотря на соседнюю ошибку.
    const g = await prisma.booking.findUnique({ where: { id: good.id } });
    expect(g.status).toBe("CONFIRMED");
  });

  it("WAREHOUSE не может согласовывать (approve — только SUPER_ADMIN)", async () => {
    const a = await createBooking("PENDING_APPROVAL");
    const res = await post([a.id], "approve", AUTH_WH());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN_BY_ROLE");
  });

  it("каждая согласованная бронь пишет аудит BOOKING_APPROVED", async () => {
    const a = await createBooking("PENDING_APPROVAL");
    await post([a.id], "approve", AUTH_SA());
    const audit = await prisma.auditEntry.findMany({
      where: { entityType: "Booking", entityId: a.id, action: "BOOKING_APPROVED" },
    });
    expect(audit).toHaveLength(1);
  });
});

describe("POST /api/bookings/bulk — отправка на согласование пачкой", () => {
  it("WAREHOUSE отправляет черновики на согласование", async () => {
    const a = await createBooking("DRAFT");
    const b = await createBooking("DRAFT");

    const res = await post([a.id, b.id], "submit", AUTH_WH());

    expect(res.status).toBe(200);
    expect(res.body.counts.ok).toBe(2);
    const after = await prisma.booking.findMany({ where: { id: { in: [a.id, b.id] } } });
    expect(after.every((x: any) => x.status === "PENDING_APPROVAL")).toBe(true);
  });

  it("TECHNICIAN получает 403 на любое групповое действие", async () => {
    const a = await createBooking("DRAFT");
    const res = await post([a.id], "submit", AUTH_TECH());
    expect(res.status).toBe(403);
  });
});

describe("POST /api/bookings/bulk — отмена пачкой", () => {
  it("неоплаченные брони отменяются", async () => {
    const a = await createBooking("DRAFT");
    const b = await createBooking("CONFIRMED");

    const res = await post([a.id, b.id], "cancel", AUTH_SA());

    expect(res.status).toBe(200);
    expect(res.body.counts.ok).toBe(2);
    const after = await prisma.booking.findMany({ where: { id: { in: [a.id, b.id] } } });
    expect(after.every((x: any) => x.status === "CANCELLED")).toBe(true);
  });

  it("оплаченная бронь пачкой не отменяется — код BULK_CANCEL_PAID", async () => {
    const paid = await createBooking("CONFIRMED", { amountPaid: 5000 });

    const res = await post([paid.id], "cancel", AUTH_SA());

    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ total: 1, ok: 0, failed: 1 });
    expect(res.body.results[0].code).toBe("BULK_CANCEL_PAID");

    const after = await prisma.booking.findUnique({ where: { id: paid.id } });
    expect(after.status).toBe("CONFIRMED");
  });

  it("выданную бронь пачкой не отменить (недопустимый переход)", async () => {
    const issued = await createBooking("ISSUED");
    const res = await post([issued.id], "cancel", AUTH_SA());
    expect(res.body.counts.failed).toBe(1);
    expect(res.body.results[0].code).toBe("INVALID_BOOKING_STATE");
  });
});

describe("POST /api/bookings/bulk — архивация пачкой", () => {
  it("SUPER_ADMIN архивирует несколько броней", async () => {
    const a = await createBooking("DRAFT");
    const b = await createBooking("RETURNED");

    const res = await post([a.id, b.id], "archive", AUTH_SA());

    expect(res.status).toBe(200);
    expect(res.body.counts.ok).toBe(2);
    const after = await prisma.booking.findMany({ where: { id: { in: [a.id, b.id] } } });
    expect(after.every((x: any) => x.deletedAt !== null)).toBe(true);
  });

  it("повторная архивация той же брони — BOOKING_ALREADY_ARCHIVED, не 500", async () => {
    const a = await createBooking("DRAFT");
    await post([a.id], "archive", AUTH_SA());
    const res = await post([a.id], "archive", AUTH_SA());
    expect(res.status).toBe(200);
    expect(res.body.results[0].code).toBe("BOOKING_ALREADY_ARCHIVED");
  });

  it("WAREHOUSE не может архивировать", async () => {
    const a = await createBooking("DRAFT");
    const res = await post([a.id], "archive", AUTH_WH());
    expect(res.status).toBe(403);
  });

  it("архивация пишет аудит BOOKING_ARCHIVED", async () => {
    const a = await createBooking("DRAFT");
    await post([a.id], "archive", AUTH_SA());
    const audit = await prisma.auditEntry.findMany({
      where: { entityType: "Booking", entityId: a.id, action: "BOOKING_ARCHIVED" },
    });
    expect(audit).toHaveLength(1);
  });
});

describe("POST /api/bookings/bulk — валидация запроса", () => {
  it("пустой список → 400", async () => {
    const res = await post([], "approve", AUTH_SA());
    expect(res.status).toBe(400);
  });

  it("неизвестное действие → 400", async () => {
    const a = await createBooking("DRAFT");
    const res = await post([a.id], "explode", AUTH_SA());
    expect(res.status).toBe(400);
  });

  it("больше лимита пачки → 400", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `id_${i}`);
    const res = await post(ids, "archive", AUTH_SA());
    expect(res.status).toBe(400);
  });

  it("дубли id в выборке схлопываются (двойной клик не удваивает работу)", async () => {
    const a = await createBooking("PENDING_APPROVAL");
    const res = await post([a.id, a.id], "approve", AUTH_SA());
    expect(res.body.counts.total).toBe(1);
    expect(res.body.counts.ok).toBe(1);
  });

  it("несуществующая бронь → BOOKING_NOT_FOUND в результатах, не 404 на весь запрос", async () => {
    const a = await createBooking("PENDING_APPROVAL");
    const res = await post([a.id, "cmnonexistent0000000000"], "approve", AUTH_SA());
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ total: 2, ok: 1, failed: 1 });
    expect(res.body.results.find((r: any) => !r.ok).code).toBe("BOOKING_NOT_FOUND");
  });

  it("архивированная бронь исключается из не-архивных действий", async () => {
    const a = await createBooking("PENDING_APPROVAL");
    await prisma.booking.update({ where: { id: a.id }, data: { deletedAt: new Date() } });
    const res = await post([a.id], "approve", AUTH_SA());
    expect(res.body.results[0].code).toBe("BOOKING_ARCHIVED");
  });
});
