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
  /**
   * Плановый срок возврата: позиции обычной брони или партии проекта (без
   * хвоста «до сейчас» у просроченной выданной; у сданной части партии — момент
   * сдачи). Карточка держателя пишет по нему «освободится …» и «просрочено».
   */
  dueAt?: number;
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
        dueAt: r.returnedAt.getTime(),
      })),
      { quantity: remaining, end, dueAt: plannedEnd },
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
        dueAt: p.dueAt,
        quantity: p.quantity,
      }));
  });
}
/**
 * Часть резерва, попадающая в окно запроса, или null, если не попадает.
 * Одна граница окна на всех: пик занятости и «кто держит позицию»
 * (addonAvailability) обязаны видеть один и тот же набор резервов.
 *
 * Окно и резервы полуоткрытые — [start, end): бронь, которая кончается ровно
 * в момент начала окна, его не задевает (стык-в-стык). Окно нулевой длины
 * («что занято в момент t») читается как [t, t + 1 мс).
 */
function clipToWindow(
  r: Reservation,
  start: number,
  end: number,
): [number, number] | null {
  const windowEnd = end > start ? end : start + 1;
  const a = Math.max(start, r.start),
    b = Math.min(windowEnd, r.end);
  return b > a ? [a, b] : null;
}

/** Попадает ли резерв в окно — по тем же границам, что peakOccupancy. */
export function reservationOverlaps(
  r: Reservation,
  start: number,
  end: number,
): boolean {
  return clipToWindow(r, start, end) !== null;
}

/** Peak simultaneous occupancy, with half-open intervals. */
export function peakOccupancy(
  rows: Reservation[],
  start: number,
  end: number,
): number {
  const events: Array<[number, number]> = [];
  for (const r of rows) {
    const clipped = clipToWindow(r, start, end);
    if (clipped) {
      const [a, b] = clipped;
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
