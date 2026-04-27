#!/usr/bin/env tsx
/**
 * Заполняет expectedPaymentDate для броней, у которых это поле пустое.
 *
 * Логика:
 *   1. Читает OrganizationSettings.defaultPaymentTermsDays (default 7 если запись отсутствует).
 *   2. Находит все брони: expectedPaymentDate IS NULL, endDate NOT NULL, status ≠ CANCELLED.
 *   3. Для каждой: expectedPaymentDate = endDate + N дней (по московскому времени).
 *   4. Сухой прогон по умолчанию (dry-run). Флаг --execute для записи.
 *   5. Без аудит-записи (системная миграция).
 *
 * Использование:
 *   npx tsx apps/api/scripts/backfill-expected-payment-date.ts            # dry-run
 *   npx tsx apps/api/scripts/backfill-expected-payment-date.ts --execute  # запись
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const isDryRun = !process.argv.includes("--execute");

const prisma = new PrismaClient();

function toMoscowDateString(d: Date): string {
  return d.toLocaleString("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function fromMoscowDateString(s: string): Date {
  return new Date(`${s}T00:00:00+03:00`);
}

async function main() {
  const settings = await prisma.organizationSettings.findUnique({ where: { id: "singleton" } });
  const days = settings?.defaultPaymentTermsDays ?? 7;

  console.log(`Режим: ${isDryRun ? "DRY-RUN (запись отключена)" : "EXECUTE (запись включена)"}`);
  console.log(`Срок оплаты: ${days} дн. после возврата`);

  const bookings = await prisma.booking.findMany({
    where: {
      expectedPaymentDate: null,
      status: { not: "CANCELLED" },
    },
    select: { id: true, endDate: true },
  });

  console.log(`Найдено броней без даты оплаты: ${bookings.length}`);

  let updatedCount = 0;

  for (const booking of bookings) {
    const endMoscow = toMoscowDateString(booking.endDate);
    const endMoscowMidnight = fromMoscowDateString(endMoscow);
    const paymentDate = new Date(endMoscowMidnight.getTime() + days * 24 * 60 * 60 * 1000);
    const paymentDateStr = toMoscowDateString(paymentDate);

    if (isDryRun) {
      console.log(`  [dry-run] ${booking.id}: endDate=${endMoscow} → expectedPaymentDate=${paymentDateStr}`);
    } else {
      await prisma.booking.update({
        where: { id: booking.id },
        data: { expectedPaymentDate: paymentDate },
      });
      console.log(`  [обновлено] ${booking.id}: expectedPaymentDate=${paymentDateStr}`);
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
