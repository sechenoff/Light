import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

// Set env vars at module level — vitest processes this before module resolution
// because `setupFiles` in vitest.config.ts will ensure this file runs first.
// But to be safe, we re-set them here too.
const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1,test-key-2";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";

let app: Express;

beforeAll(async () => {
  // Initialize DB schema
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../.."),
    env: {
      ...process.env,
      DATABASE_URL: `file:${TEST_DB_PATH}`,
      PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes",
    },
    stdio: "pipe",
  });

  // Dynamically import app AFTER env vars are set and DB is initialized
  const mod = await import("../app");
  app = mod.app;
});

afterAll(async () => {
  // Disconnect Prisma to release DB handles and prevent process hang
  const { prisma } = await import("../prisma");
  await prisma.$disconnect();

  // Clean up test DB and WAL sidecar files
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = TEST_DB_PATH + suffix;
    if (fs.existsSync(f)) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }
});

const API_KEY = "test-key-1";
const AUTH = { "X-API-Key": API_KEY };

describe("Auth middleware", () => {
  it("returns 401 without API key", async () => {
    const res = await request(app).get("/api/equipment");
    expect(res.status).toBe(401);
  });

  it("returns 200 with valid X-API-Key", async () => {
    const res = await request(app).get("/api/equipment").set("X-API-Key", "test-key-1");
    expect(res.status).toBe(200);
  });

  it("returns 401 with wrong API key", async () => {
    const res = await request(app).get("/api/equipment").set("X-API-Key", "wrong-key");
    expect(res.status).toBe(401);
  });
});

describe("Health", () => {
  it("GET /health returns 200 without auth", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
  });
});

describe("Equipment", () => {
  it("GET /api/equipment returns 200", async () => {
    const res = await request(app).get("/api/equipment").set(AUTH);
    expect(res.status).toBe(200);
  });
});

describe("Availability", () => {
  it("GET /api/availability with date params returns 200", async () => {
    const res = await request(app)
      .get("/api/availability?start=2026-04-10&end=2026-04-12")
      .set(AUTH);
    expect(res.status).toBe(200);
  });
});

describe("Bookings", () => {
  it("POST /api/bookings/draft without required fields returns 400 (Zod validation)", async () => {
    const res = await request(app)
      .post("/api/bookings/draft")
      .set(AUTH)
      .send({});
    expect(res.status).toBe(400);
  });

  it("GET /api/bookings returns 200", async () => {
    const res = await request(app).get("/api/bookings").set(AUTH);
    expect(res.status).toBe(200);
  });
});

describe("Estimates", () => {
  it("GET /api/estimates/:id returns 404 for non-existent id", async () => {
    const res = await request(app).get("/api/estimates/nonexistent-id").set(AUTH);
    expect(res.status).toBe(404);
  });
});

describe("Pricelist", () => {
  it("GET /api/pricelist returns 200 or 404 (not 500)", async () => {
    const res = await request(app).get("/api/pricelist").set(AUTH);
    expect([200, 404]).toContain(res.status);
  });
});

describe("Finance", () => {
  it("GET /api/finance/dashboard returns 200", async () => {
    const res = await request(app).get("/api/finance/dashboard").set(AUTH);
    expect(res.status).toBe(200);
  });
});

describe("Users", () => {
  it("POST /api/users/upsert with valid body returns 200", async () => {
    const res = await request(app)
      .post("/api/users/upsert")
      .set(AUTH)
      .send({ telegramId: "12345", firstName: "Test" });
    expect(res.status).toBe(200);
    expect(res.body.user).toBeDefined();
  });
});

describe("Analyses", () => {
  it("POST /api/analyses/pending round trip: create user then create analysis", async () => {
    // First create a user to satisfy the foreign key constraint
    const userRes = await request(app)
      .post("/api/users/upsert")
      .set(AUTH)
      .send({ telegramId: "99999", firstName: "AnalysisTest" });
    expect(userRes.status).toBe(200);
    const userId = userRes.body.user.id;

    const res = await request(app)
      .post("/api/analyses/pending")
      .set(AUTH)
      .send({
        userId,
        telegramFileId: "file-abc123",
        telegramMimeType: "image/jpeg",
      });
    expect(res.status).toBe(201);
    expect(res.body.analysis).toBeDefined();
  });
});

describe("Equipment Import", () => {
  it("POST /api/equipment/import/preview without file returns 400", async () => {
    const res = await request(app).post("/api/equipment/import/preview").set(AUTH);
    expect(res.status).toBe(400);
  });
});

describe("Booking Parser", () => {
  it("POST /api/bookings/parse-gaffer-review without body returns 400", async () => {
    const res = await request(app)
      .post("/api/bookings/parse-gaffer-review")
      .set(AUTH)
      .send({});
    expect(res.status).toBe(400);
  });
});

describe("Slang Learning", () => {
  it("GET /api/admin/slang-learning returns 200", async () => {
    const res = await request(app)
      .get("/api/admin/slang-learning")
      .set(AUTH);
    expect(res.status).toBe(200);
  });
});

describe("Photo Analysis", () => {
  it("POST /api/photo-analysis without file returns 400", async () => {
    const res = await request(app).post("/api/photo-analysis").set(AUTH);
    expect(res.status).toBe(400);
  });
});
