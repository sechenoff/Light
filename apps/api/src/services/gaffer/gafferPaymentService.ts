/**
 * Сервис управления платежами Gaffer CRM.
 */

import type { Request } from "express";
import type { GafferPaymentDirection } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "../../prisma";
import { HttpError } from "../../utils/errors";
import { gafferWhere } from "./tenant";
import { fromMoscowDateString } from "../../utils/moscowDate";

// ─── Типы ─────────────────────────────────────────────────────────────────────

export interface ListPaymentsOpts {
  projectId?: string;
  memberContactId?: string;
  from?: string;
  to?: string;
}

export interface CreatePaymentInput {
  projectId: string;
  direction: GafferPaymentDirection;
  amount: string | number;
  paidAt: string;
  paymentMethodId?: string;
  memberId?: string;
  comment?: string;
}

export interface UpdatePaymentInput {
  amount?: string | number;
  paidAt?: string;
  paymentMethodId?: string | null;
  comment?: string | null;
}

// ─── Вспомогательные ─────────────────────────────────────────────────────────

/** Нормализует paidAt: принимает YYYY-MM-DD или ISO, возвращает Moscow-midnight UTC. */
function parsePaidAt(value: string): Date {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : value.slice(0, 10);
  return fromMoscowDateString(dateOnly);
}

function serializePayment(p: {
  amount: Decimal;
  [key: string]: unknown;
}) {
  return { ...p, amount: p.amount.toString() };
}

// ─── Публичные функции ────────────────────────────────────────────────────────

/** Список платежей с фильтрами. */
export async function listPayments(req: Request, opts: ListPaymentsOpts) {
  const { gafferUserId } = gafferWhere(req);

  const where: Record<string, unknown> = {
    project: { gafferUserId },
  };

  if (opts.projectId) {
    // Убедимся, что проект принадлежит тенанту
    where.projectId = opts.projectId;
  }

  if (opts.memberContactId) {
    where.memberId = opts.memberContactId;
  }

  if (opts.from || opts.to) {
    const dateFilter: Record<string, Date> = {};
    if (opts.from) dateFilter.gte = parsePaidAt(opts.from);
    if (opts.to) dateFilter.lte = parsePaidAt(opts.to);
    where.paidAt = dateFilter;
  }

  const payments = await prisma.gafferPayment.findMany({
    where,
    include: {
      project: true,
      method: true,
      member: true,
    },
    orderBy: [{ paidAt: "desc" }, { createdAt: "desc" }],
  });

  return payments.map(serializePayment);
}

/** Создать платёж. */
export async function createPayment(req: Request, data: CreatePaymentInput) {
  const { gafferUserId } = gafferWhere(req);

  // Проверяем проект
  const project = await prisma.gafferProject.findFirst({
    where: { id: data.projectId, gafferUserId },
  });
  if (!project) {
    throw new HttpError(404, "Проект не найден", "NOT_FOUND");
  }
  if (project.status === "ARCHIVED") {
    throw new HttpError(400, "Нельзя добавить платёж в архивный проект", "PROJECT_ARCHIVED");
  }

  // Валидация суммы
  const amount = new Decimal(data.amount);
  if (!amount.gt(new Decimal(0))) {
    throw new HttpError(400, "Сумма должна быть больше нуля", "INVALID_AMOUNT");
  }

  // Направление OUT — memberId обязателен
  if (data.direction === "OUT") {
    if (!data.memberId) {
      throw new HttpError(
        400,
        "Для платежа OUT необходимо указать memberId",
        "MEMBER_REQUIRED_FOR_OUT",
      );
    }

    // Проверяем, что memberId — активный участник проекта
    const membership = await prisma.gafferProjectMember.findFirst({
      where: { projectId: data.projectId, contactId: data.memberId },
    });
    if (!membership) {
      throw new HttpError(
        400,
        "Указанный контакт не является участником этого проекта",
        "MEMBER_NOT_IN_PROJECT",
      );
    }
  }

  // Направление IN — memberId должен отсутствовать
  if (data.direction === "IN" && data.memberId) {
    throw new HttpError(
      400,
      "Для платежа IN нельзя указывать memberId",
      "MEMBER_NOT_APPLICABLE_TO_IN",
    );
  }

  // Проверяем paymentMethodId
  if (data.paymentMethodId) {
    const method = await prisma.gafferPaymentMethod.findFirst({
      where: { id: data.paymentMethodId, gafferUserId },
    });
    if (!method) {
      throw new HttpError(404, "Способ оплаты не найден", "NOT_FOUND");
    }
  }

  const payment = await prisma.gafferPayment.create({
    data: {
      projectId: data.projectId,
      direction: data.direction,
      amount,
      paidAt: parsePaidAt(data.paidAt),
      paymentMethodId: data.paymentMethodId ?? null,
      memberId: data.memberId ?? null,
      comment: data.comment?.trim() ?? null,
    },
    include: {
      project: true,
      method: true,
      member: true,
    },
  });

  return serializePayment(payment);
}

/** Обновить платёж (amount, paidAt, paymentMethodId, comment). */
export async function updatePayment(req: Request, id: string, data: UpdatePaymentInput) {
  const { gafferUserId } = gafferWhere(req);

  // Tenant-проверка через nested project
  const payment = await prisma.gafferPayment.findFirst({
    where: { id, project: { gafferUserId } },
  });
  if (!payment) {
    throw new HttpError(404, "Платёж не найден", "NOT_FOUND");
  }

  const updateData: Record<string, unknown> = {};
  if (data.amount !== undefined) {
    const amount = new Decimal(data.amount);
    if (!amount.gt(new Decimal(0))) {
      throw new HttpError(400, "Сумма должна быть больше нуля", "INVALID_AMOUNT");
    }
    updateData.amount = amount;
  }
  if (data.paidAt !== undefined) updateData.paidAt = parsePaidAt(data.paidAt);
  if (data.paymentMethodId !== undefined) updateData.paymentMethodId = data.paymentMethodId;
  if (data.comment !== undefined) updateData.comment = data.comment?.trim() ?? null;

  const updated = await prisma.gafferPayment.update({
    where: { id },
    data: updateData,
    include: { project: true, method: true, member: true },
  });

  return serializePayment(updated);
}

/** Удалить платёж. */
export async function deletePayment(req: Request, id: string) {
  const { gafferUserId } = gafferWhere(req);

  // Tenant-проверка: удаляем только если проект принадлежит тенанту
  const result = await prisma.gafferPayment.deleteMany({
    where: { id, project: { gafferUserId } },
  });

  if (result.count === 0) {
    throw new HttpError(404, "Платёж не найден", "NOT_FOUND");
  }
}
