import path from "node:path";
import fs from "node:fs";
import { execSync } from "node:child_process";
import request from "supertest";

const TEST_DB = path.resolve(__dirname, `../../prisma/test-lk-bookings-${process.pid}.db`);
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
  await prisma.estimateLine.deleteMany();
  await prisma.estimate.deleteMany();
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

async function makeBooking(
  clientId: string,
  status: string,
  startDate: Date,
  endDate: Date,
  projectName = "Тест"
) {
  return prisma.booking.create({
    data: {
      clientId,
      projectName,
      startDate,
      endDate,
      status,
    },
  });
}

async function makeEstimate(bookingId: string, kind: string = "MAIN") {
  return prisma.estimate.create({
    data: {
      bookingId,
      kind,
      shifts: 1,
      subtotal: "1000",
      discountAmount: "0",
      totalAfterDiscount: "1000",
    },
  });
}

async function makeEstimateLine(estimateId: string) {
  return prisma.estimateLine.create({
    data: {
      estimateId,
      categorySnapshot: "Свет",
      nameSnapshot: "LED панель",
      quantity: 2,
      unitPrice: "500",
      lineSum: "1000",
    },
  });
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/lk/bookings", () => {
  test("returns own bookings excluding DRAFT, sorted by startDate desc", async () => {
    const { client, cookie } = await makeClientWithSession();
    const foreignClient = await prisma.client.create({ data: { name: "Чужой" } });

    const now = new Date("2026-05-01T10:00:00Z");
    const later = new Date("2026-05-10T10:00:00Z");
    const end = new Date("2026-05-20T10:00:00Z");

    // own bookings
    const b1 = await makeBooking(client.id, "CONFIRMED", now, end, "Проект 1");
    const b2 = await makeBooking(client.id, "ISSUED", later, end, "Проект 2");
    // DRAFT — must be excluded
    await makeBooking(client.id, "DRAFT", now, end, "Черновик");
    // foreign client — must be excluded
    await makeBooking(foreignClient.id, "CONFIRMED", now, end, "Чужой проект");

    const res = await request(app).get("/api/lk/bookings").set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    // sorted by startDate desc: b2 (later) should come first
    expect(res.body.items[0].id).toBe(b2.id);
    expect(res.body.items[1].id).toBe(b1.id);
    // structure check
    expect(res.body.items[0]).toMatchObject({
      id: b2.id,
      status: "ISSUED",
      projectName: "Проект 2",
    });
    expect(res.body.items[0].bookingNo).toMatch(/^#[A-Z0-9]{6}$/);
    expect(res.body.nextCursor).toBeNull();
  });

  test("status filter returns only bookings with that status", async () => {
    const { client, cookie } = await makeClientWithSession();
    const d = new Date("2026-05-01T10:00:00Z");
    const e = new Date("2026-05-10T10:00:00Z");

    await makeBooking(client.id, "CONFIRMED", d, e, "Подтверждена");
    const issued = await makeBooking(client.id, "ISSUED", d, e, "Выдана");

    const res = await request(app)
      .get("/api/lk/bookings?status=ISSUED")
      .set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe(issued.id);
  });

  test("cursor pagination: nextCursor returned, second page has remaining item", async () => {
    const { client, cookie } = await makeClientWithSession();

    // Create 3 bookings with different start dates
    const dates = [
      new Date("2026-05-01T00:00:00Z"),
      new Date("2026-05-02T00:00:00Z"),
      new Date("2026-05-03T00:00:00Z"),
    ];
    const end = new Date("2026-05-30T00:00:00Z");
    const bookings = [];
    for (const d of dates) {
      bookings.push(await makeBooking(client.id, "CONFIRMED", d, end, `Проект ${d.toISOString()}`));
    }

    // Request first 2 (limit=2)
    const page1 = await request(app)
      .get("/api/lk/bookings?limit=2")
      .set("Cookie", cookie);

    expect(page1.status).toBe(200);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.nextCursor).toBeTruthy();

    // Request second page using cursor
    const page2 = await request(app)
      .get(`/api/lk/bookings?limit=2&cursor=${page1.body.nextCursor}`)
      .set("Cookie", cookie);

    expect(page2.status).toBe(200);
    expect(page2.body.items).toHaveLength(1);
    expect(page2.body.nextCursor).toBeNull();

    // All 3 bookings covered across both pages
    const allIds = [...page1.body.items.map((b: any) => b.id), ...page2.body.items.map((b: any) => b.id)];
    expect(allIds).toHaveLength(3);
  });

  test("401 without cookie", async () => {
    const res = await request(app).get("/api/lk/bookings");
    expect(res.status).toBe(401);
  });
});

describe("GET /api/lk/bookings/:id", () => {
  test("own CONFIRMED booking returns 200 with items from CONFIRMED estimate", async () => {
    const { client, cookie } = await makeClientWithSession();
    const d = new Date("2026-06-01T10:00:00Z");
    const e = new Date("2026-06-05T10:00:00Z");

    const booking = await makeBooking(client.id, "CONFIRMED", d, e, "Тестовый проект");
    const estimate = await makeEstimate(booking.id, "MAIN");
    await makeEstimateLine(estimate.id);

    const res = await request(app)
      .get(`/api/lk/bookings/${booking.id}`)
      .set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: booking.id,
      status: "CONFIRMED",
      projectName: "Тестовый проект",
      shifts: 1,
      subtotal: "1000",
      discountAmount: "0",
      totalAfterDiscount: "1000",
      hasConfirmedEstimate: true,
      hasAct: false,
    });
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      categorySnapshot: "Свет",
      nameSnapshot: "LED панель",
      quantity: 2,
    });
    expect(res.body.bookingNo).toMatch(/^#[A-Z0-9]{6}$/);
  });

  test("RETURNED booking has hasAct=true", async () => {
    const { client, cookie } = await makeClientWithSession();
    const d = new Date("2026-06-01T10:00:00Z");
    const e = new Date("2026-06-05T10:00:00Z");

    const booking = await makeBooking(client.id, "RETURNED", d, e);

    const res = await request(app)
      .get(`/api/lk/bookings/${booking.id}`)
      .set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.hasAct).toBe(true);
  });

  test("foreign booking returns 404", async () => {
    const { cookie } = await makeClientWithSession();
    const foreignClient = await prisma.client.create({ data: { name: "Чужой" } });
    const d = new Date("2026-06-01T10:00:00Z");
    const e = new Date("2026-06-05T10:00:00Z");

    const foreignBooking = await makeBooking(foreignClient.id, "CONFIRMED", d, e);

    const res = await request(app)
      .get(`/api/lk/bookings/${foreignBooking.id}`)
      .set("Cookie", cookie);

    expect(res.status).toBe(404);
  });

  test("DRAFT booking owned by self returns 404 (not visible)", async () => {
    const { client, cookie } = await makeClientWithSession();
    const d = new Date("2026-06-01T10:00:00Z");
    const e = new Date("2026-06-05T10:00:00Z");

    const draft = await makeBooking(client.id, "DRAFT", d, e);

    const res = await request(app)
      .get(`/api/lk/bookings/${draft.id}`)
      .set("Cookie", cookie);

    expect(res.status).toBe(404);
  });

  test("nonexistent id returns 404", async () => {
    const { cookie } = await makeClientWithSession();

    const res = await request(app)
      .get("/api/lk/bookings/nonexistent-id-xyz")
      .set("Cookie", cookie);

    expect(res.status).toBe(404);
  });
});
