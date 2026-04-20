/**
 * Сервис управления проектами Gaffer CRM.
 */

import type { Request } from "express";
import type { GafferProjectStatus } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "../../prisma";
import { HttpError } from "../../utils/errors";
import { gafferWhere } from "./tenant";

// ─── Типы ─────────────────────────────────────────────────────────────────────

export interface ListProjectsOpts {
  status?: GafferProjectStatus;
  search?: string;
  clientId?: string;
  memberContactId?: string;
}

export interface CreateProjectInput {
  title: string;
  clientId: string;
  shootDate: Date;
  clientPlanAmount?: string | number;
  lightBudgetAmount?: string | number;
  note?: string;
  members?: Array<{
    contactId: string;
    plannedAmount: string | number;
    roleLabel?: string | null;
  }>;
}

export interface UpdateProjectInput {
  title?: string;
  clientId?: string;
  shootDate?: Date;
  clientPlanAmount?: string | number;
  lightBudgetAmount?: string | number;
  note?: string | null;
}

// ─── Тип проекта с платежами и участниками ────────────────────────────────────

export type ProjectWithRelations = {
  id: string;
  gafferUserId: string;
  title: string;
  clientId: string;
  shootDate: Date;
  clientPlanAmount: Decimal;
  lightBudgetAmount: Decimal;
  status: GafferProjectStatus;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
  members: Array<{
    id: string;
    plannedAmount: Decimal;
    contactId: string;
    roleLabel: string | null;
    contact?: { type?: string } | null;
    [key: string]: unknown;
  }>;
  payments: Array<{
    direction: "IN" | "OUT";
    amount: Decimal;
    memberId: string | null;
    [key: string]: unknown;
  }>;
  client?: Record<string, unknown>;
  _count?: { members: number };
};

// ─── Агрегаты долга ───────────────────────────────────────────────────────────

export interface ProjectDebtAggregates {
  clientReceived: string;
  clientTotal: string;
  clientRemaining: string;
  lightBudgetAmount: string;
  teamPlanTotal: string;
  teamPaidTotal: string;
  teamRemaining: string;
  vendorPlanTotal: string;
  vendorPaidTotal: string;
  vendorRemaining: string;
}

/**
 * Вычисляет агрегаты долга для проекта.
 * Все суммы возвращаются в виде строк (Decimal serialization).
 */
export function computeProjectDebts(project: ProjectWithRelations): ProjectDebtAggregates {
  const ZERO = new Decimal(0);

  // clientReceived = сумма IN-платежей
  const clientReceived = project.payments
    .filter((p) => p.direction === "IN")
    .reduce((acc, p) => acc.plus(p.amount), ZERO);

  // clientTotal = clientPlanAmount (договорная сумма с заказчиком — доход за проект)
  const clientTotal = new Decimal(project.clientPlanAmount);

  // clientRemaining = max(0, clientTotal - clientReceived)
  const rawClientRemaining = clientTotal.minus(clientReceived);
  const clientRemaining = rawClientRemaining.gt(ZERO) ? rawClientRemaining : ZERO;

  // Разделяем участников по типу контакта
  const teamMembers = project.members.filter((m) => m.contact?.type === "TEAM_MEMBER");
  const vendorMembers = project.members.filter((m) => m.contact?.type === "VENDOR");

  // Карта memberId → тип для партиционирования OUT-платежей
  // GafferPayment.memberId === GafferContact.id (не GafferProjectMember.id)
  const memberTypeById = new Map<string, "TEAM_MEMBER" | "VENDOR">();
  for (const m of project.members) {
    const t = m.contact?.type;
    if (t === "TEAM_MEMBER" || t === "VENDOR") {
      memberTypeById.set(m.contactId, t);
    }
  }

  // teamPlanTotal = сумма plannedAmount только TEAM_MEMBER-участников
  const teamPlanTotal = teamMembers.reduce(
    (acc, m) => acc.plus(m.plannedAmount),
    ZERO,
  );

  // vendorPlanTotal = сумма plannedAmount только VENDOR-участников
  const vendorPlanTotal = vendorMembers.reduce(
    (acc, m) => acc.plus(m.plannedAmount),
    ZERO,
  );

  // Разделяем OUT-платежи по типу memberId
  let teamPaidTotal = ZERO;
  let vendorPaidTotal = ZERO;
  for (const p of project.payments) {
    if (p.direction !== "OUT") continue;
    const resolvedType = p.memberId ? memberTypeById.get(p.memberId) : undefined;
    if (resolvedType === "VENDOR") {
      vendorPaidTotal = vendorPaidTotal.plus(p.amount);
    } else {
      // TEAM_MEMBER, null memberId, or unresolved → backward compat
      teamPaidTotal = teamPaidTotal.plus(p.amount);
    }
  }

  // teamRemaining = max(0, teamPlanTotal - teamPaidTotal)
  const rawTeamRemaining = teamPlanTotal.minus(teamPaidTotal);
  const teamRemaining = rawTeamRemaining.gt(ZERO) ? rawTeamRemaining : ZERO;

  // vendorRemaining = max(0, vendorPlanTotal - vendorPaidTotal)
  const rawVendorRemaining = vendorPlanTotal.minus(vendorPaidTotal);
  const vendorRemaining = rawVendorRemaining.gt(ZERO) ? rawVendorRemaining : ZERO;

  return {
    clientReceived: clientReceived.toString(),
    clientTotal: clientTotal.toString(),
    clientRemaining: clientRemaining.toString(),
    lightBudgetAmount: new Decimal(project.lightBudgetAmount).toString(),
    teamPlanTotal: teamPlanTotal.toString(),
    teamPaidTotal: teamPaidTotal.toString(),
    teamRemaining: teamRemaining.toString(),
    vendorPlanTotal: vendorPlanTotal.toString(),
    vendorPaidTotal: vendorPaidTotal.toString(),
    vendorRemaining: vendorRemaining.toString(),
  };
}

