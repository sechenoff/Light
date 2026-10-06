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
import Decimal from "decimal.js";
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
 *  - у продолжения — без смены дат и состава; продлить срок возврата можно
 *    (лишние смены — в смете продолжения сверх уже оплаченного).
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
    // Продление продолжения — только срок возврата: лишние смены уходят в его
    // же смету сверх уже оплаченного (continuationBilling от нового «до»).
    if (change.extend && !change.itemsChanged && !change.skipPartialDayChanged) {
      await assertNoLiveContinuations(client, booking.id, "продлевать");
      return;
    }
    if (change.datesChanged || change.itemsChanged || change.skipPartialDayChanged || change.extend) {
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

// ── Чтение семьи ─────────────────────────────────────────────────────────────

/** Бронь семьи — то, что нужно экранам и гардам. */
export type FamilyMember = {
  id: string;
  parentBookingId: string | null;
  rootBookingId: string | null;
  status: string;
  docNumber: string | null;
  startDate: Date;
  endDate: Date;
  deletedAt: Date | null;
};

const FAMILY_SELECT = {
  id: true,
  parentBookingId: true,
  rootBookingId: true,
  status: true,
  docNumber: true,
  startDate: true,
  endDate: true,
  deletedAt: true,
} as const;

/**
 * Вся семья брони: основная и все продолжения (одна выборка по rootBookingId).
 * У обычной брони без продолжений — только она сама, и это один дешёвый запрос.
 */
export async function loadFamily(
  client: Db,
  booking: { id: string; rootBookingId: string | null },
): Promise<FamilyMember[]> {
  const rootId = booking.rootBookingId ?? booking.id;
  return client.booking.findMany({
    where: { OR: [{ id: rootId }, { rootBookingId: rootId }] },
    select: FAMILY_SELECT,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

/** Продолжения ниже брони по цепочке (дети, их дети…). */
export function descendantsOf(members: FamilyMember[], bookingId: string): FamilyMember[] {
  const out: FamilyMember[] = [];
  const queue = [bookingId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const m of members) {
      if (m.parentBookingId === id) {
        out.push(m);
        queue.push(m.id);
      }
    }
  }
  return out;
}

/** Живое (не отменённое, не в архиве) продолжение ниже брони, которое ещё у клиента. */
export function issuedDescendants(members: FamilyMember[], bookingId: string): FamilyMember[] {
  return descendantsOf(members, bookingId).filter((m) => m.status === "ISSUED" && m.deletedAt == null);
}

/**
 * Часть оборудования брони ещё у клиента по продолжению. Тогда основная
 * бронь показывается «Возвращена частично», а акт по ней ждёт приёмки
 * остатка. У обычной брони — ни одного лишнего запроса сверх одного.
 */
export async function hasIssuedDescendant(
  client: Db,
  booking: { id: string; rootBookingId: string | null },
): Promise<boolean> {
  const child = await client.booking.findFirst({ where: { parentBookingId: booking.id }, select: { id: true } });
  if (!child) return false;
  return issuedDescendants(await loadFamily(client, booking), booking.id).length > 0;
}

/** 409: акт по брони ждёт, пока продолжение не примут. */
export function actWaitsForContinuationError(): HttpError {
  return new HttpError(
    409,
    "Акт недоступен: часть оборудования ещё у клиента по продолжению брони — акт будет после приёмки остатка",
    "ACT_NOT_AVAILABLE",
    { reason: "CONTINUATION_STILL_OUT" },
  );
}

/**
 * Номер и дата сметы основной брони — для документа продолжения («продолжение
 * к смете № … от …»). У обычной брони — null.
 */
export async function continuationOrigin(
  client: Db,
  booking: { parentBookingId: string | null; rootBookingId: string | null },
): Promise<{ docNumber: string | null; createdAt: Date } | null> {
  if (!booking.parentBookingId) return null;
  return client.booking.findUnique({
    where: { id: booking.rootBookingId ?? booking.parentBookingId },
    select: { docNumber: true, createdAt: true },
  });
}

/** Что карточка брони показывает о семье. null — обычная бронь без продолжений. */
export type BookingFamilySummary = {
  /** Бронь, из которой перешло оставленное (у продолжения). */
  parent: { id: string; docNumber: string | null } | null;
  /** Основная бронь цепочки (у продолжения). */
  root: { id: string; docNumber: string | null } | null;
  /** Продолжения ниже этой брони — в порядке создания. */
  continuations: Array<{
    id: string;
    docNumber: string | null;
    status: string;
    startDate: string;
    endDate: string;
    /** Сколько единиц в продолжении (у клиента, пока оно выдано). */
    quantity: number;
    finalAmount: string;
    amountOutstanding: string;
  }>;
  /** Бронь возвращена, а часть оборудования ещё у клиента по продолжению. */
  partiallyReturned: boolean;
  /** Итог вместе с продолжениями ниже — только когда они есть. Показ, не расчёт. */
  totals: { finalAmount: string; amountPaid: string; amountOutstanding: string } | null;
};

/** Семья для карточки брони: родитель, продолжения ниже, итоги вместе с ними. */
export async function bookingFamilySummary(
  client: Db,
  booking: { id: string; status: string; parentBookingId: string | null; rootBookingId: string | null },
): Promise<BookingFamilySummary | null> {
  if (!booking.parentBookingId && !(await client.booking.findFirst({ where: { parentBookingId: booking.id }, select: { id: true } }))) {
    return null;
  }
  const members = await loadFamily(client, booking);
  const byId = new Map(members.map((m) => [m.id, m]));
  const order = new Map(members.map((m, i) => [m.id, i]));
  const below = descendantsOf(members, booking.id)
    .filter((m) => m.status !== "CANCELLED" && m.deletedAt == null)
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  // Только отменённые продолжения — семьи для карточки нет.
  if (!booking.parentBookingId && below.length === 0) return null;
  const money = below.length
    ? await client.booking.findMany({
        where: { id: { in: [booking.id, ...below.map((m) => m.id)] } },
        select: {
          id: true,
          finalAmount: true,
          amountPaid: true,
          amountOutstanding: true,
          items: { select: { quantity: true } },
        },
      })
    : [];
  const moneyById = new Map(money.map((m) => [m.id, m]));
  const sum = (field: "finalAmount" | "amountPaid" | "amountOutstanding") =>
    money.reduce((s, m) => s.add(m[field].toString()), new Decimal(0)).toFixed(2);
  const parent = booking.parentBookingId ? byId.get(booking.parentBookingId) : undefined;
  const rootId = booking.rootBookingId ?? null;
  const root = rootId ? byId.get(rootId) : undefined;
  return {
    parent: booking.parentBookingId ? { id: booking.parentBookingId, docNumber: parent?.docNumber ?? null } : null,
    root: rootId ? { id: rootId, docNumber: root?.docNumber ?? null } : null,
    continuations: below.map((m) => {
      const mm = moneyById.get(m.id);
      return {
        id: m.id,
        docNumber: m.docNumber,
        status: m.status,
        startDate: m.startDate.toISOString(),
        endDate: m.endDate.toISOString(),
        quantity: mm ? mm.items.reduce((s, i) => s + i.quantity, 0) : 0,
        finalAmount: mm ? new Decimal(mm.finalAmount.toString()).toFixed(2) : "0.00",
        amountOutstanding: mm ? new Decimal(mm.amountOutstanding.toString()).toFixed(2) : "0.00",
      };
    }),
    partiallyReturned: booking.status === "RETURNED" && below.some((m) => m.status === "ISSUED"),
    totals: below.length ? { finalAmount: sum("finalAmount"), amountPaid: sum("amountPaid"), amountOutstanding: sum("amountOutstanding") } : null,
  };
}

/**
 * Смена клиента: у основной брони, её продолжений и у самого продолжения
 * клиент общий — долг, акт и кабинет клиента читаются по семье. Сменить
 * одну бронь значило бы развести их; это делается только вручную по всей
 * семье, поэтому здесь — 409.
 */
export async function assertFamilyAllowsClientChange(
  client: Db,
  booking: { id: string; parentBookingId: string | null },
): Promise<void> {
  if (isContinuation(booking) || (await countLiveContinuations(client, booking.id)) > 0) {
    throw new HttpError(
      409,
      "У брони есть продолжение — клиента не сменить у одной брони семьи: основная и продолжения принадлежат одному клиенту",
      FAMILY_ERROR_CODES.HAS_CONTINUATION,
      { bookingId: booking.id },
    );
  }
}

/**
 * Перепроверка внутри транзакции правки: между чтением и записью бронь могли
 * принять или разделить (частичная приёмка) — тогда правка, проверенная по
 * старому состоянию, сдвинула бы срок, на котором стоит расчёт продолжения.
 */
export async function assertUnchangedSinceRead(
  client: Db,
  booking: { id: string; status: string; splitRevision: number },
): Promise<void> {
  const fresh = await client.booking.findUnique({
    where: { id: booking.id },
    select: { status: true, splitRevision: true },
  });
  if (!fresh || fresh.status !== booking.status || fresh.splitRevision !== booking.splitRevision) {
    throw new HttpError(409, "Бронь только что приняли или разделили — обновите карточку", "INVALID_BOOKING_STATE");
  }
}
