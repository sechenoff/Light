/**
 * Smoke tests for GET /api/audit.
 * Sprint 2: audit log endpoint, SUPER_ADMIN only.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-audit-routes.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-audit";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-audit";
process.env.WAREHOUSE_SECRET = "test-warehouse-audit";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-secret-audit-min-16chars";

let app: Express;
let prisma: any;

let superAdminToken: string;
let warehouseToken: string;

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
  const hash = await hashPassword("audit-test-pass");

  const superAdmin = await prisma.adminUser.create({
    data: { username: "audit_super", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  const warehouse = await prisma.adminUser.create({
    data: { username: "audit_warehouse", passwordHash: hash, role: "WAREHOUSE" },
  });

  superAdminToken = signSession({ userId: superAdmin.id, username: superAdmin.username, role: "SUPER_ADMIN" });
  warehouseToken = signSession({ userId: warehouse.id, username: warehouse.username, role: "WAREHOUSE" });

  // Создаём 3 записи аудита последовательно (небольшая пауза для уникальности createdAt)
  const now = Date.now();
  await prisma.auditEntry.create({
    data: { userId: superAdmin.id, action: "BOOKING_CREATE", entityType: "Booking", entityId: "b1", before: null, after: null, createdAt: new Date(now) },
  });
  await prisma.auditEntry.create({
    data: { userId: superAdmin.id, action: "BOOKING_UPDATE", entityType: "Booking", entityId: "b2", before: null, after: null, createdAt: new Date(now + 1) },
  });
  await prisma.auditEntry.create({
    data: { userId: superAdmin.id, action: "PAYMENT_CREATE", entityType: "Payment", entityId: "p1", before: null, after: null, createdAt: new Date(now + 2) },
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

const apiKey = { "X-API-Key": "test-key-audit" };
function authHeaders(token: string) {
  return { ...apiKey, "Authorization": `Bearer ${token}` };
}

describe("GET /api/audit", () => {
  it("SUPER_ADMIN → 200 + 3 items", async () => {
    const res = await request(app)
      .get("/api/audit")
      .set(authHeaders(superAdminToken));
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(3);
    expect(res.body.nextCursor).toBeNull();
  });

  it("WAREHOUSE → 403 FORBIDDEN_BY_ROLE", async () => {
    const res = await request(app)
      .get("/api/audit")
      .set(authHeaders(warehouseToken));
    expect(res.status).toBe(403);
    expect(res.body.details).toBe("FORBIDDEN_BY_ROLE");
  });

  it("SUPER_ADMIN → filter by entityType=Payment → 1 item", async () => {
    const res = await request(app)
      .get("/api/audit?entityType=Payment")
      .set(authHeaders(superAdminToken));
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].entityType).toBe("Payment");
  });

  it("SUPER_ADMIN → cursor pagination with limit=2", async () => {
    const first = await request(app)
      .get("/api/audit?limit=2")
      .set(authHeaders(superAdminToken));
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).not.toBeNull();

    const second = await request(app)
      .get(`/api/audit?limit=2&cursor=${first.body.nextCursor}`)
      .set(authHeaders(superAdminToken));
    expect(second.status).toBe(200);
    expect(second.body.items).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();
  });
});