// ─── Валидация клиента ────────────────────────────────────────────────────────

async function validateClientContact(
  gafferUserId: string,
  clientId: string,
  context: "create" | "update" = "create",
) {
  const contact = await prisma.gafferContact.findFirst({
    where: { id: clientId, gafferUserId },
  });

  if (!contact) {
    if (context === "update") {
      throw new HttpError(404, "Контакт не найден", "NOT_FOUND");
    }
    throw new HttpError(404, "Клиент не найден", "NOT_FOUND");
  }

  if (contact.type !== "CLIENT") {
    throw new HttpError(400, "Контакт должен быть типа CLIENT", "INVALID_CLIENT_TYPE");
  }

  if (contact.isArchived) {
    throw new HttpError(400, "Нельзя использовать архивный контакт в качестве клиента", "CLIENT_ARCHIVED");
  }
}

// ─── Включения для запросов ───────────────────────────────────────────────────

const listIncludes = {
  members: {
    select: {
      plannedAmount: true,
      contactId: true,
      contact: { select: { type: true } },
    },
  },
  payments: {
    select: { direction: true, amount: true, memberId: true },
  },
} as const;

const detailIncludes = {
  client: true,
  members: {
    include: { contact: true },
    orderBy: { createdAt: "asc" as const },
  },
  payments: {
    include: {
      method: true,
      member: true,
    },
    orderBy: [
      { paidAt: "desc" as const },
      { createdAt: "desc" as const },
    ] as Array<{ paidAt?: "asc" | "desc"; createdAt?: "asc" | "desc" }>,
  },
};

// ─── Публичные функции ────────────────────────────────────────────────────────

/** Список проектов с агрегатами долга. */
export async function listProjects(req: Request, opts: ListProjectsOpts) {
  const { gafferUserId } = gafferWhere(req);
  const where: Record<string, unknown> = { gafferUserId };

  // По умолчанию — только OPEN
  where.status = opts.status ?? "OPEN";

  if (opts.search) {
    where.title = { contains: opts.search };
  }
  if (opts.clientId) {
    where.clientId = opts.clientId;
  }
  if (opts.memberContactId) {
    where.members = {
      some: { contactId: opts.memberContactId },
    };
  }

  const projects = await prisma.gafferProject.findMany({
    where,
    include: listIncludes,
    orderBy: { shootDate: "desc" },
  });

  return projects.map((p) => ({
    ...p,
    clientPlanAmount: p.clientPlanAmount.toString(),
    members: undefined, // убираем из ответа — заменяем агрегатами
    payments: undefined,
    ...computeProjectDebts(p as ProjectWithRelations),
  }));
}

