import path from "node:path";
import fs from "node:fs";
import { execSync } from "node:child_process";
import request from "supertest";

const TEST_DB = path.resolve(__dirname, `../../prisma/test-lk-stats-${process.pid}.db`);
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
  await prisma.equipment.deleteMany();
});

// ── helpers ───────────────────────────────────────────────────────────────────

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

async function makeEquipment(suffix: string) {
  return prisma.equipment.create({
    data: {
      importKey: `test-${suffix}-${Date.now()}`,
      name: `Оборудование ${suffix}`,
      category: `Категория ${suffix}`,
      totalQuantity: 5,
      rentalRatePerShift: "1000",
    },
  });
}

async function makeBooking(clientId: string, status: string, projectName = "Тест") {
  const d = new Date("2026-05-01T10:00:00Z");
  const e = new Date("2026-05-10T10:00:00Z");
  return prisma.booking.create({
    data: { clientId, projectName, startDate: d, endDate: e, status },
  });
}

async function makeEstimateWithLines(
  bookingId: string,
  kind: string,
  lines: Array<{ equipmentId: string | null; name: string; category: string; lineSum: string }>
) {
  const estimate = await prisma.estimate.create({
    data: {
      bookingId,
      kind,
      shifts: 1,
      subtotal: "1000",
      discountAmount: "0",
      totalAfterDiscount: "1000",
    },
  });
  for (const ln of lines) {
    await prisma.estimateLine.create({
      data: {
        estimateId: estimate.id,
        equipmentId: ln.equipmentId,
        nameSnapshot: ln.name,
        categorySnapshot: ln.category,
        quantity: 1,
        unitPrice: ln.lineSum,
        lineSum: ln.lineSum,
      },
    });
  }
  return estimate;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/lk/stats", () => {
  test("401 without cookie", async () => {
    const res = await request(app).get("/api/lk/stats");
    expect(res.status).toBe(401);
  });

  test("top equipment: sorted by bookingsCount desc, E1 (3 bookings) before E2 (2 bookings)", async () => {
    const { client, cookie } = await makeClientWithSession();

    const eq1 = await makeEquipment("E1");
    const eq2 = await makeEquipment("E2");

    // 3 bookings — E1 appears in all 3, E2 in 2
    for (let i = 0; i < 3; i++) {
      const b = await makeBooking(client.id, "CONFIRMED", `Проект ${i + 1}`);
      const lines = [
        { equipmentId: eq1.id, name: eq1.name, category: eq1.category, lineSum: "500" },
      ];
      if (i < 2) {
        lines.push({ equipmentId: eq2.id, name: eq2.name, category: eq2.category, lineSum: "300" });
      }
      await makeEstimateWithLines(b.id, "MAIN", lines);
    }

    const res = await request(app)
      .get("/api/lk/stats?period=all")
      .set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.topEquipment).toHaveLength(2);

    const first = res.body.topEquipment[0];
    const second = res.body.topEquipment[1];

    expect(first.equipmentId).toBe(eq1.id);
    expect(first.bookingsCount).toBe(3);
    expect(first.totalQuantityRented).toBe(3);

    expect(second.equipmentId).toBe(eq2.id);
    expect(second.bookingsCount).toBe(2);
  });

  test("top equipment: DRAFT and CANCELLED bookings excluded", async () => {
    const { client, cookie } = await makeClientWithSession();
    const eq1 = await makeEquipment("X1");

    // Only DRAFT — should not appear
    const draftBooking = await makeBooking(client.id, "DRAFT", "Черновик");
    await makeEstimateWithLines(draftBooking.id, "MAIN", [
      { equipmentId: eq1.id, name: eq1.name, category: eq1.category, lineSum: "200" },
    ]);

    const res = await request(app)
      .get("/api/lk/stats?period=all")
      .set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.topEquipment).toHaveLength(0);
  });

  test("typicalKit: empty when sampleSize < 3", async () => {
    const { client, cookie } = await makeClientWithSession();
    const eq1 = await makeEquipment("T1");

    // Only 2 qualifying bookings
    for (let i = 0; i < 2; i++) {
      const b = await makeBooking(client.id, "CONFIRMED", `Проект ${i + 1}`);
      await makeEstimateWithLines(b.id, "MAIN", [
        { equipmentId: eq1.id, name: eq1.name, category: eq1.category, lineSum: "100" },
      ]);
    }

    const res = await request(app)
      .get("/api/lk/stats?period=all")
      .set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.typicalKit).toEqual([]);
    expect(res.body.typicalKitSampleSize).toBe(2);
  });

  test("typicalKit: frequency threshold 0.4 (2/5 = 0.4 included, 1/5 = 0.2 excluded)", async () => {
    const { client, cookie } = await makeClientWithSession();

    const eq1 = await makeEquipment("F1"); // freq 5/5 = 1.0
    const eq2 = await makeEquipment("F2"); // freq 2/5 = 0.4
    const eq3 = await makeEquipment("F3"); // freq 1/5 = 0.2

    for (let i = 0; i < 5; i++) {
      const b = await makeBooking(client.id, "CONFIRMED", `Проект ${i + 1}`);
      const lines: Array<{ equipmentId: string; name: string; category: string; lineSum: string }> = [
        { equipmentId: eq1.id, name: eq1.name, category: eq1.category, lineSum: "100" },
      ];
      if (i < 2) {
        lines.push({ equipmentId: eq2.id, name: eq2.name, category: eq2.category, lineSum: "200" });
      }
      if (i === 0) {
        lines.push({ equipmentId: eq3.id, name: eq3.name, category: eq3.category, lineSum: "50" });
      }
      await makeEstimateWithLines(b.id, "MAIN", lines);
    }

    const res = await request(app)
      .get("/api/lk/stats?period=all")
      .set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.typicalKitSampleSize).toBe(5);

    const kitIds = res.body.typicalKit.map((e: any) => e.equipmentId);

    // E1 (100%) and E2 (40%) included
    expect(kitIds).toContain(eq1.id);
    expect(kitIds).toContain(eq2.id);

    // E3 (20%) excluded
    expect(kitIds).not.toContain(eq3.id);

    // Sorted by frequency desc: E1 first (1.0), then E2 (0.4)
    expect(kitIds[0]).toBe(eq1.id);
    expect(kitIds[1]).toBe(eq2.id);

    // Frequency values in range [0,1]
    for (const item of res.body.typicalKit) {
      expect(item.frequency).toBeGreaterThanOrEqual(0);
      expect(item.frequency).toBeLessThanOrEqual(1);
    }
  });

  test("period filter: 180d excludes old bookings from topEquipment", async () => {
    const { client, cookie } = await makeClientWithSession();
    const eq1 = await makeEquipment("P1");

    // Old booking (more than 180 days ago)
    const oldDate = new Date(Date.now() - 200 * 86_400_000);
    const oldBooking = await prisma.booking.create({
      data: {
        clientId: client.id,
        projectName: "Старый",
        startDate: oldDate,
        endDate: new Date(oldDate.getTime() + 86_400_000),
        status: "RETURNED",
      },
    });
    await makeEstimateWithLines(oldBooking.id, "MAIN", [
      { equipmentId: eq1.id, name: eq1.name, category: eq1.category, lineSum: "999" },
    ]);

    const res180 = await request(app)
      .get("/api/lk/stats?period=180d")
      .set("Cookie", cookie);

    const resAll = await request(app)
      .get("/api/lk/stats?period=all")
      .set("Cookie", cookie);

    expect(res180.status).toBe(200);
    expect(res180.body.topEquipment).toHaveLength(0);

    expect(resAll.status).toBe(200);
    expect(resAll.body.topEquipment).toHaveLength(1);
  });

  test("response shape: contains required fields", async () => {
    const { client, cookie } = await makeClientWithSession();
    const eq1 = await makeEquipment("S1");

    const b = await makeBooking(client.id, "CONFIRMED", "Шейп");
    await makeEstimateWithLines(b.id, "MAIN", [
      { equipmentId: eq1.id, name: eq1.name, category: eq1.category, lineSum: "500" },
    ]);

    const res = await request(app)
      .get("/api/lk/stats")
      .set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("period");
    expect(res.body).toHaveProperty("rangeFrom");
    expect(res.body).toHaveProperty("rangeTo");
    expect(res.body).toHaveProperty("topEquipment");
    expect(res.body).toHaveProperty("typicalKit");
    expect(res.body).toHaveProperty("typicalKitSampleSize");

    const item = res.body.topEquipment[0];
    expect(item).toHaveProperty("equipmentId");
    expect(item).toHaveProperty("name");
    expect(item).toHaveProperty("category");
    expect(item).toHaveProperty("bookingsCount");
    expect(item).toHaveProperty("totalQuantityRented");
    expect(item).toHaveProperty("totalSpentRub");
  });

  test("tenant isolation: other client's bookings not counted", async () => {
    const { client, cookie } = await makeClientWithSession();
    const otherClient = await prisma.client.create({ data: { name: "Чужой клиент" } });
    const eq1 = await makeEquipment("ISO1");

    // Other client has 5 bookings — should not influence our stats
    for (let i = 0; i < 5; i++) {
      const b = await makeBooking(otherClient.id, "CONFIRMED", `Чужой ${i + 1}`);
      await makeEstimateWithLines(b.id, "MAIN", [
        { equipmentId: eq1.id, name: eq1.name, category: eq1.category, lineSum: "100" },
      ]);
    }

    const res = await request(app)
      .get("/api/lk/stats?period=all")
      .set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.topEquipment).toHaveLength(0);
    expect(res.body.typicalKit).toEqual([]);
    expect(res.body.typicalKitSampleSize).toBe(0);
  });
});
