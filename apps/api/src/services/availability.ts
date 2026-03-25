import type { Equipment, BookingStatus } from "@prisma/client";

import { prisma } from "../prisma";
import { getMergedCategoryOrder } from "./categoryOrder";
import { compareEquipmentTransportLast } from "../utils/equipmentSort";

type TxClient = Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">;

export type AvailabilityRow = {
  equipment: Pick<
    Equipment,
    | "id"
    | "category"
    | "name"
    | "brand"
    | "model"
    | "stockTrackingMode"
    | "sortOrder"
    | "totalQuantity"
    | "rentalRatePerShift"
    | "comment"
  >;
  occupiedQuantity: number;
  availableQuantity: number;
};

const BLOCKING_STATUSES: BookingStatus[] = ["CONFIRMED", "ISSUED"];

function clampNonNegative(n: number) {
  return n < 0 ? 0 : n;
}

export async function getAvailability(args: {
  startDate: Date;
  endDate: Date;
  equipmentIds?: string[];
  search?: string;
  category?: string;
  excludeBookingId?: string;
  tx?: TxClient;
}) {
  const tx = args.tx ?? prisma;
  const searchNeedle = args.search?.trim().toLocaleLowerCase("ru-RU") ?? "";

  const categoryOrder = await getMergedCategoryOrder();

  const rawEquipments = await tx.equipment.findMany({
    where: {
      ...(args.equipmentIds ? { id: { in: args.equipmentIds } } : {}),
      ...(args.category ? { category: args.category } : {}),
    },
    orderBy: { id: "asc" },
    select: {
      id: true,
      category: true,
      name: true,
      brand: true,
      model: true,
      stockTrackingMode: true,
      sortOrder: true,
      totalQuantity: true,
      rentalRatePerShift: true,
      comment: true,
    },
  });
  const equipments =
    searchNeedle.length === 0
      ? rawEquipments
      : rawEquipments.filter((e) => {
          const haystack = [e.name, e.brand ?? "", e.model ?? "", e.category]
            .join(" ")
            .toLocaleLowerCase("ru-RU");
          return haystack.includes(searchNeedle);
        });

  equipments.sort((a, b) => compareEquipmentTransportLast(a, b, categoryOrder));

  if (equipments.length === 0) return [] as AvailabilityRow[];

  const equipmentIds = equipments.map((e) => e.id);

  // Find all blocking bookings overlapping the requested range.
  const overlappingBookings = await tx.booking.findMany({
    where: {
      status: { in: BLOCKING_STATUSES },
      startDate: { lte: args.endDate },
      endDate: { gte: args.startDate },
      ...(args.excludeBookingId ? { id: { not: args.excludeBookingId } } : {}),
    },
    select: { id: true },
  });
  const overlappingBookingIds = overlappingBookings.map((b) => b.id);

  if (overlappingBookingIds.length === 0) {
    return equipments.map((e) => ({
      equipment: e,
      occupiedQuantity: 0,
      availableQuantity: e.totalQuantity,
    }));
  }

  const bookingItems = await tx.bookingItem.findMany({
    where: {
      bookingId: { in: overlappingBookingIds },
      equipmentId: { in: equipmentIds },
    },
    select: {
      id: true,
      equipmentId: true,
      quantity: true,
    },
  });

  // Count-based occupancy: sum BookingItem.quantity.
  const occupiedCountByEquipment = new Map<string, number>();
  for (const bi of bookingItems) {
    occupiedCountByEquipment.set(bi.equipmentId, (occupiedCountByEquipment.get(bi.equipmentId) ?? 0) + bi.quantity);
  }

  // Unit-based occupancy: count distinct reserved equipment units via BookingItemUnit.
  const bookingItemIds = bookingItems.map((b) => b.id);
  const bookingItemIdToEquipmentId = new Map<string, string>();
  for (const bi of bookingItems) bookingItemIdToEquipmentId.set(bi.id, bi.equipmentId);

  const occupiedUnitsByEquipment = new Map<string, Set<string>>();
  if (bookingItemIds.length > 0) {
    const reserved = await tx.bookingItemUnit.findMany({
      where: { bookingItemId: { in: bookingItemIds } },
      select: { bookingItemId: true, equipmentUnitId: true },
    });
    for (const r of reserved) {
      const equipmentId = bookingItemIdToEquipmentId.get(r.bookingItemId);
      if (!equipmentId) continue;
      if (!occupiedUnitsByEquipment.has(equipmentId)) occupiedUnitsByEquipment.set(equipmentId, new Set());
      occupiedUnitsByEquipment.get(equipmentId)!.add(r.equipmentUnitId);
    }
  }

  return equipments.map((e) => {
    const occupied =
      e.stockTrackingMode === "UNIT"
        ? (occupiedUnitsByEquipment.get(e.id)?.size ?? 0)
        : (occupiedCountByEquipment.get(e.id) ?? 0);
    const available = clampNonNegative(e.totalQuantity - occupied);
    return {
      equipment: e,
      occupiedQuantity: occupied,
      availableQuantity: available,
    };
  });
}

