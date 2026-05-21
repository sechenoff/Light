import path from "path";
import { execSync } from "child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-addon-routes.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-addon-routes";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-addon-routes";
process.env.WAREHOUSE_SECRET = "test-warehouse-addon-routes-16";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-addon-routes-min16chars";

let app: any;
let prisma: any;
let bookingWithAddonId: string;
let bookingWithoutAddonId: string;
let superAdminToken: string;

function AUTH() {
  return { Authorization: `Bearer ${superAdminToken}` };
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
  const { app: expressApp } = await import("../app");
  app = expressApp;

  const { hashPassword, signSession } = await import("../services/auth");
  const passwordHash = await hashPassword("test-pass-addon-routes");
  const admin = await prisma.adminUser.create({
    data: { username: "addon_routes_super_admin", passwordHash, role: "SUPER_ADMIN" },
  });
  superAdminToken = signSession({ userId: admin.id, username: admin.username, role: "SUPER_ADMIN" });

  const client = await prisma.client.create({
    data: { name: "Routes test", phone: "+70000000777" },
  });

  // Booking with both MAIN and ADDON estimates
  const b1 = await prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: "Has addon",
      startDate: new Date(),
      endDate: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
      status: "ISSUED",
    },
  });
  bookingWithAddonId = b1.id;
  await prisma.estimate.create({
    data: {
      bookingId: b1.id,
      kind: "MAIN",
      shifts: 2,
      subtotal: "10000",
      discountPercent: "50",
      discountAmount: "5000",
      totalAfterDiscount: "5000",
    },
  });
  await prisma.estimate.create({
    data: {
      bookingId: b1.id,
      kind: "ADDON",
      shifts: 2,
      subtotal: "2000",
      discountPercent: "50",
      discountAmount: "1000",
      totalAfterDiscount: "1000",
      lines: {
        create: [
          {
            equipmentId: null,
            categorySnapshot: "Электрика",
            nameSnapshot: "Vmount",
            quantity: 1,
            unitPrice: "1000",
            lineSum: "2000",
          },
        ],
      },
    },
  });

  // Booking without ADDON
  const b2 = await prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: "No addon",
      startDate: new Date(),
      endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
      status: "ISSUED",
    },
  });
  bookingWithoutAddonId = b2.id;
  await prisma.estimate.create({
    data: {
      bookingId: b2.id,
      kind: "MAIN",
      shifts: 1,
      subtotal: "5000",
      discountPercent: null,
      discountAmount: "0",
      totalAfterDiscount: "5000",
    },
  });
});

afterAll(async () => {
  await prisma?.$disconnect?.();
});

describe("GET /api/addon-estimates/:bookingId", () => {
  it("returns ADDON estimate JSON if present", async () => {
    const res = await request(app)
      .get(`/api/addon-estimates/${bookingWithAddonId}`)
      .set(AUTH());
    expect(res.status).toBe(200);
    expect(res.body.addon).toBeTruthy();
    expect(res.body.addon.kind).toBe("ADDON");
    expect(res.body.addon.totalAfterDiscount).toBe("1000");
    expect(res.body.addon.lines).toHaveLength(1);
  });

  it("returns null if no ADDON estimate", async () => {
    const res = await request(app)
      .get(`/api/addon-estimates/${bookingWithoutAddonId}`)
      .set(AUTH());
    expect(res.status).toBe(200);
    expect(res.body.addon).toBeNull();
  });
});

describe("GET /api/addon-estimates/:bookingId/export/pdf", () => {
  it("returns PDF if ADDON exists", async () => {
    const res = await request(app)
      .get(`/api/addon-estimates/${bookingWithAddonId}/export/pdf`)
      .set(AUTH());
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
  });

  it("404 if no ADDON", async () => {
    const res = await request(app)
      .get(`/api/addon-estimates/${bookingWithoutAddonId}/export/pdf`)
      .set(AUTH());
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("ADDON_ESTIMATE_NOT_FOUND");
  });
});

describe("GET /api/addon-estimates/:bookingId/export/xlsx", () => {
  it("returns XLSX if ADDON exists", async () => {
    const res = await request(app)
      .get(`/api/addon-estimates/${bookingWithAddonId}/export/xlsx`)
      .set(AUTH());
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("spreadsheetml");
  });
});
