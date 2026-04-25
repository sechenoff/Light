/**
 * Интеграционные тесты маршрутов /api/invoices.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-invoices.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-inv";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-inv";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-inv";
process.env.JWT_SECRET = "test-jwt-secret-invoices-min16chars";

let app: Express;
let prisma: any;
let saToken: string;
let whToken: string;
let saUserId: string;

// Shared booking for tests that don't need FULL-invoice uniqueness
let bookingId: string;
let clientId: string;

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
  const hash = await hashPassword("test-pass");

  const sa = await prisma.adminUser.create({
    data: { username: "inv_sa", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  saUserId = sa.id;
  saToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });

  const wh = await prisma.adminUser.create({
    data: { username: "inv_wh", passwordHash: hash, role: "WAREHOUSE" },
  });
  whToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });

  // Create test client and shared booking
  const client = await prisma.client.create({ data: { name: `inv-test-client-${Date.now()}` } });
  clientId = client.id;

  const booking = await prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: "Invoice Test Project",
      startDate: new Date("2026-05-01"),
      endDate: new Date("2026-05-03"),
      finalAmount: "150000",
      legacyFinance: false,
    },
  });
  bookingId = booking.id;

  // Create OrganizationSettings for numbering
  await prisma.organizationSettings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", legalName: "ООО Тест", inn: "1234567890", invoiceNumberPrefix: "TEST" },
    update: {},
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

function SA() { return { "X-API-Key": "test-key-inv", Authorization: `Bearer ${saToken}` }; }
function WH() { return { "X-API-Key": "test-key-inv", Authorization: `Bearer ${whToken}` }; }

/** Creates a fresh booking with legacyFinance=false, returns its id */
async function freshBookingId(): Promise<string> {
  const b = await prisma.booking.create({
    data: {
      clientId,
      projectName: `test-booking-${Date.now()}-${Math.random()}`,
      startDate: new Date("2026-06-01"),
      endDate: new Date("2026-06-03"),
      finalAmount: "50000",
      legacyFinance: false,
    },
  });
  return b.id;
}

describe("POST /api/invoices", () => {
  it("SA: создаёт DRAFT счёт для существующей брони", async () => {
    const res = await request(app)
      .post("/api/invoices")
      .set(SA())
      .send({ bookingId, kind: "FULL", dueDate: "2026-06-01T00:00:00.000Z", notes: "Test note" });

    expect(res.status).toBe(201);
    expect(res.body.bookingId).toBe(bookingId);
    expect(res.body.kind).toBe("FULL");
    expect(res.body.status).toBe("DRAFT");
    expect(res.body.notes).toBe("Test note");
    // DRAFT invoice has temporary number
    expect(res.body.number).toBeTruthy();
  });

  it("SA: DEPOSIT требует total", async () => {
    const bId = await freshBookingId();
    const res = await request(app)
      .post("/api/invoices")
      .set(SA())
      .send({ bookingId: bId, kind: "DEPOSIT" }); // no total

    expect(res.status).toBe(400);
  });

  it("SA: создаёт DEPOSIT счёт с явной суммой", async () => {
    const res = await request(app)
      .post("/api/invoices")
      .set(SA())
      .send({ bookingId, kind: "DEPOSIT", total: 45000 });

    expect(res.status).toBe(201);
    expect(res.body.kind).toBe("DEPOSIT");
    expect(Number(res.body.total)).toBe(45000);
  });

  it("WH: не может создавать счета → 403", async () => {
    const bId = await freshBookingId();
    const res = await request(app)
      .post("/api/invoices")
      .set(WH())
      .send({ bookingId: bId, kind: "DEPOSIT", total: 1000 });

    expect(res.status).toBe(403);
  });

  it("несуществующая бронь → 404", async () => {
    const res = await request(app)
      .post("/api/invoices")
      .set(SA())
      .send({ bookingId: "nonexistent-id", kind: "FULL" });

    expect(res.status).toBe(404);
  });

  it("H1: legacyFinance=true → 409 LEGACY_BOOKING", async () => {
    const legacyBooking = await prisma.booking.create({
      data: {
        clientId,
        projectName: "Legacy booking",
        startDate: new Date("2025-01-01"),
        endDate: new Date("2025-01-03"),
        finalAmount: "10000",
        legacyFinance: true, // legacy
      },
    });
    const res = await request(app)
      .post("/api/invoices")
      .set(SA())
      .send({ bookingId: legacyBooking.id, kind: "FULL" });

    expect(res.status).toBe(409);
    expect(res.body.details).toBe("LEGACY_BOOKING");
  });

  it("H1: FULL invoice duplicate → 409 FULL_INVOICE_EXISTS", async () => {
    const bId = await freshBookingId();
    // Create first FULL invoice
    await request(app).post("/api/invoices").set(SA()).send({ bookingId: bId, kind: "FULL" });
    // Try second FULL invoice
    const res = await request(app).post("/api/invoices").set(SA()).send({ bookingId: bId, kind: "FULL" });

    expect(res.status).toBe(409);
    expect(res.body.details).toBe("FULL_INVOICE_EXISTS");
  });

  it("H1: CANCELLED booking → 409 BOOKING_CANCELLED", async () => {
    const cancelledBooking = await prisma.booking.create({
      data: {
        clientId,
        projectName: "Cancelled booking",
        startDate: new Date("2025-03-01"),
        endDate: new Date("2025-03-03"),
        finalAmount: "5000",
        legacyFinance: false,
        status: "CANCELLED",
      },
    });
    const res = await request(app)
      .post("/api/invoices")
      .set(SA())
      .send({ bookingId: cancelledBooking.id, kind: "DEPOSIT", total: 1000 });

    expect(res.status).toBe(409);
    expect(res.body.details).toBe("BOOKING_CANCELLED");
  });
});

