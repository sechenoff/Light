/**
 * Сервис управления способами оплаты Gaffer CRM.
 */

import type { Request } from "express";
import { prisma } from "../../prisma";
import { HttpError } from "../../utils/errors";
import { gafferWhere } from "./tenant";

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

  try {
    return await prisma.$transaction(async (tx) => {
      if (data.isDefault === true) {
        await tx.gafferPaymentMethod.updateMany({
          where: { gafferUserId, isDefault: true, id: { not: id } },
          data: { isDefault: false },
        });
      }

      const result = await tx.gafferPaymentMethod.updateMany({
        where: { id, gafferUserId },
        data: {
          ...(data.name !== undefined && { name: data.name.trim() }),
          ...(data.isDefault !== undefined && { isDefault: data.isDefault }),
          ...(data.sortOrder !== undefined && { sortOrder: data.sortOrder }),
        },
      });

      if (result.count === 0) {
        throw new HttpError(404, "Способ оплаты не найден", "NOT_FOUND");
      }

      return tx.gafferPaymentMethod.findUnique({ where: { id } }) as Promise<NonNullable<Awaited<ReturnType<typeof tx.gafferPaymentMethod.findUnique>>>>;
    });
  } catch (err: unknown) {
    if (err instanceof HttpError) throw err;
    const e = err as { code?: string };
    if (e?.code === "P2002") {
      throw new HttpError(409, "Способ оплаты с таким именем уже существует", "PAYMENT_METHOD_NAME_TAKEN");
    }
    throw err;
  }
}

/** Удалить способ оплаты. GafferPayment.paymentMethodId — SetNull, удаление безопасно. */
export async function deletePaymentMethod(req: Request, id: string) {
  const { gafferUserId } = gafferWhere(req);

  const result = await prisma.gafferPaymentMethod.deleteMany({
    where: { id, gafferUserId },
  });

  if (result.count === 0) {
    throw new HttpError(404, "Способ оплаты не найден", "NOT_FOUND");
  }
}

/**
 * Переупорядочить способы оплаты по позиции в массиве ids.
 * Все ids должны принадлежать текущему tenant'у.
 */
export async function reorderPaymentMethods(req: Request, ids: string[]) {
  const { gafferUserId } = gafferWhere(req);

  await prisma.$transaction(async (tx) => {
    for (let index = 0; index < ids.length; index++) {
      const id = ids[index];
      const result = await tx.gafferPaymentMethod.updateMany({
        where: { id, gafferUserId },
        data: { sortOrder: index },
      });
      if (result.count !== 1) {
        throw new HttpError(400, "Один или несколько способов оплаты не найдены", "NOT_FOUND");
      }
    }
  });
}
