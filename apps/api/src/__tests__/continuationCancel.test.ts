/**
 * «Отменить продолжение» — продолжение оформили по ошибке: оставленное
 * вернули вместе с основной бронью. Только руководитель, только выданное
 * продолжение без оплаты; единицы снова на складе, долг клиента исчезает.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-continuation-cancel.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-ccan";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-continuation-cancel";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-ccan";
process.env.JWT_SECRET = "test-jwt-continuation-cancel-16";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const N = Math.floor(Date.now() / HOUR) * HOUR;
const ROOT_START = new Date(N - 2 * DAY);
const ROOT_END = new Date(N - DAY);

let app: Express;
let prisma: any;
let saToken: string;
let whToken: string;
let clientId: string;
let lens: string;
let seq = 0;

const AUTH = (token = saToken) => ({ "X-API-Key": "test-key-ccan", Authorization: `Bearer ${token}` });

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, DATABASE_URL: `file:${TEST_DB_PATH}`, PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes" },
    stdio: "pipe",
  });
  app = (await import("../app")).app;
  prisma = (await import("../prisma")).prisma;
  const { signSession } = await import("../services/auth");
  const sa = await prisma.adminUser.create({ data: { username: "sa-ccan", passwordHash: "x", role: "SUPER_ADMIN" } });
  const wh = await prisma.adminUser.create({ data: { username: "wh-ccan", passwordHash: "x", role: "WAREHOUSE" } });
  saToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });
  whToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });
  clientId = (await prisma.client.create({ data: { name: "Продакшн «Сфера»" } })).id;
  lens = (
    await prisma.equipment.create({
      data: { importKey: "ccan-lens", name: "Объектив Cooke", category: "Оптика", totalQuantity: 10, rentalRatePerShift: 2000, stockTrackingMode: "UNIT" },
    })
  ).id;
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    const f = `${TEST_DB_PATH}${suffix}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

/** Основная (RETURNED) и выданное продолжение с одной штучной единицей на руках. */
async function mkFamily(opts: { childStatus?: string } = {}) {
  seq += 1;
  const root = await prisma.booking.create({
    data: { clientId, projectName: `Основная ${seq}`, docNumber: `СМ-CC-${seq}`, status: "RETURNED", startDate: ROOT_START, endDate: ROOT_END },
  });
  const unit = await prisma.equipmentUnit.create({ data: { equipmentId: lens, status: "ISSUED", internalInventoryNumber: `COOKE-${seq}` } });
  const child = await prisma.booking.create({
    data: {
      clientId,
      projectName: `Основная ${seq}`,
      docNumber: `СМ-CC-${seq}-1`,
      status: opts.childStatus ?? "ISSUED",
      startDate: ROOT_END,
      endDate: new Date(N + DAY),
      issuedAt: ROOT_END,
      parentBookingId: root.id,
      rootBookingId: root.id,
      items: { create: [{ equipmentId: lens, quantity: 1, coveredShifts: 1, shiftAnchorAt: ROOT_START, listRatePerShift: 2000 }] },
    },
    include: { items: true },
  });
  await prisma.bookingItemUnit.create({ data: { bookingItemId: child.items[0].id, equipmentUnitId: unit.id } });
  const { rebuildBookingEstimate } = await import("../services/bookings");
  const { recomputeBookingFinance } = await import("../services/finance");
  await rebuildBookingEstimate(child.id);
  await recomputeBookingFinance(child.id);
  return { root: root.id as string, child: child.id as string, unit: unit.id as string };
}

const cancel = (id: string, body: Record<string, unknown> = { reason: "Всё вернули вместе с основной" }, token = saToken) =>
  request(app).post(`/api/bookings/${id}/cancel-continuation`).set(AUTH(token)).send(body);

describe("«Отменить продолжение»", () => {
  it("руководитель отменяет: продолжение «Отменена», единица на складе, долг исчез, журнал с причиной", async () => {
    const { child, unit } = await mkFamily();
    expect(Number((await prisma.booking.findUnique({ where: { id: child } })).amountOutstanding)).toBeGreaterThan(0);
    const res = await cancel(child);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ bookingId: child, releasedUnits: 1 });
    const after = await prisma.booking.findUnique({ where: { id: child } });
    expect(after.status).toBe("CANCELLED");
    expect((await prisma.equipmentUnit.findUnique({ where: { id: unit } })).status).toBe("AVAILABLE");
    const reservation = await prisma.bookingItemUnit.findFirst({ where: { equipmentUnitId: unit } });
    expect(reservation.returnedAt).not.toBeNull();
    const debts = await request(app).get("/api/finance/debts").set(AUTH());
    expect(JSON.stringify(debts.body)).not.toContain(child);
    const audit = await prisma.auditEntry.findFirst({ where: { entityId: child, action: "BOOKING_CONTINUATION_CANCELLED" } });
    const payload = typeof audit.after === "string" ? JSON.parse(audit.after) : audit.after;
    expect(payload).toMatchObject({ status: "CANCELLED", reason: "Всё вернули вместе с основной", releasedUnits: 1 });
  });

  it("кладовщику — нельзя", async () => {
    const { child } = await mkFamily();
    const res = await cancel(child, undefined, whToken);
    expect(res.status).toBe(403);
    expect((await prisma.booking.findUnique({ where: { id: child } })).status).toBe("ISSUED");
  });

  it("основную бронь так не отменить", async () => {
    const { root } = await mkFamily();
    const res = await cancel(root);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("NOT_A_CONTINUATION");
  });

  it("по продолжению есть оплата — отказ", async () => {
    const { child } = await mkFamily();
    await prisma.booking.update({ where: { id: child }, data: { amountPaid: 1000 } });
    const res = await cancel(child);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CONTINUATION_HAS_PAYMENTS");
    expect((await prisma.booking.findUnique({ where: { id: child } })).status).toBe("ISSUED");
  });

  it("уже принятое продолжение — отказ; причина короче трёх символов — 400", async () => {
    const { child: returned } = await mkFamily({ childStatus: "RETURNED" });
    const notOut = await cancel(returned);
    expect(notOut.status).toBe(409);
    expect(notOut.body.code).toBe("CONTINUATION_NOT_OUT");
    const { child } = await mkFamily();
    const short = await cancel(child, { reason: "да" });
    expect(short.status).toBe(400);
  });
});