describe("POST /api/invoices/:id/issue", () => {
  it("SA: выставляет счёт DRAFT → ISSUED с реальным номером", async () => {
    const bId = await freshBookingId();
    const create = await request(app)
      .post("/api/invoices")
      .set(SA())
      .send({ bookingId: bId, kind: "FULL" });

    const invoiceId = create.body.id;
    expect(create.status).toBe(201);

    const issue = await request(app)
      .post(`/api/invoices/${invoiceId}/issue`)
      .set(SA());

    expect(issue.status).toBe(200);
    expect(issue.body.status).toBe("ISSUED");
    expect(issue.body.number).toMatch(/^TEST-\d{4}-\d{4}$/);
    expect(issue.body.issuedAt).toBeTruthy();
  });

  it("WH: не может выставлять счета → 403", async () => {
    const bId = await freshBookingId();
    const create = await request(app)
      .post("/api/invoices")
      .set(SA())
      .send({ bookingId: bId, kind: "FULL" });

    const res = await request(app)
      .post(`/api/invoices/${create.body.id}/issue`)
      .set(WH());

    expect(res.status).toBe(403);
  });

  it("L3: повторный issue уже выставленного счёта → 200 идемпотентно", async () => {
    const bId = await freshBookingId();
    const create = await request(app)
      .post("/api/invoices")
      .set(SA())
      .send({ bookingId: bId, kind: "FULL" });

    await request(app).post(`/api/invoices/${create.body.id}/issue`).set(SA());

    const res = await request(app)
      .post(`/api/invoices/${create.body.id}/issue`)
      .set(SA());

    // L3: idempotent — already ISSUED returns 200, not 409
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ISSUED");
  });
});

