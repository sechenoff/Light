import { Prisma } from "@prisma/client";

import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";
import { writeAuditEntry } from "./audit";
import { confirmBooking } from "./bookings";

/**
 * Отправить на согласование руководителю.
 * DRAFT → PENDING_APPROVAL, либо CONFIRMED → PENDING_APPROVAL (повторное
 * согласование после правки уже подтверждённой брони — кладовщик изменил
 * состав/даты и возвращает бронь руководителю). Очищает rejectionReason.
 * Пишет AuditEntry "BOOKING_SUBMITTED".
 */
export async function submitForApproval(bookingId: string, userId: string) {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const booking = await tx.booking.findUnique({
      where: { id: bookingId },
      select: { id: true, status: true, rejectionReason: true },
    });
    if (!booking) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");
    if (booking.status !== "DRAFT" && booking.status !== "CONFIRMED") {
      throw new HttpError(
        409,
        "Отправить на согласование можно только черновик или подтверждённую бронь",
        "INVALID_BOOKING_STATE",
      );
    }

    const before = { status: booking.status, rejectionReason: booking.rejectionReason };
    const updated = await tx.booking.update({
      where: { id: bookingId },
      data: { status: "PENDING_APPROVAL", rejectionReason: null },
      include: {
        client: true,
        items: { include: { equipment: true } },
        estimates: { include: { lines: true } },
      },
    });

    await writeAuditEntry({
      userId,
      action: "BOOKING_SUBMITTED",
      entityType: "Booking",
      entityId: bookingId,
      before,
      after: { status: updated.status, rejectionReason: updated.rejectionReason },
      tx,
    });

    return updated;
  });
}

/**
 * Режим согласования броней.
 *  - "manual" (дефолт) — двухэтапный workflow: DRAFT → PENDING_APPROVAL → approve.
 *  - "auto"  — согласование выключено (env APPROVAL_MODE=auto): заявка после
 *    создания сразу подтверждается (проверка доступности + резервирование в
 *    confirmBooking), руководитель не участвует. Временный режим по решению
 *    владельца 2026-08-02; возврат — убрать env и перезапустить API.
 */
export function approvalMode(): "auto" | "manual" {
  return process.env.APPROVAL_MODE === "auto" ? "auto" : "manual";
}

/**
 * Автоподтверждение (режим APPROVAL_MODE=auto): DRAFT → CONFIRMED напрямую.
 * Вся проверка доступности/резервирование/снапшот сметы — в confirmBooking.
 * Пишет AuditEntry "BOOKING_AUTO_CONFIRMED" (вне транзакции confirmBooking —
 * тот же trade-off, что у approve: аудит = observability).
 */
export async function autoConfirmBooking(bookingId: string, userId: string | null) {
  const preCheck = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { id: true, status: true },
  });
  if (!preCheck) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");
  if (preCheck.status !== "DRAFT" && preCheck.status !== "PENDING_APPROVAL") {
    throw new HttpError(
      409,
      "Подтвердить можно только черновик или заявку на согласовании",
      "INVALID_BOOKING_STATE",
    );
  }

  const confirmed = await confirmBooking(bookingId);

  if (userId) {
    try {
      await writeAuditEntry({
        userId,
        action: "BOOKING_AUTO_CONFIRMED",
        entityType: "Booking",
        entityId: bookingId,
        before: { status: preCheck.status },
        after: { status: confirmed.status, confirmedAt: confirmed.confirmedAt, via: "auto" },
      });
    } catch {
      // Аудит best-effort — подтверждение важнее записи в журнал.
    }
  }

  const full = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      client: true,
      items: { include: { equipment: true } },
      estimates: { include: { lines: true } },
    },
  });
  return full!;
}

/**
 * Одобрить бронь: PENDING_APPROVAL → CONFIRMED.
 * Делегирует confirmBooking() для проверки доступности, резервирования единиц и создания snapshot сметы.
 * Пишет AuditEntry "BOOKING_APPROVED".
 */
export async function approveBooking(bookingId: string, userId: string) {
  // Pre-check state — fail fast before entering confirmBooking
  const preCheck = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { id: true, status: true },
  });
  if (!preCheck) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");
  if (preCheck.status !== "PENDING_APPROVAL") {
    throw new HttpError(
      409,
      "Одобрить можно только бронь на согласовании",
      "INVALID_BOOKING_STATE",
    );
  }

  // Temporarily update status to DRAFT so confirmBooking can proceed
  // (confirmBooking checks: CONFIRMED/ISSUED → return early; items empty → 400)
  // PENDING_APPROVAL is not CONFIRMED/ISSUED, so confirmBooking will process it normally.
  // We need to make sure confirmBooking accepts PENDING_APPROVAL as entering state.
  // confirmBooking only skips if status is already CONFIRMED or ISSUED — PENDING_APPROVAL passes through.
  const confirmed = await confirmBooking(bookingId);

  // Write audit AFTER confirmBooking succeeds (outside its transaction; acceptable trade-off)
  await writeAuditEntry({
    userId,
    action: "BOOKING_APPROVED",
    entityType: "Booking",
    entityId: bookingId,
    before: { status: "PENDING_APPROVAL" },
    after: { status: confirmed.status, confirmedAt: confirmed.confirmedAt },
  });

  // Return full include for API response
  const full = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      client: true,
      items: { include: { equipment: true } },
      estimates: { include: { lines: true } },
    },
  });
  return full!;
}

/**
 * Отклонить бронь: PENDING_APPROVAL → DRAFT + rejectionReason.
 * Пишет AuditEntry "BOOKING_REJECTED". reason обязателен.
 */
export async function rejectBooking(bookingId: string, userId: string, reason: string) {
  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    throw new HttpError(400, "Укажите причину отклонения", "REJECTION_REASON_REQUIRED");
  }

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const booking = await tx.booking.findUnique({
      where: { id: bookingId },
      select: { id: true, status: true, rejectionReason: true },
    });
    if (!booking) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");
    if (booking.status !== "PENDING_APPROVAL") {
      throw new HttpError(
        409,
        "Отклонить можно только бронь на согласовании",
        "INVALID_BOOKING_STATE",
      );
    }

    const before = { status: booking.status, rejectionReason: booking.rejectionReason };
    const updated = await tx.booking.update({
      where: { id: bookingId },
      data: { status: "DRAFT", rejectionReason: trimmed },
      include: {
        client: true,
        items: { include: { equipment: true } },
        estimates: { include: { lines: true } },
      },
    });

    await writeAuditEntry({
      userId,
      action: "BOOKING_REJECTED",
      entityType: "Booking",
      entityId: bookingId,
      before,
      after: { status: updated.status, rejectionReason: updated.rejectionReason },
      tx,
    });

    return updated;
  });
}
