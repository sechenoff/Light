import path from "node:path";
import fs from "node:fs";
import { execSync } from "node:child_process";
import request from "supertest";

const TEST_DB = path.resolve(__dirname, `../../prisma/test-lk-debt-${process.pid}.db`);
process.env.DATABASE_URL = `file:${TEST_DB}`;
process.env.CLIENT_PORTAL_SESSION_SECRET = "test-session-secret-min-sixteen-chars";
process.env.CLIENT_PORTAL_TOKEN_SECRET = "test-token-secret-min-sixteen-chars";

let app: any;
let prisma: any;
let issueMagicLink: any;
let computeDebts: any;

beforeAll(async () => {
  execSync("npx prisma db push --force-reset --skip-generate", {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes" },
    stdio: "pipe",
  });
  const { app: a } = await import("../app");
  const { PrismaClient } = await import("@prisma/client");
  ({ issueMagicLink } = await import("../services/clientPortal/magicLink"));
  ({ computeDebts } = await import("../services/finance"));
  app = a;
  prisma = new PrismaClient();
});

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(TEST_DB, { force: true });
});

beforeEach(async () => {
  await prisma.invoice.deleteMany();
  await prisma.bookingItem.deleteMany();
  await prisma.booking.deleteMany();
  await prisma.clientPortalMagicLink.deleteMany();
  await prisma.clientPortalAccount.deleteMany();
  await prisma.client.deleteMany();
});

// ── helpers ──────────────────────────────────────────────────────────────────

async function makeClientWithSession() {
  const client = await prisma.client.create({ data: { name: `Cl-${Date.now()}-${Math.random()}` } });
  const acc = await prisma.clientPortalAccount.create({
    data: { clientId: client.id, email: `u${Date.now()}-${Math.floor(Math.random() * 99999)}@x.ru`, status: "ACTIVE" },
  });
  const { rawToken } = await issueMagicLink(prisma, acc.id, "LOGIN");
  const verifyRes = await request(app).post("/api/lk/auth/verify").send({ token: rawToken });
  const cookie = verifyRes.headers["set-cookie"];
  return { client, acc, cookie };
}

async function makeBooking(
  clientId: string,
  opts: {
    status?: string;
    finalAmount?: string;
    amountPaid?: string;
    amountOutstanding?: string;
    endDate?: Date;
    deletedAt?: Date | null;
    expectedPaymentDate?: Date | null;
    paymentStatus?: string;
  } = {}
) {
  const now = new Date();
  const end = opts.endDate ?? new Date(now.getTime() + 3 * 86_400_000);
  const start = new Date(end.getTime() - 3 * 86_400_000);
  return prisma.booking.create({
    data: {
      clientId,
      projectName: "Тест-проект",
      startDate: start,
      endDate: end,
      status: opts.status ?? "RETURNED",
      finalAmount: opts.finalAmount ?? "1000",
      amountPaid: opts.amountPaid ?? "0",
      amountOutstanding: opts.amountOutstanding ?? "1000",
      deletedAt: opts.deletedAt ?? null,
      ...(opts.expectedPaymentDate !== undefined
        ? { expectedPaymentDate: opts.expectedPaymentDate }
        : {}),
      ...(opts.paymentStatus ? { paymentStatus: opts.paymentStatus as any } : {}),
    },
  });
}

