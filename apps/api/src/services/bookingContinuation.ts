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
 * Оставленное «по плану» (длинная позиция) или сданное раньше срока стоит 0 ₽.
 * Срок «до» позже оплаченного — лишние смены в дополнительной смете
 * продолжения (этап 14): та же ставка, скидка брони и надбавка за безнал, что в
 * основной смете. Если оставленное на эти дни нужно другой брони — 409
 * CONTINUATION_CONFLICT с держателем; «под ответственность»
 * (`acknowledgedConflict`) — проходит и пишется в журнал.
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
import { getAvailability, linePlannedEnd } from "./availability";
import { findHoldersBatch, type AddonConflict } from "./addonAvailability";

/** Длинная позиция «по плану у клиента», если её срок позже этого допуска. */
const PLANNED_STAY_TOLERANCE_MS = 60 * 60 * 1000;

export const PARTIAL_RETURN_ERROR_CODES = {
  NOT_ISSUED: "PARTIAL_RETURN_NOT_ISSUED",
  STALE: "PARTIAL_RETURN_STALE",
  BAD_STAY: "PARTIAL_RETURN_BAD_STAY",
  UNITS_REQUIRED: "PARTIAL_RETURN_UNITS_REQUIRED",
  PLANNED_STAY_PENDING: "PLANNED_STAY_PENDING",
  CONFLICT: "CONTINUATION_CONFLICT",
} as const;

/**
 * Срок «до» — не дальше года: опечатка в годе (2062 вместо 2026) в поле даты
 * иначе дала бы смету на миллионы и бронь, занимающую склад десятилетиями.
 */
export const MAX_STAY_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;

export type BookingWithItems = Booking & {
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
  /**
   * Оставить, хотя на дни сверх оплаченного позиция нужна другой брони, —
   * «под ответственность»: прибор и так у клиента, склад его не удержит.
   */
  acknowledgedConflict?: boolean;
};

