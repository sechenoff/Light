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

const CHUNK_SIZE = 500;

async function main() {
  const now = new Date();

  // D2 defense-in-depth: ensure _system_ AdminUser exists before writing any audit entries.
  // deploy.sh calls seed-system-user.ts, but this handles rolling deploys where it hasn't run yet.
  await prisma.adminUser.upsert({
    where: { id: "_system_" },
    create: { id: "_system_", username: "_system_", passwordHash: "!disabled", role: "SUPER_ADMIN" },
    update: {},
  });

  // M2: cursor-based pagination, chunk size 500 — avoids large findMany on big DBs
  let cursor: string | undefined;
  let totalCandidates = 0;
  let changedCount = 0;

  console.log(`[recompute-overdue] Запуск: ${now.toISOString()}`);

  while (true) {
    const candidates = await prisma.invoice.findMany({
      where: {
        status: { in: ["ISSUED", "PARTIAL_PAID"] },
        dueDate: { lt: now },
        voidedAt: null,
      },
      select: { id: true, number: true, status: true },
      take: CHUNK_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
    });

    if (candidates.length === 0) break;

    totalCandidates += candidates.length;
    cursor = candidates[candidates.length - 1].id;

    for (const inv of candidates) {
      const before = inv.status;
      const updated = await recomputeInvoiceStatus(inv.id);
      if (updated && updated.status !== before) {
        changedCount++;
        console.log(`  Счёт ${inv.number}: ${before} → ${updated.status}`);

        // Запись в аудит-лог (без userId — системный вызов, используем "system")
        // T3: "_system_" AdminUser is seeded by seed-system-user.ts (run in deploy.sh).
        // If for any reason the row is missing, audit write fails silently — cron continues.
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
        } catch (auditErr) {
          console.warn(`  [recompute-overdue] Аудит не записан для счёта ${inv.number}:`, auditErr);
        }
      }
    }

    // If fewer than CHUNK_SIZE returned, we've processed all
    if (candidates.length < CHUNK_SIZE) break;
  }

  console.log(`[recompute-overdue] Изменено статусов: ${changedCount} из ${totalCandidates}`);
}

main()
  .catch((err) => {
    console.error("[recompute-overdue] Ошибка:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
