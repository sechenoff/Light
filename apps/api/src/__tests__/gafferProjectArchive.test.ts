/**
 * Интеграционные тесты: архивация проекта заблокирована при открытых остатках.
 *
 * Canon §04: «Кнопка «Архивировать» неактивна, пока оба долга > 0».
 * Расширено на vendorRemaining (схема получила VENDOR после написания канона;
 * тот же смысл — не прятать деньги).
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(
  __dirname,
  "../../prisma/test-gaffer-project-archive.db",
);
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-gaffer-archive-key";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.GAFFER_SESSION_SECRET = "gaffer-archive-secret-min16chars-ok";
process.env.JWT_SECRET = "test-archive-secret-min16chars-gaffer";
process.env.BARCODE_SECRET = "test-barcode-secret-gaffer-archive";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-gaffer-archive";

let app: Express;
let token: string;

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

  const loginRes = await request(app)
    .post("/api/gaffer/auth/login")
    .send({ email: "archive-gate-test@example.com" });
  token = loginRes.body.token as string;
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

async function createClient(name = "Заказчик") {
  const res = await post("/api/gaffer/contacts").send({ type: "CLIENT", name });
  expect(res.status).toBe(200);
  return res.body.contact.id as string;
}

async function createTeamMember(name = "Участник") {
  const res = await post("/api/gaffer/contacts").send({ type: "TEAM_MEMBER", name });
  expect(res.status).toBe(200);
  return res.body.contact.id as string;
}

async function createVendor(name = "Вендор") {
  const res = await post("/api/gaffer/contacts").send({ type: "VENDOR", name });
  expect(res.status).toBe(200);
  return res.body.contact.id as string;
}

async function createProject(overrides: Record<string, unknown> = {}) {
  const clientId = await createClient();
  const res = await post("/api/gaffer/projects").send({
    title: "Тестовый проект",
    clientId,
    shootDate: "2026-07-15",
    clientPlanAmount: "0",
    ...overrides,
    ...(overrides.clientId === undefined ? { clientId } : {}),
  });
  expect(res.status).toBe(200);
  return res.body.project as Record<string, unknown> & { id: string };
}

// ─── Тесты ───────────────────────────────────────────────────────────────────

describe("Архивация: блокировка при clientRemaining > 0", () => {
  it("POST archive возвращает 409 PROJECT_HAS_DEBTS когда clientPlanAmount > 0 и нет IN-платежей", async () => {
    const project = await createProject({
      title: "Проект с долгом клиента",
      clientPlanAmount: "10000",
    });

    const res = await post(`/api/gaffer/projects/${project.id}/archive`);

    expect(res.status).toBe(409);
    expect(res.body.details).toBe("PROJECT_HAS_DEBTS");
  });
});

describe("Архивация: разблокировка после полной оплаты клиентом", () => {
  it("POST archive возвращает 200 когда клиент полностью оплатил", async () => {
    const project = await createProject({
      title: "Проект с оплаченным клиентом",
      clientPlanAmount: "10000",
    });

    // Полный IN-платёж
    const payRes = await post("/api/gaffer/payments").send({
      projectId: project.id,
      direction: "IN",
      amount: "10000",
      paidAt: "2026-07-16",
    });
    expect(payRes.status).toBe(200);

    const res = await post(`/api/gaffer/projects/${project.id}/archive`);

    expect(res.status).toBe(200);
    expect(res.body.project.status).toBe("ARCHIVED");
  });
});

describe("Архивация: блокировка при teamRemaining > 0", () => {
  it("POST archive возвращает 409 когда команде не выплачено", async () => {
    const memberId = await createTeamMember("Техник долга");
    const project = await createProject({
      title: "Проект с долгом команды",
      clientPlanAmount: "0",
    });

    // Добавляем участника с плановой суммой
    const addRes = await post(`/api/gaffer/projects/${project.id}/members`).send({
      contactId: memberId,
      plannedAmount: "5000",
    });
    expect(addRes.status).toBe(200);

    // Нет OUT-платежей → teamRemaining = 5000 > 0
    const res = await post(`/api/gaffer/projects/${project.id}/archive`);

    expect(res.status).toBe(409);
    expect(res.body.details).toBe("PROJECT_HAS_DEBTS");
  });
});

describe("Архивация: блокировка при vendorRemaining > 0", () => {
  it("POST archive возвращает 409 когда вендору не выплачено", async () => {
    const vendorId = await createVendor("Рентал Долга");
    const project = await createProject({
      title: "Проект с долгом вендора",
      clientPlanAmount: "0",
    });

    // Добавляем вендора с плановой суммой
    const addRes = await post(`/api/gaffer/projects/${project.id}/members`).send({
      contactId: vendorId,
      plannedAmount: "8000",
    });
    expect(addRes.status).toBe(200);

    // Нет OUT-платежей → vendorRemaining = 8000 > 0
    const res = await post(`/api/gaffer/projects/${project.id}/archive`);

    expect(res.status).toBe(409);
    expect(res.body.details).toBe("PROJECT_HAS_DEBTS");
  });
});

describe("Разархивация: всегда разрешена", () => {
  it("POST unarchive работает без ограничений даже при открытых остатках", async () => {
    // Сначала создаём чистый проект (нет долгов) и архивируем его
    const project = await createProject({
      title: "Проект для разархивации",
      clientPlanAmount: "0",
    });

    const archRes = await post(`/api/gaffer/projects/${project.id}/archive`);
    expect(archRes.status).toBe(200);
    expect(archRes.body.project.status).toBe("ARCHIVED");

    // Разархивируем — должно сработать
    const res = await post(`/api/gaffer/projects/${project.id}/unarchive`);

    expect(res.status).toBe(200);
    expect(res.body.project.status).toBe("OPEN");
  });
});
