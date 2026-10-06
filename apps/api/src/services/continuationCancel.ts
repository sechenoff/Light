/**
 * «Отменить продолжение» — продолжение брони оформили по ошибке: оставленное
 * на самом деле вернули вместе с основной бронью.
 *
 * Только руководитель и только продолжение, которое ещё «у клиента» (выдано):
 * принятое закрывается обычной приёмкой. Одной транзакцией:
 *  - резервы единиц продолжения закрываются возвратом (история остаётся),
 *    сами единицы — снова на складе;
 *  - открытая приёмка этого продолжения в киоске закрывается;
 *  - продолжение — «Отменена», его смета больше не долг клиента;
 *  - запись в журнал с причиной.
 *
 * Если по продолжению уже есть оплата или выставлен счёт — отказ: деньги
 * сначала нужно вернуть или перенести, счёт — аннулировать; молча их
 * обнулять нельзя (живой счёт ушёл бы в напоминания о долге). Продолжение второй волны (у
 * отменяемого есть своё живое продолжение) — тоже отказ: сначала его.
 */
import type { Prisma } from "@prisma/client";
import { Decimal } from "decimal.js";

import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";
import { writeAuditEntry } from "./audit";
import { assertNoLiveContinuations } from "./bookingFamily";
import { recomputeBookingFinance } from "./finance";
import { closeActiveScanSessions } from "./scanSessionPolicy";

export const CANCEL_CONTINUATION_CODES = {
  NOT_CONTINUATION: "NOT_A_CONTINUATION",
  NOT_OUT: "CONTINUATION_NOT_OUT",
  HAS_PAYMENTS: "CONTINUATION_HAS_PAYMENTS",
  HAS_INVOICES: "CONTINUATION_HAS_INVOICES",
} as const;

/** Счета, которые клиент видит как долг: выставлен, частично оплачен, просрочен. */
const LIVE_INVOICE_STATUSES = ["ISSUED", "PARTIAL_PAID", "OVERDUE"] as const;

export async function cancelContinuation(args: {
  bookingId: string;
  reason: string;
  actorUserId: string;
}): Promise<{ bookingId: string; releasedUnits: number; closedScanSessions: number }> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const booking = await tx.booking.findUnique({
      where: { id: args.bookingId },
      select: { id: true, status: true, parentBookingId: true, amountPaid: true, deletedAt: true, docNumber: true },
    });
    if (!booking || booking.deletedAt) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");
    if (!booking.parentBookingId) {
      throw new HttpError(409, "Это не продолжение брони — отмена продолжения к ней не применяется", CANCEL_CONTINUATION_CODES.NOT_CONTINUATION);
    }
    if (booking.status !== "ISSUED") {
      throw new HttpError(
        409,
        "Отменить можно только продолжение, которое ещё у клиента",
        CANCEL_CONTINUATION_CODES.NOT_OUT,
        { status: booking.status },
      );
    }
    await assertNoLiveContinuations(tx, booking.id, "отменять");
    if (new Decimal(booking.amountPaid.toString()).gt(0)) {
      throw new HttpError(
        409,
        "По продолжению уже есть оплата — сначала верните или перенесите деньги, потом отменяйте",
        CANCEL_CONTINUATION_CODES.HAS_PAYMENTS,
      );
    }
    const liveInvoices = await tx.invoice.count({
      where: { bookingId: booking.id, status: { in: [...LIVE_INVOICE_STATUSES] } },
    });
    if (liveInvoices > 0) {
      throw new HttpError(
        409,
        "По продолжению выставлен счёт — сначала аннулируйте его, потом отменяйте",
        CANCEL_CONTINUATION_CODES.HAS_INVOICES,
      );
    }

    // Условная смена статуса: «Отменить» и «Принять остаток» в одну секунду не проходят обе.
    const claimed = await tx.booking.updateMany({
      where: { id: booking.id, status: "ISSUED" },
      data: { status: "CANCELLED" },
    });
    if (claimed.count === 0) {
      throw new HttpError(409, "Продолжение только что приняли — обновите карточку", CANCEL_CONTINUATION_CODES.NOT_OUT);
    }

    const now = new Date();
    const live = await tx.bookingItemUnit.findMany({
      where: { bookingItem: { bookingId: booking.id }, returnedAt: null },
      select: { id: true, equipmentUnitId: true },
    });
    if (live.length > 0) {
      await tx.bookingItemUnit.updateMany({ where: { id: { in: live.map((r) => r.id) } }, data: { returnedAt: now } });
      await tx.equipmentUnit.updateMany({
        where: { id: { in: live.map((r) => r.equipmentUnitId) }, status: "ISSUED" },
        data: { status: "AVAILABLE" },
      });
    }
    const closed = await closeActiveScanSessions(tx, booking.id, { reason: "BOOKING_CANCELLED", actorUserId: args.actorUserId });
    // Отменённая бронь в реестре и в долгах не числится (её остаток там — 0);
    // пересчёт держит поля брони согласованными со сметой.
    await recomputeBookingFinance(booking.id, tx);
    await writeAuditEntry({
      tx,
      userId: args.actorUserId,
      action: "BOOKING_CONTINUATION_CANCELLED",
      entityType: "Booking",
      entityId: booking.id,
      before: { status: "ISSUED" },
      after: {
        status: "CANCELLED",
        reason: args.reason,
        parentBookingId: booking.parentBookingId,
        releasedUnits: live.length,
        closedScanSessions: closed.length,
      },
    });
    return { bookingId: booking.id, releasedUnits: live.length, closedScanSessions: closed.length };
  });
}
