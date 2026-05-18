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
