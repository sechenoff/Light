/**
 * Частичная приёмка: «Принять часть — остальное у клиента».
 *
 * Обычная бронь всегда целиком выдана или целиком возвращена. Если часть
 * оборудования осталась у клиента, одна транзакция:
 *  1. захватывает основную бронь (splitRevision — от двойного нажатия);
 *  2. переносит оставленное в бронь-продолжение — по одной на каждый срок
 *     «до»: свой номер «<основная>-k», своя смета, оплата и акт; живые
 *     резервы штучных единиц переходят к позиции продолжения;
 *  3. принимает основную бронь тем же путём, что ручное «Вернуть»
 *     (bookingManualStatus) — остальное сразу свободно для других броней.
 *
 * На этом этапе — только в пределах оплаченного: оставленное «по плану»
 * (длинная позиция) или сданное раньше срока стоит 0 ₽. Срок «до» позже
 * оплаченного — 409 CONTINUATION_BEYOND_PAID_NOT_YET (дополнительная смета
 * сверх оплаченного — этап 14).
 */
import Decimal from "decimal.js";
import type { Booking, BookingItem, Estimate, EstimateLine, Prisma } from "@prisma/client";
import { effectiveLineShifts } from "@light-rental/shared";

import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";
import { billableShifts24h } from "../utils/dates";
import { formatMoscowDayTime } from "../utils/moscowDate";
import { writeAuditEntry } from "./audit";
import { computeDefaultPaymentDate, continuationContextOf, writeMainEstimateInTx } from "./bookings";
import { continuationBilling, paidThroughAt, rootLineCoverage, type ShiftCoverage } from "./continuationPricing";
import { setBookingIssuedOrReturnedInTx } from "./bookingManualStatus";
import { recomputeBookingFinance } from "./finance";
import { linePlannedEnd } from "./availability";

/** Длинная позиция «по плану у клиента», если её срок позже этого допуска. */
const PLANNED_STAY_TOLERANCE_MS = 60 * 60 * 1000;

export const PARTIAL_RETURN_ERROR_CODES = {
  NOT_ISSUED: "PARTIAL_RETURN_NOT_ISSUED",
  STALE: "PARTIAL_RETURN_STALE",
  BAD_STAY: "PARTIAL_RETURN_BAD_STAY",
  BEYOND_PAID: "CONTINUATION_BEYOND_PAID_NOT_YET",
  UNITS_REQUIRED: "PARTIAL_RETURN_UNITS_REQUIRED",
  PLANNED_STAY_PENDING: "PLANNED_STAY_PENDING",
} as const;

type BookingWithItems = Booking & {
  items: BookingItem[];
  estimates: Array<Estimate & { lines: EstimateLine[] }>;
};

/** Смены брони — как в её смете. */
function bookingShifts(b: { startDate: Date; endDate: Date; skipPartialDay: boolean }): number {
  return billableShifts24h(b.startDate, b.endDate, b.skipPartialDay);
}

/**
 * Что уже оплачено у штук позиции этой брони: у основной — её действующие
 * смены от начала брони, у продолжения — покрытие позиции плюс выставленное
 * в его смете (`continuationBilling(...).next`).
 */
export function itemCoverage(booking: BookingWithItems | (Booking & { items: BookingItem[] }), item: BookingItem): ShiftCoverage {
  const ctx = continuationContextOf(booking);
  if (ctx && item.coveredShifts != null && item.shiftAnchorAt != null) {
    return continuationBilling({
      coverage: { anchorAt: item.shiftAnchorAt, coveredShifts: item.coveredShifts },
      splitAt: ctx.splitAt,
      until: ctx.until,
      skipPartialDay: ctx.skipPartialDay,
    }).next;
  }
  const own = item.equipmentId ? effectiveLineShifts(bookingShifts(booking), item.shifts) : bookingShifts(booking);
  return rootLineCoverage(booking.startDate, own);
}

