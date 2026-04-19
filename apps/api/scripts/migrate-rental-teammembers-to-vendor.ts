/**
 * Скрипт миграции: GafferContact type=TEAM_MEMBER с roleLabel типа "Рентал" → type=VENDOR.
 *
 * Использование:
 *   tsx apps/api/scripts/migrate-rental-teammembers-to-vendor.ts                        # dry-run (по умолчанию)
 *   tsx apps/api/scripts/migrate-rental-teammembers-to-vendor.ts --execute --i-understand # реальное выполнение
 *
 * Флаг --i-understand обязателен при --execute (защита от случайного запуска).
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import { prisma } from "../src/prisma";

const isDryRun = !process.argv.includes("--execute");
const iUnderstand = process.argv.includes("--i-understand");

async function findCandidates(): Promise<Array<{ id: string; name: string; roleLabel: string | null }>> {
  // Сопоставляем только Кириллицу: %ентал% (Рентал, рентал, Ренталу, ренталов и т.д.)
  // Латинский вариант %ental% убран — он избыточно совпадает с "dental", "Oriental" и т.п.
  const rows = await prisma.$queryRaw<Array<{ id: string; name: string; roleLabel: string | null }>>`
    SELECT id, name, roleLabel FROM GafferContact
    WHERE type = 'TEAM_MEMBER'
      AND roleLabel LIKE '%ентал%'
  `;
  return rows;
}

async function main() {
  console.log("=== Миграция рентал-контактов TEAM_MEMBER → VENDOR ===");
  console.log(`Режим: ${isDryRun ? "DRY-RUN (без изменений)" : "EXECUTE (реальная запись)"}\n`);

  const candidates = await findCandidates();

  if (candidates.length === 0) {
    console.log("Нет контактов для миграции (TEAM_MEMBER с roleLabel типа «Рентал» не найдено).");
    await prisma.$disconnect();
    return;
  }

  console.log(`Найдено контактов для миграции: ${candidates.length}`);
  console.log("\nПримеры:");
  candidates.slice(0, 10).forEach((c) => {
    console.log(`  id=${c.id}  name="${c.name}"  roleLabel="${c.roleLabel ?? ""}"`);
  });
  if (candidates.length > 10) {
    console.log(`  … ещё ${candidates.length - 10} записей`);
  }

  if (isDryRun) {
    console.log("\nDRY-RUN: изменения НЕ применены.");
    console.log(`\nДля реального применения запустите с ОБОИМИ флагами:`);
    console.log(`  tsx apps/api/scripts/migrate-rental-teammembers-to-vendor.ts --execute --i-understand`);
    console.log(`\nБудет изменено: ${candidates.length} записей GafferContact (type TEAM_MEMBER → VENDOR).`);
    await prisma.$disconnect();
    return;
  }

  // Защита от случайного деструктивного запуска
  if (!iUnderstand) {
    console.error("\n⚠️  ОШИБКА: флаг --i-understand обязателен при --execute.");
    console.error(`\nБудет изменено ${candidates.length} записей. Убедитесь, что у вас есть резервная копия БД.`);
    console.error(`Перезапустите с обоими флагами:`);
    console.error(`  tsx apps/api/scripts/migrate-rental-teammembers-to-vendor.ts --execute --i-understand`);
    await prisma.$disconnect();
    process.exit(1);
  }

  // Backup БД перед изменениями
  // DATABASE_URL вида "file:./prisma/dev.db" — путь относительно cwd (apps/api/).
  const rawDbPath = (process.env.DATABASE_URL?.replace(/^file:/, "") ?? "./prisma/dev.db");
  // Резолвим относительно cwd (скрипт запускается из apps/api/)
  const absoluteDbPath = path.resolve(process.cwd(), rawDbPath);
  const backupsDir = path.resolve(process.cwd(), "prisma/backups");

  console.log(`\nФайл БД: ${absoluteDbPath}`);

  if (!fs.existsSync(absoluteDbPath)) {
    console.error(`ОШИБКА: файл БД не найден: ${absoluteDbPath}`);
    console.error("Создайте резервную копию вручную и убедитесь, что DATABASE_URL указывает на существующий файл.");
    await prisma.$disconnect();
    process.exit(1);
  }

  fs.mkdirSync(backupsDir, { recursive: true });
  const backupFile = path.join(backupsDir, `rental-vendor-migration-${Date.now()}.db`);
  fs.copyFileSync(absoluteDbPath, backupFile);
  console.log(`Backup создан: ${backupFile}`);

  // Выполнение миграции
  const result = await prisma.$executeRaw`
    UPDATE GafferContact SET type = 'VENDOR'
    WHERE type = 'TEAM_MEMBER'
      AND roleLabel LIKE '%ентал%'
  `;

  console.log(`\nОбновлено записей: ${result}`);
  console.log("Миграция завершена успешно.");
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("Ошибка миграции:", err);
  await prisma.$disconnect();
  process.exit(1);
});
