import IORedis from "ioredis";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

/**
 * Shared IORedis connection для BullMQ.
 * BullMQ требует maxRetriesPerRequest: null — иначе бросает ошибку при старте воркера.
 *
 * retryStrategy = null означает «не пытаться переподключиться».
 * Первое соединение попробуем при lazyConnect: true, и если Redis недоступен —
 * воркер просто не запустится (см. index.ts).
 */
export const redisConnection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: true,
  retryStrategy: () => null, // не реконнектимся — избегаем бесконечного спама в логах
});

redisConnection.on("error", () => {
  // Тихо игнорируем — основной обработчик в index.ts
});
