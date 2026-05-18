# Tasks Collaboration & Realtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a slide-over task detail panel with a comment thread, an ordered checklist/subtasks, and visibility-aware smart polling so a 3–5 person team stays in sync without reloading.

**Architecture:** Approach A from the spec — `GET /api/tasks/:id` returns the task plus user-enriched comments and ordered checklist in one response; `GET /api/tasks` gains `commentCount` + `checklistSummary {done,total}` aggregates via Prisma relation `_count` (no N+1). NOTE: the list-level checklist aggregate key is `checklistSummary` (not `checklist`) to avoid shape-clashing with the detail endpoint's `checklist: ChecklistItem[]`. Comment/checklist mutations are separate optimistic REST endpoints. Realtime = two visibility-paused pollers (list 12 s, open panel 8 s) that force-refetch after the user's own mutation.

**Tech Stack:** Express 4 + Prisma 6 (SQLite), Zod, Vitest + supertest (API), Next.js 14 + React 18 + Tailwind, Vitest + jsdom + @testing-library/react (web). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-18-tasks-collaboration-realtime-design.md`

---

## File Structure

**Backend**
- `apps/api/prisma/schema.prisma` — add `TaskComment`, `TaskChecklistItem` models + `Task` back-relations (Task 1).
- `apps/api/src/services/taskCollabService.ts` — **new**, single responsibility: comment + checklist business logic, all `$transaction`-wrapped with audit (Tasks 2, 4).
- `apps/api/src/services/taskService.ts` — extend `getTask` (include comments+checklist) and `listTasks` (aggregates) only (Task 6).
- `apps/api/src/routes/tasks.ts` — add comment + checklist routes; serialize new GET shapes (Tasks 3, 5, 6).
- `apps/api/src/__tests__/taskCollab.test.ts` — **new**, integration tests mirroring `tasks.test.ts` harness (Tasks 2–6).

**Web**
- `apps/web/src/components/tasks/useTaskDetail.ts` — **new**, consolidated fetch + 8 s panel poll + optimistic comment/checklist mutations (Task 8).
- `apps/web/src/components/tasks/TaskComments.tsx` — **new**, thread + composer (Task 9).
- `apps/web/src/components/tasks/TaskChecklist.tsx` — **new**, items + add-input + progress (Task 10).
- `apps/web/src/components/tasks/TaskDetailPanel.tsx` — **new**, right slide-over composing header/desc/checklist/comments (Task 11).
- `apps/web/src/components/tasks/TaskCard.tsx` — add 💬/☑ chips + open-panel click (Task 12).
- `apps/web/src/components/tasks/useTasksQuery.ts` — add 12 s visibility-aware list poller (Task 13).
- `apps/web/src/components/tasks/TasksPage.tsx` — `?task=` deep-link → render panel (Task 13).
- `apps/web/src/components/tasks/groupTasks.ts` — extend `Task` type with `commentCount?`, `checklistSummary?` (Task 6).
- `apps/web/src/components/tasks/__tests__/useTaskDetail.test.tsx` — **new** (Task 8).

**Docs**
- `CLAUDE.md` — Tasks Feature section addendum (Task 14).

---

## Task 1: Prisma models for comments + checklist

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (Task model ~line 791–810; add two models after it)

- [ ] **Step 1: Add back-relations to the Task model**

In `apps/api/prisma/schema.prisma`, inside `model Task { ... }`, add two relation fields immediately before the closing `}` / `@@index` block (after `updatedAt DateTime @updatedAt`):

```prisma
  comments  TaskComment[]
  checklist TaskChecklistItem[]
```

- [ ] **Step 2: Add the two new models**

Immediately after the `model Task { ... }` closing brace (before the `// ─── Finance Phase 2 models` divider), insert:

```prisma
model TaskComment {
  id        String   @id @default(cuid())
  taskId    String
  task      Task     @relation(fields: [taskId], references: [id], onDelete: Cascade)
  authorId  String   // AdminUser.id — no FK, enriched manually
  body      String
  createdAt DateTime @default(now())

  @@index([taskId, createdAt])
}

model TaskChecklistItem {
  id          String    @id @default(cuid())
  taskId      String
  task        Task      @relation(fields: [taskId], references: [id], onDelete: Cascade)
  text        String
  done        Boolean   @default(false)
  position    Int       // 0-based ordering within the task
  completedAt DateTime?
  completedBy String?   // AdminUser.id — no FK
  createdAt   DateTime  @default(now())

  @@index([taskId, position])
}
```

- [ ] **Step 3: Regenerate the Prisma client and push to the dev DB**

Run:
```bash
cd apps/api && npx prisma generate && DATABASE_URL="file:$(pwd)/dev.db" npx prisma db push --accept-data-loss --skip-generate
```
Expected: `Your database is now in sync with your Prisma schema.` and Prisma Client generated. (Additive change — no existing-table data loss.)

- [ ] **Step 4: Verify the client typecheck passes**

Run: `cd apps/api && npx tsc --noEmit`
Expected: no errors (the new `prisma.taskComment` / `prisma.taskChecklistItem` accessors now exist).

- [ ] **Step 5: Commit**

```bash
git add apps/api/prisma/schema.prisma
git commit -m "feat(tasks): TaskComment + TaskChecklistItem prisma models"
```

---

## Task 2: Comment service — add / list / delete

**Files:**
- Create: `apps/api/src/services/taskCollabService.ts`
- Create: `apps/api/src/__tests__/taskCollab.test.ts`

- [ ] **Step 1: Write the test harness + failing comment tests**

Create `apps/api/src/__tests__/taskCollab.test.ts` with the exact harness from `tasks.test.ts` (isolated SQLite, signSession tokens), then comment tests:

```ts
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
```

- [ ] **Step 2: Run the comment tests to verify they fail**

Run: `cd apps/api && npx vitest run src/__tests__/taskCollab.test.ts -t "Comments"`
Expected: FAIL — routes 404 (`POST /api/tasks/:id/comments` not defined yet).

- [ ] **Step 3: Implement the comment service**

Create `apps/api/src/services/taskCollabService.ts`:

```ts
/**
 * Сервис коллаборации по задачам: комментарии + чеклист.
 * Все мутации обёрнуты в prisma.$transaction + writeAuditEntry (паттерн taskService).
 */
import type { UserRole } from "@prisma/client";
import { prisma } from "../prisma";
import { writeAuditEntry } from "./audit";
import { HttpError } from "../utils/errors";

type Actor = { userId: string; role: UserRole };

async function enrichAuthors<T extends { authorId: string }>(rows: T[]) {
  const ids = Array.from(new Set(rows.map((r) => r.authorId)));
  const users =
    ids.length > 0
      ? await prisma.adminUser.findMany({
          where: { id: { in: ids } },
          select: { id: true, username: true },
        })
      : [];
  const m = new Map(users.map((u) => [u.id, u]));
  return rows.map((r) => ({ ...r, authorUser: m.get(r.authorId) ?? null }));
}

async function assertTaskExists(tx: any, taskId: string) {
  const task = await tx.task.findUnique({ where: { id: taskId }, select: { id: true } });
  if (!task) throw new HttpError(404, "Задача не найдена", "TASK_NOT_FOUND");
}

// ─── Comments ─────────────────────────────────────────────────────────────────

export async function addComment(taskId: string, body: string, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    await assertTaskExists(tx, taskId);
    const comment = await tx.taskComment.create({
      data: { taskId, authorId: actor.userId, body },
    });
    await writeAuditEntry({
      tx: tx as any,
      userId: actor.userId,
      action: "TASK_COMMENT_ADD",
      entityType: "Task",
      entityId: taskId,
      before: null,
      after: { commentId: comment.id, body },
    });
    const [enriched] = await enrichAuthors([comment]);
    return enriched;
  });
}

export async function listComments(taskId: string) {
  const rows = await prisma.taskComment.findMany({
    where: { taskId },
    orderBy: { createdAt: "asc" },
  });
  return enrichAuthors(rows);
}

export async function deleteComment(taskId: string, commentId: string, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    const c = await tx.taskComment.findUnique({ where: { id: commentId } });
    if (!c || c.taskId !== taskId) {
      throw new HttpError(404, "Комментарий не найден", "TASK_COMMENT_NOT_FOUND");
    }
    const isAuthor = c.authorId === actor.userId;
    const isSA = actor.role === "SUPER_ADMIN";
    if (!isAuthor && !isSA) {
      throw new HttpError(403, "Нет прав на удаление комментария", "TASK_COMMENT_DELETE_FORBIDDEN");
    }
    await writeAuditEntry({
      tx: tx as any,
      userId: actor.userId,
      action: "TASK_COMMENT_DELETE",
      entityType: "Task",
      entityId: taskId,
      before: { commentId, body: c.body },
      after: null,
    });
    await tx.taskComment.delete({ where: { id: commentId } });
    return { id: commentId };
  });
}
```

- [ ] **Step 4: Add comment routes**

In `apps/api/src/routes/tasks.ts`, add to the imports block:

```ts
import { addComment, deleteComment, listComments } from "../services/taskCollabService";
```

Add Zod schema near the other schemas (after `listQuerySchema`):

```ts
const commentBodySchema = z.object({ body: z.string().trim().min(1, "Пустой комментарий").max(5000) });
```

Add routes before the final `export`/end of file (after the DELETE `/:id` route):

```ts
// ─── Comments ─────────────────────────────────────────────────────────────────

tasksRouter.post("/:id/comments", rolesGuard(["SUPER_ADMIN", "WAREHOUSE", "TECHNICIAN"]), async (req, res, next) => {
  try {
    const { body } = commentBodySchema.parse(req.body);
    const actor = { userId: req.adminUser!.userId, role: req.adminUser!.role as any };
    const comment = await addComment(req.params.id, body, actor);
    res.status(201).json({ comment: serializeComment(comment) });
  } catch (err) { next(err); }
});

tasksRouter.delete("/:id/comments/:commentId", rolesGuard(["SUPER_ADMIN", "WAREHOUSE", "TECHNICIAN"]), async (req, res, next) => {
  try {
    const actor = { userId: req.adminUser!.userId, role: req.adminUser!.role as any };
    const result = await deleteComment(req.params.id, req.params.commentId, actor);
    res.json(result);
  } catch (err) { next(err); }
});
```

Add the serializer next to `serializeTask`:

```ts
function serializeComment(c: any) {
  return { ...c, createdAt: c.createdAt instanceof Date ? c.createdAt.toISOString() : c.createdAt };
}
```

- [ ] **Step 5: Run the comment tests to verify they pass**

Run: `cd apps/api && npx vitest run src/__tests__/taskCollab.test.ts -t "Comments"`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/taskCollabService.ts apps/api/src/routes/tasks.ts apps/api/src/__tests__/taskCollab.test.ts
git commit -m "feat(tasks): comment add/list/delete service + routes + audit"
```

---

## Task 3: Checklist service — add / patch / delete

**Files:**
- Modify: `apps/api/src/services/taskCollabService.ts`
- Modify: `apps/api/src/routes/tasks.ts`
- Modify: `apps/api/src/__tests__/taskCollab.test.ts`

- [ ] **Step 1: Write failing checklist tests**

Append to `apps/api/src/__tests__/taskCollab.test.ts`:

```ts
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
```

- [ ] **Step 2: Run checklist tests to verify they fail**

Run: `cd apps/api && npx vitest run src/__tests__/taskCollab.test.ts -t "Checklist"`
Expected: FAIL — checklist routes 404.

- [ ] **Step 3: Implement the checklist service**

Append to `apps/api/src/services/taskCollabService.ts`:

```ts
// ─── Checklist ────────────────────────────────────────────────────────────────

/** Edit-content permission mirrors updateTask: creator or SA. */
async function loadTaskForChecklist(tx: any, taskId: string) {
  const task = await tx.task.findUnique({
    where: { id: taskId },
    select: { id: true, createdBy: true, assignedTo: true },
  });
  if (!task) throw new HttpError(404, "Задача не найдена", "TASK_NOT_FOUND");
  return task;
}

function assertCanEditContent(task: { createdBy: string; assignedTo: string | null }, actor: Actor) {
  const isCreator = task.createdBy === actor.userId;
  const isSA = actor.role === "SUPER_ADMIN";
  if (!isCreator && !isSA) {
    throw new HttpError(403, "Нет прав на редактирование задачи", "TASK_EDIT_FORBIDDEN");
  }
}

export async function addChecklistItem(taskId: string, text: string, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    const task = await loadTaskForChecklist(tx, taskId);
    assertCanEditContent(task, actor);
    const last = await tx.taskChecklistItem.findFirst({
      where: { taskId },
      orderBy: { position: "desc" },
      select: { position: true },
    });
    const item = await tx.taskChecklistItem.create({
      data: { taskId, text, position: last ? last.position + 1 : 0 },
    });
    await writeAuditEntry({
      tx: tx as any,
      userId: actor.userId,
      action: "TASK_CHECKLIST_ADD",
      entityType: "Task",
      entityId: taskId,
      before: null,
      after: { itemId: item.id, text },
    });
    return item;
  });
}

export interface PatchChecklistInput {
  done?: boolean;
  text?: string;
  position?: number;
}

export async function patchChecklistItem(
  taskId: string,
  itemId: string,
  patch: PatchChecklistInput,
  actor: Actor,
) {
  return prisma.$transaction(async (tx) => {
    const task = await loadTaskForChecklist(tx, taskId);
    const item = await tx.taskChecklistItem.findUnique({ where: { id: itemId } });
    if (!item || item.taskId !== taskId) {
      throw new HttpError(404, "Пункт чеклиста не найден", "TASK_CHECKLIST_ITEM_NOT_FOUND");
    }

    const isCreator = task.createdBy === actor.userId;
    const isAssignee = task.assignedTo === actor.userId;
    const isSA = actor.role === "SUPER_ADMIN";

    const wantsStructural = "text" in patch || "position" in patch;
    if (wantsStructural && !isCreator && !isSA) {
      throw new HttpError(403, "Нет прав на редактирование задачи", "TASK_EDIT_FORBIDDEN");
    }
    if ("done" in patch && !isCreator && !isAssignee && !isSA) {
      throw new HttpError(403, "Нет прав на редактирование задачи", "TASK_EDIT_FORBIDDEN");
    }

    const data: Record<string, unknown> = {};
    if ("text" in patch && patch.text !== undefined) data.text = patch.text;
    if ("position" in patch && patch.position !== undefined) data.position = patch.position;
    if ("done" in patch && patch.done !== undefined) {
      data.done = patch.done;
      data.completedAt = patch.done ? new Date() : null;
      data.completedBy = patch.done ? actor.userId : null;
    }

    // No audit row for any PATCH (toggle/text/position) — see spec §3.1.
    const updated = await tx.taskChecklistItem.update({ where: { id: itemId }, data });
    return updated;
  });
}