/** Получить один проект с участниками, платежами и агрегатами. */
export async function getProject(req: Request, id: string) {
  const { gafferUserId } = gafferWhere(req);

  const project = await prisma.gafferProject.findFirst({
    where: { id, gafferUserId },
    include: detailIncludes,
  });

  if (!project) {
    throw new HttpError(404, "Проект не найден", "NOT_FOUND");
  }

  const debts = computeProjectDebts(project as unknown as ProjectWithRelations);

  // Агрегаты по каждому участнику: сколько выплачено и сколько осталось.
  const ZERO = new Decimal(0);
  return {
    ...project,
    clientPlanAmount: project.clientPlanAmount.toString(),
    members: project.members.map((m) => {
      // GafferPayment.memberId → GafferContact.id (FK), не GafferProjectMember.id.
      const paid = project.payments
        .filter((p) => p.direction === "OUT" && p.memberId === m.contactId)
        .reduce((acc, p) => acc.plus(p.amount), ZERO);
      const planned = new Decimal(m.plannedAmount);
      const raw = planned.minus(paid);
      const remaining = raw.gt(ZERO) ? raw : ZERO;
      return {
        ...m,
        plannedAmount: m.plannedAmount.toString(),
        paidToMe: paid.toString(),
        remaining: remaining.toString(),
      };
    }),
    payments: project.payments.map((p) => ({
      ...p,
      amount: p.amount.toString(),
    })),
    ...debts,
  };
}

/** Создать проект. */
export async function createProject(req: Request, data: CreateProjectInput) {
  const { gafferUserId } = gafferWhere(req);

  await validateClientContact(gafferUserId, data.clientId, "create");

  const memberContactIds = (data.members ?? []).map((m) => m.contactId);

  const project = await prisma.$transaction(async (tx) => {
    // Validate members inside transaction to prevent TOCTOU race
    if (memberContactIds.length > 0) {
      const validContacts = await tx.gafferContact.findMany({
        where: {
          id: { in: memberContactIds },
          gafferUserId,
          type: { in: ["TEAM_MEMBER", "VENDOR"] },
          isArchived: false,
        },
        select: { id: true },
      });
      if (validContacts.length !== memberContactIds.length) {
        throw new HttpError(
          400,
          "Один или несколько участников не найдены или недоступны",
          "INVALID_MEMBER_CONTACT",
        );
      }
    }

    const created = await tx.gafferProject.create({
      data: {
        gafferUserId,
        title: data.title.trim(),
        clientId: data.clientId,
        shootDate: data.shootDate,
        clientPlanAmount: data.clientPlanAmount !== undefined
          ? new Decimal(data.clientPlanAmount)
          : new Decimal(0),
        lightBudgetAmount: data.lightBudgetAmount !== undefined
          ? new Decimal(data.lightBudgetAmount)
          : new Decimal(0),
        note: data.note?.trim() ?? null,
      },
      include: {
        members: true,
      },
    });

    if (data.members && data.members.length > 0) {
      await tx.gafferProjectMember.createMany({
        data: data.members.map((m) => ({
          projectId: created.id,
          contactId: m.contactId,
          plannedAmount: new Decimal(m.plannedAmount),
          roleLabel: m.roleLabel ?? null,
        })),
      });
    }

    // Return with populated members
    return tx.gafferProject.findUnique({
      where: { id: created.id },
      include: { members: true },
    });
  });

  if (!project) throw new HttpError(500, "Не удалось создать проект", "INTERNAL_ERROR");

  return {
    ...project,
    clientPlanAmount: project.clientPlanAmount.toString(),
    lightBudgetAmount: project.lightBudgetAmount.toString(),
    members: project.members.map((m) => ({
      ...m,
      plannedAmount: m.plannedAmount.toString(),
    })),
  };
}

