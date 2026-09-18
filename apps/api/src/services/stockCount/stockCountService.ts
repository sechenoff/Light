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
 * - Снапшот «на полке должно быть» снимается при первом счёте строки (или после
 *   «Пересчитать»); правка посчитанной строки сравнивается с тем же снапшотом, а
 *   если «должно быть» с тех пор изменилось — 409 EXPECTATION_CHANGED, нужно
 *   «Пересчитать» (или «Обновить ожидание», если учёт лишь догнал полку). Любое
 *   изменение счёта сбрасывает решение.
 * - Решение привязано к тому, что руководитель видел (seen-значения, 409
 *   LINE_CHANGED), а «Пропало» / «Ошибка учёта» на строке, чей учёт изменился
 *   после счёта, — явный выбор «оставить как посчитано» (409 LINE_BOOKS_CHANGED).
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
import { computeExpectedOnShelf, toBreakdown } from "./expected";
import { getEquipmentTrail, getTrailSuggestionsFor, resolveTrailWindow, type TrailTarget } from "./equipmentTrail";
import {
  booksDecisionHolds,
  buildDetail,
  buildLineViews,
  buildSummary,
  filterLines,
  getFoundOpenMap,
  getOpenProblemQtyMap,
  getUnitModeIds,
  isUndecided,
  isUnitModeLine,
  lineDiff,
  lineEquipmentIds,
  sameBooks,
  snapshotBreakdown,
  type TxClient,
} from "./stockCountView";
import type {
  Breakdown,
  CompleteResult,
  Decision,
  EquipmentTrail,
  StockCountDetail,
  StockCountLineFilter,
  StockCountLineView,
  StockCountScope,
  StockCountSummary,
  TrailSuggestion,
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
  const summaries: StockCountSummary[] = [];
  for (const sc of counts) {
    const own = byCount.get(sc.id) ?? [];
    summaries.push(buildSummary(sc, own, unitModeIds, await getFoundOpenMap(sc.status, own)));
  }
  return summaries;
}

export async function listStockCountLines(
  id: string,
  opts: { category?: string; filter?: StockCountLineFilter } = {},
): Promise<StockCountLineView[]> {
  const sc = await loadStockCount(prisma, id);
  const all = await loadLines(prisma, id, opts.category);
  const unitModeIds = await getUnitModeIds(lineEquipmentIds(all));
  const foundOpen = opts.filter === "undecided" ? await getFoundOpenMap(sc.status, all) : undefined;
  const lines = filterLines(all, opts.filter ?? "all", unitModeIds, foundOpen);
  return buildLineViews(sc.status, lines, new Date());
}

/**
 * Прошлые сверки позиций: equipmentId → момент счёта её строки в последней
 * ЗАВЕРШЁННОЙ инвентаризации до этой. Отменённые не в счёт, сама текущая —
 * тоже (у завершённой `lastCountedAt` позиции уже указывает на неё саму).
 */
async function previousCountedAt(sc: StockCount, equipmentIds: string[]): Promise<Map<string, Date>> {
  const result = new Map<string, Date>();
  if (equipmentIds.length === 0) return result;
  const rows = await prisma.stockCountLine.findMany({
    where: {
      equipmentId: { in: equipmentIds },
      countedQty: { not: null },
      stockCount: { status: "CLOSED", number: { lt: sc.number } },
    },
    select: { equipmentId: true, countedAt: true, stockCount: { select: { number: true } } },
  });
  const best = new Map<string, number>();
  for (const row of rows) {
    if (!row.equipmentId || !row.countedAt) continue;
    if ((best.get(row.equipmentId) ?? -1) >= row.stockCount.number) continue;
    best.set(row.equipmentId, row.stockCount.number);
    result.set(row.equipmentId, row.countedAt);
  }
  return result;
}

/**
 * На какой момент строится след строки: посчитанной — на момент счёта (тогда
 * «ещё у клиента» совпадает со снапшотом), иначе — сейчас у идущей и момент
 * закрытия у завершённой / отменённой.
 */
