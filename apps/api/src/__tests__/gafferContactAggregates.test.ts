/**
 * Интеграционные тесты Gaffer CRM contact debt-summary endpoint.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-gaffer-aggregates.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-gaffer-aggregates-key";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.GAFFER_SESSION_SECRET = "gaffer-aggregates-secret-min16chars";
process.env.JWT_SECRET = "test-jwt-secret-aggregates-min16chars";
process.env.BARCODE_SECRET = "test-barcode-secret-aggregates";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-aggregates";

let app: Express;
let tokenA: string;

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

  const resA = await request(app)
    .post("/api/gaffer/auth/login")
    .send({ email: "tenant-a@example.com" });
  tokenA = resA.body.token as string;
});

afterAll(async () => {
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
function postA(url: string) {
  return request(app).post(url).set("Authorization", `Bearer ${tokenA}`);
}

async function createClientA(name: string) {
  const res = await postA("/api/gaffer/contacts").send({ type: "CLIENT", name });
  expect(res.status).toBe(200);
  return res.body.contact.id as string;
}

async function createMemberA(name: string) {
  const res = await postA("/api/gaffer/contacts").send({ type: "TEAM_MEMBER", name });
  expect(res.status).toBe(200);
  return res.body.contact.id as string;
}

async function createProject(clientId: string, title: string, clientPlanAmount = "100000") {
  const res = await postA("/api/gaffer/projects").send({
    title,
    clientId,
    shootDate: "2025-09-01",
    clientPlanAmount,
  });
  expect(res.status).toBe(200);
  return res.body.project.id as string;
}

// ─── Client debt summary ──────────────────────────────────────────────────────

describe("GET /contacts/:id/debt-summary — CLIENT", () => {
  let clientId: string;
  let project1Id: string;
  let project2Id: string;

  beforeAll(async () => {
    clientId = await createClientA("Клиент долг-сводка");

    project1Id = await createProject(clientId, "Проект 1", "80000");
    project2Id = await createProject(clientId, "Проект 2", "120000");

    // IN-платёж для проекта 1
    await postA("/api/gaffer/payments").send({
      projectId: project1Id,
      direction: "IN",
      amount: "30000",
      paidAt: "2025-09-10",
    });

    // IN-платёж для проекта 2 (частичная оплата)
    await postA("/api/gaffer/payments").send({
      projectId: project2Id,
      direction: "IN",
      amount: "60000",
      paidAt: "2025-09-12",
    });
  });

  it("GET /contacts/:id/debt-summary возвращает список проектов клиента", async () => {
    const res = await getA(`/api/gaffer/contacts/${clientId}/debt-summary`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.projects)).toBe(true);
    expect(res.body.projects.length).toBeGreaterThanOrEqual(2);
  });

  it("Каждый проект содержит clientRemaining", async () => {
    const res = await getA(`/api/gaffer/contacts/${clientId}/debt-summary`);
    for (const p of res.body.projects) {
      expect(p).toHaveProperty("clientRemaining");
    }
  });

  it("Суммарный clientRemaining = сумма по всем проектам", async () => {
    const res = await getA(`/api/gaffer/contacts/${clientId}/debt-summary`);
    expect(res.body).toHaveProperty("totalClientRemaining");
    // project1: 80000 - 30000 = 50000, project2: 120000 - 60000 = 60000 → total = 110000
    expect(res.body.totalClientRemaining).toBe("110000");
  });

  it("clientReceived для проекта 1 = 30000", async () => {
    const res = await getA(`/api/gaffer/contacts/${clientId}/debt-summary`);
    const p1 = res.body.projects.find(
      (p: Record<string, unknown>) => p.id === project1Id,
    );
    expect(p1).toBeTruthy();
    expect(p1.clientReceived).toBe("30000");
  });
});

describe("GET /contacts/:id/debt-summary — CLIENT пустые проекты", () => {
  it("Клиент без проектов → пустой список, total=0", async () => {
    const clientId = await createClientA("Клиент без проектов");
    const res = await getA(`/api/gaffer/contacts/${clientId}/debt-summary`);
    expect(res.status).toBe(200);
    expect(res.body.projects).toHaveLength(0);
    expect(res.body.totalClientRemaining).toBe("0");
  });
});

// ─── Member paid summary ──────────────────────────────────────────────────────

describe("GET /contacts/:id/debt-summary — TEAM_MEMBER", () => {
  let memberId: string;
  let project1Id: string;
  let project2Id: string;

  beforeAll(async () => {
    const clientId1 = await createClientA("Клиент для техника 1");
    const clientId2 = await createClientA("Клиент для техника 2");
    memberId = await createMemberA("Техник долг-сводка");

    project1Id = await createProject(clientId1, "Проект техника 1", "50000");
    project2Id = await createProject(clientId2, "Проект техника 2", "80000");

    // Добавляем участника в оба проекта
    await postA(`/api/gaffer/projects/${project1Id}/members`).send({
      contactId: memberId,
      plannedAmount: "20000",
      roleLabel: "осветитель",
    });
    await postA(`/api/gaffer/projects/${project2Id}/members`).send({
      contactId: memberId,
      plannedAmount: "35000",
      roleLabel: "гафер",
    });

    // OUT-платёж для участника в проекте 1
    await postA("/api/gaffer/payments").send({
      projectId: project1Id,
      direction: "OUT",
      amount: "10000",
      paidAt: "2025-10-01",
      memberId,
    });

    // OUT-платёж для участника в проекте 2 (частичная)
    await postA("/api/gaffer/payments").send({
      projectId: project2Id,
      direction: "OUT",
      amount: "15000",
      paidAt: "2025-10-05",
      memberId,
    });
  });

  it("GET /contacts/:id/debt-summary возвращает членства участника", async () => {
    const res = await getA(`/api/gaffer/contacts/${memberId}/debt-summary`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.memberships)).toBe(true);
    expect(res.body.memberships.length).toBeGreaterThanOrEqual(2);
  });

  it("Каждое членство содержит plannedAmount, paidToMe, remaining", async () => {
    const res = await getA(`/api/gaffer/contacts/${memberId}/debt-summary`);
    for (const m of res.body.memberships) {
      expect(m).toHaveProperty("plannedAmount");
      expect(m).toHaveProperty("paidToMe");
      expect(m).toHaveProperty("remaining");
    }
  });

  it("Суммарный totalRemaining = сумма остатков по членствам", async () => {
    const res = await getA(`/api/gaffer/contacts/${memberId}/debt-summary`);
    expect(res.body).toHaveProperty("totalRemaining");
    // m1: 20000 - 10000 = 10000; m2: 35000 - 15000 = 20000 → 30000
    expect(res.body.totalRemaining).toBe("30000");
  });

  it("paidToMe для проекта 1 = 10000", async () => {
    const res = await getA(`/api/gaffer/contacts/${memberId}/debt-summary`);
    const m1 = res.body.memberships.find(
      (m: Record<string, unknown>) => m.projectId === project1Id,
    );
    expect(m1).toBeTruthy();
    expect(m1.paidToMe).toBe("10000");
  });
});

describe("GET /contacts/:id/debt-summary — TEAM_MEMBER без членств", () => {
  it("Техник без проектов → пустой список, total=0", async () => {
    const memberId = await createMemberA("Техник без проектов");
    const res = await getA(`/api/gaffer/contacts/${memberId}/debt-summary`);
    expect(res.status).toBe(200);
    expect(res.body.memberships).toHaveLength(0);
    expect(res.body.totalRemaining).toBe("0");
  });
});

// ─── Ошибки ───────────────────────────────────────────────────────────────────

describe("GET /contacts/:id/debt-summary — ошибки", () => {
  it("Несуществующий контакт → 404", async () => {
    const res = await getA("/api/gaffer/contacts/nonexistent-id/debt-summary");
    expect(res.status).toBe(404);
  });
});
