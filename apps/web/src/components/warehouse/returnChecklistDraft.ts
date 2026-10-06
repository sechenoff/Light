/**
 * Черновик чек-листа приёмки — чистые функции без React и сети.
 *
 * Зачем: исходы приёмки (штучные «Принято / Ремонт / Проблема», сетки по
 * количеству, комментарии, пробег машин) раньше жили только в `useState`
 * `ReturnChecklist` и пропадали при смене раздела, «←», перезагрузке и на
 * втором планшете, а плашка при этом обещала «принятые позиции сохранены».
 * Теперь экран складывает их в `ChecklistDraftV1.return` и хранит на сервере
 * (`PUT /sessions/:id/draft`), а при открытии восстанавливает отсюда.
 *
 * Восстановление сверяется с ТЕКУЩИМ составом брони:
 *  - строку ищем по `bookingItemId`, не нашли — по `equipmentId`, если это
 *    однозначно (позицию брони могли пересоздать правкой состава); правило
 *    общее с выдачей — `matchDraftEntries`;
 *  - сетка с другим количеством сбрасывается: номера ячеек больше не
 *    соответствуют приборам, и такую строку экран помечает жёлтым;
 *  - строки ×0 и позиции, которых больше нет, отбрасываются.
 */

import { CHECKLIST_DRAFT_LIMITS, isChecklistDraftV1 } from "./types";
import { matchDraftEntries } from "./useChecklistDraft";
import type {
  ReturnDraftStay,
  ChecklistDraftV1,
  ChecklistItem,
  ProblemDraft,
  ProblemReason,
  ReturnDraftGrid,
  ReturnDraftSlot,
  ReturnDraftUnit,
  ReturnOutcome,
  VehicleMileageEntry,
} from "./types";
import type { UnitSlot } from "./UnitGridRow";

// ── Локальное состояние экрана ───────────────────────────────────────────────

/** Исход одной штучной единицы — то, что держит `ReturnChecklist`. */
export interface UnitOutcome {
  outcome: ReturnOutcome;
  /** Есть (управляемое поле), когда `outcome === "REPAIR"`. */
  repairComment?: string;
  /** Есть (управляемое поле), когда `outcome === "PROBLEM"`. */
  problem?: ProblemDraft;
}

/** unitId → исход. */
export type OutcomeMap = Record<string, UnitOutcome>;

/** bookingItemId → ячейки сетки приёмки по количеству. */
export type UnitGridMap = ReadonlyMap<string, UnitSlot[]>;

/** vehicleId → итоговый одометр (км). */
export type MileageMap = Record<string, number | null>;

const OUTCOMES: readonly ReturnOutcome[] = ["ACCEPTED", "REPAIR", "PROBLEM"];
const SLOT_STATUSES: readonly UnitSlot["status"][] = [
  "PENDING",
  "ACCEPTED",
  "REPAIR",
  "PROBLEM",
];
const REASONS: readonly ProblemReason[] = [
  "LEFT_ON_SITE",
  "LOST",
  "DESTROYED",
  "STOLEN",
];
const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Пробег из черновика в виде записей панели — пока список машин грузится,
 * черновик несёт восстановленный пробег, а не пустоту.
 */
export function mileageEntries(map: Readonly<MileageMap> | null): VehicleMileageEntry[] {
  if (!map) return [];
  const out: VehicleMileageEntry[] = [];
  for (const [vehicleId, km] of Object.entries(map)) {
    if (typeof km === "number") out.push({ vehicleId, mileage: km });
  }
  return out;
}

/** Строки ×0 (сняли на выдаче) в приёмке не участвуют. */
export function returnableItems(items: readonly ChecklistItem[]): ChecklistItem[] {
  return items.filter((item) => item.quantity > 0);
}

export function emptyProblem(): ProblemDraft {
  return { reason: null, comment: "", expectedBackDate: null };
}

/** Пустая сетка на `qty` ячеек, все «ожидает». */
export function emptySlots(qty: number): UnitSlot[] {
  return Array.from({ length: Math.max(0, qty) }, (_, i) => ({
    index: i + 1,
    status: "PENDING" as const,
    repairComment: "",
    problem: emptyProblem(),
  }));
}

// ── Сборка черновика ─────────────────────────────────────────────────────────

function clip(value: string): string {
  return value.length > CHECKLIST_DRAFT_LIMITS.maxStringLength
    ? value.slice(0, CHECKLIST_DRAFT_LIMITS.maxStringLength)
    : value;
}

