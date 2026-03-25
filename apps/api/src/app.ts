import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";

import { router } from "./routes";
import { HttpError } from "./utils/errors";

const app = express();

app.use(
  helmet({
    // SPA на другом порту (CORS) должна иметь возможность читать blob (PDF/XLSX) из fetch.
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
);
app.use(
  cors({
    origin: process.env.CORS_ORIGIN ?? true,
    credentials: true,
    exposedHeaders: ["Content-Disposition", "Content-Type", "Content-Length"],
  }),
);
app.use(morgan("dev"));
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));
app.use(router);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ message: err.message, details: err.details });
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
  res.status(500).json({ message: "Internal server error" });
});

export { app };

