import type { Request, Response, NextFunction } from "express";
import { verifyGafferSession, GAFFER_COOKIE_NAME } from "../services/gaffer/session";
import { prisma } from "../prisma";

/**
 * Middleware: проверяет JWT из cookie `gaffer_session` или заголовка Authorization: Bearer.
 * При успехе кладёт GafferUser в req.gafferUser.
 * При отсутствии/невалидном токене → 401 GAFFER_UNAUTHENTICATED.
 */
export async function gafferAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const cookieToken = (req as Request & { cookies?: Record<string, string> }).cookies?.[GAFFER_COOKIE_NAME];
  const header = req.headers["authorization"];
  const bearerToken = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  const token = cookieToken ?? bearerToken;

  if (!token) {
    res.status(401).json({ code: "GAFFER_UNAUTHENTICATED", message: "Требуется авторизация Gaffer CRM" });
    return;
  }

  const payload = verifyGafferSession(token);
  if (!payload) {
    res.status(401).json({ code: "GAFFER_UNAUTHENTICATED", message: "Недействительный токен Gaffer CRM" });
    return;
  }

  const user = await prisma.gafferUser.findUnique({
    where: { id: payload.gafferUserId },
    select: { id: true, email: true, name: true, onboardingCompletedAt: true },
  });

  if (!user) {
    res.status(401).json({ code: "GAFFER_UNAUTHENTICATED", message: "Пользователь Gaffer CRM не найден" });
    return;
  }

  req.gafferUser = user;
  next();
}
