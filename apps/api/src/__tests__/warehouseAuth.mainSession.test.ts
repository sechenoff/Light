/**
 * Интеграционный тест: warehouseAuth принимает main session как fallback.
 *
 * - SUPER_ADMIN с main session (без warehouse_token) → 200 на /api/warehouse/bookings
 * - WAREHOUSE с main session (без warehouse_token) → 200 на /api/warehouse/bookings
 * - TECHNICIAN с main session (без warehouse_token) → 401 на /api/warehouse/bookings
 * - Без main session и без warehouse_token → 401 на /api/warehouse/bookings
 * - Валидный warehouse_token (без main session) → 200 (legacy path сохранён)
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-wh-main-session.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-wh-main";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-wh-main";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-wh-main";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-secret-wh-main-min16";

let app: Express;
let prisma: any;

let superAdminToken: string;
let warehouseToken: string;
let technicianToken: string;
let warehouseWorkerToken: string; // PIN-based token for legacy path

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
  const { hashPin, generateToken } = await import("../services/warehouseAuth");
  const hash = await hashPassword("test-password-wh-main");

  const superAdmin = await prisma.adminUser.create({
    data: { username: "sa_wh_main", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  const warehouse = await prisma.adminUser.create({
    data: { username: "wh_wh_main", passwordHash: hash, role: "WAREHOUSE" },
  });
  const technician = await prisma.adminUser.create({
    data: { username: "tech_wh_main", passwordHash: hash, role: "TECHNICIAN" },
  });

  superAdminToken = signSession({ userId: superAdmin.id, username: superAdmin.username, role: "SUPER_ADMIN" });
  warehouseToken = signSession({ userId: warehouse.id, username: warehouse.username, role: "WAREHOUSE" });
  technicianToken = signSession({ userId: technician.id, username: technician.username, role: "TECHNICIAN" });

  // Создаём PIN-сотрудника склада для теста legacy path
  const pinHash = await hashPin("1234");
  await prisma.warehousePin.create({
    data: { name: "Тест Кладовщик", pinHash, isActive: true },
  });
  warehouseWorkerToken = generateToken("Тест Кладовщик");
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

describe("warehouseAuth fallback to main session", () => {
  it("SUPER_ADMIN с main session (без warehouse_token) → 200 на /api/warehouse/bookings", async () => {
    const res = await request(app)
      .get("/api/warehouse/bookings?operation=ISSUE")
      .set("Authorization", `Bearer ${superAdminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("bookings");
  });

  it("WAREHOUSE с main session (без warehouse_token) → 200 на /api/warehouse/bookings", async () => {
    const res = await request(app)
      .get("/api/warehouse/bookings?operation=ISSUE")
      .set("Authorization", `Bearer ${warehouseToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("bookings");
  });

  it("TECHNICIAN с main session (без warehouse_token) → 401 на /api/warehouse/bookings", async () => {
    const res = await request(app)
      .get("/api/warehouse/bookings?operation=ISSUE")
      .set("Authorization", `Bearer ${technicianToken}`);
    expect(res.status).toBe(401);
  });

  it("Без main session и без warehouse_token → 401 на /api/warehouse/bookings", async () => {
    const res = await request(app)
      .get("/api/warehouse/bookings?operation=ISSUE");
    expect(res.status).toBe(401);
  });

  it("Валидный warehouse PIN-token (без main session) → 200 (legacy path)", async () => {
    const res = await request(app)
      .get("/api/warehouse/bookings?operation=ISSUE")
      .set("Authorization", `Bearer ${warehouseWorkerToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("bookings");
  });
});