export async function deleteChecklistItem(taskId: string, itemId: string, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    const task = await loadTaskForChecklist(tx, taskId);
    assertCanEditContent(task, actor);
    const item = await tx.taskChecklistItem.findUnique({ where: { id: itemId } });
    if (!item || item.taskId !== taskId) {
      throw new HttpError(404, "Пункт чеклиста не найден", "TASK_CHECKLIST_ITEM_NOT_FOUND");
    }
    await writeAuditEntry({
      tx: tx as any,
      userId: actor.userId,
      action: "TASK_CHECKLIST_DELETE",
      entityType: "Task",
      entityId: taskId,
      before: { itemId, text: item.text },
      after: null,
    });
    await tx.taskChecklistItem.delete({ where: { id: itemId } });
    return { id: itemId };
  });
}

export async function listChecklist(taskId: string) {
  return prisma.taskChecklistItem.findMany({
    where: { taskId },
    orderBy: { position: "asc" },
  });
}
```

- [ ] **Step 4: Add checklist routes**

In `apps/api/src/routes/tasks.ts`, extend the collab import:

```ts
import {
  addComment, deleteComment, listComments,
  addChecklistItem, patchChecklistItem, deleteChecklistItem, listChecklist,
} from "../services/taskCollabService";
```

Add Zod schemas after `commentBodySchema`:

```ts
const checklistAddSchema = z.object({ text: z.string().trim().min(1, "Пустой пункт").max(500) });
const checklistPatchSchema = z.object({
  done: z.boolean().optional(),
  text: z.string().trim().min(1).max(500).optional(),
  position: z.number().int().min(0).optional(),
});
```

Add routes after the comment routes:

```ts
// ─── Checklist ────────────────────────────────────────────────────────────────

tasksRouter.post("/:id/checklist", rolesGuard(["SUPER_ADMIN", "WAREHOUSE", "TECHNICIAN"]), async (req, res, next) => {
  try {
    const { text } = checklistAddSchema.parse(req.body);
    const actor = { userId: req.adminUser!.userId, role: req.adminUser!.role as any };
    const item = await addChecklistItem(req.params.id, text, actor);
    res.status(201).json({ item: serializeChecklistItem(item) });
  } catch (err) { next(err); }
});

tasksRouter.patch("/:id/checklist/:itemId", rolesGuard(["SUPER_ADMIN", "WAREHOUSE", "TECHNICIAN"]), async (req, res, next) => {
  try {
    const patch = checklistPatchSchema.parse(req.body);
    const actor = { userId: req.adminUser!.userId, role: req.adminUser!.role as any };
    const item = await patchChecklistItem(req.params.id, req.params.itemId, patch, actor);
    res.json({ item: serializeChecklistItem(item) });
  } catch (err) { next(err); }
});

tasksRouter.delete("/:id/checklist/:itemId", rolesGuard(["SUPER_ADMIN", "WAREHOUSE", "TECHNICIAN"]), async (req, res, next) => {
  try {
    const actor = { userId: req.adminUser!.userId, role: req.adminUser!.role as any };
    const result = await deleteChecklistItem(req.params.id, req.params.itemId, actor);
    res.json(result);
  } catch (err) { next(err); }
});
```

Add serializer next to `serializeComment`:

```ts
function serializeChecklistItem(i: any) {
  return {
    ...i,
    completedAt: i.completedAt instanceof Date ? i.completedAt.toISOString() : i.completedAt,
    createdAt: i.createdAt instanceof Date ? i.createdAt.toISOString() : i.createdAt,
  };
}
```

- [ ] **Step 5: Run checklist tests to verify they pass**

Run: `cd apps/api && npx vitest run src/__tests__/taskCollab.test.ts -t "Checklist"`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/taskCollabService.ts apps/api/src/routes/tasks.ts apps/api/src/__tests__/taskCollab.test.ts
git commit -m "feat(tasks): checklist add/patch/delete service + routes (no toggle audit)"
```

---

## Task 4: Extend GET /api/tasks/:id with comments + checklist

**Files:**
- Modify: `apps/api/src/services/taskService.ts:378-404` (`getTask`)
- Modify: `apps/api/src/routes/tasks.ts` (GET `/:id` serialization)
- Modify: `apps/api/src/__tests__/taskCollab.test.ts`

- [ ] **Step 1: Write failing test**

Append to `taskCollab.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/__tests__/taskCollab.test.ts -t "with collab"`
Expected: FAIL — `res.body.task.comments` is `undefined`.

- [ ] **Step 3: Extend `getTask`**

In `apps/api/src/services/taskService.ts`, add a static import at the top of the file (after the existing imports — `taskCollabService` does NOT import `taskService`, so there is no import cycle):

```ts
import { listComments, listChecklist } from "./taskCollabService";
```

Then replace the `return { ...task, ... }` block at the end of `getTask` (lines ~398-403) with:

```ts
  const [comments, checklist] = await Promise.all([
    listComments(task.id),
    listChecklist(task.id),
  ]);

  return {
    ...task,
    createdByUser: userMap.get(task.createdBy) ?? null,
    assignedToUser: task.assignedTo ? (userMap.get(task.assignedTo) ?? null) : null,
    completedByUser: task.completedBy ? (userMap.get(task.completedBy) ?? null) : null,
    comments,
    checklist,
  };
```

- [ ] **Step 4: Serialize the new shape in the route**

In `apps/api/src/routes/tasks.ts`, find the GET `/:id` handler. Replace `res.json({ task: serializeTask(task) });` with:

```ts
      res.json({
        task: {
          ...serializeTask(task),
          comments: (task.comments ?? []).map(serializeComment),
          checklist: (task.checklist ?? []).map(serializeChecklistItem),
        },
      });
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/__tests__/taskCollab.test.ts -t "with collab"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/taskService.ts apps/api/src/routes/tasks.ts apps/api/src/__tests__/taskCollab.test.ts
git commit -m "feat(tasks): GET /api/tasks/:id includes comments + checklist"
```

---

## Task 5: List aggregates — commentCount + checklistSummary {done,total}

**Files:**
- Modify: `apps/api/src/services/taskService.ts:364-373` (`listTasks`)
- Modify: `apps/api/src/__tests__/taskCollab.test.ts`

- [ ] **Step 1: Write failing test**

Append to `taskCollab.test.ts`:

