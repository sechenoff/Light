import express from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../../prisma";
import { signGafferSession, GAFFER_COOKIE_NAME, gafferCookieOptions } from "../../services/gaffer/session";
import { gafferAuth } from "../../middleware/gafferAuth";
import { HttpError } from "../../utils/errors";

const router = express.Router();

// ── Schemas ────────────────────────────────────────────────────────────────

const emailSchema = z.string().email("Некорректный email").max(254);
const passwordSchema = z
  .string()
  .min(6, "Пароль минимум 6 символов")
  .max(128, "Пароль слишком длинный");

const loginSchema = z.object({
  email: emailSchema,
  password: passwordSchema.optional(), // optional → backwards-compat для legacy passwordless юзеров без passwordHash
});

const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().min(1, "Введите имя").max(80).optional(),
});

const forgotSchema = z.object({
  email: emailSchema,
});

// ── Helpers ────────────────────────────────────────────────────────────────

function publicUser(u: {
  id: string;
  email: string;
  name?: string | null;
  onboardingCompletedAt?: Date | null;
}) {
  return {
    id: u.id,
    email: u.email,
    name: u.name ?? null,
    onboardingCompletedAt: u.onboardingCompletedAt ?? null,
  };
}

function setSessionCookie(res: express.Response, user: { id: string; email: string }) {
  const token = signGafferSession(user);
  res.cookie(GAFFER_COOKIE_NAME, token, gafferCookieOptions());
  return token;
}

// ── Routes ─────────────────────────────────────────────────────────────────

/**
 * POST /api/gaffer/auth/register
 * Создаёт нового GafferUser с email + паролем (bcrypt-хеш). Имя опционально.
 * Если email уже занят пользователем с passwordHash — 409 EMAIL_TAKEN.
 * Если email занят legacy passwordless юзером (passwordHash == null) — апгрейдит его (account claim).
 */
router.post("/register", async (req, res, next) => {
  try {
    const { email: rawEmail, password, name } = registerSchema.parse(req.body);
    const email = rawEmail.trim().toLowerCase();

    const existing = await prisma.gafferUser.findUnique({ where: { email } });
    if (existing && existing.passwordHash) {
      throw new HttpError(409, "Этот email уже зарегистрирован", "EMAIL_TAKEN");
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = existing
      ? await prisma.gafferUser.update({
          where: { id: existing.id },
          data: {
            passwordHash,
            name: name ?? existing.name ?? null,
            authProvider: "PASSWORD",
          },
        })
      : await prisma.gafferUser.create({
          data: {
            email,
            passwordHash,
            name: name ?? null,
            authProvider: "PASSWORD",
          },
        });

    const token = setSessionCookie(res, user);
    res.status(201).json({ user: publicUser(user), token });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/gaffer/auth/login
 * Вход по email + паролю.
 *
 * Поведение:
 *  - Если у пользователя есть passwordHash → требуем пароль и сверяем bcrypt.
 *  - Если passwordHash отсутствует (legacy passwordless или auto-created в тестах):
 *      • в production → 401, заставляем пройти регистрацию;
 *      • в dev/test → пропускаем (back-compat для существующих сессий и интеграционных тестов).
 *  - Если пользователя нет:
 *      • в production → 401 (нужна регистрация);
 *      • в dev/test → создаём passwordless-юзера (как раньше; удобно для seed/test).
 */
router.post("/login", async (req, res, next) => {
  try {
    const { email: rawEmail, password } = loginSchema.parse(req.body);
    const email = rawEmail.trim().toLowerCase();
    const isProd = process.env.NODE_ENV === "production";

    let user = await prisma.gafferUser.findUnique({ where: { email } });

    if (!user) {
      if (isProd) {
        throw new HttpError(401, "Неверный email или пароль", "INVALID_CREDENTIALS");
      }
      // Dev/test: автосоздаём passwordless-юзера, чтобы не ломать seed и интеграционные тесты.
      user = await prisma.gafferUser.create({ data: { email } });
    }

    // Legacy passwordless: пользователь без passwordHash.
    if (!user.passwordHash) {
      if (isProd) {
        throw new HttpError(
          401,
          "Для этого аккаунта требуется регистрация с паролем",
          "PASSWORD_REQUIRED",
        );
      }
      const token = setSessionCookie(res, user);
      res.json({ user: publicUser(user), token, legacy: true });
      return;
    }

    // Стандартный путь: требуем пароль и сверяем хеш.
    if (!password) {
      throw new HttpError(401, "Введите пароль", "PASSWORD_REQUIRED");
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      throw new HttpError(401, "Неверный email или пароль", "INVALID_CREDENTIALS");
    }

    const token = setSessionCookie(res, user);
    res.json({ user: publicUser(user), token });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/gaffer/auth/forgot-password
 * Заглушка: всегда отвечает 200, чтобы не давать enumeration. Email не отправляется.
 * TODO(sprint-5): подключить почтовую инфраструктуру и отправлять токен сброса.
 */
router.post("/forgot-password", async (req, res, next) => {
  try {
    const { email } = forgotSchema.parse(req.body);
    // eslint-disable-next-line no-console
    console.warn(`[gaffer] forgot-password requested for ${email.trim().toLowerCase()} — email not sent (stub)`);
    res.json({ ok: true, message: "Если этот email зарегистрирован — мы отправили инструкцию по сбросу пароля" });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/gaffer/auth/oauth/google
 * Заглушка: возвращает 503 со специальным кодом, фронт превратит это в дружественный toast.
 * TODO(sprint-5): полноценный OAuth-флоу через @google-oauth-library, sub → providerSubject.
 */
router.post("/oauth/google", (_req, res) => {
  res.status(503).json({
    code: "OAUTH_NOT_AVAILABLE",
    message: "Вход через Google скоро будет доступен. Пока используйте email + пароль.",
  });
});

/**
 * POST /api/gaffer/auth/oauth/telegram
 * Заглушка: 503. TODO(sprint-5): Telegram Login Widget callback verification (HMAC).
 */
router.post("/oauth/telegram", (_req, res) => {
  res.status(503).json({
    code: "OAUTH_NOT_AVAILABLE",
    message: "Вход через Telegram скоро будет доступен. Пока используйте email + пароль.",
  });
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
 */
router.post("/complete-onboarding", gafferAuth, async (req, res, next) => {
  try {
    const updated = await prisma.gafferUser.update({
      where: { id: req.gafferUser!.id },
      data: { onboardingCompletedAt: new Date() },
    });
    res.json({ user: publicUser(updated) });
  } catch (err) {
    next(err);
  }
});

export { router as gafferAuthRouter };
