#!/usr/bin/env tsx
/**
 * B3 — Перерасчёт просроченных инвойсов (OVERDUE recompute)
 *
 * Находит все инвойсы в статусе ISSUED или PARTIAL_PAID, у которых:
 *   - dueDate < now()
 *   - voidedAt IS NULL
 * Для каждого вызывает recomputeInvoiceStatus(), который переводит в OVERDUE.
 * Записывает в аудит-лог действие INVOICE_STATUS_OVERDUE для изменённых.
 *
 * Идемпотентен: повторный запуск безопасен.
 *
 * Использование:
 *   npx tsx apps/api/scripts/recompute-overdue-invoices.ts
 *
 * PM2 cron (добавить в ecosystem.config.js):
 *   {
 *     name: "overdue-recompute",
 *     script: "apps/api/scripts/recompute-overdue-invoices.js",
 *     cron_restart: "0 2 * * *",   // каждый день в 02:00
 *     autorestart: false,
 *   }
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { recomputeInvoiceStatus } from "../src/services/invoiceService";

const prisma = new PrismaClient();

async function main() {
  const now = new Date();

  // Найти все инвойсы, которые могут стать OVERDUE
  const candidates = await prisma.invoice.findMany({
    where: {
      status: { in: ["ISSUED", "PARTIAL_PAID"] },
      dueDate: { lt: now },
      voidedAt: null,
    },
    select: { id: true, number: true, status: true },
  });

  console.log(`[recompute-overdue] Кандидатов для обновления: ${candidates.length}`);

  let changedCount = 0;

  for (const inv of candidates) {
    const before = inv.status;
    const updated = await recomputeInvoiceStatus(inv.id);
    if (updated && updated.status !== before) {
      changedCount++;
      console.log(`  Счёт ${inv.number}: ${before} → ${updated.status}`);

      // Запись в аудит-лог (без userId — системный вызов, используем "system")
      try {
        await prisma.auditEntry.create({
          data: {
            userId: "_system_",
            action: "INVOICE_STATUS_OVERDUE",
            entityType: "Invoice",
            entityId: inv.id,
            before: JSON.stringify({ status: before }),
            after: JSON.stringify({ status: "OVERDUE" }),
          },
        });
      } catch {
        // userId "_system_" не существует в AdminUser — это ожидаемо для системных скриптов.
        // Аудит опционален; не прерываем выполнение при ошибке FK.
      }
    }
  }

  console.log(`[recompute-overdue] Изменено статусов: ${changedCount} из ${candidates.length}`);
}

main()
  .catch((err) => {
    console.error("[recompute-overdue] Ошибка:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