function draftProblem(p: ProblemDraft): ProblemDraft {
  return {
    reason: p.reason,
    comment: clip(p.comment),
    expectedBackDate: p.expectedBackDate,
  };
}

function draftUnit(o: UnitOutcome): ReturnDraftUnit {
  if (o.outcome === "REPAIR") {
    return { outcome: "REPAIR", repairComment: clip(o.repairComment ?? "") };
  }
  if (o.outcome === "PROBLEM") {
    return { outcome: "PROBLEM", problem: draftProblem(o.problem ?? emptyProblem()) };
  }
  return { outcome: "ACCEPTED" };
}

function draftSlot(s: UnitSlot): ReturnDraftSlot {
  return {
    status: s.status,
    repairComment: clip(s.repairComment),
    problem: draftProblem(s.problem),
  };
}

/**
 * Черновик приёмки из того, что сейчас на экране. В черновик попадают только
 * тронутые строки и единицы текущего состава: мусор от позиций, которых уже
 * нет, не копится ревизия за ревизией.
 */
export function buildReturnDraft(args: {
  items: readonly ChecklistItem[];
  outcomes: OutcomeMap;
  unitGrids: UnitGridMap;
  mileages: readonly VehicleMileageEntry[];
  /** «Остаётся у клиента» по строкам (ключ — bookingItemId). */
  stays?: Record<string, ReturnDraftStay>;
}): ChecklistDraftV1 {
  const units: Record<string, ReturnDraftUnit> = {};
  const grids: Record<string, ReturnDraftGrid> = {};
  for (const item of returnableItems(args.items)) {
    if (item.trackingMode === "UNIT" && item.units) {
      for (const u of item.units) {
        const o = args.outcomes[u.unitId];
        if (o) units[u.unitId] = draftUnit(o);
      }
      continue;
    }
    const slots = args.unitGrids.get(item.bookingItemId);
    if (!slots || slots.every((s) => s.status === "PENDING" && !s.repairComment && !s.problem.comment)) {
      continue;
    }
    grids[item.bookingItemId] = {
      equipmentId: item.equipmentId,
      slots: slots.map(draftSlot),
    };
  }
  const draft: ChecklistDraftV1 = { v: 1, return: { units, grids } };
  if (args.mileages.length > 0) {
    const mileages: MileageMap = {};
    for (const m of args.mileages) mileages[m.vehicleId] = m.mileage;
    draft.return = { units, grids, mileages };
  }
  // Без «остаётся у клиента» перезагрузка планшета вернула бы строку
  // целиком: оставленное молча стало бы «принятым».
  if (args.stays && Object.keys(args.stays).length > 0) draft.return = { ...draft.return!, stays: { ...args.stays } };
  return draft;
}

// ── Восстановление ───────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readProblem(value: unknown): ProblemDraft {
  if (!isRecord(value)) return emptyProblem();
  const reason = REASONS.includes(value.reason as ProblemReason)
    ? (value.reason as ProblemReason)
    : null;
  const date =
    typeof value.expectedBackDate === "string" && BARE_DATE.test(value.expectedBackDate)
      ? value.expectedBackDate
      : null;
  return {
    reason,
    comment: readString(value.comment),
    expectedBackDate: reason === "LEFT_ON_SITE" ? date : null,
  };
}

function readUnit(value: unknown): UnitOutcome | null {
  if (!isRecord(value)) return null;
  const outcome = value.outcome as ReturnOutcome;
  if (!OUTCOMES.includes(outcome)) return null;
  if (outcome === "REPAIR") {
    return { outcome, repairComment: readString(value.repairComment) };
  }
  if (outcome === "PROBLEM") return { outcome, problem: readProblem(value.problem) };
  return { outcome: "ACCEPTED" };
}

function readSlots(value: unknown): UnitSlot[] | null {
  if (!isRecord(value) || !Array.isArray(value.slots)) return null;
  return value.slots.map((raw, i) => {
    const slot = isRecord(raw) ? raw : {};
    const status = SLOT_STATUSES.includes(slot.status as UnitSlot["status"])
      ? (slot.status as UnitSlot["status"])
      : "PENDING";
    return {
      index: i + 1,
      status,
      repairComment: readString(slot.repairComment),
      problem: readProblem(slot.problem),
    };
  });
}

/** Сетки черновика в форме для `matchDraftEntries` (мусор отбрасывается). */
function sanitizeGrids(
  grids: Record<string, unknown>,
): Record<string, { equipmentId: string | null; raw: unknown }> {
  const out: Record<string, { equipmentId: string | null; raw: unknown }> = {};
  for (const [key, value] of Object.entries(grids)) {
    if (!isRecord(value)) continue;
    const equipmentId = typeof value.equipmentId === "string" ? value.equipmentId : null;
    out[key] = { equipmentId, raw: value };
  }
  return out;
}

