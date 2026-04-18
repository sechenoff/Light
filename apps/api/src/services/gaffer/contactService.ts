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
  isArchived?: boolean;
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
  type?: GafferContactType;
  name?: string;
  phone?: string | null;
  telegram?: string | null;
  note?: string | null;
}

/** Список контактов с опциональными фильтрами. */
export async function listContacts(req: Request, opts: ListContactsOpts) {
  const where: Record<string, unknown> = { ...gafferWhere(req) };

  if (opts.type !== undefined) {
    where.type = opts.type;
  }
  if (opts.isArchived !== undefined) {
    where.isArchived = opts.isArchived;
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
  const contact = await prisma.gafferContact.findUnique({ where: { id } });
  assertGafferTenant(contact, req);

  return prisma.gafferContact.update({
    where: { id },
    data: {
      ...(data.type !== undefined && { type: data.type }),
      ...(data.name !== undefined && { name: data.name }),
      ...(data.phone !== undefined && { phone: data.phone }),
      ...(data.telegram !== undefined && { telegram: data.telegram }),
      ...(data.note !== undefined && { note: data.note }),
    },
  });
}

/** Архивировать контакт. */
export async function archiveContact(req: Request, id: string) {
  const contact = await prisma.gafferContact.findUnique({ where: { id } });
  assertGafferTenant(contact, req);

  return prisma.gafferContact.update({
    where: { id },
    data: { isArchived: true },
  });
}

/** Разархивировать контакт. */
export async function unarchiveContact(req: Request, id: string) {
  const contact = await prisma.gafferContact.findUnique({ where: { id } });
  assertGafferTenant(contact, req);

  return prisma.gafferContact.update({
    where: { id },
    data: { isArchived: false },
  });
}

/** Удалить контакт. Если есть связанные проекты или членства — 409. */
export async function deleteContact(req: Request, id: string) {
  const contact = await prisma.gafferContact.findUnique({ where: { id } });
  assertGafferTenant(contact, req);

  try {
    await prisma.gafferContact.delete({ where: { id } });
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e?.code === "P2003") {
      throw new HttpError(409, "Контакт используется в проектах и не может быть удалён", "CONTACT_HAS_RELATIONS");
    }
    throw err;
  }
}
