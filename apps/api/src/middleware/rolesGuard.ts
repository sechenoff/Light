import type { UserRole } from "@prisma/client";
import type { RequestHandler } from "express";
import { HttpError } from "../utils/errors";

/**
 * Middleware-factory для проверки роли пользователя.
 *
 * Логика:
 * 1. Если `req.botAccess === true` — запрос уже прошёл botScopeGuard (openclaw-ключ),
 *    роль не проверяем, пропускаем.
 * 2. Если `req.adminUser` отсутствует — нет активной сессии, пропускаем (API-ключевые запросы
 *    без сессии сохраняют обратную совместимость; полное принуждение — через requireAdmin).
 * 3. Если сессия есть, но роль не входит в `allowed` — 403 FORBIDDEN_BY_ROLE.
 */
export function rolesGuard(allowed: UserRole[]): RequestHandler {
  return (req, _res, next) => {
    // Бот-ключ openclaw-* уже проверен botScopeGuard — пропускаем без проверки роли
    if (req.botAccess === true) {
      return next();
    }

    const user = req.adminUser;
    // Нет сессии — пропускаем (API-key-only запросы, backward compat)
    if (!user) {
      return next();
    }

    if (!allowed.includes(user.role as UserRole)) {
      return next(new HttpError(403, "Доступ запрещён по роли", "FORBIDDEN_BY_ROLE"));
    }

    next();
  };
}
