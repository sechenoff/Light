/**
 * Продолжение брони: расчёт сверх оплаченного и гарды семьи.
 *
 * Продолжения пока создаёт только тест (частичная приёмка — этап 10): бронь-
 * продолжение с parentBookingId и позициями с покрытием (coveredShifts,
 * shiftAnchorAt, listRatePerShift) пишется прямо в базу.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-continuation-family.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-cfam";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-continuation";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-cfam";
process.env.JWT_SECRET = "test-jwt-continuation-16chars";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Основная бронь на 1 смену, кончилась вчера; продолжение — до завтра.
const N = Math.floor(Date.now() / HOUR) * HOUR;
const ROOT_START = new Date(N - 2 * DAY);
const ROOT_END = new Date(N - DAY);

let app: Express;
let prisma: any;
let saToken: string;
let billing: typeof import("../services/continuationPricing");
let rebuildBookingEstimate: typeof import("../services/bookings").rebuildBookingEstimate;
let clientId: string;
let storm: string; // 1 000 ₽ / смена
let stand: string; //   500 ₽ / смена
let seq = 0;

const AUTH = () => ({ "X-API-Key": "test-key-cfam", Authorization: `Bearer ${saToken}` });

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, DATABASE_URL: `file:${TEST_DB_PATH}`, PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes" },
    stdio: "pipe",
  });
  app = (await import("../app")).app;
  prisma = (await import("../prisma")).prisma;
  billing = await import("../services/continuationPricing");
  ({ rebuildBookingEstimate } = await import("../services/bookings"));
  const { signSession } = await import("../services/auth");
  const sa = await prisma.adminUser.create({ data: { username: "sa-cfam", passwordHash: "x", role: "SUPER_ADMIN" } });
  saToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });
  clientId = (await prisma.client.create({ data: { name: "Продакшн «Сфера»" } })).id;
  const mk = (key: string, name: string, rate: number) =>
    prisma.equipment.create({
      data: { importKey: key, name, category: "Свет", totalQuantity: 20, rentalRatePerShift: rate, stockTrackingMode: "COUNT" },
    });
  storm = (await mk("cfam-storm", "Aputure STORM 400x", 1000)).id;
  stand = (await mk("cfam-stand", "Стойка C-Stand", 500)).id;
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    const f = `${TEST_DB_PATH}${suffix}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

/**
 * Семья: основная (RETURNED) и продолжение (ISSUED, до завтра). В продолжении
 * STORM ×2 «по плану» (позиция на 3 смены — оплачено как раз до завтра) и
 * стойка ×1 сверх оплаченного (покрыта 1 смена — до вчера), ставка стойки
 * зафиксирована 600 ₽.
 */
async function mkFamily() {
  seq += 1;
  const root = await prisma.booking.create({
    data: {
      clientId,
      projectName: `Основная ${seq}`,
      status: "RETURNED",
      startDate: ROOT_START,
      endDate: ROOT_END,
      discountPercent: 50,
      items: { create: [{ equipmentId: storm, quantity: 4, shifts: 3 }, { equipmentId: stand, quantity: 3 }] },
    },
  });
  const child = await prisma.booking.create({
    data: {
      clientId,
      projectName: `Основная ${seq}`,
      status: "ISSUED",
      startDate: ROOT_END,
      endDate: new Date(N + DAY),
      issuedAt: ROOT_END,
      confirmedAt: ROOT_END,
      discountPercent: 50,
      parentBookingId: root.id,
      rootBookingId: root.id,
      items: {
        create: [
          { equipmentId: storm, quantity: 2, coveredShifts: 3, shiftAnchorAt: ROOT_START, listRatePerShift: 1000 },
          { equipmentId: stand, quantity: 1, coveredShifts: 1, shiftAnchorAt: ROOT_START, listRatePerShift: 600 },
        ],
      },
    },
  });
  await rebuildBookingEstimate(child.id);
  return { root: root.id as string, child: child.id as string };
}

