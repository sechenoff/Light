import { Prisma } from "@prisma/client";

import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";
import { writeAuditEntry, diffFields } from "./audit";
import { releaseBookingUnits } from "./bookings";

/**
 * Отмена и архивация брони — единая реализация для одиночных маршрутов
 * (`POST /:id/status {action:"cancel"}`, `DELETE /:id`) и группового
 * `POST /bulk`. До вынесения обе операции жили инлайн в routes/bookings.ts;
 * дублировать их транзакции ради bulk означало гарантированный дрейф
 * (освобождение юнитов и аудит легко разъезжаются между копиями).
 */

/** Из каких статусов бронь можно отменить. Зеркалит allowedActionsByStatus. */
const CANCELLABLE_STATUSES = ["DRAFT", "PENDING_APPROVAL", "CONFIRMED"] as const;

const bookingInclude = {
  client: true,
  items: { include: { equipment: true } },
  estimates: { include: { lines: true } },
} as const;

export type CancelBookingPatch = {
  expectedPaymentDate?: Date | null;
  paymentComment?: string | null;
};

/**
 * Отменить бронь: статус → CANCELLED + снятие UNIT-резервов + аудит,
 * всё в одной транзакции. Без освобождения резервов equipmentUnit застревал
 * бы в ISSUED, а BookingItemUnit продолжал занимать оборудование.
 *
 * `userId` — автор действия; для каналов без AdminUser (бот-ключ) сюда
 * приходит "system", как и раньше в маршруте.
 */
export async function cancelBooking(
  bookingId: string,
  userId: string,
  patch: CancelBookingPatch = {},
) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { id: true, status: true },
  });
  if (!booking) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");
  if (!CANCELLABLE_STATUSES.includes(booking.status as (typeof CANCELLABLE_STATUSES)[number])) {
    throw new HttpError(
      409,
      `Недопустимый переход: ${booking.status} -> cancel`,
      "INVALID_BOOKING_STATE",
    );
  }

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const updated = await tx.booking.update({
      where: { id: bookingId },
      data: {
        status: "CANCELLED",
        expectedPaymentDate: patch.expectedPaymentDate,
        paymentComment: patch.paymentComment,
      },
      include: bookingInclude,
    });
    const released = await releaseBookingUnits(bookingId, tx);
    await writeAuditEntry({
      tx,
      userId,
      action: "BOOKING_UNITS_RELEASED",
      entityType: "Booking",
      entityId: bookingId,
      before: diffFields({ status: booking.status }),
      after: diffFields({
        status: "CANCELLED",
        via: "status:cancel",
        releasedReservations: released.releasedReservations,
        freedUnitIds: released.freedUnitIds.length,
      }),
    });
    return updated;
  });
}

export type ArchiveBookingResult = {
  releasedReservations: number;
  freedUnits: number;
};

/**
 * Мягкое удаление (архивация): deletedAt/deletedBy + снятие резервов + аудит.
 * Бронь остаётся в БД и восстанавливается через POST /:id/restore.
 *
 * Резервы освобождаются только для НЕ-терминальных статусов: у RETURNED
 * резервы — это история приёмки (returnedAt заполнен), у CANCELLED они уже
 * сняты веткой отмены.
 */
export async function archiveBooking(
  bookingId: string,
  userId: string,
): Promise<ArchiveBookingResult> {
  const existing = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      status: true,
      projectName: true,
      startDate: true,
      endDate: true,
      deletedAt: true,
    },
  });
  if (!existing) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");
  if (existing.deletedAt) {
    throw new HttpError(409, "Бронь уже в архиве", "BOOKING_ALREADY_ARCHIVED");
  }

  const released = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.booking.update({
      where: { id: bookingId },
      data: { deletedAt: new Date(), deletedBy: userId },
    });
    const isTerminal = existing.status === "RETURNED" || existing.status === "CANCELLED";
    const rel = isTerminal
      ? { releasedReservations: 0, freedUnitIds: [] as string[] }
      : await releaseBookingUnits(bookingId, tx);
    await writeAuditEntry({
      tx,
      userId,
      action: "BOOKING_ARCHIVED",
      entityType: "Booking",
      entityId: bookingId,
      before: diffFields(existing as Record<string, unknown>),
      after: {
        deletedAt: new Date().toISOString(),
        deletedBy: userId,
        releasedReservations: rel.releasedReservations,
        freedUnits: rel.freedUnitIds.length,
      },
    });
    return rel;
  });

  return {
    releasedReservations: released.releasedReservations,
    freedUnits: released.freedUnitIds.length,
  };
}
