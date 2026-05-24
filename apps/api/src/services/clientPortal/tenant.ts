import type { Request } from "express";
import { HttpError } from "../../utils/errors";

declare global {
  namespace Express {
    interface Request {
      clientPortal?: { accountId: string; clientId: string; email: string };
    }
  }
}

export function lkClientId(req: Request): string {
  const cp = req.clientPortal;
  if (!cp?.clientId) throw new HttpError(401, "Не авторизован", "UNAUTHENTICATED");
  return cp.clientId;
}

export function assertLkClientOwns<T extends { clientId: string } | null>(entity: T, req: Request): NonNullable<T> {
  if (!entity) throw new HttpError(404, "Не найдено", "NOT_FOUND");
  if (entity.clientId !== lkClientId(req)) throw new HttpError(404, "Не найдено", "NOT_FOUND");
  return entity as NonNullable<T>;
}