```ts
describe("GET /api/tasks list aggregates", () => {
  it("each item has commentCount and checklistSummary {done,total}", async () => {
    const task = await makeTask(AUTH_SA(), { title: "Aggr", assignedTo: saUser.id });
    await request(app).post(`/api/tasks/${task.id}/comments`).set(AUTH_SA()).send({ body: "c1" });
    const i1 = await request(app).post(`/api/tasks/${task.id}/checklist`).set(AUTH_SA()).send({ text: "i1" });
    await request(app).post(`/api/tasks/${task.id}/checklist`).set(AUTH_SA()).send({ text: "i2" });
    await request(app).patch(`/api/tasks/${task.id}/checklist/${i1.body.item.id}`).set(AUTH_SA()).send({ done: true });
    const res = await request(app).get("/api/tasks?filter=all&status=ALL&limit=200").set(AUTH_SA());
    const found = res.body.items.find((t: any) => t.id === task.id);
    expect(found.commentCount).toBe(1);
    expect(found.checklistSummary).toEqual({ done: 1, total: 2 });
  });

  it("a fresh task with no comments/checklist → zero baseline", async () => {
    const task = await makeTask(AUTH_SA(), { title: "Empty" });
    const res = await request(app).get("/api/tasks?filter=all&status=ALL&limit=200").set(AUTH_SA());
    const found = res.body.items.find((t: any) => t.id === task.id);
    expect(found.commentCount).toBe(0);
    expect(found.checklistSummary).toEqual({ done: 0, total: 0 });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/__tests__/taskCollab.test.ts -t "list aggregates"`
Expected: FAIL — `found.commentCount` undefined.

- [ ] **Step 3: Add aggregates to `listTasks`**

In `apps/api/src/services/taskService.ts`, in `listTasks`, replace:

```ts
  const tasks = await prisma.task.findMany({
    where,
    take: limit,
    orderBy: { id: "asc" },
  });

  const nextCursor = tasks.length === limit ? tasks[tasks.length - 1].id : null;
  const enriched = await enrichTasksWithUsers(tasks);

  return { items: enriched, nextCursor };
```

with:

```ts
  const tasks = await prisma.task.findMany({
    where,
    take: limit,
    orderBy: { id: "asc" },
    include: {
      _count: { select: { comments: true } },
      checklist: { select: { done: true } },
    },
  });

  const nextCursor = tasks.length === limit ? tasks[tasks.length - 1].id : null;
  const enriched = await enrichTasksWithUsers(tasks);

  const withAggregates = enriched.map((t: any) => {
    const checklist = (t.checklist ?? []) as Array<{ done: boolean }>;
    const { _count, checklist: _cl, ...rest } = t;
    return {
      ...rest,
      commentCount: _count?.comments ?? 0,
      checklistSummary: {
        done: checklist.filter((c) => c.done).length,
        total: checklist.length,
      },
    };
  });

  return { items: withAggregates, nextCursor };
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/__tests__/taskCollab.test.ts -t "list aggregates"`
Expected: PASS.

- [ ] **Step 5: Run the full API task suite (regression)**

