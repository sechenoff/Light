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
import { listComments, listChecklist } from "./taskCollabService";

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

// ─── validateRelatedBooking / Client ──────────────────────────────────────────

/**
 * Проверяет, что relatedBookingId ссылается на существующую бронь.
 * null/undefined — допустимо (задача без привязки).
 */
export async function validateRelatedBooking(
  bookingId: string | null | undefined,
  tx?: TxClient,
): Promise<void> {
  if (bookingId == null) return;
  const client = tx ?? prisma;
  const booking = await (client as any).booking.findUnique({
    where: { id: bookingId },
    select: { id: true },
  });
  if (!booking) {
    throw new HttpError(400, "Бронь не найдена", "INVALID_RELATED_BOOKING");
  }
}

/**
 * Проверяет, что relatedClientId ссылается на существующего клиента.
 * null/undefined — допустимо.
 */
export async function validateRelatedClient(
  clientId: string | null | undefined,
  tx?: TxClient,
): Promise<void> {
  if (clientId == null) return;
  const client = tx ?? prisma;
  const found = await (client as any).client.findUnique({
    where: { id: clientId },
    select: { id: true },
  });
  if (!found) {
    throw new HttpError(400, "Клиент не найден", "INVALID_RELATED_CLIENT");
  }
}

// ─── enrichTasksWithRelated ───────────────────────────────────────────────────

/** Краткая карточка связанной брони для чипа-ссылки. */
export interface RelatedBookingRef {
  id: string;
  projectName: string;
  clientId: string;
  clientName: string;
}

/** Краткая карточка связанного клиента для чипа-ссылки. */
export interface RelatedClientRef {
  id: string;
  name: string;
}

/**
 * Обогащает задачи связанной бронью/клиентом одним batch-запросом (без N+1).
 * Для брони подтягивается projectName + имя клиента. Явный relatedClientId
 * резолвится отдельно (задача может быть привязана к клиенту без брони).
 */
export async function enrichTasksWithRelated<
  T extends { relatedBookingId: string | null; relatedClientId: string | null },
>(tasks: T[]): Promise<Array<T & {
  relatedBooking: RelatedBookingRef | null;
  relatedClient: RelatedClientRef | null;
}>> {
  if (tasks.length === 0) return [] as any;

  const bookingIds = new Set<string>();
  const clientIds = new Set<string>();
  for (const t of tasks) {
    if (t.relatedBookingId) bookingIds.add(t.relatedBookingId);
    if (t.relatedClientId) clientIds.add(t.relatedClientId);
  }

  const bookings =
    bookingIds.size > 0
      ? await prisma.booking.findMany({
          where: { id: { in: Array.from(bookingIds) } },
          select: { id: true, projectName: true, clientId: true, client: { select: { name: true } } },
        })
      : [];
  const bookingMap = new Map(
    bookings.map((b) => [
      b.id,
      { id: b.id, projectName: b.projectName, clientId: b.clientId, clientName: b.client.name },
    ]),
  );

  const clients =
    clientIds.size > 0
      ? await prisma.client.findMany({
          where: { id: { in: Array.from(clientIds) } },
          select: { id: true, name: true },
        })
      : [];
  const clientMap = new Map(clients.map((c) => [c.id, { id: c.id, name: c.name }]));

  return tasks.map((t) => ({
    ...t,
    relatedBooking: t.relatedBookingId ? (bookingMap.get(t.relatedBookingId) ?? null) : null,
    relatedClient: t.relatedClientId ? (clientMap.get(t.relatedClientId) ?? null) : null,
  })) as any;
}

// ─── enrichTasksWithUsers ─────────────────────────────────────────────────────

/**
 * Joins AdminUser rows for createdBy/assignedTo/completedBy (no FK in schema).
 * Returns tasks with `createdByUser`, `assignedToUser`, `completedByUser` populated.
 */
export async function enrichTasksWithUsers<
  T extends { createdBy: string; assignedTo: string | null; completedBy: string | null },
