/**
 * Сервис управления контактами Gaffer CRM.
 */

import type { Request } from "express";
import type { GafferContactType } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "../../prisma";
import { HttpError } from "../../utils/errors";
import { gafferWhere, assertGafferTenant } from "./tenant";

export interface ListContactsOpts {
  type?: GafferContactType;
  isArchived?: boolean | "all";
  search?: string;
  withAggregates?: boolean;
}

export interface CreateContactInput {
  type: GafferContactType;
  name: string;
  phone?: string;
  telegram?: string;
  note?: string;
  shiftRate?: string | number;
  overtimeTier1Rate?: string | number;
  overtimeTier2Rate?: string | number;
  overtimeTier3Rate?: string | number;
  roleLabel?: string | null;
}

export interface UpdateContactInput {
  name?: string;
  phone?: string | null;
  telegram?: string | null;
  note?: string | null;
  shiftRate?: string | number;
  overtimeTier1Rate?: string | number;
  overtimeTier2Rate?: string | number;
  overtimeTier3Rate?: string | number;
  roleLabel?: string | null;
}

// MVP: search uses Prisma `contains` which compiles to SQLite LIKE — case-sensitive for
// Cyrillic. Acceptable for small tenants. Track: add nameLower denorm column if > 100 contacts/tenant.

/** Сериализует Decimal-поля контакта в строки для JSON-ответа. */
function serializeContact<T extends {
  shiftRate: Decimal;
  overtimeTier1Rate: Decimal;
  overtimeTier2Rate: Decimal;
  overtimeTier3Rate: Decimal;
}>(contact: T): Omit<T, "shiftRate" | "overtimeTier1Rate" | "overtimeTier2Rate" | "overtimeTier3Rate"> & {
  shiftRate: string;
  overtimeTier1Rate: string;
  overtimeTier2Rate: string;
  overtimeTier3Rate: string;
} {
  const { shiftRate, overtimeTier1Rate, overtimeTier2Rate, overtimeTier3Rate, ...rest } = contact;
  return {
    ...rest,
    shiftRate: shiftRate.toString(),
    overtimeTier1Rate: overtimeTier1Rate.toString(),
    overtimeTier2Rate: overtimeTier2Rate.toString(),
    overtimeTier3Rate: overtimeTier3Rate.toString(),
  };
}

/** Список контактов с опциональными фильтрами. */
export async function listContacts(req: Request, opts: ListContactsOpts) {
  const { gafferUserId } = gafferWhere(req);
  const where: Record<string, unknown> = { gafferUserId };

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

  const contacts = await prisma.gafferContact.findMany({
    where,
    orderBy: [{ isArchived: "asc" }, { name: "asc" }],
  });

  if (!opts.withAggregates) {
    return contacts.map(serializeContact);
  }

  // Attach aggregates: load all OPEN projects for this user once
  const ZERO = new Decimal(0);
  const openProjects = await prisma.gafferProject.findMany({
    where: { gafferUserId, status: "OPEN" },
    include: {
      members: { select: { contactId: true, plannedAmount: true } },
      payments: { select: { direction: true, amount: true, memberId: true } },
    },
  });

  // Build per-contact aggregates
  return contacts.map((c) => {
    const asClientProjects = openProjects.filter((p) => p.clientId === c.id);
    const asMemberProjects = openProjects.filter((p) =>
      p.members.some((m) => m.contactId === c.id),
    );

    // remainingToMe = sum of clientRemaining where contact is client
    let remainingToMe = ZERO;
    for (const p of asClientProjects) {
      const received = p.payments
        .filter((pay) => pay.direction === "IN")
        .reduce((acc, pay) => acc.plus(pay.amount), ZERO);
      const total = new Decimal(p.clientPlanAmount).plus(new Decimal(p.lightBudgetAmount));
      const raw = total.minus(received);
      remainingToMe = remainingToMe.plus(raw.gt(ZERO) ? raw : ZERO);
    }

    // remainingFromMe = sum of member remaining where contact is member
    let remainingFromMe = ZERO;
    for (const p of asMemberProjects) {
      const membership = p.members.find((m) => m.contactId === c.id);
      if (!membership) continue;
      const paid = p.payments
        .filter((pay) => pay.direction === "OUT" && pay.memberId === c.id)
        .reduce((acc, pay) => acc.plus(pay.amount), ZERO);
      const raw = new Decimal(membership.plannedAmount).minus(paid);
      remainingFromMe = remainingFromMe.plus(raw.gt(ZERO) ? raw : ZERO);
    }

    return {
      ...serializeContact(c),
      asClientCount: asClientProjects.length,
      asMemberCount: asMemberProjects.length,
      projectCount: asClientProjects.length + asMemberProjects.length,
      remainingToMe: remainingToMe.toString(),
      remainingFromMe: remainingFromMe.toString(),
    };
  });
}

