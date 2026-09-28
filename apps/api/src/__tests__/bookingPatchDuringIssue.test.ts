/**
 * Правка брони (PATCH) и выдача в киоске; «бумажная» правка задним числом.
 *
 * До исправления:
 *  - руководитель правил состав подтверждённой брони, пока склад выдавал её
 *    в киоске: PATCH пересоздавал позиции delete+create, каскадом стирал
 *    записи добора киоска, а «Готово» со степпером падало 400
 *    «bookingItem не принадлежит этой брони» (24.09) — P14;
 *  - правка комментария или названия выданной брони задним числом вливала
 *    доп-смету в основную и молча переоценивала бронь по текущему прайсу — P24.
 */
import path from "path";
import { execSync } from "child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-booking-patch-during-issue.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-bpi";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-bpi";
process.env.WAREHOUSE_SECRET = "test-warehouse-bpi-16chars";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-bpi-min16chars";

let app: any;
let prisma: any;
let saToken: string;
let whToken: string;
let clientId: string;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const H = (token: string) => ({ "X-API-Key": "test-key-bpi", Authorization: `Bearer ${token}` });
const num = (v: unknown) => Number(String(v));

let seq = 0;
async function mkEq(name: string, total: number, rate = "1000") {
  seq += 1;
  return (
    await prisma.equipment.create({
      data: { importKey: `bpi-${seq}`, name, category: "Свет", rentalRatePerShift: rate, stockTrackingMode: "COUNT", totalQuantity: total },
    })
  ).id as string;
}

/** Бронь с MAIN-сметой на 1 смену (24 ч), без скидки. */
async function mkBooking(opts: {
  status: "CONFIRMED" | "ISSUED" | "RETURNED";
  start: Date;
  items: Array<{ equipmentId: string; quantity: number }>;
  project: string;
}) {
  const total = opts.items.reduce((s, i) => s + i.quantity * 1000, 0);
  const b = await prisma.booking.create({
    data: {
      clientId,
      projectName: opts.project,
      startDate: opts.start,
      endDate: new Date(opts.start.getTime() + DAY),
      status: opts.status,
      issuedAt: opts.status !== "CONFIRMED" ? opts.start : null,
      confirmedAt: new Date(),
      totalEstimateAmount: String(total),
      discountAmount: "0",
      finalAmount: String(total),
      amountOutstanding: String(total),
      legacyFinance: false,
      items: { create: opts.items.map((i) => ({ equipmentId: i.equipmentId, quantity: i.quantity })) },
      estimates: {
        create: {
          kind: "MAIN",
          shifts: 1,
          subtotal: String(total),
          discountAmount: "0",
          totalAfterDiscount: String(total),
          lines: {
            create: opts.items.map((i) => ({
              equipmentId: i.equipmentId,
              categorySnapshot: "Свет",
              nameSnapshot: "Позиция",
              quantity: i.quantity,
              unitPrice: "1000",
              lineSum: String(i.quantity * 1000),
            })),
          },
        },
      },
    },
  });
  return b.id as string;
}

/** Выдача в киоске, в которой уже добрали позицию на месте (есть работа). */
async function issueSessionWithAddon(bookingId: string, equipmentId: string) {
  const s = await prisma.scanSession.create({
    data: { bookingId, operation: "ISSUE", workerName: "Иван Кладовщик", status: "ACTIVE" },
  });
  const item = await prisma.bookingItem.create({ data: { bookingId, equipmentId, quantity: 1 } });
  await prisma.addonRecord.create({
    data: { bookingId, sessionId: s.id, bookingItemId: item.id, equipmentId, quantity: 1, createdBy: "Иван Кладовщик" },
  });
  return s.id as string;
}

const patch = (id: string, body: Record<string, unknown>) =>
  request(app).patch(`/api/bookings/${id}`).set(H(saToken)).send(body);
const estimates = async (bookingId: string) => ({
  main: await prisma.estimate.findFirst({ where: { bookingId, kind: "MAIN" }, include: { lines: true } }),
  addon: await prisma.estimate.findFirst({ where: { bookingId, kind: "ADDON" }, include: { lines: true } }),
  booking: await prisma.booking.findUnique({ where: { id: bookingId } }),
});

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, DATABASE_URL: `file:${TEST_DB_PATH}`, PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes" },
    stdio: "pipe",
  });
  prisma = (await import("../prisma")).prisma;
  app = (await import("../app")).app;
  const { hashPassword, signSession } = await import("../services/auth");
  const hash = await hashPassword("bpi-pass-123456");
  const sa = await prisma.adminUser.create({ data: { username: "bpi_sa", passwordHash: hash, role: "SUPER_ADMIN" } });
  saToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });
  const wh = await prisma.adminUser.create({ data: { username: "bpi_wh", passwordHash: hash, role: "WAREHOUSE" } });
  whToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });
  clientId = (await prisma.client.create({ data: { name: "Клиент правки", phone: "+70000004545" } })).id;
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
});

