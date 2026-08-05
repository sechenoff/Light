import path from "path";
import { execSync } from "child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import ExcelJS from "exceljs";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-full-estimate-routes.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-full-estimate";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-full-estimate";
process.env.WAREHOUSE_SECRET = "test-warehouse-full-estimate-16";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-full-estimate-min16chars";

let app: any;
let prisma: any;
let superAdminToken: string;
let bookingWithAddonId: string;
let bookingWithoutAddonId: string;

function AUTH() {
  return { Authorization: `Bearer ${superAdminToken}` };
}

/** Собирает бинарное тело ответа в Buffer (supertest по умолчанию отдаёт строку). */
function binaryParser(res: NodeJS.ReadableStream, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
}

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

  const pmod = await import("../prisma");
  prisma = pmod.prisma;
  const { app: expressApp } = await import("../app");
  app = expressApp;

  const { hashPassword, signSession } = await import("../services/auth");

  // Seed SUPER_ADMIN + JWT (same pattern as addonEstimateRoutes.test.ts)
  const pwd = await hashPassword("test-password");
  const admin = await prisma.adminUser.create({
    data: { username: "full-estimate-test", passwordHash: pwd, role: "SUPER_ADMIN" },
  });
  superAdminToken = signSession({ userId: admin.id, username: admin.username, role: "SUPER_ADMIN" });

  const client = await prisma.client.create({
    data: { name: "Full estimate test", phone: "+70000000666" },
  });

  // Реквизиты организации — попадают в шапку PDF/XLSX.
  await prisma.organizationSettings.upsert({
    where: { id: "singleton" },
    update: { legalName: "ООО «Тест Рент»", phone: "+7 (900) 000-00-00", inn: "7700000001" },
    create: {
      id: "singleton",
      legalName: "ООО «Тест Рент»",
      phone: "+7 (900) 000-00-00",
      inn: "7700000001",
    },
  });

  // Booking with both MAIN and ADDON estimates
  const b1 = await prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: "Has addon",
      startDate: new Date(),
      endDate: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
      status: "ISSUED",
    },
  });
  bookingWithAddonId = b1.id;
  await prisma.estimate.create({
    data: {
      bookingId: b1.id,
      kind: "MAIN",
      shifts: 2,
      subtotal: "10000",
      discountPercent: "50",
      discountAmount: "5000",
      totalAfterDiscount: "5000",
      lines: {
        create: [
          {
            equipmentId: null,
            categorySnapshot: "Свет",
            nameSnapshot: "Aputure 600D",
            quantity: 2,
            unitPrice: "1000",
            lineSum: "4000",
          },
        ],
      },
    },
  });
  await prisma.estimate.create({
    data: {
      bookingId: b1.id,
      kind: "ADDON",
      shifts: 2,
      subtotal: "2000",
      discountPercent: "50",
      discountAmount: "1000",
      totalAfterDiscount: "1000",
      lines: {
        create: [
          {
            equipmentId: null,
            categorySnapshot: "Электрика",
            nameSnapshot: "Vmount",
            quantity: 1,
            unitPrice: "1000",
            lineSum: "2000",
          },
        ],
      },
    },
  });

  // Транспорт на b1: должен попасть в полную смету и в общий итог.
  const vehicle = await prisma.vehicle.create({
    data: { name: "Ивеко Тест", slug: "iveco-test", shiftPriceRub: "10000" },
  });
  await prisma.bookingVehicle.create({
    data: {
      bookingId: b1.id,
      vehicleId: vehicle.id,
      withGenerator: true,
      subtotalRub: "15000",
    },
  });
  await prisma.booking.update({
    where: { id: b1.id },
    data: { transportSubtotalRub: "15000" },
  });

  // Booking without ADDON
  const b2 = await prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: "No addon",
      startDate: new Date(),
      endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
      status: "ISSUED",
    },
  });
  bookingWithoutAddonId = b2.id;
  await prisma.estimate.create({
    data: {
      bookingId: b2.id,
      kind: "MAIN",
      shifts: 1,
      subtotal: "5000",
      discountPercent: null,
      discountAmount: "0",
      totalAfterDiscount: "5000",
      lines: {
        create: [
          {
            equipmentId: null,
            categorySnapshot: "Свет",
            nameSnapshot: "Aputure 600D",
            quantity: 1,
            unitPrice: "5000",
            lineSum: "5000",
          },
        ],
      },
    },
  });

  // Booking without MAIN (DRAFT)
  const b3 = await prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: "Draft no MAIN",
      startDate: new Date(),
      endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
      status: "DRAFT",
    },
  });
  // (no Estimate created — testing the 404 path)
  void b3;
});