/** Сводка контактов: totals + counts по категориям. */
export async function getContactsSummary(req: Request) {
  const { gafferUserId } = gafferWhere(req);
  const ZERO = new Decimal(0);

  const [allContacts, openProjects] = await Promise.all([
    prisma.gafferContact.findMany({
      where: { gafferUserId },
      select: { id: true, type: true, isArchived: true },
    }),
    prisma.gafferProject.findMany({
      where: { gafferUserId, status: "OPEN" },
      include: {
        members: { select: { contactId: true, plannedAmount: true } },
        payments: { select: { direction: true, amount: true, memberId: true } },
      },
    }),
  ]);

  let totalOwedToMe = ZERO;
  let totalIOwe = ZERO;

  // Per-contact debt computation for counting "withDebt"
  const contactDebtMap = new Map<string, { toMe: Decimal; fromMe: Decimal }>();

  for (const project of openProjects) {
    // Client debt
    const received = project.payments
      .filter((p) => p.direction === "IN")
      .reduce((acc, p) => acc.plus(p.amount), ZERO);
    const clientTotal = new Decimal(project.clientPlanAmount).plus(
      new Decimal(project.lightBudgetAmount),
    );
    const rawClientRem = clientTotal.minus(received);
    const clientRem = rawClientRem.gt(ZERO) ? rawClientRem : ZERO;

    if (clientRem.gt(ZERO)) {
      totalOwedToMe = totalOwedToMe.plus(clientRem);
      const ex = contactDebtMap.get(project.clientId);
      if (ex) {
        ex.toMe = ex.toMe.plus(clientRem);
      } else {
        contactDebtMap.set(project.clientId, { toMe: clientRem, fromMe: ZERO });
      }
    }

    // Member debts
    for (const member of project.members) {
      const paid = project.payments
        .filter((p) => p.direction === "OUT" && p.memberId === member.contactId)
        .reduce((acc, p) => acc.plus(p.amount), ZERO);
      const rawMem = new Decimal(member.plannedAmount).minus(paid);
      const memRem = rawMem.gt(ZERO) ? rawMem : ZERO;

      if (memRem.gt(ZERO)) {
        totalIOwe = totalIOwe.plus(memRem);
        const ex = contactDebtMap.get(member.contactId);
        if (ex) {
          ex.fromMe = ex.fromMe.plus(memRem);
        } else {
          contactDebtMap.set(member.contactId, { toMe: ZERO, fromMe: memRem });
        }
      }
    }
  }

  const nonArchived = allContacts.filter((c) => !c.isArchived);
  const archiveCount = allContacts.filter((c) => c.isArchived).length;
  const clientCount = nonArchived.filter((c) => c.type === "CLIENT").length;
  const teamCount = nonArchived.filter((c) => c.type === "TEAM_MEMBER").length;
  const withDebtCount = nonArchived.filter((c) => {
    const d = contactDebtMap.get(c.id);
    return d && (d.toMe.gt(ZERO) || d.fromMe.gt(ZERO));
  }).length;

  return {
    totals: {
      owedToMe: totalOwedToMe.toString(),
      iOwe: totalIOwe.toString(),
    },
    counts: {
      all: nonArchived.length,
      clients: clientCount,
      team: teamCount,
      withDebt: withDebtCount,
      archive: archiveCount,
    },
  };
}

