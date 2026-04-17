/**
 * Интеграционные тесты POST /api/finance/import-legacy-bookings
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-legacy-import.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-legacy-import";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-legacy-import";
process.env.JWT_SECRET = "test-jwt-secret-legacy-import-min16chars";

let app: Express;
let prisma: any;
let superAdminToken: string;
let warehouseToken: string;
let technicianToken: string;
let superAdminId: string;

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
    data: { username: "legacy_sa", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  superAdminId = sa.id;
  superAdminToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });

  const wh = await prisma.adminUser.create({
    data: { username: "legacy_wh", passwordHash: hash, role: "WAREHOUSE" },
  });
  warehouseToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });

  const tech = await prisma.adminUser.create({
    data: { username: "legacy_tech", passwordHash: hash, role: "TECHNICIAN" },
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

const ENDPOINT = "/api/finance/import-legacy-bookings";

describe("POST /api/finance/import-legacy-bookings", () => {
  it("rolesGuard: WAREHOUSE → 403", async () => {
    const res = await request(app)
      .post(ENDPOINT)
      .set(AUTH_WH())
      .send({ rows: [] });
    expect(res.status).toBe(403);
  });

  it("rolesGuard: TECHNICIAN → 403", async () => {
    const res = await request(app)
      .post(ENDPOINT)
      .set(AUTH_TECH())
      .send({ rows: [] });
    expect(res.status).toBe(403);
  });

  it("single row → creates 1 client + 1 booking", async () => {
    const res = await request(app)
      .post(ENDPOINT)
      .set(AUTH_SA())
      .send({
        rows: [
          {
            filename: "04.04 Романов 22137.xlsx",
            clientName: "Романов Импорт",
            date: "2026-04-04T00:00:00.000Z",
            amount: 22137,
          },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(1);
    expect(res.body.clients.created).toBe(1);
    expect(res.body.clients.matched).toBe(0);
    expect(res.body.bookings).toHaveLength(1);

    // Check DB
    const booking = await prisma.booking.findUnique({ where: { id: res.body.bookings[0].id } });
    expect(booking).toBeTruthy();
    expect(booking.isLegacyImport).toBe(true);
    expect(booking.status).toBe("RETURNED");
    expect(Number(booking.finalAmount)).toBe(22137);
    expect(Number(booking.amountOutstanding)).toBe(22137);
    expect(booking.paymentStatus).toBe("NOT_PAID");
  });

  it("two rows same client → 1 client, 2 bookings", async () => {
    const res = await request(app)
      .post(ENDPOINT)
      .set(AUTH_SA())
      .send({
        rows: [
          {
            filename: "05.04 Геннадий 10000.xlsx",
            clientName: "Геннадий Тест",
            date: "2026-04-05T00:00:00.000Z",
            amount: 10000,
          },
          {
            filename: "06.04 Геннадий 20000.xlsx",
            clientName: "Геннадий Тест",
            date: "2026-04-06T00:00:00.000Z",
            amount: 20000,
          },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(2);
    expect(res.body.clients.created).toBe(1);
    expect(res.body.clients.matched).toBe(1);
    expect(res.body.bookings).toHaveLength(2);
  });

  it("case-insensitive client match: 'хокаге' and 'Хокаге' → one client, first-wins name", async () => {
    const res = await request(app)
      .post(ENDPOINT)
      .set(AUTH_SA())
      .send({
        rows: [
          {
            filename: "10.04 хокаге 52600.xlsx",
            clientName: "хокаге",
            date: "2026-04-10T00:00:00.000Z",
            amount: 52600,
          },
          {
            filename: "11.04 Хокаге 30000.xlsx",
            clientName: "Хокаге",
            date: "2026-04-11T00:00:00.000Z",
            amount: 30000,
          },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.clients.created).toBe(1);
    expect(res.body.clients.matched).toBe(1);

    // Name preserved from first row (exact match since 'хокаге' was the first)
    const client = await prisma.client.findFirst({ where: { name: "хокаге" } });
    expect(client).toBeTruthy();
    expect(client.name).toBe("хокаге");
  });

  it("finalAmount = amountOutstanding, paymentStatus = NOT_PAID, status = RETURNED", async () => {
    const res = await request(app)
      .post(ENDPOINT)
      .set(AUTH_SA())
      .send({
        rows: [
          {
            filename: "17.04 Незрим 106332.xlsx",
            clientName: "Незрим Тест",
            date: "2026-04-17T00:00:00.000Z",
            amount: 106332,
          },
        ],
      });
    expect(res.status).toBe(200);
    const b = await prisma.booking.findUnique({ where: { id: res.body.bookings[0].id } });
    expect(Number(b.finalAmount)).toBe(106332);
    expect(Number(b.amountOutstanding)).toBe(106332);
    expect(Number(b.totalEstimateAmount)).toBe(106332);
    expect(Number(b.discountAmount)).toBe(0);
    expect(Number(b.amountPaid)).toBe(0);
    expect(b.isFullyPaid).toBe(false);
    expect(b.paymentStatus).toBe("NOT_PAID");
    expect(b.status).toBe("RETURNED");
  });

  it("AuditEntry written with action LEGACY_IMPORTED", async () => {
    const res = await request(app)
      .post(ENDPOINT)
      .set(AUTH_SA())
      .send({
        rows: [
          {
            filename: "audit-test.xlsx",
            clientName: "Аудит Клиент",
            date: "2026-04-15T00:00:00.000Z",
            amount: 5000,
          },
        ],
      });
    expect(res.status).toBe(200);
    const bookingId = res.body.bookings[0].id;
    const entry = await prisma.auditEntry.findFirst({
      where: { action: "LEGACY_IMPORTED", entityId: bookingId },
    });
    expect(entry).toBeTruthy();
    expect(entry.entityType).toBe("Booking");
    const after = JSON.parse(entry.after);
    expect(after.filename).toBe("audit-test.xlsx");
    expect(after.amount).toBe(5000);
  });

  it("booking has isLegacyImport = true", async () => {
    const res = await request(app)
      .post(ENDPOINT)
      .set(AUTH_SA())
      .send({
        rows: [
          {
            filename: "flag-check.xlsx",
            clientName: "Флаг Клиент",
            date: "2026-04-16T00:00:00.000Z",
            amount: 1000,
          },
        ],
      });
    expect(res.status).toBe(200);
    const booking = await prisma.booking.findUnique({ where: { id: res.body.bookings[0].id } });
    expect(booking.isLegacyImport).toBe(true);
  });

  it("Zod validation: empty clientName → 400", async () => {
    const res = await request(app)
      .post(ENDPOINT)
      .set(AUTH_SA())
      .send({
        rows: [
          {
            filename: "bad.xlsx",
            clientName: "   ",
            date: "2026-04-01T00:00:00.000Z",
            amount: 1000,
          },
        ],
      });
    expect(res.status).toBe(400);
  });

  it("Zod validation: amount <= 0 → 400", async () => {
    const res = await request(app)
      .post(ENDPOINT)
      .set(AUTH_SA())
      .send({
        rows: [
          {
            filename: "bad.xlsx",
            clientName: "Тест",
            date: "2026-04-01T00:00:00.000Z",
            amount: 0,
          },
        ],
      });
    expect(res.status).toBe(400);
  });

  it("Zod validation: invalid date → 400", async () => {
    const res = await request(app)
      .post(ENDPOINT)
      .set(AUTH_SA())
      .send({
        rows: [
          {
            filename: "bad.xlsx",
            clientName: "Тест",
            date: "not-a-date",
            amount: 1000,
          },
        ],
      });
    expect(res.status).toBe(400);
  });
});
