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
 *  - не нужна ли позиция другой брони, проверяется с текущего момента:
 *    принятая бронь склад уже не держит, а прошедшие дни не исправить;
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
import { BLOCKING_STATUSES } from "./availability";
import { quoteName } from "./stockCount/act/buildStockCountAct";

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
  /** Единицы на полке, но уже зарезервированные за другой бронью: отметить их здесь нельзя. */
  reservedUnits: Array<{ id: string; label: string | null; reservedFor: string | null }>;
  paidThrough: string;
  /**
   * От какого момента считаются лишние смены: конец оплаченного или приёмка,
   * что позже. Чипы «+N смен» окна отсчитываются от него — тогда «+1»
   * выставляет ровно одну смену.
   */
  billingAnchor: string;
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

/** Семья брони для исправления: живые продолжения (их штуки уже у клиента) и отменённые. */
async function loadChildren(client: Db, bookingId: string) {
  const children = await client.booking.findMany({
    where: { parentBookingId: bookingId, deletedAt: null },
    select: { id: true, status: true, items: { select: { equipmentId: true, customName: true, quantity: true } } },
  });
  return {
    familyIds: [bookingId, ...children.map((c) => c.id)],
    cancelledIds: children.filter((c) => c.status === "CANCELLED").map((c) => c.id),
    liveItems: children.filter((c) => c.status !== "CANCELLED").flatMap((c) => c.items),
  };
}

/** Закрытые резервы единиц этой брони — и её отменённых продолжений (их единицы снова можно отметить). */
async function loadClosedReserves(client: Db, bookingIds: string[]) {
  return client.bookingItemUnit.findMany({
    where: { bookingItem: { bookingId: { in: bookingIds } }, returnedAt: { not: null } },
    select: {
      id: true,
      bookingItemId: true,
      returnedAt: true,
      bookingItem: { select: { bookingId: true, equipmentId: true } },
      equipmentUnit: {
        select: {
          id: true,
          status: true,
          internalInventoryNumber: true,
          bookingItemUnits: {
            select: {
              returnedAt: true,
              bookingItem: {
                select: {
                  bookingId: true,
                  booking: { select: { projectName: true, status: true, deletedAt: true, endDate: true } },
                },
              },
            },
          },
          // Длинный проект выдаёт единицы партиями, мимо BookingItemUnit.
          projectAssignments: { select: { returnedAt: true, lot: { select: { issuedAt: true } } } },
          // Открытая выдача в киоске: единицу уже отметили для другой брони.
          scanRecords: {
            where: { session: { status: "ACTIVE", operation: "ISSUE" } },
            select: { session: { select: { bookingId: true, booking: { select: { projectName: true } } } } },
          },
        },
      },
    },
  });
}

type ClosedReserve = Awaited<ReturnType<typeof loadClosedReserves>>[number];

/** Живой резерв другой брони держит единицу, только пока та бронь жива: идёт или впереди. */
function isLiveReserveBlocking(
  booking: { status: string; deletedAt: Date | null; endDate: Date } | null | undefined,
  now: Date,
): boolean {
  if (!booking || booking.deletedAt) return false;
  return (BLOCKING_STATUSES as string[]).includes(booking.status) && booking.endDate.getTime() > now.getTime();
}

/**
 * Единицы штучной позиции, которые клиент мог не вернуть: отмечать можно
 * только ту, что по учёту на складе («Свободна», без живого резерва живой
 * брони) и после приёмки не побывала у другого клиента — ни в брони, ни в
 * партии длинного проекта. Свободная, но зарезервированная за живой бронью
 * (или уже отмеченная в открытой выдаче киоска) — показывается отдельно: её
 * сначала снимают там. Сданная с этой брони в ремонт или в «Потеряшки» —
 * вернулась (или учтена) и сюда не попадает.
 */
