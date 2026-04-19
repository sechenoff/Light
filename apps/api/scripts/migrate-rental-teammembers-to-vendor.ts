/**
 * Скрипт миграции: GafferContact type=TEAM_MEMBER с roleLabel типа "Рентал" → type=VENDOR.
 *
 * Использование:
 *   tsx apps/api/scripts/migrate-rental-teammembers-to-vendor.ts          # dry-run (по умолчанию)
 *   tsx apps/api/scripts/migrate-rental-teammembers-to-vendor.ts --execute # реальное выполнение
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import { prisma } from "../src/prisma";

const isDryRun = !process.argv.includes("--execute");

async function findCandidates(): Promise<Array<{ id: string; name: string; roleLabel: string | null }>> {
  // SQLite LIKE is case-sensitive for ASCII but works for Cyrillic patterns.
  // We match %ентал% (Рентал, рентал) and %ental% (rental).
  const rows = await prisma.$queryRaw<Array<{ id: string; name: string; roleLabel: string | null }>>`
    SELECT id, name, roleLabel FROM GafferContact
    WHERE type = 'TEAM_MEMBER'
      AND (
        roleLabel LIKE '%ентал%'
        OR roleLabel LIKE '%ental%'
      )
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
    console.log("\nDRY-RUN: изменения НЕ применены. Запустите с флагом --execute для реального применения.");
    await prisma.$disconnect();
    return;
  }

  // Backup БД перед изменениями
  const rawDbPath = process.env.DATABASE_URL?.replace("file:", "") ?? "./dev.db";
  const schemaDir = path.resolve(process.cwd(), "prisma");
  const absoluteDbPath = path.resolve(schemaDir, rawDbPath);
  const backupsDir = path.resolve(process.cwd(), "prisma/backups");
  fs.mkdirSync(backupsDir, { recursive: true });
  const backupFile = path.join(backupsDir, `rental-vendor-migration-${Date.now()}.db`);

  if (fs.existsSync(absoluteDbPath)) {
    fs.copyFileSync(absoluteDbPath, backupFile);
    console.log(`\nBackup создан: ${backupFile}`);
  } else {
    console.warn(`\nПредупреждение: файл БД не найден по пути ${absoluteDbPath}, backup пропущен.`);
  }

  // Выполнение миграции
  const result = await prisma.$executeRaw`
    UPDATE GafferContact SET type = 'VENDOR'
    WHERE type = 'TEAM_MEMBER'
      AND (
        roleLabel LIKE '%ентал%'
        OR roleLabel LIKE '%ental%'
      )
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
