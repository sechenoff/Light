/**
 * Integration tests for Gaffer CRM obligations endpoint (Task 3.1).
 * Mirrors gafferDashboard.test.ts pattern.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { PrismaClient } from "@prisma/client";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-gaffer-obligations.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-gaffer-obligations-key";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.GAFFER_SESSION_SECRET = "gaffer-obligations-secret-min16chars";
process.env.JWT_SECRET = "test-jwt-secret-obligations-min16chars";
process.env.BARCODE_SECRET = "test-barcode-secret-obligations";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-obligations";

let app: Express;
let tokenA: string;
let tokenB: string;
let testPrisma: PrismaClient;

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

  const mod = await import("../app");
  app = mod.app;

  testPrisma = new PrismaClient({
    datasources: { db: { url: `file:${TEST_DB_PATH}` } },
  });

  const resA = await request(app)
    .post("/api/gaffer/auth/login")
    .send({ email: "obligations-tenant-a@example.com" });
  tokenA = resA.body.token as string;

  const resB = await request(app)
    .post("/api/gaffer/auth/login")
    .send({ email: "obligations-tenant-b@example.com" });
  tokenB = resB.body.token as string;
}, 60_000);

afterAll(async () => {
  await testPrisma.$disconnect();
  const { prisma } = await import("../prisma");
  await prisma.$disconnect();
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = TEST_DB_PATH + suffix;
    if (fs.existsSync(f)) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }
});

// ─── helpers ──────────────────────────────────────────────────────────────────

function getA(url: string) {
  return request(app).get(url).set("Authorization", `Bearer ${tokenA}`);
}
function getB(url: string) {
  return request(app).get(url).set("Authorization", `Bearer ${tokenB}`);
}
function postAs(token: string, url: string) {
  return request(app).post(url).set("Authorization", `Bearer ${token}`);
}

async function createClient(token: string, name: string) {
  const res = await postAs(token, "/api/gaffer/contacts").send({ type: "CLIENT", name });
  expect(res.status).toBe(200);
  return res.body.contact.id as string;
}

async function createContact(token: string, name: string, type: string) {
  const res = await postAs(token, "/api/gaffer/contacts").send({ type, name });
  expect(res.status).toBe(200);
  return res.body.contact.id as string;
}

async function createProject(
  token: string,
  clientId: string,
  title: string,
  opts: { clientPlanAmount?: string; clientDueAt?: string } = {},
) {
  const res = await postAs(token, "/api/gaffer/projects").send({
    title,
    clientId,
    shootDate: "2025-09-01",
    clientPlanAmount: opts.clientPlanAmount ?? "100000",
  });
  expect(res.status).toBe(200);
  const projectId = res.body.project.id as string;

  if (opts.clientDueAt) {
    await testPrisma.gafferProject.update({
      where: { id: projectId },
      data: { clientDueAt: new Date(opts.clientDueAt) },
    });
  }

  return projectId;
}

async function addMember(
  token: string,
  projectId: string,
  contactId: string,
  plannedAmount: string,
  dueAt?: string,
) {
  const res = await postAs(token, `/api/gaffer/projects/${projectId}/members`).send({
    contactId,
    plannedAmount,
    ...(dueAt ? { dueAt } : {}),
  });
  expect(res.status).toBe(200);
  return res.body.member;
}

async function createPayment(
  token: string,
  projectId: string,
  direction: "IN" | "OUT",
  amount: string,
  memberId?: string,
) {
  const res = await postAs(token, "/api/gaffer/payments").send({
    projectId,
    direction,
    amount,
    paidAt: "2025-09-10",
    ...(memberId ? { memberId } : {}),
  });
  expect(res.status).toBe(200);
  return res.body.payment;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GET /api/gaffer/obligations", () => {
  // ── Test 1: Unauthenticated → 401 ─────────────────────────────────────────

  it("1. unauthenticated request returns 401", async () => {
    const res = await request(app).get("/api/gaffer/obligations");
    expect(res.status).toBe(401);
  });

  // ── Test 2: Empty state ────────────────────────────────────────────────────

  it("2. user with no projects returns { items: [] }", async () => {
    const res = await getA("/api/gaffer/obligations");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("items");
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items).toHaveLength(0);
  });

  // ── Test 3: Mixed seed — 3 items ──────────────────────────────────────────

  describe("mixed seed (1 project, 1 client, 1 TEAM_MEMBER, 1 VENDOR)", () => {
    let projectId: string;
    let clientId: string;
    let memberId: string;
    let vendorId: string;

    beforeAll(async () => {
      clientId = await createClient(tokenA, "Client Obligations Test");
      memberId = await createContact(tokenA, "Team Member Obligations", "TEAM_MEMBER");
      vendorId = await createContact(tokenA, "Vendor Obligations", "VENDOR");

      projectId = await createProject(tokenA, clientId, "Mixed Obligations Project", {
        clientPlanAmount: "100000",
      });

      await addMember(tokenA, projectId, memberId, "20000");
      await addMember(tokenA, projectId, vendorId, "30000");

      // 1 IN payment of 50000
      await createPayment(tokenA, projectId, "IN", "50000");
      // 1 OUT to member of 10000
      await createPayment(tokenA, projectId, "OUT", "10000", memberId);
    });

    it("3a. returns 3 items: 1 client, 1 crew, 1 rental", async () => {
      const res = await getA("/api/gaffer/obligations");
      expect(res.status).toBe(200);
      const items = res.body.items as Array<{ category: string }>;
      expect(items).toHaveLength(3);
      const categories = items.map((i) => i.category).sort();
      expect(categories).toEqual(["client", "crew", "rental"]);
    });

    it("3b. IN row: sum=100000, paid=50000, remaining=50000, status=partial", async () => {
      const res = await getA("/api/gaffer/obligations");
      expect(res.status).toBe(200);
      const inRow = (res.body.items as Array<Record<string, unknown>>).find(
        (i) => i.category === "client",
      );
      expect(inRow).toBeTruthy();
      expect(inRow!.direction).toBe("IN");
      expect(inRow!.sum).toBe("100000");
      expect(inRow!.paid).toBe("50000");
      expect(inRow!.remaining).toBe("50000");
      expect(inRow!.status).toBe("partial");
    });

    it("3c. crew row: sum=20000, paid=10000, remaining=10000, status=partial", async () => {
      const res = await getA("/api/gaffer/obligations");
      const crewRow = (res.body.items as Array<Record<string, unknown>>).find(
        (i) => i.category === "crew",
      );
      expect(crewRow).toBeTruthy();
      expect(crewRow!.direction).toBe("OUT");
      expect(crewRow!.sum).toBe("20000");
      expect(crewRow!.paid).toBe("10000");
      expect(crewRow!.remaining).toBe("10000");
      expect(crewRow!.status).toBe("partial");
    });

    it("3d. rental row: sum=30000, paid=0, remaining=30000, status=open", async () => {
      const res = await getA("/api/gaffer/obligations");
      const rentalRow = (res.body.items as Array<Record<string, unknown>>).find(
        (i) => i.category === "rental",
      );
      expect(rentalRow).toBeTruthy();
      expect(rentalRow!.direction).toBe("OUT");
      expect(rentalRow!.sum).toBe("30000");
      expect(rentalRow!.paid).toBe("0");
      expect(rentalRow!.remaining).toBe("30000");
      expect(rentalRow!.status).toBe("open");
    });

    // ── Test 4: Filter direction=IN ──────────────────────────────────────────

    it("4. filter direction=IN returns only client rows", async () => {
      const res = await getA("/api/gaffer/obligations?direction=IN");
      expect(res.status).toBe(200);
      const items = res.body.items as Array<{ direction: string; category: string }>;
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        expect(item.direction).toBe("IN");
        expect(item.category).toBe("client");
      }
    });

    // ── Test 5: Filter direction=OUT ─────────────────────────────────────────

    it("5. filter direction=OUT returns only crew+rental rows", async () => {
      const res = await getA("/api/gaffer/obligations?direction=OUT");
      expect(res.status).toBe(200);
      const items = res.body.items as Array<{ direction: string; category: string }>;
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        expect(item.direction).toBe("OUT");
        expect(["crew", "rental"]).toContain(item.category);
      }
    });

    // ── Test 6: Filter category=rental ──────────────────────────────────────

    it("6. filter category=rental returns only VENDOR rows", async () => {
      const res = await getA("/api/gaffer/obligations?category=rental");
      expect(res.status).toBe(200);
      const items = res.body.items as Array<{ category: string }>;
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        expect(item.category).toBe("rental");
      }
    });

    // ── Test 8: Filter status=active ─────────────────────────────────────────

    it("8. filter status=active returns everything except paid", async () => {
      const res = await getA("/api/gaffer/obligations?status=active");
      expect(res.status).toBe(200);
      const items = res.body.items as Array<{ status: string }>;
      for (const item of items) {
        expect(item.status).not.toBe("paid");
      }
    });

    // ── Test 9: Fully-paid obligation ────────────────────────────────────────

    it("9. fully-paid IN obligation has status=paid and remaining=0", async () => {
      // Create a new project where plan=50000 and payment=50000
      const paidClientId = await createClient(tokenA, "Paid Client Test");
      const paidProjectId = await createProject(tokenA, paidClientId, "Paid Project", {
        clientPlanAmount: "50000",
      });
      await createPayment(tokenA, paidProjectId, "IN", "50000");

      const res = await getA("/api/gaffer/obligations");
      const items = res.body.items as Array<{
        projectId: string;
        status: string;
        remaining: string;
      }>;
      const paidRow = items.find(
        (i) => i.projectId === paidProjectId && i.remaining === "0",
      );
      expect(paidRow).toBeTruthy();
      expect(paidRow!.status).toBe("paid");
    });

    // ── Test 10: Tenant isolation ─────────────────────────────────────────────

    it("10. tenant isolation: user A cannot see user B's obligations", async () => {
      // Create user B's data
      const bClientId = await createClient(tokenB, "Client B Obligations");
      const bProjectId = await createProject(tokenB, bClientId, "Project B Obligations", {
        clientPlanAmount: "999000",
      });

      const resA = await getA("/api/gaffer/obligations");
      const resB = await getB("/api/gaffer/obligations");

      const aItems = resA.body.items as Array<{ projectId: string }>;
      const bItems = resB.body.items as Array<{ projectId: string }>;

      // A should not see B's project
      expect(aItems.find((i) => i.projectId === bProjectId)).toBeUndefined();
      // B should see their own
      expect(bItems.find((i) => i.projectId === bProjectId)).toBeTruthy();
    });
  });

  // ── Test 7: Filter status=overdue ─────────────────────────────────────────

  it("7. filter status=overdue: overdue rows have overdueDays>0; others filtered out", async () => {
    const clientId = await createClient(tokenA, "Overdue Client Obligations");
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 10);

    const overdueProjectId = await createProject(
      tokenA,
      clientId,
      "Overdue Obligations Project",
      {
        clientPlanAmount: "80000",
        clientDueAt: pastDate.toISOString(),
      },
    );
    // No payment → remaining > 0 → overdue

    const res = await getA("/api/gaffer/obligations?status=overdue");
    expect(res.status).toBe(200);
    const items = res.body.items as Array<{
      status: string;
      overdueDays: number | null;
      projectId: string;
    }>;

    // All returned items must have status=overdue
    for (const item of items) {
      expect(item.status).toBe("overdue");
    }

    // The seeded overdue project must appear
    const found = items.find((i) => i.projectId === overdueProjectId);
    expect(found).toBeTruthy();
    expect(found!.overdueDays).not.toBeNull();
    expect(found!.overdueDays!).toBeGreaterThan(0);
  });

  // ── Test 11: Sort dueAt ascending with null handling ──────────────────────

  it("11. sort=dueAt: nulls sort last, earlier dates come first", async () => {
    const clientId = await createClient(tokenA, "Sort Client Obligations");

    const soon1Date = new Date();
    soon1Date.setDate(soon1Date.getDate() + 5);
    const soon2Date = new Date();
    soon2Date.setDate(soon2Date.getDate() + 15);

    // Project with dueAt = soon1 (5 days from now)
    await createProject(tokenA, clientId, "Sort Project 1", {
      clientPlanAmount: "10000",
      clientDueAt: soon1Date.toISOString(),
    });

    // Project with dueAt = soon2 (15 days from now)
    await createProject(tokenA, clientId, "Sort Project 2", {
      clientPlanAmount: "10000",
      clientDueAt: soon2Date.toISOString(),
    });

    // Project with no dueAt (null)
    await createProject(tokenA, clientId, "Sort Project 3 (no due)", {
      clientPlanAmount: "10000",
    });

    const res = await getA("/api/gaffer/obligations?sort=dueAt");
    expect(res.status).toBe(200);
    const items = res.body.items as Array<{ dueAt: string | null }>;

    // Find indices of null dueAt items
    const nonNullItems = items.filter((i) => i.dueAt !== null);
    const nullItems = items.filter((i) => i.dueAt === null);

    // Null items should all come after non-null items that are sorted
    // (all non-null dueAt items should appear before null ones)
    if (nonNullItems.length > 0 && nullItems.length > 0) {
      const lastNonNullIdx = items.findLastIndex((i) => i.dueAt !== null);
      const firstNullIdx = items.findIndex((i) => i.dueAt === null);
      expect(firstNullIdx).toBeGreaterThan(lastNonNullIdx);
    }

    // Non-null items must be sorted ascending
    for (let i = 1; i < nonNullItems.length; i++) {
      const prev = new Date(nonNullItems[i - 1].dueAt!).getTime();
      const curr = new Date(nonNullItems[i].dueAt!).getTime();
      expect(prev).toBeLessThanOrEqual(curr);
    }
  });

  // ── Test 12: Perf smoke ───────────────────────────────────────────────────

  it("12. perf smoke: 10 projects × 5 members × 3 payments responds in <500ms", async () => {
    const clientId = await createClient(tokenA, "Perf Client Obligations");
    const memberIds: string[] = [];
    const vendorIds: string[] = [];

    // 3 TEAM_MEMBER + 2 VENDOR contacts
    for (let i = 0; i < 3; i++) {
      const m = await createContact(tokenA, `Perf Team Member ${i}`, "TEAM_MEMBER");
      memberIds.push(m);
    }
    for (let i = 0; i < 2; i++) {
      const v = await createContact(tokenA, `Perf Vendor ${i}`, "VENDOR");
      vendorIds.push(v);
    }
    const allMembers = [...memberIds, ...vendorIds]; // 5 total

    for (let p = 0; p < 10; p++) {
      const projectId = await createProject(tokenA, clientId, `Perf Project ${p}`, {
        clientPlanAmount: "50000",
      });

      // 5 members
      for (const mId of allMembers) {
        await addMember(tokenA, projectId, mId, "2000");
      }

      // 3 payments per project (1 IN, 1 IN, 1 OUT)
      await createPayment(tokenA, projectId, "IN", "10000");
      await createPayment(tokenA, projectId, "IN", "5000");
      await createPayment(tokenA, projectId, "OUT", "1000", memberIds[0]);
    }

    const start = Date.now();
    const res = await getA("/api/gaffer/obligations");
    const duration = Date.now() - start;

    expect(res.status).toBe(200);
    console.log(`[perf] obligations endpoint: ${duration}ms`);
    expect(duration).toBeLessThan(500);
  }, 120_000);
});
