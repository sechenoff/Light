/**
 * Тесты math-фиксов финансового аудита 2026-07.
 *
 * Покрываем:
 *  (a) единая семантика «получено за период»: платёж с receivedAt в одном
 *      месяце и paymentDate в другом учитывается РОВНО один раз (по receivedAt)
 *      и в KPI, и в тренде — раньше OR-окно тренда давало двойной учёт;
 *  (b) KPI «Получено» — нетто: Refund в периоде уменьшает earned;
 *  (c) скоуп долга: DRAFT/PENDING_APPROVAL и deletedAt-брони НЕ дебиторка
 *      (computeDebts + dashboard totalOutstanding);
 *  (d) computeForecast: полностью оплаченная бронь без инвойсов не попадает в
 *      pipeline (раньше фолбэк на finalAmount показывал полученное как будущее);
 *  (e) BALANCE-счёт без суммы = остаток к доплате, не полная сумма брони;
 *  (f) кредит-нота: истёкшая не применяется (409 CREDIT_NOTE_EXPIRED);
 *  (g) bookingId-only возврат ограничен фактически полученным;
 *  (h) POST /payments/:id/void без причины → 400.
 */

import path from "path";
import { execSync } from "child_process";
import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-finance-math-audit.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-finance-math";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-finance-math";
process.env.JWT_SECRET = "test-jwt-secret-finance-math-min16chars";
process.env.AUTH_MODE = "enforce";
process.env.API_KEYS = "test-api-key";

let prisma: any;
let app: any;
let superAdminToken: string;
let adminId: string;
let clientId: string;

function authHeaders(token: string) {
  return { "X-API-Key": "test-api-key", Authorization: `Bearer ${token}` };
}

async function mkBooking(over: Record<string, unknown> = {}): Promise<any> {
  return prisma.booking.create({
    data: {
      clientId,
      projectName: `P-${Math.random().toString(36).slice(2, 8)}`,
      startDate: new Date("2026-07-10T10:00:00Z"),
      endDate: new Date("2026-07-12T10:00:00Z"),
      status: "CONFIRMED",
      finalAmount: "10000",
      amountPaid: "0",
      amountOutstanding: "10000",
      paymentStatus: "NOT_PAID",
      legacyFinance: false,
      ...over,
    },
  });
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
  const appMod = await import("../app");
  app = appMod.app ?? appMod.default;
  const { signSession } = await import("../services/auth");

  const admin = await prisma.adminUser.create({
    data: { username: "fin-math-sa", passwordHash: "x", role: "SUPER_ADMIN" },
  });
  adminId = admin.id;
  superAdminToken = signSession({ userId: admin.id, username: admin.username, role: "SUPER_ADMIN" });

  const client = await prisma.client.create({ data: { name: "Финансовый Клиент" } });
  clientId = client.id;
});

describe("(a)+(b) единая нетто-семантика «получено за период»", () => {
  it("платёж с receivedAt и paymentDate в разных месяцах учитывается один раз; refund вычитается", async () => {
    const b = await mkBooking();
    // receivedAt: март, paymentDate: апрель — считается ровно в марте.
    await prisma.payment.create({
      data: {
        bookingId: b.id,
        amount: "3000.00",
        method: "CASH",
        paymentMethod: "CASH",
        direction: "INCOME",
        status: "RECEIVED",
        receivedAt: new Date("2026-03-10T10:00:00Z"),
        paymentDate: new Date("2026-04-10T10:00:00Z"),
      },
    });
    // Возврат в марте — нетто марта = 3000 − 1000 = 2000.
    await prisma.refund.create({
      data: {
        bookingId: b.id,
        amount: "1000.00",
        reason: "тест",
        method: "CASH",
        refundedAt: new Date("2026-03-15T10:00:00Z"),
        createdBy: adminId,
      },
    });

    const { computeFinanceDashboard } = await import("../services/finance");
    const dash = await computeFinanceDashboard(new Date("2026-07-17T12:00:00Z"));

    const march = dash.trend.find((t: any) => t.month === "2026-03");
    const april = dash.trend.find((t: any) => t.month === "2026-04");
    expect(march?.earned).toBe("2000.00");
    // Апрель НЕ содержит этот платёж (нет двойного учёта через paymentDate).
    expect(april?.earned).toBe("0.00");

    // KPI за март тем же числом (единая формула KPI == тренд).
    const dashMarch = await computeFinanceDashboard(new Date("2026-07-17T12:00:00Z"), {
      from: new Date("2026-03-01T00:00:00Z"),
      to: new Date("2026-03-31T23:59:59Z"),
    });
    expect(dashMarch.earnedThisMonth).toBe("2000.00");
  });
});

describe("(c) скоуп долга: DRAFT/PENDING_APPROVAL/архив — не дебиторка", () => {
  it("computeDebts и dashboard.totalOutstanding игнорируют черновики и архив", async () => {
    const { computeDebts, computeFinanceDashboard } = await import("../services/finance");
    const before = await computeDebts();
    const beforeTotal = Number(before.summary.totalOutstanding);

    await mkBooking({ status: "DRAFT", amountOutstanding: "77777" });
    await mkBooking({ status: "PENDING_APPROVAL", amountOutstanding: "88888" });
    await mkBooking({ status: "CONFIRMED", amountOutstanding: "99999", deletedAt: new Date() });

    const after = await computeDebts();
    expect(Number(after.summary.totalOutstanding)).toBe(beforeTotal);

    const dash = await computeFinanceDashboard();
    // totalOutstanding дашборда тоже не видит эти брони
    expect(Number(dash.totalOutstanding)).toBe(beforeTotal);

    // Подтверждённая живая бронь — видна обоим
    await mkBooking({ status: "CONFIRMED", amountOutstanding: "500" });
    const after2 = await computeDebts();
    expect(Number(after2.summary.totalOutstanding)).toBe(beforeTotal + 500);
  });
});

