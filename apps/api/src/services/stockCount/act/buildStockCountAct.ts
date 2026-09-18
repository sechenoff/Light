/**
 * Акт инвентаризации — модель документа (спека §7 «Акт», мокап
 * final-inventory.html «Акт инвентаризации»). Рендеры PDF и XLSX получают
 * готовую модель и ничего не считают сами: оба файла одного акта обязаны
 * говорить одно и то же.
 *
 * Разделы:
 *   1. Расхождения — на полке должно быть / факт / разница / решение / причина;
 *   2. Сверено без расхождений — компактным списком;
 *   3. Не посчитано — позиции, которые остались не сверены.
 *
 * Решение в акте — человеческой фразой («пропажа → потеряшка», «ошибка учёта:
 * 5 → 3», «нашлось (потеряшка от 11.09)»). У завершённой инвентаризации фраза
 * описывает то, что РЕАЛЬНО записано: заведённые потеряшки, поправку из журнала
 * (STOCK_ADJUST), закрытые потеряшки. У идущей (черновик) и отменённой — то, что
 * записалось бы при завершении, и «решение не принято», где решения нет.
 *
 * Реквизиты организации — из настроек, тем же путём, что у сметы
 * (smetaOrgFromSettings). Пустое поле не печатается: фейковых плейсхолдеров в
 * документе быть не должно.
 */

import type { StockCount, StockCountLine } from "@prisma/client";

import { prisma } from "../../../prisma";
import { HttpError } from "../../../utils/errors";
import { getSettings } from "../../organizationService";
import { smetaOrgFromSettings } from "../../smetaExport/buildDocument";
import {
  collectCounters,
  computeTotals,
  decisionFits,
  getFoundOpenMap,
  getUnitModeIds,
  isFoundExhausted,
  isUnitModeLine,
  lineDiff,
  lineEquipmentIds,
  parseCategories,
} from "../stockCountView";
import type { Decision, StockCountStatus } from "../types";
import { fmtDayMonth, pluralRu, positionsLabel } from "./format";

/** Название в «ёлочках» без удвоения — проекты часто уже записаны с кавычками. */
export function quoteName(name: string): string {
  const t = name.trim();
  if (/^[«„"“]/.test(t) && /[»“"”]$/.test(t)) return t;
  return `«${t}»`;
}


// ── Модель ───────────────────────────────────────────────────────────────────

/**
 * applied — записано при завершении; planned — запишется при завершении
 * (черновик) или записалось бы (отменённая); none — решения нет; skipped —
 * строка эффектов не даёт (позиция удалена или на штучном учёте).
 */
export type ActDecisionState = "applied" | "planned" | "none" | "skipped";

export interface ActOrg {
  name: string | null;
  inn: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
}

export interface ActDiscrepancyRow {
  lineId: string;
  equipmentId: string | null;
  name: string;
  category: string;
  /** На полке должно было быть (снапшот в момент счёта). */
  expected: number;
  counted: number;
  /** counted − expected, всегда ≠ 0. */
  diff: number;
  decision: Decision | null;
  decisionLabel: string;
  decisionState: ActDecisionState;
  note: string | null;
  countedBy: string | null;
  countedAt: Date | null;
  decidedBy: string | null;
}

export interface ActMatchedRow {
  lineId: string;
  name: string;
  category: string;
  qty: number;
  countedBy: string | null;
  countedAt: Date | null;
}

export interface ActUncountedRow {
  lineId: string;
  name: string;
  category: string;
}

export interface StockCountActSummary {
  lines: number;
  counted: number;
  uncounted: number;
  matched: number;
  shortagePositions: number;
  shortageQty: number;
  surplusPositions: number;
  surplusQty: number;
  /** Посчитанные расхождения без решения (у завершённой — 0). */
  undecided: number;
}