>(tasks: T[]): Promise<Array<T & {
  createdByUser: { id: string; username: string } | null;
  assignedToUser: { id: string; username: string } | null;
  completedByUser: { id: string; username: string } | null;
}>> {
  if (tasks.length === 0) return [] as any;
  const ids = new Set<string>();
  for (const t of tasks) {
    if (t.createdBy) ids.add(t.createdBy);
    if (t.assignedTo) ids.add(t.assignedTo);
    if (t.completedBy) ids.add(t.completedBy);
  }
  const users =
    ids.size > 0
      ? await prisma.adminUser.findMany({
          where: { id: { in: Array.from(ids) } },
          select: { id: true, username: true },
        })
      : [];
  const userMap = new Map(users.map((u) => [u.id, u]));
  return tasks.map((t) => ({
    ...t,
    createdByUser: userMap.get(t.createdBy) ?? null,
    assignedToUser: t.assignedTo ? (userMap.get(t.assignedTo) ?? null) : null,
    completedByUser: t.completedBy ? (userMap.get(t.completedBy) ?? null) : null,
  })) as any;
}

// ─── createTask ───────────────────────────────────────────────────────────────

export interface CreateTaskInput {
  title: string;
  description?: string;
  urgent?: boolean;
  dueDate?: string | null; // "YYYY-MM-DD" or null
  assignedTo?: string | null;
  relatedBookingId?: string | null;
  relatedClientId?: string | null;
}

