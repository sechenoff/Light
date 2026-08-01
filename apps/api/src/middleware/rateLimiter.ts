import rateLimit from "express-rate-limit";
import type { Request, Response } from "express";

/**
 * Перф-аудит 2026-08-02: раньше лимит был чисто по IP. Все браузерные запросы
 * приходят через Next-прокси с ОДНОГО адреса (127.0.0.1) — весь офис делил
 * один бакет 100 req/мин, и при живом поллинге задач (12 с список + 8 с
 * панель × несколько вкладок) массовый 429 был вопросом времени.
 *
 * Ключ теперь: сессия пользователя → API-ключ бота → IP (для неавторизованных).
 * Cookie к этому моменту уже распарсены (cookieParser стоит до limiter в app.ts).
 * Значение cookie не валидируем — для нарезки бакетов подлинность не важна,
 * а подделка ключа лишь выделяет нарушителю персональный бакет.
 */
function limiterKey(req: Request): string {
  const session = (req.cookies as Record<string, string> | undefined)?.lr_session;
  if (session) return `s:${session.slice(0, 32)}`;
  const apiKey = req.get("x-api-key");
  if (apiKey) return `k:${apiKey.slice(0, 32)}`;
  return `ip:${req.ip ?? "unknown"}`;
}

export const rateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 минута
  // 300 на пользователя: закладываемся на поллинг задач + параллельные вкладки.
  // Это защита от абьюза, легитимную работу она задевать не должна.
  max: 300,
  keyGenerator: limiterKey,
  skip: (req: Request) =>
    process.env.RATE_LIMIT_DISABLED === "true" || req.path === "/health",
  validate: { xForwardedForHeader: false },
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      message: "Слишком много запросов, попробуйте позже",
      code: "RATE_LIMITED",
    });
  },
});