export interface StockCountActDocument {
  stockCountId: string;
  number: number;
  status: StockCountStatus;
  /** Инвентаризация идёт — документ печатается с пометкой «ЧЕРНОВИК». */
  isDraft: boolean;
  generatedAt: Date;
  /** Дата акта: закрытия, отмены или (для черновика) формирования. */
  docDate: Date;
  org: ActOrg;
  scope: { categories: string[] | null; label: string };
  startedAt: Date;
  startedBy: string;
  closedAt: Date | null;
  closedBy: string | null;
  cancelledAt: Date | null;
  /** Кто считал — по порядку первого счёта. */
  counters: string[];
  /** Первый и последний счёт строки; null — ничего не посчитано. */
  countingFrom: Date | null;
  countingTo: Date | null;
  summary: StockCountActSummary;
  /** Недостачи, затем излишки; внутри — порядок каталога. */
  discrepancies: ActDiscrepancyRow[];
  matched: ActMatchedRow[];
  uncounted: ActUncountedRow[];
}

// ── Фраза решения (чистая функция) ───────────────────────────────────────────

export interface DecisionLineInput {
  decision: Decision | null;
  /** counted − expected, ≠ 0. */
  diff: number;
  /** Сколько числилось в каталоге в момент счёта строки. */
  totalAtCount: number | null;
  hasEquipment: boolean;
}

/** Потеряшка, которую «Нашлось» закрыло (завершённая) или закроет (черновик). */
export interface FoundProblemRef {
  quantity: number;
  createdAt: Date;
}

export interface DecisionFacts {
  status: StockCountStatus;
  /** Позиция сейчас на штучном учёте. */
  isUnitMode: boolean;
  /** Проект брони, с которой вероятно ушло (для «Пропало»). */
  sourceProjectName: string | null;
  /** Завершённая: сколько штук потеряшек завела эта инвентаризация по позиции. */
  lostCreatedQty?: number;
  /** Завершённая: поправка из журнала — то, что реально записано. */
  adjustApplied?: { before: number; after: number } | null;
  /** «Нашлось»: закрытые (завершённая) или закрываемые (план) потеряшки. */
  foundProblems?: FoundProblemRef[];
}

export interface DecisionDescription {
  label: string;
  state: ActDecisionState;
}

const UNIT_MODE_LABEL = "позиция на штучном учёте — сверяется по единицам";
const MAX_DATES_IN_LABEL = 3;

function datesPhrase(problems: FoundProblemRef[]): string {
  const dates: string[] = [];
  for (const p of problems) {
    const d = fmtDayMonth(p.createdAt);
    if (!dates.includes(d)) dates.push(d);
  }
  const noun = problems.length === 1 ? "потеряшка" : "потеряшки";
  const shown = dates.slice(0, MAX_DATES_IN_LABEL).join(", ");
  const rest = dates.length - MAX_DATES_IN_LABEL;
  return rest > 0 ? `${noun} от ${shown} и ещё ${rest}` : `${noun} от ${shown}`;
}

/**
 * «Нашлось»: «нашлось (потеряшка от 11.09)» — излишек целиком объяснён;
 * «нашлось 1 (потеряшка от 11.09), ещё 2 без объяснения» — объяснён частично;
 * «лишнее без объяснения: 2» — закрыть было нечего.
 */
export function foundLabel(diff: number, problems: FoundProblemRef[]): string {
  const covered = problems.filter((p) => p.quantity > 0);
  const found = Math.min(
    diff,
    covered.reduce((s, p) => s + p.quantity, 0),
  );
  const rest = diff - found;
  if (found === 0) return `лишнее без объяснения: ${rest}`;
  const dates = datesPhrase(covered);
  if (rest === 0) return `нашлось (${dates})`;
  return `нашлось ${found} (${dates}), ещё ${rest} без объяснения`;
}

/** Было ли у завершённой инвентаризации записано хоть что-то по этой строке. */
function hasAppliedEvidence(decision: Decision, facts: DecisionFacts): boolean {
  if (decision === "LOST") return (facts.lostCreatedQty ?? 0) > 0;
  if (decision === "ADJUST") return facts.adjustApplied != null;
  return (facts.foundProblems ?? []).some((p) => p.quantity > 0);
}

