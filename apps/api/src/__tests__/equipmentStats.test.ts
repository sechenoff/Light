/**
 * Интеграционные тесты /api/equipment-stats
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-equipment-stats.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1,test-key-2";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-eqstats";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-eqstats";
process.env.JWT_SECRET = "test-jwt-secret-eqstats-min16chars";

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
    data: { username: "eqstats_sa", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  superAdminToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });

  const wh = await prisma.adminUser.create({
    data: { username: "eqstats_wh", passwordHash: hash, role: "WAREHOUSE" },
  });
  warehouseToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });

  const tech = await prisma.adminUser.create({
    data: { username: "eqstats_tech", passwordHash: hash, role: "TECHNICIAN" },
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

describe("GET /api/equipment-stats — access control", () => {
  it("returns 403 for TECHNICIAN", async () => {
    const res = await request(app).get("/api/equipment-stats").set(AUTH_TECH());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN_BY_ROLE");
  });

  it("returns 403 for WAREHOUSE", async () => {
    const res = await request(app).get("/api/equipment-stats").set(AUTH_WH());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN_BY_ROLE");
  });

  it("returns 200 with empty arrays and zero KPI when DB is empty", async () => {
    const res = await request(app).get("/api/equipment-stats").set(AUTH_SA());
    expect(res.status).toBe(200);
    expect(res.body.period).toBe("90d");
    expect(res.body.kpi).toMatchObject({
      activeCount: 0,
      dormantCount: 0,
      totalCount: 0,
      revenueRub: "0",
      repairCostRub: "0",
    });
    expect(res.body.demand).toEqual([]);
    expect(res.body.deadStock).toEqual([]);
    expect(res.body.revenue).toEqual([]);
    expect(res.body.quality).toEqual([]);
    expect(res.body.table).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────
// Seed helpers reused across multi-task scenarios
// ──────────────────────────────────────────────────────────────────

async function clearScenario() {
  // Delete in FK-safe order
  await prisma.estimateLine.deleteMany();
  await prisma.estimate.deleteMany();
  await prisma.bookingItemUnit.deleteMany();
  await prisma.bookingItem.deleteMany();
  await prisma.expense.deleteMany();
  await prisma.problemItem.deleteMany();
  await prisma.repair.deleteMany();
  await prisma.booking.deleteMany();
  await prisma.equipmentUnit.deleteMany();
  await prisma.equipment.deleteMany();
  await prisma.client.deleteMany();
}

async function makeEquipment(opts: { name: string; category?: string; totalQuantity: number; rate: number }) {
  return prisma.equipment.create({
    data: {
      importKey: `${opts.category ?? "Свет"}||${opts.name.toUpperCase()}||||`,
      name: opts.name,
      category: opts.category ?? "Свет",
      totalQuantity: opts.totalQuantity,
      stockTrackingMode: "COUNT",
      rentalRatePerShift: opts.rate,
    },
  });
}

async function makeClient(name = "Тестовый клиент") {
  return prisma.client.create({ data: { name } });
}

type SeedBookingItem = { equipmentId: string | null; equipmentName?: string; category?: string; quantity: number; unitPrice: number };

async function makeBooking(opts: {
  clientId: string;
  projectName: string;
  status: "DRAFT" | "PENDING_APPROVAL" | "CONFIRMED" | "ISSUED" | "RETURNED" | "CANCELLED";
  startDaysAgo: number;
  endDaysAgo: number;
  items: SeedBookingItem[];
  withEstimate?: boolean; // default true when status not DRAFT
}) {
  const now = Date.now();
  const startDate = new Date(now - opts.startDaysAgo * 24 * 60 * 60 * 1000);
  const endDate = new Date(now - opts.endDaysAgo * 24 * 60 * 60 * 1000);
  const shifts = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000)));
  const subtotal = opts.items.reduce((acc, it) => acc + it.quantity * it.unitPrice * shifts, 0);

  const booking = await prisma.booking.create({
    data: {
      clientId: opts.clientId,
      projectName: opts.projectName,
      startDate,
      endDate,
      status: opts.status,
      finalAmount: subtotal,
      totalEstimateAmount: subtotal,
    },
  });

  for (const item of opts.items) {
    await prisma.bookingItem.create({
      data: {
        bookingId: booking.id,
        equipmentId: item.equipmentId,
        quantity: item.quantity,
        customName: item.equipmentId === null ? (item.equipmentName ?? "Кастомная позиция") : null,
        customCategory: item.equipmentId === null ? (item.category ?? "Свет") : null,
        customUnitPrice: item.equipmentId === null ? item.unitPrice : null,
      },
    });
  }

  const wantEstimate = opts.withEstimate ?? (opts.status !== "DRAFT");
  if (wantEstimate) {
    const est = await prisma.estimate.create({
      data: {
        bookingId: booking.id,
        kind: "MAIN",
        shifts,
        subtotal,
        discountAmount: 0,
        totalAfterDiscount: subtotal,
      },
    });
    for (const item of opts.items) {
      await prisma.estimateLine.create({
        data: {
          estimateId: est.id,
          equipmentId: item.equipmentId,
          categorySnapshot: item.category ?? "Свет",
          nameSnapshot: item.equipmentName ?? "(catalog)",
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          lineSum: item.quantity * item.unitPrice * shifts,
        },
      });
    }
  }
  return booking;
}

// ──────────────────────────────────────────────────────────────────
// Master-table — catalog visibility
// ──────────────────────────────────────────────────────────────────

describe("GET /api/equipment-stats — master table", () => {
  it("lists every catalog equipment row even when nothing is rented", async () => {
    await clearScenario();
    await makeEquipment({ name: "Прожектор Aputure", totalQuantity: 5, rate: 1000 });
    await makeEquipment({ name: "Тренога Manfrotto", totalQuantity: 3, rate: 500 });

    const res = await request(app).get("/api/equipment-stats").set(AUTH_SA());
    expect(res.status).toBe(200);
    expect(res.body.table).toHaveLength(2);
    expect(res.body.table.map((r: any) => r.name).sort()).toEqual(["Прожектор Aputure", "Тренога Manfrotto"]);
    expect(res.body.kpi.totalCount).toBe(2);
    expect(res.body.kpi.dormantCount).toBe(2);
    expect(res.body.kpi.activeCount).toBe(0);
  });
});

describe("GET /api/equipment-stats — demand", () => {
  it("counts distinct bookings and qty×shifts per equipment in the window", async () => {
    await clearScenario();
    const apu = await makeEquipment({ name: "Прожектор Aputure", totalQuantity: 5, rate: 1000 });
    const man = await makeEquipment({ name: "Тренога Manfrotto", totalQuantity: 3, rate: 500 });
    const client = await makeClient("Клиент A");

    // B1: CONFIRMED, last 10..8 days (2 shifts), apu×2 + man×1
    await makeBooking({
      clientId: client.id,
      projectName: "Проект 1",
      status: "CONFIRMED",
      startDaysAgo: 10,
      endDaysAgo: 8,
      items: [
        { equipmentId: apu.id, equipmentName: apu.name, quantity: 2, unitPrice: 1000 },
        { equipmentId: man.id, equipmentName: man.name, quantity: 1, unitPrice: 500 },
      ],
    });
    // B2: ISSUED, last 5..3 days (2 shifts), apu×1
    await makeBooking({
      clientId: client.id,
      projectName: "Проект 2",
      status: "ISSUED",
      startDaysAgo: 5,
      endDaysAgo: 3,
      items: [{ equipmentId: apu.id, equipmentName: apu.name, quantity: 1, unitPrice: 1000 }],
    });
    // B3: CANCELLED → must be excluded
    await makeBooking({
      clientId: client.id,
      projectName: "Проект 3 (отменён)",
      status: "CANCELLED",
      startDaysAgo: 2,
      endDaysAgo: 1,
      items: [{ equipmentId: apu.id, equipmentName: apu.name, quantity: 9, unitPrice: 1000 }],
    });

    const res = await request(app).get("/api/equipment-stats?period=90").set(AUTH_SA());
    expect(res.status).toBe(200);

    const tableById = new Map<string, any>(res.body.table.map((r: any) => [r.id, r]));
    expect(tableById.get(apu.id).bookingsCount).toBe(2);   // B1 + B2
    expect(tableById.get(apu.id).qtyShifts).toBe(2 * 2 + 1 * 2); // = 6
    expect(tableById.get(man.id).bookingsCount).toBe(1);   // B1
    expect(tableById.get(man.id).qtyShifts).toBe(1 * 2);   // = 2

    expect(res.body.demand).toHaveLength(2);
    expect(res.body.demand[0].id).toBe(apu.id);  // top = Aputure (2 bookings)
    expect(res.body.demand[1].id).toBe(man.id);

    expect(res.body.kpi.activeCount).toBe(2);
    expect(res.body.kpi.dormantCount).toBe(0);
  });
});
