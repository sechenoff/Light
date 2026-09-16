/**
 * Форма оплаты брони и надбавка за безналичный расчёт («По счёту (ИП)»).
 *
 * Наличные — цена как в смете. Безнал — к итогу плюсуется процент: дефолт из
 * настроек организации (9 %), на брони его можно перебить. Надбавка живёт
 * снапшотом на брони, входит в finalAmount и печатается отдельной строкой в
 * полной смете.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import Decimal from "decimal.js";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-payment-surcharge.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-surcharge";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-surcharge";
process.env.WAREHOUSE_SECRET = "test-warehouse-surcharge";
process.env.JWT_SECRET = "test-jwt-surcharge-min16chars";
process.env.APPROVAL_MODE = "manual";

let app: Express;
let prisma: any;
let saToken: string;
let whToken: string;
let equipmentId: string;

const START = new Date(Date.now() + 7 * 86_400_000);
START.setUTCHours(9, 0, 0, 0);
const END = new Date(START.getTime() + 2 * 86_400_000); // 2 смены

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
  const hash = await hashPassword("pass-123");
  const sa = await prisma.adminUser.create({ data: { username: "sur_sa", passwordHash: hash, role: "SUPER_ADMIN" } });
  saToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });
  const wh = await prisma.adminUser.create({ data: { username: "sur_wh", passwordHash: hash, role: "WAREHOUSE" } });
  whToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });

  const eq = await prisma.equipment.create({
    data: {
      importKey: "СВЕТ||НАДБАВКА||GENERIC||SUR-1",
      name: "Прожектор для безнала",
      category: "Свет",
      totalQuantity: 10,
      rentalRatePerShift: "5000",
      stockTrackingMode: "COUNT",
    },
  });
  equipmentId = eq.id;
  // Дефолт 9 % — как у владельца.
  await prisma.organizationSettings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", legalName: "ИП Тестов", inn: "123456789012", cashlessSurchargePercent: "9" },
    update: { cashlessSurchargePercent: "9" },
  });
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

const SA = () => ({ "X-API-Key": "test-key-surcharge", Authorization: `Bearer ${saToken}` });
const WH = () => ({ "X-API-Key": "test-key-surcharge", Authorization: `Bearer ${whToken}` });

// 2 смены × 5000 × 1 шт = 10 000; без скидки
const basePayload = (extra: Record<string, unknown> = {}) => ({
  client: { name: "ООО «Безнал»" },
  projectName: `Съёмка ${Math.random().toString(36).slice(2, 8)}`,
  startDate: START.toISOString(),
  endDate: END.toISOString(),
  items: [{ equipmentId, quantity: 1 }],
  discountPercent: 0,
  ...extra,
});

describe("POST /api/bookings/quote — форма оплаты", () => {
  it("наличные: надбавки нет, grandTotal = оборудование", async () => {
    const res = await request(app).post("/api/bookings/quote").set(SA()).send(basePayload());
    expect(res.status).toBe(200);
    expect(res.body.paymentForm).toBe("CASH");
    expect(res.body.surchargePercent).toBeNull();
    expect(res.body.surchargeAmount).toBe("0.00");
    expect(res.body.grandTotal).toBe("10000.00");
  });

  it("безнал без процента берёт дефолт 9 % из настроек", async () => {
    const res = await request(app).post("/api/bookings/quote").set(SA()).send(basePayload({ paymentForm: "CASHLESS" }));
    expect(res.status).toBe(200);
    expect(res.body.paymentForm).toBe("CASHLESS");
    expect(res.body.surchargePercent).toBe("9");
    expect(res.body.surchargeAmount).toBe("900.00");
    expect(res.body.grandTotal).toBe("10900.00");
    // Оборудование не трогаем — надбавка идёт отдельной строкой.
    expect(res.body.equipmentTotal).toBe("10000.00");
  });

  it("явный процент перебивает дефолт", async () => {
    const res = await request(app)
      .post("/api/bookings/quote")
      .set(SA())
      .send(basePayload({ paymentForm: "CASHLESS", cashlessSurchargePercent: 12.5 }));
    expect(res.status).toBe(200);
    expect(res.body.surchargePercent).toBe("12.5");
    expect(res.body.surchargeAmount).toBe("1250.00");
    expect(res.body.grandTotal).toBe("11250.00");
  });

  it("надбавка считается и с транспорта тоже (база = оборудование + транспорт)", async () => {
    const van = await prisma.vehicle.create({
      data: { name: "Газель надбавки", slug: `van-surcharge-${Date.now()}`, shiftPriceRub: "4000", currentMileage: 1000 },
    });
    const res = await request(app)
      .post("/api/bookings/quote")
      .set(SA())
      .send(
        basePayload({
          paymentForm: "CASHLESS",
          transport: [{ vehicleId: van.id, withGenerator: false, shiftHours: 12, skipOvertime: true, kmOutsideMkad: 0, ttkEntry: false }],
        }),
      );
    expect(res.status).toBe(200);
    const transport = new Decimal(res.body.transportSubtotal);
    expect(transport.gt(0)).toBe(true);
    const expected = new Decimal("10000").add(transport).mul(0.09).toDecimalPlaces(2);
    expect(res.body.surchargeAmount).toBe(expected.toFixed(2));
    expect(res.body.grandTotal).toBe(new Decimal("10000").add(transport).add(expected).toFixed(2));
  });

  it("процент вне 0–100 отвергается", async () => {
    const res = await request(app)
      .post("/api/bookings/quote")
      .set(SA())
      .send(basePayload({ paymentForm: "CASHLESS", cashlessSurchargePercent: 150 }));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/bookings/draft + PATCH — снапшот на брони", () => {
  it("черновик по счёту фиксирует форму, процент и сумму надбавки в finalAmount", async () => {
    const res = await request(app).post("/api/bookings/draft").set(SA()).send(basePayload({ paymentForm: "CASHLESS" }));
    expect(res.status).toBe(200);
    const id = res.body.booking.id;
    const b = await prisma.booking.findUnique({ where: { id } });
    expect(b.paymentForm).toBe("CASHLESS");
    expect(b.cashlessSurchargePercent.toString()).toBe("9");
    expect(b.surchargeAmount.toString()).toBe("900");
    expect(b.finalAmount.toString()).toBe("10900");
    expect(b.amountOutstanding.toString()).toBe("10900");
  });

  it("dryRun черновика показывает надбавку в estimate", async () => {
    const res = await request(app)
      .post("/api/bookings/draft")
      .set(SA())
      .send(basePayload({ paymentForm: "CASHLESS", dryRun: true }));
    expect(res.status).toBe(200);
    expect(res.body.booking.estimate.surchargePercent).toBe("9");
    expect(res.body.booking.estimate.surchargeAmount).toBe("900.00");
    expect(res.body.booking.estimate.grandTotal).toBe("10900.00");
  });

  it("смена дефолта в настройках не меняет уже созданную бронь; пересчёт финансов сохраняет надбавку", async () => {
    const created = await request(app).post("/api/bookings/draft").set(SA()).send(basePayload({ paymentForm: "CASHLESS" }));
    const id = created.body.booking.id;
    await prisma.organizationSettings.update({ where: { id: "singleton" }, data: { cashlessSurchargePercent: "15" } });
    try {
      const { recomputeBookingFinance } = await import("../services/finance");
      await recomputeBookingFinance(id);
      const b = await prisma.booking.findUnique({ where: { id } });
      expect(b.cashlessSurchargePercent.toString()).toBe("9");
      expect(b.surchargeAmount.toString()).toBe("900");
      expect(b.finalAmount.toString()).toBe("10900");
    } finally {
      await prisma.organizationSettings.update({ where: { id: "singleton" }, data: { cashlessSurchargePercent: "9" } });
    }
  });

  it("PATCH paymentForm=CASH снимает надбавку, CASHLESS без процента — берёт дефолт", async () => {
    const created = await request(app).post("/api/bookings/draft").set(SA()).send(basePayload({ paymentForm: "CASHLESS" }));
    const id = created.body.booking.id;

    const toCash = await request(app).patch(`/api/bookings/${id}`).set(SA()).send({ paymentForm: "CASH" });
    expect(toCash.status).toBe(200);
    let b = await prisma.booking.findUnique({ where: { id } });
    expect(b.paymentForm).toBe("CASH");
    expect(b.cashlessSurchargePercent).toBeNull();
    expect(b.surchargeAmount.toString()).toBe("0");
    expect(b.finalAmount.toString()).toBe("10000");

    const back = await request(app).patch(`/api/bookings/${id}`).set(SA()).send({ paymentForm: "CASHLESS" });
    expect(back.status).toBe(200);
    b = await prisma.booking.findUnique({ where: { id } });
    expect(b.paymentForm).toBe("CASHLESS");
    expect(b.cashlessSurchargePercent.toString()).toBe("9");
    expect(b.finalAmount.toString()).toBe("10900");

    // Только процент, форма уже безнал — перебивается.
    const pct = await request(app).patch(`/api/bookings/${id}`).set(SA()).send({ cashlessSurchargePercent: 5 });
    expect(pct.status).toBe(200);
    b = await prisma.booking.findUnique({ where: { id } });
    expect(b.cashlessSurchargePercent.toString()).toBe("5");
    expect(b.surchargeAmount.toString()).toBe("500");
    expect(b.finalAmount.toString()).toBe("10500");
  });

  it("PATCH dryRun показывает надбавку по форме из тела", async () => {
    const created = await request(app).post("/api/bookings/draft").set(SA()).send(basePayload());
    const id = created.body.booking.id;
    const res = await request(app).patch(`/api/bookings/${id}`).set(SA()).send({ dryRun: true, paymentForm: "CASHLESS" });
    expect(res.status).toBe(200);
    expect(res.body.booking.estimate.paymentForm).toBe("CASHLESS");
    expect(res.body.booking.estimate.surchargeAmount).toBe("900.00");
    expect(res.body.booking.estimate.grandTotal).toBe("10900.00");
  });

  it("кладовщик выбирает форму оплаты, но процент перебить не может — берётся дефолт", async () => {
    const created = await request(app)
      .post("/api/bookings/draft")
      .set(WH())
      .send(basePayload({ paymentForm: "CASHLESS", cashlessSurchargePercent: 50 }));
    expect(created.status).toBe(200);
    const id = created.body.booking.id;
    let b = await prisma.booking.findUnique({ where: { id } });
    expect(b.paymentForm).toBe("CASHLESS");
    expect(b.cashlessSurchargePercent.toString()).toBe("9");
    expect(b.finalAmount.toString()).toBe("10900");

    const patched = await request(app).patch(`/api/bookings/${id}`).set(WH()).send({ cashlessSurchargePercent: 50 });
    expect(patched.status).toBe(200);
    b = await prisma.booking.findUnique({ where: { id } });
    expect(b.cashlessSurchargePercent.toString()).toBe("9");

    // Руководитель — может.
    const sa = await request(app).patch(`/api/bookings/${id}`).set(SA()).send({ cashlessSurchargePercent: 12 });
    expect(sa.status).toBe(200);
    b = await prisma.booking.findUnique({ where: { id } });
    expect(b.cashlessSurchargePercent.toString()).toBe("12");
    expect(b.finalAmount.toString()).toBe("11200");
  });

  it("договорной итог надбавку не получает — это уже финальная сумма", async () => {
    const created = await request(app)
      .post("/api/bookings/draft")
      .set(SA())
      .send(basePayload({ paymentForm: "CASHLESS", manualFinalAmount: 9500 }));
    expect(created.status).toBe(200);
    const b = await prisma.booking.findUnique({ where: { id: created.body.booking.id } });
    expect(b.finalAmount.toString()).toBe("9500");
    // Расчётная надбавка при этом видна — по ней клиент понимает, из чего сложился расчёт.
    expect(b.surchargeAmount.toString()).toBe("900");
  });
});

describe("Полная смета печатает надбавку", () => {
  it("buildFullSmeta добавляет строку и включает её в grandTotal", async () => {
    const created = await request(app).post("/api/bookings/draft").set(SA()).send(basePayload({ paymentForm: "CASHLESS" }));
    const booking = await prisma.booking.findUnique({
      where: { id: created.body.booking.id },
      include: { client: true, estimates: { include: { lines: true } }, vehicles: { include: { vehicle: true } } },
    });
    const { buildFullSmeta } = await import("../services/smetaExport/buildFullDocument");
    const { resolveSurchargePercent } = await import("../services/paymentForm");
    const main = booking.estimates.find((e: any) => e.kind === "MAIN");
    const doc = buildFullSmeta({
      booking,
      main,
      addon: null,
      org: null,
      surchargePercent: resolveSurchargePercent({
        paymentForm: booking.paymentForm,
        cashlessSurchargePercent: booking.cashlessSurchargePercent,
      }),
    });
    expect(doc.surcharge).toEqual({ percent: "9", amount: "900" });
    expect(doc.grandTotal).toBe("10900");
  });

  it("экспорт PDF и XLSX полной сметы отдаёт файл", async () => {
    const created = await request(app).post("/api/bookings/draft").set(SA()).send(basePayload({ paymentForm: "CASHLESS" }));
    const id = created.body.booking.id;
    const pdf = await request(app).get(`/api/bookings/${id}/full-estimate/export/pdf`).set(SA()).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");
    const xlsx = await request(app).get(`/api/bookings/${id}/full-estimate/export/xlsx`).set(SA());
    expect(xlsx.status).toBe(200);
  });

  it("превью-экспорт /quote/export печатает надбавку (PDF/XLSX с общим блоком)", async () => {
    const pdf = await request(app)
      .post("/api/bookings/quote/export")
      .set(SA())
      .send(basePayload({ paymentForm: "CASHLESS", format: "pdf" }))
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(pdf.status).toBe(200);
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");
    const xlsx = await request(app)
      .post("/api/bookings/quote/export")
      .set(SA())
      .send(basePayload({ paymentForm: "CASHLESS", format: "xlsx" }));
    expect(xlsx.status).toBe(200);
  });
});

describe("Настройки организации — дефолтный процент", () => {
  it("PATCH /api/settings/organization принимает процент и реквизиты для счёта", async () => {
    const res = await request(app)
      .patch("/api/settings/organization")
      .set(SA())
      .send({ cashlessSurchargePercent: 9, ogrn: "312345678901234", signerName: "Тестов Т. Т.", signerTitle: "ИП", taxNote: "Без НДС (УСН)" });
    expect(res.status).toBe(200);
    expect(String(res.body.cashlessSurchargePercent)).toBe("9");
    expect(res.body.ogrn).toBe("312345678901234");
    expect(res.body.signerName).toBe("Тестов Т. Т.");
    expect(res.body.taxNote).toBe("Без НДС (УСН)");
    const bad = await request(app).patch("/api/settings/organization").set(SA()).send({ cashlessSurchargePercent: 101 });
    expect(bad.status).toBe(400);
  });
});
