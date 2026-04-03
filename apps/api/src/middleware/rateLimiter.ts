import rateLimit from "express-rate-limit";
import type { Request, Response } from "express";

export const rateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 минута
  max: 100,
  skip: (_req: Request) => process.env.RATE_LIMIT_DISABLED === "true",
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      message: "Слишком много запросов, попробуйте позже",
      code: "RATE_LIMITED",
    });
  },
});
