#!/usr/bin/env tsx
/**
 * Бэкфилл multi-vehicle: для каждой брони с legacy одиночным транспортом
 * (`Booking.vehicleId != null`) и БЕЗ строк `BookingVehicle` создаёт одну
 * `BookingVehicle` из legacy-колонок.
 *
 * - withGenerator/shiftHours/skipOvertime/kmOutsideMkad/ttkEntry — из
 *   `Booking.vehicle*` колонок.
 * - subtotalRub — из `Booking.transportSubtotalRub` (общая сумма транспорта,
 *   для legacy-брони == сумме единственной машины).
 *
 * Идемпотентен: брони, у которых уже есть BookingVehicle, пропускаются.
 *
 * Использование:
 *   npx tsx apps/api/scripts/backfill-booking-vehicles.ts            # dry-run
 *   npx tsx apps/api/scripts/backfill-booking-vehicles.ts --execute  # запись
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const EXECUTE = process.argv.includes("--execute");

async function main() {
  // Брони с legacy одиночным транспортом
  const candidates = await prisma.booking.findMany({
    where: { vehicleId: { not: null } },
    select: {
      id: true,
      vehicleId: true,
      vehicleWithGenerator: true,
      vehicleShiftHours: true,
      vehicleSkipOvertime: true,
      vehicleKmOutsideMkad: true,
      vehicleTtkEntry: true,
      transportSubtotalRub: true,
      _count: { select: { vehicles: true } },
    },
  });

  let created = 0;
  let skipped = 0;

  for (const b of candidates) {
    if (b._count.vehicles > 0) {
      skipped++;
      continue;
    }
    created++;
    if (EXECUTE) {
      await prisma.bookingVehicle.create({
        data: {
          bookingId: b.id,
          vehicleId: b.vehicleId!,
          withGenerator: b.vehicleWithGenerator,
          shiftHours: b.vehicleShiftHours ?? null,
          skipOvertime: b.vehicleSkipOvertime,
          kmOutsideMkad: b.vehicleKmOutsideMkad ?? null,
          ttkEntry: b.vehicleTtkEntry,
          subtotalRub: b.transportSubtotalRub ?? null,
        },
      });
    }
  }

  const mode = EXECUTE ? "ЗАПИСЬ" : "DRY-RUN (для записи добавьте --execute)";
  console.log(
    `[${mode}] Кандидатов: ${candidates.length}; ` +
      `создано BookingVehicle: ${created}; пропущено (уже есть): ${skipped}`,
  );
}

main()
  .catch((err) => {
    console.error("Ошибка при выполнении скрипта:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
