import express from "express";
import { z } from "zod";

import { authenticate, signSession, SESSION_COOKIE_NAME, sessionCookieOptions } from "../services/auth";
import { requireAdmin } from "../middleware/sessionAuth";

const router = express.Router();

const loginSchema = z.object({
  username: z.string().min(1, "Логин обязателен").max(100),
  password: z.string().min(1, "Пароль обязателен").max(200),
});

/**
 * POST /api/auth/login
 * Публичный маршрут (монтируется до apiKeyAuth).
 */
router.post("/login", async (req, res, next) => {
  try {
    const body = loginSchema.parse(req.body);
    const session = await authenticate(body.username, body.password);
    if (!session) {
      return res.status(401).json({ message: "Неверный логин или пароль" });
    }
    const token = signSession(session);
    res.cookie(SESSION_COOKIE_NAME, token, sessionCookieOptions());
    res.json({ user: session, token });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/logout
 * Очищает cookie.
 */
router.post("/logout", (_req, res) => {
  res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
  res.json({ ok: true });
});

/**
 * GET /api/auth/me
 * Возвращает текущего пользователя по cookie/bearer-токену.
 */
router.get("/me", requireAdmin, (req, res) => {
  res.json({ user: req.adminUser });
});

export { router as authRouter };
