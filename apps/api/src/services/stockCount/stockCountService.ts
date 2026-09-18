/**
 * Инвентаризация склада — жизненный цикл (спека §4).
 *
 *   старт → счёт строк (киоск / десктоп) → решения по расхождениям → завершение
 *                                                                 ↘ отмена
 *
 * - Открытая инвентаризация на систему одна (409 STOCK_COUNT_ALREADY_OPEN).
 * - Строки — только позиции с учётом количеством: штучные сверяются по единицам
 *   в карточке оборудования. Позицию, переведённую на штучный учёт уже после
 *   старта, считать и решать нельзя (409 LINE_NOT_COUNT_MODE), а завершение её
 *   пропускает: totalQuantity штучной позиции выводится из единиц.
 * - Счёт снимает снапшот «на полке должно быть» и сбрасывает решение, если итог
 *   строки изменился.
 * - Завершение применяет ВСЕ решения одной транзакцией: либо склад сверен целиком,
 *   либо не изменилось ничего.
 *
 * Аудит пишется только для действий с десктопа (AuditEntry.userId — FK на
 * AdminUser.id). Счёт строки не аудируется вовсе: высокочастотно, как галочки
 * чек-листа, а итог и так виден в акте.
 */

import type { StockCount, StockCountLine } from "@prisma/client";

import { prisma } from "../../prisma";
import { HttpError } from "../../utils/errors";
import { compareEquipmentTransportLast } from "../../utils/equipmentSort";
import { getMergedCategoryOrder } from "../categoryOrder";
import { writeAuditEntry } from "../audit";
import { computeExpectedOnShelf } from "./expected";
import { getEquipmentTrail } from "./equipmentTrail";
import {
  buildDetail,
  buildLineViews,
  buildSummary,
  filterLines,
  getOpenProblemQtyMap,
  getUnitModeIds,
  isUndecided,
  isUnitModeLine,
  lineDiff,
  lineEquipmentIds,
  type TxClient,
} from "./stockCountView";
import type {
  CompleteResult,
  Decision,
  EquipmentTrail,
  StockCountDetail,
  StockCountLineFilter,
  StockCountLineView,
  StockCountSummary,
} from "./types";

/** Кто действует с десктопа: id — для аудита, username — для подписей в акте. */
export interface StockCountActor {
  userId: string;
  username: string;
}

export const MAX_COUNT_QTY = 100_000;
/** Минимальная длина причины «Ошибки учёта» (после trim). */
export const ADJUST_REASON_MIN = 3;
/** Завершение на сотни строк — одна транзакция; дефолтных 5 с Prisma мало с запасом. */
const COMPLETE_TX_OPTIONS = { maxWait: 10_000, timeout: 60_000 };

// ── Загрузка с проверками ────────────────────────────────────────────────────

async function loadStockCount(tx: TxClient, id: string): Promise<StockCount> {
  const sc = await tx.stockCount.findUnique({ where: { id } });
  if (!sc) throw new HttpError(404, "Инвентаризация не найдена", "STOCK_COUNT_NOT_FOUND");
  return sc;
}

/**
 * Строка сверяется количеством, только пока позиция на учёте количеством.
 * SA может перевести позицию на штучный учёт посреди инвентаризации — тогда
 * снапшот, поправка totalQuantity и безъюнитная потеряшка были бы неправдой
 * (eu-1: totalQuantity штучной позиции выводится из единиц). Читается внутри
 * транзакции мутации.
 */
async function assertLineCountMode(tx: TxClient, equipmentId: string): Promise<void> {
  const equipment = await tx.equipment.findUnique({
    where: { id: equipmentId },
    select: { stockTrackingMode: true },
  });
  if (equipment?.stockTrackingMode === "UNIT") {
    throw new HttpError(
      409,
      "Позиция переведена на штучный учёт — её сверяют по единицам в карточке оборудования",
      "LINE_NOT_COUNT_MODE",
    );
  }
}

function assertOpen(sc: StockCount): void {
  if (sc.status !== "OPEN") {
    throw new HttpError(409, "Инвентаризация уже завершена или отменена", "STOCK_COUNT_NOT_OPEN");
  }
}

async function loadLine(tx: TxClient, stockCountId: string, lineId: string): Promise<StockCountLine> {
  const line = await tx.stockCountLine.findUnique({ where: { id: lineId } });
  if (!line || line.stockCountId !== stockCountId) {
    throw new HttpError(404, "Строка инвентаризации не найдена", "LINE_NOT_FOUND");
  }
  return line;
}

