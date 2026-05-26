/**
 * Интеграционные тесты soft-delete для броней.
 *
 *  (a) DELETE /api/bookings/:id (SUPER_ADMIN) → soft-delete: deletedAt
 *      установлен, audit BOOKING_ARCHIVED, бронь живёт в БД.
 *  (b) GET /api/bookings без флага — не показывает архивированных.
 *  (c) GET /api/bookings?archived=true — только архивированные.
 *  (d) DELETE второй раз → 409 BOOKING_ALREADY_ARCHIVED.
 *  (e) POST /restore → deletedAt очищается, бронь снова в списке.
 *  (f) DELETE /purge до восстановления → audit BOOKING_PURGED, нет записи в БД.
 *  (g) DELETE /purge на живой броне → 409 BOOKING_NOT_ARCHIVED.
 *  (h) WAREHOUSE без SUPER_ADMIN → 403 на DELETE/restore/purge.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-archive.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-archive";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-archive-min16chars";
process.env.JWT_SECRET = "test-jwt-secret-archive-min16chars";

let app: Express;
let prisma: any;
let superAdminToken: string;
let warehouseToken: string;
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
  const hash = await hashPassword("test-pass-123");

  await prisma.adminUser.upsert({
    where: { id: "_system_" },
    update: {},
    create: { id: "_system_", username: "_system_", passwordHash: hash, role: "SUPER_ADMIN" },
  });

  const sa = await prisma.adminUser.create({
    data: { username: "arch_sa", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  superAdminToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });

  const wh = await prisma.adminUser.create({
    data: { username: "arch_wh", passwordHash: hash, role: "WAREHOUSE" },
  });
  warehouseToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });

  const c = await prisma.client.create({ data: { name: "Архив-Клиент" } });
  clientId = c.id;
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

const AUTH_SA = () => ({ "X-API-Key": "test-key-1", Authorization: `Bearer ${superAdminToken}` });
const AUTH_WH = () => ({ "X-API-Key": "test-key-1", Authorization: `Bearer ${warehouseToken}` });

let seq = 0;
async function makeBooking(): Promise<string> {
  seq += 1;
  const b = await prisma.booking.create({
    data: {
      clientId,
      projectName: `Архив-проект ${seq}`,
      startDate: new Date(`2026-06-${String(seq).padStart(2, "0")}T09:00:00.000Z`),
      endDate: new Date(`2026-06-${String(seq + 1).padStart(2, "0")}T09:00:00.000Z`),
      status: "DRAFT",
    },
  });
  return b.id;
}

describe("Soft-delete броней: archive / restore / purge", () => {
  it("(a) DELETE → soft-delete: deletedAt установлен, audit BOOKING_ARCHIVED", async () => {
    const id = await makeBooking();
    const res = await request(app).delete(`/api/bookings/${id}`).set(AUTH_SA());
    expect(res.status).toBe(200);
    expect(res.body.archived).toBe(true);

    const after = await prisma.booking.findUnique({ where: { id } });
    expect(after).not.toBeNull();
    expect(after?.deletedAt).not.toBeNull();
    expect(after?.deletedBy).toBeTruthy();

    const audit = await prisma.auditEntry.findFirst({
      where: { action: "BOOKING_ARCHIVED", entityId: id },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
  });

  it("(b) GET /api/bookings без флага не показывает архивированных", async () => {
    const id = await makeBooking();
    await request(app).delete(`/api/bookings/${id}`).set(AUTH_SA());
    const res = await request(app).get("/api/bookings?limit=200").set(AUTH_SA());
    expect(res.status).toBe(200);
    const ids = (res.body.bookings as Array<{ id: string }>).map((b) => b.id);
    expect(ids).not.toContain(id);
  });

  it("(c) GET ?archived=true возвращает только архивированных", async () => {
    const id = await makeBooking();
    await request(app).delete(`/api/bookings/${id}`).set(AUTH_SA());
    const res = await request(app).get("/api/bookings?archived=true&limit=200").set(AUTH_SA());
    expect(res.status).toBe(200);
    const found = (res.body.bookings as Array<{ id: string; deletedAt: string | null }>).find((b) => b.id === id);
    expect(found).toBeDefined();
    expect(found?.deletedAt).not.toBeNull();
  });

  it("(d) повторный DELETE архивированной → 409 BOOKING_ALREADY_ARCHIVED", async () => {
    const id = await makeBooking();
    await request(app).delete(`/api/bookings/${id}`).set(AUTH_SA());
    const res = await request(app).delete(`/api/bookings/${id}`).set(AUTH_SA());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("BOOKING_ALREADY_ARCHIVED");
  });

  it("(e) POST /restore → возвращает бронь в основной список", async () => {
    const id = await makeBooking();
    await request(app).delete(`/api/bookings/${id}`).set(AUTH_SA());
    const res = await request(app).post(`/api/bookings/${id}/restore`).set(AUTH_SA());
    expect(res.status).toBe(200);
    expect(res.body.restored).toBe(true);

    const after = await prisma.booking.findUnique({ where: { id } });
    expect(after?.deletedAt).toBeNull();
    expect(after?.deletedBy).toBeNull();

    const audit = await prisma.auditEntry.findFirst({
      where: { action: "BOOKING_RESTORED", entityId: id },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
  });

  it("(f) DELETE /purge на архивированной → запись удалена из БД", async () => {
    const id = await makeBooking();
    await request(app).delete(`/api/bookings/${id}`).set(AUTH_SA());
    const res = await request(app).delete(`/api/bookings/${id}/purge`).set(AUTH_SA());
    expect(res.status).toBe(200);
    expect(res.body.purged).toBe(true);

    const after = await prisma.booking.findUnique({ where: { id } });
    expect(after).toBeNull();

    // Audit-запись о purge должна остаться (вне зависимости от booking)
    const audit = await prisma.auditEntry.findFirst({
      where: { action: "BOOKING_PURGED", entityId: id },
    });
    expect(audit).not.toBeNull();
  });

  it("(g) DELETE /purge на живой броне (не в архиве) → 409 BOOKING_NOT_ARCHIVED", async () => {
    const id = await makeBooking();
    const res = await request(app).delete(`/api/bookings/${id}/purge`).set(AUTH_SA());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("BOOKING_NOT_ARCHIVED");
    // Бронь не тронута
    const after = await prisma.booking.findUnique({ where: { id } });
    expect(after).not.toBeNull();
    expect(after?.deletedAt).toBeNull();
  });

  it("(h) WAREHOUSE — 403 на DELETE/restore/purge (только SUPER_ADMIN)", async () => {
    const id = await makeBooking();
    const del = await request(app).delete(`/api/bookings/${id}`).set(AUTH_WH());
    expect(del.status).toBe(403);
    const res = await request(app).post(`/api/bookings/${id}/restore`).set(AUTH_WH());
    expect(res.status).toBe(403);
    const purge = await request(app).delete(`/api/bookings/${id}/purge`).set(AUTH_WH());
    expect(purge.status).toBe(403);
  });
});
