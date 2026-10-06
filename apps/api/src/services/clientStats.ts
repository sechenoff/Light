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
 *
 * Продолжение брони (часть оборудования осталась у клиента после приёмки
 * основной) — та же аренда, а не новая: в число броней и дату последней оно
 * не входит, а его сумма прибавляется к своей основной брони (средний чек —
 * по семьям, выручка — вся).
 */
export async function getClientStats(clientId: string): Promise<ClientStatsResult> {
  const client = await prisma.client.findUnique({ where: { id: clientId } });
  if (!client) {
    throw new HttpError(404, "Клиент не найден");
  }

  const bookings = await prisma.booking.findMany({
    where: { clientId, status: { not: "CANCELLED" } },
    select: {
      id: true,
      finalAmount: true,
      amountOutstanding: true,
      startDate: true,
      parentBookingId: true,
      rootBookingId: true,
    },
  });
  const rentals = bookings.filter((b) => b.parentBookingId == null);
  const familyTotal = new Map<string, Decimal>();
  for (const b of bookings) {
    const key = b.rootBookingId ?? b.id;
    familyTotal.set(key, (familyTotal.get(key) ?? new Decimal(0)).add(b.finalAmount));
  }

  let totalRevenue = new Decimal(0);
  let outstandingDebt = new Decimal(0);
  let lastBookingDate: Date | null = null;
  let amountPositiveCount = 0;
  let amountPositiveSum = new Decimal(0);

  for (const b of bookings) {
    totalRevenue = totalRevenue.add(b.finalAmount);
    outstandingDebt = outstandingDebt.add(b.amountOutstanding);
  }
  for (const b of rentals) {
    const family = familyTotal.get(b.id) ?? b.finalAmount;
    if (family.greaterThan(0)) {
      amountPositiveCount += 1;
      amountPositiveSum = amountPositiveSum.add(family);
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
    bookingCount: rentals.length,
    averageCheck: averageCheck.toNumber(),
    totalRevenue: totalRevenue.toNumber(),
    outstandingDebt: outstandingDebt.toNumber(),
    hasDebt: outstandingDebt.greaterThan(0),
    lastBookingDate: lastBookingDate ? lastBookingDate.toISOString() : null,
  };
}