const mainOf = (bookingId: string) => prisma.estimate.findFirst({ where: { bookingId, kind: "MAIN" }, include: { lines: true } });
const lineOf = (est: any, name: string) => est.lines.find((l: any) => l.nameSnapshot === name);

describe("сколько смен выставить за оставленное", () => {
  const at = (ms: number) => new Date(ROOT_START.getTime() + ms);
  const covered = (n: number) => billing.rootLineCoverage(ROOT_START, n);

  it("в пределах оплаченного — 0 смен", () => {
    const r = billing.continuationBilling({ coverage: covered(2), splitAt: at(DAY), until: at(2 * DAY), skipPartialDay: false });
    expect(r.billedShifts).toBe(0);
  });

  it("сверх оплаченного — ровно лишние смены по сетке основной брони", () => {
    const r = billing.continuationBilling({ coverage: covered(1), splitAt: at(DAY), until: at(3 * DAY), skipPartialDay: false });
    expect(r.billedShifts).toBe(2);
    expect(r.next).toEqual({ anchorAt: ROOT_START, coveredShifts: 3 });
  });

  it("основную сдали раньше срока — короткий хвост не выставляется лишней сменой", () => {
    // Оплачено 2 смены, сдали через 30 ч, оставили до конца 2-й смены + 2 ч.
    const r = billing.continuationBilling({ coverage: covered(2), splitAt: at(30 * HOUR), until: at(2 * DAY + 2 * HOUR), skipPartialDay: false });
    expect(r.billedShifts).toBe(1);
  });

  it("основную приняли позже оплаченного — опоздание не считается, счёт от приёмки", () => {
    // Оплачено 1 смена (до +24 ч), приняли на 8 ч позже, оставили ещё на 16 ч.
    const r = billing.continuationBilling({ coverage: covered(1), splitAt: at(32 * HOUR), until: at(48 * HOUR), skipPartialDay: false });
    expect(r.billedShifts).toBe(1);
    expect(r.next).toEqual({ anchorAt: at(32 * HOUR), coveredShifts: 1 });
  });

  it("«не считать вторые сутки»: хвост до 4 ч сверх оплаченного прощается", () => {
    const r = billing.continuationBilling({ coverage: covered(1), splitAt: at(DAY), until: at(DAY + 3 * HOUR), skipPartialDay: true });
    expect(r.billedShifts).toBe(0);
  });
});

describe("смета продолжения", () => {
  it("«по плану» — 0 ₽ и 0 смен, сверх оплаченного — по зафиксированной ставке, скидка брони", async () => {
    const { child } = await mkFamily();
    const main = await mainOf(child);
    const plan = lineOf(main, "Aputure STORM 400x");
    expect(plan.shifts).toBe(0);
    expect(Number(plan.lineSum)).toBe(0);
    const extra = lineOf(main, "Стойка C-Stand");
    // Покрыта 1 смена из 3 (с начала основной до завтра) — выставляется 2 по 600 ₽.
    expect(extra.shifts).toBe(2);
    expect(Number(extra.unitPrice)).toBe(1200);
    expect(Number(main.subtotal)).toBe(1200);
    expect(Number(main.totalAfterDiscount)).toBe(600);
  });

  it("«бумажная» правка продолжения (скидка) пересобирает смету по тому же правилу", async () => {
    const { child } = await mkFamily();
    const res = await request(app).patch(`/api/bookings/${child}`).set(AUTH()).send({ retroactive: true, discountPercent: 0 });
    expect(res.status).toBe(200);
    const main = await mainOf(child);
    expect(Number(lineOf(main, "Aputure STORM 400x").lineSum)).toBe(0);
    expect(Number(main.totalAfterDiscount)).toBe(1200);
  });

  it("превью такой правки считает так же", async () => {
    const { child } = await mkFamily();
    const res = await request(app).patch(`/api/bookings/${child}`).set(AUTH()).send({ dryRun: true, discountPercent: 0 });
    expect(res.status).toBe(200);
    expect(res.body.booking.estimate.subtotal).toBe("1200");
  });
});

