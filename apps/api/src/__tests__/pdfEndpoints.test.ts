/**
 * Smoke tests for PDF export endpoints.
 * Verifies F1 (async buffer), F2 (font path), F6 (CANCELLED block).
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-pdf-endpoints.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-pdf";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-pdf";
process.env.WAREHOUSE_SECRET = "test-warehouse-pdf";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-secret-pdf-endpoints-min16chars";

let app: Express;
let prisma: any;

let superAdminToken: string;

let confirmedBookingId: string;
let returnedBookingId: string;
let cancelledBookingId: string;
let outstandingBookingId: string;

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
  const hash = await hashPassword("pdf-test-pass");

  const superAdmin = await prisma.adminUser.create({
    data: { username: "pdf_super", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  superAdminToken = signSession({ userId: superAdmin.id, username: superAdmin.username, role: "SUPER_ADMIN" });

  const client = await prisma.client.create({
    data: { name: "PDF Тест Клиент", phone: "+79001111111" },
  });

  const bookingBase = {
    clientId: client.id,
    projectName: "PDF Тест Проект",
    startDate: new Date("2026-05-01T10:00:00Z"),
    endDate: new Date("2026-05-03T10:00:00Z"),
    totalEstimateAmount: "5000.00",
    finalAmount: "5000.00",
    discountAmount: "0.00",
    amountPaid: "0.00",
    amountOutstanding: "0.00",
  };

  const confirmed = await prisma.booking.create({
    data: { ...bookingBase, status: "CONFIRMED" },
  });
  confirmedBookingId = confirmed.id;

  const returned = await prisma.booking.create({
    data: { ...bookingBase, status: "RETURNED" },
  });
  returnedBookingId = returned.id;

  const cancelled = await prisma.booking.create({
    data: { ...bookingBase, status: "CANCELLED" },
  });
  cancelledBookingId = cancelled.id;

  const outstanding = await prisma.booking.create({
    data: { ...bookingBase, status: "RETURNED", amountOutstanding: "2000.00" },
  });
  outstandingBookingId = outstanding.id;
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

const apiKey = { "X-API-Key": "test-key-pdf" };
function authHeaders(token: string) {
  return { ...apiKey, "Authorization": `Bearer ${token}` };
}

describe("GET /api/bookings/:id/invoice.pdf", () => {
  it("200 — возвращает PDF-буфер для CONFIRMED брони", async () => {
    const res = await request(app)
      .get(`/api/bookings/${confirmedBookingId}/invoice.pdf`)
      .set(authHeaders(superAdminToken))
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
    const buf = res.body as Buffer;
    expect(buf.length).toBeGreaterThan(1000);
    // PDF magic bytes: %PDF
    expect(buf.slice(0, 4).toString("ascii")).toBe("%PDF");
  });

  it("409 INVOICE_NOT_AVAILABLE — бронь отменена", async () => {
    const res = await request(app)
      .get(`/api/bookings/${cancelledBookingId}/invoice.pdf`)
      .set(authHeaders(superAdminToken));

    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject({
      code: "INVOICE_NOT_AVAILABLE",
      reason: "BOOKING_CANCELLED",
    });
  });
});

describe("GET /api/bookings/:id/act.pdf", () => {
  it("200 — возвращает PDF-буфер для RETURNED брони без долга", async () => {
    const res = await request(app)
      .get(`/api/bookings/${returnedBookingId}/act.pdf`)
      .set(authHeaders(superAdminToken))
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
    const buf = res.body as Buffer;
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf.slice(0, 4).toString("ascii")).toBe("%PDF");
  });

  it("409 ACT_NOT_AVAILABLE — бронь не возвращена (CONFIRMED)", async () => {
    const res = await request(app)
      .get(`/api/bookings/${confirmedBookingId}/act.pdf`)
      .set(authHeaders(superAdminToken));

    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject({
      code: "ACT_NOT_AVAILABLE",
      reason: "BOOKING_NOT_RETURNED",
    });
  });

  it("409 ACT_NOT_AVAILABLE — есть задолженность", async () => {
    const res = await request(app)
      .get(`/api/bookings/${outstandingBookingId}/act.pdf`)
      .set(authHeaders(superAdminToken));

    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject({
      code: "ACT_NOT_AVAILABLE",
      reason: "OUTSTANDING_DEBT",
    });
  });
});
