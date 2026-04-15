/**
 * Скрипт миграции: RENTAL_ADMIN → WAREHOUSE в таблице AdminUser.
 *
 * Использование:
 *   tsx apps/api/scripts/migrate-adminrole-to-userrole.ts          # dry-run (по умолчанию)
 *   tsx apps/api/scripts/migrate-adminrole-to-userrole.ts --execute # реальное выполнение
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import { prisma } from "../src/prisma";

const isDryRun = !process.argv.includes("--execute");

async function getRoleCounts(): Promise<Array<{ role: string; count: bigint }>> {
  const rows = await prisma.$queryRaw<Array<{ role: string; count: bigint }>>`
    SELECT role, COUNT(*) as count FROM AdminUser GROUP BY role
  `;
  return rows;
}

function formatRoleCounts(rows: Array<{ role: string; count: bigint }>): string {
  if (rows.length === 0) return "  (пусто)";
  return rows.map((r) => `  ${r.role}: ${r.count}`).join("\n");
}

async function main() {
  console.log("=== Миграция AdminRole → UserRole ===");
  console.log(`Режим: ${isDryRun ? "DRY-RUN (без изменений)" : "EXECUTE (реальная запись)"}\n`);

  // Состояние до
  const before = await getRoleCounts();
  console.log("Состояние ДО:");
  console.log(formatRoleCounts(before));

  const rentalAdminCount = before.find((r) => r.role === "RENTAL_ADMIN")?.count ?? 0n;

  if (rentalAdminCount === 0n) {
    console.log("\nНет записей с role=RENTAL_ADMIN — миграция не требуется.");
    await prisma.$disconnect();
    return;
  }

  console.log(`\nНайдено RENTAL_ADMIN: ${rentalAdminCount} — будут заменены на WAREHOUSE.`);

  if (isDryRun) {
    console.log("\nDRY-RUN: изменения НЕ применены. Запустите с флагом --execute для реального применения.");
    await prisma.$disconnect();
    return;
  }

  // Backup БД перед изменениями
  const rawDbPath = process.env.DATABASE_URL?.replace("file:", "") ?? "./dev.db";
  // Prisma resolves DB path relative to schema.prisma directory (prisma/)
  const schemaDir = path.resolve(process.cwd(), "prisma");
  const absoluteDbPath = path.resolve(schemaDir, rawDbPath);
  const backupsDir = path.resolve(process.cwd(), "prisma/backups");
  fs.mkdirSync(backupsDir, { recursive: true });
  const backupFile = path.join(backupsDir, `adminrole-migration-${Date.now()}.db`);

  if (fs.existsSync(absoluteDbPath)) {
    fs.copyFileSync(absoluteDbPath, backupFile);
    console.log(`\nBackup создан: ${backupFile}`);
  } else {
    console.warn(`\nПредупреждение: файл БД не найден по пути ${absoluteDbPath}, backup пропущен.`);
  }

  // Выполнение миграции
  await prisma.$executeRaw`
    UPDATE AdminUser SET role = 'WAREHOUSE' WHERE role = 'RENTAL_ADMIN'
  `;

  // Состояние после
  const after = await getRoleCounts();
  console.log("\nСостояние ПОСЛЕ:");
  console.log(formatRoleCounts(after));

  console.log("\n✅ Миграция завершена успешно.");
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("Ошибка миграции:", err);
  await prisma.$disconnect();
  process.exit(1);
});
