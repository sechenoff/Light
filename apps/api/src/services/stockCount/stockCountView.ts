/**
 * Инвентаризация — сборка ответов API из строк базы (спека §6 «Типы ответов»).
 *
 * Здесь только чтение и арифметика: итоги, прогресс по категориям, представление
 * строки с вычисленными сервером допустимыми решениями. Мутации — в
 * stockCountService.ts.
 *
 * Расхождение строки = counted − expected, где expected — СНАПШОТ, снятый в
 * момент счёта. Выдачи и возвраты во время инвентаризации итог уже посчитанной
 * строки не сбивают; для непосчитанной строки ожидание показывается живым.
 */

import Decimal from "decimal.js";
import type { Prisma, StockCount, StockCountLine, StockCountStatus as DbStatus } from "@prisma/client";

import { prisma } from "../../prisma";
import { computeExpectedOnShelf, EMPTY_BREAKDOWN, toBreakdown } from "./expected";
import type {
  Breakdown,
  CalendarBooking,
  Decision,
  StockCountCategory,
  StockCountDecisionsPlan,
  StockCountDetail,
  StockCountLineFilter,
  StockCountLineView,
  StockCountSummary,
  StockCountTotals,
} from "./types";

export type TxClient = Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">;

/** counted − expected по снапшоту; null — строка не посчитана. */
export function lineDiff(line: Pick<StockCountLine, "countedQty" | "expectedQty">): number | null {
  if (line.countedQty == null || line.expectedQty == null) return null;
  return line.countedQty - line.expectedQty;
}

/** Посчитанная строка с расхождением — ей нужно решение. */
export function isDiscrepant(line: Pick<StockCountLine, "countedQty" | "expectedQty">): boolean {
  const diff = lineDiff(line);
  return diff != null && diff !== 0;
}

/** Пустое множество штучных позиций — значение по умолчанию. */
const NO_UNIT_MODE_IDS: ReadonlySet<string> = new Set<string>();

/**
 * Подходит ли решение знаку расхождения (спека §4): «Пропало» — только недостача,
 * «Нашлось» — только излишек, «Ошибка учёта» — любой знак.
 */
export function decisionFits(decision: Decision, diff: number): boolean {
  return decision === "ADJUST" || (decision === "LOST" && diff < 0) || (decision === "FOUND" && diff > 0);
}

/**
 * Позицию перевели на штучный учёт уже после старта: количеством её не сверяют
 * (totalQuantity у неё выводится из единиц), решений она не получает и на
 * завершении пропускается.
 */
export function isUnitModeLine(line: Pick<StockCountLine, "equipmentId">, unitModeIds: ReadonlySet<string>): boolean {
  return line.equipmentId != null && unitModeIds.has(line.equipmentId);
}

/**
 * Посчитанное расхождение, которое ждёт решения. Решение, чей знак больше не
 * подходит расхождению, считается отсутствующим: иначе завершение пропустило бы
 * строку молча (ни применения, ни ошибки). Штучные строки решения не ждут.
 */
export function isUndecided(line: StockCountLine, unitModeIds: ReadonlySet<string> = NO_UNIT_MODE_IDS): boolean {
  const diff = lineDiff(line);
  if (diff == null || diff === 0 || isUnitModeLine(line, unitModeIds)) return false;
  return line.decision == null || !decisionFits(line.decision, diff);
}

