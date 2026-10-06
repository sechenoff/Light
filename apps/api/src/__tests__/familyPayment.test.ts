/**
 * «Разнести по продолжениям»: один платёж клиента на основную бронь и её
 * продолжения — долги от старшей к младшей, остаток — на бронь, где вводили.
 * Лимиты кладовщика — по всей сумме, а не по частям.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { randomUUID } from "crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-family-payment.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-fpay";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-family-payment";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-fpay";
process.env.JWT_SECRET = "test-jwt-family-payment-16chars";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const N = Math.floor(Date.now() / HOUR) * HOUR;

let app: Express;
let prisma: any;
let saToken: string;
let whToken: string;
let clientId: string;
let seq = 0;

const AUTH = (token = saToken) => ({ "X-API-Key": "test-key-fpay", Authorization: `Bearer ${token}` });

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, DATABASE_URL: `file:${TEST_DB_PATH}`, PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes" },
    stdio: "pipe",
  });
  app = (await import("../app")).app;
  prisma = (await import("../prisma")).prisma;
  const { signSession } = await import("../services/auth");
  const sa = await prisma.adminUser.create({ data: { username: "sa-fpay", passwordHash: "x", role: "SUPER_ADMIN" } });
  const wh = await prisma.adminUser.create({ data: { username: "wh-fpay", passwordHash: "x", role: "WAREHOUSE" } });
  saToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });
  whToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });
  clientId = (await prisma.client.create({ data: { name: "Продакшн «Сфера»" } })).id;
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    const f = `${TEST_DB_PATH}${suffix}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

/** Основная (долг rootDebt) и продолжение (долг childDebt). Суммы — через смету, чтобы пересчёт финансов их не обнулил. */
async function mkFamily(rootDebt: number, childDebt: number) {
  seq += 1;
  const mkEstimate = (amount: number) => ({
    create: { kind: "MAIN", shifts: 1, subtotal: amount, discountAmount: 0, totalAfterDiscount: amount },
  });
  const root = await prisma.booking.create({
    data: {
      clientId, projectName: `Семья ${seq}`, docNumber: `СМ-FP-${seq}`, status: "RETURNED", legacyFinance: false,
      startDate: new Date(N - 2 * DAY), endDate: new Date(N - DAY),
      finalAmount: rootDebt, amountOutstanding: rootDebt, estimates: mkEstimate(rootDebt),
    },
  });
  const child = await prisma.booking.create({
    data: {
      clientId, projectName: `Семья ${seq}`, docNumber: `СМ-FP-${seq}-1`, status: "ISSUED", legacyFinance: false,
      startDate: new Date(N - DAY), endDate: new Date(N + DAY), issuedAt: new Date(N - DAY),
      parentBookingId: root.id, rootBookingId: root.id,
      finalAmount: childDebt, amountOutstanding: childDebt, estimates: mkEstimate(childDebt),
    },
  });
  const { recomputeBookingFinance } = await import("../services/finance");
  await recomputeBookingFinance(root.id);
  await recomputeBookingFinance(child.id);
  return { root, child };
}

const owed = async (id: string) => Number((await prisma.booking.findUnique({ where: { id } })).amountOutstanding);

describe("раскладка по семье", () => {
  it("долги от старшей брони к младшей, остаток — на бронь, где вводили", async () => {
    const { planFamilyPayment } = await import("../services/familyPayment");
    const Decimal = (await import("decimal.js")).default;
    const members = [
      { id: "root", docNumber: "СМ-1", amountOutstanding: 3000 },
      { id: "child", docNumber: "СМ-1-1", amountOutstanding: 1200 },
    ];
    expect(planFamilyPayment(members, new Decimal(3500), "child")).toEqual([
      { bookingId: "root", docNumber: "СМ-1", amount: "3000.00" },
      { bookingId: "child", docNumber: "СМ-1-1", amount: "500.00" },
    ]);
    expect(planFamilyPayment(members, new Decimal(5000), "child")).toEqual([
      { bookingId: "root", docNumber: "СМ-1", amount: "3000.00" },
      { bookingId: "child", docNumber: "СМ-1-1", amount: "2000.00" },
    ]);
  });
});

describe("платёж «Разнести по продолжениям»", () => {
  it("один ввод — два платежа, обе брони закрыты", async () => {
    const { root, child } = await mkFamily(3000, 1200);
    const preview = await request(app).get("/api/payments/family-preview").query({ bookingId: child.id, amount: 4200 }).set(AUTH());
    expect(preview.body.parts.map((p: any) => p.amount)).toEqual(["3000.00", "1200.00"]);
    const res = await request(app)
      .post("/api/payments")
      .set(AUTH())
      .send({ bookingId: child.id, amount: 4200, method: "BANK_TRANSFER", receivedAt: new Date().toISOString(), spreadAcrossFamily: true });
    expect(res.status).toBe(201);
    expect(res.body.payments).toHaveLength(2);
    expect(await owed(root.id)).toBe(0);
    expect(await owed(child.id)).toBe(0);
    const notes = (await prisma.payment.findMany({ where: { bookingId: { in: [root.id, child.id] } } })).map((p: any) => p.note);
    expect(notes.every((n: string) => n.includes(`один платёж на ${root.docNumber} + ${child.docNumber}`))).toBe(true);
  });

  it("лимит кладовщика — по всей сумме, а не по частям", async () => {
    const { child } = await mkFamily(60_000, 60_000);
    const res = await request(app)
      .post("/api/payments")
      .set(AUTH(whToken))
      .send({ bookingId: child.id, amount: 120_000, method: "CASH", receivedAt: new Date().toISOString(), spreadAcrossFamily: true });
    expect(res.status).toBe(403);
    expect(await prisma.payment.count({ where: { bookingId: child.id } })).toBe(0);
  });

  it("повтор той же отправки не платит второй раз", async () => {
    const { root, child } = await mkFamily(1000, 1000);
    const body = { requestKey: randomUUID(), bookingId: child.id, amount: 2000, method: "CASH", receivedAt: new Date().toISOString(), spreadAcrossFamily: true };
    const first = await request(app).post("/api/payments").set(AUTH()).send(body);
    const second = await request(app).post("/api/payments").set(AUTH()).send(body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await prisma.payment.count({ where: { bookingId: { in: [root.id, child.id] } } })).toBe(2);
  });

  it("платёж по счёту не разносится", async () => {
    const { child } = await mkFamily(1000, 1000);
    const res = await request(app)
      .post("/api/payments")
      .set(AUTH())
      .send({ bookingId: child.id, amount: 500, method: "CASH", receivedAt: new Date().toISOString(), spreadAcrossFamily: true, invoiceId: "inv-x" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("PAYMENT_SPREAD_WITH_INVOICE");
  });

  it("у обычной брони — как обычный платёж", async () => {
    seq += 1;
    const plain = await prisma.booking.create({
      data: {
        clientId, projectName: `Обычная ${seq}`, status: "RETURNED", legacyFinance: false, startDate: new Date(N - 2 * DAY), endDate: new Date(N - DAY),
        finalAmount: 700, amountOutstanding: 700,
        estimates: { create: { kind: "MAIN", shifts: 1, subtotal: 700, discountAmount: 0, totalAfterDiscount: 700 } },
      },
    });
    const res = await request(app)
      .post("/api/payments")
      .set(AUTH())
      .send({ bookingId: plain.id, amount: 700, method: "CASH", receivedAt: new Date().toISOString(), spreadAcrossFamily: true });
    expect(res.status).toBe(201);
    expect(res.body.payments).toHaveLength(1);
    expect(await owed(plain.id)).toBe(0);
  });
});
