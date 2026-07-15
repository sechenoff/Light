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

  it("?paid=NOT_PAID возвращает только NOT_PAID (LF 4)", async () => {
    const rows = await list("limit=200&paid=NOT_PAID");
    expect(rows.length).toBe(1);
    expect(rows[0].projectName).toBe("LF 4");
  });

  it("?paid=PARTIALLY_PAID — точный статус (в фикстуре нет → 0)", async () => {
    const rows = await list("limit=200&paid=PARTIALLY_PAID");
    expect(rows.length).toBe(0);
  });

  it("?paid=OVERDUE ловит статус OVERDUE (LF 5), но не NOT_PAID без срока", async () => {
    const rows = await list("limit=200&paid=OVERDUE");
    expect(rows.length).toBe(1);
    expect(rows[0].projectName).toBe("LF 5");
  });

  it("?paid=OVERDUE также ловит просроченный NOT_PAID по expectedPaymentDate", async () => {
    // Бронь NOT_PAID со сроком оплаты в прошлом — cron ещё не перекинул в OVERDUE.
    const past = await prisma.booking.create({
      data: {
        clientId, projectName: "LF Overdue Date",
        startDate: new Date("2026-05-18T09:00:00.000Z"), endDate: new Date("2026-05-18T09:00:00.000Z"),
        status: "RETURNED", paymentStatus: "NOT_PAID", finalAmount: "1000",
        expectedPaymentDate: new Date("2020-01-01T00:00:00.000Z"),
      },
    });
    const rows = await list("limit=200&paid=OVERDUE");
    const names = rows.map((r) => r.projectName);
    expect(names).toContain("LF 5");
    expect(names).toContain("LF Overdue Date");
    await prisma.booking.delete({ where: { id: past.id } });
  });

  it("GET /summary/counts — pendingApproval / overdue / issued по живым броням", async () => {
    const res = await request(app).get("/api/bookings/summary/counts").set(AUTH());
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("pendingApproval");
    expect(res.body).toHaveProperty("overdue");
    expect(res.body).toHaveProperty("issued");
    // Все брони фикстуры — RETURNED, поэтому pendingApproval=0, issued=0.
    expect(res.body.pendingApproval).toBe(0);
    expect(res.body.issued).toBe(0);
    // Просрочка: LF 5 (статус OVERDUE).
    expect(res.body.overdue).toBe(1);
  });

  it("list-serializer больше не отдаёт displayName и сырой _count", async () => {
    const rows = await list("limit=1");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).not.toHaveProperty("displayName");
    expect(rows[0]).not.toHaveProperty("_count");
    expect(rows[0]).not.toHaveProperty("scanSessions");
    // Производные поля остаются.
    expect(rows[0]).toHaveProperty("hasScanSessions");
  });
});