function unitCandidates(
  item: BookingWithItems["items"][number],
  reserves: ClosedReserve[],
  ctx: { familyIds: string[]; cancelledIds: string[]; returnedAt: Date | null; now: Date; accountedUnitIds: Set<string> },
) {
  const units: CorrectionLine["units"] = [];
  const reservedUnits: CorrectionLine["reservedUnits"] = [];
  const seen = new Set<string>();
  const after = (d: Date | null | undefined) => d != null && ctx.returnedAt != null && d.getTime() > ctx.returnedAt.getTime();
  const own = reserves.filter(
    (r) =>
      r.bookingItemId === item.id ||
      (ctx.cancelledIds.includes(r.bookingItem.bookingId) && r.bookingItem.equipmentId === item.equipmentId),
  );
  for (const r of own) {
    const u = r.equipmentUnit;
    if (seen.has(u.id) || u.status !== "AVAILABLE" || ctx.accountedUnitIds.has(u.id)) continue;
    seen.add(u.id);
    const blocking = u.bookingItemUnits.find(
      (x) => x.returnedAt == null && !ctx.familyIds.includes(x.bookingItem.bookingId) && isLiveReserveBlocking(x.bookingItem.booking, ctx.now),
    );
    const scanning = u.scanRecords.find((x) => !ctx.familyIds.includes(x.session.bookingId));
    if (blocking || scanning) {
      reservedUnits.push({
        id: u.id,
        label: u.internalInventoryNumber,
        reservedFor: blocking?.bookingItem.booking?.projectName ?? scanning?.session.booking?.projectName ?? null,
      });
      continue;
    }
    const usedElsewhere =
      u.bookingItemUnits.some((x) => after(x.returnedAt) && !ctx.familyIds.includes(x.bookingItem.bookingId)) ||
      u.projectAssignments.some((x) => after(x.lot.issuedAt) || after(x.returnedAt));
    if (usedElsewhere) continue;
    units.push({ id: u.id, label: u.internalInventoryNumber });
  }
  return { units, reservedUnits };
}

/**
 * Сколько уже в живых продолжениях — по каждой строке. Каталожные позиции
 * сопоставляются по оборудованию (у брони одна строка на позицию), свои — по
 * названию, с раскладкой по строкам: две строки «Удлинитель» не должны обе
 * считать одно и то же продолжение.
 */
function continuationShares(
  items: BookingWithItems["items"],
  liveItems: Array<{ equipmentId: string | null; customName: string | null; quantity: number }>,
): Map<string, number> {
  const shares = new Map<string, number>();
  for (const it of items) {
    if (it.equipmentId) {
      shares.set(it.id, liveItems.filter((c) => c.equipmentId === it.equipmentId).reduce((n, c) => n + c.quantity, 0));
    }
  }
  const pools = new Map<string, number>();
  for (const c of liveItems) {
    if (!c.equipmentId && c.customName) pools.set(c.customName, (pools.get(c.customName) ?? 0) + c.quantity);
  }
  for (const it of items) {
    if (it.equipmentId) continue;
    const pool = it.customName ? pools.get(it.customName) ?? 0 : 0;
    const take = Math.min(pool, it.quantity);
    shares.set(it.id, take);
    if (it.customName) pools.set(it.customName, pool - take);
  }
  return shares;
}

/**
 * Потолок «не вернули» по каждой позиции и единицы на складе. Считается одним
 * набором запросов на всю бронь.
 */
