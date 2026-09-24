/**
 * Состав брони и строки сметы в ответах API и документах — в порядке каталога:
 * категории как на /equipment/manage (AppSetting equipment_category_order),
 * внутри категории — sortOrder позиции, произвольные позиции — последними.
 * Позиции добавляются вперемешку: без сортировки при чтении они шли бы в
 * порядке добавления.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import ExcelJS from "exceljs";

const TEST_DB_PATH = path.resolve(__dirname, `../../prisma/test-booking-line-order-${process.pid}.db`);
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-line-order";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-line-order";
process.env.JWT_SECRET = "test-jwt-secret-line-order-min16";
process.env.CLIENT_PORTAL_SESSION_SECRET = "test-session-secret-line-order-16";
process.env.CLIENT_PORTAL_TOKEN_SECRET = "test-token-secret-line-order-16ch";

let app: Express;
let prisma: any;
let superAdminToken: string;
let bookingId: string;
let clientId: string;

// «Свет» раньше «Грипа» — наоборот алфавиту, чтобы порядок явно шёл из настройки.
const CATEGORY_ORDER = ["Свет", "Грип"];
// sortOrder внутри «Света» тоже против алфавита: Arri (1) раньше Aputure (2).
const EXPECTED = ["Arri SkyPanel S60", "Aputure 600d", "C-стенд", "Флаг 4x4", "Доставка на площадку"];

// Даты — от «сейчас», а не зашитые: зашитая дата однажды уходит в прошлое.
const DAY_MS = 24 * 60 * 60 * 1000;
const START = new Date(Math.floor((Date.now() + 30 * DAY_MS) / DAY_MS) * DAY_MS + 10 * 60 * 60 * 1000);

function AUTH_SA() {
  return { "X-API-Key": "test-key-1", Authorization: `Bearer ${superAdminToken}` };
}

/** Имена позиций брони в порядке ответа. */
function itemNames(items: Array<{ equipment?: { name: string } | null; customName?: string | null }>) {
  return items.map((it) => it.equipment?.name ?? it.customName);
}

/** Строки с позициями на листе XLSX: № и название, в порядке строк листа. */
async function xlsxLines(buf: Buffer, sheetName: string) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  const sheet = wb.getWorksheet(sheetName)!;
  const names = new Set(EXPECTED);
  const rows: Array<{ index: unknown; name: string }> = [];
  sheet.eachRow((row) => {
    const name = row.getCell(2).value;
    if (typeof name === "string" && names.has(name)) rows.push({ index: row.getCell(1).value, name });
  });
  return rows;
}

function binaryParser(res: any, cb: (err: Error | null, body: Buffer) => void) {
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

  const mod = await import("../app");
  app = mod.app;
  const pmod = await import("../prisma");
  prisma = pmod.prisma;

  const { hashPassword, signSession } = await import("../services/auth");
  const hash = await hashPassword("pass");
  const sa = await prisma.adminUser.create({
    data: { username: "line_order_sa", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  superAdminToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });

  await prisma.appSetting.create({
    data: { key: "equipment_category_order", value: JSON.stringify(CATEGORY_ORDER) },
  });

  const mk = (name: string, category: string, sortOrder: number) =>
    prisma.equipment.create({
      data: {
        importKey: `${category}||${name}||line-order||`,
        name,
        category,
        sortOrder,
        totalQuantity: 10,
        rentalRatePerShift: 1000,
      },
    });
  const aputure = await mk("Aputure 600d", "Свет", 2);
  const arri = await mk("Arri SkyPanel S60", "Свет", 1);
  const cstand = await mk("C-стенд", "Грип", 1);
  const flag = await mk("Флаг 4x4", "Грип", 2);

  // Порядок добавления — вперемешку, произвольная позиция посередине.
  const res = await request(app)
    .post("/api/bookings/draft")
    .set(AUTH_SA())
    .send({
      client: { name: "Студия порядка" },
      projectName: "Порядок строк",
      startDate: START.toISOString(),
      endDate: new Date(START.getTime() + DAY_MS).toISOString(),
      items: [
        { equipmentId: flag.id, quantity: 1 },
        { equipmentId: aputure.id, quantity: 1 },
        { customName: "Доставка на площадку", customUnitPrice: 5000, quantity: 1 },
        { equipmentId: cstand.id, quantity: 2 },
        { equipmentId: arri.id, quantity: 1 },
      ],
    });
  expect(res.status).toBe(200);
  bookingId = res.body.booking.id;
  clientId = res.body.booking.clientId;
});