describe("P14: правка состава, пока идёт выдача в киоске", () => {
  it("состав или даты → 409 SCAN_SESSION_ACTIVE, добор киоска цел; комментарий — можно", async () => {
    const eqA = await mkEq("Выдача прибор", 10);
    const eqB = await mkEq("Выдача добор", 10);
    const id = await mkBooking({ status: "CONFIRMED", start: new Date(Date.now() + 2 * DAY), items: [{ equipmentId: eqA, quantity: 2 }], project: "Правка во время выдачи" });
    const sid = await issueSessionWithAddon(id, eqB);

    const items = await patch(id, { items: [{ equipmentId: eqA, quantity: 3 }, { equipmentId: eqB, quantity: 1 }] });
    expect(items.status).toBe(409);
    expect(items.body.code).toBe("SCAN_SESSION_ACTIVE");
    expect(items.body.details).toMatchObject({ sessionId: sid, operation: "ISSUE" });
    expect(items.body.message).toMatch(/открыта выдача/);
    expect(await prisma.addonRecord.count({ where: { bookingId: id } })).toBe(1);
    expect((await prisma.bookingItem.findFirst({ where: { bookingId: id, equipmentId: eqA } })).quantity).toBe(2);

    const b = await prisma.booking.findUnique({ where: { id } });
    const dates = await patch(id, { endDate: new Date(b.endDate.getTime() + DAY).toISOString() });
    expect(dates.status).toBe(409);
    expect(dates.body.code).toBe("SCAN_SESSION_ACTIVE");

    // Те же даты (форма шлёт их при каждом сохранении) и комментарий — не мешают выдаче.
    const comment = await patch(id, {
      comment: "позвонить гаферу",
      startDate: b.startDate.toISOString(),
      endDate: b.endDate.toISOString(),
    });
    expect(comment.status, JSON.stringify(comment.body)).toBe(200);
    expect(await prisma.addonRecord.count({ where: { bookingId: id } })).toBe(1);
  });

  it("выдачу открыли и ничего не сделали — правка состава проходит", async () => {
    const eqA = await mkEq("Пустая выдача прибор", 10);
    const id = await mkBooking({ status: "CONFIRMED", start: new Date(Date.now() + 2 * DAY), items: [{ equipmentId: eqA, quantity: 2 }], project: "Пустая выдача" });
    await prisma.scanSession.create({ data: { bookingId: id, operation: "ISSUE", workerName: "Иван", status: "ACTIVE" } });
    const res = await patch(id, { items: [{ equipmentId: eqA, quantity: 3 }] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("правка кладовщика тоже упирается в выдачу (проверка не зависит от роли)", async () => {
    const eqA = await mkEq("Кладовщик прибор", 10);
    const eqB = await mkEq("Кладовщик добор", 10);
    const id = await mkBooking({ status: "CONFIRMED", start: new Date(Date.now() + 2 * DAY), items: [{ equipmentId: eqA, quantity: 2 }], project: "Кладовщик правит" });
    await issueSessionWithAddon(id, eqB);
    const res = await request(app).patch(`/api/bookings/${id}`).set(H(whToken)).send({ items: [{ equipmentId: eqA, quantity: 5 }] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("SCAN_SESSION_ACTIVE");
  });
});

describe("P24: «бумажная» правка задним числом", () => {
  it("выданная бронь с доп-сметой: правка названия не вливает доп-смету в основную", async () => {
    const eq = await mkEq("Бумажная прибор", 10);
    const id = await mkBooking({ status: "ISSUED", start: new Date(Date.now() - HOUR), items: [{ equipmentId: eq, quantity: 1 }], project: "До переименования" });
    const added = await request(app)
      .post(`/api/bookings/${id}/addon-items`)
      .set(H(whToken))
      .send({ items: [{ equipmentId: eq, quantity: 2 }], mode: "ADDON" });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const before = await estimates(id);
    expect(before.addon).toBeTruthy();

    const res = await patch(id, { retroactive: true, projectName: "Переименовали" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = await estimates(id);
    expect(after.booking.projectName).toBe("Переименовали");
    expect(after.addon).toBeTruthy();
    expect(after.addon.lines[0].quantity).toBe(2);
    expect(after.main.lines[0].quantity).toBe(1);
    expect(num(after.booking.finalAmount)).toBe(num(before.booking.finalAmount));
    expect(res.body.warning ?? null).toBeNull();
  });

  it("возвращённая бронь, прайс вырос: правка комментария предупреждает, что сумма пересчитана", async () => {
    const eq = await mkEq("Прайс вырос прибор", 10, "1000");
    const start = new Date(Date.now() - 3 * DAY);
    const id = await mkBooking({ status: "RETURNED", start, items: [{ equipmentId: eq, quantity: 2 }], project: "Прайс вырос" });
    await prisma.equipment.update({ where: { id: eq }, data: { rentalRatePerShift: "1500" } });

    const res = await patch(id, { retroactive: true, comment: "позвонить" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.warning).toMatch(/^Сумма к оплате пересчитана по текущим ценам каталога: было 2\s000 ₽, стало 3\s000 ₽/);
  });

  it("правка состава задним числом — сумма меняется без предупреждения (это и есть цель правки)", async () => {
    const eq = await mkEq("Состав задним числом", 10, "1000");
    const start = new Date(Date.now() - 3 * DAY);
    const id = await mkBooking({ status: "RETURNED", start, items: [{ equipmentId: eq, quantity: 2 }], project: "Состав задним" });
    const res = await patch(id, { retroactive: true, items: [{ equipmentId: eq, quantity: 3 }] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(num((await estimates(id)).booking.finalAmount)).toBe(3000);
    expect(res.body.warning ?? null).toBeNull();
  });

  it("продление выданной брони по-прежнему сохраняет доп-смету", async () => {
    const eq = await mkEq("Продление прибор", 10);
    const start = new Date(Date.now() - HOUR);
    const id = await mkBooking({ status: "ISSUED", start, items: [{ equipmentId: eq, quantity: 1 }], project: "Продление" });
    expect((await request(app).post(`/api/bookings/${id}/addon-items`).set(H(whToken)).send({ items: [{ equipmentId: eq, quantity: 2 }], mode: "ADDON" })).status).toBe(201);
    const ext = await patch(id, { extendEndDate: new Date(start.getTime() + 2 * DAY).toISOString() });
    expect(ext.status, JSON.stringify(ext.body)).toBe(200);
    const s = await estimates(id);
    expect(s.addon).toBeTruthy();
    expect(s.addon.lines[0].quantity).toBe(2);
  });
});