/**
 * Позиция «по плану у клиента» — её ждут позже конца брони: своё число смен
 * задано, оно больше смен брони, и срок позже и текущего момента, и конца
 * брони (с допуском). Одно правило на всех: без него любой досрочный возврат
 * считался бы «по плану» и запирал обычную приёмку.
 */
export function plannedStayDueAt(
  booking: { startDate: Date; endDate: Date; skipPartialDay: boolean },
  item: { equipmentId: string | null; shifts: number | null },
  now: Date,
): Date | null {
  if (!item.equipmentId || item.shifts == null) return null;
  if (item.shifts <= bookingShifts(booking)) return null;
  const due = linePlannedEnd(booking, item.shifts);
  const floor = Math.max(now.getTime(), booking.endDate.getTime()) + PLANNED_STAY_TOLERANCE_MS;
  return due.getTime() > floor ? due : null;
}

/** Строка плана приёмки для окна «Принять возврат». */
export type ReturnPlanLine = {
  bookingItemId: string;
  equipmentId: string | null;
  name: string;
  quantity: number;
  unitTracked: boolean;
  /** Единицы у клиента — по инвентарному номеру (штрихкоды в интерфейсе не показываем). */
  units: Array<{ id: string; label: string | null }>;
  /** До какого момента штуки позиции оплачены. Срок «до» позже — дополнительная смета (этап 14). */
  paidThrough: string;
  /** Позиция «по плану у клиента» — окно сразу предлагает её оставить. */
  plannedStayUntil: string | null;
};

export type ReturnPlan = {
  bookingId: string;
  splitRevision: number;
  lines: ReturnPlanLine[];
  /** Есть позиции «по плану»: обычное «Вернуть» просит подтвердить, что вернули всё. */
  hasPlannedStays: boolean;
  /** Открытая приёмка в киоске — окно предупреждает, чьи отметки пропадут. */
  kioskSession: { workerName: string; startedAt: string } | null;
};

/** Выданная бронь с позициями и сметами — для плана приёмки и разделения. */
export async function loadIssued(client: Prisma.TransactionClient | typeof prisma, bookingId: string) {
  const booking = await client.booking.findUnique({
    where: { id: bookingId },
    include: { items: true, estimates: { include: { lines: true } } },
  });
  if (!booking || booking.deletedAt) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");
  if (booking.mode !== "STANDARD" || booking.status !== "ISSUED") {
    throw new HttpError(
      409,
      "Принять часть можно только у выданной брони",
      PARTIAL_RETURN_ERROR_CODES.NOT_ISSUED,
      { status: booking.status },
    );
  }
  return booking;
}

/** План приёмки: позиции, их оплаченный срок, «по плану», единицы у клиента. */
export async function getReturnPlan(bookingId: string, now = new Date()): Promise<ReturnPlan> {
  const booking = await loadIssued(prisma, bookingId);
  const live = await prisma.bookingItemUnit.findMany({
    where: { bookingItem: { bookingId }, returnedAt: null },
    select: { bookingItemId: true, equipmentUnit: { select: { id: true, internalInventoryNumber: true } } },
  });
  const equipment = await prisma.equipment.findMany({
    where: { id: { in: booking.items.map((i) => i.equipmentId).filter((v): v is string => v != null) } },
    select: { id: true, name: true, stockTrackingMode: true },
  });
  const eqById = new Map(equipment.map((e) => [e.id, e]));
  const session = await prisma.scanSession.findFirst({
    where: { bookingId, status: "ACTIVE", operation: "RETURN" },
    orderBy: { startedAt: "desc" },
    select: { workerName: true, startedAt: true },
  });
  const lines = booking.items.map((it): ReturnPlanLine => {
    const eq = it.equipmentId ? eqById.get(it.equipmentId) : undefined;
    const planned = plannedStayDueAt(booking, it, now);
    return {
      bookingItemId: it.id,
      equipmentId: it.equipmentId,
      name: eq?.name ?? it.customName ?? "Позиция",
      quantity: it.quantity,
      unitTracked: eq?.stockTrackingMode === "UNIT",
      units: live
        .filter((u) => u.bookingItemId === it.id)
        .map((u) => ({ id: u.equipmentUnit.id, label: u.equipmentUnit.internalInventoryNumber })),
      paidThrough: paidThroughAt(itemCoverage(booking, it), booking.skipPartialDay).toISOString(),
      plannedStayUntil: planned ? planned.toISOString() : null,
    };
  });
  return {
    bookingId,
    splitRevision: booking.splitRevision,
    lines,
    hasPlannedStays: lines.some((l) => l.plannedStayUntil != null),
    kioskSession: session ? { workerName: session.workerName, startedAt: session.startedAt.toISOString() } : null,
  };
}

