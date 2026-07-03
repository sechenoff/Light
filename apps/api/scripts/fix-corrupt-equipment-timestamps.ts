/**
 * Ремонт битых DateTime в Equipment.
 *
 * Симптом: `GET /api/bookings/:id` (detail, include items→equipment) падал
 * `PrismaClientRustPanicError: No such local time`. Причина — у 10 приборов
 * `updatedAt = 178101629633436964` (18-значный мусор вместо 13-значного ms;
 * первые 13 цифр — валидный ms 2026-06-07, к ним склеено «36964» → баг
 * конкатенации в каком-то разовом raw-SQL/ручной правке SQLite). Значение
 * вне диапазона, который chrono-tz может представить → Query Engine паникует
 * при десериализации DATETIME-колонки. TZ-независимо → падало и на проде.
 *
 * ВАЖНО: Prisma к этим строкам НЕприменима — даже `$queryRaw` паникует, т.к.
 * SQLite-коннектор десериализует integer как DateTime. Поэтому ремонт идёт
 * через `sqlite3` CLI напрямую (обходит маппинг типов Prisma полностью).
 *
 * Fix: `updatedAt = createdAt` для строк, где updatedAt вне диапазона
 * [2000-01-01 .. 2100-01-01) в ms. Идемпотентно, трогает только битые строки.
 *
 * Запуск (dry-run):  tsx scripts/fix-corrupt-equipment-timestamps.ts
 * Запуск (execute):  tsx scripts/fix-corrupt-equipment-timestamps.ts --execute
 * Путь к БД:         из DATABASE_URL (file:...) либо аргумент --db <path>.
 */
import { execFileSync } from "node:child_process";
import * as path from "node:path";

// Валидный диапазон epoch-ms: [2000-01-01, 2100-01-01)
const MIN_MS = 946684800000;
const MAX_MS = 4102444800000;
const WHERE = `typeof(updatedAt)='integer' AND (updatedAt < ${MIN_MS} OR updatedAt > ${MAX_MS})`;

/** Резолвит путь к SQLite-файлу: из --db, иначе из DATABASE_URL (относительно prisma/). */
function resolveDbPath(): string {
  const dbArgIdx = process.argv.indexOf("--db");
  if (dbArgIdx !== -1 && process.argv[dbArgIdx + 1]) {
    return path.resolve(process.argv[dbArgIdx + 1]);
  }
  const url = process.env.DATABASE_URL ?? "";
  const m = url.match(/^file:(.+)$/);
  if (!m) {
    throw new Error("Не удалось определить путь к БД: задай DATABASE_URL=file:... или --db <path>");
  }
  // Относительные пути в Prisma резолвятся от каталога schema.prisma (prisma/).
  const raw = m[1];
  return path.isAbsolute(raw) ? raw : path.resolve(__dirname, "..", "prisma", raw);
}

function sqlite(db: string, sql: string): string {
  return execFileSync("sqlite3", [db, sql], { encoding: "utf8" }).trim();
}

function main() {
  const execute = process.argv.includes("--execute");
  const db = resolveDbPath();
  console.log(`БД: ${db}`);

  const count = Number(sqlite(db, `SELECT COUNT(*) FROM "Equipment" WHERE ${WHERE};`));
  if (count === 0) {
    console.log("✓ Битых Equipment.updatedAt не найдено — база чистая.");
    return;
  }

  const rows = sqlite(db, `SELECT id || ' — ' || name || ': ' || updatedAt FROM "Equipment" WHERE ${WHERE};`);
  console.log(`Найдено ${count} повреждённых строк:`);
  console.log(rows.split("\n").map((r) => `  ${r}`).join("\n"));

  if (!execute) {
    console.log("\n[dry-run] Изменения НЕ применены. Запусти с --execute для записи.");
    return;
  }

  sqlite(db, `UPDATE "Equipment" SET updatedAt = createdAt WHERE ${WHERE};`);
  const after = Number(sqlite(db, `SELECT COUNT(*) FROM "Equipment" WHERE ${WHERE};`));
  console.log(`\n✓ Отремонтировано. Битых осталось: ${after}`);
}

main();
