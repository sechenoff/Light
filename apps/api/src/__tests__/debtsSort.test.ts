/**
 * B1 — тесты сортировки GET /api/finance/debts
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import Decimal from "decimal.js";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-debts-sort.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-debts-sort";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-debts-sort";
process.env.WAREHOUSE_SECRET = "test-wh-debts-sort";
process.env.JWT_SECRET = "test-jwt-secret-debts-sort-min16chars";

let app: Express;
let prisma: any;
let superAdminToken: string;

function AUTH_SA() {
  return { "X-API-Key": "test-key-debts-sort", Authorization: `Bearer ${superAdminToken}` };
}

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
  const hash = await hashPassword("pass");
  const admin = await prisma.adminUser.create({
    data: { username: "sort_super", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  superAdminToken = signSession({ userId: admin.id, username: admin.username, role: "SUPER_ADMIN" });

  // Создаём трёх клиентов с разными суммами долга и датами
  // Алиса — 5000, долг с 2024-01-15
  // Борис — 15000, долг с 2024-03-01
  // Виктор — 8000, долг с 2024-02-10
  const alice = await prisma.client.create({ data: { name: "Алиса" } });
  const boris = await prisma.client.create({ data: { name: "Борис" } });
  const viktor = await prisma.client.create({ data: { name: "Виктор" } });

  await prisma.booking.create({
    data: {
      clientId: alice.id,
      projectName: "Проект Алисы",
      startDate: new Date("2024-01-01"),
      endDate: new Date("2024-01-05"),
      status: "ISSUED",
      amountOutstanding: new Decimal("5000"),
      finalAmount: new Decimal("5000"),
      amountPaid: new Decimal("0"),
      paymentStatus: "NOT_PAID",
      expectedPaymentDate: new Date("2024-01-15"),
    },
  });

  await prisma.booking.create({
    data: {
      clientId: boris.id,
      projectName: "Проект Бориса",
      startDate: new Date("2024-03-01"),
      endDate: new Date("2024-03-05"),
      status: "ISSUED",
      amountOutstanding: new Decimal("15000"),
      finalAmount: new Decimal("15000"),
      amountPaid: new Decimal("0"),
      paymentStatus: "NOT_PAID",
      expectedPaymentDate: new Date("2024-03-01"),
    },
  });

  await prisma.booking.create({
    data: {
      clientId: viktor.id,
      projectName: "Проект Виктора",
      startDate: new Date("2024-02-01"),
      endDate: new Date("2024-02-05"),
      status: "ISSUED",
      amountOutstanding: new Decimal("8000"),
      finalAmount: new Decimal("8000"),
      amountPaid: new Decimal("0"),
      paymentStatus: "NOT_PAID",
      expectedPaymentDate: new Date("2024-02-10"),
    },
  });
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

describe("GET /api/finance/debts — сортировка", () => {
  it("sort=amount&order=desc возвращает Борис → Виктор → Алиса (по убыванию суммы)", async () => {
    const res = await request(app)
      .get("/api/finance/debts?sort=amount&order=desc")
      .set(AUTH_SA());

    expect(res.status).toBe(200);
    const names = res.body.debts.map((d: any) => d.clientName);
    const aliceIdx = names.indexOf("Алиса");
    const borisIdx = names.indexOf("Борис");
    const viktorIdx = names.indexOf("Виктор");
    expect(borisIdx).toBeLessThan(viktorIdx);
    expect(viktorIdx).toBeLessThan(aliceIdx);
  });

  it("sort=amount&order=asc возвращает Алиса → Виктор → Борис (по возрастанию суммы)", async () => {
    const res = await request(app)
      .get("/api/finance/debts?sort=amount&order=asc")
      .set(AUTH_SA());

    expect(res.status).toBe(200);
    const names = res.body.debts.map((d: any) => d.clientName);
    const aliceIdx = names.indexOf("Алиса");
    const borisIdx = names.indexOf("Борис");
    const viktorIdx = names.indexOf("Виктор");
    expect(aliceIdx).toBeLessThan(viktorIdx);
    expect(viktorIdx).toBeLessThan(borisIdx);
  });

  it("sort=name&order=asc: русская локаль Алиса < Борис < Виктор", async () => {
    const res = await request(app)
      .get("/api/finance/debts?sort=name&order=asc")
      .set(AUTH_SA());

    expect(res.status).toBe(200);
    const names = res.body.debts.map((d: any) => d.clientName);
    const aliceIdx = names.indexOf("Алиса");
    const borisIdx = names.indexOf("Борис");
    const viktorIdx = names.indexOf("Виктор");
    expect(aliceIdx).toBeLessThan(borisIdx);
    expect(borisIdx).toBeLessThan(viktorIdx);
  });

  it("sort=name&order=desc: русская локаль Виктор > Борис > Алиса", async () => {
    const res = await request(app)
      .get("/api/finance/debts?sort=name&order=desc")
      .set(AUTH_SA());

    expect(res.status).toBe(200);
    const names = res.body.debts.map((d: any) => d.clientName);
    const aliceIdx = names.indexOf("Алиса");
    const borisIdx = names.indexOf("Борис");
    const viktorIdx = names.indexOf("Виктор");
    expect(viktorIdx).toBeLessThan(borisIdx);
    expect(borisIdx).toBeLessThan(aliceIdx);
  });

  it("sort=date&order=asc: Алиса (Jan-15) < Виктор (Feb-10) < Борис (Mar-01)", async () => {
    const res = await request(app)
      .get("/api/finance/debts?sort=date&order=asc")
      .set(AUTH_SA());

    expect(res.status).toBe(200);
    const names = res.body.debts.map((d: any) => d.clientName);
    const aliceIdx = names.indexOf("Алиса");
    const borisIdx = names.indexOf("Борис");
    const viktorIdx = names.indexOf("Виктор");
    expect(aliceIdx).toBeLessThan(viktorIdx);
    expect(viktorIdx).toBeLessThan(borisIdx);
  });

  it("default (no sort param) sorts by amount desc — same as sort=amount&order=desc", async () => {
    const resDefault = await request(app).get("/api/finance/debts").set(AUTH_SA());
    const resExplicit = await request(app).get("/api/finance/debts?sort=amount&order=desc").set(AUTH_SA());

    expect(resDefault.status).toBe(200);
    const defaultNames = resDefault.body.debts.map((d: any) => d.clientName);
    const explicitNames = resExplicit.body.debts.map((d: any) => d.clientName);
    expect(defaultNames).toEqual(explicitNames);
  });
});
