/**
 * Сервис для заявок обратной связи (баги / идеи / комментарии).
 *
 * Контракт безопасности:
 *  - Создавать может любая роль из allowlist (SUPER_ADMIN/WAREHOUSE/TECHNICIAN).
 *  - Менять статус (NEW/IN_PROGRESS/DONE/REJECTED) — только SUPER_ADMIN.
 *  - Удалять заявку и редактировать title/description — автор или SUPER_ADMIN.
 *  - Комментарии добавляют все, удалять — автор или SUPER_ADMIN.
 *
 * Все мутации обёрнуты в prisma.$transaction + writeAuditEntry. Фото лежат
 * в uploads/feedback/{feedbackId}/ через FeedbackPhotoStorage.
 */

import type { FeedbackCategory, FeedbackStatus, UserRole } from "@prisma/client";
import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";
import { writeAuditEntry } from "./audit";

type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

export interface Actor {
  userId: string;
  role: UserRole;
}

const FEEDBACK_CATEGORIES = ["BUG", "IDEA", "COMMENT"] as const satisfies readonly FeedbackCategory[];
const FEEDBACK_STATUSES = ["NEW", "IN_PROGRESS", "DONE", "REJECTED"] as const satisfies readonly FeedbackStatus[];

export function isFeedbackCategory(v: unknown): v is FeedbackCategory {
  return typeof v === "string" && (FEEDBACK_CATEGORIES as readonly string[]).includes(v);
}
export function isFeedbackStatus(v: unknown): v is FeedbackStatus {
  return typeof v === "string" && (FEEDBACK_STATUSES as readonly string[]).includes(v);
}

// ─── enrichFeedbackWithUsers ──────────────────────────────────────────────────

/**
 * Join AdminUser для createdBy/resolvedBy (FK в схеме нет).
 */
export async function enrichFeedbackWithUsers<
  T extends { createdBy: string; resolvedBy: string | null },
>(items: T[]): Promise<Array<T & {
  createdByUser: { id: string; username: string } | null;
  resolvedByUser: { id: string; username: string } | null;
}>> {
  if (items.length === 0) return [] as Array<T & { createdByUser: null; resolvedByUser: null }>;
  const ids = new Set<string>();
  for (const it of items) {
    if (it.createdBy) ids.add(it.createdBy);
    if (it.resolvedBy) ids.add(it.resolvedBy);
  }
  const users = ids.size > 0
    ? await prisma.adminUser.findMany({
        where: { id: { in: Array.from(ids) } },
        select: { id: true, username: true },
      })
    : [];
  const map = new Map(users.map((u) => [u.id, u]));
  return items.map((it) => ({
    ...it,
    createdByUser: map.get(it.createdBy) ?? null,
    resolvedByUser: it.resolvedBy ? (map.get(it.resolvedBy) ?? null) : null,
  }));
}

async function enrichCommentsWithUsers(
  items: Array<{ id: string; authorId: string; body: string; createdAt: Date }>,
) {
  if (items.length === 0) return [] as Array<typeof items[number] & { authorUser: { id: string; username: string } | null }>;
  const ids = Array.from(new Set(items.map((c) => c.authorId)));
  const users = await prisma.adminUser.findMany({
    where: { id: { in: ids } },
    select: { id: true, username: true },
  });
  const map = new Map(users.map((u) => [u.id, u]));
  return items.map((c) => ({ ...c, authorUser: map.get(c.authorId) ?? null }));
}

// ─── listFeedback ─────────────────────────────────────────────────────────────

export interface ListFeedbackInput {
  status?: FeedbackStatus | "ALL";
  category?: FeedbackCategory | "ALL";
  createdBy?: string;
  cursor?: string;
  limit?: number;
}

