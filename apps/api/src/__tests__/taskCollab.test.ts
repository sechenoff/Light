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

  it("POST to a non-existent task → 404 TASK_NOT_FOUND", async () => {
    const res = await request(app)
      .post(`/api/tasks/nonexistent-task-id/comments`)
      .set(AUTH_SA())
      .send({ body: "ghost" });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("TASK_NOT_FOUND");
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

describe("Checklist", () => {
  it("POST adds item at next position; audit TASK_CHECKLIST_ADD", async () => {
    const task = await makeTask(AUTH_SA());
    const a = await request(app).post(`/api/tasks/${task.id}/checklist`).set(AUTH_SA()).send({ text: "Шаг 1" });
    const b = await request(app).post(`/api/tasks/${task.id}/checklist`).set(AUTH_SA()).send({ text: "Шаг 2" });
    expect(a.status).toBe(201);
    expect(a.body.item.position).toBe(0);
    expect(b.body.item.position).toBe(1);
    const audit = await prisma.auditEntry.findMany({
      where: { entityType: "Task", entityId: task.id, action: "TASK_CHECKLIST_ADD" },
    });
    expect(audit).toHaveLength(2);
  });

  it("PATCH toggle done sets completedAt/By; idempotent; NO audit row", async () => {
    const task = await makeTask(AUTH_SA());
    const a = await request(app).post(`/api/tasks/${task.id}/checklist`).set(AUTH_SA()).send({ text: "x" });
    const t1 = await request(app).patch(`/api/tasks/${task.id}/checklist/${a.body.item.id}`).set(AUTH_SA()).send({ done: true });
    expect(t1.status).toBe(200);
    expect(t1.body.item.done).toBe(true);
    expect(t1.body.item.completedBy).toBe(saUser.id);
    const t2 = await request(app).patch(`/api/tasks/${task.id}/checklist/${a.body.item.id}`).set(AUTH_SA()).send({ done: true });
    expect(t2.status).toBe(200); // idempotent
    const audit = await prisma.auditEntry.findMany({
      where: { entityType: "Task", entityId: task.id, action: { startsWith: "TASK_CHECKLIST" } },
    });
    expect(audit.filter((x: any) => x.action === "TASK_CHECKLIST_ADD")).toHaveLength(1);
    expect(audit.filter((x: any) => x.action.includes("TOGGLE"))).toHaveLength(0); // no toggle audit
  });

  it("assignee may toggle done but may NOT edit text", async () => {
    const task = await makeTask(AUTH_SA(), { title: "T", assignedTo: whUser.id });
    const a = await request(app).post(`/api/tasks/${task.id}/checklist`).set(AUTH_SA()).send({ text: "x" });
    const toggle = await request(app).patch(`/api/tasks/${task.id}/checklist/${a.body.item.id}`).set(AUTH_WH()).send({ done: true });
    expect(toggle.status).toBe(200);
    const edit = await request(app).patch(`/api/tasks/${task.id}/checklist/${a.body.item.id}`).set(AUTH_WH()).send({ text: "new" });
    expect(edit.status).toBe(403);
    expect(edit.body.code).toBe("TASK_EDIT_FORBIDDEN");
  });

  it("DELETE removes item; audit TASK_CHECKLIST_DELETE; non-creator non-SA → 403", async () => {
    const task = await makeTask(AUTH_SA());
    const a = await request(app).post(`/api/tasks/${task.id}/checklist`).set(AUTH_SA()).send({ text: "x" });
    const forbidden = await request(app).delete(`/api/tasks/${task.id}/checklist/${a.body.item.id}`).set(AUTH_TECH());
    expect(forbidden.status).toBe(403);
    const ok = await request(app).delete(`/api/tasks/${task.id}/checklist/${a.body.item.id}`).set(AUTH_SA());
    expect(ok.status).toBe(200);
    const audit = await prisma.auditEntry.findMany({
      where: { entityType: "Task", entityId: task.id, action: "TASK_CHECKLIST_DELETE" },
    });
    expect(audit).toHaveLength(1);
  });
});

describe("GET /api/tasks/:id with collab", () => {
  it("returns enriched comments (asc) + ordered checklist", async () => {
    const task = await makeTask(AUTH_SA());
    await request(app).post(`/api/tasks/${task.id}/comments`).set(AUTH_WH()).send({ body: "первый" });
    await request(app).post(`/api/tasks/${task.id}/comments`).set(AUTH_SA()).send({ body: "второй" });
    await request(app).post(`/api/tasks/${task.id}/checklist`).set(AUTH_SA()).send({ text: "A" });
    await request(app).post(`/api/tasks/${task.id}/checklist`).set(AUTH_SA()).send({ text: "B" });
    const res = await request(app).get(`/api/tasks/${task.id}`).set(AUTH_SA());
    expect(res.status).toBe(200);
    expect(res.body.task.comments.map((c: any) => c.body)).toEqual(["первый", "второй"]);
    expect(res.body.task.comments[0].authorUser.username).toBe("tc_wh");
    expect(res.body.task.checklist.map((i: any) => i.text)).toEqual(["A", "B"]);
  });
});

describe("GET /api/tasks list aggregates", () => {
  it("each item has commentCount and checklist {done,total}", async () => {
    const task = await makeTask(AUTH_SA(), { title: "Aggr", assignedTo: saUser.id });
    await request(app).post(`/api/tasks/${task.id}/comments`).set(AUTH_SA()).send({ body: "c1" });
    const i1 = await request(app).post(`/api/tasks/${task.id}/checklist`).set(AUTH_SA()).send({ text: "i1" });
    await request(app).post(`/api/tasks/${task.id}/checklist`).set(AUTH_SA()).send({ text: "i2" });
    await request(app).patch(`/api/tasks/${task.id}/checklist/${i1.body.item.id}`).set(AUTH_SA()).send({ done: true });
    const res = await request(app).get("/api/tasks?filter=all&status=ALL&limit=200").set(AUTH_SA());
    const found = res.body.items.find((t: any) => t.id === task.id);
    expect(found.commentCount).toBe(1);
    expect(found.checklist).toEqual({ done: 1, total: 2 });
  });
});
