import type { Request, Response, NextFunction } from "express";
import { LK_COOKIE_NAME, verifyLkSession } from "../services/clientPortal/session";
import { HttpError } from "../utils/errors";

export function lkAuth(req: Request, res: Response, next: NextFunction) {
  let token: string | undefined = req.cookies?.[LK_COOKIE_NAME];
  if (!token) {
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ")) token = auth.substring(7);
  }
  if (!token) return next(new HttpError(401, "Не авторизован", "UNAUTHENTICATED"));

  const payload = verifyLkSession(token);
  if (!payload) return next(new HttpError(401, "Не авторизован", "UNAUTHENTICATED"));

  req.clientPortal = payload;
  next();
}