export async function listFeedback(input: ListFeedbackInput) {
  const limit = Math.max(1, Math.min(100, input.limit ?? 50));
  const where: {
    status?: FeedbackStatus;
    category?: FeedbackCategory;
    createdBy?: string;
  } = {};
  if (input.status && input.status !== "ALL") where.status = input.status;
  if (input.category && input.category !== "ALL") where.category = input.category;
  if (input.createdBy) where.createdBy = input.createdBy;

  const items = await prisma.feedbackItem.findMany({
    where,
    take: limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    orderBy: [{ createdAt: "desc" }],
    include: {
      _count: { select: { comments: true, photos: true } },
    },
  });

  const hasMore = items.length > limit;
  const slice = hasMore ? items.slice(0, limit) : items;
  const enriched = await enrichFeedbackWithUsers(slice);
  return {
    items: enriched.map((it) => ({
      id: it.id,
      category: it.category,
      status: it.status,
      title: it.title,
      description: it.description,
      pageUrl: it.pageUrl,
      createdBy: it.createdBy,
      createdByUser: it.createdByUser,
      resolvedAt: it.resolvedAt,
      createdAt: it.createdAt,
      updatedAt: it.updatedAt,
      commentCount: it._count.comments,
      photoCount: it._count.photos,
    })),
    nextCursor: hasMore ? slice[slice.length - 1].id : null,
  };
}

// ─── getFeedback ──────────────────────────────────────────────────────────────

export async function getFeedback(id: string) {
  const item = await prisma.feedbackItem.findUnique({
    where: { id },
    include: {
      comments: { orderBy: { createdAt: "asc" } },
      photos: { orderBy: { createdAt: "asc" }, select: { id: true, createdAt: true, createdBy: true } },
    },
  });
  if (!item) throw new HttpError(404, "Заявка не найдена", "FEEDBACK_NOT_FOUND");
  const [enriched] = await enrichFeedbackWithUsers([item]);
  const comments = await enrichCommentsWithUsers(item.comments);
  return {
    id: enriched.id,
    category: enriched.category,
    status: enriched.status,
    title: enriched.title,
    description: enriched.description,
    pageUrl: enriched.pageUrl,
    viewport: enriched.viewport,
    userAgent: enriched.userAgent,
    createdBy: enriched.createdBy,
    createdByUser: enriched.createdByUser,
    resolvedBy: enriched.resolvedBy,
    resolvedByUser: enriched.resolvedByUser,
    resolvedAt: enriched.resolvedAt,
    createdAt: enriched.createdAt,
    updatedAt: enriched.updatedAt,
    comments: comments.map((c) => ({
      id: c.id,
      body: c.body,
      authorId: c.authorId,
      authorUser: c.authorUser,
      createdAt: c.createdAt,
    })),
    photos: item.photos.map((p) => ({
      id: p.id,
      url: `/api/feedback/${item.id}/photos/${p.id}`,
      createdAt: p.createdAt,
      createdBy: p.createdBy,
    })),
  };
}

// ─── createFeedback ───────────────────────────────────────────────────────────

export interface CreateFeedbackInput {
  category: FeedbackCategory;
  title: string;
  description: string;
  pageUrl?: string | null;
  viewport?: string | null;
  userAgent?: string | null;
}

export async function createFeedback(input: CreateFeedbackInput, actor: Actor) {
  if (!isFeedbackCategory(input.category)) {
    throw new HttpError(400, "Недопустимая категория", "INVALID_CATEGORY");
  }
  const title = input.title.trim();
  const description = input.description.trim();
  if (title.length < 3) throw new HttpError(400, "Заголовок слишком короткий", "TITLE_TOO_SHORT");
  if (title.length > 200) throw new HttpError(400, "Заголовок слишком длинный", "TITLE_TOO_LONG");
  if (description.length < 3) throw new HttpError(400, "Описание слишком короткое", "DESCRIPTION_TOO_SHORT");
  if (description.length > 4000) throw new HttpError(400, "Описание слишком длинное", "DESCRIPTION_TOO_LONG");

  return prisma.$transaction(async (tx) => {
    const item = await tx.feedbackItem.create({
      data: {
        category: input.category,
        title,
        description,
        pageUrl: input.pageUrl?.slice(0, 1000) ?? null,
        viewport: input.viewport?.slice(0, 32) ?? null,
        userAgent: input.userAgent?.slice(0, 500) ?? null,
        createdBy: actor.userId,
      },
    });
    await writeAuditEntry({
      tx: tx as unknown as TxClient,
      userId: actor.userId,
      action: "FEEDBACK_CREATE",
      entityType: "Feedback",
      entityId: item.id,
      before: null,
      after: { category: item.category, title: item.title, status: item.status },
    });
    return item;
  });
}

