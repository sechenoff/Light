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

beforeAll(async () => {
  execSync("npx prisma db push --force-reset --skip-generate", {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes" },
    stdio: "pipe",
  });
  const { app: a } = await import("../app");
  const { PrismaClient } = await import("@prisma/client");
  ({ issueMagicLink } = await import("../services/clientPortal/magicLink"));
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
  const client = await prisma.client.create({ data: { name: `Cl-${Date.now()}` } });
  const acc = await prisma.clientPortalAccount.create({
    data: { clientId: client.id, email: `u${Date.now()}@x.ru`, status: "ACTIVE" },
  });
  const { rawToken } = await issueMagicLink(prisma, acc.id, "LOGIN");
  const verifyRes = await request(app).post("/api/lk/auth/verify").send({ token: rawToken });
  const cookie = verifyRes.headers["set-cookie"];
  return { client, acc, cookie };
}

async function makeBooking(clientId: string, status = "CONFIRMED") {
  const now = new Date();
  const end = new Date(now.getTime() + 3 * 86_400_000);
  return prisma.booking.create({
    data: { clientId, projectName: "Тест-проект", startDate: now, endDate: end, status },
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
      createdBy: opts.createdBy ?? "test-admin",
    },
  });
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/lk/debt", () => {
  it("returns empty result when client has no outstanding invoices", async () => {
    const { client, cookie } = await makeClientWithSession();
    const booking = await makeBooking(client.id);
    // Create a PAID invoice — should NOT appear in debt endpoint
    await makeInvoice(booking.id, { status: "PAID", total: "1000", paidAmount: "1000" });

    const res = await request(app).get("/api/lk/debt").set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.totalOutstanding).toBe("0");
    expect(res.body.overdueCount).toBe(0);
    expect(res.body.invoices).toHaveLength(0);
  });

  it("returns own outstanding invoices and NOT foreign client's", async () => {
    const { client: ownClient, cookie } = await makeClientWithSession();
    const { client: foreignClient } = await makeClientWithSession();

    const ownBooking = await makeBooking(ownClient.id);
    const foreignBooking = await makeBooking(foreignClient.id);

    await makeInvoice(ownBooking.id, { status: "ISSUED", total: "2000", paidAmount: "0" });
    await makeInvoice(foreignBooking.id, { status: "ISSUED", total: "5000", paidAmount: "0" });

    const res = await request(app).get("/api/lk/debt").set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.invoices).toHaveLength(1);
    expect(res.body.invoices[0].finalAmount).toBe("2000");
    expect(res.body.totalOutstanding).toBe("2000");
    // Foreign invoice must not appear
    const amounts = res.body.invoices.map((i: any) => i.finalAmount);
    expect(amounts).not.toContain("5000");
  });

  it("identifies overdue invoices and counts them", async () => {
    const { client, cookie } = await makeClientWithSession();
    const booking = await makeBooking(client.id);

    const pastDate = new Date(Date.now() - 10 * 86_400_000); // 10 days ago
    const futureDate = new Date(Date.now() + 10 * 86_400_000); // 10 days ahead

    // Explicitly OVERDUE status
    await makeInvoice(booking.id, {
      status: "OVERDUE",
      total: "1000",
      paidAmount: "0",
      dueDate: pastDate,
    });
    // ISSUED but past due date with outstanding balance (live overdue)
    await makeInvoice(booking.id, {
      status: "ISSUED",
      total: "500",
      paidAmount: "0",
      dueDate: pastDate,
    });
    // ISSUED with future due date — NOT overdue
    await makeInvoice(booking.id, {
      status: "ISSUED",
      total: "300",
      paidAmount: "0",
      dueDate: futureDate,
    });

    const res = await request(app).get("/api/lk/debt").set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.invoices).toHaveLength(3);
    expect(res.body.overdueCount).toBe(2);

    const overdueItems = res.body.invoices.filter((i: any) => i.isOverdue);
    expect(overdueItems).toHaveLength(2);

    const notOverdueItems = res.body.invoices.filter((i: any) => !i.isOverdue);
    expect(notOverdueItems).toHaveLength(1);
  });

  it("computes amountOutstanding correctly as total minus paidAmount", async () => {
    const { client, cookie } = await makeClientWithSession();
    const booking = await makeBooking(client.id);

    await makeInvoice(booking.id, {
      status: "PARTIAL_PAID",
      total: "1000",
      paidAmount: "500",
    });

    const res = await request(app).get("/api/lk/debt").set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.invoices).toHaveLength(1);
    const inv = res.body.invoices[0];
    expect(inv.finalAmount).toBe("1000");
    expect(inv.amountPaid).toBe("500");
    expect(inv.amountOutstanding).toBe("500");
    expect(res.body.totalOutstanding).toBe("500");
  });

  it("returns 401 without session cookie", async () => {
    const res = await request(app).get("/api/lk/debt");
    expect(res.status).toBe(401);
  });
});
