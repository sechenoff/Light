/**
 * Интеграционные тесты маршрутов /api/credit-notes.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-credit-notes.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-cn";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-cn";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-cn";
process.env.JWT_SECRET = "test-jwt-secret-creditnotes-min16";

let app: Express;
let prisma: any;
let saToken: string;
let whToken: string;

let clientId: string;
let bookingId: string;

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
    data: { username: "cn_sa", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  saToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });

  const wh = await prisma.adminUser.create({
    data: { username: "cn_wh", passwordHash: hash, role: "WAREHOUSE" },
  });
  whToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });

  // Create test client and booking
  const client = await prisma.client.create({ data: { name: `cn-client-${Date.now()}` } });
  clientId = client.id;

  const booking = await prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: "CreditNote Test",
      startDate: new Date("2026-06-01"),
      endDate: new Date("2026-06-03"),
      finalAmount: "50000",
      legacyFinance: false,
    },
  });
  bookingId = booking.id;
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

function SA() { return { "X-API-Key": "test-key-cn", Authorization: `Bearer ${saToken}` }; }
function WH() { return { "X-API-Key": "test-key-cn", Authorization: `Bearer ${whToken}` }; }

describe("POST /api/credit-notes", () => {
  it("SA: создаёт кредит-ноту для клиента", async () => {
    const res = await request(app)
      .post("/api/credit-notes")
      .set(SA())
      .send({
        contactClientId: clientId,
        amount: 15000,
        reason: "Компенсация за задержку",
      });

    expect(res.status).toBe(201);
    expect(res.body.contactClientId).toBe(clientId);
    expect(Number(res.body.amount)).toBe(15000);
    expect(Number(res.body.remaining)).toBe(15000);
    expect(res.body.reason).toBe("Компенсация за задержку");
  });

  it("короткая причина → 400", async () => {
    const res = await request(app)
      .post("/api/credit-notes")
      .set(SA())
      .send({
        contactClientId: clientId,
        amount: 1000,
        reason: "аб", // < 3 chars
      });

    expect(res.status).toBe(400);
  });

  it("WH: не может создавать кредит-ноты → 403", async () => {
    const res = await request(app)
      .post("/api/credit-notes")
      .set(WH())
      .send({
        contactClientId: clientId,
        amount: 5000,
        reason: "Тест",
      });

    expect(res.status).toBe(403);
  });
});

describe("POST /api/credit-notes/:id/apply", () => {
  it("SA: применяет кредит-ноту к брони", async () => {
    // Create a credit note
    const create = await request(app)
      .post("/api/credit-notes")
      .set(SA())
      .send({
        contactClientId: clientId,
        amount: 20000,
        reason: "Применение к брони тест",
      });

    expect(create.status).toBe(201);
    const noteId = create.body.id;

    // Apply to booking
    const apply = await request(app)
      .post(`/api/credit-notes/${noteId}/apply`)
      .set(SA())
      .send({ applyToBookingId: bookingId });

    expect(apply.status).toBe(200);
    expect(Number(apply.body.remaining)).toBe(0);
    expect(apply.body.appliedToBookingId).toBe(bookingId);
    expect(apply.body.appliedAt).toBeTruthy();
  });

  it("повторное применение → 409", async () => {
    // Create and apply
    const create = await request(app)
      .post("/api/credit-notes")
      .set(SA())
      .send({
        contactClientId: clientId,
        amount: 5000,
        reason: "Повторное применение тест",
      });
    const noteId = create.body.id;

    await request(app)
      .post(`/api/credit-notes/${noteId}/apply`)
      .set(SA())
      .send({ applyToBookingId: bookingId });

    // Apply again
    const res = await request(app)
      .post(`/api/credit-notes/${noteId}/apply`)
      .set(SA())
      .send({ applyToBookingId: bookingId });

    expect(res.status).toBe(409);
  });
});

describe("GET /api/credit-notes", () => {
  it("SA: получает список кредит-нот", async () => {
    const res = await request(app).get("/api/credit-notes").set(SA());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(typeof res.body.total).toBe("number");
  });

  it("WH: может читать список", async () => {
    const res = await request(app).get("/api/credit-notes").set(WH());
    expect(res.status).toBe(200);
  });

  it("фильтр по contactClientId", async () => {
    const res = await request(app).get(`/api/credit-notes?contactClientId=${clientId}`).set(SA());
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    for (const n of res.body.items) {
      expect(n.contactClientId).toBe(clientId);
    }
  });
});