// ─── updateFeedback (title/description/category by author or SA) ─────────────

export interface UpdateFeedbackInput {
  title?: string;
  description?: string;
  category?: FeedbackCategory;
}

export async function updateFeedback(id: string, input: UpdateFeedbackInput, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    const current = await tx.feedbackItem.findUnique({ where: { id } });
    if (!current) throw new HttpError(404, "Заявка не найдена", "FEEDBACK_NOT_FOUND");
    if (current.createdBy !== actor.userId && actor.role !== "SUPER_ADMIN") {
      throw new HttpError(403, "Можно редактировать только свои заявки", "FEEDBACK_EDIT_FORBIDDEN");
    }
    const data: Record<string, unknown> = {};
    if (input.title !== undefined) {
      const t = input.title.trim();
      if (t.length < 3 || t.length > 200) throw new HttpError(400, "Некорректный заголовок", "TITLE_INVALID");
      data.title = t;
    }
    if (input.description !== undefined) {
      const d = input.description.trim();
      if (d.length < 3 || d.length > 4000) throw new HttpError(400, "Некорректное описание", "DESCRIPTION_INVALID");
      data.description = d;
    }
    if (input.category !== undefined) {
      if (!isFeedbackCategory(input.category)) throw new HttpError(400, "Недопустимая категория", "INVALID_CATEGORY");
      data.category = input.category;
    }
    if (Object.keys(data).length === 0) return current;

    const updated = await tx.feedbackItem.update({ where: { id }, data });
    await writeAuditEntry({
      tx: tx as unknown as TxClient,
      userId: actor.userId,
      action: "FEEDBACK_UPDATE",
      entityType: "Feedback",
      entityId: id,
      before: { title: current.title, description: current.description, category: current.category },
      after: { title: updated.title, description: updated.description, category: updated.category },
    });
    return updated;
  });
}

// ─── changeStatus (SUPER_ADMIN only) ─────────────────────────────────────────

export async function changeFeedbackStatus(id: string, nextStatus: FeedbackStatus, actor: Actor) {
  if (actor.role !== "SUPER_ADMIN") {
    throw new HttpError(403, "Менять статус может только администратор", "FEEDBACK_STATUS_FORBIDDEN");
  }
  if (!isFeedbackStatus(nextStatus)) throw new HttpError(400, "Недопустимый статус", "INVALID_STATUS");

  return prisma.$transaction(async (tx) => {
    const current = await tx.feedbackItem.findUnique({ where: { id } });
    if (!current) throw new HttpError(404, "Заявка не найдена", "FEEDBACK_NOT_FOUND");
    if (current.status === nextStatus) return current;

    const isResolved = nextStatus === "DONE" || nextStatus === "REJECTED";
    const updated = await tx.feedbackItem.update({
      where: { id },
      data: {
        status: nextStatus,
        resolvedBy: isResolved ? actor.userId : null,
        resolvedAt: isResolved ? new Date() : null,
      },
    });
    await writeAuditEntry({
      tx: tx as unknown as TxClient,
      userId: actor.userId,
      action: "FEEDBACK_STATUS_CHANGE",
      entityType: "Feedback",
      entityId: id,
      before: { status: current.status },
      after: { status: nextStatus },
    });
    return updated;
  });
}

// ─── deleteFeedback ──────────────────────────────────────────────────────────

export async function deleteFeedback(id: string, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    const current = await tx.feedbackItem.findUnique({
      where: { id },
      include: { photos: true },
    });
    if (!current) throw new HttpError(404, "Заявка не найдена", "FEEDBACK_NOT_FOUND");
    if (current.createdBy !== actor.userId && actor.role !== "SUPER_ADMIN") {
      throw new HttpError(403, "Можно удалить только свою заявку", "FEEDBACK_DELETE_FORBIDDEN");
    }
    await tx.feedbackItem.delete({ where: { id } });
    await writeAuditEntry({
      tx: tx as unknown as TxClient,
      userId: actor.userId,
      action: "FEEDBACK_DELETE",
      entityType: "Feedback",
      entityId: id,
      before: { title: current.title, category: current.category, status: current.status },
      after: null,
    });
    return { ok: true, photoFiles: current.photos.map((p) => p.filePath) };
  });
}

