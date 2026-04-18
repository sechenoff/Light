/**
 * Tenant-helper для Gaffer CRM.
 * Все операции Gaffer CRM изолированы по gafferUserId — это гарантируется здесь.
 */

import type { Request } from "express";
import { HttpError } from "../../utils/errors";

/**
 * Возвращает Prisma where-фрагмент { gafferUserId: string }.
 * Бросает 401, если req.gafferUser отсутствует (defense-in-depth — gafferAuth уже должен был отловить).
 */
export function gafferWhere(req: Request): { gafferUserId: string } {
  if (!req.gafferUser) {
    throw new HttpError(401, "Требуется авторизация Gaffer CRM");
  }
  return { gafferUserId: req.gafferUser.id };
}

/**
 * Проверяет, что entity принадлежит текущему tenant'у.
 * Бросает 404 NOT_FOUND если entity null или принадлежит другому пользователю.
 */
export function assertGafferTenant<T extends { gafferUserId: string }>(
  entity: T | null,
  req: Request,
): T {
  if (!req.gafferUser) {
    throw new HttpError(401, "Требуется авторизация Gaffer CRM");
  }
  if (!entity || entity.gafferUserId !== req.gafferUser.id) {
    throw new HttpError(404, "Запись не найдена");
  }
  return entity;
}