function trailAt(sc: StockCount, line: StockCountLine, now: Date): Date {
  if (line.countedQty != null && line.countedAt) return line.countedAt;
  return sc.status === "OPEN" ? now : (sc.closedAt ?? sc.cancelledAt ?? now);
}

/**
 * Окно следа строки: от момента, когда позицию посчитали в прошлой завершённой
 * инвентаризации. Прошлой нет: у идущей — `lastCountedAt` позиции (или окно по
 * умолчанию), у завершённой / отменённой — окно по умолчанию (её собственная
 * сверка окном быть не может).
 */
function trailSince(sc: StockCount, previous: Date | undefined): Date | null | undefined {
  if (previous) return previous;
  return sc.status === "OPEN" ? undefined : null;
}

/**
 * «Как пропало» для строки. Окно — от момента счёта позиции в прошлой
 * завершённой инвентаризации; след строится на момент счёта строки.
 */
export async function getStockCountLineTrail(id: string, lineId: string): Promise<EquipmentTrail> {
  const sc = await loadStockCount(prisma, id);
  const line = await loadLine(prisma, id, lineId);
  if (!line.equipmentId) {
    throw new HttpError(404, "Позиция удалена из каталога", "EQUIPMENT_NOT_FOUND");
  }
  const previous = (await previousCountedAt(sc, [line.equipmentId])).get(line.equipmentId);
  return getEquipmentTrail(line.equipmentId, {
    since: trailSince(sc, previous),
    at: trailAt(sc, line, new Date()),
  });
}

/**
 * Подсказки «Как пропало» для всех недостач идущей инвентаризации — одним
 * набором запросов, без полного следа на строку. lineId → бронь или null.
 * Ровно то, что показал бы раскрытый след строки (`visibleSuggestion`).
 */
export async function getTrailSuggestions(id: string): Promise<Record<string, TrailSuggestion | null>> {
  const sc = await loadStockCount(prisma, id);
  if (sc.status !== "OPEN") return {};
  const lines = (await loadLines(prisma, id)).filter((l) => l.equipmentId && (lineDiff(l) ?? 0) < 0);
  if (lines.length === 0) return {};
  const ids = lineEquipmentIds(lines);
  const previous = await previousCountedAt(sc, ids);
  const equipments = await prisma.equipment.findMany({
    where: { id: { in: ids } },
    select: { id: true, lastCountedAt: true },
  });
  const lastCounted = new Map(equipments.map((e) => [e.id, e.lastCountedAt]));
  const now = new Date();
  const targets: Array<TrailTarget & { lineId: string }> = [];
  for (const line of lines) {
    const equipmentId = line.equipmentId as string;
    if (!lastCounted.has(equipmentId)) continue;
    const at = trailAt(sc, line, now);
    const { windowFrom } = resolveTrailWindow(
      lastCounted.get(equipmentId) ?? null,
      trailSince(sc, previous.get(equipmentId)),
      at,
    );
    targets.push({ lineId: line.id, equipmentId, windowFrom, at });
  }
  const byEquipment = await getTrailSuggestionsFor(targets);
  const result: Record<string, TrailSuggestion | null> = {};
  for (const t of targets) result[t.lineId] = byEquipment.get(t.equipmentId) ?? null;
  return result;
}

/**
 * Охват для «Начать инвентаризацию»: категории в порядке каталога и сколько в
 * каждой позиций с учётом количеством (их и посчитает инвентаризация) и
 * штучных (сверяются в карточке единиц). Ключ — сырое имя категории: старт
 * фильтрует тем же точным равенством.
 */
export async function getStockCountScope(): Promise<StockCountScope> {
  const categories = await getMergedCategoryOrder();
  const counts: Record<string, number> = {};
  const unitCounts: Record<string, number> = {};
  const rows = await prisma.equipment.groupBy({
    by: ["category", "stockTrackingMode"],
    _count: { _all: true },
  });
  for (const row of rows) {
    const target = row.stockTrackingMode === "UNIT" ? unitCounts : counts;
    target[row.category] = (target[row.category] ?? 0) + row._count._all;
  }
  for (const c of categories) {
    counts[c] ??= 0;
    unitCounts[c] ??= 0;
  }
  return { categories, counts, unitCounts };
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
  decidedById: null,
  decidedAt: null,
  sourceBookingId: null,
  decisionBasis: null,
} as const;

