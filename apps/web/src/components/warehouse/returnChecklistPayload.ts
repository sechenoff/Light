/**
 * Приёмка: проверка заполненности и тело `POST /sessions/:id/complete` —
 * чистые функции без React. Всё считается по строкам, которые участвуют в
 * приёмке (`returnableItems`): строки ×0 (сняли на выдаче) не требуют
 * отметок и в тело не попадают.
 *
 * ⚠ expectedBackDate: ProblemPanel и UnitGridRow отдают голый `YYYY-MM-DD`,
 * а Zod на сервере (`z.string().datetime()`) требует ISO-8601. Перевод —
 * здесь (`toIsoDatetime`), только для «Остался на площадке».
 */

import type {
  ChecklistItem,
  CompletePayload,
  ProblemDraft,
  ProblemReason,
  ProblemUnitInput,
  RepairUnitInput,
  VehicleMileageEntry,
} from "./types";
import type { UnitSlot } from "./UnitGridRow";
import type { OutcomeMap, UnitGridMap } from "./returnChecklistDraft";

/** Все штучные единицы строк приёмки — по строке чек-листа на каждую. */
export function returnUnitIds(items: readonly ChecklistItem[]): string[] {
  const ids: string[] = [];
  for (const item of items) {
    if (item.trackingMode === "UNIT" && item.units) {
      for (const u of item.units) ids.push(u.unitId);
    }
  }
  return ids;
}

/**
 * The TRUE «Принято» count from the frontend outcome truth: UNIT units whose
 * outcome is ACCEPTED + ACCEPTED slots of every COUNT grid. NOT derived from
 * the backend `scannedCount` (only ACCEPTED units are ever check()'d, so
 * `scannedCount − repair − problem` double-subtracts).
 */
export function computeAcceptedCount(
  items: readonly ChecklistItem[],
  outcomes: OutcomeMap,
  unitGrids: UnitGridMap,
): number {
  let accepted = 0;
  for (const item of items) {
    if (item.trackingMode === "UNIT" && item.units) {
      for (const u of item.units) {
        if (outcomes[u.unitId]?.outcome === "ACCEPTED") accepted += 1;
      }
    } else {
      const slots = unitGrids.get(item.bookingItemId);
      if (slots) accepted += slots.filter((s) => s.status === "ACCEPTED").length;
    }
  }
  return accepted;
}

/** Bare `YYYY-MM-DD` → midnight-UTC ISO; undefined for anything else. */
export function toIsoDatetime(bareDate: string | null | undefined): string | undefined {
  if (!bareDate) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(bareDate)) return undefined;
  const d = new Date(`${bareDate}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

/** Ячейка сетки: ожидает → принят → ремонт → проблема → ожидает. */
export function cycleStatus(s: UnitSlot["status"]): UnitSlot["status"] {
  if (s === "PENDING") return "ACCEPTED";
  if (s === "ACCEPTED") return "REPAIR";
  if (s === "REPAIR") return "PROBLEM";
  return "PENDING";
}

function slotError(slot: UnitSlot): string | null {
  if (slot.status === "REPAIR" && !slot.repairComment.trim()) {
    return `Юнит #${slot.index}: введите комментарий ремонта`;
  }
  if (slot.status === "PROBLEM" && !slot.problem.reason) {
    return `Юнит #${slot.index}: выберите причину проблемы`;
  }
  if (slot.status === "PROBLEM" && !slot.problem.comment.trim()) {
    return `Юнит #${slot.index}: добавьте комментарий проблемы`;
  }
  return null;
}

/**
 * Ошибки по строкам: ключ — unitId (штучные) или bookingItemId (сетки).
 * Сетка: каждая ячейка отмечена; ремонту нужен комментарий, проблеме —
 * причина и комментарий.
 */
export function computeReturnRowErrors(
  items: readonly ChecklistItem[],
  outcomes: OutcomeMap,
  unitGrids: UnitGridMap,
): Record<string, string> {
  const errs: Record<string, string> = {};
  for (const id of returnUnitIds(items)) {
    const o = outcomes[id];
    if (!o) {
      errs[id] = "Выберите исход: принято, ремонт или проблема";
    } else if (o.outcome === "REPAIR" && !(o.repairComment ?? "").trim()) {
      errs[id] = "Опишите, что сломалось";
    } else if (o.outcome === "PROBLEM") {
      if (!o.problem?.reason) errs[id] = "Выберите причину проблемы";
      else if (!o.problem.comment.trim()) errs[id] = "Добавьте комментарий к проблеме";
    }
  }
  for (const item of items) {
    if (item.trackingMode === "UNIT") continue;
    const biId = item.bookingItemId;
    const slots = unitGrids.get(biId);
    if (!slots || slots.every((s) => s.status === "PENDING")) {
      errs[biId] = `Помечьте все ${item.quantity} шт`;
      continue;
    }
    const pending = slots.filter((s) => s.status === "PENDING").length;
    if (pending > 0) {
      errs[biId] = `Осталось пометить ${pending} из ${item.quantity}`;
      continue;
    }
    for (const slot of slots) {
      const err = slotError(slot);
      if (err) {
        errs[biId] = err;
        break;
      }
    }
  }
  return errs;
}

type ProblemFields = { reason: ProblemReason; comment: string; expectedBackDate?: string };

/** Поля потеряшки; `null`, пока причина не выбрана. */
function problemFields(p: ProblemDraft): ProblemFields | null {
  if (!p.reason) return null;
  const fields: ProblemFields = { reason: p.reason, comment: p.comment.trim() };
  if (p.reason === "LEFT_ON_SITE") {
    const iso = toIsoDatetime(p.expectedBackDate);
    if (iso) fields.expectedBackDate = iso;
  }
  return fields;
}

/**
 * Исходы приёмки для `/complete`. Принятые штучные единицы уже отмечены
 * `check()` и в тело не попадают; по сетке — одна запись на каждую
 * непринятую ячейку (quantity 1, свой комментарий).
 */
export function buildReturnCompletePayload(args: {
  items: readonly ChecklistItem[];
  outcomes: OutcomeMap;
  unitGrids: UnitGridMap;
  mileages: readonly VehicleMileageEntry[];
}): CompletePayload {
  const repairUnits: RepairUnitInput[] = [];
  const problemUnits: ProblemUnitInput[] = [];

  for (const id of returnUnitIds(args.items)) {
    const o = args.outcomes[id];
    if (o?.outcome === "REPAIR") {
      // urgency intentionally omitted — backend defaults NORMAL.
      repairUnits.push({ equipmentUnitId: id, comment: (o.repairComment ?? "").trim() });
    } else if (o?.outcome === "PROBLEM" && o.problem) {
      const fields = problemFields(o.problem);
      if (fields) problemUnits.push({ equipmentUnitId: id, ...fields });
    }
  }

  for (const item of args.items) {
    if (item.trackingMode === "UNIT") continue;
    const biId = item.bookingItemId;
    for (const slot of args.unitGrids.get(biId) ?? []) {
      if (slot.status === "REPAIR") {
        repairUnits.push({ bookingItemId: biId, quantity: 1, comment: slot.repairComment.trim() });
      } else if (slot.status === "PROBLEM") {
        const fields = problemFields(slot.problem);
        if (fields) problemUnits.push({ bookingItemId: biId, quantity: 1, ...fields });
      }
    }
  }

  const payload: CompletePayload = {};
  if (repairUnits.length > 0) payload.repairUnits = repairUnits;
  if (problemUnits.length > 0) payload.problemUnits = problemUnits;
  if (args.mileages.length > 0) payload.vehicleMileages = [...args.mileages];
  return payload;
}