/** Оставленное нужно другой брони на дни сверх оплаченного. */
export type StayConflict = {
  bookingItemId: string;
  equipmentId: string;
  name: string;
  needed: number;
  available: number;
  /** С какого момента проверяли (конец оплаченного или сейчас), ISO. */
  from: string;
  until: string;
  /**
   * С какого момента позиция нужна другой брони, ISO: начало держателя, но не
   * раньше начала проверки. Его и показываем — «нужна с ср 12:00».
   */
  neededFrom: string;
  holder: AddonConflict | null;
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
export const PARTIAL_RETURN_TX_OPTIONS = { timeout: 20_000, maxWait: 10_000 } as const;

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
    /** "collect" — для превью: держатели не останавливают, а возвращаются. */
    conflictMode?: "throw" | "collect";
    /**
     * Не раньше какого момента срок «до» (по умолчанию — `now`). Исправление
     * «Часть не вернули» разделяет от момента приёмки, а срок «до» всё равно
     * должен быть позже текущего.
     */
    untilNotBefore?: Date;
    /**
     * С какого момента проверять, не нужна ли оставленная позиция другой
     * брони. По умолчанию — с конца оплаченного: эти дни бронь и так держала.
     * Исправление «Часть не вернули» передаёт текущий момент: принятая бронь
     * склад уже не держит, а прошедшие дни не исправить.
     */
    conflictFrom?: Date;
  },
): Promise<{ continuationIds: string[]; conflicts: StayConflict[] }> {
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
    const floor = args.untilNotBefore ?? now;
    if (!Number.isFinite(until.getTime()) || until.getTime() <= floor.getTime()) {
      throw new HttpError(400, "Срок «до» должен быть позже текущего момента", PARTIAL_RETURN_ERROR_CODES.BAD_STAY);
    }
    if (until.getTime() > floor.getTime() + MAX_STAY_AHEAD_MS) {
      throw new HttpError(400, "Срок «до» — не дальше чем через год", PARTIAL_RETURN_ERROR_CODES.BAD_STAY);
    }
    const total = (keptByItem.get(item.id) ?? 0) + s.quantity;
    if (!Number.isInteger(s.quantity) || s.quantity <= 0 || total > item.quantity) {
      throw new HttpError(400, "Оставить можно от 1 до количества позиции", PARTIAL_RETURN_ERROR_CODES.BAD_STAY);
    }
    keptByItem.set(item.id, total);
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

  // ── сверх оплаченного: не нужна ли позиция другой брони ──────────────────
  const conflicts = await stayConflicts(tx, booking, args.stays, now, args.conflictFrom);
  // Под ответственность — только если подтвердили каждое оставленное этой
  // позиции, что выходит за начало конфликта (одна галочка не покрывает
  // другой срок той же позиции).
  const unacknowledged = conflicts.filter((c) =>
    args.stays.some(
      (s) =>
        s.bookingItemId === c.bookingItemId &&
        new Date(s.until).getTime() > Date.parse(c.from) &&
        s.acknowledgedConflict !== true,
    ),
  );
  if (unacknowledged.length > 0 && (args.conflictMode ?? "throw") === "throw") {
    const first = unacknowledged[0];
    const who = first.holder ? ` брони «${first.holder.projectName}»` : " другой брони";
    throw new HttpError(
      409,
      `Позиция «${first.name}» нужна${who} с ${formatMoscowDayTime(new Date(first.neededFrom))} — свободно ${Math.max(0, first.available)} из ${first.needed}. Оставить можно под ответственность.`,
      PARTIAL_RETURN_ERROR_CODES.CONFLICT,
      { conflicts: unacknowledged },
    );
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
          // Оставили, хотя позиция нужна другой брони, — «под ответственность».
          ...(stays.some((s) => s.acknowledgedConflict && conflicts.some((c) => c.bookingItemId === s.bookingItemId))
            ? {
                acknowledgedConflict: true,
                conflictBookingIds: conflicts
                  .filter((c) => stays.some((s) => s.bookingItemId === c.bookingItemId) && c.holder)
                  .map((c) => c.holder!.bookingId)
                  .join(", "),
              }
            : {}),
        },
      });
    }
    continuationIds.push(child.id);
  }
  return { continuationIds, conflicts };
}

/**
 * Не нужна ли оставленная сверх оплаченного позиция другой брони: склад на
 * дни «конец оплаченного → срок до» без самой основной брони (её позиции
 * сейчас уходят — часть на склад, часть в продолжение). Дни в пределах
 * оплаченного не проверяются: их бронь и так держала.
 */
