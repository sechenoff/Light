import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";

export type ClientStatsResult = {
  clientId: string;
  clientName: string;
  bookingCount: number;
  averageCheck: number;
  totalRevenue: number;
  outstandingDebt: number;
  hasDebt: boolean;
  lastBookingDate: string | null;
};

/**
 * Агрегирует статистику по клиенту для экрана согласования.
 * Исключает CANCELLED-брони из всех расчётов.
 */
export async function getClientStats(clientId: string): Promise<ClientStatsResult> {
  const client = await prisma.client.findUnique({ where: { id: clientId } });
  if (!client) {
    throw new HttpError(404, "Клиент не найден");
  }

  const bookings = await prisma.booking.findMany({
    where: { clientId, status: { not: "CANCELLED" } },
    select: {
      finalAmount: true,
      amountOutstanding: true,
      startDate: true,
    },
  });

  let totalRevenue = new Decimal(0);
  let outstandingDebt = new Decimal(0);
  let lastBookingDate: Date | null = null;
  let amountPositiveCount = 0;
  let amountPositiveSum = new Decimal(0);

  for (const b of bookings) {
    totalRevenue = totalRevenue.add(b.finalAmount);
    outstandingDebt = outstandingDebt.add(b.amountOutstanding);

    if (b.finalAmount.greaterThan(0)) {
      amountPositiveCount += 1;
      amountPositiveSum = amountPositiveSum.add(b.finalAmount);
    }

    if (!lastBookingDate || b.startDate > lastBookingDate) {
      lastBookingDate = b.startDate;
    }
  }

  const averageCheck =
    amountPositiveCount > 0
      ? amountPositiveSum.dividedBy(amountPositiveCount)
      : new Decimal(0);

  return {
    clientId: client.id,
    clientName: client.name,
    bookingCount: bookings.length,
    averageCheck: averageCheck.toNumber(),
    totalRevenue: totalRevenue.toNumber(),
    outstandingDebt: outstandingDebt.toNumber(),
    hasDebt: outstandingDebt.greaterThan(0),
    lastBookingDate: lastBookingDate ? lastBookingDate.toISOString() : null,
  };
}