/** Получить один контакт по id (с проверкой tenant). */
export async function getContact(req: Request, id: string) {
  const contact = await prisma.gafferContact.findUnique({ where: { id } });
  const verified = assertGafferTenant(contact, req);
  return serializeContact(verified);
}

/** Создать новый контакт. */
export async function createContact(req: Request, data: CreateContactInput) {
  const { gafferUserId } = gafferWhere(req);
  const contact = await prisma.gafferContact.create({
    data: {
      gafferUserId,
      type: data.type,
      name: data.name,
      phone: data.phone ?? null,
      telegram: data.telegram ?? null,
      note: data.note ?? null,
      shiftRate: data.shiftRate !== undefined ? new Decimal(data.shiftRate) : new Decimal(0),
      overtimeTier1Rate: data.overtimeTier1Rate !== undefined ? new Decimal(data.overtimeTier1Rate) : new Decimal(0),
      overtimeTier2Rate: data.overtimeTier2Rate !== undefined ? new Decimal(data.overtimeTier2Rate) : new Decimal(0),
      overtimeTier3Rate: data.overtimeTier3Rate !== undefined ? new Decimal(data.overtimeTier3Rate) : new Decimal(0),
      roleLabel: data.roleLabel ?? null,
    },
  });
  return serializeContact(contact);
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
      ...(data.shiftRate !== undefined && { shiftRate: new Decimal(data.shiftRate) }),
      ...(data.overtimeTier1Rate !== undefined && { overtimeTier1Rate: new Decimal(data.overtimeTier1Rate) }),
      ...(data.overtimeTier2Rate !== undefined && { overtimeTier2Rate: new Decimal(data.overtimeTier2Rate) }),
      ...(data.overtimeTier3Rate !== undefined && { overtimeTier3Rate: new Decimal(data.overtimeTier3Rate) }),
      ...(data.roleLabel !== undefined && { roleLabel: data.roleLabel }),
    },
  });

  if (result.count === 0) {
    throw new HttpError(404, "Контакт не найден", "NOT_FOUND");
  }

  const updated = await prisma.gafferContact.findUnique({ where: { id } });
  if (!updated) throw new HttpError(404, "Контакт не найден", "NOT_FOUND");
  return serializeContact(updated);
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

  const updated = await prisma.gafferContact.findUnique({ where: { id } });
  if (!updated) throw new HttpError(404, "Контакт не найден", "NOT_FOUND");
  return serializeContact(updated);
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

  const updated = await prisma.gafferContact.findUnique({ where: { id } });
  if (!updated) throw new HttpError(404, "Контакт не найден", "NOT_FOUND");
  return serializeContact(updated);
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

    // Последние 10 входящих платежей от этого клиента
    const inPayments = await prisma.gafferPayment.findMany({
      where: { direction: "IN", project: { clientId: id, gafferUserId } },
      include: { project: { select: { id: true, title: true } } },
      orderBy: { paidAt: "desc" },
      take: 10,
    });

    const recentPayments = inPayments.map((p) => ({
      id: p.id,
      direction: "IN" as const,
      amount: p.amount.toString(),
      paidAt: p.paidAt,
      projectId: p.project.id,
      projectTitle: p.project.title,
      comment: p.comment,
    }));

    return {
      type: "CLIENT" as const,
      contact,
      projects: projectSummaries,
      totalClientRemaining: totalClientRemaining.toString(),
      recentPayments,
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

    // Последние 10 выплат этому участнику
    const outPayments = await prisma.gafferPayment.findMany({
      where: { direction: "OUT", memberId: id, project: { gafferUserId } },
      include: { project: { select: { id: true, title: true } } },
      orderBy: { paidAt: "desc" },
      take: 10,
    });

    const recentPayments = outPayments.map((p) => ({
      id: p.id,
      direction: "OUT" as const,
      amount: p.amount.toString(),
      paidAt: p.paidAt,
      projectId: p.project.id,
      projectTitle: p.project.title,
      comment: p.comment,
    }));

    return {
      type: "TEAM_MEMBER" as const,
      contact,
      memberships: memberSummaries,
      totalRemaining: totalRemaining.toString(),
      recentPayments,
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
