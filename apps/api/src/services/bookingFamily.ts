/**
 * Семья броней: основная бронь и её продолжения.
 *
 * Продолжение появляется при частичной приёмке: основная бронь закрывается, а
 * оставленное у клиента переходит в связанную бронь со своей сметой и
 * оплатой (Booking.parentBookingId / rootBookingId). Пока продолжение живо,
 * некоторые правки ломали бы семью, поэтому они под гардами здесь — в
 * сервисах, чтобы одиночные, групповые и API-пути шли через одно правило:
 *
 *  - у брони с продолжением нельзя менять даты (включая задним числом),
 *    состав задним числом, архивировать и удалять: расчёт продолжения стоит на
 *    её сроке и её смете. «Бумажные» поля — комментарий, скидка, договорной
 *    итог, водители — править можно;
 *  - у продолжения нельзя менять начало и состав, делать добор (новое
 *    оборудование — новая бронь), архивировать пока оно у клиента. Продление
 *    продолжения появится вместе с дополнительной сметой сверх оплаченного.
 */
import type { Prisma } from "@prisma/client";

import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";

type Db = Prisma.TransactionClient | typeof prisma;

export const FAMILY_ERROR_CODES = {
  HAS_CONTINUATION: "HAS_CONTINUATION",
  CONTINUATION_EDIT_FORBIDDEN: "CONTINUATION_EDIT_FORBIDDEN",
  CONTINUATION_ADDON_FORBIDDEN: "CONTINUATION_ADDON_FORBIDDEN",
  CONTINUATION_EXTEND_NOT_YET: "CONTINUATION_EXTEND_NOT_YET",
  CONTINUATION_STILL_OUT: "CONTINUATION_STILL_OUT",
} as const;

/** Продолжение ли это (бронь, в которую перешло оставленное у клиента). */
export function isContinuation(b: { parentBookingId: string | null }): boolean {
  return b.parentBookingId != null;
}

/**
 * Живые продолжения брони: не отменённые и не в архиве. Отменённое
 * продолжение («всё вернули при приёмке основной») семью уже не держит.
 */
export async function countLiveContinuations(client: Db, bookingId: string): Promise<number> {
  return client.booking.count({
    where: { parentBookingId: bookingId, status: { not: "CANCELLED" }, deletedAt: null },
  });
}

/** 409 HAS_CONTINUATION, если у брони есть живое продолжение. `what` — что именно нельзя. */
export async function assertNoLiveContinuations(client: Db, bookingId: string, what: string): Promise<void> {
  if ((await countLiveContinuations(client, bookingId)) > 0) {
    throw new HttpError(
      409,
      `У брони есть продолжение — ${what} нельзя: расчёт продолжения стоит на сроке и смете этой брони`,
      FAMILY_ERROR_CODES.HAS_CONTINUATION,
      { bookingId },
    );
  }
}

/**
 * Правка брони (PATCH /api/bookings/:id) в семье:
 *  - у брони с продолжением — без смены дат и состава;
 *  - у продолжения — без смены дат, состава и продления (продление появится
 *    вместе с дополнительной сметой сверх оплаченного).
 */
export async function assertFamilyAllowsEdit(
  client: Db,
  booking: { id: string; parentBookingId: string | null },
  change: {
    datesChanged: boolean;
    itemsChanged: boolean;
    extend: boolean;
    /** «Не считать вторые сутки» поменяли — в семье это сдвинуло бы оплаченный срок. */
    skipPartialDayChanged?: boolean;
  },
): Promise<void> {
  if (isContinuation(booking)) {
    if (change.extend) {
      throw new HttpError(
        409,
        "Продлить продолжение брони пока нельзя — это появится вместе с дополнительной сметой сверх оплаченного",
        FAMILY_ERROR_CODES.CONTINUATION_EXTEND_NOT_YET,
      );
    }
    if (change.datesChanged || change.itemsChanged || change.skipPartialDayChanged) {
      throw new HttpError(
        409,
        "У продолжения брони даты, состав и «не считать вторые сутки» не правятся: они пришли из приёмки основной брони",
        FAMILY_ERROR_CODES.CONTINUATION_EDIT_FORBIDDEN,
      );
    }
  }
  if (change.datesChanged || change.itemsChanged || change.extend || change.skipPartialDayChanged) {
    await assertNoLiveContinuations(
      client,
      booking.id,
      change.itemsChanged
        ? "править состав"
        : change.skipPartialDayChanged && !change.datesChanged && !change.extend
          ? "менять «не считать вторые сутки»"
          : "менять даты",
    );
  }
}

/** Добор (карточка брони, поиск добора): у продолжения — 409, новое оборудование — новая бронь. */
export function assertAddonAllowedForFamily(booking: { parentBookingId: string | null }): void {
  if (isContinuation(booking)) {
    throw new HttpError(
      409,
      "В продолжение брони добор не делается — новое оборудование оформите отдельной бронью",
      FAMILY_ERROR_CODES.CONTINUATION_ADDON_FORBIDDEN,
    );
  }
}

/**
 * Архивация: у брони с живым продолжением — нельзя; продолжение, которое ещё
 * у клиента, — тоже (его закрывает приёмка или «Отменить продолжение»).
 */
export async function assertFamilyAllowsArchive(
  client: Db,
  booking: { id: string; status: string; parentBookingId: string | null },
): Promise<void> {
  if (isContinuation(booking) && booking.status === "ISSUED") {
    throw new HttpError(
      409,
      "Продолжение брони ещё у клиента — примите остаток или отмените продолжение",
      FAMILY_ERROR_CODES.CONTINUATION_STILL_OUT,
    );
  }
  await assertNoLiveContinuations(client, booking.id, "отправлять в архив");
}

/** Удаление навсегда: бронь, от которой отделяли продолжения (даже отменённые), не удаляется. */
export async function assertFamilyAllowsPurge(client: Db, bookingId: string): Promise<void> {
  const children = await client.booking.count({ where: { parentBookingId: bookingId } });
  if (children > 0) {
    throw new HttpError(
      409,
      "От брони отделялись продолжения — удалить её навсегда нельзя, иначе они потеряют основную бронь",
      FAMILY_ERROR_CODES.HAS_CONTINUATION,
      { bookingId },
    );
  }
}
