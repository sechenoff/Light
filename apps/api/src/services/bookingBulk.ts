import type { UserRole } from "@prisma/client";

import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";
import { approveBooking, autoConfirmBooking, approvalMode, submitForApproval } from "./bookingApproval";
import { archiveBooking, cancelBooking, purgeBooking, restoreBooking } from "./bookingLifecycle";
import { createFinanceEvent, recomputeBookingFinance } from "./finance";

/**
 * Групповые действия над бронями (мультивыбор на /bookings и /bookings/archive).
 *
 * Ключевое свойство: КАЖДАЯ бронь обрабатывается изолированно. Пачка из 30
 * броней, где две конфликтуют по доступности оборудования, не должна
 * откатывать остальные 28 — оператор получает отчёт «выполнено 28, не удалось
 * 2» с причиной по каждой. Поэтому здесь нет общей транзакции: атомарность
 * живёт внутри каждой отдельной операции (approveBooking / cancelBooking /
 * archiveBooking / restoreBooking / purgeBooking сами обёрнуты в $transaction).
 *
 * Обработка последовательная, а не Promise.all: SQLite пишет в один поток, и
 * параллельные транзакции дали бы SQLITE_BUSY вместо ускорения.
 */

export const BULK_ACTIONS = ["approve", "submit", "cancel", "archive", "restore", "purge"] as const;
export type BulkBookingAction = (typeof BULK_ACTIONS)[number];

/** Потолок пачки: защита от случайного «выбрать всё» на тысячах броней. */
export const BULK_MAX_IDS = 100;

export type BulkItemResult =
  | { id: string; ok: true; status: string }
  | { id: string; ok: false; code: string; message: string };

export type BulkBookingResult = {
  action: BulkBookingAction;
  results: BulkItemResult[];
  counts: { total: number; ok: number; failed: number };
};

/** Роли, которым в принципе доступно действие. Точечные ограничения — ниже. */
const ROLES_BY_ACTION: Record<BulkBookingAction, UserRole[]> = {
  approve: ["SUPER_ADMIN"],
  submit: ["SUPER_ADMIN", "WAREHOUSE"],
  cancel: ["SUPER_ADMIN", "WAREHOUSE"],
  archive: ["SUPER_ADMIN"],
  // Архивные операции (страница /bookings/archive) — как одиночные
  // /:id/restore и /:id/purge: только руководитель.
  restore: ["SUPER_ADMIN"],
  purge: ["SUPER_ADMIN"],
};

export function assertBulkActionAllowed(action: BulkBookingAction, role: UserRole): void {
  if (!ROLES_BY_ACTION[action].includes(role)) {
    throw new HttpError(403, "Действие недоступно для вашей роли", "FORBIDDEN_BY_ROLE");
  }
}

/** Ошибка одной брони → машинный код + человеческий текст для отчёта. */
function toItemFailure(id: string, err: unknown): BulkItemResult {
  if (err instanceof HttpError) {
    return { id, ok: false, code: err.code ?? "BULK_ITEM_FAILED", message: err.message };
  }
  return {
    id,
    ok: false,
    code: "BULK_ITEM_FAILED",
    message: err instanceof Error ? err.message : "Неизвестная ошибка",
  };
}

/**
 * Финансовые побочки после смены статуса — best-effort, как в одиночных
 * маршрутах: провал пересчёта не отменяет уже совершённое действие.
 */
async function syncFinanceAfter(bookingId: string, eventType: string, payload: Record<string, unknown>) {
  try {
    await recomputeBookingFinance(bookingId);
    await createFinanceEvent({ bookingId, eventType, payload });
  } catch (financeErr) {
    // eslint-disable-next-line no-console
    console.error(`Finance side-effects failed after bulk ${eventType} (${bookingId}):`, financeErr);
  }
}

/** Архивированную бронь не трогаем ни одним действием — как assertBookingNotArchived. */
async function assertNotArchived(bookingId: string): Promise<void> {
  const row = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { deletedAt: true },
  });
  if (!row) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");
  if (row.deletedAt) {
    throw new HttpError(409, "Бронь в архиве", "BOOKING_ARCHIVED");
  }
}

async function runOne(
  id: string,
  action: BulkBookingAction,
  userId: string,
  role: UserRole,
): Promise<BulkItemResult> {
  if (action === "archive") {
    await archiveBooking(id, userId);
    return { id, ok: true, status: "ARCHIVED" };
  }

  // restore/purge оперируют именно архивными бронями — «не в архиве» для них
  // штатный побронный отказ (409 BOOKING_NOT_ARCHIVED из lifecycle-сервиса),
  // а не предусловие всей пачки.
  if (action === "restore") {
    const restored = await restoreBooking(id, userId);
    return { id, ok: true, status: restored.status };
  }

  if (action === "purge") {
    await purgeBooking(id, userId);
    return { id, ok: true, status: "PURGED" };
  }

  await assertNotArchived(id);

  if (action === "approve") {
    const updated = await approveBooking(id, userId);
    await syncFinanceAfter(id, "BOOKING_CONFIRMED", { status: updated.status, via: "bulk-approve" });
    return { id, ok: true, status: updated.status };
  }

  if (action === "submit") {
    // APPROVAL_MODE=auto: согласование выключено — «отправить» сразу
    // подтверждает бронь, ровно как одиночный submit-for-approval.
    const updated =
      approvalMode() === "auto"
        ? await autoConfirmBooking(id, userId)
        : await submitForApproval(id, userId);
    if (approvalMode() === "auto") {
      await syncFinanceAfter(id, "BOOKING_CONFIRMED", { status: updated.status, via: "bulk-auto" });
    }
    return { id, ok: true, status: updated.status };
  }

  // cancel: оплаченную бронь пачкой не отменяем — депозит требует явного
  // распоряжения (возврат / кредит-нота / удержание), это осознанное решение
  // по каждой брони, а не побочный эффект галочки в списке.
  const money = await prisma.booking.findUnique({
    where: { id },
    select: { amountPaid: true },
  });
  if (!money) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");
  if (Number(money.amountPaid) > 0) {
    throw new HttpError(
      409,
      "По брони есть оплата — отмените её отдельно, распорядившись депозитом",
      "BULK_CANCEL_PAID",
    );
  }
  const cancelled = await cancelBooking(id, userId);
  await syncFinanceAfter(id, "BOOKING_STATUS_CHANGED", {
    to: "CANCELLED",
    action: "cancel",
    via: "bulk",
  });
  return { id, ok: true, status: cancelled.status };
}

export async function runBulkBookingAction(args: {
  ids: string[];
  action: BulkBookingAction;
  userId: string;
  role: UserRole;
}): Promise<BulkBookingResult> {
  const { action, userId, role } = args;
  assertBulkActionAllowed(action, role);

  // Дубли в выборке — не ошибка ввода, а следствие двойного клика; схлопываем.
  const ids = Array.from(new Set(args.ids));
  if (ids.length === 0) {
    throw new HttpError(400, "Не выбрано ни одной брони", "BULK_EMPTY_SELECTION");
  }
  if (ids.length > BULK_MAX_IDS) {
    throw new HttpError(
      400,
      `За один раз можно обработать не больше ${BULK_MAX_IDS} броней`,
      "BULK_TOO_MANY",
    );
  }

  const results: BulkItemResult[] = [];
  for (const id of ids) {
    try {
      results.push(await runOne(id, action, userId, role));
    } catch (err) {
      results.push(toItemFailure(id, err));
    }
  }

  const ok = results.filter((r) => r.ok).length;
  return {
    action,
    results,
    counts: { total: results.length, ok, failed: results.length - ok },
  };
}
