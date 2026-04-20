/**
 * Integration tests for Gaffer CRM dashboard DTO extensions (Task 1.4).
 * Mirrors gafferContactAggregates.test.ts pattern.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { PrismaClient } from "@prisma/client";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-gaffer-dashboard.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-gaffer-dashboard-key";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.GAFFER_SESSION_SECRET = "gaffer-dashboard-secret-min16chars";
process.env.JWT_SECRET = "test-jwt-secret-dashboard-min16chars";
process.env.BARCODE_SECRET = "test-barcode-secret-dashboard";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-dashboard";

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
    .send({ email: "dashboard-tenant-a@example.com" });
  tokenA = resA.body.token as string;

  const resB = await request(app)
    .post("/api/gaffer/auth/login")
    .send({ email: "dashboard-tenant-b@example.com" });
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

  // If clientDueAt is requested, set it directly via Prisma
  // (the route may not yet expose this field per Task 1.1 dependency)
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

// ─── Seed data ────────────────────────────────────────────────────────────────

/**
 * Seeds 10 projects × 5 members × 3 payments for tenant A.
 * Plus 2 projects for tenant B.
 * Returns known totals for assertion.
 */
async function seedTenantA() {
  // Create contacts for A: 5 team members, 1 client
  const clientId = await createClient(tokenA, "Dashboard Client A");
  const memberIds: string[] = [];
  for (let i = 0; i < 5; i++) {
    const m = await createContact(tokenA, `Team Member A-${i}`, "TEAM_MEMBER");
    memberIds.push(m);
  }

  // 10 projects, each with 5 members and 3 payments
  let totalIn = 0;
  let totalOut = 0;

  for (let p = 0; p < 10; p++) {
    const projectId = await createProject(tokenA, clientId, `Project A-${p}`, {
      clientPlanAmount: "50000",
    });

    // 5 members, each planned 2000
    for (const memberId of memberIds) {
      await addMember(tokenA, projectId, memberId, "2000");
    }

    // 3 payments: 1 IN (10000), 1 IN (5000), 1 OUT to member[0] (1000)
    await createPayment(tokenA, projectId, "IN", "10000");
    await createPayment(tokenA, projectId, "IN", "5000");
    await createPayment(tokenA, projectId, "OUT", "1000", memberIds[0]);

    totalIn += 15000;
    totalOut += 1000;
  }

  return { clientId, memberIds, totalIn, totalOut };
}

