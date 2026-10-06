/**
 * «Часть не вернули» — исправление приёмки (этап 14b, мокап m4, состояние D).
 *
 * Бронь приняли целиком, а потом выяснилось, что часть осталась у клиента.
 * В течение 7 дней после приёмки оставленное оформляется продолжением брони —
 * тем же разделением, что и «Вернули не всё», но от момента приёмки:
 *  - продолжение выдано с момента приёмки, смены сверх оплаченного считаются
 *    от него (клиент держал позицию всё это время);
 *  - у штучной позиции отмечают, какие именно единицы не вернули: их закрытый
 *    резерв снова открывается и переходит к продолжению, единица — «Выдана»;
 *  - не больше, чем осталось: всего в позиции минус уже в продолжениях, в
 *    ремонте и в «Потеряшках» с этой брони;
 *  - пока идёт инвентаризация, исправление запрещено: оно сдвинуло бы «на
 *    полке должно быть» посреди пересчёта.
 */
import type { Prisma } from "@prisma/client";

import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";
import { writeAuditEntry } from "./audit";
import {
  continuationPreviewsInTx,
  itemCoverage,
  PARTIAL_RETURN_ERROR_CODES,
  PARTIAL_RETURN_TX_OPTIONS,
  PreviewRollback,
  splitOffContinuationsInTx,
  stayPaymentDates,
  type BookingWithItems,
  type ContinuationPreview,
  type StayConflict,
  type StayInput,
} from "./bookingContinuation";
import { paidThroughAt } from "./continuationPricing";

/** Сколько после приёмки можно исправить «Часть не вернули». */
export const RETURN_CORRECTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export const RETURN_CORRECTION_CODES = {
  NOT_RETURNED: "RETURN_CORRECTION_NOT_RETURNED",
  NO_RETURN_RECORD: "RETURN_CORRECTION_NO_RETURN_RECORD",
  WINDOW_CLOSED: "RETURN_CORRECTION_WINDOW_CLOSED",
  STOCK_COUNT_OPEN: "RETURN_CORRECTION_STOCK_COUNT_OPEN",
  OVER_CAP: "RETURN_CORRECTION_OVER_CAP",
  UNIT_NOT_ON_SHELF: "RETURN_CORRECTION_UNIT_NOT_ON_SHELF",
} as const;

type Db = Prisma.TransactionClient | typeof prisma;

/** Почему исправить нельзя — для окна и меню карточки. */
export type CorrectionBlock = "NOT_RETURNED" | "NO_RETURN_RECORD" | "WINDOW_CLOSED" | "STOCK_COUNT_OPEN";

/** Строка исправления: сколько можно отметить «не вернули» и почему не больше. */
export type CorrectionLine = {
  bookingItemId: string;
  equipmentId: string | null;
  name: string;
  /** Не больше скольких можно отметить. */
  quantity: number;
  unitTracked: boolean;
  /** Штучная позиция — единицы, которые по учёту на складе (их и можно отметить). */
  units: Array<{ id: string; label: string | null }>;
  paidThrough: string;
  plannedStayUntil: null;
  /** Из чего потолок: в брони, уже в продолжениях, в ремонте, в «Потеряшках». */
  booked: number;
  inContinuations: number;
  inRepair: number;
  inProblems: number;
};

export type CorrectionPlan = {
  bookingId: string;
  docNumber: string | null;
  splitRevision: number;
  /** Когда приняли (ISO); null — приёмки в журнале нет. */
  returnedAt: string | null;
  /** До когда можно исправить (ISO). */
  correctableUntil: string | null;
  /** Можно ли исправлять сейчас; иначе — почему нет. */
  blockedBy: CorrectionBlock | null;
  lines: CorrectionLine[];
};