/** Частичное обновление проекта. */
export async function updateProject(req: Request, id: string, data: UpdateProjectInput) {
  const { gafferUserId } = gafferWhere(req);

  if (data.clientId !== undefined) {
    await validateClientContact(gafferUserId, data.clientId, "update");
  }

  const updateData: Record<string, unknown> = {};
  if (data.title !== undefined) updateData.title = data.title.trim();
  if (data.clientId !== undefined) updateData.clientId = data.clientId;
  if (data.shootDate !== undefined) updateData.shootDate = data.shootDate;
  if (data.clientPlanAmount !== undefined) {
    updateData.clientPlanAmount = new Decimal(data.clientPlanAmount);
  }
  if (data.lightBudgetAmount !== undefined) {
    updateData.lightBudgetAmount = new Decimal(data.lightBudgetAmount);
  }
  if (data.note !== undefined) updateData.note = data.note?.trim() ?? null;

  const result = await prisma.gafferProject.updateMany({
    where: { id, gafferUserId },
    data: updateData,
  });

  if (result.count === 0) {
    throw new HttpError(404, "Проект не найден", "NOT_FOUND");
  }

  const updated = await prisma.gafferProject.findUnique({ where: { id } });
  if (!updated) throw new HttpError(404, "Проект не найден", "NOT_FOUND");

  return { ...updated, clientPlanAmount: updated.clientPlanAmount.toString(), lightBudgetAmount: updated.lightBudgetAmount.toString() };
}

/** Архивировать проект. */
export async function archiveProject(req: Request, id: string) {
  const { gafferUserId } = gafferWhere(req);

  // Загружаем проект с платежами и участниками для расчёта остатков.
  const projectWithRelations = await prisma.gafferProject.findFirst({
    where: { id, gafferUserId },
    include: listIncludes,
  });

  if (!projectWithRelations) throw new HttpError(404, "Проект не найден", "NOT_FOUND");

  // Canon §04: блокируем архивацию при открытых остатках.
  // Проверяем clientRemaining, teamRemaining и vendorRemaining (VENDOR добавлен
  // после написания канона; смысл тот же — не прятать открытые деньги).
  const debts = computeProjectDebts(projectWithRelations as unknown as ProjectWithRelations);
  const ZERO = new Decimal(0);
  const hasDebts =
    new Decimal(debts.clientRemaining).gt(ZERO) ||
    new Decimal(debts.teamRemaining).gt(ZERO) ||
    new Decimal(debts.vendorRemaining).gt(ZERO);

  if (hasDebts) {
    throw new HttpError(
      409,
      "Нельзя архивировать проект с открытыми остатками",
      "PROJECT_HAS_DEBTS",
    );
  }

  await prisma.gafferProject.updateMany({
    where: { id, gafferUserId },
    data: { status: "ARCHIVED" },
  });

  const project = await prisma.gafferProject.findFirst({ where: { id, gafferUserId } });
  if (!project) throw new HttpError(404, "Проект не найден", "NOT_FOUND");

  return { ...project, clientPlanAmount: project.clientPlanAmount.toString(), lightBudgetAmount: project.lightBudgetAmount.toString() };
}

/** Разархивировать проект. */
export async function unarchiveProject(req: Request, id: string) {
  const { gafferUserId } = gafferWhere(req);

  await prisma.gafferProject.updateMany({
    where: { id, gafferUserId },
    data: { status: "OPEN" },
  });

  const project = await prisma.gafferProject.findFirst({ where: { id, gafferUserId } });
  if (!project) throw new HttpError(404, "Проект не найден", "NOT_FOUND");

  return { ...project, clientPlanAmount: project.clientPlanAmount.toString(), lightBudgetAmount: project.lightBudgetAmount.toString() };
}

/** Удалить проект. Cascade удаляет участников и платежи. */
export async function deleteProject(req: Request, id: string) {
  const { gafferUserId } = gafferWhere(req);

  try {
    const result = await prisma.gafferProject.deleteMany({
      where: { id, gafferUserId },
    });

    if (result.count === 0) {
      throw new HttpError(404, "Проект не найден", "NOT_FOUND");
    }
  } catch (err: unknown) {
    if (err instanceof HttpError) throw err;
    const e = err as { code?: string };
    if (e?.code === "P2003") {
      throw new HttpError(409, "Проект не может быть удалён: есть связанные данные", "PROJECT_HAS_RELATIONS");
    }
    throw err;
  }
}
