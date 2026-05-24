import { Router } from "express";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { PrismaClient } from "@prisma/client";
import { issueMagicLink } from "../../services/clientPortal/magicLink";
import { sendLoginEmail } from "../../services/clientPortal/mailer";
import { HttpError } from "../../utils/errors";

const prisma = new PrismaClient();
const router = Router();

const requestLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === "test" ? 1000 : 5,
  standardHeaders: true,
  legacyHeaders: false,
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
        await sendLoginEmail({ email: account.email }, rawToken);
      }
    }
    // Always 200 — no enumeration
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
