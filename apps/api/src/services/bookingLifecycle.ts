import { Prisma } from "@prisma/client";

import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";
import { writeAuditEntry, diffFields } from "./audit";
import { releaseBookingUnits } from "./bookings";
import { closeActiveScanSessions, invalidBookingStateMessage } from "./scanSessionPolicy";
import { assertFamilyAllowsArchive, assertFamilyAllowsPurge } from "./bookingFamily";

/**
 * Отмена, архивация, восстановление и окончательное удаление брони — единая
 * реализация для одиночных маршрутов (`POST /:id/status {action:"cancel"}`,
 * `DELETE /:id`, `POST /:id/restore`, `DELETE /:id/purge`) и группового
 * `POST /bulk`. До вынесения операции жили инлайн в routes/bookings.ts;
 * дублировать их транзакции ради bulk означало гарантированный дрейф
 * (освобождение юнитов, финансовые гарды и аудит легко разъезжаются между
 * копиями).
 */

/**
 * 409 INVALID_BOOKING_STATE для ручной кнопки карточки: текст по паре
 * «статус × действие» («Бронь уже выдана — обновите страницу», «Выданную бронь
 * нельзя отменить — сначала примите возврат»…), а не ENUM-строка
 * «Недопустимый переход: ISSUED -> issue». Когда переход сам по себе допустим,
 * но бронь поменяли между чтением и записью (гонка двух сотрудников), текст —
 * «Бронь уже изменили — обновите страницу». В details — status и action, чтобы
 * интерфейс перечитал бронь.
 */
export function invalidTransitionError(status: string, action: string): HttpError {
  return new HttpError(
    409,
    invalidBookingStateMessage(status as Parameters<typeof invalidBookingStateMessage>[0], action),
    "INVALID_BOOKING_STATE",
    { status, action },
  );
}

async function requireOrdinaryBooking(bookingId: string) {
  if (await prisma.bookingProject.findUnique({ where: { bookingId } })) {
    throw new HttpError(409, "Действие выполняется в карточке длинного проекта", "PROJECT_ACTION_REQUIRED");
  }
}

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
 * Отменить бронь: статус → CANCELLED + снятие UNIT-резервов + закрытие сессий
 * киоска + аудит, всё в одной транзакции. Без освобождения резервов
 * equipmentUnit застревал бы в ISSUED, а BookingItemUnit продолжал занимать
 * оборудование; без закрытия сессий брошенный чек-лист выдачи висел бы
 * «активным» на отменённой брони.
 *
 * Статус перепроверяется условным updateMany внутри транзакции: «Отменить» и
 * «Выдать» в одну секунду больше не проходят обе (выданная бронь становилась
 * «Отменена» с записью «Выдано» в журнале).
 *
 * `userId` — автор действия; для каналов без AdminUser (бот-ключ) сюда
 * приходит "system", как и раньше в маршруте.
 */
export async function cancelBookingWithSessions(
  bookingId: string,
  userId: string,
  patch: CancelBookingPatch = {},
) {
  await requireOrdinaryBooking(bookingId);
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { id: true, status: true },
  });
  if (!booking) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");
  if (!CANCELLABLE_STATUSES.includes(booking.status as (typeof CANCELLABLE_STATUSES)[number])) {
    throw invalidTransitionError(booking.status, "cancel");
  }

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const claimed = await tx.booking.updateMany({
      where: { id: bookingId, status: { in: [...CANCELLABLE_STATUSES] }, deletedAt: null },
      data: {
        status: "CANCELLED",
        expectedPaymentDate: patch.expectedPaymentDate,
        paymentComment: patch.paymentComment,
      },
    });
    if (claimed.count === 0) {
      const fresh = await tx.booking.findUnique({ where: { id: bookingId }, select: { status: true } });
      throw invalidTransitionError(fresh?.status ?? booking.status, "cancel");
    }
    const released = await releaseBookingUnits(bookingId, tx);
    const closed = await closeActiveScanSessions(tx, bookingId, { reason: "BOOKING_CANCELLED", actorUserId: userId });
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
        closedScanSessions: closed.length,
      }),
    });
    const updated = await tx.booking.findUniqueOrThrow({ where: { id: bookingId }, include: bookingInclude });
    return { booking: updated, closedScanSessions: closed.length };
  });
}

/** Отмена без подробностей о сессиях киоска — для bulk и прочих вызовов. */
export async function cancelBooking(
  bookingId: string,
  userId: string,
  patch: CancelBookingPatch = {},
) {
  return (await cancelBookingWithSessions(bookingId, userId, patch)).booking;
}

export type ArchiveBookingResult = {
  releasedReservations: number;
  freedUnits: number;
  /** Сколько сессий киоска закрыто (reason BOOKING_ARCHIVED). */
  closedScanSessions: number;
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
  await requireOrdinaryBooking(bookingId);
  const existing = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      status: true,
      projectName: true,
      startDate: true,
      endDate: true,
      deletedAt: true,
      parentBookingId: true,
    },
  });
  if (!existing) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");
  if (existing.deletedAt) {
    throw new HttpError(409, "Бронь уже в архиве", "BOOKING_ALREADY_ARCHIVED");
  }

  const released = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // В транзакции: продолжение могли отделить между чтением и архивацией.
    await assertFamilyAllowsArchive(tx, existing);
    // Условный updateMany: параллельная архивация между чтением и записью —
    // штатный 409, а не второй аудит и повторное закрытие.
    const claimed = await tx.booking.updateMany({
      where: { id: bookingId, deletedAt: null },
      data: { deletedAt: new Date(), deletedBy: userId },
    });
    if (claimed.count === 0) throw new HttpError(409, "Бронь уже в архиве", "BOOKING_ALREADY_ARCHIVED");
    const isTerminal = existing.status === "RETURNED" || existing.status === "CANCELLED";
    const rel = isTerminal
      ? { releasedReservations: 0, freedUnitIds: [] as string[] }
      : await releaseBookingUnits(bookingId, tx);
    // Архивная бронь ни выдаваться, ни приниматься в киоске больше не будет.
    const closed = await closeActiveScanSessions(tx, bookingId, { reason: "BOOKING_ARCHIVED", actorUserId: userId });
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
        closedScanSessions: closed.length,
      },
    });
    return { ...rel, closedScanSessions: closed.length };
  });

  return {
    releasedReservations: released.releasedReservations,
    freedUnits: released.freedUnitIds.length,
    closedScanSessions: released.closedScanSessions,
  };
}

