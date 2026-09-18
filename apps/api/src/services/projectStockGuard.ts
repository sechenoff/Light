import type { Prisma } from "@prisma/client";
import { HttpError } from "../utils/errors";
import {
  getLostCountByEquipmentMap,
  getRepairCountByEquipmentMap,
} from "./availability";

/** The ordinary issue paths must not hand out stock physically held by a project,
 * including overdue project lots and the explicit conflict-override workflow. */
export async function assertProjectStockForBooking(
  tx: Prisma.TransactionClient,
  bookingId: string,
  replacements: Array<{ equipmentId: string; quantity: number }> = [],
  scannedUnitIds: string[] = [],
) {
  const items = await tx.bookingItem.findMany({
    where: { bookingId },
    include: {
      equipment: true,
      unitReservations: { where: { returnedAt: null } },
    },
  });
  const requested = new Map(
    items.filter((i) => i.equipmentId).map((i) => [i.equipmentId!, i.quantity]),
  );
  for (const item of replacements)
    requested.set(item.equipmentId, item.quantity);
  const unitIds = [
    ...scannedUnitIds,
    ...items.flatMap((i) => i.unitReservations.map((r) => r.equipmentUnitId)),
  ];
  if (
    unitIds.length &&
    (await tx.projectLotUnit.count({
      where: {
        equipmentUnitId: { in: unitIds },
        returnedAt: null,
        lot: { status: "ISSUED" },
      },
    }))
  )
    throw new HttpError(
      409,
      "Экземпляр находится у клиента по длинному проекту",
      "PROJECT_STOCK_CONFLICT",
    );
  const lots = await tx.projectLot.findMany({
    where: {
      equipmentId: { in: [...requested.keys()] },
      status: "ISSUED",
      equipment: { stockTrackingMode: "COUNT" },
    },
    include: { returns: true, equipment: true },
  });
  for (const equipmentId of new Set(lots.map((l) => l.equipmentId))) {
    const held = lots.filter((l) => l.equipmentId === equipmentId);
    const projectQty = held.reduce(
      (sum, l) =>
        sum + l.quantity - l.returns.reduce((s, r) => s + r.quantity, 0),
      0,
    );
    if (!projectQty) continue;
    const other = await tx.bookingItem.aggregate({
      where: {
        equipmentId,
        bookingId: { not: bookingId },
        booking: { mode: "STANDARD", status: "ISSUED" },
      },
      _sum: { quantity: true },
    });
    const lost =
      (await getLostCountByEquipmentMap([equipmentId], tx)).get(equipmentId) ??
      0;
    const repair =
      (await getRepairCountByEquipmentMap([equipmentId], tx)).get(
        equipmentId,
      ) ?? 0;
    if (
      (requested.get(equipmentId) ?? 0) +
        projectQty +
        (other._sum.quantity ?? 0) +
        lost +
        repair >
      held[0].equipment.totalQuantity
    )
      throw new HttpError(
        409,
        `«${held[0].equipment.name}»: часть оборудования находится у клиента по длинному проекту`,
        "PROJECT_STOCK_CONFLICT",
      );
  }
}
