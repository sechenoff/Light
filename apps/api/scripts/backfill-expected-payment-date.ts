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
 * Логика (с --reset --previous-default N):
 *   Ищет ВСЕ брони с endDate NOT NULL и status в (CONFIRMED/ISSUED/RETURNED).
 *   Эвристика «вручную выставлено»: если |expectedPaymentDate − endDate+N*86400s| >= 1 час —
 *   считается user-set и пропускается. Брони с NULL expectedPaymentDate заполняются всегда.
 *   Аудит: BOOKING_UPDATE per booking внутри prisma.$transaction.
 *
 * Флаги:
 *   --execute                   реальная запись (по умолчанию dry-run)
 *   --reset                     режим перезаписи (требует --previous-default N)
 *   --previous-default N        целое 0–90: старый defaultPaymentTermsDays (обязателен с --reset)
 *   --force-all                 отключить эвристику (требует --reset --execute + интерактивного ввода YES)
 *
 * Примеры:
 *   npx tsx apps/api/scripts/backfill-expected-payment-date.ts
 *   npx tsx apps/api/scripts/backfill-expected-payment-date.ts --execute
 *   npx tsx apps/api/scripts/backfill-expected-payment-date.ts --reset --previous-default 7
 *   npx tsx apps/api/scripts/backfill-expected-payment-date.ts --reset --previous-default 7 --execute
 *   npx tsx apps/api/scripts/backfill-expected-payment-date.ts --reset --previous-default 7 --execute --force-all
 */

import "dotenv/config";
import * as readline from "readline";
import { PrismaClient } from "@prisma/client";
import { toMoscowDateString, fromMoscowDateString } from "../src/utils/moscowDate";
import { writeAuditEntry } from "../src/services/audit";

const args = process.argv.slice(2);
const isDryRun = !args.includes("--execute");
const isReset = args.includes("--reset");
const isForceAll = args.includes("--force-all");

// Parse --previous-default N
let previousDefault: number | null = null;
const pdIdx = args.indexOf("--previous-default");
if (pdIdx !== -1) {
  const raw = args[pdIdx + 1];
  const parsed = parseInt(raw ?? "", 10);
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 90) {
    console.error(`Ошибка: --previous-default должен быть целым числом 0–90, получено: ${raw}`);
    process.exit(1);
  }
  previousDefault = parsed;
}

// Validate flag combinations
if (isReset && previousDefault === null) {
  console.error(
    "Ошибка: --reset требует обязательного флага --previous-default N (старое значение defaultPaymentTermsDays).\n" +
    "Пример: --reset --previous-default 7",
  );
  process.exit(1);
}

if (isForceAll && (!isReset || isDryRun)) {
  console.error("Ошибка: --force-all требует комбинации --reset --execute.");
  process.exit(1);
}

const ONE_HOUR_MS = 60 * 60 * 1000;

const prisma = new PrismaClient();

/**
 * Проверяет, является ли expectedPaymentDate автоматически вычисленным
 * (т.е. совпадает с endDate + previousDefault дней с точностью до 1 часа).
 */
function isAutoDefaulted(
  expectedPaymentDate: Date,
  endDate: Date,
  prevDefault: number,
): boolean {
  const endMoscow = toMoscowDateString(endDate);
  const endMoscowMidnight = fromMoscowDateString(endMoscow);
  const expectedAuto = new Date(endMoscowMidnight.getTime() + prevDefault * 24 * 60 * 60 * 1000);
  return Math.abs(expectedPaymentDate.getTime() - expectedAuto.getTime()) < ONE_HOUR_MS;
}

async function askConfirmation(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.error("Ошибка: --force-all требует интерактивного терминала (stdin не является TTY).");
    process.exit(1);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim() === "YES");
    });
  });
}

async function main() {
  const settings = await prisma.organizationSettings.findUnique({ where: { id: "singleton" } });
  const days = settings?.defaultPaymentTermsDays ?? 0;

  const modeLabel = [
    isDryRun ? "DRY-RUN" : "EXECUTE",
    isReset ? "RESET" : null,
    isForceAll ? "FORCE-ALL" : null,
  ].filter(Boolean).join(" + ");

  console.log(`Режим: ${modeLabel}${isDryRun ? " (запись отключена)" : " (запись включена)"}`);
  console.log(`Новый срок оплаты: ${days} дн. после возврата (0 = в день возврата)`);
  if (isReset && previousDefault !== null) {
    console.log(`Старый срок оплаты: ${previousDefault} дн. (эвристика user-set)`);
  }

  if (isForceAll && !isDryRun) {
    console.warn("\n[ВНИМАНИЕ] --force-all отключает эвристику и перезапишет ВСЕ брони,");
    console.warn("включая те, где срок был выставлен вручную. Это необратимо.\n");
    const confirmed = await askConfirmation("Введите 'YES' для подтверждения слепой перезаписи: ");
    if (!confirmed) {
      console.log("Отменено пользователем.");
      process.exit(0);
    }
  }

  if (isReset) {
    await runReset(days);
  } else {
    await runFill(days);
  }

  await prisma.$disconnect();
}