async function seedTenantB() {
  const clientId = await createClient(tokenB, "Dashboard Client B");
  const projectId1 = await createProject(tokenB, clientId, "Project B-1", {
    clientPlanAmount: "200000",
  });
  const projectId2 = await createProject(tokenB, clientId, "Project B-2", {
    clientPlanAmount: "300000",
  });
  await createPayment(tokenB, projectId1, "IN", "100000");
  return { clientId, projectId1, projectId2 };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GET /api/gaffer/dashboard — extended DTO (Task 1.4)", () => {
  let seedA: { clientId: string; memberIds: string[]; totalIn: number; totalOut: number };
  let seedB: { clientId: string; projectId1: string; projectId2: string };

  beforeAll(async () => {
    [seedA, seedB] = await Promise.all([seedTenantA(), seedTenantB()]);
  });

  it("dashboard returns HTTP 200 for tenant A", async () => {
    const res = await getA("/api/gaffer/dashboard");
    expect(res.status).toBe(200);
  });

  // ── freeCash formula ──────────────────────────────────────────────────────

  it("kpi.freeCash = totalIn - totalOut across all tenant projects", async () => {
    console.time("dashboard");
    const res = await getA("/api/gaffer/dashboard");
    console.timeEnd("dashboard");
    expect(res.status).toBe(200);
    const { kpi } = res.body;
    // 10 projects × (10000 + 5000 IN) - 10 × 1000 OUT = 150000 - 10000 = 140000
    expect(kpi.freeCash).toBe("140000");
  });

  // ── Tenant isolation ───────────────────────────────────────────────────────

  it("tenant A dashboard does not contain tenant B project data", async () => {
    const resA = await getA("/api/gaffer/dashboard");
    expect(resA.status).toBe(200);
    const dash = resA.body;

    // overdueIncoming rows must all belong to A's projects
    for (const row of dash.overdueIncoming ?? []) {
      expect(row.clientId).not.toBe(seedB.clientId);
    }

    // atRiskProjects must not include B's projects
    for (const row of dash.atRiskProjects ?? []) {
      expect(row.projectId).not.toBe(seedB.projectId1);
      expect(row.projectId).not.toBe(seedB.projectId2);
    }
  });

  it("tenant B freeCash is independent from tenant A", async () => {
    const resB = await getB("/api/gaffer/dashboard");
    expect(resB.status).toBe(200);
    // B has 2 projects: IN 100000 for one, nothing for the other
    expect(resB.body.kpi.freeCash).toBe("100000");
  });

  // ── upcomingObligations ≤ 6 rows, sorted by dueAt asc ────────────────────

  it("upcomingObligations is array with at most 6 rows", async () => {
    const res = await getA("/api/gaffer/dashboard");
    expect(res.status).toBe(200);
    const { upcomingObligations } = res.body;
    expect(Array.isArray(upcomingObligations)).toBe(true);
    expect(upcomingObligations.length).toBeLessThanOrEqual(6);
  });

  it("upcomingObligations rows are sorted by dueAt ascending", async () => {
    // Create a project with upcoming clientDueAt to get rows
    const clientId = await createClient(tokenA, "Due Soon Client");
    const now = new Date();
    const soon1 = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
    const soon2 = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    await createProject(tokenA, clientId, "Due Soon Project 1", {
      clientPlanAmount: "50000",
      clientDueAt: soon1.toISOString(),
    });
    await createProject(tokenA, clientId, "Due Soon Project 2", {
      clientPlanAmount: "50000",
      clientDueAt: soon2.toISOString(),
    });

    const res = await getA("/api/gaffer/dashboard");
    const { upcomingObligations } = res.body;
    // Check sorted
    for (let i = 1; i < upcomingObligations.length; i++) {
      const prev = new Date(upcomingObligations[i - 1].dueAt).getTime();
      const curr = new Date(upcomingObligations[i].dueAt).getTime();
      expect(prev).toBeLessThanOrEqual(curr);
    }
  });

  // ── overdueIncoming: only rows with clientDueAt < now AND remaining > 0 ───

  it("overdueIncoming contains only rows with clientDueAt in the past and remaining > 0", async () => {
    // Create a project with past clientDueAt and no payment (remaining > 0)
    const clientId = await createClient(tokenA, "Overdue Client");
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 30);

    const overdueProjectId = await createProject(
      tokenA,
      clientId,
      "Overdue Project",
      {
        clientPlanAmount: "80000",
        clientDueAt: pastDate.toISOString(),
      },
    );
    // No payments → remaining = 80000

    const res = await getA("/api/gaffer/dashboard");
    expect(res.status).toBe(200);
    const { overdueIncoming } = res.body;
    expect(Array.isArray(overdueIncoming)).toBe(true);

    // The overdue project must appear
    const foundRow = overdueIncoming.find(
      (r: { projectId: string }) => r.projectId === overdueProjectId,
    );
    expect(foundRow).toBeTruthy();
    expect(parseFloat(foundRow.remaining)).toBeGreaterThan(0);
    expect(foundRow.overdueDays).toBeGreaterThan(0);

    // All rows must have positive remaining
    for (const row of overdueIncoming) {
      expect(parseFloat(row.remaining)).toBeGreaterThan(0);
      expect(row.overdueDays).toBeGreaterThan(0);
    }
  });

  // ── New KPI fields exist ───────────────────────────────────────────────────

  it("kpi contains all required extended fields", async () => {
    const res = await getA("/api/gaffer/dashboard");
    const { kpi } = res.body;
    expect(kpi).toHaveProperty("overdueIncomingSum");
    expect(kpi).toHaveProperty("dueSoonIncomingSum");
    expect(kpi).toHaveProperty("dueSoonOutgoingSum");
    expect(kpi).toHaveProperty("freeCash");
    expect(kpi).toHaveProperty("cashGap14d");
    expect(kpi).toHaveProperty("openObligationCount");
    expect(kpi).toHaveProperty("overdueProjectCount");
  });

  it("existing kpi fields are preserved (backward compat)", async () => {
    const res = await getA("/api/gaffer/dashboard");
    const { kpi } = res.body;
    expect(kpi).toHaveProperty("owedToMe");
    expect(kpi).toHaveProperty("iOwe");
    expect(kpi).toHaveProperty("owedToMeProjectCount");
    expect(kpi).toHaveProperty("owedToMeClientCount");
    expect(kpi).toHaveProperty("iOweProjectCount");
    expect(kpi).toHaveProperty("iOweMemberCount");
    expect(kpi).toHaveProperty("iOweVendorCount");
  });

  it("dashboard response includes atRiskProjects, debtStructure, overdueIncoming, upcomingObligations", async () => {
    const res = await getA("/api/gaffer/dashboard");
    expect(res.body).toHaveProperty("atRiskProjects");
    expect(res.body).toHaveProperty("debtStructure");
    expect(res.body).toHaveProperty("overdueIncoming");
    expect(res.body).toHaveProperty("upcomingObligations");
    expect(Array.isArray(res.body.atRiskProjects)).toBe(true);
    expect(res.body.atRiskProjects.length).toBeLessThanOrEqual(4);
  });

  it("debtStructure contains required fields", async () => {
    const res = await getA("/api/gaffer/dashboard");
    const { debtStructure } = res.body;
    expect(debtStructure).toHaveProperty("vendorOutSum");
    expect(debtStructure).toHaveProperty("teamOutSum");
    expect(debtStructure).toHaveProperty("closedProjectCount");
    expect(debtStructure).toHaveProperty("inProgressProjectCount");
    expect(debtStructure).toHaveProperty("overdueProjectCount");
  });

  it("existing top-level fields are preserved (backward compat)", async () => {
    const res = await getA("/api/gaffer/dashboard");
    expect(res.body).toHaveProperty("clientsWithDebt");
    expect(res.body).toHaveProperty("teamWithDebt");
    expect(res.body).toHaveProperty("vendorsWithDebt");
    expect(res.body).toHaveProperty("meta");
  });

  // ── openObligationCount is a number ───────────────────────────────────────

  it("kpi.openObligationCount is a non-negative integer", async () => {
    const res = await getA("/api/gaffer/dashboard");
    const { openObligationCount } = res.body.kpi;
    expect(typeof openObligationCount).toBe("number");
    expect(openObligationCount).toBeGreaterThanOrEqual(0);
  });

  // ── cashGap14d formula check ──────────────────────────────────────────────

  it("kpi.cashGap14d = freeCash + dueSoonIncomingSum - dueSoonOutgoingSum", async () => {
    const res = await getA("/api/gaffer/dashboard");
    const { freeCash, dueSoonIncomingSum, dueSoonOutgoingSum, cashGap14d } = res.body.kpi;
    const expected =
      parseFloat(freeCash) + parseFloat(dueSoonIncomingSum) - parseFloat(dueSoonOutgoingSum);
    expect(parseFloat(cashGap14d)).toBeCloseTo(expected, 2);
  });
});