// ─── comments ────────────────────────────────────────────────────────────────

export async function addComment(feedbackId: string, body: string, actor: Actor) {
  const text = body.trim();
  if (text.length < 1) throw new HttpError(400, "Комментарий пустой", "COMMENT_EMPTY");
  if (text.length > 4000) throw new HttpError(400, "Комментарий слишком длинный", "COMMENT_TOO_LONG");

  return prisma.$transaction(async (tx) => {
    const fb = await tx.feedbackItem.findUnique({ where: { id: feedbackId }, select: { id: true } });
    if (!fb) throw new HttpError(404, "Заявка не найдена", "FEEDBACK_NOT_FOUND");
    const comment = await tx.feedbackComment.create({
      data: { feedbackId, authorId: actor.userId, body: text },
    });
    await writeAuditEntry({
      tx: tx as unknown as TxClient,
      userId: actor.userId,
      action: "FEEDBACK_COMMENT_ADD",
      entityType: "Feedback",
      entityId: feedbackId,
      before: null,
      after: { commentId: comment.id },
    });
    return comment;
  });
}

export async function deleteComment(feedbackId: string, commentId: string, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    const comment = await tx.feedbackComment.findUnique({ where: { id: commentId } });
    if (!comment || comment.feedbackId !== feedbackId) throw new HttpError(404, "Комментарий не найден", "COMMENT_NOT_FOUND");
    if (comment.authorId !== actor.userId && actor.role !== "SUPER_ADMIN") {
      throw new HttpError(403, "Можно удалить только свой комментарий", "COMMENT_DELETE_FORBIDDEN");
    }
    await tx.feedbackComment.delete({ where: { id: commentId } });
    await writeAuditEntry({
      tx: tx as unknown as TxClient,
      userId: actor.userId,
      action: "FEEDBACK_COMMENT_DELETE",
      entityType: "Feedback",
      entityId: feedbackId,
      before: { commentId, body: comment.body },
      after: null,
    });
    return { ok: true };
  });
}

// ─── photos ──────────────────────────────────────────────────────────────────

export async function attachPhoto(
  feedbackId: string,
  filePath: string,
  actor: Actor,
) {
  return prisma.$transaction(async (tx) => {
    const fb = await tx.feedbackItem.findUnique({ where: { id: feedbackId }, select: { id: true } });
    if (!fb) throw new HttpError(404, "Заявка не найдена", "FEEDBACK_NOT_FOUND");
    const photo = await tx.feedbackPhoto.create({
      data: { feedbackId, filePath, createdBy: actor.userId },
    });
    return photo;
  });
}

export async function getPhoto(feedbackId: string, photoId: string) {
  const photo = await prisma.feedbackPhoto.findUnique({ where: { id: photoId } });
  if (!photo || photo.feedbackId !== feedbackId) throw new HttpError(404, "Фото не найдено", "PHOTO_NOT_FOUND");
  return photo;
}

export async function deletePhoto(feedbackId: string, photoId: string, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    const photo = await tx.feedbackPhoto.findUnique({ where: { id: photoId } });
    if (!photo || photo.feedbackId !== feedbackId) throw new HttpError(404, "Фото не найдено", "PHOTO_NOT_FOUND");
    if (photo.createdBy !== actor.userId && actor.role !== "SUPER_ADMIN") {
      throw new HttpError(403, "Можно удалить только своё фото", "PHOTO_DELETE_FORBIDDEN");
    }
    await tx.feedbackPhoto.delete({ where: { id: photoId } });
    return { ok: true, filePath: photo.filePath };
  });
}

// ─── stats (for menu badge) ──────────────────────────────────────────────────

export async function getFeedbackStats() {
  const [newCount, inProgressCount, total] = await Promise.all([
    prisma.feedbackItem.count({ where: { status: "NEW" } }),
    prisma.feedbackItem.count({ where: { status: "IN_PROGRESS" } }),
    prisma.feedbackItem.count(),
  ]);
  return { newCount, inProgressCount, openCount: newCount + inProgressCount, total };
}