async function loadOpenLine(tx: TxClient, stockCountId: string, lineId: string) {
  const sc = await loadStockCount(tx, stockCountId);
  assertOpen(sc);
  const line = await loadLine(tx, stockCountId, lineId);
  return { sc, line };
}

async function loadLines(tx: TxClient, stockCountId: string, category?: string): Promise<StockCountLine[]> {
  return tx.stockCountLine.findMany({
    where: { stockCountId, ...(category ? { categorySnapshot: category } : {}) },
    orderBy: { position: "asc" },
  });
}

async function lineView(stockCountId: string, lineId: string): Promise<StockCountLineView> {
  const sc = await loadStockCount(prisma, stockCountId);
  const line = await loadLine(prisma, stockCountId, lineId);
  const [view] = await buildLineViews(sc.status, [line], new Date());
  return view!;
}

// ── Чтение ───────────────────────────────────────────────────────────────────

export async function getStockCountDetail(id: string): Promise<StockCountDetail> {
  const sc = await loadStockCount(prisma, id);
  return buildDetail(sc, await loadLines(prisma, id));
}

export async function getActiveStockCount(): Promise<StockCountDetail | null> {
  const sc = await prisma.stockCount.findFirst({ where: { status: "OPEN" }, orderBy: { number: "desc" } });
  if (!sc) return null;
  return buildDetail(sc, await loadLines(prisma, sc.id));
}

/** Все инвентаризации, новые сверху. Строки — одной выборкой на весь список. */
export async function listStockCounts(): Promise<StockCountSummary[]> {
  const counts = await prisma.stockCount.findMany({ orderBy: { number: "desc" } });
  if (counts.length === 0) return [];
  const lines = await prisma.stockCountLine.findMany({
    where: { stockCountId: { in: counts.map((c) => c.id) } },
    orderBy: { position: "asc" },
  });
  const unitModeIds = await getUnitModeIds(lineEquipmentIds(lines));
  const byCount = new Map<string, StockCountLine[]>();
  for (const line of lines) {
    const list = byCount.get(line.stockCountId) ?? [];
    list.push(line);
    byCount.set(line.stockCountId, list);
  }
  return counts.map((sc) => buildSummary(sc, byCount.get(sc.id) ?? [], unitModeIds));
}

export async function listStockCountLines(
  id: string,
  opts: { category?: string; filter?: StockCountLineFilter } = {},
): Promise<StockCountLineView[]> {
  const sc = await loadStockCount(prisma, id);
  const all = await loadLines(prisma, id, opts.category);
  const unitModeIds = await getUnitModeIds(lineEquipmentIds(all));
  const lines = filterLines(all, opts.filter ?? "all", unitModeIds);
  return buildLineViews(sc.status, lines, new Date());
}

/**
 * «Как пропало» для строки. Окно — от закрытия прошлой инвентаризации, в которой
 * позиция была посчитана. У завершённой инвентаризации `lastCountedAt` позиции
 * уже указывает на неё саму, поэтому окно выводится из истории строк, а след
 * строится на момент закрытия.
 */
export async function getStockCountLineTrail(id: string, lineId: string): Promise<EquipmentTrail> {
  const sc = await loadStockCount(prisma, id);
  const line = await loadLine(prisma, id, lineId);
  if (!line.equipmentId) {
    throw new HttpError(404, "Позиция удалена из каталога", "EQUIPMENT_NOT_FOUND");
  }
  const previous = await prisma.stockCountLine.findFirst({
    where: {
      equipmentId: line.equipmentId,
      countedQty: { not: null },
      stockCount: { status: "CLOSED", number: { lt: sc.number } },
    },
    orderBy: { stockCount: { number: "desc" } },
    select: { stockCount: { select: { closedAt: true } } },
  });
  const previousClosedAt = previous?.stockCount.closedAt ?? null;
  if (sc.status === "OPEN") {
    return getEquipmentTrail(line.equipmentId, { since: previousClosedAt ?? undefined });
  }
  return getEquipmentTrail(line.equipmentId, {
    since: previousClosedAt,
    at: sc.closedAt ?? sc.cancelledAt ?? new Date(),
  });
}

// ── Старт ────────────────────────────────────────────────────────────────────

