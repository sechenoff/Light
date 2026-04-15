import type { UserRole } from "@prisma/client";
import type { RequestHandler } from "express";
import { HttpError } from "../utils/errors";

/**
 * Middleware-factory для проверки роли пользователя.
 *
 * Логика:
 * 1. Если `req.botAccess === true` — запрос уже прошёл botScopeGuard (openclaw-ключ),
 *    роль не проверяем, пропускаем.
 * 2. Если `req.adminUser` отсутствует — нет активной сессии → 401 UNAUTHENTICATED
 *    (строго по design §2.1; любой валидный API-ключ без JWT не должен проходить guard).
 * 3. Если сессия есть, но роль не входит в `allowed` — 403 FORBIDDEN_BY_ROLE.
 */
export function rolesGuard(allowed: UserRole[]): RequestHandler {
  return (req, _res, next) => {
    // Бот-ключ openclaw-* уже проверен botScopeGuard — пропускаем без проверки роли
    if (req.botAccess === true) {
      return next();
    }

    // Нет сессии → 401 UNAUTHENTICATED (строго по design §2.1)
    if (!req.adminUser) {
      return next(new HttpError(401, "Требуется авторизация", "UNAUTHENTICATED"));
    }

    if (!allowed.includes(req.adminUser.role as UserRole)) {
      return next(new HttpError(403, "Доступ запрещён по роли", "FORBIDDEN_BY_ROLE"));
    }

    next();
  };
}
