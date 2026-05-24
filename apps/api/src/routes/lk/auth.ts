import { Router } from "express";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { prisma } from "../../prisma";
import { issueMagicLink } from "../../services/clientPortal/magicLink";
import { loginViaMagicLink } from "../../services/clientPortal/portalAccountService";
import { sendLoginEmail } from "../../services/clientPortal/mailer";
import { signLkSession, LK_COOKIE_NAME, lkCookieOptions } from "../../services/clientPortal/session";
import { verifyPassword } from "../../services/clientPortal/password";
import { lkAuth } from "../../middleware/lkAuth";
import { HttpError } from "../../utils/errors";
const router = Router();

const requestLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.RATE_LIMIT_DISABLED === "true",
  message: { code: "RATE_LIMIT", error: "Слишком много попыток. Подождите 15 минут." },
});

const emailSchema = z.object({ email: z.string().email().toLowerCase().trim() });

router.post("/request-login", requestLoginLimiter, async (req, res, next) => {
  try {
    const parsed = emailSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "Некорректный email", "INVALID_EMAIL");
    const { email } = parsed.data;

    const account = await prisma.clientPortalAccount.findUnique({ where: { email } });
    if (account && account.status === "ACTIVE") {
      if (!account.lockedUntil || account.lockedUntil.getTime() < Date.now()) {
        const { rawToken } = await issueMagicLink(prisma, account.id, "LOGIN");
        try {
          await sendLoginEmail({ email: account.email }, rawToken);
        } catch (mailErr) {
          // eslint-disable-next-line no-console
          console.error("[LK] sendLoginEmail failed:", mailErr);
          // Swallow — no-enumeration: caller always gets 200
        }
      }
    }
    // Always 200 — no enumeration
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

const passwordLoginSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
  password: z.string().min(1).max(200),
});

router.post("/password-login", requestLoginLimiter, async (req, res, next) => {
  try {
    const parsed = passwordLoginSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(401, "Неверные учётные данные", "INVALID_CREDENTIALS");
    }
    const { email, password } = parsed.data;

    const account = await prisma.clientPortalAccount.findUnique({ where: { email } });
    // Constant-time-ish: always run bcrypt even when account missing/has no password
    const hash = account?.passwordHash ?? "$2a$10$invalidsaltinvalidsaltinvalidsaltinvalidsalt";
    const ok = await verifyPassword(password, hash);

    if (!account || account.status !== "ACTIVE" || !account.passwordHash || !ok) {
      throw new HttpError(401, "Неверные учётные данные", "INVALID_CREDENTIALS");
    }

    if (account.lockedUntil && account.lockedUntil.getTime() > Date.now()) {
      throw new HttpError(401, "Неверные учётные данные", "INVALID_CREDENTIALS");
    }

    const meta = {
      ip: (req.ip ?? null) || null,
      ua: (req.get("user-agent") ?? null) || null,
    };

    await prisma.clientPortalAccount.update({
      where: { id: account.id },
      data: {
        lastLoginAt: new Date(),
        lastLoginIp: meta.ip ?? undefined,
        lastLoginUa: meta.ua ?? undefined,
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });

    const token = signLkSession({ accountId: account.id, clientId: account.clientId, email: account.email });
    res.cookie(LK_COOKIE_NAME, token, lkCookieOptions());
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

const verifySchema = z.object({ token: z.string().min(10).max(128) });

router.post("/verify", async (req, res, next) => {
  try {
    const parsed = verifySchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(401, "Ссылка недействительна или истекла", "INVALID_TOKEN");

    const meta = {
      ip: (req.ip ?? null) || null,
      ua: (req.get("user-agent") ?? null) || null,
    };

    const result = await loginViaMagicLink(parsed.data.token, meta);
    if (!result.ok) {
      throw new HttpError(401, "Ссылка недействительна или истекла", "INVALID_TOKEN");
    }

    const token = signLkSession({
      accountId: result.account.id,
      clientId: result.account.clientId,
      email: result.account.email,
    });
    res.cookie(LK_COOKIE_NAME, token, lkCookieOptions());
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post("/logout", lkAuth, async (req, res) => {
  res.clearCookie(LK_COOKIE_NAME, { path: "/" });
  res.json({ ok: true });
});

export default router;