/** Когда бронь приняли: последняя запись «Бронь возвращена» в журнале. */
async function returnMoment(client: Db, bookingId: string): Promise<Date | null> {
  const entry = await client.auditEntry.findFirst({
    where: { entityType: "Booking", entityId: bookingId, action: "BOOKING_RETURNED" },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  return entry?.createdAt ?? null;
}

async function loadReturned(client: Db, bookingId: string): Promise<BookingWithItems> {
  const booking = await client.booking.findUnique({
    where: { id: bookingId },
    include: { items: true, estimates: { include: { lines: true } } },
  });
  if (!booking || booking.deletedAt) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");
  return booking;
}

/** Что мешает исправлению, по порядку важности. */
async function correctionBlock(
  client: Db,
  booking: BookingWithItems,
  returnedAt: Date | null,
  now: Date,
): Promise<CorrectionBlock | null> {
  if (booking.mode !== "STANDARD" || booking.status !== "RETURNED") return "NOT_RETURNED";
  if (!returnedAt) return "NO_RETURN_RECORD";
  if (now.getTime() > returnedAt.getTime() + RETURN_CORRECTION_WINDOW_MS) return "WINDOW_CLOSED";
  if ((await client.stockCount.count({ where: { status: "OPEN" } })) > 0) return "STOCK_COUNT_OPEN";
  return null;
}

const BLOCK_ERRORS: Record<CorrectionBlock, [number, string, string]> = {
  NOT_RETURNED: [409, "Исправить приёмку можно только у принятой брони", RETURN_CORRECTION_CODES.NOT_RETURNED],
  NO_RETURN_RECORD: [409, "В журнале нет приёмки этой брони — исправить её нельзя", RETURN_CORRECTION_CODES.NO_RETURN_RECORD],
  WINDOW_CLOSED: [409, "Исправить приёмку можно в течение 7 дней — срок прошёл", RETURN_CORRECTION_CODES.WINDOW_CLOSED],
  STOCK_COUNT_OPEN: [409, "Идёт инвентаризация — исправьте приёмку после её завершения", RETURN_CORRECTION_CODES.STOCK_COUNT_OPEN],
};

function throwBlock(block: CorrectionBlock): never {
  const [status, message, code] = BLOCK_ERRORS[block];
  throw new HttpError(status, message, code);
}

/**
 * Потолок «не вернули» по каждой позиции и единицы на складе. Считается одним
 * набором запросов на всю бронь.
 */
async function correctionLines(client: Db, booking: BookingWithItems): Promise<CorrectionLine[]> {
  const equipmentIds = booking.items.map((i) => i.equipmentId).filter((v): v is string => v != null);
  const [equipment, children, repairs, problems, reserves] = await Promise.all([
    client.equipment.findMany({ where: { id: { in: equipmentIds } }, select: { id: true, name: true, stockTrackingMode: true } }),
    client.booking.findMany({
      where: { parentBookingId: booking.id, status: { not: "CANCELLED" }, deletedAt: null },
      select: { items: { select: { equipmentId: true, customName: true, quantity: true } } },
    }),
    client.repair.findMany({
      where: { sourceBookingId: booking.id },
      select: { bookingItemId: true, equipmentId: true, quantity: true, unit: { select: { equipmentId: true } } },
    }),
    client.problemItem.findMany({
      where: { sourceBookingId: booking.id },
      select: { bookingItemId: true, equipmentId: true, quantity: true, equipmentUnit: { select: { equipmentId: true } } },
    }),
    client.bookingItemUnit.findMany({
      where: { bookingItem: { bookingId: booking.id }, returnedAt: { not: null } },
      select: {
        bookingItemId: true,
        equipmentUnit: {
          select: {
            id: true,
            status: true,
            internalInventoryNumber: true,
            bookingItemUnits: { where: { returnedAt: null }, select: { id: true } },
          },
        },
      },
    }),
  ]);
  const eqById = new Map(equipment.map((e) => [e.id, e]));
  const childItems = children.flatMap((c) => c.items);
  return booking.items.map((it): CorrectionLine => {
    const eq = it.equipmentId ? eqById.get(it.equipmentId) : undefined;
    const same = (row: { bookingItemId?: string | null; equipmentId: string | null }, unitEquipmentId?: string | null) =>
      row.bookingItemId === it.id ||
      (it.equipmentId != null && (row.equipmentId === it.equipmentId || unitEquipmentId === it.equipmentId));
    const inContinuations = childItems
      .filter((c) => (it.equipmentId ? c.equipmentId === it.equipmentId : c.customName === it.customName))
      .reduce((n, c) => n + c.quantity, 0);
    const inRepair = repairs.filter((r) => same(r, r.unit?.equipmentId)).reduce((n, r) => n + r.quantity, 0);
    const inProblems = problems.filter((p) => same(p, p.equipmentUnit?.equipmentId)).reduce((n, p) => n + p.quantity, 0);
    const unitTracked = eq?.stockTrackingMode === "UNIT";
    // Отметить можно только единицу, которая по учёту на складе: свободна и
    // ни у кого не в живом резерве. Выданную с тех пор другой брони клиент
    // держать не может.
    const seen = new Set<string>();
    const units = unitTracked
      ? reserves
          .filter((r) => r.bookingItemId === it.id)
          .map((r) => r.equipmentUnit)
          .filter((u) => {
            if (seen.has(u.id) || u.status !== "AVAILABLE" || u.bookingItemUnits.length > 0) return false;
            seen.add(u.id);
            return true;
          })
          .map((u) => ({ id: u.id, label: u.internalInventoryNumber }))
      : [];
    const left = Math.max(0, it.quantity - inContinuations - inRepair - inProblems);
    return {
      bookingItemId: it.id,
      equipmentId: it.equipmentId,
      name: eq?.name ?? it.customName ?? "Позиция",
      quantity: unitTracked ? Math.min(left, units.length) : left,
      unitTracked,
      units,
      paidThrough: paidThroughAt(itemCoverage(booking, it), booking.skipPartialDay).toISOString(),
      plannedStayUntil: null,
      booked: it.quantity,
      inContinuations,
      inRepair,
      inProblems,
    };
  });
}

/** План исправления для окна «Часть не вернули»; всегда 200 — `blockedBy` объясняет отказ. */
export async function getCorrectionPlan(bookingId: string, now = new Date()): Promise<CorrectionPlan> {
  const booking = await loadReturned(prisma, bookingId);
  const returnedAt = await returnMoment(prisma, bookingId);
  const blockedBy = await correctionBlock(prisma, booking, returnedAt, now);
  const lines = blockedBy === "NOT_RETURNED" || blockedBy === "NO_RETURN_RECORD" ? [] : await correctionLines(prisma, booking);
  return {
    bookingId,
    docNumber: booking.docNumber,
    splitRevision: booking.splitRevision,
    returnedAt: returnedAt ? returnedAt.toISOString() : null,
    correctableUntil: returnedAt ? new Date(returnedAt.getTime() + RETURN_CORRECTION_WINDOW_MS).toISOString() : null,
    blockedBy,
    lines: lines.filter((l) => l.quantity > 0),
  };
}

/**
 * Проверки и подготовка внутри транзакции: исправлять можно, количество в
 * пределах потолка, у штучной позиции единицы — на складе. Резервы
 * отмеченных единиц снова открываются, единицы — «Выдана»: дальше общее
 * разделение переносит их к продолжению.
 */
async function prepareCorrectionInTx(
  tx: Prisma.TransactionClient,
  bookingId: string,
  stays: ReadonlyArray<StayInput>,
  now: Date,
): Promise<{ booking: BookingWithItems; returnedAt: Date }> {
  if (stays.length === 0) {
    throw new HttpError(400, "Отметьте, что не вернули", PARTIAL_RETURN_ERROR_CODES.BAD_STAY);
  }
  const booking = await loadReturned(tx, bookingId);
  const returnedAt = await returnMoment(tx, bookingId);
  const block = await correctionBlock(tx, booking, returnedAt, now);
  if (block) throwBlock(block);
  const lines = await correctionLines(tx, booking);
  const lineById = new Map(lines.map((l) => [l.bookingItemId, l]));
  const wanted = new Map<string, number>();
  for (const s of stays) wanted.set(s.bookingItemId, (wanted.get(s.bookingItemId) ?? 0) + s.quantity);
  for (const [itemId, qty] of wanted) {
    const line = lineById.get(itemId);
    if (!line) throw new HttpError(400, "Позиция не из этой брони", PARTIAL_RETURN_ERROR_CODES.BAD_STAY);
    if (qty > line.quantity) {
      throw new HttpError(
        400,
        `«${line.name}»: не вернули не больше ${line.quantity} — остальное уже в продолжениях, ремонте или «Потеряшках»`,
        RETURN_CORRECTION_CODES.OVER_CAP,
        { bookingItemId: itemId, max: line.quantity },
      );
    }
  }
  for (const s of stays) {
    const line = lineById.get(s.bookingItemId)!;
    if (!line.unitTracked) continue;
    const ids = s.equipmentUnitIds ?? [];
    const onShelf = new Set(line.units.map((u) => u.id));
    if (ids.length !== s.quantity || new Set(ids).size !== ids.length || ids.some((id) => !onShelf.has(id))) {
      throw new HttpError(
        400,
        `«${line.name}»: отметьте, какие именно единицы не вернули — из тех, что по учёту на складе`,
        RETURN_CORRECTION_CODES.UNIT_NOT_ON_SHELF,
        { bookingItemId: s.bookingItemId },
      );
    }
    for (const unitId of ids) {
      const last = await tx.bookingItemUnit.findFirst({
        where: { bookingItemId: s.bookingItemId, equipmentUnitId: unitId, returnedAt: { not: null } },
        orderBy: { returnedAt: "desc" },
        select: { id: true },
      });
      const flipped = await tx.equipmentUnit.updateMany({
        where: { id: unitId, status: "AVAILABLE" },
        data: { status: "ISSUED" },
      });
      if (!last || flipped.count === 0) {
        throw new HttpError(409, `«${line.name}»: единицу только что выдали — обновите окно`, RETURN_CORRECTION_CODES.UNIT_NOT_ON_SHELF);
      }
      await tx.bookingItemUnit.update({ where: { id: last.id }, data: { returnedAt: null } });
    }
  }
  return { booking, returnedAt: returnedAt! };
}

/** Превью: дополнительная смета и держатели — в откатываемой транзакции. */
export async function previewReturnCorrection(
  bookingId: string,
  stays: StayInput[],
  now = new Date(),
): Promise<{ continuations: ContinuationPreview[]; conflicts: StayConflict[] }> {
  const paymentDates = await stayPaymentDates(stays);
  try {
    await prisma.$transaction(async (tx) => {
      const { booking, returnedAt } = await prepareCorrectionInTx(tx, bookingId, stays, now);
      const { continuationIds, conflicts } = await splitOffContinuationsInTx(tx, {
        booking,
        stays,
        now: returnedAt,
        untilNotBefore: now,
        actorUserId: null,
        paymentDates,
        conflictMode: "collect",
      });
      throw new PreviewRollback({ conflicts, continuations: await continuationPreviewsInTx(tx, booking, continuationIds) });
    }, PARTIAL_RETURN_TX_OPTIONS);
  } catch (err) {
    if (err instanceof PreviewRollback) return { continuations: err.result.continuations, conflicts: err.result.conflicts };
    throw err;
  }
  return { continuations: [], conflicts: [] };
}

/**
 * «Создать продолжение»: одной транзакцией — захват брони по ревизии
 * разделения, проверки, открытые заново резервы, продолжение от момента
 * приёмки, запись в журнал основной брони.
 */
export async function correctReturn(args: {
  bookingId: string;
  stays: StayInput[];
  expectedSplitRevision: number;
  actorUserId: string;
  now?: Date;
}): Promise<{ continuationIds: string[] }> {
  const now = args.now ?? new Date();
  const paymentDates = await stayPaymentDates(args.stays);
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.booking.updateMany({
      where: { id: args.bookingId, status: "RETURNED", splitRevision: args.expectedSplitRevision },
      data: { splitRevision: { increment: 1 } },
    });
    if (claimed.count === 0) {
      throw new HttpError(409, "Бронь только что изменили — обновите окно", PARTIAL_RETURN_ERROR_CODES.STALE);
    }
    const { booking, returnedAt } = await prepareCorrectionInTx(tx, args.bookingId, args.stays, now);
    const { continuationIds } = await splitOffContinuationsInTx(tx, {
      booking,
      stays: args.stays,
      now: returnedAt,
      untilNotBefore: now,
      actorUserId: args.actorUserId,
      paymentDates,
      auditExtra: { via: "return-correction" },
    });
    await writeAuditEntry({
      tx,
      userId: args.actorUserId,
      action: "BOOKING_RETURN_CORRECTED",
      entityType: "Booking",
      entityId: booking.id,
      before: { status: "RETURNED" },
      after: {
        status: "RETURNED",
        returnedAt: returnedAt.toISOString(),
        continuationIds: continuationIds.join(", "),
        quantity: args.stays.reduce((n, s) => n + s.quantity, 0),
      },
    });
    return { continuationIds };
  }, PARTIAL_RETURN_TX_OPTIONS);
}