afterAll(async () => {
  await prisma.$disconnect();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const f = TEST_DB_PATH + suffix;
    if (fs.existsSync(f)) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }
});

describe("порядок строк брони по каталогу", () => {
  it("GET /api/bookings/:id: позиции и строки сметы — по категориям каталога, произвольная — последней", async () => {
    const res = await request(app).get(`/api/bookings/${bookingId}`).set(AUTH_SA());
    expect(res.status).toBe(200);
    const { booking } = res.body;
    expect(itemNames(booking.items)).toEqual(EXPECTED);
    expect(booking.estimate.lines.map((l: any) => l.nameSnapshot)).toEqual(EXPECTED);
    expect(booking.estimate.lines.map((l: any) => l.categorySnapshot)).toEqual([
      "Свет",
      "Свет",
      "Грип",
      "Грип",
      "Произвольная позиция",
    ]);
  });

  it("в базе порядок добавления сохраняется — сортируется только чтение", async () => {
    const items = await prisma.bookingItem.findMany({
      where: { bookingId },
      include: { equipment: true },
    });
    expect(itemNames(items)).not.toEqual(EXPECTED);
  });

  it("экспорт основной сметы XLSX: строки по каталогу, № в порядке печати", async () => {
    const estimate = await prisma.estimate.findFirst({ where: { bookingId, kind: "MAIN" } });
    const res = await request(app)
      .get(`/api/estimates/${estimate.id}/export/xlsx`)
      .set(AUTH_SA())
      .buffer(true)
      .parse(binaryParser);
    expect(res.status).toBe(200);
    const rows = await xlsxLines(res.body, "Смета");
    expect(rows.map((r) => r.name)).toEqual(EXPECTED);
    expect(rows.map((r) => r.index)).toEqual([1, 2, 3, 4, 5]);
  });

  it("полная смета XLSX: тот же порядок", async () => {
    const res = await request(app)
      .get(`/api/bookings/${bookingId}/full-estimate/export/xlsx`)
      .set(AUTH_SA())
      .buffer(true)
      .parse(binaryParser);
    expect(res.status).toBe(200);
    const rows = await xlsxLines(res.body, "Смета");
    expect(rows.map((r) => r.name)).toEqual(EXPECTED);
    expect(rows.map((r) => r.index)).toEqual([1, 2, 3, 4, 5]);
  });

  it("строки счёта и акта: по каталогу, номер после сортировки", async () => {
    const { bookingDocumentLines } = await import("../services/documentExport/bookingPdf");
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { estimates: { include: { lines: true } }, items: { include: { equipment: true } } },
    });
    const lines = await bookingDocumentLines(booking);
    expect(lines.map((l) => l.name)).toEqual(EXPECTED);
    expect(lines.map((l) => l.index)).toEqual([1, 2, 3, 4, 5]);

    // Легаси-бронь без MAIN-снапшота — из позиций брони, в том же порядке.
    const legacy = await bookingDocumentLines({ ...booking, estimates: [] });
    expect(legacy.map((l) => l.name)).toEqual(EXPECTED);
  });

  it("POST /:id/submit-for-approval отдаёт бронь в том же порядке", async () => {
    const res = await request(app)
      .post(`/api/bookings/${bookingId}/submit-for-approval`)
      .set(AUTH_SA())
      .send({});
    expect(res.status).toBe(200);
    expect(itemNames(res.body.booking.items)).toEqual(EXPECTED);
    expect(res.body.booking.estimate.lines.map((l: any) => l.nameSnapshot)).toEqual(EXPECTED);
  });

  it("ЛК GET /api/lk/bookings/:id: строки сметы по каталогу", async () => {
    await prisma.booking.update({ where: { id: bookingId }, data: { status: "CONFIRMED" } });
    const acc = await prisma.clientPortalAccount.create({
      data: { clientId, email: `line-order-${process.pid}@example.ru`, status: "ACTIVE" },
    });
    const { issueMagicLink } = await import("../services/clientPortal/magicLink");
    const { rawToken } = await issueMagicLink(prisma, acc.id, "LOGIN");
    const verify = await request(app).post("/api/lk/auth/verify").send({ token: rawToken });
    expect(verify.status).toBe(200);

    const res = await request(app)
      .get(`/api/lk/bookings/${bookingId}`)
      .set("Cookie", verify.headers["set-cookie"]);
    expect(res.status).toBe(200);
    expect(res.body.items.map((l: any) => l.nameSnapshot)).toEqual(EXPECTED);
    // equipmentId нужен только для сортировки — клиенту не уходит.
    expect(res.body.items[0]).not.toHaveProperty("equipmentId");
  });

  // Идёт после ЛК-теста: там бронь переведена в CONFIRMED — добор возможен.
  it("добор и вливание: ответ и доп-смета по каталогу, дописанное в конец встаёт в свою категорию", async () => {
    const mk = (name: string, category: string, sortOrder: number) =>
      prisma.equipment.create({
        data: {
          importKey: `${category}||${name}||line-order-addon||`,
          name,
          category,
          sortOrder,
          totalQuantity: 10,
          rentalRatePerShift: 1000,
        },
      });
    const boom = await mk("Бум-стойка", "Грип", 3);
    const astera = await mk("Astera Titan", "Свет", 3);

    // Грип раньше Света — порядок добавления против каталога.
    const add = await request(app)
      .post(`/api/bookings/${bookingId}/addon-items`)
      .set(AUTH_SA())
      .send({
        items: [
          { equipmentId: boom.id, quantity: 1 },
          { equipmentId: astera.id, quantity: 1 },
        ],
        mode: "ADDON",
      });
    expect(add.status).toBe(201);
    const withAddon = [
      "Arri SkyPanel S60",
      "Aputure 600d",
      "Astera Titan",
      "C-стенд",
      "Флаг 4x4",
      "Бум-стойка",
      "Доставка на площадку",
    ];
    expect(itemNames(add.body.booking.items)).toEqual(withAddon);
    expect(add.body.booking.estimate.lines.map((l: any) => l.nameSnapshot)).toEqual(EXPECTED);
    expect(add.body.booking.addonEstimate.lines.map((l: any) => l.nameSnapshot)).toEqual([
      "Astera Titan",
      "Бум-стойка",
    ]);

    // Read-model доб-сметы (киоск) — тот же порядок.
    const addonRes = await request(app).get(`/api/addon-estimates/${bookingId}`).set(AUTH_SA());
    expect(addonRes.status).toBe(200);
    expect(addonRes.body.addon.lines.map((l: any) => l.nameSnapshot)).toEqual(["Astera Titan", "Бум-стойка"]);

    // Вливание дописывает строки добора в конец MAIN — ответ всё равно по каталогу.
    const merge = await request(app)
      .post(`/api/bookings/${bookingId}/addon-estimate/merge`)
      .set(AUTH_SA())
      .send({});
    expect(merge.status).toBe(200);
    expect(merge.body.booking.addonEstimate).toBeNull();
    expect(merge.body.booking.estimate.lines.map((l: any) => l.nameSnapshot)).toEqual(withAddon);
  });
});