async function correctionLines(
  client: Db,
  booking: BookingWithItems,
  returnedAt: Date | null,
  now: Date,
): Promise<CorrectionLine[]> {
  const equipmentIds = booking.items.map((i) => i.equipmentId).filter((v): v is string => v != null);
  const family = await loadChildren(client, booking.id);
  const [equipment, repairs, problems, reserves] = await Promise.all([
    client.equipment.findMany({ where: { id: { in: equipmentIds } }, select: { id: true, name: true, stockTrackingMode: true } }),
    client.repair.findMany({
      where: { sourceBookingId: booking.id },
      select: { bookingItemId: true, equipmentId: true, quantity: true, unitId: true, unit: { select: { equipmentId: true } } },
    }),
    client.problemItem.findMany({
      where: { sourceBookingId: booking.id },
      select: {
        bookingItemId: true,
        equipmentId: true,
        quantity: true,
        equipmentUnitId: true,
        equipmentUnit: { select: { equipmentId: true } },
      },
    }),
    loadClosedReserves(client, [booking.id, ...family.cancelledIds]),
  ]);
  const eqById = new Map(equipment.map((e) => [e.id, e]));
  const shares = continuationShares(booking.items, family.liveItems);
  const accountedUnitIds = new Set(
    [...repairs.map((r) => r.unitId), ...problems.map((p) => p.equipmentUnitId)].filter((v): v is string => v != null),
  );
  return booking.items.map((it): CorrectionLine => {
    const eq = it.equipmentId ? eqById.get(it.equipmentId) : undefined;
    const same = (row: { bookingItemId?: string | null; equipmentId: string | null }, unitEquipmentId?: string | null) =>
      row.bookingItemId === it.id ||
      (it.equipmentId != null && (row.equipmentId === it.equipmentId || unitEquipmentId === it.equipmentId));
    const inContinuations = shares.get(it.id) ?? 0;
    const inRepair = repairs.filter((r) => same(r, r.unit?.equipmentId)).reduce((n, r) => n + r.quantity, 0);
    const inProblems = problems.filter((p) => same(p, p.equipmentUnit?.equipmentId)).reduce((n, p) => n + p.quantity, 0);
    const unitTracked = eq?.stockTrackingMode === "UNIT";
    const { units, reservedUnits } = unitTracked
      ? unitCandidates(it, reserves, { ...family, returnedAt, now, accountedUnitIds })
      : { units: [], reservedUnits: [] };
    const left = Math.max(0, it.quantity - inContinuations - inRepair - inProblems);
    const paidThrough = paidThroughAt(itemCoverage(booking, it), booking.skipPartialDay);
    return {
      bookingItemId: it.id,
      equipmentId: it.equipmentId,
      name: eq?.name ?? it.customName ?? "Позиция",
      quantity: unitTracked ? Math.min(left, units.length) : left,
      unitTracked,
      units,
      reservedUnits,
      paidThrough: paidThrough.toISOString(),
      billingAnchor: new Date(Math.max(paidThrough.getTime(), returnedAt?.getTime() ?? 0)).toISOString(),
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
  const lines =
    blockedBy === "NOT_RETURNED" || blockedBy === "NO_RETURN_RECORD" ? [] : await correctionLines(prisma, booking, returnedAt, now);
  return {
    bookingId,
    docNumber: booking.docNumber,
    splitRevision: booking.splitRevision,
    returnedAt: returnedAt ? returnedAt.toISOString() : null,
    correctableUntil: returnedAt ? new Date(returnedAt.getTime() + RETURN_CORRECTION_WINDOW_MS).toISOString() : null,
    blockedBy,
    lines: lines.filter((l) => l.quantity > 0 || l.reservedUnits.length > 0),
  };
}

/** Единицы штучных строк: каждая один раз и из тех, что можно отметить; зарезервированная — с названием брони. */
function assertUnitsPickable(stays: ReadonlyArray<StayInput>, lineById: Map<string, CorrectionLine>): void {
  const picked = new Set<string>();
  for (const s of stays) {
    const line = lineById.get(s.bookingItemId);
    if (!line?.unitTracked) continue;
    const ids = s.equipmentUnitIds ?? [];
    const reserved = ids.map((id) => line.reservedUnits.find((u) => u.id === id)).find((u) => u != null);
    if (reserved) {
      throw new HttpError(
        400,
        `«${line.name}»: единица ${reserved.label ?? ""} зарезервирована за ${reserved.reservedFor ? quoteName(reserved.reservedFor) : "другой бронью"} — сначала снимите резерв там`.replace(/\s+/g, " "),
        RETURN_CORRECTION_CODES.UNIT_NOT_ON_SHELF,
        { bookingItemId: s.bookingItemId, reservedFor: reserved.reservedFor },
      );
    }
    const onShelf = new Set(line.units.map((u) => u.id));
    if (ids.length !== s.quantity || ids.some((id) => !onShelf.has(id) || picked.has(id)) || new Set(ids).size !== ids.length) {
      throw new HttpError(
        400,
        `«${line.name}»: отметьте, какие именно единицы не вернули — каждую один раз и из тех, что по учёту на складе`,
        RETURN_CORRECTION_CODES.UNIT_NOT_ON_SHELF,
        { bookingItemId: s.bookingItemId },
      );
    }
    for (const id of ids) picked.add(id);
  }
}

/** Количество по строкам в пределах потолка — иначе 400 с понятной причиной. */
function assertWithinCaps(stays: ReadonlyArray<StayInput>, lineById: Map<string, CorrectionLine>): void {
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
}

/**
 * Снова открыть закрытый резерв единицы: её не вернули. Сначала — резерв
 * этой позиции; если единица ушла в отменённое продолжение, его резерв
 * возвращается к позиции брони. Дальше общее разделение переносит открытый
 * резерв к новому продолжению. Возвращает, когда резерв был закрыт.
 */
async function reopenUnitReserve(
  tx: Prisma.TransactionClient,
  item: BookingWithItems["items"][number],
  unitId: string,
  cancelledIds: string[],
  lineName: string,
): Promise<Date | null> {
  const candidates = await tx.bookingItemUnit.findMany({
    where: {
      equipmentUnitId: unitId,
      returnedAt: { not: null },
      OR: [{ bookingItemId: item.id }, { bookingItem: { bookingId: { in: cancelledIds }, equipmentId: item.equipmentId } }],
    },
    orderBy: { returnedAt: "desc" },
    select: { id: true, bookingItemId: true, returnedAt: true },
  });
  const reserve = candidates.find((c) => c.bookingItemId === item.id) ?? candidates[0];
  const flipped = await tx.equipmentUnit.updateMany({ where: { id: unitId, status: "AVAILABLE" }, data: { status: "ISSUED" } });
  if (!reserve || flipped.count === 0) {
    throw new HttpError(409, `«${lineName}»: единицу только что выдали — обновите окно`, RETURN_CORRECTION_CODES.UNIT_NOT_ON_SHELF);
  }
  await tx.bookingItemUnit.update({ where: { id: reserve.id }, data: { returnedAt: null, bookingItemId: item.id } });
  return reserve.returnedAt;
}

/**
 * Проверки и подготовка внутри транзакции: исправлять можно, количество в
 * пределах потолка, у штучной позиции единицы — на складе и без повторов.
 * Резервы отмеченных единиц снова открываются, единицы — «Выдана».
 */
async function prepareCorrectionInTx(
  tx: Prisma.TransactionClient,
  bookingId: string,
  stays: ReadonlyArray<StayInput>,
  now: Date,
): Promise<{ booking: BookingWithItems; returnedAt: Date; unitLabels: string[] }> {
  if (stays.length === 0) {
    throw new HttpError(400, "Отметьте, что не вернули", PARTIAL_RETURN_ERROR_CODES.BAD_STAY);
  }
  const booking = await loadReturned(tx, bookingId);
  const returnedAt = await returnMoment(tx, bookingId);
  const block = await correctionBlock(tx, booking, returnedAt, now);
  if (block) throwBlock(block);
  const lines = await correctionLines(tx, booking, returnedAt, now);
  const lineById = new Map(lines.map((l) => [l.bookingItemId, l]));
  // Штучные — сначала по единицам: у зарезервированной причина не в потолке.
  assertUnitsPickable(stays, lineById);
  assertWithinCaps(stays, lineById);
  const { cancelledIds } = await loadChildren(tx, booking.id);
  const unitLabels: string[] = [];
  for (const s of stays) {
    const line = lineById.get(s.bookingItemId)!;
    if (!line.unitTracked) continue;
    const ids = s.equipmentUnitIds ?? [];
    const item = booking.items.find((i) => i.id === s.bookingItemId)!;
    for (const unitId of ids) {
      const closedAt = await reopenUnitReserve(tx, item, unitId, cancelledIds, line.name);
      const label = line.units.find((u) => u.id === unitId)?.label ?? "без инв. номера";
      unitLabels.push(closedAt ? `${label} (принят ${closedAt.toISOString()})` : label);
    }
  }
  return { booking, returnedAt: returnedAt!, unitLabels };
}

/** Превью: дополнительная смета и держатели — в откатываемой транзакции. */
export async function previewReturnCorrection(
  bookingId: string,
  stays: StayInput[],
  now = new Date(),
): Promise<{ continuations: ContinuationPreview[]; conflicts: StayConflict[]; parentNegotiatedTotal: string | null }> {
  const paymentDates = await stayPaymentDates(stays);
  let parentNegotiatedTotal: string | null = null;
  try {
    await prisma.$transaction(async (tx) => {
      const { booking, returnedAt } = await prepareCorrectionInTx(tx, bookingId, stays, now);
      // Договорной итог основной брони дополнительную смету не покрывает — окно об этом скажет.
      parentNegotiatedTotal = booking.manualFinalAmount != null ? booking.manualFinalAmount.toString() : null;
      const { continuationIds, conflicts } = await splitOffContinuationsInTx(tx, {
        booking,
        stays,
        now: returnedAt,
        untilNotBefore: now,
        conflictFrom: now,
        actorUserId: null,
        paymentDates,
        conflictMode: "collect",
      });
      throw new PreviewRollback({ conflicts, continuations: await continuationPreviewsInTx(tx, booking, continuationIds) });
    }, PARTIAL_RETURN_TX_OPTIONS);
  } catch (err) {
    if (err instanceof PreviewRollback) {
      return { continuations: err.result.continuations, conflicts: err.result.conflicts, parentNegotiatedTotal };
    }
    throw err;
  }
  return { continuations: [], conflicts: [], parentNegotiatedTotal };
}

/**
 * «Создать продолжение»: одной транзакцией — проверка, что исправлять можно,
 * захват брони по ревизии разделения, открытые заново резервы, продолжение от
 * момента приёмки, запись в журнал основной брони.
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
    // Сначала — почему нельзя (бронь не принята, срок прошёл…): иначе захват
    // по ревизии ответил бы «бронь изменили» на то, что изменить нельзя вовсе.
    const current = await loadReturned(tx, args.bookingId);
    const block = await correctionBlock(tx, current, await returnMoment(tx, args.bookingId), now);
    if (block) throwBlock(block);
    const claimed = await tx.booking.updateMany({
      where: { id: args.bookingId, status: "RETURNED", splitRevision: args.expectedSplitRevision },
      data: { splitRevision: { increment: 1 } },
    });
    if (claimed.count === 0) {
      throw new HttpError(409, "Бронь только что изменили — обновите окно", PARTIAL_RETURN_ERROR_CODES.STALE);
    }
    const { booking, returnedAt, unitLabels } = await prepareCorrectionInTx(tx, args.bookingId, args.stays, now);
    const { continuationIds } = await splitOffContinuationsInTx(tx, {
      booking,
      stays: args.stays,
      now: returnedAt,
      untilNotBefore: now,
      conflictFrom: now,
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
        // Журнал хранит плоские поля: какие единицы снова «Выданы» и когда их принимали.
        ...(unitLabels.length > 0 ? { equipmentUnits: unitLabels.join("; ") } : {}),
      },
    });
    return { continuationIds };
  }, PARTIAL_RETURN_TX_OPTIONS);
}
