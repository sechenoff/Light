import type { Prisma } from "@prisma/client";
import { currentAuditActor } from "./auditContext";
import { writeAuditEntry } from "./audit";

export async function bookingAuditSnapshot(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<Record<string, unknown>> {
  const b = await tx.booking.findUniqueOrThrow({
    where: { id },
    include: {
      client: { select: { name: true } },
      items: { include: { equipment: { select: { name: true } } } },
      vehicles: { include: { vehicle: { select: { name: true } } } },
    },
  });
  const fields = [
    "projectName",
    "status",
    "startDate",
    "endDate",
    "comment",
    "discountPercent",
    "expectedPaymentDate",
    "paymentForm",
    "cashlessSurchargePercent",
    "manualFinalAmount",
    "skipPartialDay",
    "estimateOptionalNote",
    "estimateIncludeOptionalInExport",
  ] as const;
  const result: Record<string, unknown> = { clientName: b.client.name };
  for (const key of fields) result[key] = b[key];
  // Запись по каждой позиции позволяет показать только изменившиеся строки.
  const items: Record<string, unknown> = {};
  const occurrences = new Map<string, number>();
  for (const item of b.items) {
    const name =
      item.equipment?.name ?? item.customName ?? "Позиция без названия";
    const occurrence = (occurrences.get(name) ?? 0) + 1;
    occurrences.set(name, occurrence);
    const key = name + (occurrence > 1 ? ` (${occurrence})` : "");
    items[key] = {
      quantity: item.quantity,
      customUnitPrice: item.customUnitPrice?.toString() ?? null,
      negotiatedRatePerShift: item.negotiatedRatePerShift?.toString() ?? null,
    };
  }
  result.itemsDetails = Object.fromEntries(
    Object.entries(items).sort(([a], [b]) => a.localeCompare(b)),
  );
  result.transportDetails = Object.fromEntries(
    [...b.vehicles]
      .sort((a, b) => a.vehicle.name.localeCompare(b.vehicle.name))
      .map((v) => [
        v.vehicle.name,
        {
          subtotalRub: v.subtotalRub?.toString() ?? null,
          negotiatedTotalRub: v.negotiatedTotalRub?.toString() ?? null,
          driverName: v.driverName,
          driverPhone: v.driverPhone,
          shiftHours: v.shiftHours?.toString() ?? null,
          kmOutsideMkad: v.kmOutsideMkad,
          withGenerator: v.withGenerator,
          skipOvertime: v.skipOvertime,
          ttkEntry: v.ttkEntry,
        },
      ]),
  );
  return JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
}

export async function recordBookingCreated(
  tx: Prisma.TransactionClient,
  id: string,
  action = "BOOKING_CREATE",
) {
  const actor = currentAuditActor();
  if (!actor) return; // Фоновые/ботовые вызовы не приписываем чужому аккаунту.
  const after = await bookingAuditSnapshot(tx, id);
  // Сохраняем контракт существующего события быстрой брони.
  if (action === "BOOKING_QUICK_CREATE")
    after.amount = Number(after.manualFinalAmount ?? 0);
  await writeAuditEntry({
    tx,
    userId: actor.id,
    action,
    entityType: "Booking",
    entityId: id,
    maxSnapshotBytes: 2 * 1024 * 1024,
    before: null,
    after,
  });
}
