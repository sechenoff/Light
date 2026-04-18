/**
 * Сервис управления контактами Gaffer CRM.
 */

import type { Request } from "express";
import type { GafferContactType } from "@prisma/client";
import { prisma } from "../../prisma";
import { HttpError } from "../../utils/errors";
import { gafferWhere, assertGafferTenant } from "./tenant";

export interface ListContactsOpts {
  type?: GafferContactType;
  isArchived?: boolean | "all";
  search?: string;
}

export interface CreateContactInput {
  type: GafferContactType;
  name: string;
  phone?: string;
  telegram?: string;
  note?: string;
}

export interface UpdateContactInput {
  name?: string;
  phone?: string | null;
  telegram?: string | null;
  note?: string | null;
}

// MVP: search uses Prisma `contains` which compiles to SQLite LIKE — case-sensitive for
// Cyrillic. Acceptable for small tenants. Track: add nameLower denorm column if > 100 contacts/tenant.

/** Список контактов с опциональными фильтрами. */
export async function listContacts(req: Request, opts: ListContactsOpts) {
  const where: Record<string, unknown> = { ...gafferWhere(req) };

  if (opts.type !== undefined) {
    where.type = opts.type;
  }
  // Default: show only non-archived. Pass "all" to include both.
  if (opts.isArchived === "all") {
    // no filter
  } else if (opts.isArchived !== undefined) {
    where.isArchived = opts.isArchived;
  } else {
    where.isArchived = false;
  }
  if (opts.search) {
    where.name = { contains: opts.search };
  }

  return prisma.gafferContact.findMany({
    where,
    orderBy: [{ isArchived: "asc" }, { name: "asc" }],
  });
}

/** Получить один контакт по id (с проверкой tenant). */
export async function getContact(req: Request, id: string) {
  const contact = await prisma.gafferContact.findUnique({ where: { id } });
  return assertGafferTenant(contact, req);
}

/** Создать новый контакт. */
export async function createContact(req: Request, data: CreateContactInput) {
  const { gafferUserId } = gafferWhere(req);
  return prisma.gafferContact.create({
    data: {
      gafferUserId,
      type: data.type,
      name: data.name,
      phone: data.phone ?? null,
      telegram: data.telegram ?? null,
      note: data.note ?? null,
    },
  });
}

/** Частичное обновление контакта. */
export async function updateContact(req: Request, id: string, data: UpdateContactInput) {
  const { gafferUserId } = gafferWhere(req);

  const result = await prisma.gafferContact.updateMany({
    where: { id, gafferUserId },
    data: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.phone !== undefined && { phone: data.phone }),
      ...(data.telegram !== undefined && { telegram: data.telegram }),
      ...(data.note !== undefined && { note: data.note }),
    },
  });

  if (result.count === 0) {
    throw new HttpError(404, "Контакт не найден", "NOT_FOUND");
  }

  return prisma.gafferContact.findUnique({ where: { id } }) as Promise<NonNullable<Awaited<ReturnType<typeof prisma.gafferContact.findUnique>>>>;
}

/** Архивировать контакт. */
export async function archiveContact(req: Request, id: string) {
  const { gafferUserId } = gafferWhere(req);

  const result = await prisma.gafferContact.updateMany({
    where: { id, gafferUserId },
    data: { isArchived: true },
  });

  if (result.count === 0) {
    throw new HttpError(404, "Контакт не найден", "NOT_FOUND");
  }

  return prisma.gafferContact.findUnique({ where: { id } }) as Promise<NonNullable<Awaited<ReturnType<typeof prisma.gafferContact.findUnique>>>>;
}

/** Разархивировать контакт. */
export async function unarchiveContact(req: Request, id: string) {
  const { gafferUserId } = gafferWhere(req);

  const result = await prisma.gafferContact.updateMany({
    where: { id, gafferUserId },
    data: { isArchived: false },
  });

  if (result.count === 0) {
    throw new HttpError(404, "Контакт не найден", "NOT_FOUND");
  }

  return prisma.gafferContact.findUnique({ where: { id } }) as Promise<NonNullable<Awaited<ReturnType<typeof prisma.gafferContact.findUnique>>>>;
}