/** Есть ли у выданной брони позиции «по плану у клиента». */
export function hasPlannedStays(booking: BookingWithItems | (Booking & { items: BookingItem[] }), now = new Date()): boolean {
  return booking.items.some((it) => plannedStayDueAt(booking, it, now) != null);
}

export type StayInput = {
  bookingItemId: string;
  quantity: number;
  /** До когда оставили (ISO). */
  until: string;
  /** Штучная позиция — какие именно единицы остались у клиента. */
  equipmentUnitIds?: string[];
};

/** Ставка за смену для продолжения: из строки сметы предка, никогда из строки с 0 смен. */
function listRateForStay(booking: BookingWithItems, item: BookingItem): Decimal | null {
  if (item.listRatePerShift != null) return new Decimal(item.listRatePerShift.toString());
  for (const kind of ["MAIN", "ADDON"] as const) {
    const est = booking.estimates.find((e) => e.kind === kind);
    const line = est?.lines.find((l) => l.equipmentId === item.equipmentId);
    const shifts = line ? line.shifts ?? est!.shifts : 0;
    if (line && shifts > 0) {
      return new Decimal((line.listUnitPrice ?? line.unitPrice).toString()).div(shifts);
    }
  }
  return null;
}

/**
 * Номер продолжения: «<номер основной>-k», k — следующий после самого
 * большого уже выданного (а не по числу продолжений: удалённое навсегда
 * продолжение уменьшило бы счёт, и номер совпал бы с живым).
 */
async function nextContinuationDocNumber(tx: Prisma.TransactionClient, rootId: string): Promise<string | null> {
  const root = await tx.booking.findUnique({ where: { id: rootId }, select: { docNumber: true } });
  if (!root?.docNumber) return null;
  const prefix = `${root.docNumber}-`;
  const taken = await tx.booking.findMany({ where: { docNumber: { startsWith: prefix } }, select: { docNumber: true } });
  const max = taken.reduce((m, b) => {
    const k = Number(b.docNumber!.slice(prefix.length));
    return Number.isInteger(k) && k > m ? k : m;
  }, 0);
  return `${prefix}${max + 1}`;
}

/** Приёмка с продолжениями — много записей: таймаут как у завершения приёмки в киоске. */
const PARTIAL_RETURN_TX_OPTIONS = { timeout: 20_000, maxWait: 10_000 } as const;

/** Срок оплаты продолжения — по его сроку «до». Читает настройки, поэтому вне транзакции. */
export async function stayPaymentDates(stays: ReadonlyArray<StayInput>): Promise<Map<number, Date>> {
  const paymentDates = new Map<number, Date>();
  for (const s of stays) {
    const until = new Date(s.until);
    if (!paymentDates.has(until.getTime())) paymentDates.set(until.getTime(), await computeDefaultPaymentDate(until));
  }
  return paymentDates;
}

/**
 * Захват брони под разделение: `splitRevision` из плана приёмки. Бронь успели
 * принять или разделить — 409, и вся транзакция откатывается.
 */
