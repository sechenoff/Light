/**
 * Интеграционные тесты Gaffer CRM projects API.
 * Паттерн: изолированная SQLite БД, два tenant'а для cross-tenant изоляции.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-gaffer-projects.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-gaffer-key";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.GAFFER_SESSION_SECRET = "gaffer-test-secret-min16chars-ok";
process.env.JWT_SECRET = "test-jwt-secret-min16chars-gaffer";
process.env.BARCODE_SECRET = "test-barcode-secret-gaffer";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-gaffer";

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
function patchB(url: string) {
  return request(app).patch(url).set("Authorization", `Bearer ${tokenB}`);
}
function deleteB(url: string) {
  return request(app).delete(url).set("Authorization", `Bearer ${tokenB}`);
}

async function createClientA(name = "Клиент Альфа") {
  const res = await postA("/api/gaffer/contacts").send({ type: "CLIENT", name });
  expect(res.status).toBe(200);
  return res.body.contact.id as string;
}

async function createMemberA(name = "Член команды") {
  const res = await postA("/api/gaffer/contacts").send({ type: "TEAM_MEMBER", name });
  expect(res.status).toBe(200);
  return res.body.contact.id as string;
}

async function createProjectA(overrides: Record<string, unknown> = {}) {
  const clientId = await createClientA();
  const res = await postA("/api/gaffer/projects").send({
    title: "Тестовый проект",
    clientId,
    shootDate: "2025-07-15",
    clientPlanAmount: "50000",
    ...overrides,
    ...(overrides.clientId === undefined ? { clientId } : {}),
  });
  expect(res.status).toBe(200);
  return res.body.project as Record<string, unknown> & { id: string };
}

// ─── Авторизация ──────────────────────────────────────────────────────────────

describe("Авторизация (проекты)", () => {
  it("GET /api/gaffer/projects без токена → 401", async () => {
    const res = await request(app).get("/api/gaffer/projects");
    expect(res.status).toBe(401);
  });

  it("POST /api/gaffer/projects без токена → 401", async () => {
    const res = await request(app).post("/api/gaffer/projects").send({ title: "Test" });
    expect(res.status).toBe(401);
  });
});

// ─── Создание проектов ────────────────────────────────────────────────────────

describe("Создание проектов", () => {
  it("POST создаёт проект с обязательными полями", async () => {
    const clientId = await createClientA("Клиент 1");
    const res = await postA("/api/gaffer/projects").send({
      title: "Клип «Новая волна»",
      clientId,
      shootDate: "2025-08-20",
    });

    expect(res.status).toBe(200);
    expect(res.body.project.title).toBe("Клип «Новая волна»");
    expect(res.body.project.status).toBe("OPEN");
    expect(res.body.project.clientPlanAmount).toBeTruthy(); // serialized as string
  });

  it("POST создаёт проект с clientPlanAmount", async () => {
    const clientId = await createClientA("Клиент 2");
    const res = await postA("/api/gaffer/projects").send({
      title: "Реклама автомобиля",
      clientId,
      shootDate: "2025-09-01",
      clientPlanAmount: "120000",
    });

    expect(res.status).toBe(200);
    expect(res.body.project.clientPlanAmount).toBe("120000");
  });

  it("POST создаёт проект с note", async () => {
    const clientId = await createClientA("Клиент 3");
    const res = await postA("/api/gaffer/projects").send({
      title: "С заметкой",
      clientId,
      shootDate: "2025-10-10",
      note: "Особые условия",
    });

    expect(res.status).toBe(200);
    expect(res.body.project.note).toBe("Особые условия");
  });

  it("POST без title → 400", async () => {
    const clientId = await createClientA("Клиент 4");
    const res = await postA("/api/gaffer/projects").send({
      clientId,
      shootDate: "2025-08-01",
    });
    expect(res.status).toBe(400);
  });

  it("POST без clientId → 400", async () => {
    const res = await postA("/api/gaffer/projects").send({
      title: "Без клиента",
      shootDate: "2025-08-01",
    });
    expect(res.status).toBe(400);
  });

  it("POST без shootDate → 400", async () => {
    const clientId = await createClientA("Клиент 5");
    const res = await postA("/api/gaffer/projects").send({
      title: "Без даты",
      clientId,
    });
    expect(res.status).toBe(400);
  });

  it("POST с clientId чужого tenant → 404", async () => {
    // Создаём контакт у tenant B
    const resB = await postB("/api/gaffer/contacts").send({ type: "CLIENT", name: "Клиент B" });
    const foreignClientId = resB.body.contact.id as string;

    const res = await postA("/api/gaffer/projects").send({
      title: "Чужой клиент",
      clientId: foreignClientId,
      shootDate: "2025-08-01",
    });
    expect(res.status).toBe(404);
  });

  it("POST с clientId архивированного контакта → 400", async () => {
    const clientId = await createClientA("Архивный клиент проекта");
    await postA(`/api/gaffer/contacts/${clientId}/archive`);

    const res = await postA("/api/gaffer/projects").send({
      title: "Проект с архивным клиентом",
      clientId,
      shootDate: "2025-08-01",
    });
    expect(res.status).toBe(400);
  });

  it("POST с clientId типа TEAM_MEMBER → 400", async () => {
    const memberId = await createMemberA("Техник проекта");

    const res = await postA("/api/gaffer/projects").send({
      title: "Проект с техником как клиентом",
      clientId: memberId,
      shootDate: "2025-08-01",
    });
    expect(res.status).toBe(400);
  });
});

// ─── Список проектов ──────────────────────────────────────────────────────────

describe("Список проектов", () => {
  let projectId: string;

  beforeAll(async () => {
    // clientPlanAmount: "0" чтобы не было долга и тест на архивный статус мог архивировать проект
    const p = await createProjectA({ title: "Список: проект А", clientPlanAmount: "0" });
    projectId = p.id;
  });

  it("GET возвращает только OPEN проекты по умолчанию", async () => {
    const res = await getA("/api/gaffer/projects");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    for (const item of res.body.items) {
      expect(item.status).toBe("OPEN");
    }
  });

  it("GET возвращает проект с агрегатами", async () => {
    const res = await getA("/api/gaffer/projects");
    expect(res.status).toBe(200);
    const item = res.body.items.find((p: Record<string, unknown>) => p.id === projectId);
    expect(item).toBeTruthy();
    // aggregates
    expect(item).toHaveProperty("clientReceived");
    expect(item).toHaveProperty("clientRemaining");
    expect(item).toHaveProperty("teamPlanTotal");
    expect(item).toHaveProperty("teamPaidTotal");
    expect(item).toHaveProperty("teamRemaining");
  });

  it("GET ?status=ARCHIVED возвращает только архивные", async () => {
    // Archive a project
    await postA(`/api/gaffer/projects/${projectId}/archive`);

    const res = await getA("/api/gaffer/projects?status=ARCHIVED");
    expect(res.status).toBe(200);
    for (const item of res.body.items) {
      expect(item.status).toBe("ARCHIVED");
    }

    // Restore
    await postA(`/api/gaffer/projects/${projectId}/unarchive`);
  });

  it("GET ?search=Список возвращает совпадающий проект", async () => {
    const res = await getA("/api/gaffer/projects?search=Список");
    expect(res.status).toBe(200);
    expect(res.body.items.some((p: Record<string, unknown>) => p.id === projectId)).toBe(true);
  });

  it("GET ?search=НесуществующийПроект → пустой массив", async () => {
    const res = await getA("/api/gaffer/projects?search=НесуществующийПроект12345");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
  });
});

// ─── Получить один проект ─────────────────────────────────────────────────────

describe("Получить проект", () => {
  let projectId: string;
  let clientId: string;

  beforeAll(async () => {
    clientId = await createClientA("Клиент для GET");
    const res = await postA("/api/gaffer/projects").send({
      title: "Проект для GET",
      clientId,
      shootDate: "2025-11-01",
      clientPlanAmount: "80000",
    });
    projectId = res.body.project.id as string;
  });

  it("GET /:id возвращает проект с клиентом, участниками и платежами", async () => {
    const res = await getA(`/api/gaffer/projects/${projectId}`);
    expect(res.status).toBe(200);
    expect(res.body.project.id).toBe(projectId);
    expect(res.body.project.client).toBeTruthy();
    expect(Array.isArray(res.body.project.members)).toBe(true);
    expect(Array.isArray(res.body.project.payments)).toBe(true);
  });

  it("GET /:id включает агрегаты долга", async () => {
    const res = await getA(`/api/gaffer/projects/${projectId}`);
    expect(res.status).toBe(200);
    expect(res.body.project).toHaveProperty("clientReceived");
    expect(res.body.project).toHaveProperty("clientRemaining");
    expect(res.body.project).toHaveProperty("teamPlanTotal");
    expect(res.body.project).toHaveProperty("teamPaidTotal");
    expect(res.body.project).toHaveProperty("teamRemaining");
  });

  it("GET несуществующего проекта → 404", async () => {
    const res = await getA("/api/gaffer/projects/nonexistent-id");
    expect(res.status).toBe(404);
  });
});

// ─── Обновление проектов ──────────────────────────────────────────────────────

describe("Обновление проектов", () => {
  let projectId: string;

  beforeAll(async () => {
    const p = await createProjectA({ title: "До обновления" });
    projectId = p.id;
  });

  it("PATCH обновляет title", async () => {
    const res = await patchA(`/api/gaffer/projects/${projectId}`)
      .send({ title: "После обновления" });
    expect(res.status).toBe(200);
    expect(res.body.project.title).toBe("После обновления");
  });

  it("PATCH обновляет clientPlanAmount", async () => {
    const res = await patchA(`/api/gaffer/projects/${projectId}`)
      .send({ clientPlanAmount: "99000" });
    expect(res.status).toBe(200);
    expect(res.body.project.clientPlanAmount).toBe("99000");
  });

  it("PATCH с чужим clientId → 404", async () => {
    const resB = await postB("/api/gaffer/contacts").send({ type: "CLIENT", name: "Клиент B для PATCH" });
    const foreignId = resB.body.contact.id as string;
    const res = await patchA(`/api/gaffer/projects/${projectId}`).send({ clientId: foreignId });
    expect(res.status).toBe(404);
  });

  it("PATCH несуществующего проекта → 404", async () => {
    const res = await patchA("/api/gaffer/projects/nonexistent-id").send({ title: "x" });
    expect(res.status).toBe(404);
  });
});

// ─── Архивация ────────────────────────────────────────────────────────────────

describe("Архивация проектов", () => {
  let projectId: string;

  beforeAll(async () => {
    // clientPlanAmount: "0" чтобы не было долга клиента и архивация не блокировалась
    const p = await createProjectA({ title: "Для архивации", clientPlanAmount: "0" });
    projectId = p.id;
  });

  it("POST /:id/archive → status=ARCHIVED", async () => {
    const res = await postA(`/api/gaffer/projects/${projectId}/archive`);
    expect(res.status).toBe(200);
    expect(res.body.project.status).toBe("ARCHIVED");
  });

  it("POST /:id/archive идемпотентен", async () => {
    const res = await postA(`/api/gaffer/projects/${projectId}/archive`);
    expect(res.status).toBe(200);
    expect(res.body.project.status).toBe("ARCHIVED");
  });

  it("POST /:id/unarchive → status=OPEN", async () => {
    const res = await postA(`/api/gaffer/projects/${projectId}/unarchive`);
    expect(res.status).toBe(200);
    expect(res.body.project.status).toBe("OPEN");
  });

  it("POST /:id/unarchive идемпотентен", async () => {
    const res = await postA(`/api/gaffer/projects/${projectId}/unarchive`);
    expect(res.status).toBe(200);
    expect(res.body.project.status).toBe("OPEN");
  });
});

// ─── Удаление ─────────────────────────────────────────────────────────────────

describe("Удаление проектов", () => {
  it("DELETE удаляет проект → 204", async () => {
    const p = await createProjectA({ title: "Удаляемый проект" });
    const res = await deleteA(`/api/gaffer/projects/${p.id}`);
    expect(res.status).toBe(204);

    const check = await getA(`/api/gaffer/projects/${p.id}`);
    expect(check.status).toBe(404);
  });

  it("DELETE несуществующего проекта → 404", async () => {
    const res = await deleteA("/api/gaffer/projects/nonexistent-id");
    expect(res.status).toBe(404);
  });
});

// ─── Cross-tenant изоляция ────────────────────────────────────────────────────

describe("Cross-tenant изоляция (проекты)", () => {
  let projectIdA: string;

  beforeAll(async () => {
    const p = await createProjectA({ title: "Эксклюзивный проект A" });
    projectIdA = p.id;
  });

  it("Tenant B не видит проекты tenant A в списке", async () => {
    const resA = await getA("/api/gaffer/projects");
    const resB = await getB("/api/gaffer/projects");

    const idsA = resA.body.items.map((p: Record<string, unknown>) => p.id);
    const idsB = resB.body.items.map((p: Record<string, unknown>) => p.id);

    for (const id of idsA) {
      expect(idsB).not.toContain(id);
    }
  });

  it("Tenant B GET /:id для проекта A → 404", async () => {
    const res = await getB(`/api/gaffer/projects/${projectIdA}`);
    expect(res.status).toBe(404);
  });

  it("Tenant B PATCH /:id для проекта A → 404", async () => {
    const res = await patchB(`/api/gaffer/projects/${projectIdA}`).send({ title: "Взлом" });
    expect(res.status).toBe(404);
  });

  it("Tenant B DELETE /:id для проекта A → 404", async () => {
    const res = await deleteB(`/api/gaffer/projects/${projectIdA}`);
    expect(res.status).toBe(404);
  });
});

// ─── Агрегаты долга ───────────────────────────────────────────────────────────

describe("Агрегаты долга", () => {
  let projectId: string;
  let clientId: string;
  let memberId: string;

  beforeAll(async () => {
    clientId = await createClientA("Клиент для агрегатов");
    memberId = await createMemberA("Техник для агрегатов");

    const res = await postA("/api/gaffer/projects").send({
      title: "Проект для агрегатов",
      clientId,
      shootDate: "2025-12-01",
      clientPlanAmount: "100000",
    });
    projectId = res.body.project.id as string;

    // Добавляем участника
    await postA(`/api/gaffer/projects/${projectId}/members`).send({
      contactId: memberId,
      plannedAmount: "30000",
      roleLabel: "осветитель",
    });

    // Создаём платёж IN
    await postA("/api/gaffer/payments").send({
      projectId,
      direction: "IN",
      amount: "40000",
      paidAt: "2025-12-05",
    });

    // Создаём платёж OUT
    await postA("/api/gaffer/payments").send({
      projectId,
      direction: "OUT",
      amount: "15000",
      paidAt: "2025-12-06",
      memberId,
    });
  });

  it("GET /:id clientReceived = сумма IN", async () => {
    const res = await getA(`/api/gaffer/projects/${projectId}`);
    expect(res.status).toBe(200);
    expect(res.body.project.clientReceived).toBe("40000");
  });

  it("GET /:id clientRemaining = clientPlanAmount - clientReceived", async () => {
    const res = await getA(`/api/gaffer/projects/${projectId}`);
    expect(res.body.project.clientRemaining).toBe("60000"); // 100000 - 40000
  });

  it("GET /:id teamPlanTotal = сумма plannedAmount участников", async () => {
    const res = await getA(`/api/gaffer/projects/${projectId}`);
    expect(res.body.project.teamPlanTotal).toBe("30000");
  });

  it("GET /:id teamPaidTotal = сумма OUT", async () => {
    const res = await getA(`/api/gaffer/projects/${projectId}`);
    expect(res.body.project.teamPaidTotal).toBe("15000");
  });

  it("GET /:id teamRemaining = teamPlanTotal - teamPaidTotal", async () => {
    const res = await getA(`/api/gaffer/projects/${projectId}`);
    expect(res.body.project.teamRemaining).toBe("15000"); // 30000 - 15000
  });

  it("GET list также возвращает агрегаты", async () => {
    const res = await getA("/api/gaffer/projects?search=Проект для агрегатов");
    expect(res.status).toBe(200);
    const item = res.body.items.find((p: Record<string, unknown>) => p.id === projectId);
    expect(item.clientReceived).toBe("40000");
    expect(item.teamRemaining).toBe("15000");
  });
});

// ─── Фильтры clientId / memberContactId ──────────────────────────────────────

describe("Фильтр по clientId и memberContactId", () => {
  let clientId: string;
  let memberId: string;
  let projectId: string;

  beforeAll(async () => {
    clientId = await createClientA("Клиент для фильтра");
    memberId = await createMemberA("Техник для фильтра");

    const res = await postA("/api/gaffer/projects").send({
      title: "Проект с конкретным клиентом",
      clientId,
      shootDate: "2026-01-10",
    });
    projectId = res.body.project.id as string;

    await postA(`/api/gaffer/projects/${projectId}/members`).send({
      contactId: memberId,
      plannedAmount: "10000",
    });
  });

  it("GET ?clientId=<id> возвращает только проекты этого клиента", async () => {
    const res = await getA(`/api/gaffer/projects?clientId=${clientId}`);
    expect(res.status).toBe(200);
    for (const item of res.body.items) {
      expect(item.clientId).toBe(clientId);
    }
    expect(res.body.items.some((p: Record<string, unknown>) => p.id === projectId)).toBe(true);
  });

  it("GET ?memberContactId=<id> возвращает проекты с этим участником", async () => {
    const res = await getA(`/api/gaffer/projects?memberContactId=${memberId}`);
    expect(res.status).toBe(200);
    expect(res.body.items.some((p: Record<string, unknown>) => p.id === projectId)).toBe(true);
  });
});

// ─── lightBudgetAmount ────────────────────────────────────────────────────────

describe("lightBudgetAmount", () => {
  it("POST создаёт проект с lightBudgetAmount, GET возвращает его", async () => {
    const clientId = await createClientA("Клиент для lightBudget");
    const res = await postA("/api/gaffer/projects").send({
      title: "Проект с бюджетом на свет",
      clientId,
      shootDate: "2026-03-01",
      clientPlanAmount: "30000",
      lightBudgetAmount: "20000",
    });
    expect(res.status).toBe(200);
    expect(res.body.project.lightBudgetAmount).toBe("20000");

    const get = await getA(`/api/gaffer/projects/${res.body.project.id as string}`);
    expect(get.status).toBe(200);
    expect(get.body.project.lightBudgetAmount).toBe("20000");
  });

  it("PATCH обновляет lightBudgetAmount", async () => {
    const p = await createProjectA({ title: "Обновить lightBudget" });
    const res = await patchA(`/api/gaffer/projects/${p.id}`)
      .send({ lightBudgetAmount: "55000" });
    expect(res.status).toBe(200);
    expect(res.body.project.lightBudgetAmount).toBe("55000");
  });

  it("clientTotal = clientPlanAmount, не зависит от lightBudgetAmount", async () => {
    const clientId = await createClientA("Клиент для суммарного долга");
    const res = await postA("/api/gaffer/projects").send({
      title: "Проект суммарный бюджет",
      clientId,
      shootDate: "2026-04-01",
      clientPlanAmount: "50000",
      lightBudgetAmount: "30000",
    });
    const projectId = res.body.project.id as string;

    // Вносим IN-платёж 40000
    await postA("/api/gaffer/payments").send({
      projectId,
      direction: "IN",
      amount: "40000",
      paidAt: "2026-04-02",
    });

    const get = await getA(`/api/gaffer/projects/${projectId}`);
    expect(get.status).toBe(200);
    // clientTotal = clientPlanAmount = 50000 (lightBudgetAmount не входит в доход — это стоимость)
    // clientRemaining = 50000 - 40000 = 10000
    expect(get.body.project.clientTotal).toBe("50000");
    expect(get.body.project.clientRemaining).toBe("10000");
  });
});
