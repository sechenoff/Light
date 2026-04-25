/**
 * Интеграционные тесты маршрутов /api/settings/organization.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-org-settings.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-org";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-org";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-org";
process.env.JWT_SECRET = "test-jwt-secret-orgsettings-min16";

let app: Express;
let prisma: any;
let saToken: string;
let whToken: string;

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
  const hash = await hashPassword("test-pass");

  const sa = await prisma.adminUser.create({
    data: { username: "org_sa", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  saToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });

  const wh = await prisma.adminUser.create({
    data: { username: "org_wh", passwordHash: hash, role: "WAREHOUSE" },
  });
  whToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });
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

function SA() { return { "X-API-Key": "test-key-org", Authorization: `Bearer ${saToken}` }; }
function WH() { return { "X-API-Key": "test-key-org", Authorization: `Bearer ${whToken}` }; }

describe("GET /api/settings/organization", () => {
  it("SA: получает настройки организации (создаёт singleton по умолчанию)", async () => {
    const res = await request(app).get("/api/settings/organization").set(SA());
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("singleton");
    expect(res.body.invoiceNumberPrefix).toBeTruthy();
  });

  it("WH: нет доступа → 403", async () => {
    const res = await request(app).get("/api/settings/organization").set(WH());
    expect(res.status).toBe(403);
  });
});

describe("PATCH /api/settings/organization", () => {
  it("SA: обновляет реквизиты организации", async () => {
    const res = await request(app)
      .patch("/api/settings/organization")
      .set(SA())
      .send({
        legalName: "ООО Световая База",
        inn: "7712345678",
        invoiceNumberPrefix: "SB",
        bankName: "Сбербанк",
      });

    expect(res.status).toBe(200);
    expect(res.body.legalName).toBe("ООО Световая База");
    expect(res.body.inn).toBe("7712345678");
    expect(res.body.invoiceNumberPrefix).toBe("SB");
    expect(res.body.bankName).toBe("Сбербанк");
  });

  it("невалидный ИНН → 400", async () => {
    const res = await request(app)
      .patch("/api/settings/organization")
      .set(SA())
      .send({ inn: "123" }); // not 10 or 12 digits

    expect(res.status).toBe(400);
  });

  it("WH: нет доступа → 403", async () => {
    const res = await request(app)
      .patch("/api/settings/organization")
      .set(WH())
      .send({ legalName: "Попытка WH" });

    expect(res.status).toBe(403);
  });
});
