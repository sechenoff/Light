/**
 * Интеграционные тесты Gaffer CRM auth: login / logout / me / complete-onboarding.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-gaffer-auth.db");
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

async function loginAs(email: string): Promise<{ token: string; userId: string }> {
  const res = await request(app)
    .post("/api/gaffer/auth/login")
    .send({ email });
  expect(res.status).toBe(200);
  return { token: res.body.token as string, userId: res.body.user.id as string };
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe("POST /api/gaffer/auth/login", () => {
  it("создаёт нового GafferUser и возвращает токен при первом входе", async () => {
    const res = await request(app)
      .post("/api/gaffer/auth/login")
      .send({ email: "newuser@example.com" });

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe("newuser@example.com");
    expect(typeof res.body.token).toBe("string");
    expect(res.body.token.length).toBeGreaterThan(0);
    // cookie должен быть выставлен
    expect(res.headers["set-cookie"]).toBeDefined();
    const cookies: string[] = Array.isArray(res.headers["set-cookie"])
      ? res.headers["set-cookie"]
      : [res.headers["set-cookie"]];
    expect(cookies.some((c) => c.startsWith("gaffer_session="))).toBe(true);
  });

  it("возвращает того же пользователя при повторном входе", async () => {
    const email = "repeat@example.com";
    const first = await request(app)
      .post("/api/gaffer/auth/login")
      .send({ email });
    const second = await request(app)
      .post("/api/gaffer/auth/login")
      .send({ email });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.user.id).toBe(second.body.user.id);
  });

  it("возвращает 400 при невалидном email", async () => {
    const res = await request(app)
      .post("/api/gaffer/auth/login")
      .send({ email: "not-an-email" });

    expect(res.status).toBe(400);
  });

  it("возвращает 400 при отсутствующем email", async () => {
    const res = await request(app)
      .post("/api/gaffer/auth/login")
      .send({});

    expect(res.status).toBe(400);
  });
});

describe("GET /api/gaffer/auth/me", () => {
  it("возвращает 401 без токена", async () => {
    const res = await request(app).get("/api/gaffer/auth/me");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("GAFFER_UNAUTHENTICATED");
  });

  it("возвращает пользователя по Bearer-токену", async () => {
    const { token } = await loginAs("bearer-test@example.com");

    const res = await request(app)
      .get("/api/gaffer/auth/me")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe("bearer-test@example.com");
  });

  it("возвращает пользователя по cookie", async () => {
    // login возвращает set-cookie, используем его в следующем запросе
    const loginRes = await request(app)
      .post("/api/gaffer/auth/login")
      .send({ email: "cookie-test@example.com" });

    const cookies: string[] = Array.isArray(loginRes.headers["set-cookie"])
      ? loginRes.headers["set-cookie"]
      : [loginRes.headers["set-cookie"]];
    const cookieHeader = cookies.join("; ");

    const res = await request(app)
      .get("/api/gaffer/auth/me")
      .set("Cookie", cookieHeader);

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe("cookie-test@example.com");
  });
});

describe("POST /api/gaffer/auth/complete-onboarding", () => {
  it("устанавливает onboardingCompletedAt для текущего пользователя", async () => {
    const { token } = await loginAs("onboarding@example.com");

    // до онбординга
    const meBefore = await request(app)
      .get("/api/gaffer/auth/me")
      .set("Authorization", `Bearer ${token}`);
    expect(meBefore.body.user.onboardingCompletedAt).toBeNull();

    // выполнить онбординг
    const res = await request(app)
      .post("/api/gaffer/auth/complete-onboarding")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.user.onboardingCompletedAt).not.toBeNull();

    // /me теперь тоже возвращает timestamp
    const meAfter = await request(app)
      .get("/api/gaffer/auth/me")
      .set("Authorization", `Bearer ${token}`);
    expect(meAfter.body.user.onboardingCompletedAt).not.toBeNull();
  });

  it("возвращает 401 без токена", async () => {
    const res = await request(app)
      .post("/api/gaffer/auth/complete-onboarding");
    expect(res.status).toBe(401);
  });
});

describe("POST /api/gaffer/auth/logout", () => {
  it("очищает cookie gaffer_session", async () => {
    const loginRes = await request(app)
      .post("/api/gaffer/auth/login")
      .send({ email: "logout-test@example.com" });
    expect(loginRes.status).toBe(200);

    const res = await request(app)
      .post("/api/gaffer/auth/logout");

    expect(res.status).toBe(204);
    // ответ содержит директиву очистки cookie
    const setCookies: string[] = Array.isArray(res.headers["set-cookie"])
      ? res.headers["set-cookie"]
      : (res.headers["set-cookie"] ? [res.headers["set-cookie"]] : []);
    const hasClear = setCookies.some(
      (c) => c.startsWith("gaffer_session=") && c.includes("Expires=Thu, 01 Jan 1970"),
    );
    expect(hasClear).toBe(true);
  });
});

describe("Изоляция пользователей", () => {
  it("GET /me с токеном пользователя A возвращает A, а не B", async () => {
    const { token: tokenA } = await loginAs("user-a@example.com");
    const { token: tokenB } = await loginAs("user-b@example.com");

    const resA = await request(app)
      .get("/api/gaffer/auth/me")
      .set("Authorization", `Bearer ${tokenA}`);
    const resB = await request(app)
      .get("/api/gaffer/auth/me")
      .set("Authorization", `Bearer ${tokenB}`);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(resA.body.user.email).toBe("user-a@example.com");
    expect(resB.body.user.email).toBe("user-b@example.com");
    expect(resA.body.user.id).not.toBe(resB.body.user.id);
  });
});
