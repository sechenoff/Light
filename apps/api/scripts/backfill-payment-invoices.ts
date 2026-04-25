/**
 * Backfill script: для post-cutoff броней (legacyFinance=false) создаёт DRAFT FULL invoice
 * и привязывает к нему существующие Payment без invoiceId.
 *
 * По умолчанию — dry-run. Для записи: --execute
 *
 * ВАЖНО: pre-cutoff брони (legacyFinance=true) НЕ трогаются.
 * Никаких фантомных инвойсов для старых броней.
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const execute = process.argv.includes("--execute");

  console.log(`\n=== Backfill Payment Invoices (${execute ? "EXECUTE" : "DRY-RUN"}) ===\n`);

  // Только post-cutoff брони
  const bookings = await prisma.booking.findMany({
    where: { legacyFinance: false },
    include: {
      payments: {
        where: { invoiceId: null, direction: "INCOME" },
      },
      invoices: {
        where: { kind: "FULL", status: { not: "VOID" } },
      },
    },
  });

  console.log(`Post-cutoff броней: ${bookings.length}`);
  let invoicesCreated = 0;
  let paymentsLinked = 0;
  let skipped = 0;

  for (const booking of bookings) {
    const unlinkedPayments = booking.payments;

    if (unlinkedPayments.length === 0) {
      // Нет несвязанных платежей — пропускаем
      skipped++;
      continue;
    }

    console.log(`\nБронь ${booking.id} (${booking.projectName}): ${unlinkedPayments.length} несвязанных платёж(ей)`);

    // Ищем существующий FULL invoice
    const existingInvoice = booking.invoices.find((inv) => inv.kind === "FULL");

    if (!execute) {
      if (existingInvoice) {
        console.log(`  → Использовать существующий FULL invoice: ${existingInvoice.id}`);
      } else {
        console.log(`  → Создать новый DRAFT FULL invoice`);
      }
      console.log(`  → Привязать ${unlinkedPayments.length} платёж(ей)`);
      paymentsLinked += unlinkedPayments.length;
      if (!existingInvoice) invoicesCreated++;
      continue;
    }

    await prisma.$transaction(async (tx) => {
      let invoiceId = existingInvoice?.id;

      if (!invoiceId) {
        // Создаём DRAFT FULL invoice с временным номером
        const invoice = await tx.invoice.create({
          data: {
            number: `BACKFILL-${booking.id.slice(0, 8)}-${Date.now()}`,
            bookingId: booking.id,
            kind: "FULL",
            status: "DRAFT",
            total: booking.finalAmount.toString(),
            paidAmount: "0",
            createdBy: "SYSTEM_BACKFILL",
          },
        });
        invoiceId = invoice.id;
        invoicesCreated++;
        console.log(`  + Создан DRAFT FULL invoice ${invoiceId}`);
      } else {
        console.log(`  = Используем существующий invoice ${invoiceId}`);
      }

      // Привязываем платежи
      for (const payment of unlinkedPayments) {
        await tx.payment.update({
          where: { id: payment.id },
          data: { invoiceId },
        });
        paymentsLinked++;
        console.log(`  → Платёж ${payment.id} привязан к ${invoiceId}`);
      }
    });
  }

  console.log(`\n=== Итог ===`);
  console.log(`Broker пропущено (нет несвязанных платежей): ${skipped}`);
  console.log(`Invoice создано: ${invoicesCreated}`);
  console.log(`Платежей привязано: ${paymentsLinked}`);

  if (!execute) {
    console.log("\nDry-run: никаких изменений не сделано. Запустите с --execute для записи.\n");
  } else {
    console.log("\nГотово.\n");
  }
}

main()
  .catch((err) => {
    console.error("Ошибка:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
