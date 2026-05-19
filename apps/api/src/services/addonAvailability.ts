import { prisma } from "../prisma";

const BLOCKING_STATUSES = ["CONFIRMED", "ISSUED"] as const;

export interface AddonConflict {
  bookingId: string;
  bookingNo: string;          // "#A1B2C3"
  projectName: string;
  from: string;               // ISO
  to: string;                 // ISO
  freeFrom: string;           // ISO — nearest conflicting booking endDate
}

function bookingNo(id: string): string {
  return "#" + id.slice(-6).toUpperCase();
}

/**
 * Находит ближайшую конфликтующую бронь (CONFIRMED/ISSUED), которая делает
 * equipment недоступным в окне [start,end], исключая текущую бронь.
 * Возвращает null если конфликта нет (с учётом totalQuantity).
 */
export async function findAddonConflict(
  equipmentId: string,
  start: Date,
  end: Date,
  excludeBookingId: string,
): Promise<AddonConflict | null> {
  const eq = await prisma.equipment.findUnique({
    where: { id: equipmentId },
    select: { totalQuantity: true },
  });
  if (!eq) return null;

  const overlapping = await prisma.booking.findMany({
    where: {
      id: { not: excludeBookingId },
      status: { in: [...BLOCKING_STATUSES] },
      startDate: { lte: end },
      endDate: { gte: start },
      items: { some: { equipmentId } },
    },
    select: {
      id: true, projectName: true, startDate: true, endDate: true,
      items: { where: { equipmentId }, select: { quantity: true } },
    },
    orderBy: { startDate: "asc" },
  });

  if (overlapping.length === 0) return null;

  const reservedQty = overlapping.reduce(
    (s, b) => s + b.items.reduce((q, i) => q + i.quantity, 0), 0,
  );
  const capacity = eq.totalQuantity || 1;
  if (reservedQty + 1 <= capacity) return null; // ещё есть свободный экземпляр

  const nearest = overlapping[0];
  return {
    bookingId: nearest.id,
    bookingNo: bookingNo(nearest.id),
    projectName: nearest.projectName,
    from: nearest.startDate.toISOString(),
    to: nearest.endDate.toISOString(),
    freeFrom: nearest.endDate.toISOString(),
  };
}
