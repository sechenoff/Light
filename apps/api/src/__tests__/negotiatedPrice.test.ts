/**
 * Договорная цена: позиция, машина, итог.
 *
 * Главный инвариант — процент ложится только на прайсовые строки. Договорная
 * цена уже результат переговоров, и начислять на неё скидку значило бы уступить
 * дважды: вписанные 18 000 превратились бы в 9 000.
 *
 * Второй инвариант — цена живёт на позиции брони, а не в снапшоте сметы.
 * Снапшот пересобирается в четырёх независимых местах, и записанная туда цена
 * была бы молча затёрта первой же правкой брони.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import Decimal from "decimal.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-negotiated-price.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-negotiated-16chars";
process.env.BARCODE_SECRET = "test-secret-np";

let prisma: any;
let quoteEstimate: any;
let createBookingDraft: any;
let rebuildBookingEstimate: any;
let recreateMainEstimate: any;
let resolveCatalogLinePrice: any;
let splitEquipmentDiscount: any;

const RATE = 25000;
const SHIFTS = 3;
const START = new Date("2026-09-10T09:00:00.000Z");
const END = new Date("2026-09-12T21:00:00.000Z");

let clientId: string;
let skyId: string;
let apuId: string;

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

  prisma = (await import("../prisma")).prisma;
  const svc = await import("../services/bookings");
  quoteEstimate = svc.quoteEstimate;
  createBookingDraft = svc.createBookingDraft;
  rebuildBookingEstimate = svc.rebuildBookingEstimate;
  recreateMainEstimate = (await import("../services/mainEstimate")).recreateMainEstimate;
  const pricing = await import("../services/pricing");
  resolveCatalogLinePrice = pricing.resolveCatalogLinePrice;
  splitEquipmentDiscount = pricing.splitEquipmentDiscount;

  const client = await prisma.client.create({ data: { name: "Гаффер Петя" } });
  clientId = client.id;
  const sky = await prisma.equipment.create({
    data: {
      importKey: "np-sky", name: "ARRI SkyPanel S60-C", category: "Свет",
      totalQuantity: 5, rentalRatePerShift: RATE, stockTrackingMode: "COUNT",
    },
  });
  skyId = sky.id;
  const apu = await prisma.equipment.create({
    data: {
      importKey: "np-apu", name: "Aputure LS 600d Pro", category: "Свет",
      totalQuantity: 5, rentalRatePerShift: 12000, stockTrackingMode: "COUNT",
    },
  });
  apuId = apu.id;
});

afterAll(async () => {
  await prisma?.$disconnect();
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    const f = `${TEST_DB_PATH}${suffix}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

describe("расчёт сметы с договорной ценой", () => {
  it("договорная цена задаётся ставкой за смену и множится на период", async () => {
    const quote = await quoteEstimate({
      startDate: START, endDate: END, clientId,
      discountPercent: 0,
      items: [{ equipmentId: skyId, quantity: 2, negotiatedRatePerShift: 18000 }],
    });
    const line = quote.lines[0];
    expect(Number(line.unitPrice)).toBe(18000 * SHIFTS);
    expect(Number(line.lineSum)).toBe(18000 * SHIFTS * 2);
    // Прайсовая цена сохранена — смете нужна для «цена до скидки».
    expect(Number(line.listUnitPrice)).toBe(RATE * SHIFTS);
    expect(line.isNegotiated).toBe(true);
  });

  it("процент НЕ применяется к договорной строке, но применяется к прайсовой", async () => {
    const quote = await quoteEstimate({
      startDate: START, endDate: END, clientId,
      discountPercent: 50,
      items: [
        { equipmentId: skyId, quantity: 2, negotiatedRatePerShift: 18000 }, // 108 000, без скидки
        { equipmentId: apuId, quantity: 3 },                                 // 108 000, −50%
      ],
    });
    expect(Number(quote.negotiatedSubtotal)).toBe(108000);
    expect(Number(quote.listedSubtotal)).toBe(108000);
    expect(Number(quote.discountAmount)).toBe(54000);
    // 108 000 договорных + 54 000 прайсовых после скидки
    expect(Number(quote.totalAfterDiscount)).toBe(162000);
  });

  it("без договорных цен расчёт не изменился — процент на всю смету", async () => {
    const quote = await quoteEstimate({
      startDate: START, endDate: END, clientId,
      discountPercent: 50,
      items: [{ equipmentId: skyId, quantity: 2 }],
    });
    expect(Number(quote.subtotal)).toBe(RATE * SHIFTS * 2);
    expect(Number(quote.discountAmount)).toBe((RATE * SHIFTS * 2) / 2);
    expect(quote.lines[0].isNegotiated).toBe(false);
    expect(quote.lines[0].listUnitPrice).toBeNull();
  });

  it("договорная сумма машины заменяет расчёт по прайсу", async () => {
    const vehicle = await prisma.vehicle.create({
      data: {
        slug: "gazelle-tent", name: "Газель (тент)", licensePlate: "А001АА777",
        shiftPriceRub: 18000, shiftHours: 12, overtimePercent: 0,
      },
    });
    const quote = await quoteEstimate({
      startDate: START, endDate: END, clientId,
      discountPercent: 0,
      items: [{ equipmentId: skyId, quantity: 1 }],
      transport: [{
        vehicleId: vehicle.id, withGenerator: false, shiftHours: 12,
        skipOvertime: false, kmOutsideMkad: 0, ttkEntry: false,
        negotiatedTotalRub: 12000,
      }],
    });
    expect(Number(quote.transport[0].total)).toBe(12000);
    expect(Number(quote.transport[0].listTotal)).toBe(18000);
    expect(quote.transport[0].isNegotiated).toBe(true);
    expect(Number(quote.transportSubtotal)).toBe(12000);
  });
});

describe("договорная цена переживает пересборку сметы", () => {
  let bookingId: string;

  it("сохраняется на позиции при создании черновика и попадает в снапшот", async () => {
    const booking = await createBookingDraft({
      clientId,
      projectName: "Смена с уступкой",
      startDate: START, endDate: END,
      discountPercent: 50,
      items: [
        { equipmentId: skyId, quantity: 2, negotiatedRatePerShift: 18000 },
        { equipmentId: apuId, quantity: 3 },
      ],
    });
    bookingId = booking.id;

    const item = await prisma.bookingItem.findFirst({ where: { bookingId, equipmentId: skyId } });
    expect(Number(item.negotiatedRatePerShift)).toBe(18000);

    const est = await prisma.estimate.findFirst({
      where: { bookingId, kind: "MAIN" }, include: { lines: true },
    });
    const negotiatedLine = est.lines.find((l: any) => l.equipmentId === skyId);
    expect(Number(negotiatedLine.unitPrice)).toBe(18000 * SHIFTS);
    expect(Number(negotiatedLine.listUnitPrice)).toBe(RATE * SHIFTS);
    expect(Number(est.totalAfterDiscount)).toBe(162000);
  });

  it("PATCH-пересборка сметы не теряет договорную цену", async () => {
    await rebuildBookingEstimate(bookingId);
    const est = await prisma.estimate.findFirst({
      where: { bookingId, kind: "MAIN" }, include: { lines: true },
    });
    const line = est.lines.find((l: any) => l.equipmentId === skyId);
    expect(Number(line.unitPrice)).toBe(18000 * SHIFTS);
    expect(Number(line.listUnitPrice)).toBe(RATE * SHIFTS);
    expect(Number(est.totalAfterDiscount)).toBe(162000);
  });

  it("пересборка после приёмки на складе тоже не теряет договорную цену", async () => {
    await recreateMainEstimate(bookingId);
    const est = await prisma.estimate.findFirst({
      where: { bookingId, kind: "MAIN" }, include: { lines: true },
    });
    const line = est.lines.find((l: any) => l.equipmentId === skyId);
    expect(Number(line.unitPrice)).toBe(18000 * SHIFTS);
    expect(Number(line.listUnitPrice)).toBe(RATE * SHIFTS);
    expect(Number(est.totalAfterDiscount)).toBe(162000);
  });
});

describe("чистые хелперы расчёта", () => {
  it("resolveCatalogLinePrice: без договорной цены отдаёт прайс и не помечает строку", () => {
    const r = resolveCatalogLinePrice({ ratePerShift: 25000, shifts: 3 });
    expect(Number(r.unitPrice)).toBe(75000);
    expect(r.listUnitPrice).toBeNull();
    expect(r.isNegotiated).toBe(false);
  });

  it("resolveCatalogLinePrice: период меньше смены считается за одну смену", () => {
    const r = resolveCatalogLinePrice({ ratePerShift: 25000, shifts: 0, negotiatedRatePerShift: 18000 });
    expect(Number(r.unitPrice)).toBe(18000);
    expect(Number(r.listUnitPrice)).toBe(25000);
  });

  it("splitEquipmentDiscount: скидка считается только от прайсовой части", () => {
    const split = splitEquipmentDiscount(
      [
        { lineSum: new Decimal(108000), isNegotiated: true },
        { lineSum: new Decimal(108000), isNegotiated: false },
      ],
      new Decimal(50),
    );
    expect(Number(split.subtotal)).toBe(216000);
    expect(Number(split.listedSubtotal)).toBe(108000);
    expect(Number(split.negotiatedSubtotal)).toBe(108000);
    expect(Number(split.discountAmount)).toBe(54000);
    expect(Number(split.totalAfterDiscount)).toBe(162000);
  });
});