describe("смета продолжения: крайние случаи", () => {
  it("основную приняли позже оплаченного — опоздание не выставляется, счёт от приёмки", async () => {
    seq += 1;
    const root = await prisma.booking.create({
      data: { clientId, projectName: `Опоздание ${seq}`, status: "RETURNED", startDate: ROOT_START, endDate: ROOT_END, items: { create: [{ equipmentId: stand, quantity: 2 }] } },
    });
    // Оплачено до ROOT_END, приняли на 8 ч позже, оставили ещё на 16 ч от приёмки.
    const splitAt = new Date(ROOT_END.getTime() + 8 * HOUR);
    const child = await prisma.booking.create({
      data: {
        clientId,
        projectName: `Опоздание ${seq}`,
        status: "ISSUED",
        startDate: ROOT_END,
        endDate: new Date(splitAt.getTime() + 16 * HOUR),
        issuedAt: splitAt,
        parentBookingId: root.id,
        rootBookingId: root.id,
        items: { create: [{ equipmentId: stand, quantity: 1, coveredShifts: 1, shiftAnchorAt: ROOT_START, listRatePerShift: 500 }] },
      },
    });
    await rebuildBookingEstimate(child.id);
    const line = lineOf(await mainOf(child.id), "Стойка C-Stand");
    expect(line.shifts).toBe(1);
    expect(Number(line.lineSum)).toBe(500);
  });

  it("своя позиция в продолжении — 0 ₽: её фиксированная цена уже в основной смете", async () => {
    seq += 1;
    const root = await prisma.booking.create({
      data: { clientId, projectName: `Своя ${seq}`, status: "RETURNED", startDate: ROOT_START, endDate: ROOT_END },
    });
    const child = await prisma.booking.create({
      data: {
        clientId,
        projectName: `Своя ${seq}`,
        status: "ISSUED",
        startDate: ROOT_END,
        endDate: new Date(N + DAY),
        issuedAt: ROOT_END,
        parentBookingId: root.id,
        rootBookingId: root.id,
        items: {
          create: [{ customName: "Расходники", customUnitPrice: 1500, customCategory: "Произвольная позиция", quantity: 1, coveredShifts: 1, shiftAnchorAt: ROOT_START }],
        },
      },
    });
    await rebuildBookingEstimate(child.id);
    const line = lineOf(await mainOf(child.id), "Расходники");
    expect(Number(line.lineSum)).toBe(0);
    expect(line.shifts).toBe(0);
  });

  it("после правки продолжения добора не появляется: 0 ₽-строки идут полным количеством", async () => {
    const { child } = await mkFamily();
    await request(app).patch(`/api/bookings/${child}`).set(AUTH()).send({ retroactive: true, comment: "Перезвонить" });
    expect(await prisma.estimate.findFirst({ where: { bookingId: child, kind: "ADDON" } })).toBeNull();
  });
});

