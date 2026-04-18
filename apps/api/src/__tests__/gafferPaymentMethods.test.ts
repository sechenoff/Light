/**
 * Интеграционные тесты Gaffer CRM payment-methods API.
 * Паттерн: изолированная SQLite БД, два tenant'а для cross-tenant изоляции.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-gaffer-payment-methods.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-gaffer-pm-key";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.GAFFER_SESSION_SECRET = "gaffer-pm-test-secret-min16chars-ok";
process.env.JWT_SECRET = "test-jwt-secret-pm-min16chars-gaffer";
process.env.BARCODE_SECRET = "test-barcode-secret-pm-gaffer";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-pm-gaffer";

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
    .send({ email: "pm-tenant-a@example.com" });
  tokenA = resA.body.token as string;

  const resB = await request(app)
    .post("/api/gaffer/auth/login")
    .send({ email: "pm-tenant-b@example.com" });
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
function postB(url: string) {
  return request(app).post(url).set("Authorization", `Bearer ${tokenB}`);
}
function getB(url: string) {
  return request(app).get(url).set("Authorization", `Bearer ${tokenB}`);
}

// ─── тесты ────────────────────────────────────────────────────────────────────

describe("Авторизация (payment-methods)", () => {
  it("GET /api/gaffer/payment-methods без токена → 401", async () => {
    const res = await request(app).get("/api/gaffer/payment-methods");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("GAFFER_UNAUTHENTICATED");
  });

  it("POST /api/gaffer/payment-methods без токена → 401", async () => {
    const res = await request(app)
      .post("/api/gaffer/payment-methods")
      .send({ name: "Тест" });
    expect(res.status).toBe(401);
  });
});

describe("Создание способов оплаты", () => {
  it("POST создаёт новый метод оплаты", async () => {
    const res = await postA("/api/gaffer/payment-methods")
      .send({ name: "Тинькофф карта" });

    expect(res.status).toBe(200);
    expect(res.body.item.name).toBe("Тинькофф карта");
    expect(res.body.item.isDefault).toBe(false);
  });

  it("POST c тем же именем для того же tenant'а → 409 PAYMENT_METHOD_NAME_TAKEN", async () => {
    await postA("/api/gaffer/payment-methods")
      .send({ name: "Сбер карта" });

    const res = await postA("/api/gaffer/payment-methods")
      .send({ name: "Сбер карта" });

    expect(res.status).toBe(409);
    expect(res.body.details).toBe("PAYMENT_METHOD_NAME_TAKEN");
  });

  it("POST с тем же именем у другого tenant'а → 200 (уникальность per-tenant)", async () => {
    // Сначала создаём у tenant A
    await postA("/api/gaffer/payment-methods")
      .send({ name: "Наличные" });

    // Тот же name у tenant B — должно работать
    const res = await postB("/api/gaffer/payment-methods")
      .send({ name: "Наличные" });

    expect(res.status).toBe(200);
    expect(res.body.item.name).toBe("Наличные");
  });

  it("POST c isDefault=true сбрасывает предыдущий default", async () => {
    // Создаём первый дефолтный
    const first = await postA("/api/gaffer/payment-methods")
      .send({ name: "Первый дефолт", isDefault: true });
    expect(first.body.item.isDefault).toBe(true);

    // Создаём второй дефолтный
    const second = await postA("/api/gaffer/payment-methods")
      .send({ name: "Второй дефолт", isDefault: true });
    expect(second.body.item.isDefault).toBe(true);

    // Проверяем, что у первого isDefault теперь false
    const list = await getA("/api/gaffer/payment-methods");
    const firstItem = list.body.items.find((m: any) => m.id === first.body.item.id);
    expect(firstItem.isDefault).toBe(false);
    // Второй остался дефолтным
    const secondItem = list.body.items.find((m: any) => m.id === second.body.item.id);
    expect(secondItem.isDefault).toBe(true);
  });

  it("POST без name → 400", async () => {
    const res = await postA("/api/gaffer/payment-methods")
      .send({});

    expect(res.status).toBe(400);
  });
});

describe("Обновление способов оплаты", () => {
  let methodId: string;
  let otherMethodId: string;

  beforeAll(async () => {
    const res1 = await postA("/api/gaffer/payment-methods")
      .send({ name: "Основной счёт", isDefault: true });
    methodId = res1.body.item.id as string;

    const res2 = await postA("/api/gaffer/payment-methods")
      .send({ name: "Запасной счёт" });
    otherMethodId = res2.body.item.id as string;
  });

  it("PATCH с isDefault=true сбрасывает другие", async () => {
    const res = await patchA(`/api/gaffer/payment-methods/${otherMethodId}`)
      .send({ isDefault: true });

    expect(res.status).toBe(200);
    expect(res.body.item.isDefault).toBe(true);

    const list = await getA("/api/gaffer/payment-methods");
    const mainItem = list.body.items.find((m: any) => m.id === methodId);
    expect(mainItem.isDefault).toBe(false);
  });

  it("PATCH обновляет name", async () => {
    const res = await patchA(`/api/gaffer/payment-methods/${methodId}`)
      .send({ name: "Обновлённый счёт" });

    expect(res.status).toBe(200);
    expect(res.body.item.name).toBe("Обновлённый счёт");
  });
});

describe("Удаление способов оплаты", () => {
  it("DELETE → 204, запись удалена из списка", async () => {
    const created = await postA("/api/gaffer/payment-methods")
      .send({ name: "Удаляемый метод" });
    const id = created.body.item.id as string;

    const del = await deleteA(`/api/gaffer/payment-methods/${id}`);
    expect(del.status).toBe(204);

    const list = await getA("/api/gaffer/payment-methods");
    expect(list.body.items.every((m: any) => m.id !== id)).toBe(true);
  });
});

describe("Переупорядочивание", () => {
  it("POST /reorder правильно переставляет sortOrder", async () => {
    // Создаём три метода
    const r1 = await postA("/api/gaffer/payment-methods")
      .send({ name: "Метод Первый" });
    const r2 = await postA("/api/gaffer/payment-methods")
      .send({ name: "Метод Второй" });
    const r3 = await postA("/api/gaffer/payment-methods")
      .send({ name: "Метод Третий" });

    const id1 = r1.body.item.id as string;
    const id2 = r2.body.item.id as string;
    const id3 = r3.body.item.id as string;

    // Переупорядочиваем: 3, 1, 2
    const res = await postA("/api/gaffer/payment-methods/reorder")
      .send({ ids: [id3, id1, id2] });

    expect(res.status).toBe(200);

    // Проверяем sortOrder
    const m3 = res.body.items.find((m: any) => m.id === id3);
    const m1 = res.body.items.find((m: any) => m.id === id1);
    const m2 = res.body.items.find((m: any) => m.id === id2);

    expect(m3.sortOrder).toBe(0);
    expect(m1.sortOrder).toBe(1);
    expect(m2.sortOrder).toBe(2);
  });

  it("POST /reorder с чужим id → 400", async () => {
    // Создаём метод у tenant B
    const bRes = await postB("/api/gaffer/payment-methods")
      .send({ name: "Чужой метод" });
    const foreignId = bRes.body.item.id as string;

    // Tenant A пытается переставить чужой id
    const myRes = await postA("/api/gaffer/payment-methods")
      .send({ name: "Мой метод для reorder" });
    const myId = myRes.body.item.id as string;

    const res = await postA("/api/gaffer/payment-methods/reorder")
      .send({ ids: [myId, foreignId] });

    expect(res.status).toBe(400);
  });
});

describe("Cross-tenant изоляция (payment-methods)", () => {
  it("GET возвращает только методы текущего tenant'а", async () => {
    const resA = await getA("/api/gaffer/payment-methods");
    const resB = await getB("/api/gaffer/payment-methods");

    const idsA = resA.body.items.map((m: any) => m.id);
    const idsB = resB.body.items.map((m: any) => m.id);

    for (const id of idsA) {
      expect(idsB).not.toContain(id);
    }
  });
});

describe("PATCH/DELETE несуществующих способов оплаты", () => {
  it("PATCH /payment-methods/nonexistent → 404", async () => {
    const res = await patchA("/api/gaffer/payment-methods/nonexistent-id-xyz")
      .send({ name: "Новое имя" });
    expect(res.status).toBe(404);
  });

  it("DELETE /payment-methods/nonexistent → 404", async () => {
    const res = await deleteA("/api/gaffer/payment-methods/nonexistent-id-xyz");
    expect(res.status).toBe(404);
  });
});

describe("Reorder: чужой id не влияет на его sortOrder", () => {
  it("Tenant A reorder с чужим id → 400; sortOrder способа tenant B не меняется", async () => {
    // Создаём метод у tenant B
    const bRes = await postB("/api/gaffer/payment-methods")
      .send({ name: "Метод Б для изоляции reorder" });
    const foreignId = bRes.body.item.id as string;

    // Получаем исходный sortOrder у B
    const beforeList = await getB("/api/gaffer/payment-methods");
    const bItemBefore = beforeList.body.items.find((m: any) => m.id === foreignId);

    // Tenant A пытается переставить: один свой + один чужой
    const aRes = await postA("/api/gaffer/payment-methods")
      .send({ name: "Мой метод для reorder изоляции" });
    const myId = aRes.body.item.id as string;

    const reorderRes = await postA("/api/gaffer/payment-methods/reorder")
      .send({ ids: [myId, foreignId] });

    expect(reorderRes.status).toBe(400);

    // Убедиться, что sortOrder у метода Б не изменился
    const afterList = await getB("/api/gaffer/payment-methods");
    const bItemAfter = afterList.body.items.find((m: any) => m.id === foreignId);
    expect(bItemAfter.sortOrder).toBe(bItemBefore.sortOrder);
  });
});