async function stayConflicts(
  tx: Prisma.TransactionClient,
  booking: BookingWithItems,
  stays: ReadonlyArray<StayInput>,
  now: Date,
  conflictFrom?: Date,
): Promise<StayConflict[]> {
  const itemById = new Map(booking.items.map((i) => [i.id, i]));
  type Need = { bookingItemId: string; quantity: number; from: Date; until: Date };
  const byEquipment = new Map<string, Need[]>();
  for (const s of stays) {
    const item = itemById.get(s.bookingItemId);
    if (!item?.equipmentId) continue;
    const until = new Date(s.until);
    let from: Date;
    if (conflictFrom) {
      // Бронь уже принята и склад не держит — проверяется всё, что впереди.
      if (until.getTime() <= conflictFrom.getTime()) continue;
      from = conflictFrom;
    } else {
      const paidThrough = paidThroughAt(itemCoverage(booking, item), booking.skipPartialDay);
      if (until.getTime() <= paidThrough.getTime()) continue;
      from = new Date(Math.max(paidThrough.getTime(), now.getTime()));
    }
    const list = byEquipment.get(item.equipmentId) ?? [];
    list.push({ bookingItemId: item.id, quantity: s.quantity, from, until });
    byEquipment.set(item.equipmentId, list);
  }
  const out: StayConflict[] = [];
  if (byEquipment.size === 0) return out;
  // Своя семья (корень и продолжения) склад занимает, но держателем не
  // называется: иначе карточка говорила бы «нужна брони» о самой себе.
  const rootId = booking.rootBookingId ?? booking.id;
  const familyIds = (
    await tx.booking.findMany({ where: { OR: [{ id: rootId }, { rootBookingId: rootId }] }, select: { id: true } })
  ).map((b) => b.id);
  for (const [equipmentId, needs] of byEquipment) {
    // Разные сроки одной позиции: «1 шт до чт + 1 шт до сб» до четверга —
    // это 2 шт, после — 1. Проверяем по отрезкам между сроками, на каждом —
    // сколько ещё у клиента.
    const ends = Array.from(new Set(needs.map((n) => n.until.getTime()))).sort((a, b) => a - b);
    let segStart = new Date(Math.min(...needs.map((n) => n.from.getTime())));
    for (const end of ends) {
      const segEnd = new Date(end);
      if (segEnd.getTime() <= segStart.getTime()) continue;
      const involved = needs.filter((n) => n.until.getTime() >= end);
      const needed = involved.reduce((sum, n) => sum + n.quantity, 0);
      const [row] = await getAvailability({
        startDate: segStart,
        endDate: segEnd,
        equipmentIds: [equipmentId],
        excludeBookingId: booking.id,
        tx,
      });
      const available = row?.availableQuantity ?? 0;
      if (available < needed) {
        const holders = await findHoldersBatch(tx, {
          equipmentIds: [equipmentId],
          start: segStart,
          end: segEnd,
          excludeBookingId: booking.id,
          excludeHolderIds: familyIds,
        });
        // Держатель занимает позицию с начала своей брони, выданный раньше
        // срока — с момента выдачи, проект — со своей партии. Из нескольких
        // назван тот, кто занимает раньше, — то есть задевающий отрезок, если
        // такой есть. Кому она нужна только после срока «до», дефицит не
        // объясняет (окно поиска у длинной строки шире отрезка) — такого не
        // называем.
        const found = holders.get(equipmentId) ?? null;
        const occupiedFrom = found ? holderOccupiedFrom(found) : null;
        const holder = found && occupiedFrom! < segEnd.getTime() ? found : null;
        const neededFrom = holder ? Math.max(occupiedFrom!, segStart.getTime()) : segStart.getTime();
        out.push({
          bookingItemId: involved[0].bookingItemId,
          equipmentId,
          name: row?.equipment.name ?? "Позиция",
          needed,
          available,
          from: segStart.toISOString(),
          until: segEnd.toISOString(),
          neededFrom: new Date(neededFrom).toISOString(),
          holder,
        });
        // Одной карточки на позицию достаточно: решают по ней.
        break;
      }
      segStart = segEnd;
    }
  }
  return out;
}

/**
 * С какого момента держатель занимает позицию: начало брони или, у выданной
 * раньше срока, выдача. У партии проекта `from` — уже её фактическое начало
 * (выдача партии или первый день), так что формула та же — и совпадает с
 * началом резерва, по которому держатель выбран (addonAvailability).
 */
function holderOccupiedFrom(h: AddonConflict): number {
  const start = Date.parse(h.from);
  const issued = h.issuedAt ? Date.parse(h.issuedAt) : Number.POSITIVE_INFINITY;
  return Math.min(start, issued);
}

/** Превью продолжения для окна приёмки: цена дополнительной сметы, держатели. */
export type ContinuationPreview = {
  until: string;
  docNumber: string | null;
  expectedPaymentDate: string | null;
  lines: Array<{
    /** Позиция основной брони, из которой строка (для подписи у строки окна). */
    bookingItemId: string | null;
    name: string;
    quantity: number;
    billedShifts: number;
    lineSum: string;
    /** Сумма строки со скидкой брони (договорная цена — без скидки). */
    afterDiscount: string;
    negotiated: boolean;
  }>;
  /** Скидка брони, % — та же, что в основной смете. */
  discountPercent: string;
  subtotal: string;
  discountAmount: string;
  surchargeAmount: string;
  /** К оплате по продолжению (finalAmount). */
  total: string;
};

