import type { BookingStatus, Prisma } from "@prisma/client";

import { prisma } from "../prisma";
import { writeAuditEntry, diffFields } from "./audit";
import { invalidTransitionError } from "./bookingLifecycle";
import { assertProjectStockForBooking } from "./projectStockGuard";
import { closeActiveScanSessions } from "./scanSessionPolicy";

/** Бронь, которую возвращают ручные «Выдать» / «Вернуть». */
const MANUAL_STATUS_INCLUDE = {
  client: true,
  items: { include: { equipment: true } },
  estimates: { include: { lines: true } },
} as const;

export type ManualStatusAction = "issue" | "return";

/**
 * Ручные «Выдать» / «Вернуть» (без киоска) — одной транзакцией: условный
 * захват статуса, реконсиляция UNIT-резервов, закрытие брошенных сессий
 * киоска, аудит. Вынесено из маршрута POST /:id/status, чтобы приёмку можно
 * было вызвать из других сервисов (частичный возврат) с теми же правилами.
 *
 * Ручные «Выдать»/«Вернуть» обязаны реконсилировать UNIT-резервы в той же
 * транзакции — раньше менялся только статус брони, и юниты застревали в
 * ISSUED (после ручного «Вернуть») или числились AVAILABLE на руках у клиента
 * (после ручного «Выдать»). Семантика согласована с
 * warehouseScan.completeSession: юниты, уже обработанные сканером или
 * живущие своим циклом (MAINTENANCE/RETIRED/MISSING), не трогаем — фильтруем
 * по текущему статусу.
 */
export async function setBookingIssuedOrReturnedManually(a: {
  bookingId: string;
  /** Статус, из которого переводим: захват — по нему (второе нажатие получает 409). */
  fromStatus: BookingStatus;
  /** Текущий issuedAt брони: момент выдачи пишется, только если его ещё нет. */
  issuedAt: Date | null;
  action: ManualStatusAction;
  /** Ранняя выдача подтверждена (гард ISSUE_TOO_EARLY): фиксируется в аудите. */
  force?: boolean;
  /** AdminUser.id; null — канал без пользователя (бот-ключ), аудит пропускается. */
  actorUserId: string | null;
  patch: {
    status: BookingStatus;
    expectedPaymentDate?: Date | null;
    paymentComment?: string | null;
  };
}) {
  const id = a.bookingId;
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Первой записью — условный переход статуса: проверка «можно ли» до
    // транзакции не защищает от второго нажатия и второго сотрудника.
    // Три быстрых «Вернуть» писали три события, «Отменить» ‖ «Выдать»
    // проходили обе. Теперь проигравший получает 409 и откат.
    const claimed = await tx.booking.updateMany({
      where: { id, status: a.fromStatus, deletedAt: null },
      data: {
        ...a.patch,
        // Момент фактической выдачи — как в киоске: пишем только если ещё null.
        ...(a.action === "issue" && !a.issuedAt ? { issuedAt: new Date() } : {}),
      },
    });
    if (claimed.count === 0) {
      const fresh = await tx.booking.findUnique({ where: { id }, select: { status: true } });
      throw invalidTransitionError(fresh?.status ?? a.fromStatus, a.action);
    }
    if (a.action === "issue") await assertProjectStockForBooking(tx, id);

    // Живые резервы брони (returnedAt: null) — история приёмки не трогается.
    const reservations = await tx.bookingItemUnit.findMany({
      where: { bookingItem: { bookingId: id }, returnedAt: null },
      select: { id: true, equipmentUnitId: true },
    });
    let touchedUnits = 0;
    if (reservations.length > 0) {
      const unitIds = Array.from(new Set(reservations.map((r) => r.equipmentUnitId)));
      if (a.action === "issue") {
        // Выдача: только свободные юниты → ISSUED (выданные сканером уже ISSUED).
        const res = await tx.equipmentUnit.updateMany({
          where: { id: { in: unitIds }, status: "AVAILABLE" },
          data: { status: "ISSUED" },
        });
        touchedUnits = res.count;
      } else {
        // Возврат: резервы закрываем returnedAt (сохраняем историю, как
        // scan-return), выданные юниты → AVAILABLE.
        await tx.bookingItemUnit.updateMany({
          where: { id: { in: reservations.map((r) => r.id) } },
          data: { returnedAt: new Date() },
        });
        const res = await tx.equipmentUnit.updateMany({
          where: { id: { in: unitIds }, status: "ISSUED" },
          data: { status: "AVAILABLE" },
        });
        touchedUnits = res.count;
      }
    }

    // Брошенный в киоске чек-лист этой брони больше не нужен: выдачу/приёмку
    // оформили кнопкой. Раньше сессия оставалась ACTIVE навсегда и запирала
    // «+ Добор» со страницы (на проде 8 таких сессий на принятых бронях).
    const closed = await closeActiveScanSessions(tx, id, {
      reason: a.action === "issue" ? "BOOKING_ISSUED_MANUALLY" : "BOOKING_RETURNED_MANUALLY",
      actorUserId: a.actorUserId,
    });

    // Аудит выдачи/возврата — headline-событие пишем ВСЕГДА, не только при
    // UNIT-резервах: физически самые важные операции (оборудование ушло со
    // склада / вернулось) должны быть видны в /admin/audit и для COUNT-броней.
    // Пропускаем только канал без AdminUser (bot-ключ) — userId это FK,
    // синтетический sentinel уронил бы транзакцию.
    if (a.actorUserId) {
      await writeAuditEntry({
        tx,
        userId: a.actorUserId,
        action: a.action === "issue" ? "BOOKING_ISSUED" : "BOOKING_RETURNED",
        entityType: "Booking",
        entityId: id,
        before: diffFields({ status: a.fromStatus }),
        after: diffFields({
          status: a.patch.status,
          via: `status:${a.action}`,
          reservations: reservations.length,
          unitsUpdated: touchedUnits,
          closedScanSessions: closed.length,
          ...(a.action === "issue" && a.force ? { forcedEarlyIssue: true } : {}),
        }),
      });
    }
    const u = await tx.booking.findUniqueOrThrow({ where: { id }, include: MANUAL_STATUS_INCLUDE });
    return { booking: u, closedScanSessions: closed.length };
  });
}
