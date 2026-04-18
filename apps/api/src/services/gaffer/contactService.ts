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