afterAll(async () => {
  await prisma?.$disconnect?.();
});

describe("GET /api/bookings/:id/full-estimate/export/pdf", () => {
  it("returns A4 PDF for booking WITH addon and transport", async () => {
    const res = await request(app)
      .get(`/api/bookings/${bookingWithAddonId}/full-estimate/export/pdf`)
      .set(AUTH())
      .buffer(true)
      .parse(binaryParser);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    const body = res.body as Buffer;
    expect(body.subarray(0, 5).toString()).toBe("%PDF-");
    // A4 MediaBox: pdfkit пишет размеры страницы в объект Pages без сжатия.
    expect(body.toString("latin1")).toContain("595.28 841.89");
  });

  it("returns PDF for booking WITHOUT addon (main only)", async () => {
    const res = await request(app)
      .get(`/api/bookings/${bookingWithoutAddonId}/full-estimate/export/pdf`)
      .set(AUTH());
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
  });
});

describe("GET /api/bookings/:id/full-estimate/export/xlsx", () => {
  it("returns XLSX with A4 print setup, transport and grand total", async () => {
    const res = await request(app)
      .get(`/api/bookings/${bookingWithAddonId}/full-estimate/export/xlsx`)
      .set(AUTH())
      .buffer(true)
      .parse(binaryParser);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("spreadsheetml");

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as Buffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Смета", "Доб-смета"]);

    for (const ws of wb.worksheets) {
      // Печать A4: портрет, вписывание по ширине, повтор шапки таблицы.
      expect(ws.pageSetup.paperSize).toBe(9);
      expect(ws.pageSetup.orientation).toBe("portrait");
      expect(ws.pageSetup.fitToWidth).toBe(1);
      expect((ws.pageSetup as { printTitlesRow?: string }).printTitlesRow).toBeTruthy();
      expect(ws.headerFooter?.oddFooter).toContain("Стр. &P из &N");
    }

    // Транспорт + общий итог — на последнем листе.
    const last = wb.worksheets[wb.worksheets.length - 1];
    const cellTexts: string[] = [];
    const numbers: number[] = [];
    last.eachRow((r) =>
      r.eachCell((c) => {
        if (typeof c.value === "string") cellTexts.push(c.value);
        if (typeof c.value === "number") numbers.push(c.value);
      }),
    );
    expect(cellTexts.some((t) => t.includes("ТРАНСПОРТ"))).toBe(true);
    expect(cellTexts.some((t) => t.includes("Ивеко Тест"))).toBe(true);
    expect(cellTexts.some((t) => t.includes("ИТОГО К ОПЛАТЕ"))).toBe(true);
    // grand = main 5000 + addon 1000 + транспорт 15000
    expect(numbers).toContain(21000);
  });

  it("returns XLSX for booking WITHOUT addon (main only)", async () => {
    const res = await request(app)
      .get(`/api/bookings/${bookingWithoutAddonId}/full-estimate/export/xlsx`)
      .set(AUTH())
      .buffer(true)
      .parse(binaryParser);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("spreadsheetml");

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as Buffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Смета"]);
    expect(wb.worksheets[0].pageSetup.paperSize).toBe(9);
  });
});
