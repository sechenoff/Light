/**
 * B4 — тесты POST /api/finance/debts/:clientId/mark-reminded
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import Decimal from "decimal.js";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-debts-mark-reminded.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-mark-reminded";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-mr";
process.env.WAREHOUSE_SECRET = "test-wh-mr";
process.env.JWT_SECRET = "test-jwt-secret-mark-reminded-min16chars";

let app: Express;
let prisma: any;
let superAdminToken: string;
let clientId: string;

function AUTH_SA() {
  return { "X-API-Key": "test-key-mark-reminded", Authorization: `Bearer ${superAdminToken}` };
}

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
  const pmod = await import("../prisma");
  prisma = pmod.prisma;

  const { hashPassword, signSession } = await import("../services/auth");
  const hash = await hashPassword("pass");
  const admin = await prisma.adminUser.create({
    data: { username: "mr_super", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  superAdminToken = signSession({ userId: admin.id, username: admin.username, role: "SUPER_ADMIN" });

  const client = await prisma.client.create({
    data: { name: "Клиент для Напоминания" },
  });
  clientId = client.id;
});

afterAll(async () => {
  await prisma.$disconnect();
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = TEST_DB_PATH + suffix;
    if (fs.existsSync(f)) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }
});

describe("POST /api/finance/debts/:clientId/mark-reminded", () => {
  it("первое напоминание — устанавливает lastReminderAt", async () => {
    // Проверяем что изначально lastReminderAt = null
    const clientBefore = await prisma.client.findUnique({ where: { id: clientId } });
    expect(clientBefore.lastReminderAt).toBeNull();

    const before = Date.now();
    const res = await request(app)
      .post(`/api/finance/debts/${clientId}/mark-reminded`)
      .set(AUTH_SA());

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.lastReminderAt).toBeTruthy();
    const after = Date.now();

    // Проверяем что timestamp разумный
    const ts = new Date(res.body.lastReminderAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after + 1000);

    // Проверяем в БД
    const clientAfter = await prisma.client.findUnique({ where: { id: clientId } });
    expect(clientAfter.lastReminderAt).not.toBeNull();

    // Проверяем что audit-запись создана
    const auditEntry = await prisma.auditEntry.findFirst({
      where: { entityType: "Client", entityId: clientId, action: "CLIENT_REMINDED" },
      orderBy: { createdAt: "desc" },
    });
    expect(auditEntry).not.toBeNull();
    expect(auditEntry.action).toBe("CLIENT_REMINDED");
  });

  it("повторное напоминание в рамках 14 дней — обновляет lastReminderAt", async () => {
    const resBefore = await prisma.client.findUnique({ where: { id: clientId } });
    const firstReminderAt = resBefore.lastReminderAt;
    expect(firstReminderAt).not.toBeNull();

    // Немного подождём чтобы timestamp был другим
    await new Promise((r) => setTimeout(r, 10));

    const res = await request(app)
      .post(`/api/finance/debts/${clientId}/mark-reminded`)
      .set(AUTH_SA());

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Новый timestamp должен быть >= предыдущему
    const newTs = new Date(res.body.lastReminderAt).getTime();
    expect(newTs).toBeGreaterThanOrEqual(firstReminderAt.getTime());
  });

  it("возвращает 404 для несуществующего клиента", async () => {
    const res = await request(app)
      .post("/api/finance/debts/nonexistent-client-xyz/mark-reminded")
      .set(AUTH_SA());

    expect(res.status).toBe(404);
  });

  it("возвращает 401 без авторизации", async () => {
    const res = await request(app)
      .post(`/api/finance/debts/${clientId}/mark-reminded`)
      .set({ "X-API-Key": "test-key-mark-reminded" }); // без Bearer token

    expect(res.status).toBe(401);
  });
});
