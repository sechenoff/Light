/**
 * Интеграционные тесты списания («прощения») остатка долга.
 *
 * Сценарий из жизни: смета округлена до удобной суммы, клиент заплатил ровно,
 * повис хвост в 600 ₽. Взыскивать его не будут — проект надо закрыть, но при
 * этом не переписывать смету и не терять историю платежей.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-debt-writeoff.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-writeoff";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-writeoff";
process.env.WAREHOUSE_SECRET = "test-warehouse-writeoff";
process.env.JWT_SECRET = "test-jwt-writeoff-min16chars";

let app: Express;
let prisma: any;
let saToken: string;
let whToken: string;
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
  prisma = (await import("../prisma")).prisma;

  const { hashPassword, signSession } = await import("../services/auth");
  const hash = await hashPassword("pass-123");

  const sa = await prisma.adminUser.create({
    data: { username: "wo_sa", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  saToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });

  const wh = await prisma.adminUser.create({
    data: { username: "wo_wh", passwordHash: hash, role: "WAREHOUSE" },
  });
  whToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });

  const client = await prisma.client.create({ data: { name: "ООО «Хвостатый»" } });
  clientId = client.id;
});

afterAll(async () => {
  await prisma.$disconnect();
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = TEST_DB_PATH + suffix;
    if (fs.existsSync(f)) {
      try { fs.unlinkSync(f); } catch { /* игнор */ }
    }
  }
});

function SA() {
  return { "X-API-Key": "test-key-writeoff", Authorization: `Bearer ${saToken}` };
}
function WH() {
  return { "X-API-Key": "test-key-writeoff", Authorization: `Bearer ${whToken}` };
}

/** Бронь на `final` рублей, из которых `paid` уже оплачено. */
async function makeBookingWithDebt(final: number, paid: number, project = "Проект") {
  const booking = await prisma.booking.create({
    data: {
      clientId,
      projectName: project,
      startDate: new Date("2026-07-01"),
      endDate: new Date("2026-07-02"),
      status: "RETURNED",
      legacyFinance: false,
      totalEstimateAmount: String(final),
      discountAmount: "0",
      finalAmount: String(final),
      manualFinalAmount: String(final),
      amountPaid: "0",
      amountOutstanding: "0",
    },
  });
  if (paid > 0) {
    await prisma.payment.create({
      data: {
        bookingId: booking.id,
        amount: String(paid),
        direction: "INCOME",
        status: "RECEIVED",
        receivedAt: new Date("2026-07-03"),
        paymentDate: new Date("2026-07-03"),
      },
    });
  }
  const { recomputeBookingFinance } = await import("../services/finance");
  await recomputeBookingFinance(booking.id);
  return booking.id;
}

