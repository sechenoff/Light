/**
 * Сторожа трёх дыр, найденных аудитом доступа 2026-08.
 * Каждая из них умела отрасти незаметно, поэтому проверяем поведение, а не код.
 */
import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-security-hardening.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-security";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-security";
process.env.WAREHOUSE_SECRET = "test-warehouse-security-16ch";
process.env.JWT_SECRET = "test-jwt-security-min16chars";

let app: Express;
let prisma: any;
let saToken: string;
let victimId: string;
let victimToken: string;

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, DATABASE_URL: `file:${TEST_DB_PATH}`, PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes" },
    stdio: "pipe",
  });
  app = (await import("../app")).app;
  prisma = (await import("../prisma")).prisma;
  const { hashPassword, signSession } = await import("../services/auth");
  const hash = await hashPassword("pass-12345678");

  const sa = await prisma.adminUser.create({
    data: { username: "sec_sa", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  saToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });

  const victim = await prisma.adminUser.create({
    data: { username: "sec_victim", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  victimId = victim.id;
  victimToken = signSession({ userId: victim.id, username: victim.username, role: "SUPER_ADMIN" });

  await prisma.warehousePin.create({
    data: { name: "Тестовый кладовщик", pinHash: await hashPassword("123456"), isActive: true },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = TEST_DB_PATH + suffix;
    if (fs.existsSync(f)) { try { fs.unlinkSync(f); } catch { /* игнор */ } }
  }
});

const KEY = () => ({ "X-API-Key": "test-key-security" });

describe("экран входа киоска закрыт API-ключом", () => {
  it("список имён кладовщиков не отдаётся без ключа", async () => {
    const res = await request(app).get("/api/warehouse/workers/names");
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain("Тестовый кладовщик");
  });

  it("PIN нельзя перебирать анонимно", async () => {
    const res = await request(app).post("/api/warehouse/auth").send({ name: "Тестовый кладовщик", pin: "123456" });
    expect(res.status).toBe(401);
  });

  it("но киоск через прокси (с ключом) работает как раньше", async () => {
    const names = await request(app).get("/api/warehouse/workers/names").set(KEY());
    expect(names.status).toBe(200);
    expect(names.body.names).toContain("Тестовый кладовщик");

    const auth = await request(app)
      .post("/api/warehouse/auth")
      .set(KEY())
      .send({ name: "Тестовый кладовщик", pin: "123456" });
    expect(auth.status).toBe(200);
    expect(auth.body.token).toBeTruthy();
  });
});

describe("деактивация действует немедленно, а не через 7 дней", () => {
  it("живой токен перестаёт работать сразу после отключения пользователя", async () => {
    const before = await request(app).get("/api/auth/me").set(KEY()).set("Authorization", `Bearer ${victimToken}`);
    expect(before.status).toBe(200);

    await request(app)
      .patch(`/api/admin-users/${victimId}`)
      .set(KEY())
      .set("Authorization", `Bearer ${saToken}`)
      .send({ isActive: false })
      .expect(200);

    // Тот же самый токен — он всё ещё криптографически валиден и не истёк.
    const after = await request(app).get("/api/auth/me").set(KEY()).set("Authorization", `Bearer ${victimToken}`);
    expect(after.status).toBe(401);
  });

  it("понижение роли тоже действует сразу: токен не даёт прежних прав", async () => {
    const { signSession } = await import("../services/auth");
    const demoted = await prisma.adminUser.create({
      data: { username: "sec_demoted", passwordHash: "x", role: "SUPER_ADMIN" },
    });
    const token = signSession({ userId: demoted.id, username: demoted.username, role: "SUPER_ADMIN" });

    // Финансы доступны только руководителю — до понижения пускает.
    const before = await request(app).get("/api/finance/debts").set(KEY()).set("Authorization", `Bearer ${token}`);
    expect(before.status).toBe(200);

    await request(app)
      .patch(`/api/admin-users/${demoted.id}`)
      .set(KEY())
      .set("Authorization", `Bearer ${saToken}`)
      .send({ role: "TECHNICIAN" })
      .expect(200);

    // Токен по-прежнему утверждает SUPER_ADMIN, но роль берётся из базы.
    const after = await request(app).get("/api/finance/debts").set(KEY()).set("Authorization", `Bearer ${token}`);
    expect(after.status).toBe(403);
  });
});

describe("сид первого админа не заводит тривиальных паролей", () => {
  it("в скрипте не осталось захардкоженных паролей «тест»/«test»", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../scripts/seed-admin-users.ts"), "utf8");
    expect(src).not.toMatch(/"тест"|'тест'/);
    expect(src).not.toMatch(/ensureUser\(\s*["'][^"']+["']\s*,\s*["']test["']/);
    expect(src).toContain("ADMIN_PASSWORD");
  });

  it("деплой больше не запускает его автоматически", () => {
    const deploy = fs.readFileSync(path.resolve(__dirname, "../../../../deploy.sh"), "utf8");
    const active = deploy
      .split("\n")
      .filter((l) => l.includes("seed-admin-users.ts") && !l.trim().startsWith("#"));
    expect(active).toEqual([]);
  });
});
