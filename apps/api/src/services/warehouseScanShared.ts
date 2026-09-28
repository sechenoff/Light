/**
 * Общие типы и мелкие помощники сессий склада (киоска): ввод отметок
 * приёмки, итог сверки, опции завершения. Используются warehouseScan.ts и его
 * частями (корректировки выдачи, сверка экземпляров, просмотр сессии).
 */

import type { ProblemReason, RepairUrgency, ScanSession } from "@prisma/client";

import { HttpError } from "../utils/errors";
import { SCAN_ERR, SCAN_MSG } from "./scanSessionPolicy";

export type ScanOperation = "ISSUE" | "RETURN";

/**
 * Repair input — discriminated union of UNIT-mode and COUNT-mode forms.
 *
 *  - UNIT-mode: `{ equipmentUnitId, comment, urgency? }` — one Repair card created per
 *    physically scanned unit (statuses transition AVAILABLE→MAINTENANCE).
 *  - COUNT-mode: `{ bookingItemId, quantity, comment }` — one Repair row covering N
 *    untracked units of the same line. `unitId` is null, `equipmentId` is set.
 */
export type RepairUnit =
  | { equipmentUnitId: string; comment: string; urgency?: RepairUrgency }
  | { bookingItemId: string; quantity: number; comment: string };

/** ProblemItem input — same UNIT-vs-COUNT discriminator pattern as RepairUnit. */
export type ProblemUnit =
  | { equipmentUnitId: string; reason: ProblemReason; comment: string; expectedBackDate?: string }
  | {
      bookingItemId: string;
      quantity: number;
      reason: ProblemReason;
      comment: string;
      expectedBackDate?: string;
    };

/**
 * Фактически выданное количество по позиции (степпер чек-листа выдачи).
 *
 * `actualQuantity` ≥ 0. Меньше заказанного — COUNT просто уменьшается, UNIT
 * дополнительно освобождает неотсканированные резервы. Больше — добор на месте
 * в пределах потолка `computeAddCaps`; сверх свободного, но в пределах склада —
 * только с `acknowledgedConflict` («под ответственность»).
 */
export interface IssuanceAdjustment {
  bookingItemId: string;
  actualQuantity: number;
  acknowledgedConflict?: boolean;
}

export interface ReservedButUnavailableUnit {
  equipmentUnitId: string;
  equipmentName: string;
  /** «прибор N из M» — порядок среди ВСЕХ резерваций этой позиции (стабильный). */
  ordinalLabel: string;
  /** Статус юнита, который мешает выдаче: MAINTENANCE | MISSING | RETIRED | ISSUED | …. */
  status: string;
}

export interface ReconciliationSummary {
  scanned: number;
  expected: number;
  missing: string[];    // equipmentUnitId[] не отсканированных
  substituted: string[]; // equipmentUnitId[] замен (отсканирован другой юнит вместо зарезервированного)
  /**
   * Зарезервированные юниты, недоступные для выдачи (статус ≠ AVAILABLE).
   * Только для ISSUE-сессий; для RETURN пустой массив.
   */
  reservedButUnavailable: ReservedButUnavailableUnit[];
  createdRepairIds: string[];
  failedBrokenUnits: Array<{ unitId: string; reason: string; error: string }>;
  createdProblemItemIds: string[];
  failedProblemUnits: Array<{ equipmentUnitId: string; reason: string }>;
  /** MAIN Estimate.totalAfterDiscount. */
  mainAfterDiscount: string;
  /** ADDON Estimate.totalAfterDiscount (0 если доборов нет). */
  addonAfterDiscount: string;
  /** Booking.finalAmount (= main + addon + transport, или договорной итог). */
  finalAmount: string;
  /** MAIN.totalAfterDiscount ДО корректировок этой сессии (блок «исходно / фактически»). */
  mainOriginalAfterDiscount: string;
  /** Booking.paymentStatus после пересчёта (OVERPAID → «К возврату»). */
  paymentStatus: string;
  /** Booking.amountPaid (Decimal as string). */
  amountPaid: string;
  /** Статус брони после завершения; null — в предпросмотре. */
  bookingStatus: string | null;
  /** Кто нажал «Готово» (может отличаться от открывшего сессию). */
  completedBy: string | null;
  /** Договорной итог брони или null. */
  manualFinalAmount: string | null;
  /** Сколько строк получили добор в этой сессии («+» в поиске или степпер сверх сметы). */
  addonsAddedInSession: number;
}