/** Какие позиции из списка сейчас на штучном учёте — одним запросом. */
export async function getUnitModeIds(equipmentIds: string[], tx: TxClient = prisma): Promise<Set<string>> {
  const ids = Array.from(new Set(equipmentIds));
  if (ids.length === 0) return new Set();
  const rows = await tx.equipment.findMany({
    where: { id: { in: ids }, stockTrackingMode: "UNIT" },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}

/** Позиции строк (без удалённых из каталога). */
export function lineEquipmentIds(lines: StockCountLine[]): string[] {
  return lines.map((l) => l.equipmentId).filter((id): id is string => id != null);
}

export function parseCategories(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const list = parsed.filter((c): c is string => typeof c === "string");
    return list.length > 0 ? list : null;
  } catch {
    return null;
  }
}

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

/** Кто считал — по порядку первого счёта. */
export function collectCounters(lines: StockCountLine[]): string[] {
  const seen = new Map<string, number>();
  for (const line of lines) {
    if (!line.countedBy || !line.countedAt) continue;
    const t = line.countedAt.getTime();
    const prev = seen.get(line.countedBy);
    if (prev == null || t < prev) seen.set(line.countedBy, t);
  }
  return Array.from(seen.entries())
    .sort((a, b) => a[1] - b[1])
    .map(([name]) => name);
}

export function computeTotals(
  lines: StockCountLine[],
  unitModeIds: ReadonlySet<string> = NO_UNIT_MODE_IDS,
): StockCountTotals {
  const totals: StockCountTotals = {
    lines: lines.length,
    counted: 0,
    matched: 0,
    shortagePositions: 0,
    shortageQty: 0,
    surplusPositions: 0,
    surplusQty: 0,
    undecided: 0,
    shortageRatePerShift: "0",
  };
  let shortageRate = new Decimal(0);
  for (const line of lines) {
    const diff = lineDiff(line);
    if (diff == null) continue;
    totals.counted += 1;
    if (diff === 0) {
      totals.matched += 1;
      continue;
    }
    if (isUndecided(line, unitModeIds)) totals.undecided += 1;
    if (diff < 0) {
      totals.shortagePositions += 1;
      totals.shortageQty += -diff;
      shortageRate = shortageRate.add(new Decimal(line.rateSnapshot.toString()).mul(-diff));
    } else {
      totals.surplusPositions += 1;
      totals.surplusQty += diff;
    }
  }
  totals.shortageRatePerShift = shortageRate.toString();
  return totals;
}

/** Прогресс по категориям в порядке строк (он же порядок каталога). */
export function computeCategoryProgress(lines: StockCountLine[]): StockCountCategory[] {
  const byCategory = new Map<string, StockCountLine[]>();
  for (const line of lines) {
    const list = byCategory.get(line.categorySnapshot) ?? [];
    list.push(line);
    byCategory.set(line.categorySnapshot, list);
  }
  return Array.from(byCategory.entries()).map(([category, list]) => ({
    category,
    lines: list.length,
    counted: list.filter((l) => l.countedQty != null).length,
    discrepancies: list.filter(isDiscrepant).length,
    counters: collectCounters(list),
  }));
}

/**
 * Открытые (EXPECTED / SEARCHING) безъюнитные потеряшки по позициям — то, что
 * «Нашлось» может закрыть. Позиция строки — `equipmentId ?? bookingItem.equipmentId`,
 * как в getLostCountByEquipmentMap.
 */
export async function getOpenProblemQtyMap(
  equipmentIds: string[],
  tx: TxClient = prisma,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const ids = Array.from(new Set(equipmentIds));
  if (ids.length === 0) return result;
  const requested = new Set(ids);
  const rows = await tx.problemItem.findMany({
    where: {
      equipmentUnitId: null,
      status: { in: ["EXPECTED", "SEARCHING"] },
      OR: [{ equipmentId: { in: ids } }, { bookingItem: { equipmentId: { in: ids } } }],
    },
    select: { quantity: true, equipmentId: true, bookingItem: { select: { equipmentId: true } } },
  });
  for (const row of rows) {
    const equipmentId = row.equipmentId ?? row.bookingItem?.equipmentId;
    if (!equipmentId || !requested.has(equipmentId)) continue;
    result.set(equipmentId, (result.get(equipmentId) ?? 0) + row.quantity);
  }
  return result;
}

/**
 * Какие решения доступны строке (спека §4):
 *  - «Пропало» — только недостача;
 *  - «Ошибка учёта» — любой знак;
 *  - «Нашлось» — только излишек и только если по позиции есть открытые потеряшки.
 * В закрытой/отменённой инвентаризации решений нет; у позиции, переведённой на
 * штучный учёт, — тоже (сервер их отклонит: LINE_NOT_COUNT_MODE).
 */
export function allowedDecisionsFor(
  status: DbStatus,
  diff: number | null,
  openProblemQty: number,
  hasEquipment: boolean,
  isUnitMode = false,
): Decision[] {
  if (status !== "OPEN" || diff == null || diff === 0 || isUnitMode) return [];
  if (diff < 0) return ["LOST", "ADJUST"];
  return hasEquipment && openProblemQty > 0 ? ["ADJUST", "FOUND"] : ["ADJUST"];
}

export function filterLines(
  lines: StockCountLine[],
  filter: StockCountLineFilter,
  unitModeIds: ReadonlySet<string> = NO_UNIT_MODE_IDS,
): StockCountLine[] {
  switch (filter) {
    case "uncounted":
      return lines.filter((l) => l.countedQty == null);
    case "discrepancy":
      return lines.filter(isDiscrepant);
    case "undecided":
      return lines.filter((l) => isUndecided(l, unitModeIds));
    default:
      return lines;
  }
}

function snapshotBreakdown(line: StockCountLine): Breakdown {
  return {
    total: line.totalAtCount ?? 0,
    issued: line.issuedAtCount ?? 0,
    calendar: line.calendarAtCount ?? 0,
    repair: line.repairAtCount ?? 0,
    lost: line.lostAtCount ?? 0,
    expected: line.expectedQty ?? 0,
  };
}

/**
 * Представления строк. Живое ожидание, потеряшки и брони-источники — батчем на
 * весь набор строк.
 *
 * Список «по календарю у …» всегда живой (на момент запроса). У посчитанной
 * строки он отдаётся, только если сходится со снапшотом (та же сумма, что
 * `calendarAtCount`): иначе пояснение противоречило бы зафиксированной цифре.
 */
export async function buildLineViews(
  status: DbStatus,
  lines: StockCountLine[],
  at: Date,
  tx: TxClient = prisma,
): Promise<StockCountLineView[]> {
  if (lines.length === 0) return [];
  const equipmentIds = lineEquipmentIds(lines);
  const live = await computeExpectedOnShelf(equipmentIds, at, tx);
  const openProblems = await getOpenProblemQtyMap(equipmentIds, tx);
  const unitModeIds = await getUnitModeIds(equipmentIds, tx);

  const sourceIds = Array.from(
    new Set(lines.map((l) => l.sourceBookingId).filter((id): id is string => id != null)),
  );
  const sourceById = new Map<string, { id: string; projectName: string; clientName: string }>();
  if (sourceIds.length > 0) {
    const bookings = await tx.booking.findMany({
      where: { id: { in: sourceIds } },
      select: { id: true, projectName: true, client: { select: { name: true } } },
    });
    for (const b of bookings) {
      sourceById.set(b.id, { id: b.id, projectName: b.projectName, clientName: b.client.name });
    }
  }

  return lines.map((line) => {
    const liveEntry = line.equipmentId ? live.get(line.equipmentId) : undefined;
    const isSnapshot = line.countedQty != null && line.expectedQty != null;
    const expected: Breakdown = isSnapshot
      ? snapshotBreakdown(line)
      : liveEntry
        ? toBreakdown(liveEntry)
        : { ...EMPTY_BREAKDOWN };

    let calendarBookings: CalendarBooking[] = liveEntry?.calendarBookings ?? [];
    if (isSnapshot) {
      const liveSum = calendarBookings.reduce((s, b) => s + b.quantity, 0);
      if (liveSum !== (line.calendarAtCount ?? 0)) calendarBookings = [];
    }

    const diff = lineDiff(line);
    const openProblemQty = line.equipmentId ? (openProblems.get(line.equipmentId) ?? 0) : 0;
    return {
      id: line.id,
      equipmentId: line.equipmentId,
      name: line.nameSnapshot,
      category: line.categorySnapshot,
      ratePerShift: line.rateSnapshot.toString(),
      position: line.position,
      expected,
      expectedIsSnapshot: isSnapshot,
      calendarBookings,
      countedQty: line.countedQty,
      countedBy: line.countedBy,
      countedAt: iso(line.countedAt),
      diff,
      decision: line.decision,
      decisionNote: line.decisionNote,
      decidedBy: line.decidedBy,
      decidedAt: iso(line.decidedAt),
      sourceBookingId: line.sourceBookingId,
      sourceBooking: line.sourceBookingId ? (sourceById.get(line.sourceBookingId) ?? null) : null,
      openProblemQty,
      allowedDecisions: allowedDecisionsFor(
        status,
        diff,
        openProblemQty,
        line.equipmentId != null,
        isUnitModeLine(line, unitModeIds),
      ),
    };
  });
}

export function buildSummary(
  sc: StockCount,
  lines: StockCountLine[],
  unitModeIds: ReadonlySet<string> = NO_UNIT_MODE_IDS,
): StockCountSummary {
  return {
    id: sc.id,
    number: sc.number,
    status: sc.status,
    categories: parseCategories(sc.categories),
    startedAt: sc.startedAt.toISOString(),
    closedAt: iso(sc.closedAt),
    cancelledAt: iso(sc.cancelledAt),
    createdByName: sc.createdByName,
    closedByName: sc.closedByName,
    counters: collectCounters(lines),
    totals: computeTotals(lines, unitModeIds),
  };
}

/**
 * План завершения: что произойдёт по принятым решениям. «Нашлось» закроет не
 * больше, чем открыто потеряшек, — остаток уйдёт в акт как «лишнее без
 * объяснения», поэтому foundQty считается с этим потолком. Решения, которые
 * завершение не применит (знак не подходит расхождению, позиция ушла на штучный
 * учёт), в план не попадают.
 */
async function computeDecisionsPlan(
  lines: StockCountLine[],
  unitModeIds: ReadonlySet<string>,
  tx: TxClient,
): Promise<StockCountDecisionsPlan> {
  const plan: StockCountDecisionsPlan = {
    lostPositions: 0,
    lostQty: 0,
    adjustPositions: 0,
    adjustMinusQty: 0,
    adjustPlusQty: 0,
    foundPositions: 0,
    foundQty: 0,
  };
  const decided = lines.filter((l) => {
    const diff = lineDiff(l);
    return (
      l.decision != null &&
      diff != null &&
      diff !== 0 &&
      decisionFits(l.decision, diff) &&
      !isUnitModeLine(l, unitModeIds)
    );
  });
  const foundIds = decided
    .filter((l) => l.decision === "FOUND" && l.equipmentId)
    .map((l) => l.equipmentId as string);
  const openProblems = await getOpenProblemQtyMap(foundIds, tx);

  for (const line of decided) {
    const diff = lineDiff(line) as number;
    if (line.decision === "LOST") {
      plan.lostPositions += 1;
      plan.lostQty += Math.abs(diff);
    } else if (line.decision === "ADJUST") {
      plan.adjustPositions += 1;
      if (diff < 0) plan.adjustMinusQty += -diff;
      else plan.adjustPlusQty += diff;
    } else if (line.decision === "FOUND") {
      plan.foundPositions += 1;
      const open = line.equipmentId ? (openProblems.get(line.equipmentId) ?? 0) : 0;
      plan.foundQty += Math.min(Math.max(diff, 0), open);
    }
  }
  return plan;
}

export async function buildDetail(
  sc: StockCount,
  lines: StockCountLine[],
  tx: TxClient = prisma,
): Promise<StockCountDetail> {
  const categories = parseCategories(sc.categories);
  const equipmentIds = lineEquipmentIds(lines);
  const unitModeIds = await getUnitModeIds(equipmentIds, tx);
  // Позиция, переведённая на штучный учёт уже после старта, осталась строкой —
  // «вне охвата» её второй раз не считаем.
  const unitWhere: Prisma.EquipmentWhereInput = {
    stockTrackingMode: "UNIT",
    ...(categories ? { category: { in: categories } } : {}),
    ...(equipmentIds.length > 0 ? { id: { notIn: equipmentIds } } : {}),
  };
  const unitModeExcluded = await tx.equipment.count({ where: unitWhere });
  const earlier = await tx.stockCount.count({
    where: { status: { in: ["OPEN", "CLOSED"] }, number: { lt: sc.number } },
  });
  return {
    ...buildSummary(sc, lines, unitModeIds),
    categoryProgress: computeCategoryProgress(lines),
    unitModeExcluded,
    isFirst: earlier === 0,
    decisionsPlan: await computeDecisionsPlan(lines, unitModeIds, tx),
  };
}