export async function claimSplit(
  tx: Prisma.TransactionClient,
  bookingId: string,
  expectedSplitRevision: number,
): Promise<void> {
  const claimed = await tx.booking.updateMany({
    where: { id: bookingId, status: "ISSUED", splitRevision: expectedSplitRevision },
    data: { splitRevision: { increment: 1 } },
  });
  if (claimed.count === 0) {
    throw new HttpError(
      409,
      "Бронь уже приняли или разделили — обновите карточку",
      PARTIAL_RETURN_ERROR_CODES.STALE,
    );
  }
}

/**
 * Отделить оставленное у клиента в продолжения — проверки и запись, без
 * приёмки основной брони: её закрывает вызывающий (ручное «Вернуть» на
 * карточке или «Готово» в киоске). Живые резервы оставленных единиц
 * переходят к позиции продолжения — приёмка основной их уже не видит.
 */
export async function splitOffContinuationsInTx(
  tx: Prisma.TransactionClient,
  args: {
    booking: BookingWithItems;
    stays: ReadonlyArray<StayInput>;
    now: Date;
    actorUserId: string | null;
    paymentDates: ReadonlyMap<number, Date>;
    /** Откуда приёмка — в запись журнала о продолжении (киоск: кто и в какой сессии). */
    auditExtra?: Record<string, string>;
  },
): Promise<string[]> {
  const { booking, now } = args;
  if (args.stays.length === 0) {
    throw new HttpError(400, "Отметьте, что осталось у клиента", PARTIAL_RETURN_ERROR_CODES.BAD_STAY);
  }

  // ── проверки оставленного ────────────────────────────────────────────────
  const itemById = new Map(booking.items.map((i) => [i.id, i]));
  const keptByItem = new Map<string, number>();
  const keptUnitIds = new Set<string>();
  const live = await tx.bookingItemUnit.findMany({
    where: { bookingItem: { bookingId: booking.id }, returnedAt: null },
    select: { id: true, bookingItemId: true, equipmentUnitId: true },
  });
  const eqModes = new Map(
    (
      await tx.equipment.findMany({
        where: { id: { in: booking.items.map((i) => i.equipmentId).filter((v): v is string => v != null) } },
        select: { id: true, stockTrackingMode: true },
      })
    ).map((e) => [e.id, e.stockTrackingMode]),
  );
  for (const s of args.stays) {
    const item = itemById.get(s.bookingItemId);
    if (!item) throw new HttpError(400, "Позиция не из этой брони", PARTIAL_RETURN_ERROR_CODES.BAD_STAY);
    const until = new Date(s.until);
    if (!Number.isFinite(until.getTime()) || until.getTime() <= now.getTime()) {
      throw new HttpError(400, "Срок «до» должен быть позже текущего момента", PARTIAL_RETURN_ERROR_CODES.BAD_STAY);
    }
    const total = (keptByItem.get(item.id) ?? 0) + s.quantity;
    if (!Number.isInteger(s.quantity) || s.quantity <= 0 || total > item.quantity) {
      throw new HttpError(400, "Оставить можно от 1 до количества позиции", PARTIAL_RETURN_ERROR_CODES.BAD_STAY);
    }
    keptByItem.set(item.id, total);
    const paidThrough = paidThroughAt(itemCoverage(booking, item), booking.skipPartialDay);
    if (until.getTime() > paidThrough.getTime()) {
      throw new HttpError(
        409,
        `Оставить дольше оплаченного (до ${formatMoscowDayTime(paidThrough)}) пока нельзя — это появится вместе с дополнительной сметой`,
        PARTIAL_RETURN_ERROR_CODES.BEYOND_PAID,
        { bookingItemId: item.id, paidThrough: paidThrough.toISOString() },
      );
    }
    if (item.equipmentId && eqModes.get(item.equipmentId) === "UNIT") {
      const ids = s.equipmentUnitIds ?? [];
      const own = new Set(live.filter((r) => r.bookingItemId === item.id).map((r) => r.equipmentUnitId));
      if (own.size < s.quantity) {
        throw new HttpError(
          400,
          `У клиента по этой позиции отмечено только ${own.size} ед. — оставить больше нельзя`,
          PARTIAL_RETURN_ERROR_CODES.UNITS_REQUIRED,
          { bookingItemId: item.id },
        );
      }
      // Одна и та же единица дважды прошла бы проверку: позиция продолжения
      // получила бы 2 шт, а перешёл бы один резерв — второй прибор ушёл бы на полку.
      if (
        ids.length !== s.quantity ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !own.has(id) || keptUnitIds.has(id))
      ) {
        throw new HttpError(
          400,
          "Отметьте, какие именно единицы остались у клиента",
          PARTIAL_RETURN_ERROR_CODES.UNITS_REQUIRED,
          { bookingItemId: item.id },
        );
      }
      for (const id of ids) keptUnitIds.add(id);
    }
  }

  // ── продолжения: по одному на каждый срок «до» ───────────────────────────
  // Одна позиция с одним сроком — одна строка продолжения (у брони одна
  // строка на позицию каталога).
  const rootId = booking.rootBookingId ?? booking.id;
  const merged = new Map<string, StayInput>();
  for (const s of args.stays) {
    const key = `${s.bookingItemId}|${new Date(s.until).getTime()}`;
    const prev = merged.get(key);
    merged.set(
      key,
      prev
        ? {
            ...prev,
            quantity: prev.quantity + s.quantity,
            equipmentUnitIds: [...(prev.equipmentUnitIds ?? []), ...(s.equipmentUnitIds ?? [])],
          }
        : { ...s },
    );
  }
  const byUntil = new Map<number, StayInput[]>();
  for (const s of merged.values()) {
    const t = new Date(s.until).getTime();
    byUntil.set(t, [...(byUntil.get(t) ?? []), s]);
  }
  const continuationIds: string[] = [];
  for (const [untilMs, stays] of Array.from(byUntil.entries()).sort((a, b) => a[0] - b[0])) {
    const docNumber = await nextContinuationDocNumber(tx, rootId);
    const child = await tx.booking.create({
      data: {
        clientId: booking.clientId,
        projectName: booking.projectName,
        comment: `Продолжение брони${booking.docNumber ? ` № ${booking.docNumber}` : ""}`,
        status: "ISSUED",
        mode: "STANDARD",
        startDate: new Date(Math.min(booking.endDate.getTime(), now.getTime())),
        endDate: new Date(untilMs),
        issuedAt: now,
        confirmedAt: now,
        discountPercent: booking.discountPercent,
        paymentForm: booking.paymentForm,
        cashlessSurchargePercent: booking.cashlessSurchargePercent,
        skipPartialDay: booking.skipPartialDay,
        legacyFinance: false,
        expectedPaymentDate: args.paymentDates.get(untilMs) ?? null,
        parentBookingId: booking.id,
        rootBookingId: rootId,
        docNumber,
        items: {
          create: stays.map((s) => {
            const item = itemById.get(s.bookingItemId)!;
            const coverage = itemCoverage(booking, item);
            const rate = item.equipmentId ? listRateForStay(booking, item) : null;
            return {
              equipmentId: item.equipmentId,
              quantity: s.quantity,
              customName: item.customName,
              customCategory: item.customCategory,
              customUnitPrice: item.customUnitPrice,
              negotiatedRatePerShift: item.negotiatedRatePerShift,
              coveredShifts: coverage.coveredShifts,
              shiftAnchorAt: coverage.anchorAt,
              listRatePerShift: rate ? rate.toDecimalPlaces(2).toString() : null,
            };
          }),
        },
      },
      include: { items: true },
    });
    // Живые резервы оставленных единиц — к позиции продолжения: единица
    // остаётся «Выдана», приёмку покажет уже продолжение.
    for (const s of stays) {
      const ids = s.equipmentUnitIds ?? [];
      if (ids.length === 0) continue;
      const item = itemById.get(s.bookingItemId)!;
      const childItem = child.items.find((ci) =>
        item.equipmentId ? ci.equipmentId === item.equipmentId : ci.customName === item.customName,
      )!;
      await tx.bookingItemUnit.updateMany({
        where: { bookingItemId: item.id, equipmentUnitId: { in: ids }, returnedAt: null },
        data: { bookingItemId: childItem.id },
      });
    }
    await writeMainEstimateInTx(tx, child.id);
    await recomputeBookingFinance(child.id, tx);
    if (args.actorUserId) {
      await writeAuditEntry({
        tx,
        userId: args.actorUserId,
        action: "BOOKING_CONTINUATION_CREATED",
        entityType: "Booking",
        entityId: child.id,
        before: null,
        after: {
          parentBookingId: booking.id,
          rootBookingId: rootId,
          docNumber,
          until: new Date(untilMs).toISOString(),
          quantity: stays.reduce((sum, s) => sum + s.quantity, 0),
          ...(args.auditExtra ?? { via: "card" }),
        },
      });
    }
    continuationIds.push(child.id);
  }
  return continuationIds;
}

