/**
 * B6 — Интеграционные тесты file upload для /api/expenses/:id/document
 *
 * Проверяет загрузку, получение и удаление документа расхода.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import Decimal from "decimal.js";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-expense-doc.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-ed";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-expense-doc";
process.env.WAREHOUSE_SECRET = "test-wh-ed";
process.env.JWT_SECRET = "test-jwt-secret-expense-doc-min16ch";

let app: Express;
let prisma: any;
let superAdminToken: string;
let warehouseToken: string;
let technicianToken: string;
let clientId: string;
let expenseId: string;

function AUTH_SA() {
  return { "X-API-Key": "test-key-ed", Authorization: `Bearer ${superAdminToken}` };
}
function AUTH_WH() {
  return { "X-API-Key": "test-key-ed", Authorization: `Bearer ${warehouseToken}` };
}
function AUTH_TECH() {
  return { "X-API-Key": "test-key-ed", Authorization: `Bearer ${technicianToken}` };
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
    data: { username: "ed_super", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  superAdminToken = signSession({ userId: admin.id, username: admin.username, role: "SUPER_ADMIN" });

  const wh = await prisma.adminUser.create({
    data: { username: "ed_wh", passwordHash: hash, role: "WAREHOUSE" },
  });
  warehouseToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });

  const tech = await prisma.adminUser.create({
    data: { username: "ed_tech", passwordHash: hash, role: "TECHNICIAN" },
  });
  technicianToken = signSession({ userId: tech.id, username: tech.username, role: "TECHNICIAN" });

  const client = await prisma.client.create({ data: { name: "DocExp Client" } });
  clientId = client.id;

  // Create an expense to upload document for
  const expense = await prisma.expense.create({
    data: {
      category: "REPAIR",
      name: "Запчасти",
      amount: new Decimal("4200"),
      expenseDate: new Date(),
      approved: true,
    },
  });
  expenseId = expense.id;
});

afterAll(async () => {
  await prisma.$disconnect();
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = TEST_DB_PATH + suffix;
    if (fs.existsSync(f)) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }
  // Clean up upload directory
  const uploadDir = path.resolve(__dirname, "../../uploads/expenses");
  if (fs.existsSync(uploadDir)) {
    fs.rmSync(uploadDir, { recursive: true, force: true });
  }
});

describe("POST /api/expenses/:id/document", () => {
  it("rejects wrong file type (.exe) — 400", async () => {
    const fakeExe = Buffer.from("MZ fake exe content");
    const res = await request(app)
      .post(`/api/expenses/${expenseId}/document`)
      .set(AUTH_SA())
      .attach("document", fakeExe, { filename: "malware.exe", contentType: "application/x-msdownload" });
    expect(res.status).toBe(400);
  });

  it("rejects file exceeding 5 MB — 413 or 400", async () => {
    // Create a 6 MB buffer
    const bigFile = Buffer.alloc(6 * 1024 * 1024, "x");
    const res = await request(app)
      .post(`/api/expenses/${expenseId}/document`)
      .set(AUTH_SA())
      .attach("document", bigFile, { filename: "big.jpg", contentType: "image/jpeg" });
    expect([400, 413]).toContain(res.status);
  });

  it("uploads PDF document successfully", async () => {
    const fakePdf = Buffer.from("%PDF-1.4 fake pdf content");
    const res = await request(app)
      .post(`/api/expenses/${expenseId}/document`)
      .set(AUTH_SA())
      .attach("document", fakePdf, { filename: "receipt.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(200);
    expect(res.body.documentUrl).toBeTruthy();
    expect(typeof res.body.documentUrl).toBe("string");
  });

  it("serves uploaded document via GET", async () => {
    // M1: Use valid PNG magic bytes (89 50 4E 47 = \x89PNG)
    const validPng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("fake png content"),
    ]);
    const uploadRes = await request(app)
      .post(`/api/expenses/${expenseId}/document`)
      .set(AUTH_SA())
      .attach("document", validPng, { filename: "invoice.png", contentType: "image/png" });
    expect(uploadRes.status).toBe(200);

    const res = await request(app)
      .get(`/api/expenses/${expenseId}/document`)
      .set(AUTH_WH());
    expect(res.status).toBe(200);
  });

  it("deletes document via DELETE", async () => {
    // M1: Use valid PNG magic bytes
    const validPng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("fake png for delete"),
    ]);
    await request(app)
      .post(`/api/expenses/${expenseId}/document`)
      .set(AUTH_SA())
      .attach("document", validPng, { filename: "delete-me.png", contentType: "image/png" });

    const delRes = await request(app)
      .delete(`/api/expenses/${expenseId}/document`)
      .set(AUTH_SA());
    expect(delRes.status).toBe(200);

    // After delete, documentUrl should be null in DB
    const updated = await prisma.expense.findUnique({ where: { id: expenseId }, select: { documentUrl: true } });
    expect(updated?.documentUrl).toBeNull();
  });
});
