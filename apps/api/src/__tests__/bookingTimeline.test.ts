/**
 * B4 — Интеграционные тесты GET /api/bookings/:id/finance-timeline
 *
 * Проверяет хронологию финансовых событий по броне.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import Decimal from "decimal.js";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-timeline.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-tl";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-timeline-123";
process.env.WAREHOUSE_SECRET = "test-wh-timeline";
process.env.JWT_SECRET = "test-jwt-secret-timeline-min16chars";

let app: Express;
let prisma: any;
let superAdminToken: string;
let warehouseToken: string;
let technicianToken: string;
let clientId: string;

function AUTH_SA() {
  return { "X-API-Key": "test-key-tl", Authorization: `Bearer ${superAdminToken}` };
}
function AUTH_WH() {
  return { "X-API-Key": "test-key-tl", Authorization: `Bearer ${warehouseToken}` };
}
function AUTH_TECH() {
  return { "X-API-Key": "test-key-tl", Authorization: `Bearer ${technicianToken}` };
}

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, DATABASE_URL: `file:${TEST_DB_PATH}`, PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes" },
    stdio: "pipe",
  });

  const mod = await import("../app");
  app = mod.app;
  const pmod = await import("../prisma");
  prisma = pmod.prisma;

  const { hashPassword, signSession } = await import("../services/auth");
  const hash = await hashPassword("pass");

  const admin = await prisma.adminUser.create({
    data: { username: "tl_super", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  superAdminToken = signSession({ userId: admin.id, username: admin.username, role: "SUPER_ADMIN" });

  const wh = await prisma.adminUser.create({
    data: { username: "tl_wh", passwordHash: hash, role: "WAREHOUSE" },
  });
  warehouseToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });

  const tech = await prisma.adminUser.create({
    data: { username: "tl_tech", passwordHash: hash, role: "TECHNICIAN" },
  });
  technicianToken = signSession({ userId: tech.id, username: tech.username, role: "TECHNICIAN" });

  const client = await prisma.client.create({ data: { name: "Timeline Client" } });
  clientId = client.id;
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

describe("GET /api/bookings/:id/finance-timeline", () => {
  it("returns empty array for booking with no financial activity", async () => {
    const booking = await prisma.booking.create({
      data: {
        clientId,
        projectName: "Timeline Empty",
        startDate: new Date("2025-03-01"),
        endDate: new Date("2025-03-05"),
        status: "CONFIRMED",
      },
    });

    const res = await request(app)
      .get(`/api/bookings/${booking.id}/finance-timeline`)
      .set(AUTH_SA());
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("includes INVOICE_ISSUED event when invoice is issued", async () => {
    const booking = await prisma.booking.create({
      data: {
        clientId,
        projectName: "Timeline With Invoice",
        startDate: new Date("2025-04-01"),
        endDate: new Date("2025-04-05"),
        status: "CONFIRMED",
        legacyFinance: false,
      },
    });

    const invoice = await prisma.invoice.create({
      data: {
        number: "LR-TL-0001",
        bookingId: booking.id,
        kind: "FULL",
        status: "ISSUED",
        total: new Decimal("60000"),
        paidAmount: new Decimal("0"),
        issuedAt: new Date("2025-04-01T10:00:00Z"),
        createdBy: "tl_super",
      },
    });

    const res = await request(app)
      .get(`/api/bookings/${booking.id}/finance-timeline`)
      .set(AUTH_SA());
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    const invoiceEvent = res.body.find((e: any) => e.type === "INVOICE_ISSUED");
    expect(invoiceEvent).toBeDefined();
    expect(invoiceEvent.invoiceId).toBe(invoice.id);
    expect(invoiceEvent.number).toBe("LR-TL-0001");
    expect(new Decimal(invoiceEvent.total).toFixed(2)).toBe("60000.00");
  });

  it("includes PAYMENT_RECEIVED event", async () => {
    const booking = await prisma.booking.create({
      data: {
        clientId,
        projectName: "Timeline With Payment",
        startDate: new Date("2025-05-01"),
        endDate: new Date("2025-05-05"),
        status: "ISSUED",
      },
    });

    const payment = await prisma.payment.create({
      data: {
        bookingId: booking.id,
        amount: new Decimal("15000"),
        direction: "INCOME",
        status: "RECEIVED",
        paymentMethod: "CASH",
        receivedAt: new Date("2025-05-02T09:00:00Z"),
      },
    });

    const res = await request(app)
      .get(`/api/bookings/${booking.id}/finance-timeline`)
      .set(AUTH_SA());
    expect(res.status).toBe(200);
    const payEvent = res.body.find((e: any) => e.type === "PAYMENT_RECEIVED" && e.paymentId === payment.id);
    expect(payEvent).toBeDefined();
    expect(new Decimal(payEvent.amount).toFixed(2)).toBe("15000.00");
  });

  it("includes EXPENSE_LOGGED event and events are sorted ascending by at", async () => {
    const booking = await prisma.booking.create({
      data: {
        clientId,
        projectName: "Timeline Multi Events",
        startDate: new Date("2025-06-01"),
        endDate: new Date("2025-06-05"),
        status: "RETURNED",
      },
    });

    await prisma.expense.create({
      data: {
        bookingId: booking.id,
        category: "TRANSPORT",
        name: "Газель",
        amount: new Decimal("5000"),
        expenseDate: new Date("2025-06-02T08:00:00Z"),
        approved: true,
      },
    });

    await prisma.payment.create({
      data: {
        bookingId: booking.id,
        amount: new Decimal("30000"),
        direction: "INCOME",
        status: "RECEIVED",
        paymentMethod: "BANK_TRANSFER",
        receivedAt: new Date("2025-06-03T12:00:00Z"),
      },
    });

    const res = await request(app)
      .get(`/api/bookings/${booking.id}/finance-timeline`)
      .set(AUTH_SA());
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(2);

    // Verify ascending order
    const ats = res.body.map((e: any) => e.at);
    for (let i = 1; i < ats.length; i++) {
      expect(ats[i] >= ats[i - 1]).toBe(true);
    }

    const expenseEvent = res.body.find((e: any) => e.type === "EXPENSE_LOGGED");
    expect(expenseEvent).toBeDefined();
    expect(expenseEvent.category).toBe("TRANSPORT");
  });

  it("TECHNICIAN cannot access finance timeline — 403", async () => {
    const booking = await prisma.booking.create({
      data: {
        clientId,
        projectName: "Timeline Tech Forbidden",
        startDate: new Date("2025-07-01"),
        endDate: new Date("2025-07-05"),
        status: "CONFIRMED",
      },
    });

    const res = await request(app)
      .get(`/api/bookings/${booking.id}/finance-timeline`)
      .set(AUTH_TECH());
    expect(res.status).toBe(403);
  });
});