/** Снапшот ожидания строки из живой разбивки. */
function snapshotFields(expected: Breakdown) {
  return {
    totalAtCount: expected.total,
    issuedAtCount: expected.issued,
    calendarAtCount: expected.calendar,
    repairAtCount: expected.repair,
    lostAtCount: expected.lost,
    expectedQty: expected.expected,
  };
}

/**
 * Живое ожидание позиции строки внутри транзакции мутации. Позиция удалена из
 * каталога — считать и сверять не с чем (409 EQUIPMENT_DELETED).
 */
async function liveExpectation(
  tx: TxClient,
  line: StockCountLine,
  now: Date,
): Promise<{ equipmentId: string; expected: Breakdown }> {
  const equipmentId = line.equipmentId;
  if (equipmentId) await assertLineCountMode(tx, equipmentId);
  const expected = equipmentId ? (await computeExpectedOnShelf([equipmentId], now, tx)).get(equipmentId) : undefined;
  if (!equipmentId || !expected) {
    throw new HttpError(409, "Позиция удалена из каталога — считать нечего", "EQUIPMENT_DELETED");
  }
  return { equipmentId, expected: toBreakdown(expected) };
}

/**
 * Счёт строки.
 *
 *  - Первый счёт (или после «Пересчитать») снимает снапшот «на полке должно
 *    быть» — дальше выдачи и возвраты итог строки не сбивают.
 *  - То же число ещё раз (повтор запроса, второй клик «на месте», досылка
 *    отложенного) — ничего не меняет: ни снапшот, ни решение, ни `countedAt`.
 *  - Правка посчитанной строки сравнивается с ТЕМ ЖЕ снапшотом: новое число
 *    против старого ожидания. Если «должно быть» с тех пор изменилось (выдача,
 *    возврат, календарь, мастерская, потеряшки), правка против старого
 *    снапшота показала бы расхождение, которого нет, а против нового — смешала
 *    бы старый счёт полки с новым учётом. Тогда 409 EXPECTATION_CHANGED: строку
 *    нужно «Пересчитать» и посчитать полку заново.
 *  Любое изменение числа сбрасывает решение строки.
 */
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
    const now = new Date();
    const { expected } = await liveExpectation(tx, line, now);

    if (line.countedQty == null) {
      await tx.stockCountLine.update({
        where: { id: line.id },
        data: { ...snapshotFields(expected), countedQty: qty, countedBy, countedAt: now, ...CLEARED_DECISION },
      });
      return;
    }
    if (line.countedQty === qty) return;
    if (expected.expected !== line.expectedQty) {
      throw new HttpError(
        409,
        "Учёт позиции изменился после счёта (выдача, возврат, календарь, мастерская или потеряшки) — нажмите «Пересчитать» и посчитайте полку заново",
        "EXPECTATION_CHANGED",
        { snapshotExpected: line.expectedQty, liveExpected: expected.expected },
      );
    }
    // Ожидание то же — правка сравнивается с прежним снапшотом.
    await tx.stockCountLine.update({
      where: { id: line.id },
      data: { countedQty: qty, countedBy, countedAt: now, ...CLEARED_DECISION },
    });
  });
  return lineView(stockCountId, lineId);
}

/**
 * «Обновить ожидание»: снапшот снимается заново по живому учёту, счёт полки
 * остаётся. Верно, когда учёт лишь догнал то, что уже было на полке при счёте
 * (бронь вернули кнопкой после того, как оборудование разгрузили). Неверно,
 * когда движение случилось ПОСЛЕ счёта — тогда «оставить как посчитано».
 * Поэтому только явное действие руководителя, а не автоматика.
 *
 * `countedAt` не трогается: полку посчитали тогда же, когда и раньше (от него
 * считаются окно следа и отсечка «Нашлось»). Изменилось «должно быть» —
 * решение сбрасывается, как при любом изменении итога строки.
 */
