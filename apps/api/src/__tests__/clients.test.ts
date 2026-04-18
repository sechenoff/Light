/**
 * Интеграционные тесты CRUD клиентов.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-clients.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-clients";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-clients";
process.env.JWT_SECRET = "test-jwt-secret-clients-min16chars";

let app: Express;
let prisma: any;
let superAdminToken: string;
let warehouseToken: string;
let technicianToken: string;
let superAdminId: string;

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
  const hash = await hashPassword("test-pass-123");

  const sa = await prisma.adminUser.create({
    data: { username: "cli_sa", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  superAdminId = sa.id;
  superAdminToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });

  const wh = await prisma.adminUser.create({
    data: { username: "cli_wh", passwordHash: hash, role: "WAREHOUSE" },
  });
  warehouseToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });

  const tech = await prisma.adminUser.create({
    data: { username: "cli_tech", passwordHash: hash, role: "TECHNICIAN" },
  });
  technicianToken = signSession({ userId: tech.id, username: tech.username, role: "TECHNICIAN" });
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

function AUTH_SA() { return { "X-API-Key": "test-key-1", Authorization: `Bearer ${superAdminToken}` }; }
function AUTH_WH() { return { "X-API-Key": "test-key-1", Authorization: `Bearer ${warehouseToken}` }; }
function AUTH_TECH() { return { "X-API-Key": "test-key-1", Authorization: `Bearer ${technicianToken}` }; }

describe("GET /api/clients", () => {
  it("SA returns 200 with clients list", async () => {
    await prisma.client.createMany({
      data: [
        { name: "Альфа Студио" },
        { name: "Бета Фильмз" },
      ],
    });

    const res = await request(app)
      .get("/api/clients")
      .set(AUTH_SA());

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.clients)).toBe(true);
    const names = res.body.clients.map((c: any) => c.name);
    expect(names).toContain("Альфа Студио");
    expect(names).toContain("Бета Фильмз");
    // Check enriched fields
    const alfa = res.body.clients.find((c: any) => c.name === "Альфа Студио");
    expect(alfa).toHaveProperty("id");
    expect(alfa).toHaveProperty("bookingCount");
    expect(alfa).toHaveProperty("createdAt");
  });

  it("WAREHOUSE returns 200", async () => {
    const res = await request(app)
      .get("/api/clients")
      .set(AUTH_WH());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.clients)).toBe(true);
  });

  it("TECHNICIAN returns 403", async () => {
    const res = await request(app)
      .get("/api/clients")
      .set(AUTH_TECH());
    expect(res.status).toBe(403);
  });

  it("search filters by name substring", async () => {
    await prisma.client.create({ data: { name: "Иванов Продакшн" } });

    const res = await request(app)
      .get("/api/clients?search=Иванов")
      .set(AUTH_SA());

    expect(res.status).toBe(200);
    const names = res.body.clients.map((c: any) => c.name);
    expect(names).toContain("Иванов Продакшн");
  });
});

describe("POST /api/clients", () => {
  it("SA creates client, response includes id, audit CLIENT_CREATE written", async () => {
    const res = await request(app)
      .post("/api/clients")
      .set(AUTH_SA())
      .send({ name: "Новый Клиент", phone: "+7 999 000 00 01", email: "new@client.ru" });

    expect(res.status).toBe(201);
    expect(res.body.client).toHaveProperty("id");
    expect(res.body.client.name).toBe("Новый Клиент");
    expect(res.body.client.bookingCount).toBe(0);

    const dbClient = await prisma.client.findUnique({ where: { id: res.body.client.id } });
    expect(dbClient).not.toBeNull();

    const audit = await prisma.auditEntry.findFirst({
      where: { entityId: res.body.client.id, action: "CLIENT_CREATE" },
    });
    expect(audit).not.toBeNull();
    expect(audit!.entityType).toBe("Client");
    expect(audit!.userId).toBe(superAdminId);
  });

  it("WAREHOUSE returns 403", async () => {
    const res = await request(app)
      .post("/api/clients")
      .set(AUTH_WH())
      .send({ name: "Попытка Кладовщика" });
    expect(res.status).toBe(403);
  });

  it("duplicate name returns 409 CLIENT_NAME_TAKEN", async () => {
    await prisma.client.create({ data: { name: "Уникальный Клиент" } });
    const res = await request(app)
      .post("/api/clients")
      .set(AUTH_SA())
      .send({ name: "Уникальный Клиент" });
    expect(res.status).toBe(409);
    expect(res.body.details).toBe("CLIENT_NAME_TAKEN");
  });

  it("invalid email returns 400", async () => {
    const res = await request(app)
      .post("/api/clients")
      .set(AUTH_SA())
      .send({ name: "Клиент с Email", email: "not-an-email" });
    expect(res.status).toBe(400);
  });

  it("empty string email becomes undefined (no validation error)", async () => {
    const res = await request(app)
      .post("/api/clients")
      .set(AUTH_SA())
      .send({ name: "Клиент Без Email", email: "" });
    expect(res.status).toBe(201);
    expect(res.body.client.email).toBeNull();
  });
});

describe("PATCH /api/clients/:id", () => {
  it("SA updates name, audit CLIENT_UPDATE has before/after", async () => {
    const client = await prisma.client.create({ data: { name: "Старое Имя" } });

    const res = await request(app)
      .patch(`/api/clients/${client.id}`)
      .set(AUTH_SA())
      .send({ name: "Новое Имя" });

    expect(res.status).toBe(200);
    expect(res.body.client.name).toBe("Новое Имя");

    const audit = await prisma.auditEntry.findFirst({
      where: { entityId: client.id, action: "CLIENT_UPDATE" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
    const before = JSON.parse(audit!.before as string);
    const after = JSON.parse(audit!.after as string);
    expect(before.name).toBe("Старое Имя");
    expect(after.name).toBe("Новое Имя");
  });

  it("WAREHOUSE returns 403", async () => {
    const client = await prisma.client.create({ data: { name: "Клиент Для Патча WH" } });
    const res = await request(app)
      .patch(`/api/clients/${client.id}`)
      .set(AUTH_WH())
      .send({ name: "Попытка" });
    expect(res.status).toBe(403);
  });

  it("name collision returns 409 CLIENT_NAME_TAKEN", async () => {
    await prisma.client.create({ data: { name: "Существующий Клиент" } });
    const client = await prisma.client.create({ data: { name: "Другой Клиент" } });

    const res = await request(app)
      .patch(`/api/clients/${client.id}`)
      .set(AUTH_SA())
      .send({ name: "Существующий Клиент" });
    expect(res.status).toBe(409);
    expect(res.body.details).toBe("CLIENT_NAME_TAKEN");
  });
});

describe("DELETE /api/clients/:id", () => {
  it("SA deletes client without bookings, audit CLIENT_DELETE written", async () => {
    const client = await prisma.client.create({ data: { name: "Клиент К Удалению" } });

    const res = await request(app)
      .delete(`/api/clients/${client.id}`)
      .set(AUTH_SA());

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const dbClient = await prisma.client.findUnique({ where: { id: client.id } });
    expect(dbClient).toBeNull();

    const audit = await prisma.auditEntry.findFirst({
      where: { entityId: client.id, action: "CLIENT_DELETE" },
    });
    expect(audit).not.toBeNull();
    expect(audit!.entityType).toBe("Client");
  });

  it("client with bookings returns 409 CLIENT_HAS_BOOKINGS", async () => {
    // Create client and attach a booking via raw create
    const client = await prisma.client.create({ data: { name: "Клиент С Бронями" } });
    await prisma.booking.create({
      data: {
        clientId: client.id,
        projectName: "Тест проект",
        status: "DRAFT",
        startDate: new Date("2025-01-01"),
        endDate: new Date("2025-01-10"),
      },
    });

    const res = await request(app)
      .delete(`/api/clients/${client.id}`)
      .set(AUTH_SA());

    expect(res.status).toBe(409);
    expect(res.body.details).toBe("CLIENT_HAS_BOOKINGS");
  });

  it("WAREHOUSE returns 403", async () => {
    const client = await prisma.client.create({ data: { name: "Клиент Для Удаления WH" } });
    const res = await request(app)
      .delete(`/api/clients/${client.id}`)
      .set(AUTH_WH());
    expect(res.status).toBe(403);
  });

  it("not-found returns 404 CLIENT_NOT_FOUND", async () => {
    const res = await request(app)
      .delete("/api/clients/nonexistent-id-xyz")
      .set(AUTH_SA());
    expect(res.status).toBe(404);
    expect(res.body.details).toBe("CLIENT_NOT_FOUND");
  });
});
