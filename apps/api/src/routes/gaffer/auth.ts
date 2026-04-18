import express from "express";
import { z } from "zod";
import { prisma } from "../../prisma";
import { signGafferSession, GAFFER_COOKIE_NAME, gafferCookieOptions } from "../../services/gaffer/session";
import { gafferAuth } from "../../middleware/gafferAuth";

const router = express.Router();

const loginSchema = z.object({
  // TODO(sprint-5): replace with password/OAuth — this is passwordless dev-mode only
  email: z.string().email("Некорректный email"),
});

/**
 * POST /api/gaffer/auth/login
 * Публичный маршрут — создаёт GafferUser если не существует, выдаёт JWT.
 * ВНИМАНИЕ: passwordless режим — только для разработки.
 * TODO(sprint-5): заменить на password + Google OAuth + Telegram Login.
 */
router.post("/login", async (req, res, next) => {
  try {
    const { email } = loginSchema.parse(req.body);

    const user = await prisma.gafferUser.upsert({
      where: { email },
      update: {},
      create: { email },
    });

    const token = signGafferSession(user);
    res.cookie(GAFFER_COOKIE_NAME, token, gafferCookieOptions());
    res.json({ user, token });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/gaffer/auth/logout
 * Очищает cookie gaffer_session.
 */
router.post("/logout", (_req, res) => {
  res.clearCookie(GAFFER_COOKIE_NAME, { path: "/" });
  res.status(204).end();
});

/**
 * GET /api/gaffer/auth/me
 * Возвращает текущего GafferUser.
 */
router.get("/me", gafferAuth, (req, res) => {
  res.json({ user: req.gafferUser });
});

/**
 * POST /api/gaffer/auth/complete-onboarding
 * Отмечает завершение онбординга для текущего GafferUser.
 */
router.post("/complete-onboarding", gafferAuth, async (req, res, next) => {
  try {
    const updated = await prisma.gafferUser.update({
      where: { id: req.gafferUser!.id },
      data: { onboardingCompletedAt: new Date() },
    });
    res.json({ user: updated });
  } catch (err) {
    next(err);
  }
});

export { router as gafferAuthRouter };
