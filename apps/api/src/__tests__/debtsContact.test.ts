/**
 * B2 — тест расширения /api/finance/debts: clientPhone и clientEmail в ответе
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import Decimal from "decimal.js";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-debts-contact.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-dc";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-debts-contact";
process.env.WAREHOUSE_SECRET = "test-wh-dc";
process.env.JWT_SECRET = "test-jwt-secret-debts-contact-min16";

let app: Express;
let prisma: any;
let superAdminToken: string;

function AUTH_SA() {
  return { "X-API-Key": "test-key-dc", Authorization: `Bearer ${superAdminToken}` };
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
    data: { username: "dc_super", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  superAdminToken = signSession({ userId: admin.id, username: admin.username, role: "SUPER_ADMIN" });
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

describe("GET /api/finance/debts — clientPhone & clientEmail", () => {
  it("includes clientPhone and clientEmail in debts response", async () => {
    const client = await prisma.client.create({
      data: { name: "DC Client With Contact", phone: "+7-999-123-45-67", email: "dclient@test.com" },
    });

    await prisma.booking.create({
      data: {
        clientId: client.id,
        projectName: "DC Project",
        startDate: new Date("2025-01-01"),
        endDate: new Date("2025-01-05"),
        status: "ISSUED",
        amountOutstanding: new Decimal("25000"),
        finalAmount: new Decimal("25000"),
        amountPaid: new Decimal("0"),
        paymentStatus: "NOT_PAID",
      },
    });

    const res = await request(app)
      .get("/api/finance/debts")
      .set(AUTH_SA());

    expect(res.status).toBe(200);
    const debt = res.body.debts.find((d: any) => d.clientId === client.id);
    expect(debt).toBeDefined();
    expect(debt.clientPhone).toBe("+7-999-123-45-67");
    expect(debt.clientEmail).toBe("dclient@test.com");
  });

  it("B1: projects include startDate, endDate, clientName, clientId (denormalized)", async () => {
    const client = await prisma.client.create({
      data: { name: "DC Denorm Client" },
    });
    const startDate = new Date("2025-03-10");
    const endDate = new Date("2025-03-15");
    await prisma.booking.create({
      data: {
        clientId: client.id,
        projectName: "DC Denorm Project",
        startDate,
        endDate,
        status: "ISSUED",
        amountOutstanding: new Decimal("8000"),
        finalAmount: new Decimal("8000"),
        amountPaid: new Decimal("0"),
        paymentStatus: "NOT_PAID",
      },
    });

    const res = await request(app)
      .get("/api/finance/debts")
      .set(AUTH_SA());

    expect(res.status).toBe(200);
    const debt = res.body.debts.find((d: any) => d.clientId === client.id);
    expect(debt).toBeDefined();
    expect(debt.projects).toHaveLength(1);
    const proj = debt.projects[0];
    expect(proj.startDate).toBeDefined();
    expect(new Date(proj.startDate).toISOString().startsWith("2025-03-10")).toBe(true);
    expect(proj.endDate).toBeDefined();
    expect(new Date(proj.endDate).toISOString().startsWith("2025-03-15")).toBe(true);
    expect(proj.clientName).toBe("DC Denorm Client");
    expect(proj.clientId).toBe(client.id);
    // PAR F1: new fields
    expect(proj.amountPaid).toBeDefined();
    expect(proj.finalAmount).toBeDefined();
    // PAR F4: payment count
    expect(typeof proj.paymentCount).toBe("number");
  });

  it("returns null for clientPhone/clientEmail when not set on client", async () => {
    const client = await prisma.client.create({
      data: { name: "DC Client No Contact" },
    });

    await prisma.booking.create({
      data: {
        clientId: client.id,
        projectName: "DC Project No Contact",
        startDate: new Date("2025-02-01"),
        endDate: new Date("2025-02-05"),
        status: "ISSUED",
        amountOutstanding: new Decimal("12000"),
        finalAmount: new Decimal("12000"),
        amountPaid: new Decimal("0"),
        paymentStatus: "NOT_PAID",
      },
    });

    const res = await request(app)
      .get("/api/finance/debts")
      .set(AUTH_SA());

    expect(res.status).toBe(200);
    const debt = res.body.debts.find((d: any) => d.clientId === client.id);
    expect(debt).toBeDefined();
    expect(debt.clientPhone).toBeNull();
    expect(debt.clientEmail).toBeNull();
  });
});
