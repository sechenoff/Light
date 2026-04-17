/**
 * Сервис управления задачами (to-do list).
 *
 * Все мутации обёрнуты в prisma.$transaction + writeAuditEntry.
 * Идемпотентность: completeTask/reopenTask не пишут аудит если уже в целевом состоянии.
 */

import type { UserRole, TaskStatus } from "@prisma/client";
import { prisma } from "../prisma";
import { writeAuditEntry, diffFields } from "./audit";
import { HttpError } from "../utils/errors";
import { fromMoscowDateString, moscowTodayStart, addDays } from "../utils/moscowDate";

type Actor = {
  userId: string;
  role: UserRole;
};

type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

// ─── validateAssignee ─────────────────────────────────────────────────────────

/**
 * Проверяет, что assignedTo существует в AdminUser.
 * null/undefined — допустимо (задача без исполнителя).
 */
export async function validateAssignee(
  assignedToId: string | null | undefined,
  tx?: TxClient,
): Promise<void> {
  if (assignedToId == null) return;

  const client = tx ?? prisma;
  const user = await (client as any).adminUser.findUnique({
    where: { id: assignedToId },
    select: { id: true },
  });
  if (!user) {
    throw new HttpError(400, "Исполнитель не найден", "INVALID_ASSIGNEE");
  }
}

// ─── createTask ───────────────────────────────────────────────────────────────

export interface CreateTaskInput {
  title: string;
  description?: string;
  urgent?: boolean;
  dueDate?: string | null; // "YYYY-MM-DD" or null
  assignedTo?: string | null;
}

export async function createTask(input: CreateTaskInput, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    await validateAssignee(input.assignedTo, tx as unknown as TxClient);

    const task = await tx.task.create({
      data: {
        title: input.title,
        description: input.description ?? null,
        urgent: input.urgent ?? false,
        dueDate: input.dueDate ? fromMoscowDateString(input.dueDate) : null,
        createdBy: actor.userId,
        assignedTo: input.assignedTo ?? null,
        status: "OPEN",
      },
    });

    await writeAuditEntry({
      tx: tx as any,
      userId: actor.userId,
      action: "TASK_CREATE",
      entityType: "Task",
      entityId: task.id,
      before: null,
      after: diffFields({ ...task } as unknown as Record<string, unknown>),
    });

    return task;
  });
}

// ─── updateTask ───────────────────────────────────────────────────────────────

export interface UpdateTaskInput {
  title?: string;
  description?: string | null;
  dueDate?: string | null; // "YYYY-MM-DD" or null
  assignedTo?: string | null;
  urgent?: boolean;
}