describe("гарды семьи", () => {
  it("«не считать вторые сутки» в семье не меняется", async () => {
    const { root, child } = await mkFamily();
    const onChild = await request(app).patch(`/api/bookings/${child}`).set(AUTH()).send({ retroactive: true, skipPartialDay: true });
    expect(onChild.status).toBe(409);
    expect(onChild.body.code).toBe("CONTINUATION_EDIT_FORBIDDEN");
    const onRoot = await request(app).patch(`/api/bookings/${root}`).set(AUTH()).send({ retroactive: true, skipPartialDay: true });
    expect(onRoot.status).toBe(409);
    expect(onRoot.body.code).toBe("HAS_CONTINUATION");
  });

  it("превью правки, которую семья не пропустит, — тот же отказ", async () => {
    const { root } = await mkFamily();
    const res = await request(app)
      .patch(`/api/bookings/${root}`)
      .set(AUTH())
      .send({ dryRun: true, endDate: new Date(N).toISOString() });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("HAS_CONTINUATION");
  });

  it("у основной брони с продолжением даты не правятся, «бумажные» поля — да", async () => {
    const { root } = await mkFamily();
    const dates = await request(app)
      .patch(`/api/bookings/${root}`)
      .set(AUTH())
      .send({ retroactive: true, endDate: new Date(N).toISOString() });
    expect(dates.status).toBe(409);
    expect(dates.body.code).toBe("HAS_CONTINUATION");
    const paper = await request(app).patch(`/api/bookings/${root}`).set(AUTH()).send({ retroactive: true, comment: "Правка комментария" });
    expect(paper.status).toBe(200);
    const backdate = await request(app)
      .patch(`/api/bookings/${root}/backdate`)
      .set(AUTH())
      .send({ endDate: new Date(N).toISOString(), reason: "Сдвиг по договорённости" });
    expect(backdate.status).toBe(409);
    expect(backdate.body.code).toBe("HAS_CONTINUATION");
  });

  it("у продолжения начало не правится, продление — позже, добора нет", async () => {
    const { child } = await mkFamily();
    const start = await request(app)
      .patch(`/api/bookings/${child}`)
      .set(AUTH())
      .send({ retroactive: true, startDate: new Date(N - DAY - HOUR).toISOString() });
    expect(start.status).toBe(409);
    expect(start.body.code).toBe("CONTINUATION_EDIT_FORBIDDEN");
    const extend = await request(app)
      .patch(`/api/bookings/${child}`)
      .set(AUTH())
      .send({ extendEndDate: new Date(N + 2 * DAY).toISOString() });
    expect(extend.status).toBe(409);
    expect(extend.body.code).toBe("CONTINUATION_EXTEND_NOT_YET");
    const search = await request(app).get(`/api/bookings/${child}/addon-search`).query({ q: "сто" }).set(AUTH());
    expect(search.status).toBe(409);
    expect(search.body.code).toBe("CONTINUATION_ADDON_FORBIDDEN");
    const add = await request(app)
      .post(`/api/bookings/${child}/addon-items`)
      .set(AUTH())
      .send({ items: [{ equipmentId: stand, quantity: 1 }], mode: "ADDON" });
    expect(add.status).toBe(409);
    expect(add.body.code).toBe("CONTINUATION_ADDON_FORBIDDEN");
  });

  it("архив: ни основную с живым продолжением, ни продолжение у клиента", async () => {
    const { root, child } = await mkFamily();
    const rootArchive = await request(app).delete(`/api/bookings/${root}`).set(AUTH());
    expect(rootArchive.status).toBe(409);
    expect(rootArchive.body.code).toBe("HAS_CONTINUATION");
    const childArchive = await request(app).delete(`/api/bookings/${child}`).set(AUTH());
    expect(childArchive.status).toBe(409);
    expect(childArchive.body.code).toBe("CONTINUATION_STILL_OUT");
    // Отменённое продолжение семью не держит.
    await prisma.booking.update({ where: { id: child }, data: { status: "CANCELLED" } });
    expect((await request(app).delete(`/api/bookings/${root}`).set(AUTH())).status).toBe(200);
  });

  it("удалить навсегда бронь, от которой отделяли продолжение, нельзя", async () => {
    const { root, child } = await mkFamily();
    await prisma.booking.update({ where: { id: child }, data: { status: "CANCELLED" } });
    await request(app).delete(`/api/bookings/${root}`).set(AUTH());
    const purge = await request(app).delete(`/api/bookings/${root}/purge`).set(AUTH());
    expect(purge.status).toBe(409);
    expect(purge.body.code).toBe("HAS_CONTINUATION");
  });

  it("обычная бронь без продолжений правится как раньше", async () => {
    seq += 1;
    const plain = await prisma.booking.create({
      data: {
        clientId,
        projectName: `Обычная ${seq}`,
        status: "RETURNED",
        startDate: ROOT_START,
        endDate: ROOT_END,
        items: { create: [{ equipmentId: stand, quantity: 1 }] },
      },
    });
    const res = await request(app)
      .patch(`/api/bookings/${plain.id}`)
      .set(AUTH())
      .send({ retroactive: true, endDate: new Date(N).toISOString() });
    expect(res.status).toBe(200);
  });
});
