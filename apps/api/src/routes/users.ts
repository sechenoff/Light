import express from "express";
import { z } from "zod";
import { upsertUser } from "../services/users";

const router = express.Router();

const upsertSchema = z.object({
  /** Telegram user ID передаётся как строка (JSON не поддерживает BigInt) */
  telegramId: z.string().regex(/^\d+$/),
  username: z.string().optional().nullable(),
  firstName: z.string().optional().nullable(),
});

/**
 * POST /api/users/upsert
 * Создаёт или обновляет Telegram-пользователя.
 */
router.post("/upsert", async (req, res, next) => {
  try {
    const body = upsertSchema.parse(req.body);
    const user = await upsertUser({
      telegramId: BigInt(body.telegramId),
      username: body.username,
      firstName: body.firstName,
    });
    res.json({ user: { ...user, telegramId: user.telegramId.toString() } });
  } catch (err) {
    next(err);
  }
});

export { router as usersRouter };