/** Решение, которое подходит знаку расхождения; неподходящее — как отсутствующее (isUndecided). */
function fittingDecision(line: DecisionLineInput): Decision | null {
  return line.decision != null && decisionFits(line.decision, line.diff) ? line.decision : null;
}

/** Фраза самого решения — без оглядки на режим учёта и на то, жива ли позиция. */
function decisionPhrase(decision: Decision, line: DecisionLineInput, facts: DecisionFacts): string {
  if (decision === "LOST") {
    return facts.sourceProjectName ? `пропажа → ${quoteName(facts.sourceProjectName)}` : "пропажа → потеряшка";
  }
  if (decision === "ADJUST") {
    const applied = facts.status === "CLOSED" ? facts.adjustApplied : null;
    if (applied) return `ошибка учёта: ${applied.before} → ${applied.after}`;
    if (line.totalAtCount == null) return "ошибка учёта";
    return `ошибка учёта: ${line.totalAtCount} → ${Math.max(0, line.totalAtCount + line.diff)}`;
  }
  return foundLabel(line.diff, facts.foundProblems ?? []);
}

const DELETED_LABEL = "позиция удалена из каталога";
const DELETED_LATER_SUFFIX = " (позиция позже удалена из каталога)";

/**
 * Строка, чья позиция удалена из каталога (equipmentId обнулён SetNull).
 *
 * Завершённая: если по строке есть улики записанного (потеряшка, поправка в
 * журнале, закрытые потеряшки), позицию удалили ПОСЛЕ завершения — акт обязан
 * говорить, что записано, а не «без последствий». Улик нет — позицию удалили до
 * завершения, и оно строку пропустило: тогда «без последствий» — правда
 * (поправки STOCK_ADJUST и потеряшки инвентаризации не удаляются, а «Нашлось»
 * всегда пишет позицию в закрытую потеряшку).
 *
 * Идущая и отменённая — в согласии с isUndecided: без подходящего решения
 * строка ждёт решения и видна как «решение не принято» (иначе «Без решения: N»
 * в сводке не сходится со строками, а завершение отвечает 409).
 */
function describeDeletedPosition(line: DecisionLineInput, facts: DecisionFacts): DecisionDescription {
  const decision = fittingDecision(line);
  if (facts.status === "CLOSED") {
    if (decision != null && hasAppliedEvidence(decision, facts)) {
      return { label: `${decisionPhrase(decision, line, facts)}${DELETED_LATER_SUFFIX}`, state: "applied" };
    }
    return { label: `${DELETED_LABEL} — без последствий`, state: "skipped" };
  }
  return decision != null
    ? { label: DELETED_LABEL, state: "skipped" }
    : { label: `${DELETED_LABEL} — решение не принято`, state: "none" };
}

/**
 * Решение строки с расхождением — фразой для акта.
 *
 * Штучный учёт определяется по ТЕКУЩЕМУ режиму позиции (исторического нет), но
 * у завершённой инвентаризации приоритет у фактов: если потеряшка заведена или
 * поправка есть в журнале, строка применена — даже если позицию перевели на
 * штучный учёт уже после завершения.
 */
export function describeDecision(line: DecisionLineInput, facts: DecisionFacts): DecisionDescription {
  if (!line.hasEquipment) return describeDeletedPosition(line, facts);
  const closed = facts.status === "CLOSED";
  const decision = fittingDecision(line);

  if (facts.isUnitMode && !(closed && decision != null && hasAppliedEvidence(decision, facts))) {
    return { label: closed && decision != null ? `без последствий: ${UNIT_MODE_LABEL}` : UNIT_MODE_LABEL, state: "skipped" };
  }
  if (decision == null) return { label: "решение не принято", state: "none" };
  return { label: decisionPhrase(decision, line, facts), state: closed ? "applied" : "planned" };
}

// ── Факты из базы ────────────────────────────────────────────────────────────

type AdjustPair = { before: number; after: number };

