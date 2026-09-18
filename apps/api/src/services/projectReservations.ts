import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { nextDate, projectMidnight } from "./projectPricing";
export type Reservation = {
  equipmentId: string;
  start: number;
  end: number;
  quantity: number;
  bookingId: string;
  lotId?: string;
};
export async function projectReservations(
  args: {
    start: Date;
    end: Date;
    equipmentIds?: string[];
    excludeLotId?: string;
    excludeBookingId?: string;
  },
  tx: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<Reservation[]> {
  const lots = await tx.projectLot.findMany({
    where: {
      status: { not: "CANCELLED" },
      ...(args.equipmentIds ? { equipmentId: { in: args.equipmentIds } } : {}),
      ...(args.excludeLotId ? { id: { not: args.excludeLotId } } : {}),
      ...(args.excludeBookingId
        ? { bookingId: { not: args.excludeBookingId } }
        : {}),
      project: {
        booking: { status: { in: ["CONFIRMED", "ISSUED"] }, deletedAt: null },
      },
    },
    include: { returns: true },
  });
  const now = Date.now();
  return lots.flatMap((l) => {
    const start =
      l.issuedAt?.getTime() ?? projectMidnight(l.fromDate).getTime();
    const plannedEnd = projectMidnight(nextDate(l.throughDate)).getTime();
    const end =
      l.status === "ISSUED" && plannedEnd <= now
        ? Math.max(now + 1, args.end.getTime() + 1)
        : plannedEnd;
    const remaining =
      l.quantity - l.returns.reduce((s, r) => s + r.quantity, 0);
    return [
      ...l.returns.map((r) => ({
        quantity: r.quantity,
        end: r.returnedAt.getTime(),
      })),
      { quantity: remaining, end },
    ]
      .filter(
        (p) =>
          p.quantity > 0 &&
          start <= args.end.getTime() &&
          p.end > args.start.getTime(),
      )
      .map((p) => ({
        equipmentId: l.equipmentId,
        bookingId: l.bookingId,
        lotId: l.id,
        start,
        end: p.end,
        quantity: p.quantity,
      }));
  });
}
/** Peak simultaneous occupancy, with half-open intervals. */
export function peakOccupancy(
  rows: Reservation[],
  start: number,
  end: number,
): number {
  const events: Array<[number, number]> = [];
  for (const r of rows) {
    const a = Math.max(start, r.start),
      b = Math.min(end + 1, r.end);
    if (b > a) {
      events.push([a, r.quantity], [b, -r.quantity]);
    }
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let n = 0,
    max = 0;
  for (const [, delta] of events) {
    n += delta;
    max = Math.max(max, n);
  }
  return max;
}
