/**
 * Отчёт по задолженности для взыскания: сборка документа, роль COLLECTOR
 * и выгрузка PDF/XLSX по отмеченным броням.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-debt-report.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-debtreport";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-debtreport";
process.env.WAREHOUSE_SECRET = "test-warehouse-debtreport";
process.env.JWT_SECRET = "test-jwt-debtreport-min16chars";

let app: Express;
let prisma: any;
let saToken: string;
let collectorToken: string;
let whToken: string;
let techToken: string;

/** id броней по метке — заполняется в beforeAll. */
const B: Record<string, string> = {};

const DAY = 86_400_000;

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

  const mk = async (username: string, role: string) => {
    const u = await prisma.adminUser.create({ data: { username, passwordHash: hash, role } });
    return signSession({ userId: u.id, username: u.username, role: role as any });
  };
  saToken = await mk("dr_sa", "SUPER_ADMIN");
  collectorToken = await mk("dr_collector", "COLLECTOR");
  whToken = await mk("dr_wh", "WAREHOUSE");
  techToken = await mk("dr_tech", "TECHNICIAN");

  await prisma.organizationSettings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", legalName: "ИП Светов", inn: "771234567890", phone: "+7 916 000-00-00" },
    update: { legalName: "ИП Светов" },
  });

  const alpha = await prisma.client.create({
    data: { name: "Альфа Продакшн", legalName: "ООО «Альфа Продакшн»", phone: "+7 495 111-22-33", email: "buh@alpha.ru" },
  });
  const beta = await prisma.client.create({ data: { name: "Бета Филмз", phone: "+7 916 444-55-66" } });

  const now = Date.now();
  /**
   * Платежи заводятся настоящими записями, а не только полями на брони:
   * маршруты отчёта вызывают `paymentStatusSyncForAllBookings`, и он
   * пересчитает `amountPaid` из реальных Payment — выдуманные суммы на
   * брони он бы просто обнулил.
   */
  const mkBooking = async (key: string, data: Record<string, unknown> & { paid?: string }) => {
    const { paid, ...bookingData } = data;
    const b = await prisma.booking.create({
      data: {
        projectName: key,
        startDate: new Date(now - 40 * DAY),
        endDate: new Date(now - 38 * DAY),
        status: "RETURNED",
        ...bookingData,
      },
    });
    if (paid && Number(paid) > 0) {
      await prisma.payment.create({
        data: {
          bookingId: b.id,
          amount: paid,
          direction: "INCOME",
          status: "RECEIVED",
          receivedAt: new Date(now - 20 * DAY),
          paymentDate: new Date(now - 20 * DAY),
        },
      });
    }
    B[key] = b.id;
    return b;
  };

  // Альфа: просрочено давно (90 дней) + просрочено недавно (10 дней)
  await mkBooking("alpha-old", {
    clientId: alpha.id,
    docNumber: "СМ-2026-0001",
    finalAmount: "300000",
    paid: "100000",
    amountPaid: "100000",
    amountOutstanding: "200000",
    paymentStatus: "PARTIALLY_PAID",
    expectedPaymentDate: new Date(now - 90 * DAY),
  });
  await mkBooking("alpha-fresh", {
    clientId: alpha.id,
    finalAmount: "50000",
    amountPaid: "0",
    amountOutstanding: "50000",
    paymentStatus: "NOT_PAID",
    expectedPaymentDate: new Date(now - 10 * DAY),
  });
  // Бета: срок ещё не наступил — долг есть, просрочки нет
  await mkBooking("beta-future", {
    clientId: beta.id,
    finalAmount: "80000",
    amountPaid: "0",
    amountOutstanding: "80000",
    paymentStatus: "NOT_PAID",
    expectedPaymentDate: new Date(now + 10 * DAY),
  });
  // Полностью оплачена — в отчёт попасть не должна даже если её отметили
  await mkBooking("beta-paid", {
    clientId: beta.id,
    finalAmount: "10000",
    paid: "10000",
    amountPaid: "10000",
    amountOutstanding: "0",
    paymentStatus: "PAID",
  });
  // В архиве, но долг живой: «погашено» тут было бы враньём
  await mkBooking("archived", {
    clientId: beta.id,
    deletedAt: new Date(now - 2 * DAY),
    finalAmount: "33000",
    amountOutstanding: "33000",
    paymentStatus: "NOT_PAID",
  });
  // Отменённая бронь — тоже не взыскивается
  await mkBooking("cancelled", {
    clientId: beta.id,
    status: "CANCELLED",
    finalAmount: "5000",
    amountOutstanding: "5000",
    paymentStatus: "NOT_PAID",
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

const hdr = (token: string) => ({ "X-API-Key": "test-key-debtreport", Authorization: `Bearer ${token}` });
const SA = () => hdr(saToken);
const COLLECTOR = () => hdr(collectorToken);
const WH = () => hdr(whToken);
const TECH = () => hdr(techToken);

const pdfParser = (res: any, cb: (e: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
};

describe("buildDebtReport", () => {
  it("группирует по клиентам, считает итоги и ставит острый долг первым", async () => {
    const { buildDebtReport } = await import("../services/debtReport/buildDebtReport");
    const report = await buildDebtReport({
      bookingIds: [B["beta-future"], B["alpha-fresh"], B["alpha-old"]],
    });

    // Альфа впереди: у неё просрочено 250 000, у Беты — ничего.
    expect(report.clients.map((c) => c.clientName)).toEqual(["Альфа Продакшн", "Бета Филмз"]);
    // Юр. имя доезжает до документа — в бланке печатается оно.
    expect(report.clients[0].legalName).toBe("ООО «Альфа Продакшн»");
    // Внутри клиента — сначала самый старый долг.
    expect(report.clients[0].rows.map((r) => r.projectName)).toEqual(["alpha-old", "alpha-fresh"]);
    expect(report.clients[0].rows[0].daysOverdue).toBeGreaterThanOrEqual(89);
    expect(report.clients[0].total.toString()).toBe("250000");

    // У Беты срок не наступил — долг есть, просрочки нет.
    expect(report.clients[1].overdue.toString()).toBe("0");
    expect(report.clients[1].rows[0].daysOverdue).toBeNull();

    expect(report.totals).toMatchObject({ clientsCount: 2, bookingsCount: 3 });
    expect(report.totals.total.toString()).toBe("330000");
    expect(report.totals.overdue.toString()).toBe("250000");
    // Старше 60 дней — только alpha-old.
    expect(report.totals.overAgedCount).toBe(1);
    expect(report.totals.overAged.toString()).toBe("200000");
    expect(report.title).toBe("Реестр задолженности");
  });

  it("отсеивает непригодное и НАЗЫВАЕТ причину для каждой брони", async () => {
    const { buildDebtReport } = await import("../services/debtReport/buildDebtReport");
    const report = await buildDebtReport({
      bookingIds: [B["alpha-old"], B["beta-paid"], B["cancelled"], B["archived"], "booking-which-does-not-exist"],
    });
    expect(report.totals.bookingsCount).toBe(1);
    const reasons = Object.fromEntries(report.skipped.map((s) => [s.bookingId, s.reason]));
    expect(reasons).toEqual({
      [B["beta-paid"]]: "PAID",
      // Отменённая ≠ погашенная: долг по ней живой, и путать их нельзя.
      [B["cancelled"]]: "CANCELLED",
      // Архивная с живым долгом — тем более не «погашено».
      [B["archived"]]: "ARCHIVED",
      "booking-which-does-not-exist": "NOT_FOUND",
    });
  });

  it("describeSkipped объясняет пропуски человеческими словами", async () => {
    const { describeSkipped } = await import("../services/debtReport/buildDebtReport");
    expect(describeSkipped([])).toBeNull();
    expect(describeSkipped([{ bookingId: "a", reason: "PAID" }])).toBe(
      "1 долг не попал в отчёт: 1 — уже погашен",
    );
    expect(
      describeSkipped([
        { bookingId: "a", reason: "PAID" },
        { bookingId: "b", reason: "PAID" },
        { bookingId: "c", reason: "CANCELLED" },
      ]),
    ).toBe("3 долга не попали в отчёт: 2 — уже погашены, 1 — отменён");
  });

  it("пустой выбор и выбор из одних оплаченных — понятные ошибки, а не пустой документ", async () => {
    const { buildDebtReport } = await import("../services/debtReport/buildDebtReport");
    await expect(buildDebtReport({ bookingIds: [] })).rejects.toMatchObject({ code: "DEBT_REPORT_EMPTY" });
    await expect(buildDebtReport({ bookingIds: [B["beta-paid"]] })).rejects.toMatchObject({
      code: "DEBT_REPORT_NOTHING_TO_COLLECT",
    });
  });

  it("дубли в выборе не задваивают сумму", async () => {
    const { buildDebtReport } = await import("../services/debtReport/buildDebtReport");
    const report = await buildDebtReport({ bookingIds: [B["alpha-old"], B["alpha-old"]] });
    expect(report.totals.bookingsCount).toBe(1);
    expect(report.totals.total.toString()).toBe("200000");
  });

  it("заголовок и примечание доезжают до документа", async () => {
    const { buildDebtReport } = await import("../services/debtReport/buildDebtReport");
    const report = await buildDebtReport({
      bookingIds: [B["alpha-old"]],
      title: "  Долги на планёрку  ",
      note: " звонить до пятницы ",
      includeContacts: true,
    });
    expect(report.title).toBe("Долги на планёрку");
    expect(report.note).toBe("звонить до пятницы");
    expect(report.includeContacts).toBe(true);
    expect(report.org.name).toBe("ИП Светов");
  });
});

describe("POST /api/finance/debts/report.{pdf,xlsx}", () => {
  it("руководитель получает PDF с корректной шапкой имени файла", async () => {
    const res = await request(app)
      .post("/api/finance/debts/report.pdf")
      .set(SA())
      .send({ bookingIds: [B["alpha-old"], B["alpha-fresh"]] })
      .buffer(true)
      .parse(pdfParser);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    // inline — фронт печатает документ из iframe, а не скачивает.
    expect(res.headers["content-disposition"]).toContain("inline");
    expect(res.headers["content-disposition"]).toContain("filename*=UTF-8''");
    expect((res.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");
  });

  it("XLSX отдаётся вложением", async () => {
    const res = await request(app)
      .post("/api/finance/debts/report.xlsx")
      .set(SA())
      .send({ bookingIds: [B["alpha-old"], B["beta-future"]] })
      .buffer(true)
      .parse(pdfParser);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("spreadsheetml");
    expect(res.headers["content-disposition"]).toContain("attachment");
    // XLSX — это zip: сигнатура PK.
    expect((res.body as Buffer).subarray(0, 2).toString()).toBe("PK");
  });

  it("сотрудник взыскания формирует отчёт сам", async () => {
    const res = await request(app)
      .post("/api/finance/debts/report.pdf")
      .set(COLLECTOR())
      .send({ bookingIds: [B["alpha-old"]], title: "Обзвон", includeContacts: true })
      .buffer(true)
      .parse(pdfParser);
    expect(res.status).toBe(200);
    expect((res.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");
  });

  it("выбор только из погашенных → 409/400 с человеческим кодом, а не пустой файл", async () => {
    const res = await request(app)
      .post("/api/finance/debts/report.pdf")
      .set(SA())
      .send({ bookingIds: [B["beta-paid"]] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("DEBT_REPORT_NOTHING_TO_COLLECT");
  });

  it("про отсеянные брони сервер сообщает заголовком, а не молчит", async () => {
    const res = await request(app)
      .post("/api/finance/debts/report.pdf")
      .set(SA())
      .send({ bookingIds: [B["alpha-old"], B["beta-paid"], B["cancelled"]] })
      .buffer(true)
      .parse(pdfParser);
    expect(res.status).toBe(200);
    const notice = decodeURIComponent(res.headers["x-export-notice"] ?? "");
    expect(notice).toContain("2 долга не попали в отчёт");
    expect(notice).toContain("уже погашен");
    expect(notice).toContain("отменён");
  });

  it("без отсева заголовка нет — лишний тост пользователю не нужен", async () => {
    const res = await request(app)
      .post("/api/finance/debts/report.pdf")
      .set(SA())
      .send({ bookingIds: [B["alpha-old"]] })
      .buffer(true)
      .parse(pdfParser);
    expect(res.status).toBe(200);
    expect(res.headers["x-export-notice"]).toBeUndefined();
  });

  it("длинный отчёт разбивается на страницы и не падает", async () => {
    const { buildDebtReport } = await import("../services/debtReport/buildDebtReport");
    const { renderDebtReportPdf } = await import("../services/debtReport/renderDebtReportPdf");
    // 40 клиентов по 3 долга — заведомо больше одного листа A4.
    const many: string[] = [];
    for (let i = 0; i < 40; i++) {
      const c = await prisma.client.create({ data: { name: `Массовый клиент ${i}` } });
      for (let j = 0; j < 3; j++) {
        const b = await prisma.booking.create({
          data: {
            clientId: c.id,
            projectName: `Проект ${i}-${j} с очень длинным названием, которое не помещается в колонку ни при каком кегле`,
            startDate: new Date(Date.now() - 30 * DAY),
            endDate: new Date(Date.now() - 28 * DAY),
            status: "RETURNED",
            finalAmount: "10000",
            amountOutstanding: "10000",
            paymentStatus: "NOT_PAID",
            expectedPaymentDate: new Date(Date.now() - (j + 1) * 30 * DAY),
          },
        });
        many.push(b.id);
      }
    }
    const report = await buildDebtReport({ bookingIds: many });
    expect(report.totals.bookingsCount).toBe(120);
    const pdf = await renderDebtReportPdf(report);
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    // Несколько страниц: футер «Стр. N из M» рисуется по всему диапазону.
    expect(pdf.length).toBeGreaterThan(40_000);
  });

  it("валидация тела: пустой список и мусор → 400", async () => {
    expect((await request(app).post("/api/finance/debts/report.pdf").set(SA()).send({ bookingIds: [] })).status).toBe(400);
    expect((await request(app).post("/api/finance/debts/report.pdf").set(SA()).send({})).status).toBe(400);
    expect(
      (await request(app).post("/api/finance/debts/report.xlsx").set(SA()).send({ bookingIds: [B["alpha-old"]], title: "x".repeat(200) })).status,
    ).toBe(400);
  });
});

describe("Роль COLLECTOR — доступ ровно к реестру долгов", () => {
  it("читает реестр и выгружает его целиком", async () => {
    const list = await request(app).get("/api/finance/debts").set(COLLECTOR());
    expect(list.status).toBe(200);
    expect(list.body.debts.length).toBeGreaterThan(0);
    const xlsx = await request(app).get("/api/finance/debts.xlsx").set(COLLECTOR());
    expect(xlsx.status).toBe(200);
  });

  it("к остальным финансам не допущен", async () => {
    for (const p of [
      "/api/finance/dashboard",
      "/api/finance/forecast",
      "/api/payments",
      "/api/expenses",
      "/api/finance/debts/remindable",
    ]) {
      const res = await request(app).get(p).set(COLLECTOR());
      expect([401, 403], `${p} должен быть закрыт для взыскания`).toContain(res.status);
    }
  });

  it("не может менять данные: платежи и списание долга закрыты", async () => {
    const pay = await request(app)
      .post("/api/payments")
      .set(COLLECTOR())
      .send({ bookingId: B["alpha-old"], amount: 1000, method: "CASH", direction: "INCOME" });
    expect([401, 403]).toContain(pay.status);
    const writeOff = await request(app)
      .post(`/api/bookings/${B["alpha-old"]}/write-off`)
      .set(COLLECTOR())
      .send({ amount: 100 });
    expect([401, 403]).toContain(writeOff.status);
  });

  it("кладовщик и техник к реестру и отчёту не допущены", async () => {
    for (const headers of [WH, TECH]) {
      expect((await request(app).get("/api/finance/debts").set(headers())).status).toBe(403);
      expect(
        (await request(app).post("/api/finance/debts/report.pdf").set(headers()).send({ bookingIds: [B["alpha-old"]] })).status,
      ).toBe(403);
    }
  });
});
