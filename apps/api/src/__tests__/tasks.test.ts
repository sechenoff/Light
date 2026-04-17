/**
 * Интеграционные тесты Tasks (to-do list) — Sprint 1 backend.
 *
 * Паттерн: изолированная SQLite БД через TEST_DB_PATH, prisma db push --force-reset,
 * signSession токены для SA/WH/TECH. Зеркалит approval.test.ts.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-tasks.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1,openclaw-bot-key";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-tasks";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-tasks";
process.env.JWT_SECRET = "test-jwt-secret-tasks-min16chars";

let app: Express;
let prisma: any;
let superAdminToken: string;
let warehouseToken: string;
let technicianToken: string;

let saUser: any;
let whUser: any;
let techUser: any;

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

  saUser = await prisma.adminUser.create({
    data: { username: "tasks_sa", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  superAdminToken = signSession({ userId: saUser.id, username: saUser.username, role: "SUPER_ADMIN" });

  whUser = await prisma.adminUser.create({
    data: { username: "tasks_wh", passwordHash: hash, role: "WAREHOUSE" },
  });
  warehouseToken = signSession({ userId: whUser.id, username: whUser.username, role: "WAREHOUSE" });

  techUser = await prisma.adminUser.create({
    data: { username: "tasks_tech", passwordHash: hash, role: "TECHNICIAN" },
  });
  technicianToken = signSession({ userId: techUser.id, username: techUser.username, role: "TECHNICIAN" });
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
function AUTH_BOT() { return { "X-API-Key": "openclaw-bot-key" }; }
function AUTH_API_ONLY() { return { "X-API-Key": "test-key-1" }; } // no JWT

// ─── Вспомогательные функции ──────────────────────────────────────────────────

async function createTaskDirect(data: any) {
  return prisma.task.create({ data });
}

// ─── 1. Bot scope: openclaw-* ключ на /api/tasks → 403 BOT_SCOPE_FORBIDDEN ───

describe("Bot scope guard", () => {
  it("openclaw-* ключ на POST /api/tasks → 403 BOT_SCOPE_FORBIDDEN", async () => {
    const res = await request(app)
      .post("/api/tasks")
      .set(AUTH_BOT())
      .send({ title: "Задача от бота" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("BOT_SCOPE_FORBIDDEN");
  });
});

// ─── 2. Создание задачи ───────────────────────────────────────────────────────

describe("POST /api/tasks — создание", () => {
  it("SUPER_ADMIN создаёт задачу с минимальными полями", async () => {
    const res = await request(app)
      .post("/api/tasks")
      .set(AUTH_SA())
      .send({ title: "Задача SA" });

    expect(res.status).toBe(201);
    expect(res.body.task.title).toBe("Задача SA");
    expect(res.body.task.status).toBe("OPEN");

    const audit = await prisma.auditEntry.findMany({
      where: { entityType: "Task", entityId: res.body.task.id, action: "TASK_CREATE" },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0].before).toBeNull();
    const after = typeof audit[0].after === "string" ? JSON.parse(audit[0].after) : audit[0].after;
    expect(after.title).toBe("Задача SA");
  });

  it("WAREHOUSE создаёт задачу", async () => {
    const res = await request(app)
      .post("/api/tasks")
      .set(AUTH_WH())
      .send({ title: "Задача склада" });
    expect(res.status).toBe(201);
  });

  it("TECHNICIAN создаёт задачу", async () => {
    const res = await request(app)
      .post("/api/tasks")
      .set(AUTH_TECH())
      .send({ title: "Задача техника" });
    expect(res.status).toBe(201);
  });

  it("пустой заголовок → 400 VALIDATION_FAILED", async () => {
    const res = await request(app)
      .post("/api/tasks")
      .set(AUTH_SA())
      .send({ title: "" });
    expect(res.status).toBe(400);
  });

  it("пробельный заголовок → 400 VALIDATION_FAILED", async () => {
    const res = await request(app)
      .post("/api/tasks")
      .set(AUTH_SA())
      .send({ title: "   " });
    expect(res.status).toBe(400);
  });

  it("assignedTo несуществующего пользователя → 400 INVALID_ASSIGNEE", async () => {
    const res = await request(app)
      .post("/api/tasks")
      .set(AUTH_SA())
      .send({ title: "Задача", assignedTo: "nonexistent-user-id" });
    expect(res.status).toBe(400);
    expect(res.body.details ?? res.body.code).toMatch(/INVALID_ASSIGNEE/);
  });

  it("assignedTo: null — допустимо (задача без исполнителя)", async () => {
    const res = await request(app)
      .post("/api/tasks")
      .set(AUTH_SA())
      .send({ title: "Без исполнителя", assignedTo: null });
    expect(res.status).toBe(201);
    expect(res.body.task.assignedTo).toBeNull();
  });

  it("dueDate валидный YYYY-MM-DD — допустимо", async () => {
    const res = await request(app)
      .post("/api/tasks")
      .set(AUTH_SA())
      .send({ title: "С датой", dueDate: "2026-05-01" });
    expect(res.status).toBe(201);
  });

  it("dueDate: null — допустимо", async () => {
    const res = await request(app)
      .post("/api/tasks")
      .set(AUTH_SA())
      .send({ title: "Без даты", dueDate: null });
    expect(res.status).toBe(201);
    expect(res.body.task.dueDate).toBeNull();
  });

  it("dueDate некорректный формат → 400", async () => {
    const res = await request(app)
      .post("/api/tasks")
      .set(AUTH_SA())
      .send({ title: "Кривая дата", dueDate: "01-05-2026" });
    expect(res.status).toBe(400);
  });

  it("без JWT — только API ключ → 401 UNAUTHENTICATED", async () => {
    const res = await request(app)
      .post("/api/tasks")
      .set(AUTH_API_ONLY())
      .send({ title: "Задача" });
    expect(res.status).toBe(401);
  });
});

// ─── 3. Список задач ──────────────────────────────────────────────────────────

describe("GET /api/tasks — список", () => {
  it("filter=my возвращает только assignedTo === userId", async () => {
    // Создаём задачу для WH (назначена WH)
    await createTaskDirect({
      title: "Задача для WH",
      status: "OPEN",
      urgent: false,
      createdBy: saUser.id,
      assignedTo: whUser.id,
    });
    // Задача для SA (не WH)
    await createTaskDirect({
      title: "Задача для SA",
      status: "OPEN",
      urgent: false,
      createdBy: saUser.id,
      assignedTo: saUser.id,
    });

    const res = await request(app)
      .get("/api/tasks?filter=my")
      .set(AUTH_WH());

    expect(res.status).toBe(200);
    expect(res.body.items).toBeDefined();
    for (const t of res.body.items) {
      expect(t.assignedTo).toBe(whUser.id);
    }
  });

  it("filter=all возвращает все задачи", async () => {
    const res = await request(app)
      .get("/api/tasks?filter=all&limit=200")
      .set(AUTH_SA());

    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
  });

  it("filter=created-by-me возвращает только createdBy === userId (включая задачи на себя)", async () => {
    // Создаём задачу TECH→себе
    await createTaskDirect({
      title: "Задача от TECH для TECH",
      status: "OPEN",
      urgent: false,
      createdBy: techUser.id,
      assignedTo: techUser.id,
    });

    const res = await request(app)
      .get("/api/tasks?filter=created-by-me")
      .set(AUTH_TECH());

    expect(res.status).toBe(200);
    for (const t of res.body.items) {
      expect(t.createdBy).toBe(techUser.id);
    }
    const myTask = res.body.items.find((t: any) => t.title === "Задача от TECH для TECH");
    expect(myTask).toBeDefined();
  });

  it("status=DONE фильтрует только выполненные задачи", async () => {
    const task = await createTaskDirect({
      title: "Выполненная задача",
      status: "DONE",
      urgent: false,
      createdBy: saUser.id,
      completedBy: saUser.id,
      completedAt: new Date(),
    });

    const res = await request(app)
      .get("/api/tasks?filter=all&status=DONE&limit=200")
      .set(AUTH_SA());

    expect(res.status).toBe(200);
    for (const t of res.body.items) {
      expect(t.status).toBe("DONE");
    }
    const found = res.body.items.find((t: any) => t.id === task.id);
    expect(found).toBeDefined();
  });

  it("overdue=true возвращает просроченные (dueDate < сегодня), не сегодняшние", async () => {
    // Просроченная задача — вчера по Москве
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const overdueTask = await createTaskDirect({
      title: "Просроченная задача",
      status: "OPEN",
      urgent: false,
      createdBy: saUser.id,
      dueDate: yesterday,
    });

    // Задача на сегодня
    const todayTask = await createTaskDirect({
      title: "Сегодняшняя задача",
      status: "OPEN",
      urgent: false,
      createdBy: saUser.id,
      dueDate: new Date(), // today
    });

    const res = await request(app)
      .get("/api/tasks?filter=all&overdue=true&limit=200")
      .set(AUTH_SA());

    expect(res.status).toBe(200);
    const ids = res.body.items.map((t: any) => t.id);
    expect(ids).toContain(overdueTask.id);
    // Сегодняшняя не должна быть в overdue (она на сегодня, не просрочена)
    expect(ids).not.toContain(todayTask.id);
  });

  it("response shape: {items, nextCursor}", async () => {
    const res = await request(app)
      .get("/api/tasks?filter=all&limit=200")
      .set(AUTH_SA());

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect("nextCursor" in res.body).toBe(true);
  });

  it("keyset pagination: nextCursor присутствует на первой странице, второй запрос возвращает данные", async () => {
    // Создаём новый AdminUser специально для этого теста, чтобы изолировать количество задач
    const { hashPassword, signSession } = await import("../services/auth");
    const hash = await hashPassword("pagtest");
    const pageUser = await prisma.adminUser.create({
      data: { username: `pagtest_${Date.now()}`, passwordHash: hash, role: "WAREHOUSE" },
    });
    const pageToken = signSession({ userId: pageUser.id, username: pageUser.username, role: "WAREHOUSE" });
    const AUTH_PAGE = () => ({ "X-API-Key": "test-key-1", Authorization: `Bearer ${pageToken}` });

    const t1 = await createTaskDirect({ title: "Page 1", status: "OPEN", urgent: false, createdBy: pageUser.id });
    const t2 = await createTaskDirect({ title: "Page 2", status: "OPEN", urgent: false, createdBy: pageUser.id });
    const t3 = await createTaskDirect({ title: "Page 3", status: "OPEN", urgent: false, createdBy: pageUser.id });
    void t1; void t2;

    const res1 = await request(app)
      .get(`/api/tasks?filter=created-by-me&limit=2`)
      .set(AUTH_PAGE());

    expect(res1.status).toBe(200);
    expect(res1.body.items).toHaveLength(2);
    const { nextCursor } = res1.body;
    expect(nextCursor).toBeTruthy();

    const res2 = await request(app)
      .get(`/api/tasks?filter=created-by-me&limit=2&cursor=${nextCursor}`)
      .set(AUTH_PAGE());

    expect(res2.status).toBe(200);
    const allIds = res2.body.items.map((t: any) => t.id);
    expect(allIds).toContain(t3.id);
  });

  it("TECHNICIAN на filter=all — допустимо (router guard пропускает все 3 роли)", async () => {
    const res = await request(app)
      .get("/api/tasks?filter=all")
      .set(AUTH_TECH());
    expect(res.status).toBe(200);
  });
});

// ─── 4. Обновление задачи ─────────────────────────────────────────────────────

describe("PATCH /api/tasks/:id — обновление", () => {
  it("создатель может редактировать title/description/dueDate/assignedTo; аудит TASK_UPDATE с before/after", async () => {
    // WH создаёт задачу для себя
    const createRes = await request(app)
      .post("/api/tasks")
      .set(AUTH_WH())
      .send({ title: "Оригинальный заголовок" });
    const taskId = createRes.body.task.id;

    const res = await request(app)
      .patch(`/api/tasks/${taskId}`)
      .set(AUTH_WH())
      .send({ title: "Обновлённый заголовок" });

    expect(res.status).toBe(200);
    expect(res.body.task.title).toBe("Обновлённый заголовок");

    const audit = await prisma.auditEntry.findFirst({
      where: { entityType: "Task", entityId: taskId, action: "TASK_UPDATE" },
    });
    expect(audit).not.toBeNull();
    const before = typeof audit!.before === "string" ? JSON.parse(audit!.before) : audit!.before;
    const after = typeof audit!.after === "string" ? JSON.parse(audit!.after) : audit!.after;
    expect(before.title).toBe("Оригинальный заголовок");
    expect(after.title).toBe("Обновлённый заголовок");
  });

  it("смена assignedTo → аудит TASK_ASSIGN с before/after.assignedTo", async () => {
    const createRes = await request(app)
      .post("/api/tasks")
      .set(AUTH_SA())
      .send({ title: "Назначаемая задача", assignedTo: whUser.id });
    const taskId = createRes.body.task.id;

    const res = await request(app)
      .patch(`/api/tasks/${taskId}`)
      .set(AUTH_SA())
      .send({ assignedTo: techUser.id });

    expect(res.status).toBe(200);

    const audit = await prisma.auditEntry.findFirst({
      where: { entityType: "Task", entityId: taskId, action: "TASK_ASSIGN" },
    });
    expect(audit).not.toBeNull();
    const before = typeof audit!.before === "string" ? JSON.parse(audit!.before) : audit!.before;
    const after = typeof audit!.after === "string" ? JSON.parse(audit!.after) : audit!.after;
    expect(before.assignedTo).toBe(whUser.id);
    expect(after.assignedTo).toBe(techUser.id);
  });

  it("исполнитель (не создатель) пытается изменить title → 403 TASK_EDIT_FORBIDDEN", async () => {
    // SA создаёт задачу, назначает TECH исполнителем
    const createRes = await request(app)
      .post("/api/tasks")
      .set(AUTH_SA())
      .send({ title: "Задача SA", assignedTo: techUser.id });
    const taskId = createRes.body.task.id;

    const res = await request(app)
      .patch(`/api/tasks/${taskId}`)
      .set(AUTH_TECH())
      .send({ title: "Новый заголовок от техника" });

    expect(res.status).toBe(403);
    expect(res.body.details ?? res.body.code).toMatch(/TASK_EDIT_FORBIDDEN/);
  });

  it("исполнитель может переключить urgent → 200 + аудит TASK_UPDATE", async () => {
    // SA создаёт задачу, назначает WH
    const createRes = await request(app)
      .post("/api/tasks")
      .set(AUTH_SA())
      .send({ title: "Для urgent toggle", assignedTo: whUser.id, urgent: false });
    const taskId = createRes.body.task.id;

    const res = await request(app)
      .patch(`/api/tasks/${taskId}`)
      .set(AUTH_WH())
      .send({ urgent: true });

    expect(res.status).toBe(200);
    expect(res.body.task.urgent).toBe(true);
  });

  it("не-создатель, не-исполнитель, не-SA → 403 для любого поля", async () => {
    // SA создаёт задачу для WH
    const createRes = await request(app)
      .post("/api/tasks")
      .set(AUTH_SA())
      .send({ title: "Чужая задача", assignedTo: whUser.id });
    const taskId = createRes.body.task.id;

    // TECH пытается редактировать (не создатель, не исполнитель)
    const res = await request(app)
      .patch(`/api/tasks/${taskId}`)
      .set(AUTH_TECH())
      .send({ urgent: true });

    expect(res.status).toBe(403);
  });

  it("SA может редактировать любое поле любой задачи → 200", async () => {
    // WH создаёт задачу
    const createRes = await request(app)
      .post("/api/tasks")
      .set(AUTH_WH())
      .send({ title: "Задача WH для SA" });
    const taskId = createRes.body.task.id;

    const res = await request(app)
      .patch(`/api/tasks/${taskId}`)
      .set(AUTH_SA())
      .send({ title: "Исправлено SA", urgent: true });

    expect(res.status).toBe(200);
    expect(res.body.task.title).toBe("Исправлено SA");
  });
});

// ─── 5. Выполнение и возврат ──────────────────────────────────────────────────

describe("POST /:id/complete и /:id/reopen", () => {
  it("любая роль может выполнить задачу; аудит TASK_COMPLETE", async () => {
    const task = await createTaskDirect({
      title: "Задача для complete",
      status: "OPEN",
      urgent: false,
      createdBy: saUser.id,
    });

    const res = await request(app)
      .post(`/api/tasks/${task.id}/complete`)
      .set(AUTH_TECH());

    expect(res.status).toBe(200);
    expect(res.body.task.status).toBe("DONE");
    expect(res.body.task.completedBy).toBe(techUser.id);

    const audit = await prisma.auditEntry.findFirst({
      where: { entityType: "Task", entityId: task.id, action: "TASK_COMPLETE" },
    });
    expect(audit).not.toBeNull();
  });

  it("идемпотентный complete: уже DONE → 200, новая аудит-запись НЕ создаётся", async () => {
    const task = await createTaskDirect({
      title: "Уже выполненная",
      status: "DONE",
      urgent: false,
      createdBy: saUser.id,
      completedBy: saUser.id,
      completedAt: new Date(),
    });

    const auditBefore = await prisma.auditEntry.count({
      where: { entityType: "Task", entityId: task.id, action: "TASK_COMPLETE" },
    });

    const res = await request(app)
      .post(`/api/tasks/${task.id}/complete`)
      .set(AUTH_SA());

    expect(res.status).toBe(200);

    const auditAfter = await prisma.auditEntry.count({
      where: { entityType: "Task", entityId: task.id, action: "TASK_COMPLETE" },
    });
    expect(auditAfter).toBe(auditBefore); // не изменилось
  });

  it("reopen очищает completedAt и completedBy; аудит TASK_REOPEN", async () => {
    const task = await createTaskDirect({
      title: "Задача для reopen",
      status: "DONE",
      urgent: false,
      createdBy: saUser.id,
      completedBy: saUser.id,
      completedAt: new Date(),
    });

    const res = await request(app)
      .post(`/api/tasks/${task.id}/reopen`)
      .set(AUTH_WH());

    expect(res.status).toBe(200);
    expect(res.body.task.status).toBe("OPEN");
    expect(res.body.task.completedAt).toBeNull();
    expect(res.body.task.completedBy).toBeNull();

    const audit = await prisma.auditEntry.findFirst({
      where: { entityType: "Task", entityId: task.id, action: "TASK_REOPEN" },
    });
    expect(audit).not.toBeNull();
  });

  it("concurrent complete: оба запроса 200, ровно 1 TASK_COMPLETE аудит-запись", async () => {
    const task = await createTaskDirect({
      title: "Concurrent complete",
      status: "OPEN",
      urgent: false,
      createdBy: saUser.id,
    });

    const [res1, res2] = await Promise.all([
      request(app).post(`/api/tasks/${task.id}/complete`).set(AUTH_SA()),
      request(app).post(`/api/tasks/${task.id}/complete`).set(AUTH_WH()),
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    const auditCount = await prisma.auditEntry.count({
      where: { entityType: "Task", entityId: task.id, action: "TASK_COMPLETE" },
    });
    expect(auditCount).toBe(1);
  });
});

// ─── 6. Удаление ─────────────────────────────────────────────────────────────

describe("DELETE /api/tasks/:id", () => {
  it("создатель может удалить свою задачу; аудит TASK_DELETE с before=fullTask, after=null", async () => {
    const createRes = await request(app)
      .post("/api/tasks")
      .set(AUTH_WH())
      .send({ title: "Удаляемая задача" });
    const taskId = createRes.body.task.id;

    const res = await request(app)
      .delete(`/api/tasks/${taskId}`)
      .set(AUTH_WH());

    expect(res.status).toBe(200);

    const audit = await prisma.auditEntry.findFirst({
      where: { entityType: "Task", entityId: taskId, action: "TASK_DELETE" },
    });
    expect(audit).not.toBeNull();
    const before = typeof audit!.before === "string" ? JSON.parse(audit!.before) : audit!.before;
    expect(before.title).toBe("Удаляемая задача");
    expect(audit!.after).toBeNull();
  });

  it("SA может удалить чужую задачу → 200", async () => {
    const createRes = await request(app)
      .post("/api/tasks")
      .set(AUTH_WH())
      .send({ title: "Задача для SA-удаления" });
    const taskId = createRes.body.task.id;

    const res = await request(app)
      .delete(`/api/tasks/${taskId}`)
      .set(AUTH_SA());

    expect(res.status).toBe(200);
  });

  it("WH не-создатель → 403 TASK_DELETE_FORBIDDEN", async () => {
    const createRes = await request(app)
      .post("/api/tasks")
      .set(AUTH_SA())
      .send({ title: "Задача SA, удаляет WH" });
    const taskId = createRes.body.task.id;

    const res = await request(app)
      .delete(`/api/tasks/${taskId}`)
      .set(AUTH_WH());

    expect(res.status).toBe(403);
    expect(res.body.details ?? res.body.code).toMatch(/TASK_DELETE_FORBIDDEN/);
  });

  it("TECH исполнитель (не создатель) → 403 TASK_DELETE_FORBIDDEN", async () => {
    const createRes = await request(app)
      .post("/api/tasks")
      .set(AUTH_SA())
      .send({ title: "Задача SA для TECH", assignedTo: techUser.id });
    const taskId = createRes.body.task.id;

    const res = await request(app)
      .delete(`/api/tasks/${taskId}`)
      .set(AUTH_TECH());

    expect(res.status).toBe(403);
    expect(res.body.details ?? res.body.code).toMatch(/TASK_DELETE_FORBIDDEN/);
  });
});

// ─── 7. Dashboard /task-stats ─────────────────────────────────────────────────

describe("GET /api/dashboard/task-stats", () => {
  it("SA получает {myOpen, myOverdue, myToday, myUrgent} без 403", async () => {
    const res = await request(app)
      .get("/api/dashboard/task-stats")
      .set(AUTH_SA());
    expect(res.status).toBe(200);
    expect(typeof res.body.myOpen).toBe("number");
    expect(typeof res.body.myOverdue).toBe("number");
    expect(typeof res.body.myToday).toBe("number");
    expect(typeof res.body.myUrgent).toBe("number");
  });

  it("WAREHOUSE получает task-stats без 403", async () => {
    const res = await request(app)
      .get("/api/dashboard/task-stats")
      .set(AUTH_WH());
    expect(res.status).toBe(200);
  });

  it("TECHNICIAN получает task-stats без 403", async () => {
    const res = await request(app)
      .get("/api/dashboard/task-stats")
      .set(AUTH_TECH());
    expect(res.status).toBe(200);
  });

  it("myToday включает срочную задачу без даты (urgent=true, dueDate=null)", async () => {
    // Создаём задачу для текущего пользователя (SA)
    const task = await createTaskDirect({
      title: "Срочная без даты",
      status: "OPEN",
      urgent: true,
      dueDate: null,
      createdBy: saUser.id,
      assignedTo: saUser.id,
    });
    void task;

    const res = await request(app)
      .get("/api/dashboard/task-stats")
      .set(AUTH_SA());

    expect(res.status).toBe(200);
    expect(res.body.myToday).toBeGreaterThan(0);
  });

  it("myOverdue использует московское TZ: задача с dueDate вчера → в просрочке", async () => {
    // Вчерашняя дата по UTC (точно не сегодня в Москве)
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    const task = await createTaskDirect({
      title: "Просрочка Moscow TZ",
      status: "OPEN",
      urgent: false,
      dueDate: yesterday,
      createdBy: techUser.id,
      assignedTo: techUser.id,
    });
    void task;

    const res = await request(app)
      .get("/api/dashboard/task-stats")
      .set(AUTH_TECH());

    expect(res.status).toBe(200);
    expect(res.body.myOverdue).toBeGreaterThan(0);
  });
});

// ─── 8. Dashboard /today расширен myTasks ────────────────────────────────────

describe("GET /api/dashboard/today — включает myTasks", () => {
  it("ответ содержит поле myTasks как массив", async () => {
    const res = await request(app)
      .get("/api/dashboard/today")
      .set(AUTH_SA());

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.myTasks)).toBe(true);
  });
});

// ─── 9. status=ALL — возвращает OPEN и DONE вместе ───────────────────────────

describe("GET /api/tasks?status=ALL", () => {
  it("возвращает и OPEN, и DONE задачи для filter=my одного пользователя", async () => {
    // Создаём специального пользователя для изоляции
    const { hashPassword, signSession } = await import("../services/auth");
    const hash = await hashPassword("alltest123");
    const allUser = await prisma.adminUser.create({
      data: { username: `alltest_${Date.now()}`, passwordHash: hash, role: "SUPER_ADMIN" },
    });
    const allToken = signSession({ userId: allUser.id, username: allUser.username, role: "SUPER_ADMIN" });
    const AUTH_ALL = () => ({ "X-API-Key": "test-key-1", Authorization: `Bearer ${allToken}` });

    // Создаём OPEN задачу для этого пользователя
    await prisma.task.create({
      data: {
        title: "Открытая-ALL",
        status: "OPEN",
        urgent: false,
        createdBy: allUser.id,
        assignedTo: allUser.id,
      },
    });

    // Создаём DONE задачу для этого пользователя
    await prisma.task.create({
      data: {
        title: "Выполненная-ALL",
        status: "DONE",
        urgent: false,
        createdBy: allUser.id,
        assignedTo: allUser.id,
        completedAt: new Date(),
        completedBy: allUser.id,
      },
    });

    const res = await request(app)
      .get("/api/tasks?filter=my&status=ALL&limit=200")
      .set(AUTH_ALL());

    expect(res.status).toBe(200);
    const items: any[] = res.body.items;

    const openTask = items.find((t) => t.title === "Открытая-ALL");
    const doneTask = items.find((t) => t.title === "Выполненная-ALL");

    expect(openTask).toBeDefined();
    expect(openTask.status).toBe("OPEN");
    expect(doneTask).toBeDefined();
    expect(doneTask.status).toBe("DONE");
  });

  it("status=OPEN (default) не возвращает DONE задачи", async () => {
    const res = await request(app)
      .get("/api/tasks?filter=my&status=OPEN&limit=200")
      .set(AUTH_SA());

    expect(res.status).toBe(200);
    const items: any[] = res.body.items;
    expect(items.every((t) => t.status === "OPEN")).toBe(true);
  });
});
