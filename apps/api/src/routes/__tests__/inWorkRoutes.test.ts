/**
 * Route-level integration tests:
 *  - GET /api/warehouse/in-work — список ISSUED-броней с isOverdue/overdueDays.
 *  - GET /api/warehouse/in-work/:bookingId/details — read-only детали с items + finance.
 *
 * Today (план): 2026-05-22. Тестовая бронь endDate=2026-05-21 → overdue на 1 день.
 * Auth: Bearer warehouseToken (PIN-based), сидируем WarehousePin + ловим token через /auth.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

const TEST_DB_PATH = path.resolve(__dirname, "../../../prisma/test-in-work.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-in-work";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-in-work";
process.env.WAREHOUSE_SECRET = "test-warehouse-in-work-min16chars0";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-in-work-min16chars000000";

let app: any;
let prisma: any;
let warehouseToken: string;
let issuedBookingId: string;
let confirmedBookingId: string;

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../../.."),
    env: {
      ...process.env,
      DATABASE_URL: `file:${TEST_DB_PATH}`,
      PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes",
    },
    stdio: "pipe",
  });

  const pmod = await import("../../prisma");
  prisma = pmod.prisma;
  const { app: expressApp } = await import("../../app");
  app = expressApp;

  const { hashPin } = await import("../../services/warehouseAuth");
  const pinHash = await hashPin("1234");
  await prisma.warehousePin.create({
    data: { name: "Тест in-work route", pinHash, isActive: true },
  });

  const authRes = await request(app)
    .post("/api/warehouse/auth")
    .send({ name: "Тест in-work route", pin: "1234" });
  warehouseToken = authRes.body.token;

  const client = await prisma.client.create({
    data: { name: "ACME", phone: "+70000000002" },
  });

  const equipment = await prisma.equipment.create({
    data: {
      importKey: "in-work-eq",
      name: "Stand",
      category: "Acc",
      rentalRatePerShift: "100",
      totalQuantity: 10,
    },
  });

  // ISSUED booking with endDate < today (2026-05-22) → overdue.
  const issued = await prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: "Активная съёмка",
      startDate: new Date("2026-05-20"),
      endDate: new Date("2026-05-21"),
      status: "ISSUED",
      confirmedAt: new Date("2026-05-19"),
      finalAmount: "5000",
      amountPaid: "0",
      amountOutstanding: "5000",
      items: { create: [{ equipmentId: equipment.id, quantity: 3 }] },
    },
  });
  issuedBookingId = issued.id;

  // CONFIRMED (non-ISSUED) booking — должна быть исключена.
  const confirmed = await prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: "Только подтверждена",
      startDate: new Date("2026-05-25"),
      endDate: new Date("2026-05-26"),
      status: "CONFIRMED",
      items: { create: [{ equipmentId: equipment.id, quantity: 1 }] },
    },
  });
  confirmedBookingId = confirmed.id;
});

afterAll(async () => {
  await prisma?.$disconnect?.();
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = TEST_DB_PATH + suffix;
    if (fs.existsSync(f)) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
  }
});

describe("GET /api/warehouse/in-work", () => {
  it("returns only ISSUED bookings, sorted by endDate asc, isOverdue computed", async () => {
    const res = await request(app)
      .get("/api/warehouse/in-work")
      .set("Authorization", `Bearer ${warehouseToken}`);

    expect(res.status).toBe(200);
    expect(res.body.bookings).toHaveLength(1);
    const b = res.body.bookings[0];
    expect(b.bookingId).toBe(issuedBookingId);
    expect(b.projectName).toBe("Активная съёмка");
    expect(b.clientName).toBe("ACME");
    expect(b.itemsCount).toBe(1);
    expect(b.displayNo).toMatch(/^#[A-Z0-9]{6}$/);
    expect(b.isOverdue).toBe(true);
    expect(b.overdueDays).toBeGreaterThanOrEqual(1);
  });

  it("excludes non-ISSUED bookings", async () => {
    const res = await request(app)
      .get("/api/warehouse/in-work")
      .set("Authorization", `Bearer ${warehouseToken}`);

    const ids = res.body.bookings.map((b: any) => b.bookingId);
    expect(ids).not.toContain(confirmedBookingId);
  });

  it("returns 401 without auth token", async () => {
    const res = await request(app).get("/api/warehouse/in-work");
    expect(res.status).toBe(401);
  });
});

describe("GET /api/warehouse/in-work/:bookingId/details", () => {
  it("returns items + finance for ISSUED booking", async () => {
    const res = await request(app)
      .get(`/api/warehouse/in-work/${issuedBookingId}/details`)
      .set("Authorization", `Bearer ${warehouseToken}`);

    expect(res.status).toBe(200);
    expect(res.body.bookingId).toBe(issuedBookingId);
    expect(res.body.items).toBeInstanceOf(Array);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.finance.finalAmount).toBe("5000");
  });

  it("returns 404 for non-ISSUED booking", async () => {
    const res = await request(app)
      .get(`/api/warehouse/in-work/${confirmedBookingId}/details`)
      .set("Authorization", `Bearer ${warehouseToken}`);

    expect(res.status).toBe(404);
  });
});
