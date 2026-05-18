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
  const comment = await prisma.$transaction(async (tx) => {
    await assertTaskExists(tx, taskId);
    const created = await tx.taskComment.create({
      data: { taskId, authorId: actor.userId, body },
    });
    await writeAuditEntry({
      tx: tx as any,
      userId: actor.userId,
      action: "TASK_COMMENT_ADD",
      entityType: "Task",
      entityId: taskId,
      before: null,
      after: { commentId: created.id, body },
    });
    return created;
  });
  const [enriched] = await enrichAuthors([comment]);
  return enriched;
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
