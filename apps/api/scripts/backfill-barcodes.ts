#!/usr/bin/env tsx
/**
 * Заполняет штрихкоды для EquipmentUnit, у которых barcode IS NULL.
 * Обрабатывает только юниты оборудования с stockTrackingMode === "UNIT".
 *
 * Идемпотентен: пропускает юниты, у которых barcode уже задан.
 *
 * Использование:
 *   npx tsx apps/api/scripts/backfill-barcodes.ts
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { generateBarcodeId, generateBarcodePayload } from "../src/services/barcode";

if (!process.env.BARCODE_SECRET) {
  console.error("Ошибка: переменная окружения BARCODE_SECRET не задана.");
  process.exit(1);
}

const prisma = new PrismaClient();

async function main() {
  // Загружаем все UNIT-оборудование с его юнитами без штрихкода
  const equipments = await prisma.equipment.findMany({
    where: { stockTrackingMode: "UNIT" },
    select: {
      id: true,
      name: true,
      category: true,
      units: {
        select: { id: true, barcode: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  let updatedCount = 0;
  let skippedCount = 0;

  const allUpdates: Array<() => Promise<unknown>> = [];

  for (const equipment of equipments) {
    // Определяем максимальный существующий порядковый номер из barcode
    let maxSeq = 0;
    for (const unit of equipment.units) {
      if (!unit.barcode) continue;
      // Формат: LR-ABBREV-NNN (последний сегмент — порядковый номер)
      const parts = unit.barcode.split("-");
      const seqStr = parts[parts.length - 1];
      const seq = parseInt(seqStr, 10);
      if (!isNaN(seq) && seq > maxSeq) {
        maxSeq = seq;
      }
    }

    // Только юниты без штрихкода
    const unitsWithoutBarcode = equipment.units.filter((u) => !u.barcode);

    if (unitsWithoutBarcode.length === 0) {
      skippedCount += equipment.units.length;
      continue;
    }

    skippedCount += equipment.units.length - unitsWithoutBarcode.length;

    for (let i = 0; i < unitsWithoutBarcode.length; i++) {
      const unit = unitsWithoutBarcode[i];
      const seqNum = maxSeq + i + 1;
      const barcode = generateBarcodeId(equipment.name, equipment.category, seqNum);
      const barcodePayload = generateBarcodePayload(unit.id);

      allUpdates.push(() =>
        prisma.equipmentUnit.update({
          where: { id: unit.id },
          data: { barcode, barcodePayload },
        }),
      );
      updatedCount++;
    }
  }

  // Применяем обновления в транзакции
  if (allUpdates.length > 0) {
    await prisma.$transaction(allUpdates.map((fn) => fn()));
  }

  console.log(`Обновлено ${updatedCount} юнитов, пропущено ${skippedCount}`);
}

main()
  .catch((err) => {
    console.error("Ошибка при выполнении скрипта:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
