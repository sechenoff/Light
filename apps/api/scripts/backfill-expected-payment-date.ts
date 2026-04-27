#!/usr/bin/env tsx
/**
 * Заполняет / перезаписывает expectedPaymentDate для броней.
 *
 * Логика (без --reset):
 *   1. Читает OrganizationSettings.defaultPaymentTermsDays (default 0 если запись отсутствует).
 *   2. Находит все брони: expectedPaymentDate IS NULL, endDate NOT NULL, status ≠ CANCELLED.
 *   3. Для каждой: expectedPaymentDate = endDate + N дней (по московскому времени).
 *   4. Сухой прогон по умолчанию (dry-run). Флаг --execute для записи.
 *   5. Без аудит-записи (системная миграция).
 *
 * Логика (с --reset):
 *   Ищет ВСЕ брони с endDate NOT NULL и status в (CONFIRMED/ISSUED/RETURNED),
 *   независимо от текущего expectedPaymentDate, и перезаписывает на endDate + N дней.
 *
 * Использование:
 *   npx tsx apps/api/scripts/backfill-expected-payment-date.ts            # dry-run (только NULL)
 *   npx tsx apps/api/scripts/backfill-expected-payment-date.ts --execute  # запись (только NULL)
 *   npx tsx apps/api/scripts/backfill-expected-payment-date.ts --reset              # dry-run + перезаписать все
 *   npx tsx apps/api/scripts/backfill-expected-payment-date.ts --reset --execute    # запись + перезаписать все
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { toMoscowDateString, fromMoscowDateString } from "../src/utils/moscowDate";

const isDryRun = !process.argv.includes("--execute");
const isReset = process.argv.includes("--reset");

const prisma = new PrismaClient();

async function main() {
  const settings = await prisma.organizationSettings.findUnique({ where: { id: "singleton" } });
  const days = settings?.defaultPaymentTermsDays ?? 0;

  const modeLabel = [
    isDryRun ? "DRY-RUN" : "EXECUTE",
    isReset ? "RESET" : null,
  ].filter(Boolean).join(" + ");

  console.log(`Режим: ${modeLabel}${isDryRun ? " (запись отключена)" : " (запись включена)"}`);
  console.log(`Срок оплаты: ${days} дн. после возврата (0 = в день возврата)`);

  const whereClause = isReset
    ? {
        endDate: { not: null },
        status: { in: ["CONFIRMED" as const, "ISSUED" as const, "RETURNED" as const] },
      }
    : {
        expectedPaymentDate: null,
        status: { in: ["CONFIRMED" as const, "ISSUED" as const, "RETURNED" as const] },
      };

  const bookings = await prisma.booking.findMany({
    where: whereClause,
    select: { id: true, endDate: true, expectedPaymentDate: true },
  });

  console.log(`Найдено броней${isReset ? "" : " без даты оплаты"}: ${bookings.length}`);

  let updatedCount = 0;

  for (const booking of bookings) {
    if (!booking.endDate) continue;

    const endMoscow = toMoscowDateString(booking.endDate);
    const endMoscowMidnight = fromMoscowDateString(endMoscow);
    const paymentDate = new Date(endMoscowMidnight.getTime() + days * 24 * 60 * 60 * 1000);
    const paymentDateStr = toMoscowDateString(paymentDate);

    const prevStr = booking.expectedPaymentDate
      ? toMoscowDateString(booking.expectedPaymentDate)
      : "null";

    if (isDryRun) {
      if (isReset) {
        console.log(`  [dry-run] ${booking.id}: ${prevStr} → ${paymentDateStr}`);
      } else {
        console.log(`  [dry-run] ${booking.id}: endDate=${endMoscow} → expectedPaymentDate=${paymentDateStr}`);
      }
    } else {
      await prisma.booking.update({
        where: { id: booking.id },
        data: { expectedPaymentDate: paymentDate },
      });
      if (isReset) {
        console.log(`  [обновлено] ${booking.id}: ${prevStr} → ${paymentDateStr}`);
      } else {
        console.log(`  [обновлено] ${booking.id}: expectedPaymentDate=${paymentDateStr}`);
      }
    }
    updatedCount++;
  }

  console.log(`\nИтого: ${isDryRun ? "будет обновлено" : "обновлено"} ${updatedCount} броней`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
