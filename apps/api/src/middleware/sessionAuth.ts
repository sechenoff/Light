import type { Request, Response, NextFunction } from "express";

import { prisma } from "../prisma";
import { verifySession, SESSION_COOKIE_NAME, type SessionPayload, type AdminRole } from "../services/auth";

/**
 * Актуальное состояние пользователя, перечитанное из базы.
 *
 * Зачем вообще ходить в базу, если всё уже есть в токене. Токен живёт 7 дней и
 * не меняется, поэтому без этой проверки:
 *  · деактивация не выкидывала человека — он спокойно дорабатывал неделю;
 *  · понижение роли не действовало — токен продолжал утверждать, что он
 *    руководитель, и пускал в финансы.
 * И то и другое — ровно те случаи, ради которых доступ и отбирают.
 *
 * Ходить в базу на КАЖДЫЙ запрос было бы расточительно, поэтому состояние
 * кэшируется на 30 секунд, а на изменении пользователя кэш сбрасывается явно
 * (`invalidateAdminUserState`). То есть в норме эффект мгновенный, а 30 секунд —
 * это худший случай, когда пользователя поменяли в обход нашего API.
 */
const USER_STATE_TTL_MS = 30_000;

type CachedState = { isActive: boolean; role: AdminRole } | null;
const userStateCache = new Map<string, { readAt: number; state: CachedState }>();

/** Сбросить кэш после смены роли, деактивации или удаления пользователя. */
export function invalidateAdminUserState(userId?: string): void {
  if (userId) userStateCache.delete(userId);
  else userStateCache.clear();
}

async function readUserState(userId: string): Promise<CachedState> {
  const cached = userStateCache.get(userId);
  if (cached && Date.now() - cached.readAt < USER_STATE_TTL_MS) return cached.state;

  let state: CachedState = null;
  try {
    const row = await prisma.adminUser.findUnique({
      where: { id: userId },
      select: { isActive: true, role: true },
    });
    state = row ? { isActive: row.isActive, role: row.role as AdminRole } : null;
  } catch {
    // База недоступна — не роняем запрос и не выдаём доступ авансом:
    // возвращаем прошлое известное состояние, а если его нет, считаем отказом.
    return cached?.state ?? null;
  }
  userStateCache.set(userId, { readAt: Date.now(), state });
  return state;
}

/**
 * Извлекает JWT из cookie `lr_session` или из заголовка Authorization: Bearer <token>.
 * Если токен валиден И пользователь всё ещё активен — кладёт его в req.adminUser,
 * подставляя АКТУАЛЬНУЮ роль из базы, а не ту, что вморожена в токен.
 * Отсутствие токена запрос не блокирует — это делают requireAdmin/rolesGuard.
 */
export async function sessionParser(req: Request, _res: Response, next: NextFunction) {
  const cookieToken = (req as Request & { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE_NAME];
  const header = req.header("authorization");
  const bearerToken = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  const token = cookieToken ?? bearerToken;
  if (!token) return next();

  const session = verifySession(token);
  if (!session) return next();

  const state = await readUserState(session.userId);
  // Пользователя удалили или отключили — токен больше не значит ничего.
  if (!state || !state.isActive) return next();

  req.adminUser = { ...session, role: state.role } as SessionPayload;
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
