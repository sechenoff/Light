/**
 * Интеграционные тесты маршрутов /api/refunds.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-refunds.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-refund";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-refund";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-refund";
process.env.JWT_SECRET = "test-jwt-secret-refunds-min16chars";

let app: Express;
let prisma: any;
let saToken: string;
let whToken: string;

let bookingId: string;
let invoiceId: string;
let paymentId: string;

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
  const hash = await hashPassword("test-pass");

  const sa = await prisma.adminUser.create({
    data: { username: "refund_sa", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  saToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });

  const wh = await prisma.adminUser.create({
    data: { username: "refund_wh", passwordHash: hash, role: "WAREHOUSE" },
  });
  whToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });

  // Create org settings for invoice numbering
  await prisma.organizationSettings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", legalName: "ООО Тест", inn: "1234567890", invoiceNumberPrefix: "RF" },
    update: {},
  });

  // Create test client, booking, invoice, payment
  const client = await prisma.client.create({ data: { name: `refund-client-${Date.now()}` } });

  const booking = await prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: "Refund Test",
      startDate: new Date("2026-05-01"),
      endDate: new Date("2026-05-03"),
      finalAmount: "200000",
      legacyFinance: false,
    },
  });
  bookingId = booking.id;

  // Create an invoice via API so it gets properly initialized
  const invRes = await request(app)
    .post("/api/invoices")
    .set({ "X-API-Key": "test-key-refund", Authorization: `Bearer ${saToken}` })
    .send({ bookingId, kind: "FULL" });
  invoiceId = invRes.body.id;

  // Issue it
  await request(app)
    .post(`/api/invoices/${invoiceId}/issue`)
    .set({ "X-API-Key": "test-key-refund", Authorization: `Bearer ${saToken}` });

  // Create a payment linked to this invoice
  const payment = await prisma.payment.create({
    data: {
      bookingId,
      invoiceId,
      amount: "200000",
      paymentMethod: "BANK_TRANSFER",
      method: "BANK_TRANSFER",
      paymentDate: new Date(),
      receivedAt: new Date(),
      direction: "INCOME",
      status: "RECEIVED",
      createdBy: sa.id,
    },
  });
  paymentId = payment.id;
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

function SA() { return { "X-API-Key": "test-key-refund", Authorization: `Bearer ${saToken}` }; }
function WH() { return { "X-API-Key": "test-key-refund", Authorization: `Bearer ${whToken}` }; }

describe("POST /api/refunds", () => {
  it("SA: создаёт возврат по invoiceId", async () => {
    const res = await request(app)
      .post("/api/refunds")
      .set(SA())
      .send({
        invoiceId,
        amount: 10000,
        reason: "Частичный возврат по договору",
        method: "BANK_TRANSFER",
        refundedAt: "2026-05-10T12:00:00.000Z",
      });

    expect(res.status).toBe(201);
    expect(res.body.invoiceId).toBe(invoiceId);
    expect(Number(res.body.amount)).toBe(10000);
    expect(res.body.reason).toBe("Частичный возврат по договору");
  });

  it("SA: создаёт возврат по paymentId", async () => {
    const res = await request(app)
      .post("/api/refunds")
      .set(SA())
      .send({
        paymentId,
        amount: 5000,
        reason: "Возврат по платежу",
        method: "CASH",
        refundedAt: "2026-05-10T12:00:00.000Z",
      });

    expect(res.status).toBe(201);
    expect(res.body.paymentId).toBe(paymentId);
    expect(Number(res.body.amount)).toBe(5000);
  });

  it("без invoiceId/paymentId/bookingId → 400", async () => {
    const res = await request(app)
      .post("/api/refunds")
      .set(SA())
      .send({
        amount: 1000,
        reason: "Тест",
        method: "CASH",
        refundedAt: "2026-05-10T12:00:00.000Z",
      });

    expect(res.status).toBe(400);
  });

  it("WH: не может создавать возвраты → 403", async () => {
    const res = await request(app)
      .post("/api/refunds")
      .set(WH())
      .send({
        invoiceId,
        amount: 1000,
        reason: "Тест WH",
        method: "CASH",
        refundedAt: "2026-05-10T12:00:00.000Z",
      });

    expect(res.status).toBe(403);
  });
});

describe("GET /api/refunds", () => {
  it("SA: получает список возвратов", async () => {
    const res = await request(app).get("/api/refunds").set(SA());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(typeof res.body.total).toBe("number");
  });

  it("WH: может читать список", async () => {
    const res = await request(app).get("/api/refunds").set(WH());
    expect(res.status).toBe(200);
  });

  it("фильтр по invoiceId", async () => {
    const res = await request(app).get(`/api/refunds?invoiceId=${invoiceId}`).set(SA());
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    for (const r of res.body.items) {
      expect(r.invoiceId).toBe(invoiceId);
    }
  });
});
