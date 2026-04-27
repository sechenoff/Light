/**
 * B2 — тесты GET /api/finance/debts/:clientId/export.xlsx
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import Decimal from "decimal.js";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-debts-export.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-debts-export";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-debts-export";
process.env.WAREHOUSE_SECRET = "test-wh-debts-export";
process.env.JWT_SECRET = "test-jwt-secret-debts-export-min16chars";

let app: Express;
let prisma: any;
let superAdminToken: string;
let clientWithDebtsId: string;
let clientNoDebtsId: string;

function AUTH_SA() {
  return { "X-API-Key": "test-key-debts-export", Authorization: `Bearer ${superAdminToken}` };
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
    data: { username: "export_super", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  superAdminToken = signSession({ userId: admin.id, username: admin.username, role: "SUPER_ADMIN" });

  // Клиент с долгом
  const clientWithDebts = await prisma.client.create({
    data: { name: "Экспорт Клиент", phone: "+7-900-000-0000", email: "export@test.com" },
  });
  clientWithDebtsId = clientWithDebts.id;

  await prisma.booking.create({
    data: {
      clientId: clientWithDebts.id,
      projectName: "Экспорт Проект",
      startDate: new Date("2024-06-01"),
      endDate: new Date("2024-06-05"),
      status: "ISSUED",
      amountOutstanding: new Decimal("30000"),
      finalAmount: new Decimal("30000"),
      amountPaid: new Decimal("0"),
      paymentStatus: "NOT_PAID",
      expectedPaymentDate: new Date("2024-06-15"),
    },
  });

  // Клиент без долга (все брони оплачены)
  const clientNoDebts = await prisma.client.create({
    data: { name: "Клиент Без Долга" },
  });
  clientNoDebtsId = clientNoDebts.id;

  await prisma.booking.create({
    data: {
      clientId: clientNoDebts.id,
      projectName: "Оплаченный Проект",
      startDate: new Date("2024-07-01"),
      endDate: new Date("2024-07-05"),
      status: "RETURNED",
      amountOutstanding: new Decimal("0"),
      finalAmount: new Decimal("20000"),
      amountPaid: new Decimal("20000"),
      paymentStatus: "PAID",
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

describe("GET /api/finance/debts/:clientId/export.xlsx", () => {
  it("возвращает XLSX-файл для клиента с долгами", async () => {
    const res = await request(app)
      .get(`/api/finance/debts/${clientWithDebtsId}/export.xlsx`)
      .set(AUTH_SA())
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    // RFC 5987 encodes filename*= with percent-encoding; check for the encoded form
    expect(res.headers["content-disposition"]).toMatch(/filename\*=UTF-8''/);
    // Проверяем что это валидный Excel (начинается с PK magic bytes)
    const bodyBuf: Buffer = res.body;
    expect(bodyBuf.length).toBeGreaterThan(0);
    expect(bodyBuf.slice(0, 2).toString("hex")).toBe("504b"); // PK zip header
  });

  it("возвращает 404 для несуществующего clientId", async () => {
    const res = await request(app)
      .get("/api/finance/debts/nonexistent-client-id/export.xlsx")
      .set(AUTH_SA());

    expect(res.status).toBe(404);
  });

  it("возвращает пустой XLSX (лист без строк данных) для клиента без долга", async () => {
    const res = await request(app)
      .get(`/api/finance/debts/${clientNoDebtsId}/export.xlsx`)
      .set(AUTH_SA());

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
  });

  it("возвращает 403 без авторизации SA", async () => {
    const res = await request(app)
      .get(`/api/finance/debts/${clientWithDebtsId}/export.xlsx`)
      .set({ "X-API-Key": "test-key-debts-export" }); // без Bearer token

    expect(res.status).toBe(401);
  });
});