/** Сводка долга по контакту.
 * Для CLIENT — список проектов с clientRemaining + totalClientRemaining.
 * Для TEAM_MEMBER — список членств с paidToMe/remaining + totalRemaining.
 */
export async function getContactDebtSummary(req: Request, id: string) {
  const { gafferUserId } = gafferWhere(req);

  const contact = await prisma.gafferContact.findFirst({
    where: { id, gafferUserId },
  });

  if (!contact) {
    throw new HttpError(404, "Контакт не найден", "NOT_FOUND");
  }

  const { Decimal } = await import("@prisma/client/runtime/library");
  const ZERO = new Decimal(0);

  if (contact.type === "CLIENT") {
    // Загружаем все проекты клиента с платежами и участниками
    const projects = await prisma.gafferProject.findMany({
      where: { clientId: id, gafferUserId },
      include: {
        members: { select: { plannedAmount: true } },
        payments: { select: { direction: true, amount: true, memberId: true } },
      },
      orderBy: { shootDate: "desc" },
    });

    let totalClientRemaining = ZERO;

    const projectSummaries = projects.map((p) => {
      const clientReceived = p.payments
        .filter((pay) => pay.direction === "IN")
        .reduce((acc, pay) => acc.plus(pay.amount), ZERO);

      const clientTotal = new Decimal(p.clientPlanAmount).plus(new Decimal(p.lightBudgetAmount));
      const raw = clientTotal.minus(clientReceived);
      const clientRemaining = raw.gt(ZERO) ? raw : ZERO;
      totalClientRemaining = totalClientRemaining.plus(clientRemaining);

      return {
        id: p.id,
        title: p.title,
        shootDate: p.shootDate,
        status: p.status,
        clientPlanAmount: p.clientPlanAmount.toString(),
        lightBudgetAmount: p.lightBudgetAmount.toString(),
        clientTotal: clientTotal.toString(),
        clientReceived: clientReceived.toString(),
        clientRemaining: clientRemaining.toString(),
      };
    });

    return {
      contact,
      projects: projectSummaries,
      totalClientRemaining: totalClientRemaining.toString(),
    };
  } else {
    // TEAM_MEMBER — загружаем членства
    const memberships = await prisma.gafferProjectMember.findMany({
      where: { contactId: id, project: { gafferUserId } },
      include: {
        project: true,
      },
    });

    let totalRemaining = ZERO;

    const memberSummaries = await Promise.all(
      memberships.map(async (m) => {
        // OUT-платежи для этого участника в этом проекте
        const payments = await prisma.gafferPayment.findMany({
          where: { projectId: m.projectId, memberId: m.contactId, direction: "OUT" },
          select: { amount: true },
        });

        const paidToMe = payments.reduce((acc, p) => acc.plus(p.amount), ZERO);
        const raw = new Decimal(m.plannedAmount).minus(paidToMe);
        const remaining = raw.gt(ZERO) ? raw : ZERO;
        totalRemaining = totalRemaining.plus(remaining);

        return {
          memberId: m.id,
          projectId: m.projectId,
          projectTitle: m.project.title,
          shootDate: m.project.shootDate,
          status: m.project.status,
          roleLabel: m.roleLabel,
          plannedAmount: m.plannedAmount.toString(),
          paidToMe: paidToMe.toString(),
          remaining: remaining.toString(),
        };
      }),
    );

    return {
      contact,
      memberships: memberSummaries,
      totalRemaining: totalRemaining.toString(),
    };
  }
}

/** Удалить контакт. Если есть связанные проекты или членства — 409. */
export async function deleteContact(req: Request, id: string) {
  const { gafferUserId } = gafferWhere(req);

  try {
    const result = await prisma.gafferContact.deleteMany({
      where: { id, gafferUserId },
    });

    if (result.count === 0) {
      throw new HttpError(404, "Контакт не найден", "NOT_FOUND");
    }
  } catch (err: unknown) {
    if (err instanceof HttpError) throw err;
    const e = err as { code?: string };
    if (e?.code === "P2003") {
      throw new HttpError(409, "Контакт используется в проектах и не может быть удалён", "CONTACT_HAS_RELATIONS");
    }
    throw err;
  }
}
