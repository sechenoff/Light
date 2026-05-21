/**
 * Route-level test (Task 6 — issue-stock-cap-and-unit-removal):
 * `GET /api/warehouse/sessions/:id/addon-search` ДОЛЖЕН возвращать `addCap`
 * в каждом результате — UI использует это как верхнюю границу для picker'а.
 *
 * Формула: addCap = max(0, row.availableQuantity − alreadyInThisBooking).
 *  - `row.availableQuantity` уже исключает текущую бронь через `excludeBookingId`
 *    в getAvailability.
 *  - `alreadyInThisBooking` = BookingItem.quantity для текущего booking × equipmentId.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

const TEST_DB_PATH = path.resolve(__dirname, "../../../prisma/test-addon-search-route.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-addon-search-route";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-addon-search-route";
process.env.WAREHOUSE_SECRET = "test-warehouse-addon-search-1";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-addon-search-route-min16";

let app: any;
let prisma: any;
let warehouseToken: string;

// Scenario 1: totalQty=5, other booking holds 1, this booking holds 2 → addCap=2.
let sessionPartialId: string;
let eqPartialId: string;

// Scenario 2: totalQty=3, other booking holds 1, this booking holds 2 → addCap=0.
let sessionExhaustedId: string;
let eqExhaustedId: string;

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
    data: { name: "Тест addon-search route", pinHash, isActive: true },
  });

  const authRes = await request(app)
    .post("/api/warehouse/auth")
    .send({ name: "Тест addon-search route", pin: "1234" });
  warehouseToken = authRes.body.token;

  const client = await prisma.client.create({
    data: { name: "addon-search клиент", phone: "+70000000555" },
  });

  // ── Scenario 1: addCap=2 ──────────────────────────────────────────────────────
  // totalQty=5, other CONFIRMED booking holds 1, this booking holds 2.
  // availableQuantity (exclude this) = 5 − 1 = 4. addCap = 4 − 2 = 2.
  const eqPartial = await prisma.equipment.create({
    data: {
      importKey: "addon-search-partial",
      name: "TestPartialLight",
      category: "Свет",
      rentalRatePerShift: 1000,
      stockTrackingMode: "COUNT",
      totalQuantity: 5,
    },
  });
  eqPartialId = eqPartial.id;

  const otherBookingPartial = await prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: "Other booking — partial",
      startDate: new Date("2026-07-01"),
      endDate: new Date("2026-07-05"),
      status: "CONFIRMED",
      amountPaid: 0,
      amountOutstanding: 0,
    },
  });
  await prisma.bookingItem.create({
    data: { bookingId: otherBookingPartial.id, equipmentId: eqPartialId, quantity: 1 },
  });

  const thisBookingPartial = await prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: "This booking — partial",
      startDate: new Date("2026-07-03"),
      endDate: new Date("2026-07-04"),
      status: "CONFIRMED",
      amountPaid: 0,
      amountOutstanding: 0,
    },
  });
  await prisma.bookingItem.create({
    data: { bookingId: thisBookingPartial.id, equipmentId: eqPartialId, quantity: 2 },
  });

  const sessionPartial = await prisma.scanSession.create({
    data: {
      bookingId: thisBookingPartial.id,
      workerName: "Тест addon-search route",
      operation: "ISSUE",
      status: "ACTIVE",
    },
  });
  sessionPartialId = sessionPartial.id;

  // ── Scenario 2: addCap=0 ──────────────────────────────────────────────────────
  // totalQty=3, other CONFIRMED holds 1, this booking holds 2.
  // availableQuantity (exclude this) = 3 − 1 = 2. addCap = 2 − 2 = 0.
  const eqExhausted = await prisma.equipment.create({
    data: {
      importKey: "addon-search-exhausted",
      name: "TestExhaustedLight",
      category: "Свет",
      rentalRatePerShift: 1000,
      stockTrackingMode: "COUNT",
      totalQuantity: 3,
    },
  });
  eqExhaustedId = eqExhausted.id;

  const otherBookingEx = await prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: "Other booking — exhausted",
      startDate: new Date("2026-08-01"),
      endDate: new Date("2026-08-05"),
      status: "CONFIRMED",
      amountPaid: 0,
      amountOutstanding: 0,
    },
  });
  await prisma.bookingItem.create({
    data: { bookingId: otherBookingEx.id, equipmentId: eqExhaustedId, quantity: 1 },
  });

  const thisBookingEx = await prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: "This booking — exhausted",
      startDate: new Date("2026-08-03"),
      endDate: new Date("2026-08-04"),
      status: "CONFIRMED",
      amountPaid: 0,
      amountOutstanding: 0,
    },
  });
  await prisma.bookingItem.create({
    data: { bookingId: thisBookingEx.id, equipmentId: eqExhaustedId, quantity: 2 },
  });

  const sessionEx = await prisma.scanSession.create({
    data: {
      bookingId: thisBookingEx.id,
      workerName: "Тест addon-search route",
      operation: "ISSUE",
      status: "ACTIVE",
    },
  });
  sessionExhaustedId = sessionEx.id;
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

describe("GET /api/warehouse/sessions/:id/addon-search — addCap per row", () => {
  it("returns addCap per row, accounting for alreadyInBooking", async () => {
    // totalQty=5, other=1, this=2 → availableQuantity=4 (excl. this), addCap=2.
    const res = await request(app)
      .get(`/api/warehouse/sessions/${sessionPartialId}/addon-search?q=TestPartialLight`)
      .set("Authorization", `Bearer ${warehouseToken}`);

    expect(res.status).toBe(200);
    const row = res.body.results.find((r: any) => r.equipmentId === eqPartialId);
    expect(row).toBeDefined();
    expect(row.availableQuantity).toBe(4);
    expect(row.addCap).toBe(2);
  });

  it("returns addCap=0 when this booking already holds the remaining stock", async () => {
    // totalQty=3, other=1, this=2 → availableQuantity=2 (excl. this), addCap=0.
    const res = await request(app)
      .get(`/api/warehouse/sessions/${sessionExhaustedId}/addon-search?q=TestExhaustedLight`)
      .set("Authorization", `Bearer ${warehouseToken}`);

    expect(res.status).toBe(200);
    const row = res.body.results.find((r: any) => r.equipmentId === eqExhaustedId);
    expect(row).toBeDefined();
    expect(row.availableQuantity).toBe(2);
    expect(row.addCap).toBe(0);
  });
});