async function makeInvoice(
  bookingId: string,
  opts: {
    status?: string;
    total?: string;
    paidAmount?: string;
    dueDate?: Date | null;
    issuedAt?: Date;
    voidedAt?: Date | null;
    createdBy?: string;
  } = {}
) {
  return prisma.invoice.create({
    data: {
      bookingId,
      number: `LR-${Date.now()}-${Math.floor(Math.random() * 9999)}`,
      kind: "FULL",
      status: opts.status ?? "ISSUED",
      total: opts.total ?? "1000",
      paidAmount: opts.paidAmount ?? "0",
      dueDate: opts.dueDate !== undefined ? opts.dueDate : new Date(Date.now() + 30 * 86_400_000),
      issuedAt: opts.issuedAt ?? new Date(),
      voidedAt: opts.voidedAt ?? null,
      createdBy: opts.createdBy ?? "test-admin",
    },
  });
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/lk/debt (по броням, единый источник с /finance/debts)", () => {
  it("returns empty result when client has no bookings with outstanding", async () => {
    const { client, cookie } = await makeClientWithSession();
    // Полностью оплаченная бронь — долга нет
    await makeBooking(client.id, {
      finalAmount: "1000",
      amountPaid: "1000",
      amountOutstanding: "0",
    });

    const res = await request(app).get("/api/lk/debt").set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.totalOutstanding).toBe("0");
    expect(res.body.overdueCount).toBe(0);
    expect(res.body.bookings).toHaveLength(0);
  });

  it("бронь с остатком БЕЗ счёта видна в долге (главный сценарий рассинхрона)", async () => {
    const { client, cookie } = await makeClientWithSession();
    await makeBooking(client.id, {
      finalAmount: "2000",
      amountPaid: "500",
      amountOutstanding: "1500",
    });
    // Счёт НЕ выставлен — раньше эндпоинт показывал «Долгов нет»

    const res = await request(app).get("/api/lk/debt").set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.bookings).toHaveLength(1);
    const row = res.body.bookings[0];
    expect(row.finalAmount).toBe("2000");
    expect(row.amountPaid).toBe("500");
    expect(row.amountOutstanding).toBe("1500");
    expect(row.invoice).toBeNull();
    expect(res.body.totalOutstanding).toBe("1500");
  });

  it("returns own outstanding bookings and NOT foreign client's", async () => {
    const { client: ownClient, cookie } = await makeClientWithSession();
    const { client: foreignClient } = await makeClientWithSession();

    await makeBooking(ownClient.id, { finalAmount: "2000", amountOutstanding: "2000" });
    await makeBooking(foreignClient.id, { finalAmount: "5000", amountOutstanding: "5000" });

    const res = await request(app).get("/api/lk/debt").set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.bookings).toHaveLength(1);
    expect(res.body.bookings[0].amountOutstanding).toBe("2000");
    expect(res.body.totalOutstanding).toBe("2000");
    const amounts = res.body.bookings.map((b: any) => b.amountOutstanding);
    expect(amounts).not.toContain("5000");
  });

  it("исключает CANCELLED, DRAFT и архивные (deletedAt) брони", async () => {
    const { client, cookie } = await makeClientWithSession();

    await makeBooking(client.id, { status: "CANCELLED", amountOutstanding: "1000" });
    await makeBooking(client.id, { status: "DRAFT", amountOutstanding: "700" });
    await makeBooking(client.id, {
      status: "RETURNED",
      amountOutstanding: "300",
      deletedAt: new Date(),
    });
    await makeBooking(client.id, { status: "ISSUED", amountOutstanding: "400" });

    const res = await request(app).get("/api/lk/debt").set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.bookings).toHaveLength(1);
    expect(res.body.bookings[0].amountOutstanding).toBe("400");
    expect(res.body.totalOutstanding).toBe("400");
  });

  it("isOverdue — тот же хелпер, что в админке (expectedPaymentDate/paymentStatus), не endDate", async () => {
    const { client, cookie } = await makeClientWithSession();

    const past = new Date(Date.now() - 10 * 86_400_000);
    const future = new Date(Date.now() + 10 * 86_400_000);

    // Срок оплаты прошёл → просрочено (даже при endDate в будущем)
    await makeBooking(client.id, {
      amountOutstanding: "1000",
      endDate: future,
      expectedPaymentDate: past,
    });
    // Аренда закончилась, но согласована отсрочка платежа → НЕ просрочено:
    // клиент не должен видеть rose-подсветку, когда менеджер её не видит
    await makeBooking(client.id, {
      status: "ISSUED",
      amountOutstanding: "500",
      endDate: past,
      expectedPaymentDate: future,
    });
    // paymentStatus=OVERDUE — страховочная ветка хелпера
    await makeBooking(client.id, {
      amountOutstanding: "300",
      expectedPaymentDate: null,
      paymentStatus: "OVERDUE",
    });

    const res = await request(app).get("/api/lk/debt").set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.bookings).toHaveLength(3);
    expect(res.body.overdueCount).toBe(2);

    const overdue = res.body.bookings.filter((b: any) => b.isOverdue);
    expect(overdue.map((b: any) => b.amountOutstanding).sort()).toEqual(["1000", "300"]);
  });

  it("невоидный счёт возвращается как детализация; VOID/DRAFT-счета игнорируются", async () => {
    const { client, cookie } = await makeClientWithSession();
    const booking = await makeBooking(client.id, { amountOutstanding: "1000" });

    const due = new Date(Date.now() + 14 * 86_400_000);
    // VOID-счёт — не должен попасть в детализацию
    await makeInvoice(booking.id, { status: "VOID", voidedAt: new Date() });
    // Живой счёт
    const inv = await makeInvoice(booking.id, { status: "ISSUED", dueDate: due });

    const res = await request(app).get("/api/lk/debt").set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.bookings).toHaveLength(1);
    const row = res.body.bookings[0];
    expect(row.invoice).toBeTruthy();
    expect(row.invoice.number).toBe(inv.number);
    expect(new Date(row.invoice.dueDate).getTime()).toBe(due.getTime());
  });

  it("итог totalOutstanding совпадает с /finance/debts (computeDebts) для того же клиента", async () => {
    const { client, cookie } = await makeClientWithSession();

    await makeBooking(client.id, { finalAmount: "2000", amountPaid: "500", amountOutstanding: "1500" });
    await makeBooking(client.id, { status: "ISSUED", finalAmount: "3000", amountOutstanding: "3000" });
    await makeBooking(client.id, { status: "CANCELLED", amountOutstanding: "999" });

    const res = await request(app).get("/api/lk/debt").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.totalOutstanding).toBe("4500");

    const adminDebts = await computeDebts();
    const clientDebt = adminDebts.debts.find((d: any) => d.clientId === client.id);
    expect(clientDebt).toBeTruthy();
    // computeDebts сериализует с toFixed(2) ("4500.00") — сравниваем численно
    expect(Number(clientDebt.totalOutstanding)).toBe(Number(res.body.totalOutstanding));
  });

  it("returns 401 without session cookie", async () => {
    const res = await request(app).get("/api/lk/debt");
    expect(res.status).toBe(401);
  });
});