function normalizeCategories(input: string[] | null | undefined): string[] | null {
  if (!input) return null;
  const list = Array.from(new Set(input.map((c) => c.trim()).filter((c) => c.length > 0)));
  return list.length > 0 ? list : null;
}

async function assertNoOpenStockCount(tx: TxClient): Promise<void> {
  const open = await tx.stockCount.findFirst({ where: { status: "OPEN" }, select: { number: true } });
  if (open) {
    throw new HttpError(
      409,
      `Уже идёт инвентаризация № ${open.number} — завершите или отмените её`,
      "STOCK_COUNT_ALREADY_OPEN",
    );
  }
}

export async function startStockCount(
  input: { categories?: string[] | null },
  actor: StockCountActor,
): Promise<StockCountDetail> {
  const categories = normalizeCategories(input.categories);
  await assertNoOpenStockCount(prisma);

  const equipments = await prisma.equipment.findMany({
    where: { stockTrackingMode: "COUNT", ...(categories ? { category: { in: categories } } : {}) },
    select: { id: true, name: true, category: true, sortOrder: true, rentalRatePerShift: true },
  });
  if (equipments.length === 0) {
    throw new HttpError(400, "В выбранном охвате нет позиций для пересчёта", "EMPTY_SCOPE");
  }
  const categoryOrder = await getMergedCategoryOrder();
  equipments.sort((a, b) => compareEquipmentTransportLast(a, b, categoryOrder));

  const created = await prisma.$transaction(async (tx) => {
    // Единственный сторож двойного клика. Проверка до транзакции одновременные
    // запросы не ловит никогда: оба видят «открытой нет». Уникального индекса на
    // status = OPEN нет (частичный индекс для SQLite в Prisma не объявить, а
    // сырой SQL `db push` счёл бы дрейфом), поэтому «одна открытая» держится
    // только тем, что интерактивные транзакции SQLite идут по очереди и вторая
    // видит запись первой здесь. Покрыто тестом «гонки: двойной клик».
    await assertNoOpenStockCount(tx);
    const max = await tx.stockCount.aggregate({ _max: { number: true } });
    const sc = await tx.stockCount.create({
      data: {
        number: (max._max.number ?? 0) + 1,
        categories: categories ? JSON.stringify(categories) : null,
        createdById: actor.userId,
        createdByName: actor.username,
      },
    });
    await tx.stockCountLine.createMany({
      data: equipments.map((e, index) => ({
        stockCountId: sc.id,
        equipmentId: e.id,
        nameSnapshot: e.name,
        categorySnapshot: e.category,
        rateSnapshot: e.rentalRatePerShift,
        position: index,
      })),
    });
    await writeAuditEntry({
      tx,
      userId: actor.userId,
      action: "STOCK_COUNT_START",
      entityType: "StockCount",
      entityId: sc.id,
      before: null,
      after: {
        number: sc.number,
        scope: categories ? categories.join(", ") : "весь склад",
        lines: equipments.length,
      },
    });
    return sc;
  }, COMPLETE_TX_OPTIONS);

  return getStockCountDetail(created.id);
}

// ── Счёт ─────────────────────────────────────────────────────────────────────

/** Поля решения строки в «не решено». */
const CLEARED_DECISION = {
  decision: null,
  decisionNote: null,
  decidedBy: null,
  decidedAt: null,
  sourceBookingId: null,
} as const;

export async function recordCount(
  stockCountId: string,
  lineId: string,
  qty: number,
  countedBy: string,
): Promise<StockCountLineView> {
  if (!Number.isInteger(qty) || qty < 0 || qty > MAX_COUNT_QTY) {
    throw new HttpError(400, `Количество — целое число от 0 до ${MAX_COUNT_QTY}`, "INVALID_QTY");
  }
  await prisma.$transaction(async (tx) => {
    const { line } = await loadOpenLine(tx, stockCountId, lineId);
    const equipmentId = line.equipmentId;
    if (equipmentId) await assertLineCountMode(tx, equipmentId);
    const now = new Date();
    const expected = equipmentId ? (await computeExpectedOnShelf([equipmentId], now, tx)).get(equipmentId) : undefined;
    if (!equipmentId || !expected) {
      throw new HttpError(409, "Позиция удалена из каталога — считать нечего", "EQUIPMENT_DELETED");
    }
    // Любое изменение итога строки (посчитано или «должно быть») сбрасывает
    // решение: «Пропало» на строке, которая после пересчёта сошлась или ушла в
    // излишек, применило бы на завершении неправду.
    const changed = line.countedQty !== qty || line.expectedQty !== expected.expected;
    await tx.stockCountLine.update({
      where: { id: line.id },
      data: {
        totalAtCount: expected.total,
        issuedAtCount: expected.issued,
        calendarAtCount: expected.calendar,
        repairAtCount: expected.repair,
        lostAtCount: expected.lost,
        expectedQty: expected.expected,
        countedQty: qty,
        countedBy,
        countedAt: now,
        ...(changed ? CLEARED_DECISION : {}),
      },
    });
  });
  return lineView(stockCountId, lineId);
}

