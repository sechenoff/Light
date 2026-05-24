import path from "node:path";
import fs from "node:fs";
import { execSync } from "node:child_process";
import request from "supertest";

const TEST_DB = path.resolve(__dirname, `../../prisma/test-lk-estimates-${process.pid}.db`);
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
  projectName = "Тест"
) {
  const d = new Date("2026-05-01T10:00:00Z");
  const e = new Date("2026-05-10T10:00:00Z");
  return prisma.booking.create({
    data: { clientId, projectName, startDate: d, endDate: e, status },
  });
}

async function makeEstimate(bookingId: string, kind: string = "MAIN", total = "1000") {
  return prisma.estimate.create({
    data: {
      bookingId,
      kind,
      shifts: 1,
      subtotal: total,
      discountAmount: "0",
      totalAfterDiscount: total,
    },
  });
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/lk/estimates", () => {
  test("returns only MAIN estimates of visible-status bookings, excluding ADDON and DRAFT bookings", async () => {
    const { client, cookie } = await makeClientWithSession();
    const clientB = await prisma.client.create({ data: { name: "Клиент Б" } });

    // Client A: 2 bookings with MAIN estimates
    const bookingConfirmed = await makeBooking(client.id, "CONFIRMED", "Проект A1");
    const bookingIssued = await makeBooking(client.id, "ISSUED", "Проект A2");
    const estMain1 = await makeEstimate(bookingConfirmed.id, "MAIN", "2000");
    const estMain2 = await makeEstimate(bookingIssued.id, "MAIN", "3000");

    // Client A: ADDON estimate on confirmed booking — must NOT appear
    await makeEstimate(bookingConfirmed.id, "ADDON", "500");

    // Client A: DRAFT booking with MAIN estimate — must NOT appear (DRAFT is not in VISIBLE_STATUSES)
    const bookingDraft = await makeBooking(client.id, "DRAFT", "Черновик");
    await makeEstimate(bookingDraft.id, "MAIN", "1500");

    // Client B: MAIN estimate — must NOT appear (tenant isolation)
    const bookingB = await makeBooking(clientB.id, "CONFIRMED", "Проект Б");
    await makeEstimate(bookingB.id, "MAIN", "4000");

    const res = await request(app).get("/api/lk/estimates").set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);

    // Verify IDs match the two MAIN estimates of client A's visible bookings
    const returnedBookingIds = res.body.items.map((i: any) => i.bookingId).sort();
    expect(returnedBookingIds).toEqual(
      [bookingConfirmed.id, bookingIssued.id].sort()
    );

    // Verify shape of each item
    for (const item of res.body.items) {
      expect(item).toHaveProperty("bookingId");
      expect(item).toHaveProperty("bookingNo");
      expect(item.bookingNo).toMatch(/^#[A-Z0-9]{6}$/);
      expect(item).toHaveProperty("projectName");
      expect(item).toHaveProperty("issuedAt");
      expect(item).toHaveProperty("totalAfterDiscount");
      expect(item).toHaveProperty("pdfUrl");
    }

    expect(res.body.nextCursor).toBeNull();
  });

  test("cursor pagination: nextCursor returned, second page fetches remaining item", async () => {
    const { client, cookie } = await makeClientWithSession();

    // Create N+1 = 3 confirmed bookings with MAIN estimates (limit will be 2)
    const bookings = [];
    for (let i = 0; i < 3; i++) {
      const b = await makeBooking(client.id, "CONFIRMED", `Проект ${i + 1}`);
      bookings.push(b);
      await makeEstimate(b.id, "MAIN", String((i + 1) * 1000));
      // Small delay to ensure distinct createdAt timestamps in SQLite
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // Page 1: limit=2
    const page1 = await request(app)
      .get("/api/lk/estimates?limit=2")
      .set("Cookie", cookie);

    expect(page1.status).toBe(200);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.nextCursor).toBeTruthy();
    expect(page1.body.nextCursor).toContain("|");

    // Page 2: follow cursor
    const page2 = await request(app)
      .get(`/api/lk/estimates?limit=2&cursor=${page1.body.nextCursor}`)
      .set("Cookie", cookie);

    expect(page2.status).toBe(200);
    expect(page2.body.items).toHaveLength(1);
    expect(page2.body.nextCursor).toBeNull();

    // All 3 estimates covered
    const allBookingIds = [
      ...page1.body.items.map((i: any) => i.bookingId),
      ...page2.body.items.map((i: any) => i.bookingId),
    ];
    expect(allBookingIds).toHaveLength(3);
    expect(new Set(allBookingIds).size).toBe(3);
  });

  test("each item carries pdfUrl pointing to existing estimate.pdf endpoint", async () => {
    const { client, cookie } = await makeClientWithSession();

    const booking = await makeBooking(client.id, "CONFIRMED", "PDF-тест");
    await makeEstimate(booking.id, "MAIN", "999");

    const res = await request(app).get("/api/lk/estimates").set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);

    const item = res.body.items[0];
    expect(item.pdfUrl).toBe(`/api/lk/bookings/${booking.id}/estimate.pdf`);
  });

  test("401 without cookie", async () => {
    const res = await request(app).get("/api/lk/estimates");
    expect(res.status).toBe(401);
  });
});
