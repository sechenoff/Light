/**
 * Интеграционные тесты GET /api/finance/forecast
 *
 * B1 — стек-бар прогноза доходов на 6 месяцев.
 * Паттерн: изолированная TEST_DB, signSession, supertest.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import Decimal from "decimal.js";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-forecast.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-fc";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-forecast-123";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-fc";
process.env.JWT_SECRET = "test-jwt-secret-forecast-min16chars";

let app: Express;
let prisma: any;
let superAdminToken: string;
let warehouseToken: string;
let technicianToken: string;
let clientId: string;

function AUTH_SA() {
  return { "X-API-Key": "test-key-fc", Authorization: `Bearer ${superAdminToken}` };
}
function AUTH_WH() {
  return { "X-API-Key": "test-key-fc", Authorization: `Bearer ${warehouseToken}` };
}
function AUTH_TECH() {
  return { "X-API-Key": "test-key-fc", Authorization: `Bearer ${technicianToken}` };
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
    data: { username: "fc_super", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  superAdminToken = signSession({ userId: admin.id, username: admin.username, role: "SUPER_ADMIN" });

  const wh = await prisma.adminUser.create({
    data: { username: "fc_wh", passwordHash: hash, role: "WAREHOUSE" },
  });
  warehouseToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });

  const tech = await prisma.adminUser.create({
    data: { username: "fc_tech", passwordHash: hash, role: "TECHNICIAN" },
  });
  technicianToken = signSession({ userId: tech.id, username: tech.username, role: "TECHNICIAN" });

  const client = await prisma.client.create({ data: { name: "Forecast Client" } });
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

describe("GET /api/finance/forecast", () => {
  it("returns empty forecast with zero totals when no invoices or bookings exist", async () => {
    const res = await request(app)
      .get("/api/finance/forecast?months=6")
      .set(AUTH_SA());
    expect(res.status).toBe(200);
    expect(res.body.months).toHaveLength(6);
    expect(res.body.totals.confirmed).toBe("0.00");
    expect(res.body.totals.potential).toBe("0.00");
    expect(res.body.totals.bookingsPipeline).toBe("0.00");
    // Each month has the three keys
    for (const m of res.body.months) {
      expect(m).toHaveProperty("month");
      expect(m).toHaveProperty("confirmed");
      expect(m).toHaveProperty("potential");
      expect(m).toHaveProperty("bookingsPipeline");
    }
  });

  it("counts ISSUED invoice outstanding in confirmed bucket for its dueDate month", async () => {
    // Create a booking and an ISSUED invoice with dueDate in the next month
    const now = new Date();
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 15);
    const nextMonthLabel = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, "0")}`;

    const booking = await prisma.booking.create({
      data: {
        clientId,
        projectName: "Forecast ISSUED",
        startDate: new Date(),
        endDate: new Date(Date.now() + 86400000),
        status: "CONFIRMED",
        legacyFinance: false,
      },
    });

    await prisma.invoice.create({
      data: {
        number: "LR-FORECAST-0001",
        bookingId: booking.id,
        kind: "FULL",
        status: "ISSUED",
        total: new Decimal("50000"),
        paidAmount: new Decimal("10000"),
        dueDate: nextMonth,
        issuedAt: new Date(),
        createdBy: "fc_super",
      },
    });

    const res = await request(app)
      .get("/api/finance/forecast?months=6")
      .set(AUTH_SA());
    expect(res.status).toBe(200);

    const targetMonth = res.body.months.find((m: any) => m.month === nextMonthLabel);
    expect(targetMonth).toBeDefined();
    // confirmed = total - paidAmount = 50000 - 10000 = 40000
    expect(new Decimal(targetMonth.confirmed).toFixed(2)).toBe("40000.00");
  });

  it("counts DRAFT invoice outstanding in potential bucket", async () => {
    const now = new Date();
    const month2 = new Date(now.getFullYear(), now.getMonth() + 2, 10);
    const month2Label = `${month2.getFullYear()}-${String(month2.getMonth() + 1).padStart(2, "0")}`;

    const booking = await prisma.booking.create({
      data: {
        clientId,
        projectName: "Forecast DRAFT invoice",
        startDate: new Date(),
        endDate: new Date(Date.now() + 86400000),
        status: "CONFIRMED",
        legacyFinance: false,
      },
    });

    await prisma.invoice.create({
      data: {
        number: "LR-FORECAST-0002",
        bookingId: booking.id,
        kind: "FULL",
        status: "DRAFT",
        total: new Decimal("30000"),
        paidAmount: new Decimal("0"),
        dueDate: month2,
        createdBy: "fc_super",
      },
    });

    const res = await request(app)
      .get("/api/finance/forecast?months=6")
      .set(AUTH_SA());
    expect(res.status).toBe(200);

    const targetMonth = res.body.months.find((m: any) => m.month === month2Label);
    expect(targetMonth).toBeDefined();
    expect(new Decimal(targetMonth.potential).gte(new Decimal("30000"))).toBe(true);
  });

  it("counts confirmed bookings without invoices in bookingsPipeline", async () => {
    const now = new Date();
    const month3 = new Date(now.getFullYear(), now.getMonth() + 1, 20);
    const month3Label = `${month3.getFullYear()}-${String(month3.getMonth() + 1).padStart(2, "0")}`;

    // Booking with no invoice, CONFIRMED, startDate in next month
    await prisma.booking.create({
      data: {
        clientId,
        projectName: "Forecast pipeline booking",
        startDate: month3,
        endDate: new Date(month3.getTime() + 2 * 86400000),
        status: "CONFIRMED",
        legacyFinance: true,
        finalAmount: new Decimal("20000"),
        amountPaid: new Decimal("5000"),
        amountOutstanding: new Decimal("15000"),
      },
    });

    const res = await request(app)
      .get("/api/finance/forecast?months=6")
      .set(AUTH_SA());
    expect(res.status).toBe(200);

    // pipeline should have at least 15000 in the target month
    const targetMonth = res.body.months.find((m: any) => m.month === month3Label);
    expect(targetMonth).toBeDefined();
    expect(new Decimal(targetMonth.bookingsPipeline).gte(new Decimal("15000"))).toBe(true);
  });

  it("respects months param — horizon limit", async () => {
    const res3 = await request(app)
      .get("/api/finance/forecast?months=3")
      .set(AUTH_SA());
    expect(res3.status).toBe(200);
    expect(res3.body.months).toHaveLength(3);

    const res12 = await request(app)
      .get("/api/finance/forecast?months=12")
      .set(AUTH_SA());
    expect(res12.status).toBe(200);
    // max is capped at 12
    expect(res12.body.months.length).toBeLessThanOrEqual(12);
  });

  it("totals equal sum of months", async () => {
    const res = await request(app)
      .get("/api/finance/forecast?months=6")
      .set(AUTH_SA());
    expect(res.status).toBe(200);

    const sumConfirmed = res.body.months.reduce(
      (acc: Decimal, m: any) => acc.add(new Decimal(m.confirmed)),
      new Decimal(0),
    );
    const sumPotential = res.body.months.reduce(
      (acc: Decimal, m: any) => acc.add(new Decimal(m.potential)),
      new Decimal(0),
    );
    const sumPipeline = res.body.months.reduce(
      (acc: Decimal, m: any) => acc.add(new Decimal(m.bookingsPipeline)),
      new Decimal(0),
    );

    expect(new Decimal(res.body.totals.confirmed).toFixed(2)).toBe(sumConfirmed.toFixed(2));
    expect(new Decimal(res.body.totals.potential).toFixed(2)).toBe(sumPotential.toFixed(2));
    expect(new Decimal(res.body.totals.bookingsPipeline).toFixed(2)).toBe(sumPipeline.toFixed(2));
  });

  it("TECHNICIAN cannot access forecast — 403", async () => {
    const res = await request(app)
      .get("/api/finance/forecast?months=6")
      .set(AUTH_TECH());
    expect(res.status).toBe(403);
  });
});