/**
 * Продолжения, только что записанные в транзакции, — в вид превью: строки
 * дополнительной сметы, смены, итог. Общий для приёмки и исправления приёмки.
 */
export async function continuationPreviewsInTx(
  tx: Prisma.TransactionClient,
  booking: BookingWithItems,
  continuationIds: string[],
): Promise<ContinuationPreview[]> {
  const children = await tx.booking.findMany({
    where: { id: { in: continuationIds } },
    include: { estimates: { where: { kind: "MAIN" }, include: { lines: true } } },
    orderBy: { endDate: "asc" },
  });
  const discount = booking.discountPercent ? new Decimal(booking.discountPercent.toString()) : new Decimal(0);
  const itemIdOf = (equipmentId: string | null, name: string) =>
    booking.items.find((i) => (equipmentId ? i.equipmentId === equipmentId : i.customName === name))?.id ?? null;
  return children.map((c) => {
    const est = c.estimates[0];
    return {
      until: c.endDate.toISOString(),
      docNumber: c.docNumber,
      expectedPaymentDate: c.expectedPaymentDate ? c.expectedPaymentDate.toISOString() : null,
      lines: (est?.lines ?? []).map((l) => {
        const negotiated = l.listUnitPrice != null;
        const sum = new Decimal(l.lineSum.toString());
        return {
          bookingItemId: itemIdOf(l.equipmentId, l.nameSnapshot),
          name: l.nameSnapshot,
          quantity: l.quantity,
          billedShifts: l.shifts ?? 0,
          lineSum: sum.toFixed(2),
          afterDiscount: (negotiated ? sum : sum.mul(new Decimal(100).sub(discount)).div(100)).toFixed(2),
          negotiated,
        };
      }),
      discountPercent: discount.toFixed(2),
      subtotal: est ? est.subtotal.toFixed(2) : "0.00",
      discountAmount: est ? est.discountAmount.toFixed(2) : "0.00",
      surchargeAmount: c.surchargeAmount.toFixed(2),
      total: c.finalAmount.toFixed(2),
    };
  });
}

/** Откат транзакции превью — результат уносится исключением. */
export class PreviewRollback extends Error {
  constructor(readonly result: { continuations: ContinuationPreview[]; conflicts: StayConflict[] }) {
    super("preview rollback");
  }
}

/**
 * «Что будет, если принять так»: те же проверки и та же запись, что у
 * приёмки, в транзакции, которая откатывается. Цена дополнительной сметы
 * поэтому совпадает с той, что запишется, — до копейки.
 */
export async function previewReturnPartial(
  bookingId: string,
  stays: StayInput[],
  now = new Date(),
): Promise<{ continuations: ContinuationPreview[]; conflicts: StayConflict[]; parentNegotiatedTotal: string | null }> {
  const paymentDates = await stayPaymentDates(stays);
  let parentNegotiatedTotal: string | null = null;
  try {
    await prisma.$transaction(async (tx) => {
      const booking = await loadIssued(tx, bookingId);
      parentNegotiatedTotal = booking.manualFinalAmount != null ? booking.manualFinalAmount.toString() : null;
      const { continuationIds, conflicts } = await splitOffContinuationsInTx(tx, {
        booking,
        stays,
        now,
        actorUserId: null,
        paymentDates,
        conflictMode: "collect",
      });
      throw new PreviewRollback({ conflicts, continuations: await continuationPreviewsInTx(tx, booking, continuationIds) });
    }, PARTIAL_RETURN_TX_OPTIONS);
  } catch (err) {
    if (err instanceof PreviewRollback) return { ...err.result, parentNegotiatedTotal };
    throw err;
  }
  return { continuations: [], conflicts: [], parentNegotiatedTotal };
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
    const { continuationIds } = await splitOffContinuationsInTx(tx, {
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
