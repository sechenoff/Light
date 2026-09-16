/**
 * Счета на оплату контрагентам (/api/bills): реестр, нумерация по годам,
 * снапшоты реквизитов, статусы, печатная форма, предзаполнение по брони.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import Decimal from "decimal.js";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-bills.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-bills";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-bills";
process.env.WAREHOUSE_SECRET = "test-warehouse-bills";
process.env.JWT_SECRET = "test-jwt-bills-min16chars";
process.env.APPROVAL_MODE = "manual";

let app: Express;
let prisma: any;
let saToken: string;
let whToken: string;
let equipmentId: string;

const YEAR = new Date().getFullYear();

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
  const sa = await prisma.adminUser.create({ data: { username: "bill_sa", passwordHash: hash, role: "SUPER_ADMIN" } });
  saToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });
  const wh = await prisma.adminUser.create({ data: { username: "bill_wh", passwordHash: hash, role: "WAREHOUSE" } });
  whToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });

  await prisma.organizationSettings.upsert({
    where: { id: "singleton" },
    create: {
      id: "singleton",
      legalName: "ИП Светов Иван Петрович",
      inn: "771234567890",
      bankName: "АО «ТБанк»",
      bankBik: "044525974",
      rschet: "40802810400001234567",
      kschet: "30101810145250000974",
      cashlessSurchargePercent: "9",
      taxNote: "Без налога (УСН)",
      signerName: "Светов И. П.",
    },
    update: {
      legalName: "ИП Светов Иван Петрович",
      bankName: "АО «ТБанк»",
      bankBik: "044525974",
      rschet: "40802810400001234567",
      kschet: "30101810145250000974",
      taxNote: "Без налога (УСН)",
    },
  });

  const eq = await prisma.equipment.create({
    data: {
      importKey: "СВЕТ||СЧЕТА||GENERIC||BILL-1",
      name: "Прожектор для счёта",
      category: "Свет",
      totalQuantity: 10,
      rentalRatePerShift: "5000",
      stockTrackingMode: "COUNT",
    },
  });
  equipmentId = eq.id;
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

const SA = () => ({ "X-API-Key": "test-key-bills", Authorization: `Bearer ${saToken}` });
const WH = () => ({ "X-API-Key": "test-key-bills", Authorization: `Bearer ${whToken}` });

const legal = {
  legalName: "ООО «Эпикпро»",
  inn: "7701234567",
  kpp: "770101001",
  legalAddress: "г. Москва, ул. Киношная, д. 1",
  bankName: "ПАО Сбербанк",
  bankBik: "044525225",
  rschet: "40702810100000000001",
  kschet: "30101810400000000225",
};

describe("POST /api/bills", () => {
  it("выставляет счёт новому контрагенту: клиент создаётся с реквизитами, номер 1 за год", async () => {
    const res = await request(app)
      .post("/api/bills")
      .set(SA())
      .send({
        client: { name: "Эпикпро", ...legal, email: "buh@epicpro.ru" },
        basis: "Договор № 12 от 01.09.2026",
        lines: [
          { name: "Аренда светового оборудования 10–12.09.2026", unit: "усл.", quantity: 1, price: "52102" },
        ],
        dueDate: "2026-09-30",
      });
    expect(res.status).toBe(201);
    expect(res.body.year).toBe(YEAR);
    expect(res.body.number).toBe(1);
    expect(res.body.status).toBe("ISSUED");
    expect(res.body.total).toBe("52102");
    expect(res.body.taxNote).toBe("Без налога (УСН)");
    expect(res.body.seller.name).toBe("ИП Светов Иван Петрович");
    expect(res.body.seller.rschet).toBe("40802810400001234567");
    expect(res.body.payer.legalName).toBe("ООО «Эпикпро»");
    expect(res.body.payer.inn).toBe("7701234567");
    expect(res.body.lines).toHaveLength(1);
    expect(res.body.lines[0].sum).toBe("52102");

    const client = await prisma.client.findUnique({ where: { name: "Эпикпро" } });
    expect(client.inn).toBe("7701234567");
    expect(client.rschet).toBe("40702810100000000001");
    expect(client.email).toBe("buh@epicpro.ru");

    const audit = await prisma.auditEntry.findFirst({ where: { entityType: "Bill", entityId: res.body.id, action: "BILL_CREATE" } });
    expect(audit).not.toBeNull();
  });

  it("второй счёт получает номер 2; реквизиты существующего клиента дописываются", async () => {
    const res = await request(app)
      .post("/api/bills")
      .set(SA())
      .send({
        client: { name: "Эпикпро", ogrn: "1027700132195" },
        lines: [
          { name: "Монтаж", unit: "шт.", quantity: 2, price: 1500.5 },
          { name: "Консультация", unit: "час", quantity: "1.5", price: "2000" },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.number).toBe(2);
    expect(res.body.total).toBe("6001"); // 3001 + 3000
    expect(res.body.payer.ogrn).toBe("1027700132195");
    expect(res.body.payer.inn).toBe("7701234567"); // осталось от прошлого раза
  });

  it("ручной номер: свободный принимается, занятый — 409 BILL_NUMBER_TAKEN", async () => {
    const ok = await request(app)
      .post("/api/bills")
      .set(SA())
      .send({ client: { name: "Эпикпро" }, number: 77, lines: [{ name: "Услуга", quantity: 1, price: 100 }] });
    expect(ok.status).toBe(201);
    expect(ok.body.number).toBe(77);
    const dup = await request(app)
      .post("/api/bills")
      .set(SA())
      .send({ client: { name: "Эпикпро" }, number: 77, lines: [{ name: "Услуга", quantity: 1, price: 100 }] });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("BILL_NUMBER_TAKEN");
    // Авто-нумерация продолжает с максимального
    const next = await request(app).get("/api/bills/next-number").set(SA());
    expect(next.status).toBe(200);
    expect(next.body.number).toBe(78);
  });

  it("валидация: без позиций / без контрагента / кривой ИНН → 400", async () => {
    const noLines = await request(app).post("/api/bills").set(SA()).send({ client: { name: "X" }, lines: [] });
    expect(noLines.status).toBe(400);
    const noClient = await request(app).post("/api/bills").set(SA()).send({ lines: [{ name: "У", quantity: 1, price: 1 }] });
    expect(noClient.status).toBe(400);
    const badInn = await request(app)
      .post("/api/bills")
      .set(SA())
      .send({ client: { name: "Y", inn: "123" }, lines: [{ name: "У", quantity: 1, price: 1 }] });
    expect(badInn.status).toBe(400);
  });

  it("WAREHOUSE не видит счета вовсе (403)", async () => {
    expect((await request(app).get("/api/bills").set(WH())).status).toBe(403);
    expect(
      (await request(app).post("/api/bills").set(WH()).send({ client: { name: "Z" }, lines: [{ name: "У", quantity: 1, price: 1 }] })).status,
    ).toBe(403);
  });
});

describe("GET/PATCH/status/pdf", () => {
  it("реестр отдаёт счётчики по статусам и годы; поиск по контрагенту и номеру", async () => {
    const res = await request(app).get("/api/bills").set(SA());
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThanOrEqual(3);
    expect(res.body.counts.ALL).toBe(res.body.items.length);
    expect(res.body.counts.ISSUED).toBe(res.body.items.length);
    expect(res.body.years).toContain(YEAR);
    expect(res.body.items[0].clientName).toBe("Эпикпро");

    const byNumber = await request(app).get("/api/bills?q=77").set(SA());
    expect(byNumber.body.items.map((b: any) => b.number)).toContain(77);
    const byName = await request(app).get("/api/bills?q=эпик").set(SA());
    expect(byName.body.items.length).toBeGreaterThanOrEqual(3);
  });

  it("PATCH меняет строки и пересчитывает итог; снапшот покупателя обновляется из карточки", async () => {
    const created = await request(app)
      .post("/api/bills")
      .set(SA())
      .send({ client: { name: "Эпикпро" }, lines: [{ name: "Услуга", quantity: 1, price: 100 }] });
    const id = created.body.id;
    const res = await request(app)
      .patch(`/api/bills/${id}`)
      .set(SA())
      .send({
        lines: [
          { name: "Услуга А", quantity: 2, price: 250 },
          { name: "Услуга Б", quantity: 1, price: "99.99" },
        ],
        clientDetails: { kpp: "770102002" },
        basis: "Заявка от 15.09.2026",
      });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe("599.99");
    expect(res.body.lines).toHaveLength(2);
    expect(res.body.lines[1].position).toBe(2);
    expect(res.body.payer.kpp).toBe("770102002");
    expect(res.body.basis).toBe("Заявка от 15.09.2026");
    const lines = await prisma.billLine.count({ where: { billId: id } });
    expect(lines).toBe(2);
  });

  it("PATCH с занятым номером → 409 BILL_NUMBER_TAKEN, счёт не меняется", async () => {
    const a = await request(app)
      .post("/api/bills")
      .set(SA())
      .send({ client: { name: "Эпикпро" }, number: 501, lines: [{ name: "А", quantity: 1, price: 10 }] });
    const b = await request(app)
      .post("/api/bills")
      .set(SA())
      .send({ client: { name: "Эпикпро" }, number: 502, lines: [{ name: "Б", quantity: 1, price: 20 }] });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const clash = await request(app).patch(`/api/bills/${b.body.id}`).set(SA()).send({ number: 501, basis: "x" });
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe("BILL_NUMBER_TAKEN");
    const still = await request(app).get(`/api/bills/${b.body.id}`).set(SA());
    expect(still.body.number).toBe(502);
    expect(still.body.basis).toBeNull();
  });

  it("статусы: PAID ставит paidAt, CANCELLED запрещает правку", async () => {
    const created = await request(app)
      .post("/api/bills")
      .set(SA())
      .send({ client: { name: "Эпикпро" }, lines: [{ name: "Услуга", quantity: 1, price: 100 }] });
    const id = created.body.id;
    const paid = await request(app).post(`/api/bills/${id}/status`).set(SA()).send({ status: "PAID" });
    expect(paid.status).toBe(200);
    expect(paid.body.status).toBe("PAID");
    expect(paid.body.paidAt).not.toBeNull();
    const cancelled = await request(app).post(`/api/bills/${id}/status`).set(SA()).send({ status: "CANCELLED" });
    expect(cancelled.body.status).toBe("CANCELLED");
    const edit = await request(app).patch(`/api/bills/${id}`).set(SA()).send({ basis: "x" });
    expect(edit.status).toBe(409);
    expect(edit.body.code).toBe("BILL_CANCELLED");
    const list = await request(app).get("/api/bills?status=CANCELLED").set(SA());
    expect(list.body.items.map((b: any) => b.id)).toContain(id);
  });

  it("PDF отдаётся inline и начинается с %PDF; сумма прописью и QR — в сервисе", async () => {
    const created = await request(app)
      .post("/api/bills")
      .set(SA())
      .send({ client: { name: "Эпикпро" }, lines: [{ name: "Аренда света", quantity: 1, price: "52102" }] });
    const id = created.body.id;
    const pdf = await request(app)
      .get(`/api/bills/${id}/pdf`)
      .set(SA())
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");
    expect(pdf.headers["content-disposition"]).toContain("inline");
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");

    const { getBill } = await import("../services/billService");
    const { buildGostPaymentQr, paymentPurpose } = await import("../services/billDocument/renderBillPdf");
    const { parseSellerSnapshot } = await import("../services/billService");
    const bill = await getBill(id);
    const seller = parseSellerSnapshot(bill.sellerSnapshot);
    const qr = buildGostPaymentQr(bill, seller, paymentPurpose(bill, bill.taxNote));
    expect(qr).not.toBeNull();
    expect(qr!.startsWith("ST00012|Name=ИП Светов Иван Петрович|PersonalAcc=40802810400001234567|BankName=АО «ТБанк»|BIC=044525974|CorrespAcc=30101810145250000974|PayeeINN=771234567890")).toBe(true);
    expect(qr).toContain("|Sum=5210200|");
    expect(qr).toContain(`Purpose=Оплата по счёту № ${bill.number}`);
  });

  it("404 для чужого id", async () => {
    expect((await request(app).get("/api/bills/nope").set(SA())).status).toBe(404);
    expect((await request(app).get("/api/bills/nope/pdf").set(SA())).status).toBe(404);
  });
});

describe("GET /api/bills/prefill?bookingId — счёт по брони", () => {
  it("разбивка: оборудование + надбавка за безнал, сумма сходится с finalAmount", async () => {
    const start = new Date(Date.now() + 10 * 86_400_000);
    start.setUTCHours(9, 0, 0, 0);
    const end = new Date(start.getTime() + 86_400_000);
    const draft = await request(app)
      .post("/api/bookings/draft")
      .set(SA())
      .send({
        client: { name: "Эпикпро" },
        projectName: "Клип",
        startDate: start.toISOString(),
        endDate: end.toISOString(),
        items: [{ equipmentId, quantity: 2 }], // 10 000
        discountPercent: 0,
        paymentForm: "CASHLESS",
      });
    expect(draft.status).toBe(200);
    const bookingId = draft.body.booking.id;

    const res = await request(app).get(`/api/bills/prefill?bookingId=${bookingId}`).set(SA());
    expect(res.status).toBe(200);
    expect(res.body.clientId).toBeTruthy();
    expect(res.body.client.legalName).toBe("ООО «Эпикпро»");
    expect(res.body.paymentForm).toBe("CASHLESS");
    expect(res.body.lines).toHaveLength(2);
    expect(res.body.lines[0].name).toContain("Аренда светового оборудования");
    expect(res.body.lines[0].price).toBe("10000");
    expect(res.body.lines[1].name).toBe("Безналичный расчёт, +9 %");
    expect(res.body.lines[1].price).toBe("900");
    const sum = res.body.lines.reduce((acc: Decimal, l: any) => acc.add(new Decimal(l.price).mul(l.quantity)), new Decimal(0));
    expect(sum.toString()).toBe(res.body.expectedTotal);
    expect(res.body.expectedTotal).toBe("10900");

    // Счёт по заготовке — с привязкой к брони
    const bill = await request(app)
      .post("/api/bills")
      .set(SA())
      .send({ clientId: res.body.clientId, bookingId, basis: res.body.basis, lines: res.body.lines });
    expect(bill.status).toBe(201);
    expect(bill.body.bookingId).toBe(bookingId);
    expect(bill.body.total).toBe("10900");
  });

  it("договорной итог — одной строкой", async () => {
    const start = new Date(Date.now() + 12 * 86_400_000);
    start.setUTCHours(9, 0, 0, 0);
    const end = new Date(start.getTime() + 86_400_000);
    const draft = await request(app)
      .post("/api/bookings/draft")
      .set(SA())
      .send({
        client: { name: "Эпикпро" },
        projectName: "Реклама",
        startDate: start.toISOString(),
        endDate: end.toISOString(),
        items: [{ equipmentId, quantity: 1 }],
        manualFinalAmount: 4444,
      });
    const res = await request(app).get(`/api/bills/prefill?bookingId=${draft.body.booking.id}`).set(SA());
    expect(res.status).toBe(200);
    expect(res.body.lines).toHaveLength(1);
    expect(res.body.lines[0].price).toBe("4444");
    expect(res.body.expectedTotal).toBe("4444");
  });

  it("несуществующая бронь → 404", async () => {
    const res = await request(app).get("/api/bills/prefill?bookingId=nope").set(SA());
    expect(res.status).toBe(404);
  });
});
