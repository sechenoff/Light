import { timingSafeEqual } from "crypto";
import type { Request, Response, NextFunction } from "express";

// Читаем ключи из env при загрузке модуля
const rawKeys = process.env.API_KEYS ?? "";
const apiKeys: Set<string> = new Set(
  rawKeys
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean),
);

const authMode = process.env.AUTH_MODE ?? "warn";

if (apiKeys.size === 0 && authMode === "enforce") {
  // eslint-disable-next-line no-console
  console.error(
    "[CRITICAL] API_KEYS не настроены, но AUTH_MODE=enforce. Все запросы будут отклонены.",
  );
} else if (apiKeys.size === 0) {
  // eslint-disable-next-line no-console
  console.warn(
    "[WARNING] API_KEYS не настроены. Аутентификация отключена (AUTH_MODE=warn).",
  );
}

function timingSafeCompare(a: string, b: string): boolean {
  try {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) {
      // Всё равно выполняем сравнение одинаковой длины, чтобы избежать timing leak
      timingSafeEqual(bufA, bufA);
      return false;
    }
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

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

function isValidKey(provided: string): boolean {
  for (const key of apiKeys) {
    if (timingSafeCompare(provided, key)) {
      return true;
    }
  }
  return false;
}

export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  // Нет ключей + warn → пропускаем всё
  if (apiKeys.size === 0 && authMode !== "enforce") {
    next();
    return;
  }

  // Нет ключей + enforce → отклоняем всё
  if (apiKeys.size === 0 && authMode === "enforce") {
    res.status(401).json({
      message: "Неверный или отсутствующий API-ключ",
      code: "UNAUTHORIZED",
    });
    return;
  }

  const provided = extractKey(req);
  const valid = provided !== undefined && isValidKey(provided);

  if (!valid) {
    if (authMode === "enforce") {
      res.status(401).json({
        message: "Неверный или отсутствующий API-ключ",
        code: "UNAUTHORIZED",
      });
      return;
    }
    // warn mode: логируем и пропускаем
    // eslint-disable-next-line no-console
    console.warn(
      `[WARNING] Неавторизованный запрос: ${req.method} ${req.path} — неверный или отсутствующий API-ключ`,
    );
  }

  next();
}
