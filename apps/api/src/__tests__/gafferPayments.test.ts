/**
 * Интеграционные тесты Gaffer CRM payments API.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-gaffer-payments.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-gaffer-payments-key";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.GAFFER_SESSION_SECRET = "gaffer-payments-secret-min16chars";
process.env.JWT_SECRET = "test-jwt-secret-payments-min16chars";
process.env.BARCODE_SECRET = "test-barcode-secret-payments";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-payments";

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

function getA(url: string) {
  return request(app).get(url).set("Authorization", `Bearer ${tokenA}`);
}
function postA(url: string) {
  return request(app).post(url).set("Authorization", `Bearer ${tokenA}`);
}
function patchA(url: string) {
  return request(app).patch(url).set("Authorization", `Bearer ${tokenA}`);
}
function deleteA(url: string) {
  return request(app).delete(url).set("Authorization", `Bearer ${tokenA}`);
}
function getB(url: string) {
  return request(app).get(url).set("Authorization", `Bearer ${tokenB}`);
}
function postB(url: string) {
  return request(app).post(url).set("Authorization", `Bearer ${tokenB}`);
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
    clientPlanAmount: "100000",
  });
  expect(res.status).toBe(200);
  return res.body.project.id as string;
}

async function addMemberA(projectId: string, contactId: string) {
  const res = await postA(`/api/gaffer/projects/${projectId}/members`).send({
    contactId,
    plannedAmount: "30000",
  });
  expect(res.status).toBe(200);
  return res.body.member;
}

// ─── Авторизация ──────────────────────────────────────────────────────────────

describe("Авторизация (платежи)", () => {
  it("GET /api/gaffer/payments без токена → 401", async () => {
    const res = await request(app).get("/api/gaffer/payments");
    expect(res.status).toBe(401);
  });

  it("POST /api/gaffer/payments без токена → 401", async () => {
    const res = await request(app).post("/api/gaffer/payments").send({});
    expect(res.status).toBe(401);
  });
});

// ─── Создание IN-платежа ──────────────────────────────────────────────────────

describe("Создание IN-платежа", () => {
  let projectId: string;

  beforeAll(async () => {
    const clientId = await createClientA("Клиент IN");
    projectId = await createProjectA(clientId, "Проект IN");
  });

  it("POST создаёт IN-платёж", async () => {
    const res = await postA("/api/gaffer/payments").send({
      projectId,
      direction: "IN",
      amount: "50000",
      paidAt: "2025-09-15",
      comment: "Предоплата",
    });

    expect(res.status).toBe(200);
    expect(res.body.payment.direction).toBe("IN");
    expect(res.body.payment.amount).toBe("50000");
    expect(res.body.payment.memberId).toBeNull();
  });

  it("POST IN с memberId → 400 MEMBER_NOT_APPLICABLE_TO_IN", async () => {
    const memberId = await createMemberA("Техник IN");
    await addMemberA(projectId, memberId);

    const res = await postA("/api/gaffer/payments").send({
      projectId,
      direction: "IN",
      amount: "10000",
      paidAt: "2025-09-16",
      memberId,
    });

    expect(res.status).toBe(400);
    expect(res.body.details).toBe("MEMBER_NOT_APPLICABLE_TO_IN");
  });

  it("POST IN с суммой = 0 → 400 INVALID_AMOUNT", async () => {
    const res = await postA("/api/gaffer/payments").send({
      projectId,
      direction: "IN",
      amount: "0",
      paidAt: "2025-09-17",
    });
    expect(res.status).toBe(400);
    expect(res.body.details).toBe("INVALID_AMOUNT");
  });

  it("POST IN с отрицательной суммой → 400 INVALID_AMOUNT", async () => {
    const res = await postA("/api/gaffer/payments").send({
      projectId,
      direction: "IN",
      amount: "-1000",
      paidAt: "2025-09-17",
    });
    expect(res.status).toBe(400);
    expect(res.body.details).toBe("INVALID_AMOUNT");
  });
});

// ─── Создание OUT-платежа ─────────────────────────────────────────────────────

describe("Создание OUT-платежа", () => {
  let projectId: string;
  let memberId: string;

  beforeAll(async () => {
    const clientId = await createClientA("Клиент OUT");
    projectId = await createProjectA(clientId, "Проект OUT");
    memberId = await createMemberA("Техник OUT");
    await addMemberA(projectId, memberId);
  });

  it("POST создаёт OUT-платёж с memberId", async () => {
    const res = await postA("/api/gaffer/payments").send({
      projectId,
      direction: "OUT",
      amount: "15000",
      paidAt: "2025-10-01",
      memberId,
    });

    expect(res.status).toBe(200);
    expect(res.body.payment.direction).toBe("OUT");
    expect(res.body.payment.amount).toBe("15000");
    expect(res.body.payment.memberId).toBe(memberId);
  });

  it("POST OUT без memberId → 400 MEMBER_REQUIRED_FOR_OUT", async () => {
    const res = await postA("/api/gaffer/payments").send({
      projectId,
      direction: "OUT",
      amount: "10000",
      paidAt: "2025-10-02",
    });

    expect(res.status).toBe(400);
    expect(res.body.details).toBe("MEMBER_REQUIRED_FOR_OUT");
  });

  it("POST OUT с memberId не из проекта → 400 MEMBER_NOT_IN_PROJECT", async () => {
    const otherMemberId = await createMemberA("Другой техник");
    // Не добавляем в проект

    const res = await postA("/api/gaffer/payments").send({
      projectId,
      direction: "OUT",
      amount: "5000",
      paidAt: "2025-10-03",
      memberId: otherMemberId,
    });

    expect(res.status).toBe(400);
    expect(res.body.details).toBe("MEMBER_NOT_IN_PROJECT");
  });

  it("POST OUT для архивного проекта → 400 PROJECT_ARCHIVED", async () => {
    const clientId = await createClientA("Клиент арх. проект");
    const archivedProjectId = await createProjectA(clientId, "Архивный проект");
    const mId = await createMemberA("Техник арх.");
    await addMemberA(archivedProjectId, mId);
    await postA(`/api/gaffer/projects/${archivedProjectId}/archive`);

    const res = await postA("/api/gaffer/payments").send({
      projectId: archivedProjectId,
      direction: "OUT",
      amount: "5000",
      paidAt: "2025-10-04",
      memberId: mId,
    });

    expect(res.status).toBe(400);
    expect(res.body.details).toBe("PROJECT_ARCHIVED");
  });

  it("POST с несуществующим проектом → 404", async () => {
    const res = await postA("/api/gaffer/payments").send({
      projectId: "nonexistent",
      direction: "OUT",
      amount: "5000",
      paidAt: "2025-10-04",
      memberId,
    });
    expect(res.status).toBe(404);
  });
});

// ─── paidAt — семантика московской даты ──────────────────────────────────────

describe("paidAt — московская дата", () => {
  let projectId: string;

  beforeAll(async () => {
    const clientId = await createClientA("Клиент дата");
    projectId = await createProjectA(clientId, "Проект дата");
  });

  it("paidAt YYYY-MM-DD сохраняется корректно", async () => {
    const res = await postA("/api/gaffer/payments").send({
      projectId,
      direction: "IN",
      amount: "1000",
      paidAt: "2025-11-20",
    });

    expect(res.status).toBe(200);
    // paidAt должен быть ISO string для 2025-11-20 в Москве = 2025-11-19T21:00:00.000Z
    expect(res.body.payment.paidAt).toContain("2025-11-19");
  });
});

// ─── Список платежей ──────────────────────────────────────────────────────────

describe("Список платежей", () => {
  let projectId: string;
  let memberId: string;

  beforeAll(async () => {
    const clientId = await createClientA("Клиент список");
    projectId = await createProjectA(clientId, "Проект список");
    memberId = await createMemberA("Техник список");
    await addMemberA(projectId, memberId);

    await postA("/api/gaffer/payments").send({
      projectId,
      direction: "IN",
      amount: "60000",
      paidAt: "2025-11-01",
    });

    await postA("/api/gaffer/payments").send({
      projectId,
      direction: "OUT",
      amount: "20000",
      paidAt: "2025-11-02",
      memberId,
    });
  });

  it("GET /api/gaffer/payments возвращает все платежи tenant", async () => {
    const res = await getA("/api/gaffer/payments");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBeGreaterThanOrEqual(2);
  });

  it("GET ?projectId фильтрует по проекту", async () => {
    const res = await getA(`/api/gaffer/payments?projectId=${projectId}`);
    expect(res.status).toBe(200);
    for (const item of res.body.items) {
      expect(item.projectId).toBe(projectId);
    }
    expect(res.body.items.length).toBeGreaterThanOrEqual(2);
  });

  it("GET ?memberContactId фильтрует по участнику", async () => {
    const res = await getA(`/api/gaffer/payments?memberContactId=${memberId}`);
    expect(res.status).toBe(200);
    for (const item of res.body.items) {
      expect(item.memberId).toBe(memberId);
    }
  });

  it("Tenant B не видит платежи tenant A", async () => {
    const resA = await getA("/api/gaffer/payments");
    const resB = await getB("/api/gaffer/payments");

    const idsA = resA.body.items.map((p: Record<string, unknown>) => p.id);
    const idsB = resB.body.items.map((p: Record<string, unknown>) => p.id);

    for (const id of idsA) {
      expect(idsB).not.toContain(id);
    }
  });
});

// ─── Обновление платежа ───────────────────────────────────────────────────────

describe("Обновление платежа", () => {
  let paymentId: string;
  let projectId: string;

  beforeAll(async () => {
    const clientId = await createClientA("Клиент обн. платёж");
    projectId = await createProjectA(clientId, "Проект обн. платёж");

    const res = await postA("/api/gaffer/payments").send({
      projectId,
      direction: "IN",
      amount: "30000",
      paidAt: "2025-12-01",
      comment: "До обновления",
    });
    paymentId = res.body.payment.id as string;
  });

  it("PATCH обновляет amount", async () => {
    const res = await patchA(`/api/gaffer/payments/${paymentId}`).send({ amount: "45000" });
    expect(res.status).toBe(200);
    expect(res.body.payment.amount).toBe("45000");
  });

  it("PATCH обновляет comment", async () => {
    const res = await patchA(`/api/gaffer/payments/${paymentId}`).send({ comment: "После обновления" });
    expect(res.status).toBe(200);
    expect(res.body.payment.comment).toBe("После обновления");
  });

  it("PATCH обновляет paidAt", async () => {
    const res = await patchA(`/api/gaffer/payments/${paymentId}`).send({ paidAt: "2025-12-15" });
    expect(res.status).toBe(200);
    expect(res.body.payment.paidAt).toContain("2025-12-14"); // Moscow-midnight
  });

  it("PATCH с amount=0 → 400 INVALID_AMOUNT", async () => {
    const res = await patchA(`/api/gaffer/payments/${paymentId}`).send({ amount: "0" });
    expect(res.status).toBe(400);
    expect(res.body.details).toBe("INVALID_AMOUNT");
  });

  it("PATCH несуществующего платежа → 404", async () => {
    const res = await patchA("/api/gaffer/payments/nonexistent-id").send({ amount: "1000" });
    expect(res.status).toBe(404);
  });
});

// ─── Удаление платежа ─────────────────────────────────────────────────────────

describe("Удаление платежа", () => {
  it("DELETE платёж → 204", async () => {
    const clientId = await createClientA("Клиент удал. платёж");
    const projectId = await createProjectA(clientId, "Проект удал. платёж");

    const res = await postA("/api/gaffer/payments").send({
      projectId,
      direction: "IN",
      amount: "1000",
      paidAt: "2025-12-20",
    });
    const paymentId = res.body.payment.id as string;

    const delRes = await deleteA(`/api/gaffer/payments/${paymentId}`);
    expect(delRes.status).toBe(204);
  });

  it("DELETE несуществующего платежа → 404", async () => {
    const res = await deleteA("/api/gaffer/payments/nonexistent-id");
    expect(res.status).toBe(404);
  });

  it("DELETE платежа другого tenant → 404", async () => {
    const clientIdB = (await postB("/api/gaffer/contacts").send({ type: "CLIENT", name: "B Client" })).body.contact.id as string;
    const projIdB = (await postB("/api/gaffer/projects").send({ title: "B Proj", clientId: clientIdB, shootDate: "2025-08-01" })).body.project.id as string;
    const pmB = (await postB("/api/gaffer/payments").send({
      projectId: projIdB,
      direction: "IN",
      amount: "1000",
      paidAt: "2025-10-01",
    }));
    const paymentIdB = pmB.body.payment.id as string;

    const res = await deleteA(`/api/gaffer/payments/${paymentIdB}`);
    expect(res.status).toBe(404);
  });
});

// ─── paymentMethodId ──────────────────────────────────────────────────────────

describe("paymentMethodId при создании платежа", () => {
  let projectId: string;
  let methodId: string;

  beforeAll(async () => {
    const clientId = await createClientA("Клиент метод");
    projectId = await createProjectA(clientId, "Проект метод");

    const mRes = await postA("/api/gaffer/payment-methods").send({ name: "Наличные" });
    methodId = mRes.body.item.id as string;
  });

  it("POST с paymentMethodId → платёж содержит метод", async () => {
    const res = await postA("/api/gaffer/payments").send({
      projectId,
      direction: "IN",
      amount: "5000",
      paidAt: "2025-10-10",
      paymentMethodId: methodId,
    });

    expect(res.status).toBe(200);
    expect(res.body.payment.paymentMethodId).toBe(methodId);
    expect(res.body.payment.method).toBeTruthy();
    expect(res.body.payment.method.name).toBe("Наличные");
  });

  it("POST с чужим paymentMethodId → 404", async () => {
    const resBMethod = await postB("/api/gaffer/payment-methods").send({ name: "Карта B" });
    const foreignMethodId = resBMethod.body.item.id as string;

    const res = await postA("/api/gaffer/payments").send({
      projectId,
      direction: "IN",
      amount: "5000",
      paidAt: "2025-10-11",
      paymentMethodId: foreignMethodId,
    });

    expect(res.status).toBe(404);
  });
});