function hasMarks(slots: readonly UnitSlot[]): boolean {
  return slots.some((s) => s.status !== "PENDING");
}

export interface HydratedReturn {
  outcomes: OutcomeMap;
  unitGrids: Map<string, UnitSlot[]>;
  mileages: MileageMap;
  /** Строки, чьи отметки сброшены: количество в брони изменилось. */
  resetRowIds: string[];
  /** Сетки черновика, не подошедшие ни к одной строке (позиции больше нет). */
  unmatchedGrids: number;
  /** Единицы, «Принято» в черновике, но без отметки на сервере — отметить. */
  toCheck: string[];
  /** Единицы с отметкой на сервере, а в черновике ремонт/проблема — снять. */
  toUncheck: string[];
  /** Восстановлено хоть что-то из черновика. */
  restoredAny: boolean;
  /** «Остаётся у клиента» из черновика — только по строкам, что есть в брони. */
  stays: Record<string, ReturnDraftStay>;
}

/**
 * Разложить черновик (`state.draft`, `details.draft` из 409 `DRAFT_OUTDATED`
 * или собранный с экрана перед перечитыванием чек-листа) на текущий состав.
 * Штучная единица без записи в черновике, но отмеченная на сервере,
 * считается принятой: отметка на сервере и есть «Принято».
 */
export function hydrateReturnDraft(
  items: readonly ChecklistItem[],
  draft: unknown,
): HydratedReturn {
  const ret = isChecklistDraftV1(draft) && draft.return ? draft.return : null;
  const draftUnits = ret ? ret.units : {};

  const outcomes: OutcomeMap = {};
  const unitGrids = new Map<string, UnitSlot[]>();
  const resetRowIds: string[] = [];
  const toCheck: string[] = [];
  const toUncheck: string[] = [];
  let restoredAny = false;

  const visible = returnableItems(items);
  const gridRows = visible.filter((i) => !(i.trackingMode === "UNIT" && i.units));
  const { matched, unmatchedCount } = matchDraftEntries(
    ret ? sanitizeGrids(ret.grids) : null,
    gridRows,
  );

  for (const item of visible) {
    if (item.trackingMode === "UNIT" && item.units) {
      for (const u of item.units) {
        const restored = readUnit(draftUnits[u.unitId]);
        if (restored) {
          outcomes[u.unitId] = restored;
          restoredAny = true;
          if (restored.outcome === "ACCEPTED" && !u.checked) toCheck.push(u.unitId);
          if (restored.outcome !== "ACCEPTED" && u.checked) toUncheck.push(u.unitId);
        } else if (u.checked) {
          outcomes[u.unitId] = { outcome: "ACCEPTED" };
        }
      }
      continue;
    }

    const entry = matched.get(item.bookingItemId);
    const slots = entry ? readSlots(entry.raw) : null;
    if (!slots) continue;
    if (slots.length !== item.quantity) {
      if (hasMarks(slots)) resetRowIds.push(item.bookingItemId);
      continue;
    }
    unitGrids.set(item.bookingItemId, slots);
    restoredAny = true;
  }

  const mileages: MileageMap = {};
  if (ret?.mileages) {
    for (const [vehicleId, km] of Object.entries(ret.mileages)) {
      if (typeof km === "number" && Number.isInteger(km) && km >= 0) {
        mileages[vehicleId] = km;
        restoredAny = true;
      }
    }
  }

  const stays: Record<string, ReturnDraftStay> = {};
  for (const [id, st] of Object.entries(ret?.stays ?? {})) {
    const item = visible.find((i) => i.bookingItemId === id);
    if (!item || !st || typeof st.until !== "string" || Number.isNaN(Date.parse(st.until))) continue;
    const unitIds = Array.isArray(st.unitIds) ? st.unitIds.filter((u) => (item.units ?? []).some((x) => x.unitId === u)) : [];
    const quantity = item.trackingMode === "UNIT" && item.units ? unitIds.length : Math.min(Math.max(0, Math.floor(st.quantity)), item.quantity);
    if (!Number.isFinite(quantity)) continue;
    stays[id] = { ...st, quantity, unitIds };
    restoredAny = true;
  }

  return {
    outcomes,
    unitGrids,
    mileages,
    resetRowIds,
    unmatchedGrids: unmatchedCount,
    toCheck,
    toUncheck,
    restoredAny,
    stays,
  };
}