export interface SessionBookingItem {
  id: string;
  equipmentId: string;
  quantity: number;
  equipment: { name: string; stockTrackingMode: string };
  trackingMode: "COUNT" | "UNIT";
  /** Ожидаемое количество (для UNIT-позиций: кол-во BookingItemUnit) */
  expected?: number;
  /** Отсканировано из этой позиции */
  scanned?: number;
  /** Зарезервированные юниты, недоступные для выдачи (статус != AVAILABLE) */
  reservedButUnavailable?: string[];
}

export interface SessionWithDetails {
  session: {
    id: string;
    bookingId: string;
    operation: string;
    status: string;
    workerName: string;
    startedAt: Date;
    completedAt: Date | null;
    scans: Array<{
      id: string;
      equipmentUnitId: string;
      scannedAt: Date;
      equipmentUnit: { id: string; equipmentId: string; equipment: { name: string } };
    }>;
  };
  bookingItems: SessionBookingItem[];
}

/** Сессия для ответа API: без тела черновика (до 256 КБ) — его отдаёт /state. */
export type PresentedScanSession = Omit<ScanSession, "draftJson"> & { hasDraft: boolean };

export function presentScanSession(s: ScanSession): PresentedScanSession {
  const { draftJson, ...rest } = s;
  return { ...rest, hasDraft: draftJson != null };
}

export function notFoundSession(): HttpError {
  return new HttpError(404, SCAN_MSG.SESSION_NOT_FOUND, SCAN_ERR.SESSION_NOT_FOUND);
}

// ── Завершение сессии ────────────────────────────────────────────────────────

export interface CompleteSessionOptions {
  repairUnits?: RepairUnit[];
  problemUnits?: ProblemUnit[];
  /** Кто нажал «Готово»: имя кладовщика (PIN) или username (главная сессия). */
  createdBy?: string;
  /** AdminUser.id, если киоск открыт главной сессией, — автор аудита; иначе `_system_`. */
  auditUserId?: string | null;
  /** Корректировки количества на выдаче (только ISSUE). */
  issuanceAdjustments?: IssuanceAdjustment[];
  /**
   * Пробеги по машинам брони, снятые на возврате. Обязательны на RETURN, если
   * в брони есть хотя бы один BookingVehicle (см. {@link recordReturnMileages}).
   */
  vehicleMileages?: Array<{ vehicleId: string; mileage: number }>;
  /** Выдать раньше, чем за сутки до начала аренды, — осознанно (повтор после ISSUE_TOO_EARLY). */
  force?: boolean;
  /** `ChecklistState.itemsVersion`, на котором построен экран. */
  itemsVersion?: string;
  /** Ревизия черновика, на которой построен экран. */
  draftRevision?: number;
}

/** Контекст транзакции завершения. */
export interface CompletionCtx {
  sessionId: string;
  bookingId: string;
  operation: ScanOperation;
  completedBy: string;
  options: CompleteSessionOptions;
}

export function checklistOutdated(unknownBookingItemIds?: string[]): HttpError {
  return new HttpError(
    409,
    SCAN_MSG.CHECKLIST_OUTDATED,
    SCAN_ERR.CHECKLIST_OUTDATED,
    unknownBookingItemIds && unknownBookingItemIds.length > 0 ? { unknownBookingItemIds } : undefined,
  );
}

export function emptySummary(): ReconciliationSummary {
  return {
    scanned: 0,
    expected: 0,
    missing: [],
    substituted: [],
    reservedButUnavailable: [],
    createdRepairIds: [],
    failedBrokenUnits: [],
    createdProblemItemIds: [],
    failedProblemUnits: [],
    mainAfterDiscount: "0",
    addonAfterDiscount: "0",
    finalAmount: "0",
    mainOriginalAfterDiscount: "0",
    paymentStatus: "NOT_PAID",
    amountPaid: "0",
    bookingStatus: null,
    completedBy: null,
    manualFinalAmount: null,
    addonsAddedInSession: 0,
  };
}
