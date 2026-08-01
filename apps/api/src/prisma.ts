import { PrismaClient } from "@prisma/client";

// PrismaClient should be a singleton in dev to avoid exhausting connections.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.PRISMA_LOG === "true" ? ["query", "error", "warn"] : ["error", "warn"],
  });

if (!globalForPrisma.prisma) {
  globalForPrisma.prisma = prisma;

  // ── SQLite-тюнинг (перф-аудит 2026-08-02) ──────────────────────────────────
  // journal_mode=WAL — persistent-настройка файла БД: пишется один раз и
  // действует для всех будущих соединений. В DELETE-режиме (дефолт) каждая
  // запись пересоздаёт журнал с fsync — полный пересчёт финансов 288 броней
  // занимал ~3 с; WAL убирает журнальную возню (запись идёт в -wal append-only).
  //
  // ВАЖНО для бэкапов: с WAL свежие транзакции живут в prod.db-wal до
  // чекпойнта, поэтому CI-бэкап делает `PRAGMA wal_checkpoint(TRUNCATE)`
  // перед cp главного файла (см. deploy-rsync.yml).
  //
  // busy_timeout — per-connection, но Prisma выполняет его на соединении пула;
  // конкурентная запись при WAL всё равно одна, таймаут страхует от
  // SQLITE_BUSY при параллельных прогонах (dashboard+debts одновременно).
  //
  // В тестах WAL не включаем: тестовые БД пересоздаются через
  // `db push --force-reset`, и осиротевший -wal-файл от прошлого прогона
  // (teardown многих тестов удаляет только .db) даёт «database disk image
  // is malformed». Тюнинг — прод-рантайм, тестам он не нужен.
  //
  // Ошибки глотаем осознанно: это оптимизация, не инвариант.
  if (process.env.NODE_ENV !== "test") {
    void prisma
      .$queryRawUnsafe("PRAGMA journal_mode=WAL;")
      .then(() => prisma.$queryRawUnsafe("PRAGMA busy_timeout=5000;"))
      .catch(() => {
        /* тюнинг недоступен — работаем на дефолтах */
      });
  }
}

