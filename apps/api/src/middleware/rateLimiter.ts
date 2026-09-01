import rateLimit, { ipKeyGenerator } from "express-rate-limit";
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
  // ipKeyGenerator схлопывает IPv6 до /56-подсети: голый req.ip дал бы клиенту
  // свежий бакет на каждый адрес подсети (и ERR_ERL_KEY_GEN_IPV6 в v8).
  return req.ip ? `ip:${ipKeyGenerator(req.ip)}` : "ip:unknown";
}

/**
 * Фабрика лимитера с собственным (изолированным) счётчиком.
 *
 * `disabled` позволяет задать режим явно, не трогая `process.env`. Это нужно
 * тестам: раньше `rateLimiter.test.ts` глобально удалял `RATE_LIMIT_DISABLED`,
 * чтобы включить лимитер себе, — и на это окно ловили 429 соседние файлы,
 * которые в тот момент выполнялись в тех же воркерах vitest. Отсюда шли
 * плавающие падения по всему набору (fix 2026-08-05). Когда `disabled` не
 * передан — поведение прежнее, флаг читается из окружения на каждом запросе.
 */
export function createRateLimiter(
  options: { disabled?: boolean; max?: number } = {},
) {
  return rateLimit({
    windowMs: 60 * 1000, // 1 минута
    // 300 на пользователя: закладываемся на поллинг задач + параллельные вкладки.
    // Это защита от абьюза, легитимную работу она задевать не должна.
    // `max` переопределяется только тестами — иначе каждый кейс гнал бы 300+
    // последовательных HTTP-запросов и разваливался по таймауту под нагрузкой.
    max: options.max ?? 300,
    keyGenerator: limiterKey,
    skip: (req: Request) => {
      const off =
        options.disabled ?? process.env.RATE_LIMIT_DISABLED === "true";
      return off || req.path === "/health";
    },
    validate: { xForwardedForHeader: false },
    handler: (_req: Request, res: Response) => {
      res.status(429).json({
        message: "Слишком много запросов, попробуйте позже",
        code: "RATE_LIMITED",
      });
    },
  });
}

export const rateLimiter = createRateLimiter();
