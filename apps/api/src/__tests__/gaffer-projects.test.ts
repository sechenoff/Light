/**
 * Интеграционные тесты createProject с поддержкой members[].
 * Проверяет:
 * 1. Успешное создание проекта с 2 участниками — ответ содержит members[].
 * 2. Создание с contactId, принадлежащим типу CLIENT → 400 INVALID_MEMBER_CONTACT.
 * 3. Создание с несуществующим contactId → 400 INVALID_MEMBER_CONTACT.
 * 4. Создание с contactId из другого tenant'а → 400 INVALID_MEMBER_CONTACT (cross-tenant attack).
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(
  __dirname,
  "../../prisma/test-gaffer-projects-members.db",
);
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-gaffer-members-key";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.GAFFER_SESSION_SECRET = "gaffer-test-secret-min16chars-ok2";
process.env.JWT_SECRET = "test-jwt-secret-min16chars-gaffermembers";
process.env.BARCODE_SECRET = "test-barcode-secret-gaffer2";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-gaffer2";

let app: Express;
let token: string;
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

  // Register gaffer user A and obtain token
  const loginRes = await request(app)
    .post("/api/gaffer/auth/login")
    .send({ email: "members-test@example.com" });
  token = loginRes.body.token as string;

  // Register gaffer user B (second tenant) and obtain token
  const loginResB = await request(app)
    .post("/api/gaffer/auth/login")
    .send({ email: "members-test-b@example.com" });
  tokenB = loginResB.body.token as string;
});

afterAll(async () => {
  const { prisma } = await import("../prisma");
  await prisma.$disconnect();
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = TEST_DB_PATH + suffix;
    if (fs.existsSync(f)) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
  }
});

// ─── helpers ──────────────────────────────────────────────────────────────────

function post(url: string) {
  return request(app).post(url).set("Authorization", `Bearer ${token}`);
}
function postB(url: string) {
  return request(app).post(url).set("Authorization", `Bearer ${tokenB}`);
}

async function createClient(name = "Заказчик Альфа") {
  const res = await post("/api/gaffer/contacts").send({ type: "CLIENT", name });
  expect(res.status).toBe(200);
  return res.body.contact.id as string;
}

async function createTeamMember(name: string, shiftRate = 5000) {
  const res = await post("/api/gaffer/contacts").send({
    type: "TEAM_MEMBER",
    name,
    shiftRate: String(shiftRate),
    overtimeTier1Rate: String(Math.round(shiftRate / 10)),
    overtimeTier2Rate: String(Math.round(shiftRate / 10) * 2),
    overtimeTier3Rate: String(Math.round(shiftRate / 10) * 4),
    roleLabel: "Осветитель / Grip",
  });
  expect(res.status).toBe(200);
  return res.body.contact.id as string;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("createProject with members", () => {
  it("создаёт проект с 2 участниками и возвращает members[]", async () => {
    const clientId = await createClient();
    const memberAId = await createTeamMember("Осветитель А");
    const memberBId = await createTeamMember("Осветитель Б", 6000);

    const res = await post("/api/gaffer/projects").send({
      title: "Тест с командой",
      clientId,
      shootDate: "2025-06-01",
      clientPlanAmount: "50000",
      lightBudgetAmount: "10000",
      members: [
        { contactId: memberAId, plannedAmount: "10000" },
        { contactId: memberBId, plannedAmount: "15000" },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.project).toBeDefined();
    expect(Array.isArray(res.body.project.members)).toBe(true);
    expect(res.body.project.members).toHaveLength(2);

    // Also verify DB has 2 GafferProjectMember rows
    const { prisma } = await import("../prisma");
    const count = await prisma.gafferProjectMember.count({
      where: { projectId: res.body.project.id },
    });
    expect(count).toBe(2);
  });

  it("отклоняет участника с типом CLIENT → 400 INVALID_MEMBER_CONTACT", async () => {
    const clientId = await createClient("Заказчик-как-участник");

    const res = await post("/api/gaffer/projects").send({
      title: "Проект с неверным участником",
      clientId,
      shootDate: "2025-06-02",
      members: [{ contactId: clientId, plannedAmount: "1000" }],
    });

    expect(res.status).toBe(400);
    expect(res.body.details).toBe("INVALID_MEMBER_CONTACT");
  });

  it("отклоняет несуществующий contactId участника → 400 INVALID_MEMBER_CONTACT", async () => {
    const clientId = await createClient("Заказчик для теста");

    const res = await post("/api/gaffer/projects").send({
      title: "Проект с несуществующим участником",
      clientId,
      shootDate: "2025-06-03",
      members: [{ contactId: "nonexistent-id-999", plannedAmount: "1000" }],
    });

    expect(res.status).toBe(400);
    expect(res.body.details).toBe("INVALID_MEMBER_CONTACT");
  });

  it("отклоняет cross-tenant атаку: contactId из tenant B нельзя использовать в tenant A → 400 INVALID_MEMBER_CONTACT", async () => {
    // Создаём TEAM_MEMBER в tenant B
    const resMemberB = await postB("/api/gaffer/contacts").send({
      type: "TEAM_MEMBER",
      name: "Участник из Tenant B",
      shiftRate: "3000",
    });
    expect(resMemberB.status).toBe(200);
    const memberBId = resMemberB.body.contact.id as string;

    // Создаём CLIENT в tenant A
    const clientId = await createClient("Заказчик для cross-tenant теста");

    // Tenant A пытается использовать contactId из tenant B в members[]
    const res = await post("/api/gaffer/projects").send({
      title: "Cross-tenant атака",
      clientId,
      shootDate: "2025-07-01",
      members: [{ contactId: memberBId, plannedAmount: "5000" }],
    });

    expect(res.status).toBe(400);
    expect(res.body.details).toBe("INVALID_MEMBER_CONTACT");

    // Убеждаемся, что проект НЕ был создан
    const { prisma } = await import("../prisma");
    const count = await prisma.gafferProject.count({
      where: { title: "Cross-tenant атака" },
    });
    expect(count).toBe(0);
  });
});

// ─── VENDOR-контакты в проектах ───────────────────────────────────────────────

describe("VENDOR-контакт: создание и добавление в проект", () => {
  it("POST /contacts создаёт контакт с type=VENDOR", async () => {
    const res = await post("/api/gaffer/contacts").send({
      type: "VENDOR",
      name: "Арта Рент",
    });
    expect(res.status).toBe(200);
    expect(res.body.contact.type).toBe("VENDOR");
    expect(res.body.contact.name).toBe("Арта Рент");
  });

  it("GET /contacts?type=VENDOR возвращает только VENDOR-контакты", async () => {
    const resV = await post("/api/gaffer/contacts").send({ type: "VENDOR", name: "Рентал Фильтр" });
    const vendorId = resV.body.contact.id as string;

    const res = await request(app).get("/api/gaffer/contacts?type=VENDOR")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const ids = res.body.items.map((c: { id: string }) => c.id);
    expect(ids).toContain(vendorId);
    for (const c of res.body.items) {
      expect(c.type).toBe("VENDOR");
    }
  });

  it("GET /contacts/summary содержит счётчик vendors > 0", async () => {
    await post("/api/gaffer/contacts").send({ type: "VENDOR", name: "Рентал Саммари" });

    const res = await request(app).get("/api/gaffer/contacts/summary")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.counts.vendors).toBe("number");
    expect(res.body.counts.vendors).toBeGreaterThan(0);
  });

  it("POST /:id/members добавляет VENDOR-контакт в проект", async () => {
    const clientId = await createClient("Заказчик рентала");
    const projectRes = await post("/api/gaffer/projects").send({
      title: "Проект с ренталом",
      clientId,
      shootDate: "2025-10-01",
      clientPlanAmount: "60000",
    });
    const projectId = projectRes.body.project.id as string;

    const vendorRes = await post("/api/gaffer/contacts").send({ type: "VENDOR", name: "Свет Про" });
    const vendorId = vendorRes.body.contact.id as string;

    const memberRes = await post(`/api/gaffer/projects/${projectId}/members`).send({
      contactId: vendorId,
      plannedAmount: "20000",
    });

    expect(memberRes.status).toBe(200);
    expect(memberRes.body.member.contactId).toBe(vendorId);
    expect(memberRes.body.member.plannedAmount).toBe("20000");
  });

  it("POST /:id/members с CLIENT → 400 INVALID_MEMBER_TYPE", async () => {
    const clientId = await createClient("Клиент-не-рентал");
    const projectRes = await post("/api/gaffer/projects").send({
      title: "Проект CLIENT-reject",
      clientId,
      shootDate: "2025-10-02",
    });
    const projectId = projectRes.body.project.id as string;

    const res = await post(`/api/gaffer/projects/${projectId}/members`).send({
      contactId: clientId,
      plannedAmount: "5000",
    });

    expect(res.status).toBe(400);
    expect(res.body.details).toBe("INVALID_MEMBER_TYPE");
  });

  it("cross-tenant атака с VENDOR: контакт из tenant A нельзя добавить в проект tenant B → 404 NOT_FOUND", async () => {
    // Создаём VENDOR-контакт в tenant A
    const vendorResA = await post("/api/gaffer/contacts").send({ type: "VENDOR", name: "Рентал из Tenant A" });
    expect(vendorResA.status).toBe(200);
    const vendorIdA = vendorResA.body.contact.id as string;

    // Создаём CLIENT + проект в tenant B
    const clientResB = await postB("/api/gaffer/contacts").send({ type: "CLIENT", name: "Заказчик B" });
    expect(clientResB.status).toBe(200);
    const clientIdB = clientResB.body.contact.id as string;

    const projectResB = await postB("/api/gaffer/projects").send({
      title: "Проект Tenant B",
      clientId: clientIdB,
      shootDate: "2025-11-01",
    });
    expect(projectResB.status).toBe(200);
    const projectIdB = projectResB.body.project.id as string;

    // Tenant B пытается добавить VENDOR из tenant A в свой проект → 404
    const res = await postB(`/api/gaffer/projects/${projectIdB}/members`).send({
      contactId: vendorIdA,
      plannedAmount: "12000",
    });

    expect(res.status).toBe(404);
    expect(res.body.details).toBe("NOT_FOUND");
  });

  it("OUT-платёж для VENDOR-участника создаётся успешно", async () => {
    const clientId = await createClient("Заказчик OUT-платежа");
    const projectRes = await post("/api/gaffer/projects").send({
      title: "Проект OUT-рентал",
      clientId,
      shootDate: "2025-10-03",
      clientPlanAmount: "50000",
    });
    const projectId = projectRes.body.project.id as string;

    const vendorRes = await post("/api/gaffer/contacts").send({ type: "VENDOR", name: "Арта Рент OUT" });
    const vendorId = vendorRes.body.contact.id as string;

    await post(`/api/gaffer/projects/${projectId}/members`).send({
      contactId: vendorId,
      plannedAmount: "15000",
    });

    const payRes = await post("/api/gaffer/payments").send({
      projectId,
      direction: "OUT",
      amount: "8000",
      paidAt: "2025-10-04",
      memberId: vendorId,
    });

    expect(payRes.status).toBe(200);
    expect(payRes.body.payment.memberId).toBe(vendorId);
    expect(payRes.body.payment.amount).toBe("8000");
  });
});
