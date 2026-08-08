/**
 * Единица цены в снапшоте сметы и учёт ручного итога в счёте.
 *
 * Два инварианта, которые до этого расходились между собой:
 *
 * 1. EstimateLine.unitPrice — цена ЗА ВЕСЬ ПЕРИОД (ставка × смены). Так пишет
 *    quoteEstimate, и на этом построен экспорт: buildSmetaExportDocument делит
 *    unitPrice на число смен, чтобы напечатать колонку «цена/смена».
 *    recreateMainEstimate (вызывается при завершении приёмки на складе) писал
 *    туда ставку за смену — итог сходился, а колонка в PDF многосменной брони
 *    уменьшалась во столько раз, сколько смен в периоде.
 *
 * 2. Счёт выписывается на ту же сумму, которую видит витрина долгов. При
 *    зафиксированном вручную итоге счёт считался по смете и расходился с
 *    долгом ровно на величину уступки.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-estimate-price-unit.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-estimate-unit-16ch";
process.env.BARCODE_SECRET = "test-secret-eu";

let prisma: any;
let recreateMainEstimate: (bookingId: string) => Promise<void>;
let buildSmetaExportDocument: any;

const RATE = 4000;
const SHIFTS = 3;
const QTY = 2;

let bookingId: string;
let equipmentId: string;
let adminId: string;

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
  recreateMainEstimate = (await import("../services/mainEstimate")).recreateMainEstimate;
  buildSmetaExportDocument = (await import("../services/smetaExport/buildDocument"))
    .buildSmetaExportDocument;

  // Аудит-запись счёта ссылается на AdminUser по внешнему ключу — без живого
  // пользователя createInvoice падает на записи в журнал, а не на сумме.
  const admin = await prisma.adminUser.create({
    data: { username: "system-test", passwordHash: "x", role: "SUPER_ADMIN" },
  });
  adminId = admin.id;

  const client = await prisma.client.create({ data: { name: "Тестовый гаффер" } });
  const equipment = await prisma.equipment.create({
    data: {
      importKey: "estimate-price-unit-eq",
      name: "ARRI SkyPanel S60",
      category: "Свет",
      totalQuantity: 5,
      rentalRatePerShift: RATE,
      stockTrackingMode: "COUNT",
    },
  });
  equipmentId = equipment.id;

  const booking = await prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: "Смена на три дня",
      startDate: new Date("2026-08-10T09:00:00.000Z"),
      endDate: new Date("2026-08-12T21:00:00.000Z"),
      status: "CONFIRMED",
      totalEstimateAmount: 0,
      discountAmount: 0,
      finalAmount: 0,
      // Счета доступны только не-легаси броням; новые всегда такие.
      legacyFinance: false,
    },
  });
  bookingId = booking.id;

  await prisma.bookingItem.create({
    data: { bookingId, equipmentId, quantity: QTY },
  });
  await prisma.estimate.create({
    data: {
      bookingId,
      kind: "MAIN",
      shifts: SHIFTS,
      discountPercent: 0,
      subtotal: 0,
      discountAmount: 0,
      totalAfterDiscount: 0,
    },
  });
});

afterAll(async () => {
  await prisma?.$disconnect();
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    const f = `${TEST_DB_PATH}${suffix}`;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

describe("единица цены в снапшоте сметы", () => {
  it("recreateMainEstimate пишет unitPrice за весь период, как quoteEstimate", async () => {
    await recreateMainEstimate(bookingId);

    const estimate = await prisma.estimate.findFirst({
      where: { bookingId, kind: "MAIN" },
      include: { lines: true },
    });
    expect(estimate.lines).toHaveLength(1);
    const line = estimate.lines[0];

    // Цена за период: ставка × смены. Не ставка за смену.
    expect(Number(line.unitPrice)).toBe(RATE * SHIFTS);
    // Сумма строки при этом не меняется — она и раньше была верной.
    expect(Number(line.lineSum)).toBe(RATE * SHIFTS * QTY);
  });

  it("экспорт печатает в колонке «цена/смена» именно прайсовую ставку", async () => {
    await recreateMainEstimate(bookingId);
    const estimate = await prisma.estimate.findFirst({
      where: { bookingId, kind: "MAIN" },
      include: { lines: true },
    });

    const doc = buildSmetaExportDocument({
      title: "Смета",
      documentNo: "1",
      issuedAt: new Date("2026-08-08T00:00:00.000Z"),
      startDate: new Date("2026-08-10T09:00:00.000Z"),
      endDate: new Date("2026-08-12T21:00:00.000Z"),
      clientName: "Тестовый гаффер",
      projectName: "Смена на три дня",
      comment: null,
      optionalNote: null,
      includeOptionalInExport: false,
      hourCalculationText: "",
      shifts: SHIFTS,
      discountPercent: "0",
      subtotal: String(RATE * SHIFTS * QTY),
      discountAmount: "0",
      totalAfterDiscount: String(RATE * SHIFTS * QTY),
      lines: estimate.lines,
    });

    expect(Number(doc.lines[0].pricePerShift)).toBe(RATE);
    expect(Number(doc.lines[0].lineSum)).toBe(RATE * SHIFTS * QTY);
  });
});

describe("счёт и ручной итог", () => {
  it("сумма счёта берётся из зафиксированного вручную итога, а не из сметы", async () => {
    const { createInvoice } = await import("../services/invoiceService");

    await prisma.booking.update({
      where: { id: bookingId },
      data: { manualFinalAmount: 100000, finalAmount: 100000 },
    });

    const invoice = await createInvoice({ bookingId, kind: "FULL" } as any, adminId);

    // Смета даёт 24 000, договорились на 100 000 — счёт обязан пойти на 100 000,
    // иначе документ разойдётся с витриной долгов.
    expect(Number(invoice.total)).toBe(100000);
  });
});
