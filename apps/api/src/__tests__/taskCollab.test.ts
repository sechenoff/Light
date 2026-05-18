/**
 * Интеграционные тесты Tasks collaboration (comments + checklist).
 * Паттерн: изолированная SQLite БД через TEST_DB_PATH, prisma db push --force-reset,
 * signSession токены. Зеркалит tasks.test.ts.
 */
import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-taskcollab.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1,openclaw-bot-key";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-tc";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-tc";
process.env.JWT_SECRET = "test-jwt-secret-taskcollab-min16";

let app: Express;
let prisma: any;
let saUser: any, whUser: any, techUser: any;
let superAdminToken: string, warehouseToken: string, technicianToken: string;

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, DATABASE_URL: `file:${TEST_DB_PATH}`, PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes" },
    stdio: "pipe",
  });
  const mod = await import("../app");
  app = mod.app;
  const pmod = await import("../prisma");
  prisma = pmod.prisma;
  const { hashPassword, signSession } = await import("../services/auth");
  const hash = await hashPassword("test-pass-123");
  saUser = await prisma.adminUser.create({ data: { username: "tc_sa", passwordHash: hash, role: "SUPER_ADMIN" } });
  superAdminToken = signSession({ userId: saUser.id, username: saUser.username, role: "SUPER_ADMIN" });
  whUser = await prisma.adminUser.create({ data: { username: "tc_wh", passwordHash: hash, role: "WAREHOUSE" } });
  warehouseToken = signSession({ userId: whUser.id, username: whUser.username, role: "WAREHOUSE" });
  techUser = await prisma.adminUser.create({ data: { username: "tc_tech", passwordHash: hash, role: "TECHNICIAN" } });
  technicianToken = signSession({ userId: techUser.id, username: techUser.username, role: "TECHNICIAN" });
});

afterAll(async () => {
  await prisma?.$disconnect?.();
  for (const ext of ["", "-journal"]) {
    const p = `${TEST_DB_PATH}${ext}`;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
});

function AUTH_SA() { return { "X-API-Key": "test-key-1", Authorization: `Bearer ${superAdminToken}` }; }
function AUTH_WH() { return { "X-API-Key": "test-key-1", Authorization: `Bearer ${warehouseToken}` }; }
function AUTH_TECH() { return { "X-API-Key": "test-key-1", Authorization: `Bearer ${technicianToken}` }; }

async function makeTask(auth: Record<string, string>, body: any = { title: "T" }) {
  const res = await request(app).post("/api/tasks").set(auth).send(body);
  return res.body.task;
}

describe("Comments", () => {
  it("POST /api/tasks/:id/comments — WAREHOUSE adds, audit written, enriched author", async () => {
    const task = await makeTask(AUTH_SA());
    const res = await request(app)
      .post(`/api/tasks/${task.id}/comments`)
      .set(AUTH_WH())
      .send({ body: "Уточни сроки" });
    expect(res.status).toBe(201);
    expect(res.body.comment.body).toBe("Уточни сроки");
    expect(res.body.comment.authorUser.username).toBe("tc_wh");
    const audit = await prisma.auditEntry.findMany({
      where: { entityType: "Task", entityId: task.id, action: "TASK_COMMENT_ADD" },
    });
    expect(audit).toHaveLength(1);
  });

  it("rejects empty/whitespace body with 400", async () => {
    const task = await makeTask(AUTH_SA());
    const res = await request(app).post(`/api/tasks/${task.id}/comments`).set(AUTH_SA()).send({ body: "   " });
    expect(res.status).toBe(400);
  });

  it("DELETE — author can delete, audit TASK_COMMENT_DELETE", async () => {
    const task = await makeTask(AUTH_SA());
    const add = await request(app).post(`/api/tasks/${task.id}/comments`).set(AUTH_WH()).send({ body: "x" });
    const del = await request(app).delete(`/api/tasks/${task.id}/comments/${add.body.comment.id}`).set(AUTH_WH());
    expect(del.status).toBe(200);
    const audit = await prisma.auditEntry.findMany({
      where: { entityType: "Task", entityId: task.id, action: "TASK_COMMENT_DELETE" },
    });
    expect(audit).toHaveLength(1);
  });

  it("DELETE — non-author non-SA → 403 TASK_COMMENT_DELETE_FORBIDDEN", async () => {
    const task = await makeTask(AUTH_SA());
    const add = await request(app).post(`/api/tasks/${task.id}/comments`).set(AUTH_WH()).send({ body: "x" });
    const del = await request(app).delete(`/api/tasks/${task.id}/comments/${add.body.comment.id}`).set(AUTH_TECH());
    expect(del.status).toBe(403);
    expect(del.body.code).toBe("TASK_COMMENT_DELETE_FORBIDDEN");
  });

  it("DELETE — SUPER_ADMIN can delete anyone's comment", async () => {
    const task = await makeTask(AUTH_SA());
    const add = await request(app).post(`/api/tasks/${task.id}/comments`).set(AUTH_WH()).send({ body: "x" });
    const del = await request(app).delete(`/api/tasks/${task.id}/comments/${add.body.comment.id}`).set(AUTH_SA());
    expect(del.status).toBe(200);
  });
});