export async function updateTask(id: string, patch: UpdateTaskInput, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.task.findUnique({ where: { id } });
    if (!existing) {
      throw new HttpError(404, "Задача не найдена", "TASK_NOT_FOUND");
    }

    const isCreator = existing.createdBy === actor.userId;
    const isAssignee = existing.assignedTo === actor.userId;
    const isSA = actor.role === "SUPER_ADMIN";

    // Content fields: title, description, dueDate, assignedTo
    const contentKeys: (keyof UpdateTaskInput)[] = ["title", "description", "dueDate", "assignedTo"];
    const wantsContentChange = contentKeys.some((k) => k in patch);

    if (wantsContentChange && !isCreator && !isSA) {
      throw new HttpError(403, "Нет прав на редактирование задачи", "TASK_EDIT_FORBIDDEN");
    }

    // urgent flag: creator, assignee, or SA
    if ("urgent" in patch && !isCreator && !isAssignee && !isSA) {
      throw new HttpError(403, "Нет прав на редактирование задачи", "TASK_EDIT_FORBIDDEN");
    }

    const assignedToChanged =
      "assignedTo" in patch && patch.assignedTo !== existing.assignedTo;

    if (assignedToChanged) {
      await validateAssignee(patch.assignedTo, tx as unknown as TxClient);
    }

    // Build update data
    const updateData: Record<string, unknown> = {};
    if ("title" in patch && patch.title !== undefined) updateData.title = patch.title;
    if ("description" in patch) updateData.description = patch.description ?? null;
    if ("urgent" in patch && patch.urgent !== undefined) updateData.urgent = patch.urgent;
    if ("assignedTo" in patch) updateData.assignedTo = patch.assignedTo ?? null;
    if ("dueDate" in patch) {
      updateData.dueDate = patch.dueDate ? fromMoscowDateString(patch.dueDate) : null;
    }

    const updated = await tx.task.update({ where: { id }, data: updateData });

    // Audit: TASK_ASSIGN if assignedTo changed, else TASK_UPDATE
    if (assignedToChanged) {
      await writeAuditEntry({
        tx: tx as any,
        userId: actor.userId,
        action: "TASK_ASSIGN",
        entityType: "Task",
        entityId: id,
        before: { assignedTo: existing.assignedTo },
        after: { assignedTo: updated.assignedTo },
      });
    } else {
      // Build diff: only changed fields
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(updateData)) {
        const existingVal = (existing as unknown as Record<string, unknown>)[k];
        before[k] = existingVal;
        after[k] = v;
      }
      await writeAuditEntry({
        tx: tx as any,
        userId: actor.userId,
        action: "TASK_UPDATE",
        entityType: "Task",
        entityId: id,
        before: diffFields(before),
        after: diffFields(after),
      });
    }

    return updated;
  });
}

// ─── completeTask ─────────────────────────────────────────────────────────────

export async function completeTask(id: string, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.task.findUnique({ where: { id } });
    if (!existing) {
      throw new HttpError(404, "Задача не найдена", "TASK_NOT_FOUND");
    }

    // Идемпотентность: уже выполнена — возвращаем без аудита
    if (existing.status === "DONE") {
      return existing;
    }

    const updated = await tx.task.update({
      where: { id },
      data: {
        status: "DONE",
        completedBy: actor.userId,
        completedAt: new Date(),
      },
    });

    await writeAuditEntry({
      tx: tx as any,
      userId: actor.userId,
      action: "TASK_COMPLETE",
      entityType: "Task",
      entityId: id,
      before: { status: "OPEN" },
      after: { status: "DONE", completedBy: actor.userId, completedAt: updated.completedAt?.toISOString() },
    });

    return updated;
  });
}

// ─── reopenTask ───────────────────────────────────────────────────────────────

export async function reopenTask(id: string, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.task.findUnique({ where: { id } });
    if (!existing) {
      throw new HttpError(404, "Задача не найдена", "TASK_NOT_FOUND");
    }

    // Идемпотентность: уже открыта — возвращаем без аудита
    if (existing.status === "OPEN") {
      return existing;
    }

    const updated = await tx.task.update({
      where: { id },
      data: {
        status: "OPEN",
        completedBy: null,
        completedAt: null,
      },
    });

    await writeAuditEntry({
      tx: tx as any,
      userId: actor.userId,
      action: "TASK_REOPEN",
      entityType: "Task",
      entityId: id,
      before: { status: "DONE" },
      after: { status: "OPEN" },
    });

    return updated;
  });
}

// ─── deleteTask ───────────────────────────────────────────────────────────────

export async function deleteTask(id: string, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.task.findUnique({ where: { id } });
    if (!existing) {
      throw new HttpError(404, "Задача не найдена", "TASK_NOT_FOUND");
    }

    const isCreator = existing.createdBy === actor.userId;
    const isSA = actor.role === "SUPER_ADMIN";

    if (!isCreator && !isSA) {
      throw new HttpError(403, "Нет прав на удаление задачи", "TASK_DELETE_FORBIDDEN");
    }

    // Аудит ПЕРЕД удалением
    await writeAuditEntry({
      tx: tx as any,
      userId: actor.userId,
      action: "TASK_DELETE",
      entityType: "Task",
      entityId: id,
      before: diffFields(existing as unknown as Record<string, unknown>),
      after: null,
    });

    await tx.task.delete({ where: { id } });

    return { id };
  });
}