export async function refreshExpectation(stockCountId: string, lineId: string): Promise<StockCountLineView> {
  await prisma.$transaction(async (tx) => {
    const { line } = await loadOpenLine(tx, stockCountId, lineId);
    if (line.countedQty == null) {
      throw new HttpError(409, "Строка ещё не посчитана — обновлять нечего", "LINE_NOT_COUNTED");
    }
    const { expected } = await liveExpectation(tx, line, new Date());
    const changed = expected.expected !== line.expectedQty;
    await tx.stockCountLine.update({
      where: { id: line.id },
      data: { ...snapshotFields(expected), ...(changed ? CLEARED_DECISION : { decisionBasis: null }) },
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
  /** Счёт строки, который руководитель видел, принимая решение (обязателен для решения). */
  seenCountedQty?: number;
  /** «На полке должно быть», которое он видел (снапшот строки). */
  seenExpectedQty?: number;
  /** «Оставить как посчитано»: учёт изменился после счёта, но решение — по счёту. */
  acknowledgeBooksChanged?: boolean;
}

/**
 * Решение привязано к ровно тому расхождению, которое видел руководитель: если
 * строку тем временем пересчитали (киоск, другая вкладка), решение с чужой
 * причиной легло бы на новое расхождение — 409 LINE_CHANGED. Сравниваются счёт
 * и ожидание (а не только разница) — то же правило, по которому счёт сбрасывает
 * решение.
 */
function assertSeenLine(line: StockCountLine, input: DecisionInput): void {
  if (input.seenCountedQty == null || input.seenExpectedQty == null) {
    throw new HttpError(400, "Не указано, какой счёт строки вы видели", "SEEN_VALUES_REQUIRED");
  }
  if (line.countedQty !== input.seenCountedQty || line.expectedQty !== input.seenExpectedQty) {
    throw new HttpError(409, "Строку пересчитали — проверьте новое расхождение и решите заново", "LINE_CHANGED", {
      countedQty: line.countedQty,
      expectedQty: line.expectedQty,
      diff: lineDiff(line),
    });
  }
}

/**
 * «Пропало» и «Ошибка учёта» опираются на снапшот. Если учёт позиции изменился
 * после счёта, это либо учёт догнал полку («Обновить ожидание»), либо движение
 * случилось после счёта («оставить как посчитано»). Выбор — только явный:
 * без `acknowledgeBooksChanged` — 409 LINE_BOOKS_CHANGED. Подтверждённый живой
 * учёт запоминается в `decisionBasis`, и завершение сверит его ещё раз.
 */
async function booksBasisFor(
  tx: TxClient,
  line: StockCountLine,
  input: DecisionInput,
  now: Date,
): Promise<string | null> {
  if (!line.equipmentId) return null;
  const liveEntry = (await computeExpectedOnShelf([line.equipmentId], now, tx)).get(line.equipmentId);
  if (!liveEntry) return null;
  const live = toBreakdown(liveEntry);
  const snapshot = snapshotBreakdown(line);
  if (sameBooks(live, snapshot)) return null;
  if (!input.acknowledgeBooksChanged) {
    throw new HttpError(
      409,
      "Учёт позиции изменился после счёта — обновите ожидание или подтвердите «оставить как посчитано»",
      "LINE_BOOKS_CHANGED",
      { snapshot, live },
    );
  }
  return JSON.stringify(live);
}

export async function decideLine(
  stockCountId: string,
  lineId: string,
  input: DecisionInput,
  decider: StockCountActor,
): Promise<StockCountLineView> {
  await prisma.$transaction(async (tx) => {
    const { sc, line } = await loadOpenLine(tx, stockCountId, lineId);
    if (input.decision === null) {
      // Снять решение можно всегда — в том числе у позиции, ушедшей на штучный учёт.
      await tx.stockCountLine.update({ where: { id: line.id }, data: CLEARED_DECISION });
      return;
    }
    if (line.equipmentId) await assertLineCountMode(tx, line.equipmentId);
    assertSeenLine(line, input);
    const diff = lineDiff(line);
    if (diff == null || diff === 0) {
      throw new HttpError(409, "Решение нужно только для посчитанной строки с расхождением", "LINE_NOT_DISCREPANT");
    }
    const now = new Date();
    const note = input.note?.trim() ? input.note.trim() : null;
    let sourceBookingId: string | null = null;
    let decisionBasis: string | null = null;

    if (input.decision === "LOST") {
      if (diff > 0) {
        throw new HttpError(400, "«Пропало» — только для недостачи", "DECISION_NOT_APPLICABLE");
      }
      if (input.sourceBookingId) {
        const booking = await tx.booking.findUnique({ where: { id: input.sourceBookingId }, select: { id: true } });
        if (!booking) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");
        sourceBookingId = booking.id;
      }
      decisionBasis = await booksBasisFor(tx, line, input, now);
    } else if (input.decision === "ADJUST") {
      if (!note || note.length < ADJUST_REASON_MIN) {
        throw new HttpError(400, "Укажите причину поправки — не короче 3 символов", "REASON_REQUIRED");
      }
      decisionBasis = await booksBasisFor(tx, line, input, now);
    } else if (input.decision === "FOUND") {
      if (diff < 0 || !line.equipmentId || !line.countedAt) {
        throw new HttpError(400, "«Нашлось» — только для излишка", "DECISION_NOT_APPLICABLE");
      }
      // Закрыть можно только потеряшки, заведённые не позже счёта строки.
      const cutoff = new Map([[line.equipmentId, line.countedAt]]);
      const open = (await getOpenProblemQtyMap([line.equipmentId], tx, cutoff)).get(line.equipmentId) ?? 0;
      if (open === 0) {
        throw new HttpError(400, "По позиции нет открытых потеряшек — закрывать нечего", "DECISION_NOT_APPLICABLE");
      }
    }

    await tx.stockCountLine.update({
      where: { id: line.id },
      data: {
        decision: input.decision,
        decisionNote: note,
        decidedBy: decider.username,
        decidedById: decider.userId,
        decidedAt: now,
        sourceBookingId,
        decisionBasis,
      },
    });
    // «Ошибка учёта» — единственный путь, которым кладовщик меняет количество в
    // каталоге. Кто и почему решил — в журнал сразу, а не только при завершении.
    if (input.decision === "ADJUST") {
      await writeAuditEntry({
        tx,
        userId: decider.userId,
        action: "STOCK_COUNT_DECISION",
        entityType: "StockCount",
        entityId: sc.id,
        before: null,
        after: {
          lineId: line.id,
          equipmentId: line.equipmentId,
          name: line.nameSnapshot,
          diff,
          reason: note,
          stockCountNumber: sc.number,
        },
      });
    }
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
      // Кто решил — отдельно от того, кто завершил (userId записи). В userId
      // решившего не пишем: AuditEntry.userId — FK на AdminUser, и удалённый до
      // завершения пользователь откатил бы всю транзакцию.
      decidedBy: line.decidedBy,
      decidedById: line.decidedById,
      decidedAt: line.decidedAt?.toISOString() ?? null,
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
 *
 * Только потеряшки, заведённые не позже счёта строки (они и были в снапшоте), и
 * не больше, чем их было в снапшоте (`lostAtCount`). Заведённые позже — вещи,
 * которых на полке при счёте не было (например, «остался на площадке» с
 * приёмки во время инвентаризации): их никто не нашёл, они остаются открытыми.
 */
async function applyFound(ctx: ApplyContext, line: StockCountLine, equipmentId: string, diff: number) {
  const resolutionNote = `Найдено при инвентаризации № ${ctx.sc.number}`;
  const rows = await ctx.tx.problemItem.findMany({
    where: {
      equipmentUnitId: null,
      status: { in: ["EXPECTED", "SEARCHING"] },
      OR: [{ equipmentId }, { bookingItem: { equipmentId } }],
      ...(line.countedAt ? { createdAt: { lte: line.countedAt } } : {}),
    },
    include: { bookingItem: { select: { equipmentId: true } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  let remaining = Math.min(diff, line.lostAtCount ?? 0);
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
  ctx.result.unexplainedSurplusQty += diff - found;
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

/**
 * «Сверено» — когда полку посчитали, а не когда нажали «Завершить»: от этого
 * момента считается окно «Как пропало» следующей инвентаризации, а между счётом
 * и завершением могут пройти дни. Строк с одним моментом счёта — одним запросом.
 */
async function markVerified(tx: TxClient, verified: Array<{ equipmentId: string; countedAt: Date }>): Promise<void> {
  const byMoment = new Map<number, string[]>();
  for (const v of verified) {
    const list = byMoment.get(v.countedAt.getTime()) ?? [];
    list.push(v.equipmentId);
    byMoment.set(v.countedAt.getTime(), list);
  }
  for (const [moment, ids] of byMoment) {
    await tx.equipment.updateMany({ where: { id: { in: ids } }, data: { lastCountedAt: new Date(moment) } });
  }
}

/**
 * «Пропало» и «Ошибка учёта» применяются по снапшоту. Если учёт позиции успел
 * измениться после счёта и руководитель не подтвердил ровно этот учёт («оставить
 * как посчитано»), применять нельзя: поправка легла бы поверх уже учтённого
 * движения (возврат кнопкой, заведённый ремонт, правка количества) — 409
 * LINE_BOOKS_CHANGED, и не применяется ничего. «Нашлось» не проверяется: оно и
 * так ограничено потеряшками, живыми на момент применения.
 */
async function assertBooksHold(
  tx: TxClient,
  lines: StockCountLine[],
  unitModeIds: ReadonlySet<string>,
  now: Date,
): Promise<void> {
  const applied = lines.filter((l) => {
    const diff = lineDiff(l);
    if (diff == null || diff === 0 || !l.equipmentId || isUnitModeLine(l, unitModeIds)) return false;
    return l.decision === "ADJUST" || (l.decision === "LOST" && diff < 0);
  });
  if (applied.length === 0) return;
  const live = await computeExpectedOnShelf(lineEquipmentIds(applied), now, tx);
  const stale = applied.filter((l) => {
    const entry = live.get(l.equipmentId as string);
    return entry != null && !booksDecisionHolds(l, toBreakdown(entry));
  });
  if (stale.length > 0) {
    throw new HttpError(
      409,
      `Учёт изменился после счёта у ${stale.length} ${stale.length === 1 ? "строки" : "строк"} — проверьте их в «Итоге»`,
      "LINE_BOOKS_CHANGED",
      { count: stale.length, lineIds: stale.map((l) => l.id) },
    );
  }
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
    // «Нашлось», которому больше нечего закрывать (потеряшки разобрали в
    // реестре), — решение, которое не подходит, как и решение с чужим знаком.
    const foundOpen = await getFoundOpenMap(sc.status, lines, tx);
    const undecided = lines.filter((l) => isUndecided(l, unitModeIds, foundOpen)).length;
    if (undecided > 0) {
      throw new HttpError(409, `Осталось решить: ${undecided}`, "UNDECIDED_LINES", { count: undecided });
    }

    const ctx: ApplyContext = { tx, sc, actor, now: new Date(), result: emptyResult() };
    await assertBooksHold(tx, lines, unitModeIds, ctx.now);
    const verified: Array<{ equipmentId: string; countedAt: Date }> = [];
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
      verified.push({ equipmentId: line.equipmentId, countedAt: line.countedAt ?? ctx.now });
      if (diff === 0) continue;
      if (line.decision === "LOST" && diff < 0) await applyLost(ctx, line, line.equipmentId, diff);
      else if (line.decision === "ADJUST") await applyAdjust(ctx, line, line.equipmentId, diff);
      else if (line.decision === "FOUND" && diff > 0) await applyFound(ctx, line, line.equipmentId, diff);
    }

    await markVerified(tx, verified);
    ctx.result.verifiedPositions = verified.length;

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
