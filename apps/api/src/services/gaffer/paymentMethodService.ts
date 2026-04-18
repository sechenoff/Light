/**
 * Сервис управления способами оплаты Gaffer CRM.
 */

import type { Request } from "express";
import { prisma } from "../../prisma";
import { HttpError } from "../../utils/errors";
import { gafferWhere, assertGafferTenant } from "./tenant";

export interface CreatePaymentMethodInput {
  name: string;
  isDefault?: boolean;
}

export interface UpdatePaymentMethodInput {
  name?: string;
  isDefault?: boolean;
  sortOrder?: number;
}

/** Список способов оплаты: default сначала, затем по sortOrder, затем по имени. */
export async function listPaymentMethods(req: Request) {
  return prisma.gafferPaymentMethod.findMany({
    where: gafferWhere(req),
    orderBy: [{ isDefault: "desc" }, { sortOrder: "asc" }, { name: "asc" }],
  });
}

/** Создать способ оплаты. Если isDefault=true — сбрасывает isDefault у остальных. */
export async function createPaymentMethod(req: Request, data: CreatePaymentMethodInput) {
  const { gafferUserId } = gafferWhere(req);
  const name = data.name.trim();
  const isDefault = data.isDefault ?? false;

  try {
    return await prisma.$transaction(async (tx) => {
      if (isDefault) {
        await tx.gafferPaymentMethod.updateMany({
          where: { gafferUserId, isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.gafferPaymentMethod.create({
        data: { gafferUserId, name, isDefault },
      });
    });
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e?.code === "P2002") {
      throw new HttpError(409, "Способ оплаты с таким именем уже существует", "PAYMENT_METHOD_NAME_TAKEN");
    }
    throw err;
  }
}

/** Обновить способ оплаты. Если isDefault=true — сбрасывает isDefault у остальных. */
export async function updatePaymentMethod(
  req: Request,
  id: string,
  data: UpdatePaymentMethodInput,
) {
  const { gafferUserId } = gafferWhere(req);
  const existing = await prisma.gafferPaymentMethod.findUnique({ where: { id } });
  assertGafferTenant(existing, req);

  try {
    return await prisma.$transaction(async (tx) => {
      if (data.isDefault === true) {
        await tx.gafferPaymentMethod.updateMany({
          where: { gafferUserId, isDefault: true, id: { not: id } },
          data: { isDefault: false },
        });
      }
      return tx.gafferPaymentMethod.update({
        where: { id },
        data: {
          ...(data.name !== undefined && { name: data.name.trim() }),
          ...(data.isDefault !== undefined && { isDefault: data.isDefault }),
          ...(data.sortOrder !== undefined && { sortOrder: data.sortOrder }),
        },
      });
    });
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e?.code === "P2002") {
      throw new HttpError(409, "Способ оплаты с таким именем уже существует", "PAYMENT_METHOD_NAME_TAKEN");
    }
    throw err;
  }
}

/** Удалить способ оплаты. GafferPayment.paymentMethodId — SetNull, удаление безопасно. */
export async function deletePaymentMethod(req: Request, id: string) {
  const existing = await prisma.gafferPaymentMethod.findUnique({ where: { id } });
  assertGafferTenant(existing, req);

  await prisma.gafferPaymentMethod.delete({ where: { id } });
}

/**
 * Переупорядочить способы оплаты по позиции в массиве ids.
 * Все ids должны принадлежать текущему tenant'у.
 */
export async function reorderPaymentMethods(req: Request, ids: string[]) {
  const { gafferUserId } = gafferWhere(req);

  // Проверяем, что все ids принадлежат tenant'у
  const methods = await prisma.gafferPaymentMethod.findMany({
    where: { id: { in: ids }, gafferUserId },
    select: { id: true },
  });

  if (methods.length !== ids.length) {
    throw new HttpError(400, "Один или несколько способов оплаты не найдены", "NOT_FOUND");
  }

  await prisma.$transaction(
    ids.map((id, index) =>
      prisma.gafferPaymentMethod.update({
        where: { id },
        data: { sortOrder: index },
      }),
    ),
  );
}