/**
 * «Пересчитать»: строка снова не посчитана — без снапшота и без решения.
 * Режим учёта не проверяется: сбросить устаревший счёт позиции, ушедшей на
 * штучный учёт, должно быть можно.
 */
export async function resetCount(stockCountId: string, lineId: string): Promise<StockCountLineView> {
  await prisma.$transaction(async (tx) => {
    const { line } = await loadOpenLine(tx, stockCountId, lineId);
    await tx.stockCountLine.update({
      where: { id: line.id },
      data: {
        totalAtCount: null,
        issuedAtCount: null,
        calendarAtCount: null,
        repairAtCount: null,
        lostAtCount: null,
        expectedQty: null,
        countedQty: null,
        countedBy: null,
        countedAt: null,
        ...CLEARED_DECISION,
      },
    });
  });
  return lineView(stockCountId, lineId);
}

// ── Решения ──────────────────────────────────────────────────────────────────

export interface DecisionInput {
  decision: Decision | null;
  note?: string | null;
  sourceBookingId?: string | null;
}

export async function decideLine(
  stockCountId: string,
  lineId: string,
  input: DecisionInput,
  decidedBy: string,
): Promise<StockCountLineView> {
  await prisma.$transaction(async (tx) => {
    const { line } = await loadOpenLine(tx, stockCountId, lineId);
    if (input.decision === null) {
      // Снять решение можно всегда — в том числе у позиции, ушедшей на штучный учёт.
      await tx.stockCountLine.update({ where: { id: line.id }, data: CLEARED_DECISION });
      return;
    }
    if (line.equipmentId) await assertLineCountMode(tx, line.equipmentId);
    const diff = lineDiff(line);
    if (diff == null || diff === 0) {
      throw new HttpError(409, "Решение нужно только для посчитанной строки с расхождением", "LINE_NOT_DISCREPANT");
    }
    const note = input.note?.trim() ? input.note.trim() : null;
    let sourceBookingId: string | null = null;

    if (input.decision === "LOST") {
      if (diff > 0) {
        throw new HttpError(400, "«Пропало» — только для недостачи", "DECISION_NOT_APPLICABLE");
      }
      if (input.sourceBookingId) {
        const booking = await tx.booking.findUnique({ where: { id: input.sourceBookingId }, select: { id: true } });
        if (!booking) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");
        sourceBookingId = booking.id;
      }
    } else if (input.decision === "ADJUST") {
      if (!note || note.length < ADJUST_REASON_MIN) {
        throw new HttpError(400, "Укажите причину поправки — не короче 3 символов", "REASON_REQUIRED");
      }
    } else if (input.decision === "FOUND") {
      if (diff < 0 || !line.equipmentId) {
        throw new HttpError(400, "«Нашлось» — только для излишка", "DECISION_NOT_APPLICABLE");
      }
      const open = (await getOpenProblemQtyMap([line.equipmentId], tx)).get(line.equipmentId) ?? 0;
      if (open === 0) {
        throw new HttpError(400, "По позиции нет открытых потеряшек — закрывать нечего", "DECISION_NOT_APPLICABLE");
      }
    }

    await tx.stockCountLine.update({
      where: { id: line.id },
      data: {
        decision: input.decision,
        decisionNote: note,
        decidedBy,
        decidedAt: new Date(),
        sourceBookingId,
      },
    });
  });
  return lineView(stockCountId, lineId);
}

// ── Завершение ───────────────────────────────────────────────────────────────

interface ApplyContext {
  tx: TxClient;
  sc: StockCount;
  actor: StockCountActor;
  now: Date;
  result: CompleteResult;
}

