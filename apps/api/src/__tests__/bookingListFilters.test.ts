/**
 * Серверные фильтры списка броней: ?paid= и ?from=&to= (по дате смены).
 * Регрессия на баг: фильтры были клиентскими и применялись лишь к
 * подгруженной странице → неполный результат.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-list-filters.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-listf";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-listf-min16chars";
process.env.JWT_SECRET = "test-jwt-secret-listf-min16chars";

let app: Express;
let prisma: any;
let saToken: string;
let clientId: string;

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, DATABASE_URL: `file:${TEST_DB_PATH}`, PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes" },
    stdio: "pipe",
  });
  const mod = await import("../app");
  app = mod.app;
  prisma = (await import("../prisma")).prisma;
  const { hashPassword, signSession } = await import("../services/auth");
  const hash = await hashPassword("x");
  const sa = await prisma.adminUser.create({ data: { username: "lf_sa", passwordHash: hash, role: "SUPER_ADMIN" } });
  saToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });
  const c = await prisma.client.create({ data: { name: "ListFilter Client" } });
  clientId = c.id;

  // 3 PAID + 2 NOT_PAID; даты: 2 в марте, 3 в мае.
  const mk = (n: number, pay: string, iso: string) =>
    prisma.booking.create({
      data: {
        clientId, projectName: `LF ${n}`,
        startDate: new Date(iso), endDate: new Date(iso),
        status: "RETURNED", paymentStatus: pay as any, finalAmount: "1000",
      },
    });
  await mk(1, "PAID", "2026-03-05T09:00:00.000Z");
  await mk(2, "PAID", "2026-03-20T09:00:00.000Z");
  await mk(3, "PAID", "2026-05-10T09:00:00.000Z");
  await mk(4, "NOT_PAID", "2026-05-12T09:00:00.000Z");
  await mk(5, "OVERDUE", "2026-05-15T09:00:00.000Z");
});

afterAll(async () => {
  await prisma.$disconnect();
  for (const s of ["", "-wal", "-shm"]) { const f = TEST_DB_PATH + s; if (fs.existsSync(f)) try { fs.unlinkSync(f); } catch {} }
});

const AUTH = () => ({ "X-API-Key": "test-key-1", Authorization: `Bearer ${saToken}` });

async function list(qs: string): Promise<any[]> {
  const res = await request(app).get(`/api/bookings?${qs}`).set(AUTH());
  expect(res.status).toBe(200);
  return res.body.bookings as any[];
}

describe("GET /api/bookings — серверные фильтры", () => {
  it("?paid=PAID возвращает только PAID", async () => {
    const rows = await list("limit=200&paid=PAID");
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.paymentStatus === "PAID")).toBe(true);
  });

  it("?paid=UNPAID возвращает всё кроме PAID", async () => {
    const rows = await list("limit=200&paid=UNPAID");
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.paymentStatus !== "PAID")).toBe(true);
  });

  it("?from=&to= фильтрует по дате смены (включительно)", async () => {
    const rows = await list("limit=200&from=2026-05-01&to=2026-05-31");
    expect(rows.length).toBe(3);
    expect(rows.every((r) => new Date(r.startDate) >= new Date("2026-05-01T00:00:00+03:00"))).toBe(true);
  });

  it("комбинация paid+дата сужает корректно", async () => {
    const rows = await list("limit=200&paid=PAID&from=2026-05-01&to=2026-05-31");
    expect(rows.length).toBe(1); // только LF 3
    expect(rows[0].projectName).toBe("LF 3");
  });

  it("граница to включительна (день целиком)", async () => {
    const rows = await list("limit=200&from=2026-03-20&to=2026-03-20");
    expect(rows.length).toBe(1);
    expect(rows[0].projectName).toBe("LF 2");
  });
});
