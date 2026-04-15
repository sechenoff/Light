import type { Request, Response, NextFunction } from "express";

import { verifySession, SESSION_COOKIE_NAME, type SessionPayload, type AdminRole } from "../services/auth";

/**
 * Извлекает JWT из cookie `lr_session` или из заголовка Authorization: Bearer <token>.
 * Если токен валиден — кладёт пользователя в req.adminUser. Не блокирует запрос при отсутствии токена.
 */
export function sessionParser(req: Request, _res: Response, next: NextFunction) {
  const cookieToken = (req as Request & { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE_NAME];
  const header = req.header("authorization");
  const bearerToken = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  const token = cookieToken ?? bearerToken;
  if (token) {
    const session = verifySession(token);
    if (session) {
      req.adminUser = session;
    }
  }
  next();
}

/** Требует авторизованного администратора. */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.adminUser) {
    return res.status(401).json({ message: "Требуется авторизация" });
  }
  next();
}

/** Требует конкретную роль (legacy, используйте rolesGuard для новых роутов). */
export function requireRole(...roles: AdminRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.adminUser) {
      return res.status(401).json({ message: "Требуется авторизация" });
    }
    if (!roles.includes(req.adminUser.role as AdminRole)) {
      return res.status(403).json({ message: "Недостаточно прав" });
    }
    next();
  };
}
