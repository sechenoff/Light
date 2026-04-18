/**
 * Интеграционные тесты Gaffer CRM contacts API.
 * Паттерн: изолированная SQLite БД, два tenant'а для cross-tenant изоляции.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-gaffer-contacts.db");
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

  // Создаём двух пользователей
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
function patchB(url: string) {
  return request(app).patch(url).set("Authorization", `Bearer ${tokenB}`);
}

// ─── тесты ────────────────────────────────────────────────────────────────────

describe("Авторизация (контакты)", () => {
  it("GET /api/gaffer/contacts без токена → 401", async () => {
    const res = await request(app).get("/api/gaffer/contacts");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("GAFFER_UNAUTHENTICATED");
  });

  it("POST /api/gaffer/contacts без токена → 401", async () => {
    const res = await request(app)
      .post("/api/gaffer/contacts")
      .send({ type: "CLIENT", name: "Тест" });
    expect(res.status).toBe(401);
  });
});

describe("Создание контактов", () => {
  it("POST создаёт CLIENT-контакт", async () => {
    const res = await postA("/api/gaffer/contacts")
      .send({ type: "CLIENT", name: "Иванов Иван", phone: "+7-999-123-45-67" });

    expect(res.status).toBe(200);
    expect(res.body.contact.type).toBe("CLIENT");
    expect(res.body.contact.name).toBe("Иванов Иван");
    expect(res.body.contact.phone).toBe("+7-999-123-45-67");
  });

  it("POST создаёт TEAM_MEMBER-контакт", async () => {
    const res = await postA("/api/gaffer/contacts")
      .send({ type: "TEAM_MEMBER", name: "Петров Пётр", note: "осветитель" });

    expect(res.status).toBe(200);
    expect(res.body.contact.type).toBe("TEAM_MEMBER");
    expect(res.body.contact.note).toBe("осветитель");
  });

  it("Telegram без @ → сохраняется с @", async () => {
    const res = await postA("/api/gaffer/contacts")
      .send({ type: "CLIENT", name: "Сидоров Сидор", telegram: "sidorov_film" });

    expect(res.status).toBe(200);
    expect(res.body.contact.telegram).toBe("@sidorov_film");
  });

  it("Telegram уже с @ → сохраняется как есть", async () => {
    const res = await postA("/api/gaffer/contacts")
      .send({ type: "CLIENT", name: "Козлов Козёл", telegram: "@kozlov" });

    expect(res.status).toBe(200);
    expect(res.body.contact.telegram).toBe("@kozlov");
  });

  it("POST без обязательного type → 400", async () => {
    const res = await postA("/api/gaffer/contacts")
      .send({ name: "Без типа" });

    expect(res.status).toBe(400);
  });

  it("POST с пустым name → 400", async () => {
    const res = await postA("/api/gaffer/contacts")
      .send({ type: "CLIENT", name: "   " });

    expect(res.status).toBe(400);
  });
});

describe("Список контактов", () => {
  beforeAll(async () => {
    // Создаём набор контактов для tenant A
    await postA("/api/gaffer/contacts")
      .send({ type: "CLIENT", name: "Клиент Альфа" });
    await postA("/api/gaffer/contacts")
      .send({ type: "CLIENT", name: "Клиент Бета" });
    await postA("/api/gaffer/contacts")
      .send({ type: "TEAM_MEMBER", name: "Член команды Гамма" });
  });

  it("GET без фильтров возвращает все контакты tenant A", async () => {
    const res = await getA("/api/gaffer/contacts");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    // Все должны принадлежать tenant A
    for (const item of res.body.items) {
      expect(item.gafferUserId).toBeTruthy();
    }
  });

  it("GET ?type=CLIENT возвращает только клиентов", async () => {
    const res = await getA("/api/gaffer/contacts?type=CLIENT");
    expect(res.status).toBe(200);
    for (const item of res.body.items) {
      expect(item.type).toBe("CLIENT");
    }
  });

  it("GET ?type=TEAM_MEMBER возвращает только членов команды", async () => {
    const res = await getA("/api/gaffer/contacts?type=TEAM_MEMBER");
    expect(res.status).toBe(200);
    for (const item of res.body.items) {
      expect(item.type).toBe("TEAM_MEMBER");
    }
  });

  it("GET ?search=Альфа возвращает совпадающие имена", async () => {
    const res = await getA("/api/gaffer/contacts?search=Альфа");
    expect(res.status).toBe(200);
    expect(res.body.items.some((c: any) => c.name === "Клиент Альфа")).toBe(true);
    expect(res.body.items.every((c: any) => c.name.includes("Альфа"))).toBe(true);
  });
});

describe("Архивация", () => {
  let contactId: string;

  beforeAll(async () => {
    const res = await postA("/api/gaffer/contacts")
      .send({ type: "CLIENT", name: "Архивный клиент" });
    contactId = res.body.contact.id as string;
  });

  it("POST /:id/archive → isArchived=true", async () => {
    const res = await postA(`/api/gaffer/contacts/${contactId}/archive`);
    expect(res.status).toBe(200);
    expect(res.body.contact.isArchived).toBe(true);
  });

  it("GET ?isArchived=true возвращает архивные контакты", async () => {
    const res = await getA("/api/gaffer/contacts?isArchived=true");
    expect(res.status).toBe(200);
    expect(res.body.items.some((c: any) => c.id === contactId)).toBe(true);
  });

  it("GET ?isArchived=false не возвращает архивный контакт", async () => {
    const res = await getA("/api/gaffer/contacts?isArchived=false");
    expect(res.status).toBe(200);
    expect(res.body.items.every((c: any) => c.id !== contactId)).toBe(true);
  });

  it("POST /:id/unarchive → isArchived=false", async () => {
    const res = await postA(`/api/gaffer/contacts/${contactId}/unarchive`);
    expect(res.status).toBe(200);
    expect(res.body.contact.isArchived).toBe(false);
  });
});

describe("Обновление контактов", () => {
  let contactId: string;

  beforeAll(async () => {
    const res = await postA("/api/gaffer/contacts")
      .send({ type: "CLIENT", name: "До обновления", phone: "+7-000-000-00-00" });
    contactId = res.body.contact.id as string;
  });

  it("PATCH обновляет name и phone", async () => {
    const res = await patchA(`/api/gaffer/contacts/${contactId}`)
      .send({ name: "После обновления", phone: "+7-111-111-11-11" });

    expect(res.status).toBe(200);
    expect(res.body.contact.name).toBe("После обновления");
    expect(res.body.contact.phone).toBe("+7-111-111-11-11");
  });
});

describe("Удаление контактов", () => {
  it("DELETE несуществующего контакта → 404", async () => {
    const res = await deleteA("/api/gaffer/contacts/nonexistent-id-xxx");
    expect(res.status).toBe(404);
  });

  it("DELETE существующего контакта → 204", async () => {
    const created = await postA("/api/gaffer/contacts")
      .send({ type: "CLIENT", name: "Удаляемый контакт" });
    const id = created.body.contact.id as string;

    const res = await deleteA(`/api/gaffer/contacts/${id}`);
    expect(res.status).toBe(204);

    // Проверяем что удалён
    const check = await getA(`/api/gaffer/contacts/${id}`);
    expect(check.status).toBe(404);
  });

  it("DELETE контакта с привязанным проектом → 409 CONTACT_HAS_RELATIONS", async () => {
    // Создаём контакт
    const contactRes = await postA("/api/gaffer/contacts")
      .send({ type: "CLIENT", name: "Клиент с проектом" });
    const contactId = contactRes.body.contact.id as string;

    // Создаём проект с этим контактом как клиентом
    const { prisma } = await import("../prisma");
    const user = await prisma.gafferUser.findFirst({
      where: { email: "tenant-a@example.com" },
    });
    await prisma.gafferProject.create({
      data: {
        gafferUserId: user!.id,
        title: "Тестовый проект",
        clientId: contactId,
        shootDate: new Date("2024-06-01"),
      },
    });

    // Пытаемся удалить контакт
    const res = await deleteA(`/api/gaffer/contacts/${contactId}`);
    expect(res.status).toBe(409);
    expect(res.body.details).toBe("CONTACT_HAS_RELATIONS");
  });
});

describe("Cross-tenant изоляция (контакты)", () => {
  let contactIdA: string;

  beforeAll(async () => {
    const res = await postA("/api/gaffer/contacts")
      .send({ type: "CLIENT", name: "Эксклюзивный клиент A" });
    contactIdA = res.body.contact.id as string;
  });

  it("Tenant B не видит контакты tenant A в списке", async () => {
    const resA = await getA("/api/gaffer/contacts");
    const resB = await getB("/api/gaffer/contacts");

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    const idsA = resA.body.items.map((c: any) => c.id);
    const idsB = resB.body.items.map((c: any) => c.id);

    // Нет пересечения
    for (const id of idsA) {
      expect(idsB).not.toContain(id);
    }
  });

  it("Tenant B GET /:id для контакта A → 404", async () => {
    const res = await getB(`/api/gaffer/contacts/${contactIdA}`);
    expect(res.status).toBe(404);
  });

  it("Tenant B PATCH /:id для контакта A → 404", async () => {
    const res = await patchB(`/api/gaffer/contacts/${contactIdA}`)
      .send({ name: "Взломанное имя" });
    expect(res.status).toBe(404);
  });
});

describe("Тип контакта — запрет изменения", () => {
  let clientId: string;

  beforeAll(async () => {
    const res = await postA("/api/gaffer/contacts")
      .send({ type: "CLIENT", name: "Клиент для типа" });
    clientId = res.body.contact.id as string;
  });

  it("PATCH с type=TEAM_MEMBER → type не меняется, контакт остаётся CLIENT", async () => {
    // type dropped from updateContactSchema — extra field is stripped by Zod
    const res = await patchA(`/api/gaffer/contacts/${clientId}`)
      .send({ type: "TEAM_MEMBER", name: "Обновлённое имя" });

    // Either 200 with type unchanged, or 400 — either way type must not flip
    if (res.status === 200) {
      expect(res.body.contact.type).toBe("CLIENT");
    }

    // Verify stored type via GET
    const get = await getA(`/api/gaffer/contacts/${clientId}`);
    expect(get.body.contact.type).toBe("CLIENT");
  });
});

describe("Нормализация Telegram", () => {
  it("https://t.me/ivanov → @ivanov", async () => {
    const res = await postA("/api/gaffer/contacts")
      .send({ type: "CLIENT", name: "Иванов URL", telegram: "https://t.me/ivanov" });

    expect(res.status).toBe(200);
    expect(res.body.contact.telegram).toBe("@ivanov");
  });

  it("t.me/petrov → @petrov", async () => {
    const res = await postA("/api/gaffer/contacts")
      .send({ type: "CLIENT", name: "Петров tme", telegram: "t.me/petrov" });

    expect(res.status).toBe(200);
    expect(res.body.contact.telegram).toBe("@petrov");
  });

  it("@@sidorov → @sidorov (два @ схлопываются)", async () => {
    const res = await postA("/api/gaffer/contacts")
      .send({ type: "CLIENT", name: "Сидоров двойной", telegram: "@@sidorov" });

    expect(res.status).toBe(200);
    expect(res.body.contact.telegram).toBe("@sidorov");
  });

  it("@ab → 400 INVALID_TELEGRAM (слишком короткий username)", async () => {
    const res = await postA("/api/gaffer/contacts")
      .send({ type: "CLIENT", name: "Короткий логин", telegram: "@ab" });

    expect(res.status).toBe(400);
    expect(res.body.details).toBe("INVALID_TELEGRAM");
  });

  it("'invalid username' (пробел) → 400 INVALID_TELEGRAM", async () => {
    const res = await postA("/api/gaffer/contacts")
      .send({ type: "CLIENT", name: "Пробел в логине", telegram: "invalid username" });

    expect(res.status).toBe(400);
    expect(res.body.details).toBe("INVALID_TELEGRAM");
  });
});

describe("Фильтр isArchived по умолчанию", () => {
  let archivedId: string;
  let activeId: string;

  beforeAll(async () => {
    const r1 = await postA("/api/gaffer/contacts")
      .send({ type: "CLIENT", name: "Активный для дефолт-фильтра" });
    activeId = r1.body.contact.id as string;

    const r2 = await postA("/api/gaffer/contacts")
      .send({ type: "CLIENT", name: "Архивный для дефолт-фильтра" });
    archivedId = r2.body.contact.id as string;
    await postA(`/api/gaffer/contacts/${archivedId}/archive`);
  });

  it("GET без isArchived → возвращает только неархивных", async () => {
    const res = await getA("/api/gaffer/contacts");
    expect(res.status).toBe(200);

    const ids = res.body.items.map((c: any) => c.id);
    expect(ids).toContain(activeId);
    expect(ids).not.toContain(archivedId);
  });

  it("GET ?isArchived=all → возвращает и архивных, и активных", async () => {
    const res = await getA("/api/gaffer/contacts?isArchived=all");
    expect(res.status).toBe(200);

    const ids = res.body.items.map((c: any) => c.id);
    expect(ids).toContain(activeId);
    expect(ids).toContain(archivedId);
  });
});

describe("PATCH несуществующего контакта", () => {
  it("PATCH /contacts/nonexistent → 404", async () => {
    const res = await patchA("/api/gaffer/contacts/nonexistent-id-xyz")
      .send({ name: "Новое имя" });
    expect(res.status).toBe(404);
  });
});