// ─── listTasks ────────────────────────────────────────────────────────────────

export interface ListTasksInput {
  filter?: "my" | "all" | "created-by-me";
  status?: TaskStatus;
  urgent?: boolean;
  overdue?: boolean;
  limit?: number;
  cursor?: string;
}

export async function listTasks(input: ListTasksInput, actor: Actor) {
  const {
    filter = "my",
    status = "OPEN",
    urgent,
    overdue,
    limit = 100,
    cursor,
  } = input;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: any = {};

  // Filter by scope
  if (filter === "my") {
    where.assignedTo = actor.userId;
  } else if (filter === "created-by-me") {
    where.createdBy = actor.userId;
  }
  // filter === "all" → no user scope filter

  // Status
  if (status) where.status = status;

  // Urgent
  if (urgent !== undefined) where.urgent = urgent;

  // Overdue: dueDate < today Moscow start
  if (overdue === true) {
    const todayStart = moscowTodayStart();
    where.dueDate = { lt: todayStart };
  }

  // Keyset pagination via id (cuid, monotonically increasing)
  if (cursor) {
    // Using id > cursor (ascending order)
    where.id = { gt: cursor };
  }

  const tasks = await prisma.task.findMany({
    where,
    take: limit,
    orderBy: { id: "asc" },
  });

  const nextCursor = tasks.length === limit ? tasks[tasks.length - 1].id : null;

  return { items: tasks, nextCursor };
}

// ─── getTask (single) ─────────────────────────────────────────────────────────

export async function getTask(id: string) {
  const task = await prisma.task.findUnique({ where: { id } });
  if (!task) {
    throw new HttpError(404, "Задача не найдена", "TASK_NOT_FOUND");
  }

  // Enrich with user labels (no FK, join manually)
  const userIds = [task.createdBy, task.assignedTo, task.completedBy].filter(
    (v): v is string => v != null,
  );
  const users =
    userIds.length > 0
      ? await prisma.adminUser.findMany({
          where: { id: { in: userIds } },
          select: { id: true, username: true, role: true },
        })
      : [];

  const userMap = new Map(users.map((u) => [u.id, u]));

  return {
    ...task,
    createdByUser: userMap.get(task.createdBy) ?? null,
    assignedToUser: task.assignedTo ? (userMap.get(task.assignedTo) ?? null) : null,
    completedByUser: task.completedBy ? (userMap.get(task.completedBy) ?? null) : null,
  };
}

// ─── getMyTasksForToday (dashboard widget) ────────────────────────────────────

/** Тип краткой информации о задаче для дашборда */
export interface TaskSummary {
  id: string;
  title: string;
  urgent: boolean;
  dueDate: string | null;
  status: string;
}

/**
 * Возвращает до 5 задач для виджета «Мои задачи» на дашборде:
 * просроченные ∪ сегодняшние ∪ срочные-без-даты, сортировка по dueDate asc (nulls last).
 */
export async function getMyTasksForToday(userId: string): Promise<TaskSummary[]> {
  const todayStart = moscowTodayStart();
  const tomorrowStart = addDays(todayStart, 1);

  const tasks = await prisma.task.findMany({
    where: {
      status: "OPEN",
      assignedTo: userId,
      OR: [
        { dueDate: { lt: tomorrowStart } },   // overdue or today
        { dueDate: null, urgent: true },        // urgent undated
      ],
    },
    orderBy: [{ dueDate: "asc" }, { id: "asc" }],
    take: 5,
    select: { id: true, title: true, urgent: true, dueDate: true, status: true },
  });

  return tasks.map((t) => ({
    ...t,
    dueDate: t.dueDate ? t.dueDate.toISOString() : null,
  }));
}
