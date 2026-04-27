/**
 * Тесты GET /api/finance/debts/:clientId/report.pdf
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import Decimal from "decimal.js";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-client-debt-report.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-debt-report";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-debt-report";
process.env.WAREHOUSE_SECRET = "test-wh-debt-report";
process.env.JWT_SECRET = "test-jwt-secret-debt-report-min16chars";

let app: Express;
let prisma: any;
let superAdminToken: string;
let warehouseToken: string;
let clientWithDebtsId: string;
let clientNoDebtsId: string;
let clientNotFoundId: string;

function AUTH_SA() {
  return { "X-API-Key": "test-key-debt-report", Authorization: `Bearer ${superAdminToken}` };
}

function AUTH_WH() {
  return { "X-API-Key": "test-key-debt-report", Authorization: `Bearer ${warehouseToken}` };
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

  const adminSA = await prisma.adminUser.create({
    data: { username: "dr_super", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  superAdminToken = signSession({ userId: adminSA.id, username: adminSA.username, role: "SUPER_ADMIN" });

  const adminWH = await prisma.adminUser.create({
    data: { username: "dr_wh", passwordHash: hash, role: "WAREHOUSE" },
  });
  warehouseToken = signSession({ userId: adminWH.id, username: adminWH.username, role: "WAREHOUSE" });

  // Клиент с тремя бронями и долгами
  const clientWithDebts = await prisma.client.create({
    data: { name: "ПДФ Клиент", phone: "+7-900-111-22-33", email: "pdf@test.com" },
  });
  clientWithDebtsId = clientWithDebts.id;

  for (const i of [1, 2, 3]) {
    await prisma.booking.create({
      data: {
        clientId: clientWithDebts.id,
        projectName: `ПДФ Проект ${i}`,
        startDate: new Date(`2024-0${i}-01`),
        endDate: new Date(`2024-0${i}-05`),
        status: "ISSUED",
        amountOutstanding: new Decimal(String(10000 * i)),
        finalAmount: new Decimal(String(15000 * i)),
        amountPaid: new Decimal(String(5000 * i)),
        paymentStatus: "PARTIALLY_PAID",
      },
    });
  }

  // Клиент без долгов (все брони оплачены)
  const clientNoDebts = await prisma.client.create({
    data: { name: "Клиент Без Долга" },
  });
  clientNoDebtsId = clientNoDebts.id;

  await prisma.booking.create({
    data: {
      clientId: clientNoDebts.id,
      projectName: "Оплаченный Проект",
      startDate: new Date("2024-08-01"),
      endDate: new Date("2024-08-05"),
      status: "RETURNED",
      amountOutstanding: new Decimal("0"),
      finalAmount: new Decimal("20000"),
      amountPaid: new Decimal("20000"),
      paymentStatus: "PAID",
    },
  });

  // ID несуществующего клиента
  clientNotFoundId = "nonexistent-client-id-000";
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

describe("GET /api/finance/debts/:clientId/report.pdf", () => {
  it("возвращает 403 для WAREHOUSE (только SUPER_ADMIN)", async () => {
    const res = await request(app)
      .get(`/api/finance/debts/${clientWithDebtsId}/report.pdf`)
      .set(AUTH_WH());

    expect(res.status).toBe(403);
  });

  it("возвращает 401 без Bearer-токена (только X-API-Key)", async () => {
    const res = await request(app)
      .get(`/api/finance/debts/${clientWithDebtsId}/report.pdf`)
      .set({ "X-API-Key": "test-key-debt-report" });

    expect(res.status).toBe(401);
  });

  it("возвращает 404 для несуществующего clientId", async () => {
    const res = await request(app)
      .get(`/api/finance/debts/${clientNotFoundId}/report.pdf`)
      .set(AUTH_SA());

    expect(res.status).toBe(404);
  });

  it("возвращает 200 с PDF для клиента без долгов (placeholder-отчёт)", async () => {
    const res = await request(app)
      .get(`/api/finance/debts/${clientNoDebtsId}/report.pdf`)
      .set(AUTH_SA())
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    const bodyBuf: Buffer = res.body;
    expect(bodyBuf.length).toBeGreaterThan(0);
    // PDF magic bytes %PDF
    expect(bodyBuf.slice(0, 4).toString("ascii")).toBe("%PDF");
  });

  it("возвращает 200 с PDF-отчётом для клиента с 3 бронями — буфер > 1000 байт и magic bytes %PDF", async () => {
    const res = await request(app)
      .get(`/api/finance/debts/${clientWithDebtsId}/report.pdf`)
      .set(AUTH_SA())
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(res.headers["content-disposition"]).toMatch(/filename/i);

    const bodyBuf: Buffer = res.body;
    expect(bodyBuf.length).toBeGreaterThan(1000);
    // PDF magic bytes %PDF
    expect(bodyBuf.slice(0, 4).toString("ascii")).toBe("%PDF");
    // DejaVu font must be embedded (Cyrillic support); absence means font path resolved incorrectly
    expect(bodyBuf.toString("binary")).toContain("DejaVu");
  });
});
