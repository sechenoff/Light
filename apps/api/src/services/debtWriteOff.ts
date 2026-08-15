import Decimal from "decimal.js";

import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";
import { writeAuditEntry } from "./audit";
import { recomputeBookingFinance } from "./finance";

/**
 * Списание («прощение») остатка долга по брони.
 *
 * Зачем: сметы округляются до удобной суммы, клиент платит ровно её, и на броне
 * повисает хвост в несколько сотен рублей. Взыскивать его никто не будет, но
 * бронь при этом не уходит из дебиторки и проект нельзя закрыть.
 *
 * Почему списание, а не удаление счёта/платежа: удаление уничтожает финансовую
 * историю (по этой же причине удаление брони убрали со страницы долгов). После
 * списания видно три разных числа — выставили, получили, простили, — и отчёты
 * продолжают сходиться.
 *
 * `writeOffAmount` НАКОПИТЕЛЬНЫЙ: повторный вызов добавляет к уже прощённому.
 * Простить больше текущего остатка нельзя — это защищает от опечатки в сумме,
 * из-за которой бронь ушла бы в мнимую переплату.
 */

/** Статусы, в которых бронь вообще может числиться должной (ср. computeDebts). */
const DEBT_BEARING_STATUSES = ["CONFIRMED", "ISSUED", "RETURNED"] as const;

export interface WriteOffResult {
  bookingId: string;
  /** Сколько прощено этим вызовом. */
  amountWrittenOff: string;
  /** Итого прощено по броне (накопительно). */
  totalWrittenOff: string;
  /** Остаток долга после списания. */
  amountOutstanding: string;
  paymentStatus: string;
}

export async function writeOffBookingDebt(
  bookingId: string,
  args: { amount?: number | null; reason?: string | null },
  actorId: string,
): Promise<WriteOffResult> {
  return prisma.$transaction(async (tx) => {
    const booking = await tx.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        status: true,
        deletedAt: true,
        amountOutstanding: true,
        writeOffAmount: true,
        writeOffReason: true,
      },
    });
    if (!booking) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");
    if (booking.deletedAt) {
      throw new HttpError(409, "Бронь в архиве", "BOOKING_ARCHIVED");
    }
    if (!DEBT_BEARING_STATUSES.includes(booking.status as (typeof DEBT_BEARING_STATUSES)[number])) {
      throw new HttpError(
        409,
        `Нельзя списать долг у брони в статусе ${booking.status}`,
        "INVALID_BOOKING_STATE",
      );
    }

    // Остаток читаем ВНУТРИ транзакции: между открытием формы и нажатием кнопки
    // клиент мог доплатить, и прощать было бы уже нечего.
    const outstanding = new Decimal(booking.amountOutstanding.toString());
    if (outstanding.lessThanOrEqualTo(0)) {
      throw new HttpError(409, "По этой брони нет долга", "NO_OUTSTANDING_DEBT");
    }

    // Без явной суммы прощаем весь остаток — типовой сценарий «закрыть хвост».
    const requested =
      args.amount == null ? outstanding : new Decimal(args.amount).toDecimalPlaces(2);
    if (requested.lessThanOrEqualTo(0)) {
      throw new HttpError(400, "Сумма списания должна быть больше нуля", "INVALID_AMOUNT");
    }
    if (requested.greaterThan(outstanding)) {
      throw new HttpError(
        400,
        `Нельзя простить больше остатка (${outstanding.toFixed(2)} ₽)`,
        "WRITE_OFF_EXCEEDS_DEBT",
        { outstanding: outstanding.toFixed(2), requested: requested.toFixed(2) },
      );
    }

    const previousTotal = booking.writeOffAmount
      ? new Decimal(booking.writeOffAmount.toString())
      : new Decimal(0);
    const newTotal = previousTotal.add(requested).toDecimalPlaces(2);

    await tx.booking.update({
      where: { id: bookingId },
      data: {
        writeOffAmount: newTotal.toString(),
        writeOffReason: args.reason?.trim() || booking.writeOffReason || null,
        writeOffAt: new Date(),
        writeOffBy: actorId,
      },
    });

    // Пересчёт в той же транзакции: amountOutstanding и paymentStatus обязаны
    // стать согласованными со списанием атомарно, иначе бронь на мгновение
    // остаётся в дебиторке с уже применённым списанием.
    const recomputed = await recomputeBookingFinance(bookingId, tx);

    await writeAuditEntry({
      tx,
      userId: actorId,
      action: "BOOKING_DEBT_WRITE_OFF",
      entityType: "Booking",
      entityId: bookingId,
      before: {
        amountOutstanding: outstanding.toFixed(2),
        writeOffAmount: previousTotal.toFixed(2),
      },
      after: {
        amountWrittenOff: requested.toFixed(2),
        writeOffAmount: newTotal.toFixed(2),
        reason: args.reason?.trim() ?? null,
        amountOutstanding: recomputed?.amountOutstanding?.toString() ?? "0",
        paymentStatus: recomputed?.paymentStatus ?? null,
      },
    });

    return {
      bookingId,
      amountWrittenOff: requested.toFixed(2),
      totalWrittenOff: newTotal.toFixed(2),
      amountOutstanding: recomputed?.amountOutstanding?.toString() ?? "0",
      paymentStatus: recomputed?.paymentStatus ?? "NOT_PAID",
    };
  });
}

/**
 * Отмена списания — долг возвращается в дебиторку целиком.
 * Нужна, потому что списание необратимо стирало бы информацию: операция
 * денежная, и ошибиться в ней легко.
 */
export async function cancelBookingDebtWriteOff(
  bookingId: string,
  actorId: string,
): Promise<WriteOffResult> {
  return prisma.$transaction(async (tx) => {
    const booking = await tx.booking.findUnique({
      where: { id: bookingId },
      select: { id: true, writeOffAmount: true, writeOffReason: true },
    });
    if (!booking) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");
    if (booking.writeOffAmount == null) {
      throw new HttpError(409, "По этой брони нет списания", "NO_WRITE_OFF");
    }

    const previousTotal = new Decimal(booking.writeOffAmount.toString());

    await tx.booking.update({
      where: { id: bookingId },
      data: {
        writeOffAmount: null,
        writeOffReason: null,
        writeOffAt: null,
        writeOffBy: null,
      },
    });

    const recomputed = await recomputeBookingFinance(bookingId, tx);

    await writeAuditEntry({
      tx,
      userId: actorId,
      action: "BOOKING_DEBT_WRITE_OFF_CANCELLED",
      entityType: "Booking",
      entityId: bookingId,
      before: {
        writeOffAmount: previousTotal.toFixed(2),
        reason: booking.writeOffReason,
      },
      after: {
        writeOffAmount: null,
        amountOutstanding: recomputed?.amountOutstanding?.toString() ?? "0",
        paymentStatus: recomputed?.paymentStatus ?? null,
      },
    });

    return {
      bookingId,
      amountWrittenOff: "0.00",
      totalWrittenOff: "0.00",
      amountOutstanding: recomputed?.amountOutstanding?.toString() ?? "0",
      paymentStatus: recomputed?.paymentStatus ?? "NOT_PAID",
    };
  });
}