/**
 * «Принять часть — остальное у клиента». Проверки и запись одной
 * транзакцией. `expectedSplitRevision` — из плана приёмки: если бронь
 * успели принять или разделить, 409 и откат.
 */
export async function returnPartial(args: {
  bookingId: string;
  stays: StayInput[];
  expectedSplitRevision: number;
  actorUserId: string | null;
  now?: Date;
}): Promise<{ parentId: string; continuationIds: string[] }> {
  const now = args.now ?? new Date();
  if (args.stays.length === 0) {
    throw new HttpError(400, "Отметьте, что осталось у клиента", PARTIAL_RETURN_ERROR_CODES.BAD_STAY);
  }
  const paymentDates = await stayPaymentDates(args.stays);

  return prisma.$transaction(async (tx) => {
    const booking = await loadIssued(tx, args.bookingId);
    await claimSplit(tx, booking.id, args.expectedSplitRevision);
    const continuationIds = await splitOffContinuationsInTx(tx, {
      booking,
      stays: args.stays,
      now,
      actorUserId: args.actorUserId,
      paymentDates,
    });

    // ── приёмка основной брони — ручным «Вернуть» без оставленного ──────────
    await setBookingIssuedOrReturnedInTx(tx, {
      bookingId: booking.id,
      fromStatus: "ISSUED",
      issuedAt: booking.issuedAt,
      action: "return",
      actorUserId: args.actorUserId,
      patch: { status: "RETURNED" },
      // Журнал хранит плоские поля (массивы diffFields отбрасывает).
      auditExtra: { via: "status:return-partial", continuationIds: continuationIds.join(", ") },
    });
    return { parentId: booking.id, continuationIds };
  }, PARTIAL_RETURN_TX_OPTIONS);
}

/** 409, если обычное «Вернуть» сдало бы позиции «по плану у клиента» молча. */
export function plannedStayPendingError(booking: BookingWithItems | (Booking & { items: BookingItem[] }), now = new Date()): HttpError {
  const lines = booking.items
    .map((it) => ({ bookingItemId: it.id, until: plannedStayDueAt(booking, it, now) }))
    .filter((l): l is { bookingItemId: string; until: Date } => l.until != null)
    .map((l) => ({ bookingItemId: l.bookingItemId, until: l.until.toISOString() }));
  return new HttpError(
    409,
    "Часть позиций по плану ещё у клиента — примите возврат в окне «Принять возврат» или подтвердите, что вернули всё",
    PARTIAL_RETURN_ERROR_CODES.PLANNED_STAY_PENDING,
    { lines },
  );
}