describe("POST /api/bookings/:id/write-off", () => {
  it("прощает весь остаток без указания суммы и убирает бронь из долгов", async () => {
    const id = await makeBookingWithDebt(40000, 39400, "Округлённая смета");

    let b = await prisma.booking.findUnique({ where: { id } });
    expect(b.amountOutstanding.toString()).toBe("600");

    const res = await request(app).post(`/api/bookings/${id}/write-off`).set(SA()).send({});
    expect(res.status).toBe(200);
    expect(res.body.amountWrittenOff).toBe("600.00");
    expect(res.body.amountOutstanding).toBe("0");
    expect(res.body.paymentStatus).toBe("PAID");

    b = await prisma.booking.findUnique({ where: { id } });
    expect(b.writeOffAmount.toString()).toBe("600");
    // Смета и полученные деньги остались нетронутыми — переписывать историю нельзя
    expect(b.finalAmount.toString()).toBe("40000");
    expect(b.amountPaid.toString()).toBe("39400");

    const { computeDebts } = await import("../services/finance");
    const debts = await computeDebts();
    const ids = debts.debts.flatMap((d: any) => d.projects.map((p: any) => p.bookingId));
    expect(ids).not.toContain(id);
  });

  it("списание переживает пересчёт финансов", async () => {
    const id = await makeBookingWithDebt(10000, 9500);
    await request(app).post(`/api/bookings/${id}/write-off`).set(SA()).send({});

    const { recomputeBookingFinance } = await import("../services/finance");
    await recomputeBookingFinance(id);

    const b = await prisma.booking.findUnique({ where: { id } });
    expect(b.amountOutstanding.toString()).toBe("0");
    expect(b.paymentStatus).toBe("PAID");
  });

  it("частичное списание оставляет остаток долга", async () => {
    const id = await makeBookingWithDebt(10000, 8000);

    const res = await request(app)
      .post(`/api/bookings/${id}/write-off`)
      .set(SA())
      .send({ amount: 500, reason: "Округление" });
    expect(res.status).toBe(200);
    expect(res.body.amountOutstanding).toBe("1500");

    const b = await prisma.booking.findUnique({ where: { id } });
    expect(b.writeOffAmount.toString()).toBe("500");
    expect(b.writeOffReason).toBe("Округление");
    expect(b.paymentStatus).not.toBe("PAID");
  });

  it("повторное списание накапливается и не превышает долг", async () => {
    const id = await makeBookingWithDebt(10000, 9000);

    await request(app).post(`/api/bookings/${id}/write-off`).set(SA()).send({ amount: 400 });
    const second = await request(app)
      .post(`/api/bookings/${id}/write-off`)
      .set(SA())
      .send({ amount: 600 });
    expect(second.status).toBe(200);
    expect(second.body.totalWrittenOff).toBe("1000.00");
    expect(second.body.amountOutstanding).toBe("0");

    // Третий раз прощать нечего
    const third = await request(app).post(`/api/bookings/${id}/write-off`).set(SA()).send({});
    expect(third.status).toBe(409);
    expect(third.body.code).toBe("NO_OUTSTANDING_DEBT");
  });

  it("нельзя простить больше остатка", async () => {
    const id = await makeBookingWithDebt(10000, 9400);
    const res = await request(app)
      .post(`/api/bookings/${id}/write-off`)
      .set(SA())
      .send({ amount: 5000 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("WRITE_OFF_EXCEEDS_DEBT");

    const b = await prisma.booking.findUnique({ where: { id } });
    expect(b.writeOffAmount).toBeNull();
  });

  it("бронь без долга → 409", async () => {
    const id = await makeBookingWithDebt(5000, 5000);
    const res = await request(app).post(`/api/bookings/${id}/write-off`).set(SA()).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("NO_OUTSTANDING_DEBT");
  });

  it("пишет аудит BOOKING_DEBT_WRITE_OFF", async () => {
    const id = await makeBookingWithDebt(10000, 9700);
    await request(app).post(`/api/bookings/${id}/write-off`).set(SA()).send({ reason: "Хвост" });

    const audit = await prisma.auditEntry.findMany({
      where: { entityType: "Booking", entityId: id, action: "BOOKING_DEBT_WRITE_OFF" },
    });
    expect(audit).toHaveLength(1);
    const after = typeof audit[0].after === "string" ? JSON.parse(audit[0].after) : audit[0].after;
    expect(after.amountWrittenOff).toBe("300.00");
    expect(after.reason).toBe("Хвост");
  });

  // ── Роли ───────────────────────────────────────────────────────────────────

  it("WAREHOUSE → 403: прощение денег только руководителю", async () => {
    const id = await makeBookingWithDebt(10000, 9000);
    const res = await request(app).post(`/api/bookings/${id}/write-off`).set(WH()).send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN_BY_ROLE");
  });
});

describe("DELETE /api/bookings/:id/write-off — отмена списания", () => {
  it("возвращает долг в дебиторку целиком", async () => {
    const id = await makeBookingWithDebt(40000, 39400);
    await request(app).post(`/api/bookings/${id}/write-off`).set(SA()).send({});

    const res = await request(app).delete(`/api/bookings/${id}/write-off`).set(SA());
    expect(res.status).toBe(200);
    expect(res.body.amountOutstanding).toBe("600");

    const b = await prisma.booking.findUnique({ where: { id } });
    expect(b.writeOffAmount).toBeNull();
    expect(b.writeOffReason).toBeNull();
    expect(b.paymentStatus).not.toBe("PAID");

    const audit = await prisma.auditEntry.findMany({
      where: { entityId: id, action: "BOOKING_DEBT_WRITE_OFF_CANCELLED" },
    });
    expect(audit).toHaveLength(1);
  });

  it("без активного списания → 409", async () => {
    const id = await makeBookingWithDebt(10000, 9000);
    const res = await request(app).delete(`/api/bookings/${id}/write-off`).set(SA());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("NO_WRITE_OFF");
  });

  it("WAREHOUSE → 403", async () => {
    const id = await makeBookingWithDebt(10000, 9000);
    await request(app).post(`/api/bookings/${id}/write-off`).set(SA()).send({});
    const res = await request(app).delete(`/api/bookings/${id}/write-off`).set(WH());
    expect(res.status).toBe(403);
  });
});