describe("POST /api/invoices/:id/void", () => {
  it("SA: аннулирует счёт с причиной", async () => {
    const bId = await freshBookingId();
    const create = await request(app)
      .post("/api/invoices")
      .set(SA())
      .send({ bookingId: bId, kind: "FULL" });

    const invoiceId = create.body.id;

    const res = await request(app)
      .post(`/api/invoices/${invoiceId}/void`)
      .set(SA())
      .send({ reason: "Ошибка выставления" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("VOID");
    expect(res.body.voidReason).toBe("Ошибка выставления");
    expect(res.body.voidedAt).toBeTruthy();
  });

  it("пустая причина → 400", async () => {
    const bId = await freshBookingId();
    const create = await request(app)
      .post("/api/invoices")
      .set(SA())
      .send({ bookingId: bId, kind: "FULL" });

    const res = await request(app)
      .post(`/api/invoices/${create.body.id}/void`)
      .set(SA())
      .send({ reason: "ab" }); // < 3 chars

    expect(res.status).toBe(400);
  });

  it("повторное аннулирование → 409", async () => {
    const bId = await freshBookingId();
    const create = await request(app)
      .post("/api/invoices")
      .set(SA())
      .send({ bookingId: bId, kind: "FULL" });

    await request(app).post(`/api/invoices/${create.body.id}/void`).set(SA()).send({ reason: "Тест аннулирования" });

    const res = await request(app)
      .post(`/api/invoices/${create.body.id}/void`)
      .set(SA())
      .send({ reason: "Повторная попытка" });

    expect(res.status).toBe(409);
  });
});

describe("GET /api/invoices", () => {
  it("SA: получает список счетов", async () => {
    const res = await request(app).get("/api/invoices").set(SA());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(typeof res.body.total).toBe("number");
  });

  it("WH: может читать список", async () => {
    const res = await request(app).get("/api/invoices").set(WH());
    expect(res.status).toBe(200);
  });

  it("фильтр по bookingId", async () => {
    const res = await request(app).get(`/api/invoices?bookingId=${bookingId}`).set(SA());
    expect(res.status).toBe(200);
    // All returned invoices should belong to our booking
    for (const inv of res.body.items) {
      expect(inv.bookingId).toBe(bookingId);
    }
  });

  it("M1: невалидный ?status= → 400 INVALID_STATUS_FILTER", async () => {
    const res = await request(app).get("/api/invoices?status=INVALID_STATUS").set(SA());
    expect(res.status).toBe(400);
    expect(res.body.details).toBe("INVALID_STATUS_FILTER");
  });

  it("M1: валидный ?status=DRAFT → 200", async () => {
    const res = await request(app).get("/api/invoices?status=DRAFT").set(SA());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    for (const inv of res.body.items) {
      expect(["DRAFT", "OVERDUE"].includes(inv.displayStatus ?? inv.status)).toBe(true);
    }
  });
});

describe("GET /api/invoices/:id", () => {
  it("SA: получает один счёт с платежами и возвратами", async () => {
    const bId = await freshBookingId();
    const create = await request(app)
      .post("/api/invoices")
      .set(SA())
      .send({ bookingId: bId, kind: "FULL" });

    const res = await request(app).get(`/api/invoices/${create.body.id}`).set(SA());

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(create.body.id);
    expect(Array.isArray(res.body.payments)).toBe(true);
    expect(Array.isArray(res.body.refunds)).toBe(true);
  });

  it("несуществующий счёт → 404", async () => {
    const res = await request(app).get("/api/invoices/nonexistent-id").set(SA());
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/invoices/:id", () => {
  it("SA: обновляет DRAFT счёт", async () => {
    const bId = await freshBookingId();
    const create = await request(app)
      .post("/api/invoices")
      .set(SA())
      .send({ bookingId: bId, kind: "DEPOSIT", total: 30000 });

    const res = await request(app)
      .patch(`/api/invoices/${create.body.id}`)
      .set(SA())
      .send({ notes: "Обновлено", total: 35000 });

    expect(res.status).toBe(200);
    expect(res.body.notes).toBe("Обновлено");
    expect(Number(res.body.total)).toBe(35000);
  });

  it("нельзя редактировать выставленный счёт → 409", async () => {
    const bId = await freshBookingId();
    const create = await request(app)
      .post("/api/invoices")
      .set(SA())
      .send({ bookingId: bId, kind: "FULL" });

    await request(app).post(`/api/invoices/${create.body.id}/issue`).set(SA());

    const res = await request(app)
      .patch(`/api/invoices/${create.body.id}`)
      .set(SA())
      .send({ notes: "Попытка" });

    expect(res.status).toBe(409);
  });
});
