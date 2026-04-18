/**
 * Интеграционные тесты Gaffer CRM project members API.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-gaffer-members.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-gaffer-members-key";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.GAFFER_SESSION_SECRET = "gaffer-members-secret-min16chars-ok";
process.env.JWT_SECRET = "test-jwt-secret-members-min16chars";
process.env.BARCODE_SECRET = "test-barcode-secret-members";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-members";

let app: Express;
let tokenA: string;
let tokenB: string;

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

  const resB = await request(app)
    .post("/api/gaffer/auth/login")
    .send({ email: "tenant-b@example.com" });
  tokenB = resB.body.token as string;
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

function postA(url: string) {
  return request(app).post(url).set("Authorization", `Bearer ${tokenA}`);
}
function patchA(url: string) {
  return request(app).patch(url).set("Authorization", `Bearer ${tokenA}`);
}
function deleteA(url: string) {
  return request(app).delete(url).set("Authorization", `Bearer ${tokenA}`);
}
function postB(url: string) {
  return request(app).post(url).set("Authorization", `Bearer ${tokenB}`);
}
function patchB(url: string) {
  return request(app).patch(url).set("Authorization", `Bearer ${tokenB}`);
}
function deleteB(url: string) {
  return request(app).delete(url).set("Authorization", `Bearer ${tokenB}`);
}

async function createClientA(name = "Клиент") {
  const res = await postA("/api/gaffer/contacts").send({ type: "CLIENT", name });
  expect(res.status).toBe(200);
  return res.body.contact.id as string;
}

async function createMemberA(name = "Техник") {
  const res = await postA("/api/gaffer/contacts").send({ type: "TEAM_MEMBER", name });
  expect(res.status).toBe(200);
  return res.body.contact.id as string;
}

async function createProjectA(clientId: string, title = "Проект") {
  const res = await postA("/api/gaffer/projects").send({
    title,
    clientId,
    shootDate: "2025-08-01",
    clientPlanAmount: "50000",
  });
  expect(res.status).toBe(200);
  return res.body.project.id as string;
}

// ─── Добавление участника ─────────────────────────────────────────────────────

describe("Добавление участника в проект", () => {
  let projectId: string;
  let memberId: string;

  beforeAll(async () => {
    const clientId = await createClientA("Клиент для членов");
    projectId = await createProjectA(clientId, "Проект для добавления");
    memberId = await createMemberA("Техник для добавления");
  });

  it("POST /:id/members добавляет участника", async () => {
    const res = await postA(`/api/gaffer/projects/${projectId}/members`).send({
      contactId: memberId,
      plannedAmount: "25000",
      roleLabel: "осветитель",
    });

    expect(res.status).toBe(200);
    expect(res.body.member.contactId).toBe(memberId);
    expect(res.body.member.plannedAmount).toBe("25000");
    expect(res.body.member.roleLabel).toBe("осветитель");
  });

  it("POST повторное добавление → 409 MEMBER_ALREADY_IN_PROJECT", async () => {
    const res = await postA(`/api/gaffer/projects/${projectId}/members`).send({
      contactId: memberId,
      plannedAmount: "10000",
    });

    expect(res.status).toBe(409);
    expect(res.body.details).toBe("MEMBER_ALREADY_IN_PROJECT");
  });

  it("POST несуществующий проект → 404", async () => {
    const res = await postA("/api/gaffer/projects/nonexistent/members").send({
      contactId: memberId,
      plannedAmount: "10000",
    });
    expect(res.status).toBe(404);
  });

  it("POST без contactId → 400", async () => {
    const res = await postA(`/api/gaffer/projects/${projectId}/members`).send({
      plannedAmount: "10000",
    });
    expect(res.status).toBe(400);
  });

  it("POST контакт типа CLIENT → 400 INVALID_MEMBER_TYPE", async () => {
    const clientId = await createClientA("Клиент-не-техник");
    const res = await postA(`/api/gaffer/projects/${projectId}/members`).send({
      contactId: clientId,
      plannedAmount: "10000",
    });
    expect(res.status).toBe(400);
    expect(res.body.details).toBe("INVALID_MEMBER_TYPE");
  });

  it("POST архивный контакт → 400 MEMBER_ARCHIVED", async () => {
    const archivedId = await createMemberA("Архивный техник");
    await postA(`/api/gaffer/contacts/${archivedId}/archive`);

    const res = await postA(`/api/gaffer/projects/${projectId}/members`).send({
      contactId: archivedId,
      plannedAmount: "10000",
    });
    expect(res.status).toBe(400);
    expect(res.body.details).toBe("MEMBER_ARCHIVED");
  });

  it("POST контакт другого tenant → 404", async () => {
    const resBMember = await postB("/api/gaffer/contacts").send({
      type: "TEAM_MEMBER",
      name: "Техник B",
    });
    const foreignMemberId = resBMember.body.contact.id as string;

    const res = await postA(`/api/gaffer/projects/${projectId}/members`).send({
      contactId: foreignMemberId,
      plannedAmount: "10000",
    });
    expect(res.status).toBe(404);
  });
});

// ─── Обновление участника ─────────────────────────────────────────────────────

describe("Обновление участника", () => {
  let memberRowId: string;

  beforeAll(async () => {
    const clientId = await createClientA("Клиент обновления");
    const projectId = await createProjectA(clientId, "Проект обновления");
    const contactId = await createMemberA("Техник обновления");

    const res = await postA(`/api/gaffer/projects/${projectId}/members`).send({
      contactId,
      plannedAmount: "10000",
      roleLabel: "До обновления",
    });
    memberRowId = res.body.member.id as string;
  });

  it("PATCH /members/:memberId обновляет plannedAmount", async () => {
    const res = await patchA(`/api/gaffer/projects/members/${memberRowId}`).send({
      plannedAmount: "35000",
    });
    expect(res.status).toBe(200);
    expect(res.body.member.plannedAmount).toBe("35000");
  });

  it("PATCH /members/:memberId обновляет roleLabel", async () => {
    const res = await patchA(`/api/gaffer/projects/members/${memberRowId}`).send({
      roleLabel: "После обновления",
    });
    expect(res.status).toBe(200);
    expect(res.body.member.roleLabel).toBe("После обновления");
  });

  it("PATCH несуществующего участника → 404", async () => {
    const res = await patchA("/api/gaffer/projects/members/nonexistent-id").send({
      plannedAmount: "5000",
    });
    expect(res.status).toBe(404);
  });
});

// ─── Удаление участника ───────────────────────────────────────────────────────

describe("Удаление участника", () => {
  it("DELETE /members/:memberId удаляет участника → 204", async () => {
    const clientId = await createClientA("Клиент удаления");
    const projectId = await createProjectA(clientId, "Проект удаления");
    const contactId = await createMemberA("Техник удаления");

    const addRes = await postA(`/api/gaffer/projects/${projectId}/members`).send({
      contactId,
      plannedAmount: "5000",
    });
    const memberRowId = addRes.body.member.id as string;

    const res = await deleteA(`/api/gaffer/projects/members/${memberRowId}`);
    expect(res.status).toBe(204);
  });

  it("DELETE несуществующего участника → 404", async () => {
    const res = await deleteA("/api/gaffer/projects/members/nonexistent-id");
    expect(res.status).toBe(404);
  });

  it("DELETE участника с платежами → 409 MEMBER_HAS_PAYMENTS", async () => {
    const clientId = await createClientA("Клиент платежей");
    const projectId = await createProjectA(clientId, "Проект платежей");
    const contactId = await createMemberA("Техник с платежами");

    const addRes = await postA(`/api/gaffer/projects/${projectId}/members`).send({
      contactId,
      plannedAmount: "20000",
    });
    const memberRowId = addRes.body.member.id as string;

    // Добавляем платёж OUT для участника
    await postA("/api/gaffer/payments").send({
      projectId,
      direction: "OUT",
      amount: "5000",
      paidAt: "2025-09-01",
      memberId: contactId,
    });

    const res = await deleteA(`/api/gaffer/projects/members/${memberRowId}`);
    expect(res.status).toBe(409);
    expect(res.body.details).toBe("MEMBER_HAS_PAYMENTS");
  });
});

// ─── Cross-tenant изоляция (участники) ───────────────────────────────────────

describe("Cross-tenant изоляция (участники)", () => {
  let memberRowIdA: string;

  beforeAll(async () => {
    const clientId = await createClientA("Клиент изоляции");
    const projectId = await createProjectA(clientId, "Проект изоляции");
    const contactId = await createMemberA("Техник изоляции");

    const res = await postA(`/api/gaffer/projects/${projectId}/members`).send({
      contactId,
      plannedAmount: "15000",
    });
    memberRowIdA = res.body.member.id as string;
  });

  it("Tenant B не может обновить участника tenant A", async () => {
    const res = await patchB(`/api/gaffer/projects/members/${memberRowIdA}`).send({
      plannedAmount: "99999",
    });
    expect(res.status).toBe(404);
  });

  it("Tenant B не может удалить участника tenant A", async () => {
    const res = await deleteB(`/api/gaffer/projects/members/${memberRowIdA}`);
    expect(res.status).toBe(404);
  });
});
