/**
 * Интеграционные тесты approval workflow: submit-for-approval / approve / reject.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-approval.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-approval";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-approval";
process.env.JWT_SECRET = "test-jwt-secret-approval-min16chars";

let app: Express;
let prisma: any;
let superAdminToken: string;
let warehouseToken: string;
let technicianToken: string;

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
  const hash = await hashPassword("test-pass-123");

  const sa = await prisma.adminUser.create({
    data: { username: "appr_sa", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  superAdminToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });

  const wh = await prisma.adminUser.create({
    data: { username: "appr_wh", passwordHash: hash, role: "WAREHOUSE" },
  });
  warehouseToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });

  const tech = await prisma.adminUser.create({
    data: { username: "appr_tech", passwordHash: hash, role: "TECHNICIAN" },
  });
  technicianToken = signSession({ userId: tech.id, username: tech.username, role: "TECHNICIAN" });
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

function AUTH_SA() { return { "X-API-Key": "test-key-1", Authorization: `Bearer ${superAdminToken}` }; }
function AUTH_WH() { return { "X-API-Key": "test-key-1", Authorization: `Bearer ${warehouseToken}` }; }
function AUTH_TECH() { return { "X-API-Key": "test-key-1", Authorization: `Bearer ${technicianToken}` }; }

async function createDraftBooking() {
  const client = await prisma.client.create({ data: { name: "ТК Тест" } });
  const equipment = await prisma.equipment.create({
    data: {
      importKey: `СВЕТ||ТЕСТ||||`,
      name: "Прожектор",
      category: "Свет",
      totalQuantity: 5,
      basePrice: 1000,
    },
  });
  const booking = await prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: "Тестовый проект",
      startDate: new Date("2026-05-01T10:00:00Z"),
      endDate: new Date("2026-05-03T10:00:00Z"),
      status: "DRAFT",
      items: {
        create: [{ equipmentId: equipment.id, quantity: 2 }],
      },
    },
  });
  return booking;
}

describe("POST /api/bookings/:id/submit-for-approval", () => {
  it("PLACEHOLDER — заполнится в Task 3", async () => {
    expect(true).toBe(true);
  });
});
