import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-probe-quoteneg.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-probe";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-probe";
process.env.JWT_SECRET = "test-jwt-secret-probe-min16chars";

let app: Express;
let prisma: any;
let token: string;
let skyId: string;
let apuId: string;

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
  app = (await import("../app")).app;
  prisma = (await import("../prisma")).prisma;
  const { hashPassword, signSession } = await import("../services/auth");
  const hash = await hashPassword("test-pass-123");
  const admin = await prisma.adminUser.create({
    data: { username: "probe_sa", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  token = signSession({ userId: admin.id, username: admin.username, role: "SUPER_ADMIN" });
  await prisma.client.create({ data: { name: "Пробный Гаффер" } });
  const sky = await prisma.equipment.create({
    data: { importKey: "pr-sky", name: "SkyPanel", category: "Свет", totalQuantity: 5, rentalRatePerShift: 25000, stockTrackingMode: "COUNT" },
  });
  skyId = sky.id;
  const apu = await prisma.equipment.create({
    data: { importKey: "pr-apu", name: "Aputure", category: "Свет", totalQuantity: 5, rentalRatePerShift: 12000, stockTrackingMode: "COUNT" },
  });
  apuId = apu.id;
});

afterAll(async () => {
  await prisma.$disconnect();
  for (const s of ["", "-wal", "-shm", "-journal"]) {
    const f = TEST_DB_PATH + s;
    if (fs.existsSync(f)) { try { fs.unlinkSync(f); } catch {} }
  }
});

function AUTH() { return { "X-API-Key": "test-key-1", Authorization: `Bearer ${token}` }; }

describe("probe", () => {
  it("POST /api/bookings/quote с договорной ценой", async () => {
    const res = await request(app).post("/api/bookings/quote").set(AUTH()).send({
      client: { name: "Пробный Гаффер" },
      projectName: "Проба",
      startDate: "2026-09-10T09:00:00.000Z",
      endDate: "2026-09-12T21:00:00.000Z",
      discountPercent: 50,
      skipPartialDay: false,
      items: [
        { equipmentId: skyId, quantity: 2, negotiatedRatePerShift: 18000 },
        { equipmentId: apuId, quantity: 3 },
      ],
    });
    fs.appendFileSync("/tmp/probe-out.json", "QUOTE " + res.status + "\n" + JSON.stringify(res.body, null, 2) + "\n");
    expect(res.status).toBe(200);
  });

  it("POST /api/bookings/draft с договорной ценой", async () => {
    const res = await request(app).post("/api/bookings/draft").set(AUTH()).send({
      client: { name: "Пробный Гаффер" },
      projectName: "Проба2",
      startDate: "2026-09-10T09:00:00.000Z",
      endDate: "2026-09-12T21:00:00.000Z",
      discountPercent: 50,
      items: [{ equipmentId: skyId, quantity: 2, negotiatedRatePerShift: 18000 }],
    });
    fs.appendFileSync("/tmp/probe-out.json", "DRAFT " + res.status + "\n");
    const bid = res.body?.booking?.id;
    if (bid) {
      const items = await prisma.bookingItem.findMany({ where: { bookingId: bid } });
      fs.appendFileSync("/tmp/probe-out.json", "DB ITEMS " + JSON.stringify(items.map((i: any) => ({ eq: i.equipmentId, q: i.quantity, neg: i.negotiatedRatePerShift?.toString?.() ?? i.negotiatedRatePerShift })), null, 2) + "\n");
      const est = await prisma.estimate.findFirst({ where: { bookingId: bid, kind: "MAIN" }, include: { lines: true } });
      fs.appendFileSync("/tmp/probe-out.json", "EST " + JSON.stringify({ subtotal: est?.subtotal?.toString(), disc: est?.discountAmount?.toString(), total: est?.totalAfterDiscount?.toString(), lines: est?.lines?.map((l: any) => ({ n: l.nameSnapshot, up: l.unitPrice?.toString(), ls: l.lineSum?.toString() })) }, null, 2) + "\n");
    }
    expect(res.status).toBe(200);
  });
});
