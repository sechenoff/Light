/**
 * Роутер /api/tasks — Tasks (to-do list) feature, Sprint 1
 *
 * GET    /              — список задач
 * POST   /              — создать задачу
 * GET    /:id           — детали задачи
 * PATCH  /:id           — обновить задачу (split permissions)
 * POST   /:id/complete  — выполнить задачу (идемпотентно)
 * POST   /:id/reopen    — вернуть в работу (идемпотентно)
 * DELETE /:id           — удалить задачу (creator или SA)
 */

import express from "express";
import { z } from "zod";
import { rolesGuard } from "../middleware/rolesGuard";
import {
  createTask,
  updateTask,
  completeTask,
  reopenTask,
  deleteTask,
  listTasks,
  getTask,
  enrichTasksWithUsers,
} from "../services/taskService";
import {
  addComment, deleteComment,
  addChecklistItem, patchChecklistItem, deleteChecklistItem,
} from "../services/taskCollabService";

async function enrichOne<T extends { createdBy: string; assignedTo: string | null; completedBy: string | null }>(
  task: T,
): Promise<any> {
  const [enriched] = await enrichTasksWithUsers([task]);
  return enriched;
}

export const tasksRouter = express.Router();

// ─── Zod схемы ───────────────────────────────────────────────────────────────

const moscowDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const createTaskSchema = z.object({
  title: z.string().trim().min(1, "Заголовок обязателен").max(500),
  description: z.string().trim().max(5000).optional(),
  urgent: z.boolean().optional().default(false),
  dueDate: moscowDateSchema.nullable().optional(),
  assignedTo: z.string().min(1).nullable().optional(),
});

const updateTaskSchema = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  description: z.string().trim().max(5000).nullable().optional(),
  dueDate: moscowDateSchema.nullable().optional(),
  assignedTo: z.string().min(1).nullable().optional(),
  urgent: z.boolean().optional(),
});

const listQuerySchema = z.object({
  filter: z.enum(["my", "all", "created-by-me"]).optional().default("my"),
  status: z.enum(["OPEN", "DONE", "ALL"]).optional().default("OPEN"),
  urgent: z.coerce.boolean().optional(),
  overdue: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(100),
  cursor: z.string().optional(),
  sort: z.enum(["id-asc", "completedAt-desc"]).optional().default("id-asc"),
});

const commentBodySchema = z.object({ body: z.string().trim().min(1, "Пустой комментарий").max(5000) });

const checklistAddSchema = z.object({ text: z.string().trim().min(1, "Пустой пункт").max(500) });
const checklistPatchSchema = z.object({
  done: z.boolean().optional(),
  text: z.string().trim().min(1).max(500).optional(),
});

// ─── Serializer ──────────────────────────────────────────────────────────────

function serializeTask(t: any) {
  return {
    ...t,
    dueDate: t.dueDate instanceof Date ? t.dueDate.toISOString() : t.dueDate,
    completedAt: t.completedAt instanceof Date ? t.completedAt.toISOString() : t.completedAt,
    createdAt: t.createdAt instanceof Date ? t.createdAt.toISOString() : t.createdAt,
    updatedAt: t.updatedAt instanceof Date ? t.updatedAt.toISOString() : t.updatedAt,
  };
}

function serializeComment(c: any) {
  return { ...c, createdAt: c.createdAt instanceof Date ? c.createdAt.toISOString() : c.createdAt };
}

function serializeChecklistItem(i: any) {
  return {
    ...i,
    completedAt: i.completedAt instanceof Date ? i.completedAt.toISOString() : i.completedAt,
    createdAt: i.createdAt instanceof Date ? i.createdAt.toISOString() : i.createdAt,
  };
}

// ─── GET / ────────────────────────────────────────────────────────────────────

tasksRouter.get(
  "/",
  rolesGuard(["SUPER_ADMIN", "WAREHOUSE", "TECHNICIAN"]),
  async (req, res, next) => {
    try {
      const query = listQuerySchema.parse(req.query);
      const actor = { userId: req.adminUser!.userId, role: req.adminUser!.role as any };
      const result = await listTasks(query, actor);
      res.json({
        items: result.items.map(serializeTask),
        nextCursor: result.nextCursor,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST / ──────────────────────────────────────────────────────────────────

tasksRouter.post(
  "/",
  rolesGuard(["SUPER_ADMIN", "WAREHOUSE", "TECHNICIAN"]),
  async (req, res, next) => {
    try {
      const body = createTaskSchema.parse(req.body);
      const actor = { userId: req.adminUser!.userId, role: req.adminUser!.role as any };
      const task = await createTask(body, actor);
      res.status(201).json({ task: serializeTask(await enrichOne(task)) });
    } catch (err) {
      next(err);
    }
  },
);

// ─── GET /:id ─────────────────────────────────────────────────────────────────

tasksRouter.get(
  "/:id",
  rolesGuard(["SUPER_ADMIN", "WAREHOUSE", "TECHNICIAN"]),
  async (req, res, next) => {
    try {
      const task = await getTask(req.params.id);
      res.json({
        task: {
          ...serializeTask(task),
          comments: (task.comments ?? []).map(serializeComment),
          checklist: (task.checklist ?? []).map(serializeChecklistItem),
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── PATCH /:id ───────────────────────────────────────────────────────────────

tasksRouter.patch(
  "/:id",
  rolesGuard(["SUPER_ADMIN", "WAREHOUSE", "TECHNICIAN"]),
  async (req, res, next) => {
    try {
      const body = updateTaskSchema.parse(req.body);
      const actor = { userId: req.adminUser!.userId, role: req.adminUser!.role as any };
      const task = await updateTask(req.params.id, body, actor);
      res.json({ task: serializeTask(await enrichOne(task)) });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /:id/complete ──────────────────────────────────────────────────────

tasksRouter.post(
  "/:id/complete",
  rolesGuard(["SUPER_ADMIN", "WAREHOUSE", "TECHNICIAN"]),
  async (req, res, next) => {
    try {
      const actor = { userId: req.adminUser!.userId, role: req.adminUser!.role as any };
      const task = await completeTask(req.params.id, actor);
      res.json({ task: serializeTask(await enrichOne(task)) });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /:id/reopen ────────────────────────────────────────────────────────

tasksRouter.post(
  "/:id/reopen",
  rolesGuard(["SUPER_ADMIN", "WAREHOUSE", "TECHNICIAN"]),
  async (req, res, next) => {
    try {
      const actor = { userId: req.adminUser!.userId, role: req.adminUser!.role as any };
      const task = await reopenTask(req.params.id, actor);
      res.json({ task: serializeTask(await enrichOne(task)) });
    } catch (err) {
      next(err);
    }
  },
);

// ─── DELETE /:id ─────────────────────────────────────────────────────────────

tasksRouter.delete(
  "/:id",
  rolesGuard(["SUPER_ADMIN", "WAREHOUSE", "TECHNICIAN"]),
  async (req, res, next) => {
    try {
      const actor = { userId: req.adminUser!.userId, role: req.adminUser!.role as any };
      const result = await deleteTask(req.params.id, actor);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

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
