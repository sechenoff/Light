import type { Request, Response, NextFunction } from "express";

/**
 * Whitelist доступных роутов для бот-ключей с префиксом `openclaw-`.
 * Порядок имеет значение: более специфичные паттерны идут первыми.
 */
const BOT_WHITELIST: Array<{ method: string; pattern: RegExp }> = [
  { method: "GET",   pattern: /^\/api\/equipment(\/[^/]+)?$/ },
  { method: "GET",   pattern: /^\/api\/availability(\/.*)?$/ },
  { method: "GET",   pattern: /^\/api\/bookings(\/[^/]+)?$/ },
  { method: "POST",  pattern: /^\/api\/bookings\/draft$/ },
  { method: "POST",  pattern: /^\/api\/bookings\/quote$/ },
  { method: "POST",  pattern: /^\/api\/bookings\/match-equipment$/ },
  { method: "POST",  pattern: /^\/api\/bookings\/parse-gaffer-review$/ },
  { method: "PATCH", pattern: /^\/api\/bookings\/[^/]+$/ },
  { method: "POST",  pattern: /^\/api\/bookings\/[^/]+\/status$/ },
  { method: "POST",  pattern: /^\/api\/bookings\/[^/]+\/confirm$/ },
  { method: "GET",   pattern: /^\/api\/finance\/debts$/ },
  { method: "GET",   pattern: /^\/api\/finance\/dashboard$/ },
  { method: "GET",   pattern: /^\/api\/receivables$/ },
  { method: "GET",   pattern: /^\/api\/payments(\/[^/]+)?$/ },
];

function extractKey(req: Request): string | undefined {
  const headerKey = req.headers["x-api-key"];
  if (typeof headerKey === "string" && headerKey.length > 0) {
    return headerKey;
  }
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length);
  }
  return undefined;
}

function isAllowedForBot(method: string, path: string): boolean {
  return BOT_WHITELIST.some(
    (entry) => entry.method === method && entry.pattern.test(path),
  );
}

/**
 * Middleware для ограничения прав API-ключей с префиксом `openclaw-`.
 * Применяется глобально после apiKeyAuth — неключевые запросы пропускаются.
 */
export function botScopeGuard(req: Request, res: Response, next: NextFunction): void {
  const key = extractKey(req);

  // Ключ отсутствует или не является бот-ключом — пропускаем без ограничений
  if (!key || !key.startsWith("openclaw-")) {
    next();
    return;
  }

  const method = req.method.toUpperCase();
  const path = req.path;

  // DELETE глобально запрещён для бот-ключей
  if (method === "DELETE") {
    res.status(403).json({
      message: "Bot keys are not allowed to delete",
      code: "BOT_SCOPE_FORBIDDEN",
    });
    return;
  }

  // Проверяем по whitelist
  if (!isAllowedForBot(method, path)) {
    res.status(403).json({
      message: "Bot key does not have access to this endpoint",
      code: "BOT_SCOPE_FORBIDDEN",
    });
    return;
  }

  next();
}
