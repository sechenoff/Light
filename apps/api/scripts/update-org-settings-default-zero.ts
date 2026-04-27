#!/usr/bin/env tsx
/**
 * Идемпотентно устанавливает OrganizationSettings.singleton.defaultPaymentTermsDays = 0.
 *
 * Запускать ПЕРЕД backfill-expected-payment-date.ts --reset на prod.
 *
 * Поведение:
 *   - Если запись отсутствует — создаёт upsert с defaultPaymentTermsDays=0.
 *   - Если уже = 0 — выводит «уже 0, no-op» и завершается с exit 0.
 *   - Dry-run по умолчанию. Флаг --execute для реальной записи.
 *
 * НЕ пишет AuditEntry (OrganizationSettings — не бизнес-сущность,
 * AuditEntityType не имеет "OrganizationSettings").
 *
 * Использование:
 *   npx tsx apps/api/scripts/update-org-settings-default-zero.ts            # dry-run
 *   npx tsx apps/api/scripts/update-org-settings-default-zero.ts --execute  # запись
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const isDryRun = !process.argv.includes("--execute");
const prisma = new PrismaClient();

async function main() {
  console.log(`Режим: ${isDryRun ? "DRY-RUN (запись отключена)" : "EXECUTE (запись включена)"}`);

  const existing = await prisma.organizationSettings.findUnique({
    where: { id: "singleton" },
    select: { id: true, defaultPaymentTermsDays: true },
  });

  const currentValue = existing?.defaultPaymentTermsDays ?? null;
  console.log(`Текущее значение defaultPaymentTermsDays: ${currentValue === null ? "(запись отсутствует)" : currentValue}`);

  if (currentValue === 0) {
    console.log("уже 0, no-op");
    await prisma.$disconnect();
    process.exit(0);
  }

  if (isDryRun) {
    console.log(`[dry-run] ${currentValue === null ? "создать" : "обновить"} singleton: previous=${currentValue} → new=0`);
  } else {
    await prisma.organizationSettings.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", defaultPaymentTermsDays: 0 },
      update: { defaultPaymentTermsDays: 0 },
    });
    console.log(`previous: ${currentValue} → new: 0`);
    console.log("OrganizationSettings.singleton.defaultPaymentTermsDays успешно обновлено до 0.");
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
