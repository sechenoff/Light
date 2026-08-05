/**
 * Интеграционные тесты «Простить остаток» + ретро-редактирование ISSUED:
 *  (a) SA прощает долг по RETURNED: manualFinalAmount = amountPaid,
 *      amountOutstanding → 0, аудит BOOKING_DEBT_FORGIVEN с причиной,
 *      FinanceEvent DEBT_FORGIVEN.
 *  (b) Без долга → 409 NO_OUTSTANDING; WAREHOUSE → 403; пустая причина → 400.
 *  (c) ISSUED: прощение работает так же.
 *  (d) PATCH retro для ISSUED: manualFinalAmount правится; body.items → 409
 *      ITEMS_LOCKED_UNTIL_RETURN.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-forgive.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-forgive";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-forgive";
process.env.JWT_SECRET = "test-jwt-secret-forgive-16chars";

let app: Express;
let prisma: any;
let saToken: string;
let whToken: string;
let equipmentId: string;

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
    data: { username: "fg_sa", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  saToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });
  const wh = await prisma.adminUser.create({
    data: { username: "fg_wh", passwordHash: hash, role: "WAREHOUSE" },
  });
  whToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });

  const eq = await prisma.equipment.create({
    data: {
      importKey: "LED||ПАНЕЛЬ FG||GENERIC||LED-FG",
      name: "Панель FG",
      category: "LED",
      totalQuantity: 10,
      rentalRatePerShift: "1000",
      stockTrackingMode: "COUNT",
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

const AUTH_SA = () => ({ "X-API-Key": "test-key-1", Authorization: `Bearer ${saToken}` });
const AUTH_WH = () => ({ "X-API-Key": "test-key-1", Authorization: `Bearer ${whToken}` });

let seq = 0;
/**
 * Бронь с долгом: finalAmount 10000, оплачено 4000, долг 6000.
 * amountPaid/amountOutstanding пишем напрямую (как это делает
 * recomputeBookingFinance после платежей).
 */
async function bookingWithDebt(status: "ISSUED" | "RETURNED") {
  seq += 1;
  const client = await prisma.client.create({ data: { name: `FG Клиент ${seq}` } });
  const booking = await prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: `FG проект ${seq}`,
      startDate: new Date(Date.now() - 5 * 86400000),
      endDate: new Date(Date.now() - 2 * 86400000),
      status,
      issuedAt: new Date(Date.now() - 5 * 86400000),
      finalAmount: "10000",
      amountPaid: "4000",
      amountOutstanding: "6000",
      legacyFinance: true,
      items: { create: [{ equipmentId, quantity: 1 }] },
    },
  });
  // Реальный платёж — recomputeBookingFinance пересчитывает amountPaid из
  // Payment-строк; голое поле без платежа обнулилось бы при recompute.
  await prisma.payment.create({
    data: {
      bookingId: booking.id,
      amount: "4000",
      direction: "INCOME",
      status: "RECEIVED",
      receivedAt: new Date(Date.now() - 3 * 86400000),
      method: "CASH",
    },
  });
  return booking;
}

describe("Простить остаток", () => {
  it("(a) RETURNED: долг обнулён, итог = полученному, аудит + фин-событие", async () => {
    const b = await bookingWithDebt("RETURNED");
    const res = await request(app)
      .post(`/api/bookings/${b.id}/forgive-outstanding`)
      .set(AUTH_SA())
      .send({ reason: "договорились о скидке по итогам смены" });

    expect(res.status).toBe(200);
    expect(res.body.booking.manualFinalAmount).toBe("4000");
    expect(Number(res.body.booking.finalAmount)).toBe(4000);
    expect(Number(res.body.booking.amountOutstanding)).toBe(0);

    const audit = await prisma.auditEntry.findFirst({
      where: { action: "BOOKING_DEBT_FORGIVEN", entityId: b.id },
    });
    expect(audit).toBeTruthy();
    const after = JSON.parse(audit.after);
    expect(after.forgivenAmount).toBe("6000");
    expect(after.reason).toContain("скидке");

    const finEvent = await prisma.bookingFinanceEvent.findFirst({
      where: { bookingId: b.id, eventType: "DEBT_FORGIVEN" },
    });
    expect(finEvent).toBeTruthy();
  });

  it("(b) без долга → 409; WAREHOUSE → 403; короткая причина → 400", async () => {
    const paid = await bookingWithDebt("RETURNED");
    await prisma.booking.update({
      where: { id: paid.id },
      data: { amountPaid: "10000", amountOutstanding: "0" },
    });
    const noDebt = await request(app)
      .post(`/api/bookings/${paid.id}/forgive-outstanding`)
      .set(AUTH_SA())
      .send({ reason: "нет долга" });
    expect(noDebt.status).toBe(409);
    expect(noDebt.body.code).toBe("NO_OUTSTANDING");

    const b = await bookingWithDebt("RETURNED");
    const forbidden = await request(app)
      .post(`/api/bookings/${b.id}/forgive-outstanding`)
      .set(AUTH_WH())
      .send({ reason: "не мой уровень" });
    expect(forbidden.status).toBe(403);

    const shortReason = await request(app)
      .post(`/api/bookings/${b.id}/forgive-outstanding`)
      .set(AUTH_SA())
      .send({ reason: "ок" });
    expect(shortReason.status).toBe(400);
  });

  it("(c) ISSUED: прощение работает", async () => {
    const b = await bookingWithDebt("ISSUED");
    const res = await request(app)
      .post(`/api/bookings/${b.id}/forgive-outstanding`)
      .set(AUTH_SA())
      .send({ reason: "клиент постоянный, долг прощён" });
    expect(res.status).toBe(200);
    expect(Number(res.body.booking.amountOutstanding)).toBe(0);
  });
});

describe("Ретро-редактирование ISSUED", () => {
  it("(d) manualFinalAmount правится; items → 409 ITEMS_LOCKED_UNTIL_RETURN", async () => {
    const b = await bookingWithDebt("ISSUED");

    const finance = await request(app)
      .patch(`/api/bookings/${b.id}`)
      .set(AUTH_SA())
      .send({ retroactive: true, manualFinalAmount: 7500 });
    expect(finance.status).toBe(200);
    expect(finance.body.booking.manualFinalAmount).toBe("7500");

    const items = await request(app)
      .patch(`/api/bookings/${b.id}`)
      .set(AUTH_SA())
      .send({
        retroactive: true,
        items: [{ equipmentId, quantity: 2 }],
      });
    expect(items.status).toBe(409);
    expect(items.body.code).toBe("ITEMS_LOCKED_UNTIL_RETURN");
  });
});
