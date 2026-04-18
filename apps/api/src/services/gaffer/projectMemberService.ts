/**
 * Сервис управления участниками проектов Gaffer CRM.
 */

import type { Request } from "express";
import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "../../prisma";
import { HttpError } from "../../utils/errors";
import { gafferWhere } from "./tenant";

export interface AddMemberInput {
  contactId: string;
  plannedAmount?: string | number;
  roleLabel?: string;
}

export interface UpdateMemberInput {
  plannedAmount?: string | number;
  roleLabel?: string | null;
}

/**
 * Добавить участника в проект.
 * Контакт должен принадлежать тенанту, быть типом TEAM_MEMBER и не быть архивирован.
 */
export async function addMember(req: Request, projectId: string, data: AddMemberInput) {
  const { gafferUserId } = gafferWhere(req);

  // Проверяем, что проект принадлежит тенанту
  const project = await prisma.gafferProject.findFirst({
    where: { id: projectId, gafferUserId },
  });
  if (!project) {
    throw new HttpError(404, "Проект не найден", "NOT_FOUND");
  }

  // Проверяем контакт
  const contact = await prisma.gafferContact.findFirst({
    where: { id: data.contactId, gafferUserId },
  });
  if (!contact) {
    throw new HttpError(404, "Контакт не найден", "NOT_FOUND");
  }
  if (contact.type !== "TEAM_MEMBER") {
    throw new HttpError(400, "Контакт должен быть типа TEAM_MEMBER", "INVALID_MEMBER_TYPE");
  }
  if (contact.isArchived) {
    throw new HttpError(400, "Нельзя добавить архивный контакт в проект", "MEMBER_ARCHIVED");
  }

  try {
    const member = await prisma.gafferProjectMember.create({
      data: {
        projectId,
        contactId: data.contactId,
        plannedAmount: data.plannedAmount !== undefined
          ? new Decimal(data.plannedAmount)
          : new Decimal(0),
        roleLabel: data.roleLabel?.trim() ?? null,
      },
      include: { contact: true },
    });

    return {
      ...member,
      plannedAmount: member.plannedAmount.toString(),
    };
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e?.code === "P2002") {
      throw new HttpError(409, "Участник уже добавлен в проект", "MEMBER_ALREADY_IN_PROJECT");
    }
    throw err;
  }
}

/**
 * Обновить участника (plannedAmount, roleLabel).
 * Tenant-проверка через nested join: member.project.gafferUserId.
 */
export async function updateMember(req: Request, memberId: string, data: UpdateMemberInput) {
  const { gafferUserId } = gafferWhere(req);

  // Ищем участника и проверяем принадлежность проекта тенанту
  const member = await prisma.gafferProjectMember.findFirst({
    where: {
      id: memberId,
      project: { gafferUserId },
    },
  });

  if (!member) {
    throw new HttpError(404, "Участник не найден", "NOT_FOUND");
  }

  const updateData: Record<string, unknown> = {};
  if (data.plannedAmount !== undefined) {
    updateData.plannedAmount = new Decimal(data.plannedAmount);
  }
  if (data.roleLabel !== undefined) {
    updateData.roleLabel = data.roleLabel?.trim() ?? null;
  }

  const updated = await prisma.gafferProjectMember.update({
    where: { id: memberId },
    data: updateData,
    include: { contact: true },
  });

  return {
    ...updated,
    plannedAmount: updated.plannedAmount.toString(),
  };
}

/**
 * Удалить участника из проекта.
 * Если у участника есть платежи (OUT) — отклоняем с 409.
 */
export async function removeMember(req: Request, memberId: string) {
  const { gafferUserId } = gafferWhere(req);

  // Ищем участника с проверкой tenant
  const member = await prisma.gafferProjectMember.findFirst({
    where: {
      id: memberId,
      project: { gafferUserId },
    },
  });

  if (!member) {
    throw new HttpError(404, "Участник не найден", "NOT_FOUND");
  }

  // Проверяем наличие платежей
  const paymentCount = await prisma.gafferPayment.count({
    where: {
      projectId: member.projectId,
      memberId: member.contactId,
      direction: "OUT",
    },
  });

  if (paymentCount > 0) {
    throw new HttpError(
      409,
      "Участник имеет связанные платежи и не может быть удалён",
      "MEMBER_HAS_PAYMENTS",
    );
  }

  await prisma.gafferProjectMember.delete({ where: { id: memberId } });
}