async function runFill(days: number) {
  const bookings = await prisma.booking.findMany({
    where: {
      expectedPaymentDate: null,
      status: { in: ["CONFIRMED", "ISSUED", "RETURNED"] },
    },
    select: { id: true, endDate: true, expectedPaymentDate: true },
  });

  console.log(`\nНайдено броней без даты оплаты: ${bookings.length}`);

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
}

async function runReset(days: number) {
  if (previousDefault === null) throw new Error("previousDefault не задан");

  const bookings = await prisma.booking.findMany({
    where: {
      status: { in: ["CONFIRMED", "ISSUED", "RETURNED"] },
    },
    select: { id: true, endDate: true, expectedPaymentDate: true },
  });

  // Classify each booking
  type Classified = {
    id: string;
    endDate: Date;
    expectedPaymentDate: Date | null;
    newPaymentDate: Date;
    action: "update" | "skip" | "fill";
  };

  const classified: Classified[] = [];

  for (const booking of bookings) {
    const endMoscow = toMoscowDateString(booking.endDate);
    const endMoscowMidnight = fromMoscowDateString(endMoscow);
    const newPaymentDate = new Date(endMoscowMidnight.getTime() + days * 24 * 60 * 60 * 1000);

    let action: "update" | "skip" | "fill";
    if (booking.expectedPaymentDate === null) {
      action = "fill";
    } else if (isForceAll || isAutoDefaulted(booking.expectedPaymentDate, booking.endDate, previousDefault)) {
      action = "update";
    } else {
      action = "skip";
    }

    classified.push({
      id: booking.id,
      endDate: booking.endDate,
      expectedPaymentDate: booking.expectedPaymentDate,
      newPaymentDate,
      action,
    });
  }

  const toUpdate = classified.filter((b) => b.action === "update");
  const toSkip = classified.filter((b) => b.action === "skip");
  const toFill = classified.filter((b) => b.action === "fill");

  console.log(`\nК обновлению (auto-defaulted): ${toUpdate.length} бр.`);
  console.log(`Будет пропущено (user-set):     ${toSkip.length} бр.`);
  console.log(`Пусто (NULL → fill):            ${toFill.length} бр.`);

  // Log skipped user-set bookings
  for (const b of toSkip) {
    const prevStr = b.expectedPaymentDate ? toMoscowDateString(b.expectedPaymentDate) : "null";
    console.log(`  [SKIP user-set] ${b.id}: ${prevStr} (≠ endDate+${previousDefault}d)`);
  }

  if (isDryRun) {
    for (const b of [...toUpdate, ...toFill]) {
      const prevStr = b.expectedPaymentDate ? toMoscowDateString(b.expectedPaymentDate) : "null";
      const newStr = toMoscowDateString(b.newPaymentDate);
      console.log(`  [dry-run] ${b.id}: ${prevStr} → ${newStr}`);
    }
    console.log(`\nИтого: будет обновлено ${toUpdate.length + toFill.length} броней, пропущено ${toSkip.length}`);
    return;
  }

  // Execute updates with audit
  let updatedCount = 0;
  for (const b of [...toUpdate, ...toFill]) {
    const prevStr = b.expectedPaymentDate ? b.expectedPaymentDate.toISOString() : null;
    const newStr = b.newPaymentDate.toISOString();

    await prisma.$transaction(async (tx) => {
      await tx.booking.update({
        where: { id: b.id },
        data: { expectedPaymentDate: b.newPaymentDate },
      });
      await writeAuditEntry({
        tx,
        userId: "_system_",
        action: "BOOKING_UPDATE",
        entityType: "Booking",
        entityId: b.id,
        before: { expectedPaymentDate: prevStr },
        after: {
          expectedPaymentDate: newStr,
          source: "backfill-reset",
          previousDefault: previousDefault,
        },
      });
    });

    const prevDisplay = b.expectedPaymentDate ? toMoscowDateString(b.expectedPaymentDate) : "null";
    const newDisplay = toMoscowDateString(b.newPaymentDate);
    console.log(`  [обновлено] ${b.id}: ${prevDisplay} → ${newDisplay}`);
    updatedCount++;
  }

  console.log(`\nИтого: обновлено ${updatedCount} броней, пропущено ${toSkip.length} (user-set)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