/** «Пропало» → потеряшка «Не нашли на складе» на всю недостачу. */
async function applyLost(ctx: ApplyContext, line: StockCountLine, equipmentId: string, diff: number) {
  const qty = -diff;
  const pi = await ctx.tx.problemItem.create({
    data: {
      equipmentId,
      quantity: qty,
      reason: "NOT_ON_SHELF",
      status: "SEARCHING",
      source: "STOCK_COUNT",
      stockCountId: ctx.sc.id,
      sourceBookingId: line.sourceBookingId,
      comment: line.decisionNote ?? `Не нашли при инвентаризации № ${ctx.sc.number}`,
      createdBy: ctx.actor.username,
    },
  });
  ctx.result.lostPositions += 1;
  ctx.result.lostQty += qty;
  ctx.result.createdProblemItemIds.push(pi.id);
}

/**
 * «Ошибка учёта» → поправка totalQuantity на расхождение. Дельта прикладывается
 * к ТЕКУЩЕМУ значению, а не к снапшоту: если за время инвентаризации позицию
 * докупили или списали, поправка не должна эту правку затереть.
 */
async function applyAdjust(ctx: ApplyContext, line: StockCountLine, equipmentId: string, diff: number) {
  const current = await ctx.tx.equipment.findUnique({
    where: { id: equipmentId },
    select: { totalQuantity: true },
  });
  if (!current) return;
  const next = Math.max(0, current.totalQuantity + diff);
  await ctx.tx.equipment.update({ where: { id: equipmentId }, data: { totalQuantity: next } });
  await writeAuditEntry({
    tx: ctx.tx,
    userId: ctx.actor.userId,
    action: "STOCK_ADJUST",
    entityType: "Equipment",
    entityId: equipmentId,
    before: { totalQuantity: current.totalQuantity },
    after: {
      totalQuantity: next,
      diff,
      reason: line.decisionNote,
      stockCountId: ctx.sc.id,
      stockCountNumber: ctx.sc.number,
    },
  });
  ctx.result.adjustedPositions += 1;
}

/**
 * «Нашлось» → закрыть открытые безъюнитные потеряшки позиции от старых к новым
 * на `diff` штук. Строка, которая помещается целиком, закрывается как FOUND;
 * не помещается — у открытой уменьшается количество, а найденная часть
 * выделяется копией в статусе FOUND (история «что и когда нашли» не теряется).
 * Излишек сверх открытых потеряшек учёт не меняет и уходит в акт.
 */
