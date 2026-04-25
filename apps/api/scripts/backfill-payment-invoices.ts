/**
 * Backfill script: для post-cutoff броней (legacyFinance=false) создаёт DRAFT FULL invoice
 * и привязывает к нему существующие Payment без invoiceId.
 *
 * По умолчанию — dry-run. Для записи: --execute
 *
 * ВАЖНО: pre-cutoff брони (legacyFinance=true) НЕ трогаются.
 * Никаких фантомных инвойсов для старых броней.
 *
 * H4: cursor-based pagination по 100 броней за раз.
 * H4: после привязки платежей пересчитывает paidAmount инвойса через recomputeInvoiceStatus.
 */

import "dotenv/config";
import { PrismaClient, Decimal } from "@prisma/client";

const prisma = new PrismaClient();
const CHUNK_SIZE = 100;

async function main() {
  const execute = process.argv.includes("--execute");

  console.log(`\n=== Backfill Payment Invoices (${execute ? "EXECUTE" : "DRY-RUN"}) ===\n`);

  let invoicesCreated = 0;
  let paymentsLinked = 0;
  let skipped = 0;
  let cursor: string | undefined = undefined;

  // H4: cursor-based pagination — обрабатываем по CHUNK_SIZE броней за раз
  while (true) {
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
      take: CHUNK_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
    });

    if (bookings.length === 0) break;

    cursor = bookings[bookings.length - 1].id;

    for (const booking of bookings) {
      const unlinkedPayments = booking.payments;

      if (unlinkedPayments.length === 0) {
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
        console.log(`  → Пересчитать paidAmount инвойса`);
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

        // H4: Пересчитываем paidAmount инвойса на основе привязанных платежей
        const linkedPayments = await tx.payment.findMany({
          where: { invoiceId, voidedAt: null },
          select: { amount: true },
        });
        const paidAmount = linkedPayments
          .reduce((acc, p) => acc.add(new Decimal(p.amount.toString())), new Decimal(0))
          .toDecimalPlaces(2)
          .toString();

        // Определяем новый статус
        const invoiceData = existingInvoice ?? await tx.invoice.findUnique({ where: { id: invoiceId! }, select: { total: true, dueDate: true, issuedAt: true } });
        const total = new Decimal((invoiceData?.total ?? booking.finalAmount).toString());
        const paid = new Decimal(paidAmount);
        let status: "DRAFT" | "ISSUED" | "PARTIAL_PAID" | "PAID" | "OVERDUE" | "VOID";
        if (paid.greaterThanOrEqualTo(total) && total.greaterThan(0)) {
          status = "PAID";
        } else if (paid.greaterThan(0)) {
          status = "PARTIAL_PAID";
        } else if (invoiceData?.dueDate && invoiceData.dueDate.getTime() < Date.now()) {
          status = "OVERDUE";
        } else if (invoiceData?.issuedAt) {
          status = "ISSUED";
        } else {
          status = "DRAFT";
        }

        await tx.invoice.update({
          where: { id: invoiceId! },
          data: { paidAmount, status },
        });

        console.log(`  → paidAmount=${paidAmount}, status=${status}`);
      });
    }

    if (bookings.length < CHUNK_SIZE) break; // последняя страница
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
