/**
 * Backfill script: устанавливает Booking.legacyFinance на основе OrganizationSettings.migrationCutoffAt.
 *
 * По умолчанию — dry-run (только лог). Для записи: --execute
 *
 * Логика:
 *   createdAt < cutoff  → legacyFinance = true  (старая логика, Payment напрямую)
 *   createdAt >= cutoff → legacyFinance = false (Invoice-слой)
 *
 * Идемпотентен: можно запускать повторно с новым cutoff.
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const execute = process.argv.includes("--execute");

  console.log(`\n=== Backfill Finance Cutoff (${execute ? "EXECUTE" : "DRY-RUN"}) ===\n`);

  // Получаем cutoff из OrganizationSettings (синглтон)
  const settings = await prisma.organizationSettings.findUnique({ where: { id: "singleton" } });
  const cutoff = settings?.migrationCutoffAt ?? new Date(0); // если нет настроек — все legacy

  console.log(`Cutoff дата: ${cutoff.toISOString()}`);

  const [legacyCount, postCutoffCount, totalCount] = await Promise.all([
    prisma.booking.count({ where: { createdAt: { lt: cutoff } } }),
    prisma.booking.count({ where: { createdAt: { gte: cutoff } } }),
    prisma.booking.count(),
  ]);

  console.log(`Всего броней: ${totalCount}`);
  console.log(`До cutoff (legacyFinance=true): ${legacyCount}`);
  console.log(`После cutoff (legacyFinance=false): ${postCutoffCount}`);

  if (!execute) {
    console.log("\nDry-run: никаких изменений не сделано. Запустите с --execute для записи.\n");
    return;
  }

  console.log("\nОбновляем брони...");

  // H4: updateMany уже атомарна и не нагружает память — чанкинг не нужен для bulk-update.
  // Для findMany-based операций используется cursor pagination (см. backfill-payment-invoices.ts).

  // Устанавливаем legacyFinance=true для pre-cutoff броней
  const legacyResult = await prisma.booking.updateMany({
    where: { createdAt: { lt: cutoff } },
    data: { legacyFinance: true },
  });

  // Устанавливаем legacyFinance=false для post-cutoff броней
  const postResult = await prisma.booking.updateMany({
    where: { createdAt: { gte: cutoff } },
    data: { legacyFinance: false },
  });

  console.log(`Помечено как legacy (true): ${legacyResult.count}`);
  console.log(`Помечено как post-cutoff (false): ${postResult.count}`);
  console.log("\nГотово.\n");
}

main()
  .catch((err) => {
    console.error("Ошибка:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