Run: `cd apps/api && npx vitest run src/__tests__/tasks.test.ts src/__tests__/taskCollab.test.ts`
Expected: PASS (existing `tasks.test.ts` still green + all new tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/taskService.ts apps/api/src/__tests__/taskCollab.test.ts
git commit -m "feat(tasks): list items expose commentCount + checklistSummary {done,total}"
```

---

## Task 6: Web Task type + groupTasks

**Files:**
- Modify: `apps/web/src/components/tasks/groupTasks.ts:7-23` (`Task` interface)

- [ ] **Step 1: Extend the `Task` interface**

In `apps/web/src/components/tasks/groupTasks.ts`, add to the `Task` interface (after `completedByUser?`):

```ts
  commentCount?: number;
  checklistSummary?: { done: number; total: number };
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && npx tsc --noEmit 2>&1 | grep -v formatWaitingTime || true`
Expected: no NEW errors (pre-existing `formatWaitingTime.test.ts` TS2578 is unrelated and filtered).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/tasks/groupTasks.ts
git commit -m "feat(tasks): Task type gains commentCount + checklist summary"
```

---

## Task 7: useTaskDetail hook

**Files:**
- Create: `apps/web/src/components/tasks/useTaskDetail.ts`
- Create: `apps/web/src/components/tasks/__tests__/useTaskDetail.test.tsx`

- [ ] **Step 1: Write failing hook test**

Create `apps/web/src/components/tasks/__tests__/useTaskDetail.test.tsx`:

```tsx
import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useTaskDetail } from "../useTaskDetail";

vi.mock("../../../lib/api", () => ({
  apiFetch: vi.fn(),
}));
vi.mock("../../ToastProvider", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

import { apiFetch } from "../../../lib/api";
const mockFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

const baseTask = {
  id: "t1", title: "T", status: "OPEN", urgent: false, dueDate: null,
  description: null, createdBy: "u1", assignedTo: null, completedBy: null,
  completedAt: null, createdAt: "2026-05-18T00:00:00Z", updatedAt: "2026-05-18T00:00:00Z",
  comments: [], checklist: [],
};

beforeEach(() => {
  mockFetch.mockReset();
});

describe("useTaskDetail", () => {
  it("fetches the task on open", async () => {
    mockFetch.mockResolvedValueOnce({ task: baseTask });
    const { result } = renderHook(() => useTaskDetail("t1"));
    await waitFor(() => expect(result.current.task?.id).toBe("t1"));
    expect(mockFetch).toHaveBeenCalledWith("/api/tasks/t1");
  });

  it("optimistically appends a comment, reconciles from server", async () => {
    mockFetch.mockResolvedValueOnce({ task: baseTask }); // initial
    const { result } = renderHook(() => useTaskDetail("t1"));
    await waitFor(() => expect(result.current.task?.id).toBe("t1"));

    mockFetch.mockResolvedValueOnce({
      comment: { id: "c1", taskId: "t1", authorId: "u1", body: "hi", createdAt: "2026-05-18T01:00:00Z", authorUser: { id: "u1", username: "Иван" } },
    });
    await act(async () => {
      await result.current.addComment("hi");
    });
    expect(result.current.task?.comments.some((c) => c.body === "hi")).toBe(true);
  });

  it("rolls back the optimistic comment on failure", async () => {
    mockFetch.mockResolvedValueOnce({ task: baseTask });
    const { result } = renderHook(() => useTaskDetail("t1"));
    await waitFor(() => expect(result.current.task?.id).toBe("t1"));

    mockFetch.mockRejectedValueOnce(new Error("boom"));
    await act(async () => {
      await result.current.addComment("bad");
    });
    expect(result.current.task?.comments.some((c) => c.body === "bad")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npx vitest run src/components/tasks/__tests__/useTaskDetail.test.tsx`
Expected: FAIL — `useTaskDetail` module not found.

- [ ] **Step 3: Implement the hook**

Create `apps/web/src/components/tasks/useTaskDetail.ts`:

```ts
"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { apiFetch } from "../../lib/api";
import { toast } from "../ToastProvider";
import type { Task } from "./groupTasks";

export interface TaskComment {
  id: string;
  taskId: string;
  authorId: string;
  body: string;
  createdAt: string;
  authorUser: { id: string; username: string } | null;
}

export interface ChecklistItem {
  id: string;
  taskId: string;
  text: string;
  done: boolean;
  position: number;
  completedAt: string | null;
  completedBy: string | null;
  createdAt: string;
}

export interface TaskDetail extends Task {
  comments: TaskComment[];
  checklist: ChecklistItem[];
}

const PANEL_POLL_MS = 8000;

export function useTaskDetail(taskId: string | null) {
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const inFlight = useRef<Set<string>>(new Set());

  const fetchTask = useCallback(async () => {
    if (!taskId) return;
    try {
      const { task: t } = await apiFetch<{ task: TaskDetail }>(`/api/tasks/${taskId}`);
      setTask(t);
      setNotFound(false);
    } catch (err: any) {
      if (err?.status === 404) {
        setNotFound(true);
      }
    }
  }, [taskId]);

  // Initial load
  useEffect(() => {
    if (!taskId) {
      setTask(null);
      setNotFound(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setTask(null);
    apiFetch<{ task: TaskDetail }>(`/api/tasks/${taskId}`)
      .then((d) => { if (!cancelled) { setTask(d.task); setNotFound(false); } })
      .catch((err: any) => { if (!cancelled && err?.status === 404) setNotFound(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [taskId]);

  // Visibility-paused polling
  useEffect(() => {
    if (!taskId) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      timer = setInterval(() => { void fetchTask(); }, PANEL_POLL_MS);
    };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const onVis = () => {
      if (document.hidden) stop();
      else { void fetchTask(); start(); }
    };
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVis);
    return () => { stop(); document.removeEventListener("visibilitychange", onVis); };
  }, [taskId, fetchTask]);

  // ── addComment (optimistic) ──
  const addComment = useCallback(async (body: string) => {
    const trimmed = body.trim();
    if (!trimmed || !taskId) return;
    const tempId = `temp-${Date.now()}`;
    const optimistic: TaskComment = {
      id: tempId, taskId, authorId: "", body: trimmed,
      createdAt: new Date().toISOString(), authorUser: null,
    };
    setTask((t) => (t ? { ...t, comments: [...t.comments, optimistic] } : t));
    try {
      const { comment } = await apiFetch<{ comment: TaskComment }>(`/api/tasks/${taskId}/comments`, {
        method: "POST", body: JSON.stringify({ body: trimmed }),
      });
      setTask((t) => (t ? { ...t, comments: t.comments.map((c) => (c.id === tempId ? comment : c)) } : t));
    } catch (err: any) {
      setTask((t) => (t ? { ...t, comments: t.comments.filter((c) => c.id !== tempId) } : t));
      toast.error(err?.message ?? "Не удалось добавить комментарий");
    }
  }, [taskId]);

  // ── deleteComment (optimistic) ──
  const deleteComment = useCallback(async (commentId: string) => {
    if (!taskId) return;
    let snapshot: TaskComment[] | undefined;
    setTask((t) => {
      if (!t) return t;
      snapshot = t.comments;
      return { ...t, comments: t.comments.filter((c) => c.id !== commentId) };
    });
    try {
      await apiFetch(`/api/tasks/${taskId}/comments/${commentId}`, { method: "DELETE" });
    } catch (err: any) {
      setTask((t) => (t && snapshot ? { ...t, comments: snapshot } : t));
      toast.error(err?.message ?? "Не удалось удалить комментарий");
    }
  }, [taskId]);

  // ── addChecklistItem (optimistic) ──
  const addChecklistItem = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || !taskId) return;
    const tempId = `temp-${Date.now()}`;
    setTask((t) => {
      if (!t) return t;
      const pos = t.checklist.length;
      const optimistic: ChecklistItem = {
        id: tempId, taskId, text: trimmed, done: false, position: pos,
        completedAt: null, completedBy: null, createdAt: new Date().toISOString(),
      };
      return { ...t, checklist: [...t.checklist, optimistic] };
    });
    try {
      const { item } = await apiFetch<{ item: ChecklistItem }>(`/api/tasks/${taskId}/checklist`, {
        method: "POST", body: JSON.stringify({ text: trimmed }),
      });
      setTask((t) => (t ? { ...t, checklist: t.checklist.map((i) => (i.id === tempId ? item : i)) } : t));
    } catch (err: any) {
      setTask((t) => (t ? { ...t, checklist: t.checklist.filter((i) => i.id !== tempId) } : t));
      toast.error(err?.message ?? "Не удалось добавить пункт");
    }
  }, [taskId]);

  // ── toggleChecklistItem (optimistic) ──
  const toggleChecklistItem = useCallback(async (itemId: string, done: boolean) => {
    if (!taskId || inFlight.current.has(`cl-${itemId}`)) return;
    inFlight.current.add(`cl-${itemId}`);
    let snapshot: ChecklistItem | undefined;
    setTask((t) => {
      if (!t) return t;
      snapshot = t.checklist.find((i) => i.id === itemId);
      return { ...t, checklist: t.checklist.map((i) => (i.id === itemId ? { ...i, done } : i)) };
    });
    try {
      const { item } = await apiFetch<{ item: ChecklistItem }>(`/api/tasks/${taskId}/checklist/${itemId}`, {
        method: "PATCH", body: JSON.stringify({ done }),
      });
      setTask((t) => (t ? { ...t, checklist: t.checklist.map((i) => (i.id === itemId ? item : i)) } : t));
    } catch (err: any) {
      setTask((t) => (t && snapshot ? { ...t, checklist: t.checklist.map((i) => (i.id === itemId ? snapshot! : i)) } : t));
      toast.error(err?.message ?? "Не удалось обновить пункт");
    } finally {
      inFlight.current.delete(`cl-${itemId}`);
    }
  }, [taskId]);

  // ── deleteChecklistItem (optimistic) ──
  const deleteChecklistItem = useCallback(async (itemId: string) => {
    if (!taskId) return;
    let snapshot: ChecklistItem[] | undefined;
    setTask((t) => {
      if (!t) return t;
      snapshot = t.checklist;
      return { ...t, checklist: t.checklist.filter((i) => i.id !== itemId) };
    });
    try {
      await apiFetch(`/api/tasks/${taskId}/checklist/${itemId}`, { method: "DELETE" });
    } catch (err: any) {
      setTask((t) => (t && snapshot ? { ...t, checklist: snapshot } : t));
      toast.error(err?.message ?? "Не удалось удалить пункт");
    }
  }, [taskId]);

  return {
    task, loading, notFound,
    addComment, deleteComment,
    addChecklistItem, toggleChecklistItem, deleteChecklistItem,
    refetch: fetchTask,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/web && npx vitest run src/components/tasks/__tests__/useTaskDetail.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/tasks/useTaskDetail.ts apps/web/src/components/tasks/__tests__/useTaskDetail.test.tsx
git commit -m "feat(tasks): useTaskDetail hook — consolidated fetch + panel poll + optimistic collab"
```

---

## Task 8: TaskComments component

**Files:**
- Create: `apps/web/src/components/tasks/TaskComments.tsx`

- [ ] **Step 1: Implement the component**

Create `apps/web/src/components/tasks/TaskComments.tsx`:

```tsx
"use client";

import { useState, useRef } from "react";
import type { TaskComment } from "./useTaskDetail";

interface Props {
  comments: TaskComment[];
  currentUserId?: string;
  isSuperAdmin: boolean;
  onAdd: (body: string) => void | Promise<void>;
  onDelete: (commentId: string) => void | Promise<void>;
}

function fmt(iso: string): string {
  try {
    return new Date(iso).toLocaleString("ru-RU", {
      day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
      timeZone: "Europe/Moscow",
    });
  } catch {
    return iso;
  }
}

export function TaskComments({ comments, currentUserId, isSuperAdmin, onAdd, onDelete }: Props) {
  const [draft, setDraft] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  function submit() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    void onAdd(trimmed);
    setDraft("");
  }

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      submit();
    }
    if (e.key === "Escape") taRef.current?.blur();
  }

  return (
    <div className="space-y-3">
      <p className="eyebrow">Обсуждение</p>

      {comments.length === 0 && (
        <p className="text-[13px] text-ink-3">Пока нет комментариев</p>
      )}

      <ul className="space-y-2.5">
        {comments.map((c) => {
          const canDelete = isSuperAdmin || (currentUserId && c.authorId === currentUserId);
          return (
            <li key={c.id} className="group bg-surface-muted rounded-lg px-3 py-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[13px] font-medium text-ink">
                  {c.authorUser?.username ?? "—"}
                </span>
                <span className="text-[11px] text-ink-3">{fmt(c.createdAt)}</span>
              </div>
              <p className="text-[13px] text-ink-2 mt-0.5 whitespace-pre-wrap break-words">
                {c.body}
              </p>
              {canDelete && (
                <button
                  onClick={() => void onDelete(c.id)}
                  aria-label="Удалить комментарий"
                  className="text-[11px] text-ink-3 hover:text-rose opacity-0 group-hover:opacity-100 transition-opacity mt-1"
                >
                  Удалить
                </button>
              )}
            </li>
          );
        })}
      </ul>

      <div className="border border-border rounded-lg bg-surface focus-within:border-accent transition-colors">
        <textarea
          ref={taRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKey}
          rows={2}
          placeholder="Написать комментарий…"
          className="w-full text-[13px] text-ink bg-transparent px-3 py-2 resize-none focus:outline-none"
        />
        <div className="flex items-center justify-between px-3 py-1.5 border-t border-border">
          <span className="text-[11px] text-ink-3">⌘+Enter — отправить</span>
          <button
            onClick={submit}
            disabled={!draft.trim()}
            className="text-[13px] font-medium px-3 py-1 rounded-md bg-accent-bright text-white disabled:opacity-40 hover:opacity-90 transition-opacity"
          >
            Отправить
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && npx tsc --noEmit 2>&1 | grep -v formatWaitingTime || true`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/tasks/TaskComments.tsx
git commit -m "feat(tasks): TaskComments thread + composer component"
```

---

## Task 9: TaskChecklist component

**Files:**
- Create: `apps/web/src/components/tasks/TaskChecklist.tsx`

- [ ] **Step 1: Implement the component**

Create `apps/web/src/components/tasks/TaskChecklist.tsx`:

```tsx
"use client";

import { useState } from "react";
import type { ChecklistItem } from "./useTaskDetail";

interface Props {
  items: ChecklistItem[];
  canEdit: boolean;       // creator/SA — add/delete
  canToggle: boolean;     // creator/assignee/SA — toggle done
  onAdd: (text: string) => void | Promise<void>;
  onToggle: (itemId: string, done: boolean) => void | Promise<void>;
  onDelete: (itemId: string) => void | Promise<void>;
}

export function TaskChecklist({ items, canEdit, canToggle, onAdd, onToggle, onDelete }: Props) {
  const [draft, setDraft] = useState("");
  const done = items.filter((i) => i.done).length;
  const total = items.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  function add() {
    const t = draft.trim();
    if (!t) return;
    void onAdd(t);
    setDraft("");
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="eyebrow">Чеклист</p>
        {total > 0 && (
          <span className="text-[12px] text-ink-3 mono-num">{done}/{total}</span>
        )}
      </div>

      {total > 0 && (
        <div className="h-1.5 rounded-full bg-surface-muted overflow-hidden">
          <div
            className="h-full bg-teal transition-all"
            style={{ width: `${pct}%` }}
            aria-hidden
          />
        </div>
      )}

      <ul className="space-y-1.5">
        {items.map((i) => (
          <li key={i.id} className="group flex items-center gap-2.5">
            <button
              role="checkbox"
              aria-checked={i.done}
              aria-label={i.done ? "Снять отметку" : "Отметить выполненным"}
              disabled={!canToggle}
              onClick={() => onToggle(i.id, !i.done)}
              className={`w-[18px] h-[18px] rounded-[5px] border-2 flex items-center justify-center shrink-0 transition-colors ${
                i.done ? "bg-teal border-teal text-white" : "bg-surface border-border-strong hover:border-teal"
              } ${canToggle ? "cursor-pointer" : "cursor-default opacity-70"}`}
            >
              {i.done && (
                <svg width="10" height="8" viewBox="0 0 12 10" fill="none" aria-hidden>
                  <path d="M1 5l3.5 3.5L11 1" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
            <span className={`text-[13px] flex-1 ${i.done ? "line-through text-ink-3" : "text-ink-2"}`}>
              {i.text}
            </span>
            {canEdit && (
              <button
                onClick={() => void onDelete(i.id)}
                aria-label="Удалить пункт"
                className="text-[12px] text-ink-3 hover:text-rose opacity-0 group-hover:opacity-100 transition-opacity"
              >
                ✕
              </button>
            )}
          </li>
        ))}
      </ul>

      {canEdit && (
        <div className="flex items-center gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") add(); }}
            placeholder="Добавить пункт…"
            className="flex-1 text-[13px] px-2.5 py-1.5 border border-border rounded-md bg-surface text-ink focus:outline-none focus:border-accent"
          />
          <button
            onClick={add}
            disabled={!draft.trim()}
            className="text-[13px] font-medium px-3 py-1.5 rounded-md border border-border-strong text-ink hover:bg-surface-muted disabled:opacity-40"
          >
            +
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && npx tsc --noEmit 2>&1 | grep -v formatWaitingTime || true`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/tasks/TaskChecklist.tsx
git commit -m "feat(tasks): TaskChecklist items + progress component"
```

---

## Task 10: TaskDetailPanel slide-over

**Files:**
- Create: `apps/web/src/components/tasks/TaskDetailPanel.tsx`

- [ ] **Step 1: Implement the panel**

Create `apps/web/src/components/tasks/TaskDetailPanel.tsx`:

```tsx
"use client";

import { useEffect } from "react";
import { useTaskDetail } from "./useTaskDetail";
import { TaskComments } from "./TaskComments";
import { TaskChecklist } from "./TaskChecklist";
import { TaskAssigneePill } from "./TaskAssigneePill";
import { StatusPill } from "../StatusPill";

interface Props {
  taskId: string;
  currentUserId?: string;
  isSuperAdmin: boolean;
  onClose: () => void;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "без срока";
  try {
    return new Date(iso).toLocaleDateString("ru-RU", {
      day: "numeric", month: "long", timeZone: "Europe/Moscow",
    });
  } catch {
    return iso;
  }
}

export function TaskDetailPanel({ taskId, currentUserId, isSuperAdmin, onClose }: Props) {
  const {
    task, loading, notFound,
    addComment, deleteComment,
    addChecklistItem, toggleChecklistItem, deleteChecklistItem,
  } = useTaskDetail(taskId);

  // Esc closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Auto-close if the task was deleted elsewhere (polled 404)
  useEffect(() => {
    if (notFound) onClose();
  }, [notFound, onClose]);

  const isCreator = task ? task.createdBy === currentUserId : false;
  const isAssignee = task ? task.assignedTo === currentUserId : false;
  const canEdit = isSuperAdmin || isCreator;
  const canToggle = isSuperAdmin || isCreator || isAssignee;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-ink/40" onClick={onClose} aria-hidden />
      <div className="relative w-full max-w-[480px] h-full bg-surface shadow-xl overflow-y-auto animate-[slidein_180ms_ease-out]">
        <style>{`@keyframes slidein{from{transform:translateX(24px);opacity:.6}to{transform:translateX(0);opacity:1}}`}</style>

        {/* Header */}
        <div className="sticky top-0 bg-surface border-b border-border px-5 py-4 flex items-start justify-between gap-3 z-10">
          <div className="min-w-0">
            <p className="eyebrow">Задача</p>
            <h2 className="text-[17px] font-semibold text-ink mt-0.5 leading-snug break-words">
              {task?.title ?? (loading ? "Загрузка…" : "—")}
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Закрыть"
            className="text-ink-3 hover:text-ink text-xl leading-none shrink-0"
          >
            ✕
          </button>
        </div>

        {task && (
          <div className="p-5 space-y-6">
            {/* Meta */}
            <div className="flex flex-wrap items-center gap-2.5">
              <StatusPill
                variant={task.status === "DONE" ? "ok" : "info"}
                label={task.status === "DONE" ? "Выполнена" : "В работе"}
              />
              {task.urgent && <StatusPill variant="alert" label="🔥 Срочно" />}
              <TaskAssigneePill user={task.assignedToUser} />
              <span className="text-[12px] text-ink-3">срок: {fmtDate(task.dueDate)}</span>
            </div>

            {/* Description */}
            {task.description?.trim() && (
              <p className="text-[14px] text-ink-2 whitespace-pre-wrap leading-relaxed">
                {task.description}
              </p>
            )}

            {/* Checklist */}
            <TaskChecklist
              items={task.checklist}
              canEdit={canEdit}
              canToggle={canToggle}
              onAdd={addChecklistItem}
              onToggle={toggleChecklistItem}
              onDelete={deleteChecklistItem}
            />

            <div className="border-t border-border" />

            {/* Comments */}
            <TaskComments
              comments={task.comments}
              currentUserId={currentUserId}
              isSuperAdmin={isSuperAdmin}
              onAdd={addComment}
              onDelete={deleteComment}
            />
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && npx tsc --noEmit 2>&1 | grep -v formatWaitingTime || true`
Expected: no new errors. (If `StatusPill` variant union rejects `"info"`/`"ok"`/`"alert"`, those are valid existing variants per spec — confirm import path `../StatusPill`.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/tasks/TaskDetailPanel.tsx
git commit -m "feat(tasks): TaskDetailPanel slide-over composing checklist + comments"
```

---

## Task 11: TaskCard chips + open-panel click

**Files:**
- Modify: `apps/web/src/components/tasks/TaskCard.tsx`
- Modify: `apps/web/src/components/tasks/__tests__/TaskCard.test.tsx`

- [ ] **Step 1: Write failing test for chips**

Append to `apps/web/src/components/tasks/__tests__/TaskCard.test.tsx` (inside the existing `describe`, reuse the file's `makeTask` helper):

```tsx
it("renders comment + checklist chips when present", () => {
  const onOpen = vi.fn();
  render(
    <TaskCard
      task={makeTask({ commentCount: 3, checklistSummary: { done: 1, total: 4 } })}
      onComplete={() => {}}
      onReopen={() => {}}
      onUpdate={() => {}}
      onDelete={() => {}}
      onOpenDetail={onOpen}
    />,
  );
  expect(screen.getByText("💬 3")).toBeInTheDocument();
  expect(screen.getByText("☑ 1/4")).toBeInTheDocument();
});

it("calls onOpenDetail when the card body is clicked", () => {
  const onOpen = vi.fn();
  render(
    <TaskCard
      task={makeTask({ id: "tX" })}
      onComplete={() => {}}
      onReopen={() => {}}
      onUpdate={() => {}}
      onDelete={() => {}}
      onOpenDetail={onOpen}
    />,
  );
  fireEvent.click(screen.getByTestId("task-card-body-tX"));
  expect(onOpen).toHaveBeenCalledWith("tX");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npx vitest run src/components/tasks/__tests__/TaskCard.test.tsx -t "chips"`
Expected: FAIL — chips/`onOpenDetail` not implemented.

- [ ] **Step 3: Add the prop + chips + click target**

In `apps/web/src/components/tasks/TaskCard.tsx`, add to `TaskCardProps`:

```ts
  onOpenDetail?: (id: string) => void;
```

Add `onOpenDetail` to the destructured props in the function signature.

Wrap the title+meta block (the `<div className="min-w-0">`) so clicking it (but not the inline-edit input) opens detail. Add `data-testid` and an `onClick` guard:

```tsx
      <div
        className="min-w-0 cursor-pointer"
        data-testid={`task-card-body-${task.id}`}
        onClick={(e) => {
          if (editingTitle) return;
          if ((e.target as HTMLElement).closest("button,input,a")) return;
          onOpenDetail?.(task.id);
        }}
      >
```

(Replace the existing opening `<div className="min-w-0">` tag with the above; keep all children unchanged.)

Then, immediately after the creator meta `<p>` (the `{creator && (...)}` block), add chips:

```tsx
        {((task.commentCount ?? 0) > 0 || (task.checklistSummary?.total ?? 0) > 0) && (
          <div className="flex items-center gap-2 mt-1">
            {(task.commentCount ?? 0) > 0 && (
              <span className="text-[11px] text-ink-3">💬 {task.commentCount}</span>
            )}
            {(task.checklistSummary?.total ?? 0) > 0 && (
              <span className="text-[11px] text-ink-3">
                ☑ {task.checklistSummary!.done}/{task.checklistSummary!.total}
              </span>
            )}
          </div>
        )}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/web && npx vitest run src/components/tasks/__tests__/TaskCard.test.tsx`
Expected: PASS (existing TaskCard tests + 2 new).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/tasks/TaskCard.tsx apps/web/src/components/tasks/__tests__/TaskCard.test.tsx
git commit -m "feat(tasks): TaskCard 💬/☑ chips + open-detail click target"
```

---

## Task 12: Wire panel into TaskGroupList + TasksPage with ?task= deep-link

**Files:**
- Modify: `apps/web/src/components/tasks/TaskGroupList.tsx`
- Modify: `apps/web/src/components/tasks/TasksPage.tsx`

- [ ] **Step 1: Thread `onOpenDetail` through TaskGroupList**

In `apps/web/src/components/tasks/TaskGroupList.tsx`, add `onOpenDetail?: (id: string) => void;` to its props interface, accept it in the destructured props, and pass `onOpenDetail={onOpenDetail}` to every `<TaskCard ... />` it renders (mirror how `onOpenEdit` is already passed).

- [ ] **Step 2: Wire `?task=` + panel into TasksPage**

In `apps/web/src/components/tasks/TasksPage.tsx`:

Add imports:

```ts
import { TaskDetailPanel } from "./TaskDetailPanel";
```

After `const [filter, setFilter] = useState<TaskFilter>(initialFilter);`, add:

```ts
  const openTaskId = searchParams?.get("task") ?? null;

  const openDetail = useCallback((id: string) => {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    params.set("task", id);
    router.replace(`/tasks?${params.toString()}`);
  }, [router, searchParams]);

  const closeDetail = useCallback(() => {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    params.delete("task");
    const qs = params.toString();
    router.replace(qs ? `/tasks?${qs}` : "/tasks");
  }, [router, searchParams]);
```

Pass `onOpenDetail={openDetail}` to `<TaskGroupList ... />`.

Render the panel before the closing `</div>` of the page (alongside the other modals):

```tsx
      {openTaskId && user && (
        <TaskDetailPanel
          taskId={openTaskId}
          currentUserId={user.userId}
          isSuperAdmin={user.role === "SUPER_ADMIN"}
          onClose={closeDetail}
        />
      )}
```

(Confirm `user.userId` exists on the `useRequireRole` user — `CurrentUser.userId` is the established field per `src/lib/auth.ts`. If the role field is named differently, match the existing usage already in this file.)

- [ ] **Step 3: Typecheck**

Run: `cd apps/web && npx tsc --noEmit 2>&1 | grep -v formatWaitingTime || true`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/tasks/TaskGroupList.tsx apps/web/src/components/tasks/TasksPage.tsx
git commit -m "feat(tasks): ?task= deep-link opens TaskDetailPanel from list"
```

---

## Task 13: List smart-polling in useTasksQuery

**Files:**
- Modify: `apps/web/src/components/tasks/useTasksQuery.ts`

- [ ] **Step 1: Add a visibility-aware 12 s list poller**

In `apps/web/src/components/tasks/useTasksQuery.ts`, extract the fetch into a reusable callback and add a polling effect. After the existing initial-load `useEffect` (the one depending on `[filter]`), add:

```ts
  // ── Smart polling: refetch list every 12s, paused when tab hidden ──
  useEffect(() => {
    const POLL_MS = 12000;
    let timer: ReturnType<typeof setInterval> | null = null;

    const poll = () => {
      apiFetch<TasksListResponse>(`/api/tasks?filter=${filter}&status=ALL&limit=200`)
        .then((data) => setTasks(data.items ?? []))
        .catch(() => { /* keep last good state; errors surfaced on user actions */ });
    };

    const start = () => { if (!timer) timer = setInterval(poll, POLL_MS); };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const onVis = () => {
      if (document.hidden) stop();
      else { poll(); start(); }
    };

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVis);
    return () => { stop(); document.removeEventListener("visibilitychange", onVis); };
  }, [filter]);
```

(Place it so it does not run before the initial load completes is unnecessary — the initial `useEffect` already populates state immediately; the poller's first tick is 12 s later. The `setTasks` here is the same setter already in scope.)

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && npx tsc --noEmit 2>&1 | grep -v formatWaitingTime || true`
Expected: no new errors.

- [ ] **Step 3: Run the full web task test suite (regression)**

Run: `cd apps/web && npx vitest run src/components/tasks`
Expected: PASS (all task component + hook tests green; poller uses real timers but tests don't advance 12 s so no interference).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/tasks/useTasksQuery.ts
git commit -m "feat(tasks): visibility-aware 12s list smart-polling"
```

---

## Task 14: Documentation

**Files:**
- Modify: `CLAUDE.md` (Tasks Feature section)

- [ ] **Step 1: Update CLAUDE.md**

In `CLAUDE.md`, under `## Tasks Feature (Sprint 3)`:

Add to the **API endpoints** table:

```
| `/api/tasks/:id/comments` | POST | Добавить комментарий (все роли) |
| `/api/tasks/:id/comments/:commentId` | DELETE | Удалить (автор или SA) |
| `/api/tasks/:id/checklist` | POST | Добавить пункт (creator/SA) |
| `/api/tasks/:id/checklist/:itemId` | PATCH | Тогл done (creator/assignee/SA) / текст·позиция (creator/SA) |
| `/api/tasks/:id/checklist/:itemId` | DELETE | Удалить пункт (creator/SA) |
```

Note that `GET /api/tasks/:id` now includes `comments[]` + `checklist[]`, and `GET /api/tasks` items include `commentCount` + `checklistSummary {done,total}`.

Add a Key Files block:

```
| `apps/api/src/services/taskCollabService.ts` | Comment + checklist CRUD, $transaction + audit; enrichAuthors join |
| `apps/web/src/components/tasks/useTaskDetail.ts` | Consolidated GET /api/tasks/:id + 8s panel poll + optimistic comment/checklist |
| `apps/web/src/components/tasks/TaskDetailPanel.tsx` | Right slide-over (?task= deep-link); composes checklist + comments |
| `apps/web/src/components/tasks/TaskComments.tsx` | Comment thread + composer (⌘+Enter) |
| `apps/web/src/components/tasks/TaskChecklist.tsx` | Ordered items + progress bar |
```

Add to the **Conventions (дополнение)** list:

```
- **Task collab realtime.** Smart polling: список 12 s, открытая панель 8 s, пауза при `document.hidden`, мгновенный refetch после своей мутации. SSE — задокументированный v2-путь (spec §10).
- **Checklist toggles НЕ аудируются** (высокочастотны, прогресс самоочевиден). Аудируются только `TASK_COMMENT_ADD/DELETE` и `TASK_CHECKLIST_ADD/DELETE` — в той же транзакции, `entityType: "Task"`, `entityId: taskId`.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: tasks collaboration + realtime endpoints, files, conventions"
```

---

## Task 15: Full regression + deploy

**Files:** none (verification + deploy)

- [ ] **Step 1: Run the full API suite**

Run: `cd apps/api && npm run test`
Expected: all green (478+ existing tests + new `taskCollab.test.ts`).

- [ ] **Step 2: Run the full web suite**

Run: `cd apps/web && npm run test`
Expected: all green.

- [ ] **Step 3: Production build sanity (web)**

Run: `cd apps/web && npm run build`
Expected: build succeeds (App Router compiles `TasksPage` + new components).

- [ ] **Step 4: Push + deploy**

```bash
git push origin main
ssh root@194.60.134.177 "cd /opt/light-rental-system && git pull && bash deploy.sh --api --web 2>&1" 2>&1 | tail -20
```
Expected: PM2 `api` + `web` online, no crash loop. (API schema changed → `--api --web`; deploy.sh runs `prisma db push` after DB backup.)

- [ ] **Step 5: Smoke-check prod**

```bash
curl -sI https://svetobazarent.ru/tasks
```
Expected: `307` redirect to `/login` (route alive). Then manual: log in, open a task → slide-over panel; add a comment + checklist item; open the same task in a second browser/tab and confirm it appears within ~12 s.

---

## Self-Review Notes

- **Spec coverage:** §3 data model → Task 1. §3.1 audit (no toggle audit) → Tasks 2–3 + asserted in tests. §4.1 extended GET/list → Tasks 4–5. §4.2 endpoints + §4.3 permissions → Tasks 2–3. §5 polling → Tasks 7 (panel) + 13 (list). §6 components → Tasks 8–12. §7 error handling → optimistic rollback in Task 7, 404 auto-close in Task 10. §8 testing → Tasks 2–7 + 15. §9 docs → Task 14. §10 (SSE) intentionally not built (documented future path).
- **Type consistency:** `TaskComment`/`ChecklistItem`/`TaskDetail` defined in Task 7 (`useTaskDetail.ts`) and consumed identically in Tasks 8–10. Service fn names (`addComment`, `listComments`, `deleteComment`, `addChecklistItem`, `patchChecklistItem`, `deleteChecklistItem`, `listChecklist`) consistent between Tasks 2–5 and route wiring. `onOpenDetail` prop name consistent across Tasks 11–12.
- **No placeholders:** every code step contains full code; the only conditional ("if taskService.ts nears 800 lines") is resolved decisively — collab logic lives in the new `taskCollabService.ts`.