async function applyFound(ctx: ApplyContext, equipmentId: string, diff: number) {
  const resolutionNote = `Найдено при инвентаризации № ${ctx.sc.number}`;
  const rows = await ctx.tx.problemItem.findMany({
    where: {
      equipmentUnitId: null,
      status: { in: ["EXPECTED", "SEARCHING"] },
      OR: [{ equipmentId }, { bookingItem: { equipmentId } }],
    },
    include: { bookingItem: { select: { equipmentId: true } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  let remaining = diff;
  let found = 0;
  for (const row of rows) {
    if (remaining <= 0) break;
    if ((row.equipmentId ?? row.bookingItem?.equipmentId) !== equipmentId) continue;
    if (row.quantity <= remaining) {
      await ctx.tx.problemItem.update({
        where: { id: row.id },
        data: {
          status: "FOUND",
          equipmentId,
          resolvedAt: ctx.now,
          resolvedBy: ctx.actor.username,
          resolutionNote,
        },
      });
      remaining -= row.quantity;
      found += row.quantity;
      continue;
    }
    await ctx.tx.problemItem.update({
      where: { id: row.id },
      data: { quantity: row.quantity - remaining, equipmentId },
    });
    await ctx.tx.problemItem.create({
      data: {
        equipmentUnitId: null,
        bookingItemId: row.bookingItemId,
        equipmentId,
        quantity: remaining,
        sourceBookingId: row.sourceBookingId,
        reason: row.reason,
        comment: row.comment,
        expectedBackDate: row.expectedBackDate,
        source: row.source,
        stockCountId: row.stockCountId,
        createdBy: row.createdBy,
        createdAt: row.createdAt,
        status: "FOUND",
        resolvedAt: ctx.now,
        resolvedBy: ctx.actor.username,
        resolutionNote,
      },
    });
    found += remaining;
    remaining = 0;
  }
  ctx.result.foundPositions += 1;
  ctx.result.foundQty += found;
  ctx.result.unexplainedSurplusQty += remaining;
}

function emptyResult(): CompleteResult {
  return {
    matched: 0,
    lostPositions: 0,
    lostQty: 0,
    createdProblemItemIds: [],
    adjustedPositions: 0,
    foundPositions: 0,
    foundQty: 0,
    unexplainedSurplusQty: 0,
    verifiedPositions: 0,
    uncounted: 0,
    unitModeSkipped: 0,
  };
}

export async function completeStockCount(
  id: string,
  actor: StockCountActor,
): Promise<{ stockCount: StockCountDetail; result: CompleteResult }> {
  const result = await prisma.$transaction(async (tx) => {
    const sc = await loadStockCount(tx, id);
    // Единственный сторож двойного «Завершить», и место ему — только здесь:
    // проверка статуса до транзакции одновременные запросы не ловит (оба видят
    // OPEN), а тут вторая транзакция видит CLOSED первой и получает 409 —
    // решения не применяются дважды (двойные потеряшки, двойная поправка
    // totalQuantity). Покрыто тестом «гонки: двойной клик».
    assertOpen(sc);
    const lines = await loadLines(tx, id);
    // Режим учёта читается на момент завершения: позиция могла уйти на штучный
    // учёт после старта. Такие строки решения не ждут и эффектов не дают.
    const unitModeIds = await getUnitModeIds(lineEquipmentIds(lines), tx);
    const undecided = lines.filter((l) => isUndecided(l, unitModeIds)).length;
    if (undecided > 0) {
      throw new HttpError(409, `Осталось решить: ${undecided}`, "UNDECIDED_LINES", { count: undecided });
    }

    const ctx: ApplyContext = { tx, sc, actor, now: new Date(), result: emptyResult() };
    const verifiedIds: string[] = [];
    for (const line of lines) {
      const diff = lineDiff(line);
      if (diff == null) {
        ctx.result.uncounted += 1;
        continue;
      }
      if (diff === 0) ctx.result.matched += 1;
      // Позиция удалена из каталога — строка остаётся в акте, но эффектов не даёт.
      if (!line.equipmentId) continue;
      // Позиция ушла на штучный учёт: её сверяют по единицам, поэтому ни поправки,
      // ни потеряшки, ни отметки «сверено» количеством.
      if (isUnitModeLine(line, unitModeIds)) {
        ctx.result.unitModeSkipped += 1;
        continue;
      }
      verifiedIds.push(line.equipmentId);
      if (diff === 0) continue;
      if (line.decision === "LOST" && diff < 0) await applyLost(ctx, line, line.equipmentId, diff);
      else if (line.decision === "ADJUST") await applyAdjust(ctx, line, line.equipmentId, diff);
      else if (line.decision === "FOUND" && diff > 0) await applyFound(ctx, line.equipmentId, diff);
    }

    if (verifiedIds.length > 0) {
      await tx.equipment.updateMany({ where: { id: { in: verifiedIds } }, data: { lastCountedAt: ctx.now } });
    }
    ctx.result.verifiedPositions = verifiedIds.length;

    await tx.stockCount.update({
      where: { id },
      data: { status: "CLOSED", closedAt: ctx.now, closedById: actor.userId, closedByName: actor.username },
    });
    const { createdProblemItemIds, ...summary } = ctx.result;
    await writeAuditEntry({
      tx,
      userId: actor.userId,
      action: "STOCK_COUNT_CLOSE",
      entityType: "StockCount",
      entityId: id,
      before: { status: "OPEN" },
      after: {
        status: "CLOSED",
        number: sc.number,
        ...summary,
        createdProblemItems: createdProblemItemIds.length,
      },
    });
    return ctx.result;
  }, COMPLETE_TX_OPTIONS);

  return { stockCount: await getStockCountDetail(id), result };
}

// ── Отмена ───────────────────────────────────────────────────────────────────

export async function cancelStockCount(id: string, actor: StockCountActor): Promise<StockCountDetail> {
  await prisma.$transaction(async (tx) => {
    const sc = await loadStockCount(tx, id);
    assertOpen(sc);
    await tx.stockCount.update({ where: { id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    await writeAuditEntry({
      tx,
      userId: actor.userId,
      action: "STOCK_COUNT_CANCEL",
      entityType: "StockCount",
      entityId: id,
      before: { status: "OPEN" },
      after: { status: "CANCELLED", number: sc.number },
    });
  });
  return getStockCountDetail(id);
}
