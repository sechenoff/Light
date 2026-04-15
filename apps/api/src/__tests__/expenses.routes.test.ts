/**
 * Smoke tests for /api/expenses.
 * Sprint 3: expenses router — SUPER_ADMIN + TECHNICIAN POST; остальное — SUPER_ADMIN.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-expenses-routes.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-expenses";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-expenses";
process.env.WAREHOUSE_SECRET = "test-warehouse-expenses";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-secret-expenses-min16chars";

let app: Express;
let prisma: any;

let superAdminToken: string;
let warehouseToken: string;
let technicianToken: string;

let superAdminId: string;
let technicianId: string;
let unapprovedExpenseId: string;

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
  const hash = await hashPassword("expenses-test-pass");

  const superAdmin = await prisma.adminUser.create({
    data: { username: "expenses_super", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  const warehouse = await prisma.adminUser.create({
    data: { username: "expenses_warehouse", passwordHash: hash, role: "WAREHOUSE" },
  });
  const technician = await prisma.adminUser.create({
    data: { username: "expenses_technician", passwordHash: hash, role: "TECHNICIAN" },
  });

  superAdminId = superAdmin.id;
  technicianId = technician.id;

  superAdminToken = signSession({ userId: superAdmin.id, username: superAdmin.username, role: "SUPER_ADMIN" });
  warehouseToken = signSession({ userId: warehouse.id, username: warehouse.username, role: "WAREHOUSE" });
  technicianToken = signSession({ userId: technician.id, username: technician.username, role: "TECHNICIAN" });
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

const apiKey = { "X-API-Key": "test-key-expenses" };
function authHeaders(token: string) {
  return { ...apiKey, "Authorization": `Bearer ${token}` };
}

describe("/api/expenses", () => {
  it("401 UNAUTHENTICATED — нет сессии, только API-ключ", async () => {
    const res = await request(app)
      .post("/api/expenses")
      .set(apiKey)
      .send({
        date: new Date().toISOString(),
        category: "REPAIR",
        amount: 500,
        description: "Тест",
      });
    expect(res.status).toBe(401);
    expect(res.body.details).toBe("UNAUTHENTICATED");
  });

  it("403 FORBIDDEN_BY_ROLE — WAREHOUSE не может создавать расходы", async () => {
    const res = await request(app)
      .post("/api/expenses")
      .set(authHeaders(warehouseToken))
      .send({
        date: new Date().toISOString(),
        category: "REPAIR",
        amount: 500,
        description: "Тест",
      });
    expect(res.status).toBe(403);
    expect(res.body.details).toBe("FORBIDDEN_BY_ROLE");
  });

  it("201 TECHNICIAN + category=REPAIR → approved=false, AuditEntry записана", async () => {
    const res = await request(app)
      .post("/api/expenses")
      .set(authHeaders(technicianToken))
      .send({
        date: new Date().toISOString(),
        category: "REPAIR",
        amount: 350,
        description: "Замена линзы",
      });
    expect(res.status).toBe(201);
    expect(res.body.expense.approved).toBe(false);
    unapprovedExpenseId = res.body.expense.id;

    const audit = await prisma.auditEntry.findFirst({
      where: { entityType: "Expense", action: "EXPENSE_CREATE", userId: technicianId },
    });
    expect(audit).not.toBeNull();
  });

  it("403 EXPENSE_CATEGORY_FORBIDDEN — TECHNICIAN + category=OTHER", async () => {
    const res = await request(app)
      .post("/api/expenses")
      .set(authHeaders(technicianToken))
      .send({
        date: new Date().toISOString(),
        category: "OTHER",
        amount: 200,
        description: "Прочее",
      });
    expect(res.status).toBe(403);
    expect(res.body.details).toBe("EXPENSE_CATEGORY_FORBIDDEN");
  });

  it("201 SUPER_ADMIN + category=OTHER → approved=true", async () => {
    const res = await request(app)
      .post("/api/expenses")
      .set(authHeaders(superAdminToken))
      .send({
        date: new Date().toISOString(),
        category: "OTHER",
        amount: 1000,
        description: "Офисные расходы",
      });
    expect(res.status).toBe(201);
    expect(res.body.expense.approved).toBe(true);
  });

  it("200 POST /:id/approve — SUPER_ADMIN одобряет ранее созданный расход техника", async () => {
    const res = await request(app)
      .post(`/api/expenses/${unapprovedExpenseId}/approve`)
      .set(authHeaders(superAdminToken));
    expect(res.status).toBe(200);
    expect(res.body.expense.approved).toBe(true);
  });

  it("409 повторное одобрение уже одобренного расхода", async () => {
    const res = await request(app)
      .post(`/api/expenses/${unapprovedExpenseId}/approve`)
      .set(authHeaders(superAdminToken));
    expect(res.status).toBe(409);
  });
});