describe("(d) forecast: оплаченная бронь не в pipeline", () => {
  it("бронь с outstanding=0 и amountPaid>0 не попадает в bookingsPipeline", async () => {
    const { computeForecast } = await import("../services/finance");
    const base = await computeForecast(6);
    const basePipeline = Number(base.totals.bookingsPipeline);

    // Полностью оплаченная бронь в горизонте прогноза (startDate в будущем месяце)
    const future = new Date();
    future.setDate(future.getDate() + 20);
    await mkBooking({
      startDate: future,
      endDate: new Date(future.getTime() + 2 * 86400000),
      amountPaid: "10000",
      amountOutstanding: "0",
      paymentStatus: "PAID",
    });

    const after = await computeForecast(6);
    expect(Number(after.totals.bookingsPipeline)).toBe(basePipeline);

    // А бронь без финансового состояния (paid=0, outstanding=0, final>0) — попадает
    await mkBooking({
      startDate: future,
      endDate: new Date(future.getTime() + 2 * 86400000),
      finalAmount: "4321",
      amountPaid: "0",
      amountOutstanding: "0",
    });
    const after2 = await computeForecast(6);
    expect(Number(after2.totals.bookingsPipeline)).toBe(basePipeline + 4321);
  });
});

describe("(e) BALANCE-счёт без суммы = остаток", () => {
  it("createInvoice(kind=BALANCE) берёт amountOutstanding, не полную сумму", async () => {
    const b = await mkBooking({
      finalAmount: "10000",
      amountPaid: "6000",
      amountOutstanding: "4000",
      paymentStatus: "PARTIALLY_PAID",
    });
    const { createInvoice } = await import("../services/invoiceService");
    const inv = await createInvoice({ bookingId: b.id, kind: "BALANCE" }, adminId);
    expect(inv.total.toString()).toBe("4000");
  });

  it("BALANCE при нулевом остатке → 409 NO_OUTSTANDING_BALANCE", async () => {
    const b = await mkBooking({
      amountPaid: "10000",
      amountOutstanding: "0",
      paymentStatus: "PAID",
    });
    const { createInvoice } = await import("../services/invoiceService");
    await expect(createInvoice({ bookingId: b.id, kind: "BALANCE" }, adminId)).rejects.toMatchObject({
      status: 409,
      code: "NO_OUTSTANDING_BALANCE",
    });
  });
});

describe("(f) кредит-нота: срок действия проверяется на сервере", () => {
  it("истёкшая кредит-нота → 409 CREDIT_NOTE_EXPIRED", async () => {
    const b = await mkBooking();
    const note = await prisma.creditNote.create({
      data: {
        contactClientId: clientId,
        amount: "1000",
        remaining: "1000",
        reason: "тест-истёкшая",
        expiresAt: new Date(Date.now() - 86400000), // вчера
        createdBy: adminId,
      },
    });
    const { applyCreditNote } = await import("../services/creditNoteService");
    await expect(applyCreditNote(note.id, b.id, adminId)).rejects.toMatchObject({
      status: 409,
      code: "CREDIT_NOTE_EXPIRED",
    });
  });
});

describe("(g) bookingId-only возврат ограничен полученным", () => {
  it("возврат больше полученного по броне → 422 REFUND_EXCEEDS_PAID_AMOUNT", async () => {
    const b = await mkBooking();
    await prisma.payment.create({
      data: {
        bookingId: b.id,
        amount: "2000.00",
        method: "CASH",
        paymentMethod: "CASH",
        direction: "INCOME",
        status: "RECEIVED",
        receivedAt: new Date(),
        paymentDate: new Date(),
      },
    });
    const { createRefund } = await import("../services/refundService");
    await expect(
      createRefund({ bookingId: b.id, amount: 5000, reason: "слишком много", method: "CASH" }, adminId),
    ).rejects.toMatchObject({ status: 422, code: "REFUND_EXCEEDS_PAID_AMOUNT" });

    // В пределах полученного — проходит
    const ok = await createRefund(
      { bookingId: b.id, amount: 1500, reason: "частичный возврат", method: "CASH" },
      adminId,
    );
    expect(ok.amount.toString()).toBe("1500");
  });
});

describe("(h) void платежа требует причину", () => {
  it("POST /api/payments/:id/void без reason → 400", async () => {
    const b = await mkBooking();
    const p = await prisma.payment.create({
      data: {
        bookingId: b.id,
        amount: "100.00",
        method: "CASH",
        paymentMethod: "CASH",
        direction: "INCOME",
        status: "RECEIVED",
        receivedAt: new Date(),
        paymentDate: new Date(),
      },
    });
    const res = await request(app)
      .post(`/api/payments/${p.id}/void`)
      .set(authHeaders(superAdminToken))
      .send({});
    expect(res.status).toBe(400);

    // Платёж НЕ аннулирован
    const still = await prisma.payment.findUnique({ where: { id: p.id } });
    expect(still.voidedAt).toBeNull();
  });
});
