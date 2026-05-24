import type { Request, Response, NextFunction } from "express";
import { LK_COOKIE_NAME, verifyLkSession } from "../services/clientPortal/session";
import { HttpError } from "../utils/errors";
import { prisma } from "../prisma";

export async function lkAuth(req: Request, res: Response, next: NextFunction) {
  try {
    let token: string | undefined = req.cookies?.[LK_COOKIE_NAME];
    if (!token) {
      const auth = req.headers.authorization;
      if (auth?.startsWith("Bearer ")) token = auth.substring(7);
    }
    if (!token) throw new HttpError(401, "Не авторизован", "UNAUTHENTICATED");

    const payload = verifyLkSession(token);
    if (!payload) throw new HttpError(401, "Не авторизован", "UNAUTHENTICATED");

    // Enforce account status on every request — disable propagates immediately.
    const account = await prisma.clientPortalAccount.findUnique({
      where: { id: payload.accountId },
      select: { status: true },
    });
    if (!account || account.status === "DISABLED") {
      throw new HttpError(401, "Не авторизован", "UNAUTHENTICATED");
    }

    req.clientPortal = payload;
    next();
  } catch (err) {
    next(err);
  }
}
