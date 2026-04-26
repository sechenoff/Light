/**
 * B5 — Интеграционные тесты GET /api/bookings/:id/related-expenses
 *
 * Проверяет прямые и косвенно связанные (через Repair) расходы по броне.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import Decimal from "decimal.js";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-related-expenses.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-re";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-related-expenses";
process.env.WAREHOUSE_SECRET = "test-wh-re";
process.env.JWT_SECRET = "test-jwt-secret-related-expenses-16";

let app: Express;
let prisma: any;
let superAdminToken: string;
let warehouseToken: string;
let technicianToken: string;
let clientId: string;
let equipmentId: string;

function AUTH_SA() {
  return { "X-API-Key": "test-key-re", Authorization: `Bearer ${superAdminToken}` };
}
function AUTH_WH() {
  return { "X-API-Key": "test-key-re", Authorization: `Bearer ${warehouseToken}` };
}
function AUTH_TECH() {
  return { "X-API-Key": "test-key-re", Authorization: `Bearer ${technicianToken}` };
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
    data: { username: "re_super", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  superAdminToken = signSession({ userId: admin.id, username: admin.username, role: "SUPER_ADMIN" });

  const wh = await prisma.adminUser.create({
    data: { username: "re_wh", passwordHash: hash, role: "WAREHOUSE" },
  });
  warehouseToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });

  const tech = await prisma.adminUser.create({
    data: { username: "re_tech", passwordHash: hash, role: "TECHNICIAN" },
  });
  technicianToken = signSession({ userId: tech.id, username: tech.username, role: "TECHNICIAN" });

  const client = await prisma.client.create({ data: { name: "RelExp Client" } });
  clientId = client.id;

  const eq = await prisma.equipment.create({
    data: {
      importKey: "re-skylight-60",
      category: "Свет",
      name: "Скайлайт 60",
      totalQuantity: 2,
      rentalRatePerShift: new Decimal("5000"),
    },
  });
  equipmentId = eq.id;
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

describe("GET /api/bookings/:id/related-expenses", () => {
  it("returns empty list when booking has no expenses", async () => {
    const booking = await prisma.booking.create({
      data: {
        clientId,
        projectName: "RelExp Empty",
        startDate: new Date("2025-03-01"),
        endDate: new Date("2025-03-05"),
        status: "CONFIRMED",
      },
    });

    const res = await request(app)
      .get(`/api/bookings/${booking.id}/related-expenses`)
      .set(AUTH_SA());
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.total).toBe("0.00");
  });

  it("returns direct expenses with source=DIRECT", async () => {
    const booking = await prisma.booking.create({
      data: {
        clientId,
        projectName: "RelExp Direct",
        startDate: new Date("2025-04-01"),
        endDate: new Date("2025-04-05"),
        status: "RETURNED",
      },
    });

    const expense = await prisma.expense.create({
      data: {
        bookingId: booking.id,
        category: "TRANSPORT",
        name: "Доставка",
        amount: new Decimal("8000"),
        expenseDate: new Date("2025-04-02"),
        description: "Газель до площадки",
        approved: true,
      },
    });

    const res = await request(app)
      .get(`/api/bookings/${booking.id}/related-expenses`)
      .set(AUTH_SA());
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe(expense.id);
    expect(res.body.items[0].source).toBe("DIRECT");
    expect(new Decimal(res.body.total).toFixed(2)).toBe("8000.00");
  });

  it("returns repair-linked expenses with source=REPAIR_LINKED", async () => {
    const now = new Date();
    const bookingStart = new Date(now.getTime() - 10 * 86400000); // 10 days ago
    const bookingEnd = new Date(now.getTime() - 5 * 86400000);   // 5 days ago
    const booking = await prisma.booking.create({
      data: {
        clientId,
        projectName: "RelExp Repair",
        startDate: bookingStart,
        endDate: bookingEnd,
        status: "RETURNED",
      },
    });

    // Create an equipment unit
    const unit = await prisma.equipmentUnit.create({
      data: { equipmentId, status: "AVAILABLE" },
    });

    // Create a BookingItem + BookingItemUnit to link unit to booking
    const item = await prisma.bookingItem.create({
      data: { bookingId: booking.id, equipmentId, quantity: 1 },
    });
    await prisma.bookingItemUnit.create({
      data: { bookingItemId: item.id, equipmentUnitId: unit.id },
    });

    // Create a Repair on that unit sourced from this booking (createdAt within booking date window)
    const repairCreatedAt = new Date(booking.startDate.getTime() + 2 * 86400000); // booking + 2 days
    const repair = await prisma.repair.create({
      data: {
        unitId: unit.id,
        status: "CLOSED",
        urgency: "NORMAL",
        reason: "Сломался прожектор",
        sourceBookingId: booking.id,
        createdBy: "re_super",
        closedAt: new Date(repairCreatedAt.getTime() + 86400000),
        createdAt: repairCreatedAt,
      },
    });

    // Expense linked to the repair
    const repairExpense = await prisma.expense.create({
      data: {
        category: "REPAIR",
        name: "Запчасть",
        amount: new Decimal("3500"),
        expenseDate: new Date("2025-05-06"),
        linkedRepairId: repair.id,
        approved: true,
      },
    });

    // D3: endpoint is now SA-only — verify via SA
    const res = await request(app)
      .get(`/api/bookings/${booking.id}/related-expenses`)
      .set(AUTH_SA());
    expect(res.status).toBe(200);
    const repairItem = res.body.items.find((e: any) => e.id === repairExpense.id);
    expect(repairItem).toBeDefined();
    expect(repairItem.source).toBe("REPAIR_LINKED");
    expect(repairItem.linkedRepairId).toBe(repair.id); // D4: linkedRepairId included in response
    expect(new Decimal(res.body.total).gte(new Decimal("3500"))).toBe(true);
  });

  it("WAREHOUSE cannot access related expenses — 403 (D3: SA-only)", async () => {
    const booking = await prisma.booking.create({
      data: {
        clientId,
        projectName: "RelExp WH Forbidden",
        startDate: new Date("2025-06-01"),
        endDate: new Date("2025-06-05"),
        status: "CONFIRMED",
      },
    });

    const res = await request(app)
      .get(`/api/bookings/${booking.id}/related-expenses`)
      .set(AUTH_WH());
    expect(res.status).toBe(403);
  });

  it("TECHNICIAN cannot access related expenses — 403", async () => {
    const booking = await prisma.booking.create({
      data: {
        clientId,
        projectName: "RelExp Tech",
        startDate: new Date("2025-06-01"),
        endDate: new Date("2025-06-05"),
        status: "CONFIRMED",
      },
    });

    const res = await request(app)
      .get(`/api/bookings/${booking.id}/related-expenses`)
      .set(AUTH_TECH());
    expect(res.status).toBe(403);
  });
});
