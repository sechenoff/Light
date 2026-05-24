import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";

import { router } from "./routes";
import { authRouter } from "./routes/auth";
import { gafferRouter } from "./routes/gaffer";
import { HttpError } from "./utils/errors";
import { rateLimiter } from "./middleware/rateLimiter";
import { apiKeyAuth } from "./middleware/apiKeyAuth";
import { botScopeGuard } from "./middleware/botScopeGuard";
import { sessionParser } from "./middleware/sessionAuth";
import { warehousePublicRouter, warehouseScanRouter } from "./routes/warehouse";

function isMalformedJsonBodyError(err: unknown): boolean {
  return (
    err instanceof SyntaxError &&
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status: unknown }).status === 400
  );
}

const app = express();

app.use(
  helmet({
    // SPA на другом порту (CORS) должна иметь возможность читать blob (PDF/XLSX) из fetch.
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
);
/** CORS: в .env можно несколько origin через запятую. В dev к списку добавляются localhost и 127.0.0.1 :3000 — иначе при открытии Next как 127.0.0.1 запросы на API падают. */
const corsOriginRaw = process.env.CORS_ORIGIN?.trim();
let corsOrigin: boolean | string | string[];
if (!corsOriginRaw) {
  corsOrigin = true;
} else {
  const fromEnv = corsOriginRaw.split(",").map((s) => s.trim()).filter(Boolean);
  const devExtras =
    process.env.NODE_ENV !== "production"
      ? ["http://localhost:3000", "http://127.0.0.1:3000"]
      : [];
  const merged = [...new Set([...fromEnv, ...devExtras])];
  corsOrigin = merged.length === 1 ? merged[0]! : merged;
}

app.use(
  cors({
    origin: corsOrigin,
    credentials: true,
    exposedHeaders: ["Content-Disposition", "Content-Type", "Content-Length"],
  }),
);
app.use(morgan("dev"));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use(rateLimiter);

app.get("/health", (_req, res) => res.json({ ok: true }));
// Auth routes — публичные (до apiKeyAuth), но login/logout не требует авторизации; /me использует cookie.
app.use("/api/auth", sessionParser, authRouter);
// Gaffer CRM routes — публичные (до apiKeyAuth), собственная auth система (gaffer_session JWT).
app.use("/api/gaffer", gafferRouter);
app.use("/api/warehouse", warehousePublicRouter);
// sessionParser здесь нужен для fallback warehouseAuth → main session (SA/WH без PIN)
app.use("/api/warehouse", sessionParser, warehouseScanRouter);
app.use(apiKeyAuth);
app.use(sessionParser);
app.use(botScopeGuard);
app.use(router);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({
      message: err.message,
      details: err.details,
      // Surface .code on the response. Legacy 3-arg form stored the code in
      // details (string) — handled below. 4-arg form sets .code explicitly
      // and keeps details as the structured payload; we still need to surface
      // the code so frontend can branch on it (ADDON_OVER_STOCK, etc).
      ...(err.code
        ? { code: err.code }
        : typeof err.details === "string"
          ? { code: err.details }
          : {}),
    });
  }
  if (err instanceof ZodError) {
    return res.status(400).json({
      message: "Некорректные данные запроса",
      details: err.flatten(),
    });
  }
  if (isMalformedJsonBodyError(err)) {
    return res.status(400).json({ message: "Некорректный JSON в теле запроса" });
  }
  if (err instanceof Prisma.PrismaClientInitializationError) {
    return res.status(503).json({
      message:
        "Не удаётся подключиться к базе данных. Проверьте DATABASE_URL в apps/api/.env и что файл SQLite или сервер БД доступны.",
      code: "DATABASE_UNAVAILABLE",
      ...(process.env.NODE_ENV !== "production" ? { details: err.message } : {}),
    });
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      return res.status(409).json({ error: "Запись с таким значением уже существует" });
    }
    if (err.code === "P1001" || err.code === "P1003") {
      return res.status(503).json({
        message:
          "База данных недоступна (сеть, хост или путь к файлу). Проверьте DATABASE_URL и перезапустите API.",
        code: "DATABASE_UNAVAILABLE",
        ...(process.env.NODE_ENV !== "production" ? { details: err.message } : {}),
      });
    }
  }
  const rawMessage = err instanceof Error ? err.message : String(err ?? "");
  const normalized = rawMessage.toLowerCase();
  const dbOutOfSync =
    normalized.includes("no such table") ||
    normalized.includes("no such column") ||
    normalized.includes("the column") ||
    normalized.includes("does not exist");
  if (dbOutOfSync) {
    return res.status(500).json({
      message:
        "База данных не синхронизирована со схемой Prisma. Выполните миграции: `cd apps/api && npx prisma migrate dev && npx prisma generate` и перезапустите API.",
      details: rawMessage,
    });
  }
  // eslint-disable-next-line no-console
  console.error(err);
  // Internal tool, one-staff shop — surfacing the real Error.message to the
  // operator is more valuable than hiding it. Helps triage production issues
  // without SSH access. Stack traces are NOT included; we only echo the
  // single-line message string.
  const publicMessage = rawMessage
    ? `Внутренняя ошибка сервера: ${rawMessage}`
    : "Внутренняя ошибка сервера";
  res.status(500).json({ message: publicMessage });
});

// Customer Portal env validation
if (process.env.NODE_ENV === "production") {
  if (!process.env.CLIENT_PORTAL_SESSION_SECRET || process.env.CLIENT_PORTAL_SESSION_SECRET.length < 16) {
    throw new Error("CLIENT_PORTAL_SESSION_SECRET обязателен в production (минимум 16 символов)");
  }
  if (!process.env.CLIENT_PORTAL_TOKEN_SECRET || process.env.CLIENT_PORTAL_TOKEN_SECRET.length < 16) {
    throw new Error("CLIENT_PORTAL_TOKEN_SECRET обязателен в production (HMAC секрет для magic-link, минимум 16 символов)");
  }
  if (!process.env.SMTP_HOST) {
    throw new Error("SMTP_HOST обязателен в production (для отправки magic-link клиентам портала)");
  }
}

export { app };

