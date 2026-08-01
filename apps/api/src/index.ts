import "dotenv/config";
import net from "net";

import { app } from "./app";
import { paymentStatusSyncForAllBookings, PAYMENT_SYNC_THROTTLE_MS } from "./services/finance";
import type { Worker } from "bullmq";

const port = Number(process.env.PORT ?? 4000);

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`[api] listening on http://localhost:${port}`);
});

// ── Фоновый финансовый синк (перф-аудит 2026-08-02) ──────────────────────────
// Полный пересчёт финансов всех броней раньше запускался ИЗ user-запроса
// (первый GET dashboard/debts после минуты простоя ловил ~3 с). Теперь прогон
// делает фоновый интервал: к моменту любого пользовательского запроса
// троттл-окно (60 с) почти всегда свежее, и await в роутах возвращается
// мгновенно. Сами вызовы в роутах сохранены — это контракт для тестов
// (детерминизм: тесты импортируют app без index и интервал не получают).
// unref(): таймер не держит процесс при graceful shutdown.
// Тик — вдвое чаще троттла: если тикать ровно раз в окно, тик может попадать
// за мгновение ДО истечения троттла (скип), и прогон доставался бы следующему
// пользовательскому запросу. При полуокне фоновый тик почти всегда первым
// пересекает границу окна.
void paymentStatusSyncForAllBookings().catch(() => {});
setInterval(() => {
  void paymentStatusSyncForAllBookings().catch(() => {});
}, PAYMENT_SYNC_THROTTLE_MS / 2).unref();

// Проверяем доступность Redis TCP-зондом перед созданием ioredis/BullMQ.
// Это позволяет стартовать API без Redis — без ошибок в логах.
function isRedisAvailable(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const host = u.hostname;
      const redisPort = Number(u.port) || 6379;
      const socket = net.connect({ host, port: redisPort });
      socket.setTimeout(1000);
      socket.on("connect", () => { socket.destroy(); resolve(true); });
      socket.on("error",   () => { socket.destroy(); resolve(false); });
      socket.on("timeout", () => { socket.destroy(); resolve(false); });
    } catch {
      resolve(false);
    }
  });
}

let worker: Worker | null = null;

async function tryStartWorker() {
  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
  const available = await isRedisAvailable(redisUrl);

  if (!available) {
    // eslint-disable-next-line no-console
    console.warn("[worker] Redis unavailable — photo analysis queue disabled. Start Redis to enable it.");
    return;
  }

  const { redisConnection } = await import("./queue/connection");
  const { createAnalysisWorker } = await import("./queue/analysisWorker");
  redisConnection.on("error", (err: Error) => {
    // eslint-disable-next-line no-console
    console.error("[redis]", err.message);
  });
  worker = createAnalysisWorker();
  // eslint-disable-next-line no-console
  console.log("[worker] started (Redis connected)");
}

tryStartWorker();

async function shutdown(signal: string) {
  // eslint-disable-next-line no-console
  console.log(`[api] ${signal} — shutting down`);
  if (worker) await worker.close().catch(() => {});
  process.exit(0);
}

process.once("SIGINT",  () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