interface LineFacts {
  /** По equipmentId — строки, чья позиция жива. */
  lostCreated: Map<string, number>;
  adjustApplied: Map<string, AdjustPair>;
  foundProblems: Map<string, FoundProblemRef[]>;
  /**
   * По id строки — позиция удалена из каталога ПОСЛЕ завершения: equipmentId
   * обнулён и у строки, и у потеряшек, поэтому улики восстановлены иначе
   * (см. loadDeletedPositionFacts).
   */
  lostByLine: Map<string, number>;
  adjustByLine: Map<string, AdjustPair>;
  foundByLine: Map<string, FoundProblemRef[]>;
}

function emptyFacts(): LineFacts {
  return {
    lostCreated: new Map(),
    adjustApplied: new Map(),
    foundProblems: new Map(),
    lostByLine: new Map(),
    adjustByLine: new Map(),
    foundByLine: new Map(),
  };
}

function parseAuditJson(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed != null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readTotalQuantity(json: string | null): number | null {
  const parsed = parseAuditJson(json);
  return typeof parsed?.totalQuantity === "number" ? parsed.totalQuantity : null;
}

function readStockCountId(json: string | null): string | null {
  const parsed = parseAuditJson(json);
  return typeof parsed?.stockCountId === "string" ? parsed.stockCountId : null;
}

function idsWithDecision(lines: StockCountLine[], decision: Decision): string[] {
  return lines
    .filter((l) => l.decision === decision && l.equipmentId != null)
    .map((l) => l.equipmentId as string);
}

const foundNote = (sc: StockCount) => `Найдено при инвентаризации № ${sc.number}`;
const defaultLostComment = (sc: StockCount) => `Не нашли при инвентаризации № ${sc.number}`;

interface LostRow {
  equipmentId: string | null;
  quantity: number;
  sourceBookingId: string | null;
  comment: string;
}

/**
 * Завершённая инвентаризация: что она записала.
 *  - «Пропало» → потеряшки с этим stockCountId. Частичное закрытие такой
 *    потеряшки позже делит её на две строки с тем же stockCountId — сумма
 *    количества сохраняется, поэтому считаем сумму, а не строки.
 *  - «Ошибка учёта» → запись STOCK_ADJUST в журнале (before/after totalQuantity).
 *  - «Нашлось» → потеряшки позиции, закрытые с пометкой этой инвентаризации.
 * Строки, чью позицию удалили из каталога, — отдельно, по id строки.
 */
async function loadAppliedFacts(
  sc: StockCount,
  lines: StockCountLine[],
  discrepant: StockCountLine[],
): Promise<LineFacts> {
  const facts = emptyFacts();

  const lost: LostRow[] = await prisma.problemItem.findMany({
    where: { stockCountId: sc.id, source: "STOCK_COUNT" },
    select: { equipmentId: true, quantity: true, sourceBookingId: true, comment: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  for (const row of lost) {
    if (!row.equipmentId) continue;
    facts.lostCreated.set(row.equipmentId, (facts.lostCreated.get(row.equipmentId) ?? 0) + row.quantity);
  }

  const adjustIds = idsWithDecision(discrepant, "ADJUST");
  if (adjustIds.length > 0) {
    // Сортировка сначала по entityId — именно она заставляет SQLite взять индекс
    // (entityType, entityId); с одним ORDER BY createdAt он выбрал бы
    // (entityType, createdAt) и прошёл бы всю историю аудита позиций.
    const audits = await prisma.auditEntry.findMany({
      where: { entityType: "Equipment", action: "STOCK_ADJUST", entityId: { in: adjustIds } },
      select: { entityId: true, before: true, after: true },
      orderBy: [{ entityId: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    });
    for (const a of audits) {
      if (readStockCountId(a.after) !== sc.id) continue;
      const before = readTotalQuantity(a.before);
      const after = readTotalQuantity(a.after);
      if (before != null && after != null) facts.adjustApplied.set(a.entityId, { before, after });
    }
  }

  const foundIds = idsWithDecision(discrepant, "FOUND");
  if (foundIds.length > 0) {
    const found = await prisma.problemItem.findMany({
      where: { status: "FOUND", equipmentId: { in: foundIds }, resolutionNote: foundNote(sc) },
      select: { equipmentId: true, quantity: true, createdAt: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    for (const row of found) {
      if (!row.equipmentId) continue;
      const list = facts.foundProblems.get(row.equipmentId) ?? [];
      list.push({ quantity: row.quantity, createdAt: row.createdAt });
      facts.foundProblems.set(row.equipmentId, list);
    }
  }

  await loadDeletedPositionFacts(sc, lines, discrepant, lost, facts);
  return facts;
}

/**
 * Позиция удалена из каталога после завершения: Equipment удалён, SetNull
 * обнулил equipmentId и у строки, и у её потеряшек — ключа «позиция» больше
 * нет. Улики ищутся по тому, что завершение записало и что у закрытой
 * инвентаризации уже не меняется:
 *  - «Ошибка учёта» — STOCK_ADJUST этой инвентаризации по позиции, которой
 *    нет среди живых строк, с тем же diff и той же причиной (applyAdjust пишет
 *    ровно их);
 *  - «Пропало» — потеряшки инвентаризации без позиции с той же бронью и тем же
 *    комментарием (applyLost), не больше недостачи строки;
 *  - «Нашлось» — закрытые с пометкой этой инвентаризации потеряшки без позиции,
 *    по порядку, каждой строке — не больше её излишка.
 * Строки обходятся в порядке position; запись достаётся первой подходящей.
 * Два удалённых «Нашлось» в одном акте могут обменяться датами потеряшек —
 * позицию у закрытой потеряшки уже не восстановить.
 */
async function loadDeletedPositionFacts(
  sc: StockCount,
  lines: StockCountLine[],
  discrepant: StockCountLine[],
  lost: LostRow[],
  facts: LineFacts,
): Promise<void> {
  const orphan = discrepant.filter((l) => l.equipmentId == null && l.decision != null);
  if (orphan.length === 0) return;
  const liveIds = new Set(lineEquipmentIds(lines));
  await matchDeletedAdjust(sc, liveIds, orphan, facts);
  matchDeletedLost(sc, orphan, lost, facts);
  await matchDeletedFound(sc, orphan, facts);
}

async function matchDeletedAdjust(
  sc: StockCount,
  liveIds: ReadonlySet<string>,
  orphan: StockCountLine[],
  facts: LineFacts,
): Promise<void> {
  const adjustLines = orphan.filter((l) => l.decision === "ADJUST");
  if (adjustLines.length === 0) return;
  const audits = await prisma.auditEntry.findMany({
    where: { entityType: "Equipment", action: "STOCK_ADJUST", after: { contains: sc.id } },
    select: { entityId: true, before: true, after: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const pool = audits.flatMap((a) => {
    const after = parseAuditJson(a.after);
    const before = readTotalQuantity(a.before);
    if (liveIds.has(a.entityId) || after?.stockCountId !== sc.id) return [];
    if (before == null || typeof after.totalQuantity !== "number") return [];
    return [
      {
        pair: { before, after: after.totalQuantity },
        diff: typeof after.diff === "number" ? after.diff : null,
        reason: typeof after.reason === "string" ? after.reason : null,
      },
    ];
  });
  const used = new Set<number>();
  for (const line of adjustLines) {
    const diff = lineDiff(line);
    const reason = line.decisionNote ?? null;
    const idx = pool.findIndex((e, i) => !used.has(i) && e.diff === diff && e.reason === reason);
    if (idx < 0) continue;
    used.add(idx);
    facts.adjustByLine.set(line.id, pool[idx].pair);
  }
}

function matchDeletedLost(sc: StockCount, orphan: StockCountLine[], lost: LostRow[], facts: LineFacts): void {
  const pool = lost.filter((r) => r.equipmentId == null);
  const used = new Set<number>();
  for (const line of orphan) {
    const diff = lineDiff(line);
    if (line.decision !== "LOST" || diff == null || diff >= 0) continue;
    const need = -diff;
    const comment = line.decisionNote ?? defaultLostComment(sc);
    let sum = 0;
    pool.forEach((row, i) => {
      if (sum >= need || used.has(i)) return;
      if (row.sourceBookingId !== line.sourceBookingId || row.comment !== comment) return;
      used.add(i);
      sum += row.quantity;
    });
    if (sum > 0) facts.lostByLine.set(line.id, Math.min(sum, need));
  }
}

async function matchDeletedFound(sc: StockCount, orphan: StockCountLine[], facts: LineFacts): Promise<void> {
  const foundLines = orphan.filter((l) => l.decision === "FOUND" && (lineDiff(l) ?? 0) > 0);
  if (foundLines.length === 0) return;
  const rows = await prisma.problemItem.findMany({
    where: { status: "FOUND", equipmentId: null, resolutionNote: foundNote(sc) },
    select: { quantity: true, createdAt: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  // Остаток каждой закрытой потеряшки, ещё не отданный строкам.
  const left = rows.map((r) => r.quantity);
  let k = 0;
  for (const line of foundLines) {
    let remaining = lineDiff(line) as number;
    const allocated: FoundProblemRef[] = [];
    while (remaining > 0 && k < rows.length) {
      const take = Math.min(left[k], remaining);
      if (take > 0) allocated.push({ quantity: take, createdAt: rows[k].createdAt });
      remaining -= take;
      left[k] -= take;
      if (left[k] <= 0) k += 1;
    }
    if (allocated.length > 0) facts.foundByLine.set(line.id, allocated);
  }
}

/**
 * Черновик и отменённая: что закрыло бы «Нашлось» — открытые безъюнитные
 * потеряшки позиции, заведённые не позже счёта строки, от старых к новым на
 * величину излишка и не больше, чем их было в снапшоте (те же правила, что у
 * завершения). Остальных эффектов для фразы знать не нужно.
 */
async function loadPlannedFacts(discrepant: StockCountLine[]): Promise<LineFacts> {
  const facts = emptyFacts();
  const foundLines = discrepant.filter((l) => l.decision === "FOUND" && l.equipmentId != null);
  if (foundLines.length === 0) return facts;
  const ids = foundLines.map((l) => l.equipmentId as string);
  const cutoff = new Map(foundLines.map((l) => [l.equipmentId as string, l.countedAt]));

  const rows = await prisma.problemItem.findMany({
    where: {
      equipmentUnitId: null,
      status: { in: ["EXPECTED", "SEARCHING"] },
      OR: [{ equipmentId: { in: ids } }, { bookingItem: { equipmentId: { in: ids } } }],
    },
    select: { quantity: true, createdAt: true, equipmentId: true, bookingItem: { select: { equipmentId: true } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const open = new Map<string, FoundProblemRef[]>();
  for (const row of rows) {
    const equipmentId = row.equipmentId ?? row.bookingItem?.equipmentId;
    if (!equipmentId || !cutoff.has(equipmentId)) continue;
    const countedAt = cutoff.get(equipmentId);
    if (countedAt && row.createdAt.getTime() > countedAt.getTime()) continue;
    const list = open.get(equipmentId) ?? [];
    list.push({ quantity: row.quantity, createdAt: row.createdAt });
    open.set(equipmentId, list);
  }

  for (const line of foundLines) {
    const equipmentId = line.equipmentId as string;
    let remaining = Math.min(Math.max(lineDiff(line) ?? 0, 0), line.lostAtCount ?? 0);
    const allocated: FoundProblemRef[] = [];
    for (const p of open.get(equipmentId) ?? []) {
      if (remaining <= 0) break;
      const take = Math.min(p.quantity, remaining);
      allocated.push({ quantity: take, createdAt: p.createdAt });
      remaining -= take;
    }
    facts.foundProblems.set(equipmentId, allocated);
  }
  return facts;
}

async function loadSourceProjects(lines: StockCountLine[]): Promise<Map<string, string>> {
  const ids = Array.from(
    new Set(lines.map((l) => l.sourceBookingId).filter((id): id is string => id != null)),
  );
  const result = new Map<string, string>();
  if (ids.length === 0) return result;
  const bookings = await prisma.booking.findMany({
    where: { id: { in: ids } },
    select: { id: true, projectName: true },
  });
  for (const b of bookings) {
    const name = b.projectName.trim();
    if (name) result.set(b.id, name);
  }
  return result;
}

// ── Сборка ───────────────────────────────────────────────────────────────────

function scopeOf(categories: string[] | null, lines: number): { categories: string[] | null; label: string } {
  const where = categories ? categories.join(", ") : "весь склад";
  return { categories, label: `${where}, ${positionsLabel(lines)}` };
}

function countingWindow(lines: StockCountLine[]): { from: Date | null; to: Date | null } {
  let from: Date | null = null;
  let to: Date | null = null;
  for (const line of lines) {
    if (line.countedQty == null || !line.countedAt) continue;
    if (!from || line.countedAt < from) from = line.countedAt;
    if (!to || line.countedAt > to) to = line.countedAt;
  }
  return { from, to };
}

function orgOf(settings: Awaited<ReturnType<typeof getSettings>>): ActOrg {
  const org = smetaOrgFromSettings(settings);
  return { name: org.name, inn: org.inn, address: org.address, phone: org.phone, email: org.email };
}

export async function buildStockCountAct(id: string, opts: { now?: Date } = {}): Promise<StockCountActDocument> {
  const sc = await prisma.stockCount.findUnique({ where: { id } });
  if (!sc) throw new HttpError(404, "Инвентаризация не найдена", "STOCK_COUNT_NOT_FOUND");
  const now = opts.now ?? new Date();

  const lines = await prisma.stockCountLine.findMany({
    where: { stockCountId: id },
    orderBy: { position: "asc" },
  });
  const unitModeIds = await getUnitModeIds(lineEquipmentIds(lines));
  // Черновик: «Нашлось», которому больше нечего закрывать, ждёт решения — как в
  // «Итоге» и на завершении.
  const foundOpen = await getFoundOpenMap(sc.status, lines);
  const totals = computeTotals(lines, unitModeIds, foundOpen);

  const discrepant = lines.filter((l) => {
    const diff = lineDiff(l);
    return diff != null && diff !== 0;
  });
  const facts =
    sc.status === "CLOSED" ? await loadAppliedFacts(sc, lines, discrepant) : await loadPlannedFacts(discrepant);
  const sourceProjects = await loadSourceProjects(discrepant);

  const toRow = (line: StockCountLine): ActDiscrepancyRow => {
    const diff = lineDiff(line) as number;
    const equipmentId = line.equipmentId;
    const decision = foundOpen && isFoundExhausted(line, foundOpen) ? null : line.decision;
    const described = describeDecision(
      { decision, diff, totalAtCount: line.totalAtCount, hasEquipment: equipmentId != null },
      {
        status: sc.status,
        isUnitMode: isUnitModeLine(line, unitModeIds),
        sourceProjectName: line.sourceBookingId ? (sourceProjects.get(line.sourceBookingId) ?? null) : null,
        // Удалённая позиция: улики — по id строки (заполнены только у завершённой).
        lostCreatedQty: equipmentId ? facts.lostCreated.get(equipmentId) : facts.lostByLine.get(line.id),
        adjustApplied: (equipmentId ? facts.adjustApplied.get(equipmentId) : facts.adjustByLine.get(line.id)) ?? null,
        foundProblems: equipmentId ? facts.foundProblems.get(equipmentId) : facts.foundByLine.get(line.id),
      },
    );
    return {
      lineId: line.id,
      equipmentId,
      name: line.nameSnapshot,
      category: line.categorySnapshot,
      expected: line.expectedQty as number,
      counted: line.countedQty as number,
      diff,
      decision: line.decision,
      decisionLabel: described.label,
      decisionState: described.state,
      note: line.decisionNote?.trim() ? line.decisionNote.trim() : null,
      countedBy: line.countedBy,
      countedAt: line.countedAt,
      decidedBy: line.decidedBy,
    };
  };

  const shortages = discrepant.filter((l) => (lineDiff(l) as number) < 0).map(toRow);
  const surpluses = discrepant.filter((l) => (lineDiff(l) as number) > 0).map(toRow);
  const matched: ActMatchedRow[] = lines
    .filter((l) => lineDiff(l) === 0)
    .map((l) => ({
      lineId: l.id,
      name: l.nameSnapshot,
      category: l.categorySnapshot,
      qty: l.countedQty as number,
      countedBy: l.countedBy,
      countedAt: l.countedAt,
    }));
  const uncounted: ActUncountedRow[] = lines
    .filter((l) => lineDiff(l) == null)
    .map((l) => ({ lineId: l.id, name: l.nameSnapshot, category: l.categorySnapshot }));

  const window = countingWindow(lines);
  const docDate = sc.status === "CLOSED" ? (sc.closedAt ?? now) : sc.status === "CANCELLED" ? (sc.cancelledAt ?? now) : now;

  return {
    stockCountId: sc.id,
    number: sc.number,
    status: sc.status,
    isDraft: sc.status === "OPEN",
    generatedAt: now,
    docDate,
    org: orgOf(await getSettings()),
    scope: scopeOf(parseCategories(sc.categories), lines.length),
    startedAt: sc.startedAt,
    startedBy: sc.createdByName,
    closedAt: sc.closedAt,
    closedBy: sc.closedByName,
    cancelledAt: sc.cancelledAt,
    counters: collectCounters(lines),
    countingFrom: window.from,
    countingTo: window.to,
    summary: {
      lines: totals.lines,
      counted: totals.counted,
      uncounted: totals.lines - totals.counted,
      matched: totals.matched,
      shortagePositions: totals.shortagePositions,
      shortageQty: totals.shortageQty,
      surplusPositions: totals.surplusPositions,
      surplusQty: totals.surplusQty,
      undecided: totals.undecided,
    },
    discrepancies: [...shortages, ...surpluses],
    matched,
    uncounted,
  };
}

// ── Подписи статуса и имя файла ──────────────────────────────────────────────

/** Метка поверх шапки: «ЧЕРНОВИК» пока идёт, «ОТМЕНЕНА» у отменённой. */
export function actStamp(doc: StockCountActDocument): string | null {
  if (doc.status === "OPEN") return "ЧЕРНОВИК";
  if (doc.status === "CANCELLED") return "ОТМЕНЕНА";
  return null;
}

/**
 * Пояснение под сводкой — только там, где без него документ легко понять
 * неправильно: черновик не окончателен, отменённая ничего не записала,
 * непосчитанные позиции не сверены.
 */
export function actStatusNotes(doc: StockCountActDocument): string[] {
  const notes: string[] = [];
  const s = doc.summary;
  if (doc.status === "OPEN") {
    const undecided =
      s.undecided > 0
        ? ` Без решения: ${s.undecided} ${pluralRu(s.undecided, "расхождение", "расхождения", "расхождений")}.`
        : "";
    notes.push(`Черновик: инвентаризация идёт, решения ещё не применены — учёт не менялся.${undecided}`);
  } else if (doc.status === "CANCELLED") {
    notes.push("Инвентаризация отменена: решения не применялись, учёт не менялся.");
  }
  if (s.uncounted > 0 && doc.status === "CLOSED") {
    notes.push(
      `Не посчитано ${positionsLabel(s.uncounted)} — ${pluralRu(s.uncounted, "она осталась не сверена", "они остались не сверены", "они остались не сверены")} (раздел 3).`,
    );
  }
  return notes;
}

/** «Акт инвентаризации № 3», «… — черновик», «… — отменена». */
export function stockCountActFileBase(doc: StockCountActDocument): string {
  const base = `Акт инвентаризации № ${doc.number}`;
  if (doc.status === "OPEN") return `${base} — черновик`;
  if (doc.status === "CANCELLED") return `${base} — отменена`;
  return base;
}