export async function createTask(input: CreateTaskInput, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    await validateAssignee(input.assignedTo, tx as unknown as TxClient);
    await validateRelatedBooking(input.relatedBookingId, tx as unknown as TxClient);
    await validateRelatedClient(input.relatedClientId, tx as unknown as TxClient);

    const task = await tx.task.create({
      data: {
        title: input.title,
        description: input.description ?? null,
        urgent: input.urgent ?? false,
        dueDate: input.dueDate ? fromMoscowDateString(input.dueDate) : null,
        createdBy: actor.userId,
        assignedTo: input.assignedTo ?? null,
        relatedBookingId: input.relatedBookingId ?? null,
        relatedClientId: input.relatedClientId ?? null,
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
  relatedBookingId?: string | null;
  relatedClientId?: string | null;
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

    // Content fields: title, description, dueDate, assignedTo, related links
    const contentKeys: (keyof UpdateTaskInput)[] = [
      "title", "description", "dueDate", "assignedTo", "relatedBookingId", "relatedClientId",
    ];
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
    if ("relatedBookingId" in patch && patch.relatedBookingId !== existing.relatedBookingId) {
      await validateRelatedBooking(patch.relatedBookingId, tx as unknown as TxClient);
    }
    if ("relatedClientId" in patch && patch.relatedClientId !== existing.relatedClientId) {
      await validateRelatedClient(patch.relatedClientId, tx as unknown as TxClient);
    }

    // Build update data
    const updateData: Record<string, unknown> = {};
    if ("title" in patch && patch.title !== undefined) updateData.title = patch.title;
    if ("description" in patch) updateData.description = patch.description ?? null;
    if ("urgent" in patch && patch.urgent !== undefined) updateData.urgent = patch.urgent;
    if ("assignedTo" in patch) updateData.assignedTo = patch.assignedTo ?? null;
    if ("relatedBookingId" in patch) updateData.relatedBookingId = patch.relatedBookingId ?? null;
    if ("relatedClientId" in patch) updateData.relatedClientId = patch.relatedClientId ?? null;
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
  status?: TaskStatus | "ALL";
  urgent?: boolean;
  overdue?: boolean;
  limit?: number;
  cursor?: string;
  /**
   * "id-asc" (default) — стабильный порядок создания + keyset-пагинация по id.
   * "completedAt-desc" — свежевыполненные первыми (архив + секция «Выполнено
   * сегодня»); keyset-пагинация по compound-курсору "<completedAt ISO>|<id>"
   * (конвенция `{iso}|{id}` как в /lk).
   */
  sort?: "id-asc" | "completedAt-desc";
}

export async function listTasks(input: ListTasksInput, actor: Actor) {
  const {
    filter = "my",
    status = "OPEN",
    urgent,
    overdue,
    limit = 100,
    cursor,
    sort = "id-asc",
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

  // Status — "ALL" means no status filter (return both OPEN and DONE)
  if (status && status !== "ALL") where.status = status;

  // Urgent
  if (urgent !== undefined) where.urgent = urgent;

  // Overdue: dueDate < today Moscow start
  if (overdue === true) {
    const todayStart = moscowTodayStart();
    where.dueDate = { lt: todayStart };
  }

  // Keyset pagination:
  //  - id-asc: cursor = id (cuid монотонно растёт) → id > cursor;
  //  - completedAt-desc: compound-курсор "<completedAt ISO>|<id>" →
  //    (completedAt, id) строго «дальше» в desc-порядке.
  if (cursor) {
    if (sort === "completedAt-desc") {
      const sep = cursor.lastIndexOf("|");
      const iso = sep > 0 ? cursor.slice(0, sep) : "";
      const cursorId = sep > 0 ? cursor.slice(sep + 1) : "";
      const cursorDate = new Date(iso);
      if (!cursorId || Number.isNaN(cursorDate.getTime())) {
        throw new HttpError(400, "Некорректный курсор", "INVALID_CURSOR");
      }
      where.AND = [
        {
          OR: [
            { completedAt: { lt: cursorDate } },
            { completedAt: cursorDate, id: { lt: cursorId } },
          ],
        },
      ];
    } else {
      // Using id > cursor (ascending order)
      where.id = { gt: cursor };
    }
  }

  const tasks = await prisma.task.findMany({
    where,
    take: limit,
    orderBy:
      sort === "completedAt-desc"
        ? [{ completedAt: "desc" }, { id: "desc" }]
        : { id: "asc" },
    include: {
      _count: { select: { comments: true } },
      checklist: { select: { done: true } },
    },
  });

  // nextCursor только при полной странице. Для completedAt-desc: аномальные
  // DONE без completedAt сортируются в конец (NULLs last в desc у SQLite) —
  // курсор на них не строим, пагинация честно останавливается.
  const last = tasks.length === limit ? tasks[tasks.length - 1] : null;
  const nextCursor = !last
    ? null
    : sort === "completedAt-desc"
      ? last.completedAt
        ? `${last.completedAt.toISOString()}|${last.id}`
        : null
      : last.id;
  const enrichedUsers = await enrichTasksWithUsers(tasks);
  const enriched = await enrichTasksWithRelated(enrichedUsers);

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

  const [comments, checklist, [withRelated]] = await Promise.all([
    listComments(task.id),
    listChecklist(task.id),
    enrichTasksWithRelated([task]),
  ]);

  return {
    ...task,
    createdByUser: userMap.get(task.createdBy) ?? null,
    assignedToUser: task.assignedTo ? (userMap.get(task.assignedTo) ?? null) : null,
    completedByUser: task.completedBy ? (userMap.get(task.completedBy) ?? null) : null,
    relatedBooking: withRelated?.relatedBooking ?? null,
    relatedClient: withRelated?.relatedClient ?? null,
    comments,
    checklist,
  };
}

// ─── searchBookingsForLink (task↔booking picker) ──────────────────────────────

/**
 * Лёгкий поиск броней для привязки задачи. Возвращает id + projectName + имя
 * клиента, без вложенных позиций/смет. Регистронезависимый поиск по-русски
 * (как в bookings.ts eq-search): SQLite LIKE игнорит кириллицу, поэтому
 * фильтруем кандидатов в приложении через toLocaleLowerCase("ru-RU").
 * DRAFT-брони включены — менеджер может ставить задачу и на черновик.
 * Архивные (deletedAt != null) исключены.
 */
export async function searchBookingsForLink(
  q: string,
  limit = 10,
): Promise<RelatedBookingRef[]> {
  const needle = q.trim().toLocaleLowerCase("ru-RU");
  if (needle.length === 0) return [];

  const candidates = await prisma.booking.findMany({
    where: { deletedAt: null },
    select: { id: true, projectName: true, clientId: true, client: { select: { name: true } } },
    orderBy: { startDate: "desc" },
    take: 200,
  });

  const matched: RelatedBookingRef[] = [];
  for (const c of candidates) {
    const hay = `${c.projectName} ${c.client.name}`.toLocaleLowerCase("ru-RU");
    if (hay.includes(needle)) {
      matched.push({ id: c.id, projectName: c.projectName, clientId: c.clientId, clientName: c.client.name });
      if (matched.length >= limit) break;
    }
  }
  return matched;
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