/**
 * Восстановить архивированную бронь: deletedAt/deletedBy → null + аудит.
 * Резервы при восстановлении НЕ пересоздаются: активная бронь возвращается с
 * прежним статусом, и доступность оборудования на её даты проверяет оператор
 * (о чём предупреждает подтверждение в UI).
 *
 * @returns статус восстановленной брони (для побронного отчёта bulk).
 */
export async function restoreBooking(bookingId: string, userId: string): Promise<{ status: string }> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const existing = await tx.booking.findUnique({
      where: { id: bookingId },
      select: { id: true, deletedAt: true, deletedBy: true, status: true },
    });
    if (!existing) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");
    if (!existing.deletedAt) {
      throw new HttpError(409, "Бронь не в архиве — восстанавливать нечего", "BOOKING_NOT_ARCHIVED");
    }
    // Условный updateMany вместо update: гард «бронь в архиве» перепроверяется
    // атомарно на уровне SQL — конкурентный restore/purge между чтением выше и
    // этой строкой даёт штатный 409, а не восстановление/падение вслепую.
    const updated = await tx.booking.updateMany({
      where: { id: bookingId, deletedAt: { not: null } },
      data: { deletedAt: null, deletedBy: null },
    });
    if (updated.count === 0) {
      throw new HttpError(409, "Бронь не в архиве — восстанавливать нечего", "BOOKING_NOT_ARCHIVED");
    }
    await writeAuditEntry({
      tx,
      userId,
      action: "BOOKING_RESTORED",
      entityType: "Booking",
      entityId: bookingId,
      before: { deletedAt: existing.deletedAt.toISOString(), deletedBy: existing.deletedBy },
      after: null,
    });
    return { status: existing.status };
  });
}

/**
 * Окончательное удаление из БД. Только для УЖЕ архивированной брони (защита
 * от случайного hard-delete живой). Финансовый гард: purge каскадно уничтожил
 * бы счета (Invoice onDelete: Cascade — номерной документ, дыра/повтор в
 * нумерации) и отвязал бы платежи (Payment onDelete: SetNull — деньги-«сироты»
 * без клиента в /finance/payments). Блокируем при любых счетах и любых не
 * аннулированных платежах; проверка внутри транзакции — платёж, созданный
 * между проверкой и delete, не проскочит (SQLite write-lock).
 */
export async function purgeBooking(bookingId: string, userId: string): Promise<void> {
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const existing = await tx.booking.findUnique({
      where: { id: bookingId },
      select: { id: true, status: true, projectName: true, startDate: true, endDate: true, deletedAt: true },
    });
    if (!existing) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");
    if (!existing.deletedAt) {
      throw new HttpError(
        409,
        "Можно удалить навсегда только архивированную бронь. Сначала отправьте в архив.",
        "BOOKING_NOT_ARCHIVED",
      );
    }
    const [invoiceCount, paymentCount] = await Promise.all([
      tx.invoice.count({ where: { bookingId } }),
      tx.payment.count({ where: { bookingId, voidedAt: null } }),
    ]);
    await assertFamilyAllowsPurge(tx, bookingId);
    if (invoiceCount > 0 || paymentCount > 0) {
      throw new HttpError(
        409,
        "Нельзя удалить бронь навсегда: с ней связаны счета или платежи. Сначала аннулируйте счета и платежи.",
        "PURGE_HAS_FINANCE",
        { invoices: invoiceCount, payments: paymentCount },
      );
    }
    // Audit ПЕРЕД delete — иначе FK Restrict от AuditEntry на AdminUser
    // блокирует. Сам entityId записываем, ссылок на удалённую запись нет.
    await writeAuditEntry({
      tx,
      userId,
      action: "BOOKING_PURGED",
      entityType: "Booking",
      entityId: bookingId,
      before: diffFields(existing as Record<string, unknown>),
      after: null,
    });
    try {
      // Условный deleteMany: «только архивную» перепроверяется атомарно на
      // уровне SQL. Конкурентный restore между чтением выше и этой строкой →
      // count 0 → 409, и транзакция откатывает уже записанный аудит.
      const deleted = await tx.booking.deleteMany({
        where: { id: bookingId, deletedAt: { not: null } },
      });
      if (deleted.count === 0) {
        throw new HttpError(
          409,
          "Можно удалить навсегда только архивированную бронь. Сначала отправьте в архив.",
          "BOOKING_NOT_ARCHIVED",
        );
      }
    } catch (e: unknown) {
      // P2003 FK violation — например, остались записи через другие связанные
      // сущности без каскада. Возвращаем 409 с подсказкой.
      if ((e as { code?: string })?.code === "P2003") {
        throw new HttpError(
          409,
          "Бронь связана с историей аудита/финансов. Полное удаление невозможно.",
          "BOOKING_HAS_RELATIONS",
        );
      }
      throw e;
    }
  });
}
