/**
 * Warehouse-scan domain types.
 *
 * These mirror the EXACT backend contracts (Express API, proxied via
 * `apps/web/app/api/[...path]/route.ts`). Source of truth:
 *  - `apps/api/src/services/checklistService.ts` (ChecklistItem/Unit/State)
 *  - `apps/api/src/services/addonAvailability.ts` (AddonConflict)
 *  - `apps/api/src/services/scanSessionPolicy.ts` (коды ошибок, причины отмены)
 *  - `apps/api/src/routes/warehouse.ts` (request/response shapes)
 *
 * Keep field names byte-identical to the API. Adding/renaming a field here
 * silently desynchronises the UI from the server.
 */

import type { MutableRefObject } from "react";

// ── State machine ────────────────────────────────────────────────────────────

/**
 * Steps of the scan flow. Parity with the existing page's state machine
 * (`apps/web/app/warehouse/scan/page.tsx` — `type Step`).
 */
export type ScanStep = "login" | "operation" | "booking" | "checklist";

export type ScanOperation = "ISSUE" | "RETURN";

/** `ScanSession.status` на бэкенде. */
export type ScanSessionStatus = "ACTIVE" | "COMPLETED" | "CANCELLED";

/** `Booking.status` — те значения, которые киоск видит в ответах API. */
export type KioskBookingStatus =
  | "DRAFT"
  | "PENDING_APPROVAL"
  | "CONFIRMED"
  | "ISSUED"
  | "RETURNED"
  | "CANCELLED";

/**
 * Почему сессию киоска закрыли без завершения (`ScanSession.cancelReason`).
 * Зеркало `ScanCancelReason` в `apps/api/src/services/scanSessionPolicy.ts`.
 */
export type ScanCancelReason =
  | "KIOSK_ABORT"
  | "CARD_ABORT"
  | "EMPTY_LEAVE"
  | "BOOKING_ISSUED_MANUALLY"
  | "BOOKING_RETURNED_MANUALLY"
  | "BOOKING_CANCELLED"
  | "BOOKING_ARCHIVED"
  | "STALE";

/**
 * Причины, которые клиент вправе передать в `POST /sessions/:id/cancel`:
 * «Прервать» в киоске, «Прервать» на карточке брони, «ушёл, ничего не сделав».
 * Остальные {@link ScanCancelReason} ставит только сервер.
 */
export type KioskCancelReason = "KIOSK_ABORT" | "CARD_ABORT" | "EMPTY_LEAVE";

// ── Черновик чек-листа (PUT /sessions/:id/draft) ─────────────────────────────

/**
 * Лимиты черновика — те же, что проверяет `checklistDraftSchema` на сервере.
 * Клиент не шлёт заведомо негодный черновик (413 `DRAFT_TOO_LARGE`).
 */
export const CHECKLIST_DRAFT_LIMITS = {
  /** Размер JSON черновика в байтах UTF-8. */
  maxBytes: 256 * 1024,
  /** Суммарное число ключей в словарях черновика. */
  maxKeys: 500,
  /** Длина любой строки (комментарий к ремонту, потеряшке). */
  maxStringLength: 2000,
} as const;

/** Строка выдачи: сколько грузим, отмечена ли, взято ли «под ответственность». */
export interface IssueDraftRow {
  qty: number;
  checked: boolean;
  /** Запасной ключ, если позицию брони пересоздали и `bookingItemId` сменился. */
  equipmentId: string | null;
  /** Строке разрешён потолок `ackCap` (сверх свободного — под ответственность). */
  ack?: boolean;
}

/** Исход штучной единицы на приёмке. */
export interface ReturnDraftUnit {
  outcome: ReturnOutcome;
  repairComment?: string;
  problem?: ProblemDraft;
}

/** Статус одной ячейки сетки приёмки по количеству (как `UnitSlot.status`). */
export type ReturnDraftSlotStatus = "PENDING" | "ACCEPTED" | "REPAIR" | "PROBLEM";

/** Ячейка сетки приёмки — `UnitSlot` без вычисляемого `index`. */
export interface ReturnDraftSlot {
  status: ReturnDraftSlotStatus;
  repairComment: string;
  problem: ProblemDraft;
}

/** Сетка строки приёмки по количеству. Число ячеек = количество строки. */
export interface ReturnDraftGrid {
  /** Запасной ключ, если позицию брони пересоздали. */
  equipmentId: string | null;
  slots: ReturnDraftSlot[];
}

/**
 * Черновик чек-листа, который киоск хранит на сервере
 * (`ScanSession.draftJson`). Контракт 2.5 плана; zod-схема — в
 * `apps/api/src/services/checklistService.ts` (`checklistDraftSchema`).
 *
 * Ключи словарей: `issue.rows` и `return.grids` — `bookingItemId`,
 * `return.units` — `equipmentUnitId`, `return.mileages` — `vehicleId`.
 */
export interface ChecklistDraftV1 {
  v: 1;
  issue?: { rows: Record<string, IssueDraftRow> };
  return?: {
    units: Record<string, ReturnDraftUnit>;
    grids: Record<string, ReturnDraftGrid>;
    mileages?: Record<string, number | null>;
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Проверка формы черновика, пришедшего с сервера (`/state`, 409
 * `DRAFT_OUTDATED`). Только верхний уровень: строки внутри клиент всё равно
 * сопоставляет с текущим составом брони и отбрасывает то, чего нет.
 */
export function isChecklistDraftV1(value: unknown): value is ChecklistDraftV1 {
  if (!isPlainObject(value) || value.v !== 1) return false;
  if (value.issue !== undefined) {
    if (!isPlainObject(value.issue) || !isPlainObject(value.issue.rows)) return false;
  }
  if (value.return !== undefined) {
    const r = value.return;
    if (!isPlainObject(r) || !isPlainObject(r.units) || !isPlainObject(r.grids)) return false;
    if (r.mileages !== undefined && !isPlainObject(r.mileages)) return false;
  }
  return true;
}

// ── Checklist (mirrors checklistService.ts) ──────────────────────────────────

export interface ChecklistUnit {
  unitId: string;
  /**
   * Machine-readable barcode. The API returns it, but per product rule it
   * must NEVER be rendered in the UX (hidden barcode IDs). Keep it on the
   * type for completeness / future machine use only.
   * @internal do not render in UX
   */
  barcode: string | null;
  checked: boolean;
  problemType: "BROKEN" | "LOST" | null;
}

export interface ChecklistItem {
  bookingItemId: string;
  equipmentId: string | null;
  equipmentName: string;
  category: string;
  /** Required quantity. */
  quantity: number;
  /** How many marked (for COUNT-mode; for UNIT it tracks checked units). */
  checkedQty: number;
  trackingMode: "COUNT" | "UNIT";
  /** Added on-site during this session. */
  isExtra: boolean;
  /** Present only for UNIT-mode items. */
  units?: ChecklistUnit[];
  /**
   * Per-shift rental rate (string Decimal) — backend serialises Prisma
   * `Equipment.rentalRatePerShift`. "0" for custom items (no equipmentId)
   * since they're not priced through the catalog. The UI uses this in the
   * live-finance sticky block to compute разбивку без round-trip'ов на сервер.
   * Source: `apps/api/src/services/checklistService.ts` (`ChecklistItem`).
   */
  rentalRatePerShift: string;
  /**
   * Original agreed-with-client quantity for this equipment, taken from the
   * MAIN Estimate snapshot. If MAIN has no line for this equipment, equals 0
   * (i.e. the BookingItem is a добор from a previous session — any positive
   * intent then counts as add-on, not as «снятие основной»). The unbounded
   * stepper uses this to colour-code «−X removed» vs «+X added».
   * Source: `apps/api/src/services/checklistService.ts` (`ChecklistItem`).
   */
  originalQuantity: number;
  /**
   * Additional units that can still be added on top of `quantity` without
   * violating physical stock (computed by the backend as
   * `max(0, totalQuantity − occupiedByOthers − bi.quantity)`). The stepper
   * exposes max = `quantity + addCap` — this is what lets the operator
   * silently bump a 10-bag row up to 12 without opening «+ Добор».
   * Source: `apps/api/src/services/checklistService.ts` (`ChecklistItem`).
   */
  addCap: number;

  // ── Поля контракта 2.5 (сервер v2 присылает их всегда; на клиенте они
  //    необязательны, чтобы старые фикстуры и ответ старого API не ломались —
  //    читать через `?? значение по умолчанию`). ─────────────────────────────

  /**
   * Потолок «под ответственность»: сколько ещё можно добавить, если забрать
   * единицы, которые числятся за чужими бронями (`physical − alreadyInBooking`).
   * `ackCap > addCap` — добор сверх свободного возможен только с подтверждением
   * (`IssuanceAdjustment.acknowledgedConflict`). По умолчанию = `addCap`.
   */
  ackCap?: number;
  /**
   * Чья бронь держит единицы сверх `addCap` — для подсказки у степпера
   * («Занято: #ABC “Проект” до ДД.ММ»). Заполнен только при `ackCap > addCap`.
   */
  capHolder?: AddonConflict | null;
  /** Цена произвольной (не каталожной) позиции за весь период, Decimal-строка. */
  customUnitPrice?: string | null;
  /** Цена строки основной сметы (MAIN) за весь период, Decimal-строка. */
  mainUnitPrice?: string | null;
  /** Строка MAIN с договорной ценой — процент скидки к ней не применяется. */
  mainNegotiated?: boolean;
  /** Сколько единиц этой строки добавлено доборами в ЭТОЙ сессии. */
  addedOnSite?: number;
}

/** Сессия, к которой относится чек-лист (`GET /sessions/:id/state`). */
export interface ChecklistSessionInfo {
  status: ScanSessionStatus;
  operation: ScanOperation;
  /** Кто открыл сессию: имя PIN-кладовщика или логин сотрудника. */
  workerName: string;
  /** ISO. */
  startedAt: string;
}

/** Бронь чек-листа — ровно то, что нужно экрану выдачи/приёмки. */
export interface ChecklistBookingInfo {
  status: KioskBookingStatus;
  /** ISO. */
  startDate: string;
  /** ISO. */
  endDate: string;
  /** Decimal-строка. */
  finalAmount: string;
  /** Договорной итог (Decimal-строка) или `null`, если сумма считается сметой. */
  manualFinalAmount: string | null;
}

export interface ChecklistState {
  sessionId: string;
  bookingId: string;
  operation: ScanOperation;
  items: ChecklistItem[];
  progress: {
    /** Items fully checked. */
    checkedItems: number;
    /** Total logical items. */
    totalItems: number;
  };
  /**
   * Number of rental shifts (days) for finance computation. Read from MAIN
   * Estimate; defaults to 1 when MAIN is absent. The UI multiplies it into
   * the per-item per-shift rate to get live subtotals.
   * Source: `apps/api/src/services/checklistService.ts` (`ChecklistState`).
   */
  shifts: number;
  /**
   * Discount percent (string Decimal "0".."100") from MAIN Estimate. The UI
   * applies the SAME discount to addons (matches what доб-смета does on the
   * server when /complete recomputes finance).
   * Source: `apps/api/src/services/checklistService.ts` (`ChecklistState`).
   */
  discountPercent: string;
  /**
   * MAIN.totalAfterDiscount snapshot — the «Согласовано» baseline shown in
   * the live-finance sticky block. The UI never recomputes it client-side;
   * we just display it and subtract / add the actual-vs-original delta.
   * Source: `apps/api/src/services/checklistService.ts` (`ChecklistState`).
   */
  mainOriginalAfterDiscount: string;

  // ── Поля контракта 2.5 (сервер v2 присылает всегда; см. ChecklistItem). ────

  session?: ChecklistSessionInfo;
  booking?: ChecklistBookingInfo;
  /** Сохранённый черновик чек-листа или `null`, если его ещё не было. */
  draft?: ChecklistDraftV1 | null;
  /**
   * Ревизия черновика на сервере. Её клиент передаёт в `saveDraft` и в
   * `complete({ draftRevision })`. 0 — черновика не было.
   */
  draftRevision?: number;
  /** ISO — когда черновик сохранили последний раз. */
  draftSavedAt?: string | null;
  /** Кто сохранил черновик последним. */
  draftSavedBy?: string | null;
  /**
   * Отпечаток состава брони (`id:quantity` всех позиций). Передаётся в
   * `complete({ itemsVersion })`: состав поменялся — 409 `CHECKLIST_OUTDATED`.
   */
  itemsVersion?: string;
}

// ── Return-flow outcomes ─────────────────────────────────────────────────────

export type ReturnOutcome = "ACCEPTED" | "REPAIR" | "PROBLEM";

/** Problem reasons accepted by `POST /sessions/:id/complete` (`problemUnits[].reason`). */
export type ProblemReason = "LEFT_ON_SITE" | "LOST" | "DESTROYED" | "STOLEN";

export type RepairUrgency = "NOT_URGENT" | "NORMAL" | "URGENT";

// ── Add-on search (mirrors GET /sessions/:id/addon-search response) ──────────

/** Статус чужой брони, которая держит единицы (`BLOCKING_STATUSES`). */
export type AddonHolderStatus = "PENDING_APPROVAL" | "CONFIRMED" | "ISSUED";

/**
 * Держатель: чужая бронь, из-за которой свободно меньше, чем просят.
 * Зеркало `AddonConflict` в `apps/api/src/services/addonAvailability.ts` (v2,
 * контракт 2.4). Приходит внутри строк поиска добора, в `capHolder` строки
 * чек-листа и в `details` 409 `ADDON_CONFLICT`.
 */
export interface AddonConflict {
  bookingId: string;
  /** Display id like "#A1B2C3". */
  bookingNo: string;
  projectName: string;
  /** ISO date. */
  from: string;
  /** ISO date. */
  to: string;
  /**
   * ISO — с какого момента единицы освободятся. `null`, когда срок назвать
   * нельзя (просроченная выданная бронь: возврат не отмечен) — тогда
   * «Свободно с …» не показывать.
   */
  freeFrom: string | null;

  // ── Поля v2 (сервер присылает всегда; на клиенте необязательны, чтобы
  //    старые фикстуры и ответ старого API не ломались). ───────────────────

  /** Клиент брони-держателя. */
  clientName?: string | null;
  /** ISSUED — вещь у клиента, а не «на бумаге». */
  holderStatus?: AddonHolderStatus;
  /** ISO — когда бронь-держатель выдана (только ISSUED). */
  issuedAt?: string | null;
  /** Держатель выдан и не возвращён после своего срока. */
  overdue?: boolean;
  /** Сколько свободно для нашей брони на её окно. */
  freeForUs?: number;
  /** Потолок «под ответственность» для этой позиции. */
  ackCap?: number;
}

export interface AddonResult {
  equipmentId: string;
  name: string;
  category: string;
  availableQuantity: number;
  /**
   * Верхняя граница для picker'а в quick-add. Считается на backend как
   * `max(0, availableQuantity − alreadyInThisBooking)` (см.
   * `apps/api/src/routes/warehouse.ts` — `/addon-search`). Используется
   * UI, чтобы не дать оператору добавить больше, чем реально можно
   * (учёт уже выданных позиций этой брони).
   */
  addCap: number;
  availability: "AVAILABLE" | "UNAVAILABLE";
  conflict: AddonConflict | null;
  /**
   * Потолок «под ответственность»: с подтверждённым конфликтом можно добрать
   * до `ackCap`. Сервер v2 присылает всегда; по умолчанию = `addCap`.
   */
  ackCap?: number;
  /** Сколько этой позиции уже в брони (0 — позиции ещё нет). */
  alreadyInBooking?: number;
}

// ── Bookings list (mirrors GET /bookings?operation= response) ────────────────

export interface BookingSummaryClient {
  id: string;
  name: string;
}

export interface BookingSummary {
  id: string;
  projectName: string;
  client: BookingSummaryClient;
  /** ISO date. */
  startDate: string;
  /** ISO date. */
  endDate: string;
  status: string;
  /** One entry per booking item — used for the position count. */
  items: { id: string }[];
}

// ── Session create (mirrors POST /sessions response) ─────────────────────────

export interface ScanSessionInfo {
  id: string;
  bookingId: string;
  operation: ScanOperation;
  status: string;
  /** ISO-время начала сессии (модель ScanSession.startedAt). */
  startedAt?: string;
  /**
   * true — createSession вернул уже существующую ACTIVE-сессию (оператор
   * продолжает незавершённую работу), false/undefined — сессия новая.
   */
  resumed?: boolean;
  /** Кто открыл сессию (для плашки «Продолжена выдача, начатая …»). */
  workerName?: string;
  /** ISO — когда последний раз сохраняли черновик; `null` — черновика нет. */
  draftSavedAt?: string | null;
  /**
   * Устаревшие ACTIVE-сессии этой брони, которые сервер закрыл при старте
   * (бронь уже выдана/принята/отменена на карточке).
   */
  closedStaleSessionIds?: string[];
}

/**
 * Пропсы, которые страница киоска (`app/warehouse/scan/page.tsx`) передаёт
 * обоим чек-листам — `IssueChecklist` и `ReturnChecklist` — сверх прежних
 * `sessionId`/`projectName`/`onBack`/`onComplete`/`onCompleted`. Чек-лист
 * монтируется с `key={sessionId}`, поэтому смена брони даёт свежий экземпляр.
 */
export interface ChecklistSessionProps {
  /**
   * `createSession` вернул уже идущую сессию (`resumed: true`) — чек-лист
   * рендерит над собой `ResumedSessionBanner` (кто и когда начал, восстановлен
   * ли черновик). `null`/`undefined` — сессия новая, плашки нет.
   */
  resumed?: ScanSessionInfo | null;
  /**
   * Страница зовёт `leaveRef.current?.()` на «←» и при выборе другой брони.
   * Чек-лист передаёт ref в `useChecklistDraft({ leaveRef })` — хук досылает
   * черновик или прерывает пустую сессию. Если ref пуст, страница делает то
   * же сама (`leaveChecklistSession`).
   */
  leaveRef?: MutableRefObject<(() => void) | null>;
  /**
   * «К списку броней» на `SessionClosedNotice` (коды `SESSION_*`): страница
   * закрывает чек-лист и обновляет списки броней.
   */
  onSessionClosed?: () => void;
}

/** Ответ `POST /sessions/:id/cancel`. */
export interface CancelSessionResult extends ScanSessionInfo {
  /**
   * false — сессию НЕ отменили: при `onlyIfEmpty` в ней уже была работа
   * (черновик, отметки или добор), и она остаётся ACTIVE.
   */
  cancelled: boolean;
}

// ── Auth (mirrors POST /auth + GET /workers/names) ───────────────────────────

export interface WorkerAuthResult {
  token: string;
  name: string;
  /** ISO date. */
  expiresAt: string;
}

// ── Complete payload (mirrors completeSessionBodySchema) ─────────────────────

/**
 * Repair-card input. Discriminated union mirroring the backend
 * `repairUnitSchema` (`apps/api/src/routes/warehouse.ts`):
 *
 *  - UNIT-form  — `{ equipmentUnitId, comment, urgency? }` — one card per
 *    serialised unit, used when the equipment is `UNIT`-tracked.
 *  - COUNT-form — `{ bookingItemId, quantity, comment }` — a single card
 *    covering `quantity` units of a `COUNT`-tracked position (Task 2,
 *    return COUNT-split).
 */
export type RepairUnitInput =
  | { equipmentUnitId: string; comment: string; urgency?: RepairUrgency }
  | { bookingItemId: string; quantity: number; comment: string };

/**
 * Problem-card input («Потеряшки»). Discriminated union mirroring the backend
 * `problemUnitSchema` (`apps/api/src/routes/warehouse.ts`):
 *
 *  - UNIT-form  — one card per serialised unit (`UNIT`-tracked equipment).
 *  - COUNT-form — single card for `quantity` units of a `COUNT`-tracked
 *    position (Task 2, return COUNT-split).
 *
 * `expectedBackDate` is an ISO datetime; the backend Zod rejects bare
 * `YYYY-MM-DD`. Only meaningful for `LEFT_ON_SITE`.
 */
export type ProblemUnitInput =
  | {
      equipmentUnitId: string;
      reason: ProblemReason;
      comment: string;
      /** ISO datetime. */
      expectedBackDate?: string;
    }
  | {
      bookingItemId: string;
      quantity: number;
      reason: ProblemReason;
      comment: string;
      /** ISO datetime. */
      expectedBackDate?: string;
    };

/**
 * Per-position quantity adjustment applied at ISSUE-complete time.
 * Mirrors `issuanceAdjustmentSchema` on the backend (apps/api warehouse.ts):
 * { bookingItemId: non-empty string, actualQuantity: non-negative int }.
 * Forwarded to `completeSession(...).options.issuanceAdjustments`.
 */
export interface IssuanceAdjustment {
  bookingItemId: string;
  actualQuantity: number;
  /**
   * Прибавку сверх свободного подтвердили «под ответственность» — потолок
   * строки `ackCap` вместо `addCap`. Без флага превышение → 409
   * `ADDON_OVER_STOCK` с `details.bookingItemId`.
   */
  acknowledgedConflict?: boolean;
}

export interface VehicleMileageEntry {
  vehicleId: string;
  /** Одометр (км) — целое неотрицательное. Backend требует ≥ currentMileage. */
  mileage: number;
}

export interface CompletePayload {
  repairUnits?: RepairUnitInput[];
  problemUnits?: ProblemUnitInput[];
  /**
   * Task 8: per-position quantity adjustments (ISSUE only). When supplied,
   * the backend recomputes MAIN after applying these actualQuantity changes;
   * `mainOriginalAfterDiscount` will hold the pre-adjustment snapshot.
   */
  issuanceAdjustments?: IssuanceAdjustment[];
  /**
   * Пробеги машин на возврате. Backend требует запись по каждой машине брони,
   * mileage ≥ Vehicle.currentMileage. Иначе 400 VEHICLE_MILEAGE_REQUIRED /
   * 409 MILEAGE_DECREASE.
   */
  vehicleMileages?: VehicleMileageEntry[];
  /**
   * Выдать раньше, чем за сутки до начала аренды, осознанно — повтор после
   * 409 `ISSUE_TOO_EARLY` (только ISSUE).
   */
  force?: boolean;
  /**
   * `ChecklistState.itemsVersion`, на котором построен экран. Состав брони
   * поменялся — 409 `CHECKLIST_OUTDATED`, чек-лист надо перечитать.
   */
  itemsVersion?: string;
  /**
   * Ревизия черновика, на которой построен экран. Меньше серверной (другое
   * устройство сохранило позже) — 409 `DRAFT_OUTDATED`.
   */
  draftRevision?: number;
}

// ── Summary / complete response (mirrors GET /summary, POST /complete) ────────

export interface ReconciliationUnitRef {
  id: string;
  name: string;
  /**
   * Machine-readable barcode echoed by the API. Do not render in UX.
   * @internal do not render in UX
   */
  barcode: string;
}

/**
 * Зарезервированный юнит, который не может быть выдан (статус ≠ AVAILABLE).
 * Источник — `GET /sessions/:id/summary`. Поля повторяют серверный
 * `ReservedButUnavailableUnit` byte-for-byte (см. apps/api warehouseScan.ts).
 */
export interface ReservedButUnavailableUnit {
  equipmentUnitId: string;
  equipmentName: string;
  /** «прибор N из M» — позиция среди резерваций этой позиции брони. */
  ordinalLabel: string;
  /** Сырое значение `EquipmentUnit.status`: MAINTENANCE | MISSING | RETIRED | ISSUED. */
  status: string;
}

export interface SummaryResult {
  sessionId: string;
  operation: ScanOperation;
  scannedCount: number;
  expectedCount: number;
  missingItems: ReconciliationUnitRef[];
  substitutedItems: ReconciliationUnitRef[];
  /**
   * Только для ISSUE; для RETURN пустой массив. Берётся из
   * `getReconciliationPreview` (apps/api). НЕ полагаемся на `[]`-default,
   * а делаем поле обязательным — клиент может рассчитывать на наличие.
   */
  reservedButUnavailable: ReservedButUnavailableUnit[];
  /**
   * MAIN Estimate.totalAfterDiscount — «Согласовано» на result-screen.
   * Backend ALWAYS sends this field; "0" when booking is not CONFIRMED.
   * Mirrors backend `ReconciliationSummary.mainAfterDiscount`.
   */
  mainAfterDiscount: string;
  /**
   * MAIN.totalAfterDiscount snapshot ДО применения issuanceAdjustments
   * в этой сессии. Если adjustments не применялись — равен `mainAfterDiscount`.
   * Backend ALWAYS sends this field; "0" when booking is not CONFIRMED.
   * Mirrors backend `ReconciliationSummary.mainOriginalAfterDiscount`.
   */
  mainOriginalAfterDiscount: string;
  /**
   * ADDON Estimate.totalAfterDiscount — «Доб-смета» на result-screen.
   * Backend ALWAYS sends this field; "0" when there are no addons.
   * Mirrors backend `ReconciliationSummary.addonAfterDiscount`.
   */
  addonAfterDiscount: string;
  /**
   * Booking.finalAmount (= main + addon + transport) — «К оплате» на
   * result-screen. Backend ALWAYS sends this field; "0" when booking is
   * not yet finance-bound. Mirrors backend `ReconciliationSummary.finalAmount`.
   */
  finalAmount: string;
  /**
   * Booking.paymentStatus (актуальный после recomputeBookingFinance).
   * UI рисует callout «К возврату клиенту» при `paymentStatus === "OVERPAID"`.
   * Mirrors backend `ReconciliationSummary.paymentStatus`. Включает все варианты
   * `BookingPaymentStatus` Prisma-enum (NOT_PAID | PARTIALLY_PAID | PAID |
   * OVERDUE | OVERPAID); хранится как string чтобы не ломать FE-build при
   * расширениях enum'а.
   */
  paymentStatus: string;
  /**
   * Booking.amountPaid (Decimal as string). UI вычисляет «Переплата =
   * amountPaid − finalAmount» для OVERPAID-callout. "0" если оплат ещё не
   * было. Mirrors backend `ReconciliationSummary.amountPaid`.
   */
  amountPaid: string;
}

/**
 * A unit whose REPAIR card could not be created post-return.
 * Mirrors `warehouseScan.ts` `summary.failedBrokenUnits` push site EXACTLY:
 * `{ unitId, reason: r.comment, error: errMsg }`. `reason` is the operator's
 * repair note; `error` is the failure message.
 */
export interface FailedBrokenUnit {
  unitId: string;
  reason: string;
  error: string;
}

/**
 * A unit whose «Потеряшки» (problem) card could not be created post-return.
 * Mirrors `warehouseScan.ts` `summary.failedProblemUnits` push site EXACTLY:
 * `{ equipmentUnitId: p.equipmentUnitId, reason: errMsg }`. There is NO
 * `error` field — `reason` ALREADY holds the failure message, and the unit
 * id field is `equipmentUnitId` (not `unitId`).
 */
export interface FailedProblemUnit {
  equipmentUnitId: string;
  reason: string;
}

export interface CompleteResult extends SummaryResult {
  createdRepairIds?: string[];
  failedBrokenUnits?: FailedBrokenUnit[];
  createdProblemItemIds?: string[];
  failedProblemUnits?: FailedProblemUnit[];

  // ── Поля контракта 2.5 (сервер v2 присылает всегда). ────────────────────

  /** Статус брони после завершения (ISSUED после выдачи, RETURNED после приёмки). */
  bookingStatus?: KioskBookingStatus;
  /** Кто нажал «Готово» (может отличаться от того, кто открыл сессию). */
  completedBy?: string | null;
  /** Договорной итог брони (Decimal-строка) или `null`. */
  manualFinalAmount?: string | null;
  /** Сколько доборов сделано в этой сессии (строк, где выдали больше исходного). */
  addonsAddedInSession?: number;
}

// ── Mutation results ─────────────────────────────────────────────────────────

export interface CheckResult {
  alreadyChecked: boolean;
}

export interface UncheckResult {
  wasChecked: boolean;
}

export interface AddItemResult {
  bookingItemId: string;
}

// ── Error envelope ───────────────────────────────────────────────────────────

/**
 * Normalised error thrown by every `api.ts` call on non-2xx.
 * `code`/`details` come from the backend `{ message, code?, details? }`
 * envelope surfaced by the central Express error handler.
 */
export interface ScanApiError {
  status: number;
  code: string | null;
  message: string;
  details: unknown;
}

// ── Add-on estimate (mirrors GET /api/addon-estimates/:bookingId) ────────────

/**
 * One line of the addon estimate (a single article × quantity).
 * `name` / `category` are `nameSnapshot` / `categorySnapshot` on the backend
 * `AddonEstimateLine` — they survive even if the source `Equipment` is later
 * renamed or deleted.
 *
 * Decimal-as-string transport: the backend serialises Prisma `Decimal` fields
 * (`unitPrice`, `lineSum`) as raw strings to avoid IEEE-754 rounding when
 * sent through JSON.
 */
export interface AddonEstimateLine {
  /** May be null if the source Equipment was deleted after the line was created. */
  equipmentId: string | null;
  /** Display name at the time the line was added (`nameSnapshot`). */
  name: string;
  /** Display category at the time the line was added (`categorySnapshot`). */
  category: string;
  quantity: number;
  /** Serialised Decimal. Format with `formatAmount` / `Number(...)` at the edge. */
  unitPrice: string;
  /** Serialised Decimal (= unitPrice × quantity × shifts). */
  lineSum: string;
}

/**
 * Read-model of the addon-estimate (доб-смета) for one booking.
 * Mirrors the JSON returned by `GET /api/addon-estimates/:bookingId` →
 * `{ addon: AddonEstimateView | null }`. `null` means the booking has no
 * addon estimate yet (no доборы scanned in).
 *
 * All money fields are serialised Decimal strings — see {@link AddonEstimateLine}.
 */
export interface AddonEstimateView {
  id: string;
  bookingId: string;
  /** Number of rental shifts the addon was priced for (matches MAIN). */
  shifts: number;
  /** Sum of `lines[].lineSum` before discount. */
  subtotal: string;
  /** Percent discount applied (e.g. "10" for 10%); `null` if no percent set. */
  discountPercent: string | null;
  /** Absolute monetary discount amount applied (Decimal string). */
  discountAmount: string;
  /** `subtotal − discountAmount`, the canonical addon total. */
  totalAfterDiscount: string;
  /** Per-article breakdown driving the «доб-смета» table. */
  lines: AddonEstimateLine[];
}

/**
 * Runtime type guard for {@link ScanApiError}. Defined here (next to the type,
 * with no module imports) so every warehouse component shares ONE copy and no
 * import cycle is introduced. Narrows an unknown rejection to the normalised
 * `{ status, code, message, details }` envelope every `api.ts` call throws.
 */
export function isScanApiError(value: unknown): value is ScanApiError {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    "message" in value
  );
}

// ── Коды ошибок киоска (таблица 2.2 плана; API и web — один список) ──────────
//
// Текст для человека всегда приходит с сервера (`ScanApiError.message`, по-русски).
// Код нужен, чтобы выбрать реакцию экрана: перечитать чек-лист, показать
// «Сессию закрыли», предложить «Выдать заранее», подсветить строку.

export const SCAN_ERROR = {
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  SESSION_ALREADY_COMPLETED: "SESSION_ALREADY_COMPLETED",
  SESSION_CANCELLED: "SESSION_CANCELLED",
  SESSION_STALE: "SESSION_STALE",
  CHECKLIST_OUTDATED: "CHECKLIST_OUTDATED",
  DRAFT_OUTDATED: "DRAFT_OUTDATED",
  DRAFT_TOO_LARGE: "DRAFT_TOO_LARGE",
  NOTHING_TO_ISSUE: "NOTHING_TO_ISSUE",
  ISSUE_TOO_EARLY: "ISSUE_TOO_EARLY",
  ADDON_ONLY_ON_ISSUE: "ADDON_ONLY_ON_ISSUE",
  ADDON_OVER_STOCK: "ADDON_OVER_STOCK",
  ADDON_CONFLICT: "ADDON_CONFLICT",
  SCAN_SESSION_ACTIVE: "SCAN_SESSION_ACTIVE",
  INVALID_BOOKING_STATE: "INVALID_BOOKING_STATE",
  NOT_ENOUGH_UNITS: "NOT_ENOUGH_UNITS",
  BOOKING_WRONG_STATUS: "BOOKING_WRONG_STATUS",
  /** Клиентский: запрос не дошёл до сервера (status 0). */
  NETWORK_ERROR: "NETWORK_ERROR",
} as const;

export type ScanErrorCode = (typeof SCAN_ERROR)[keyof typeof SCAN_ERROR];

/**
 * Коды «с этой сессией больше работать нельзя» — экран показывает
 * `SessionClosedNotice` («К списку броней»), а не тост.
 */
export const SESSION_CLOSED_CODES = [
  SCAN_ERROR.SESSION_NOT_FOUND,
  SCAN_ERROR.SESSION_ALREADY_COMPLETED,
  SCAN_ERROR.SESSION_CANCELLED,
  SCAN_ERROR.SESSION_STALE,
] as const;

export type SessionClosedCode = (typeof SESSION_CLOSED_CODES)[number];

export interface SessionAlreadyCompletedDetails {
  sessionId: string;
  operation: ScanOperation;
  /** ISO. */
  completedAt: string | null;
  completedBy: string | null;
}

export interface SessionCancelledDetails {
  sessionId: string;
  operation: ScanOperation;
  cancelReason: ScanCancelReason | null;
  /** ISO. */
  cancelledAt: string | null;
  cancelledBy: string | null;
}

export interface SessionStaleDetails {
  sessionId: string;
  operation: ScanOperation;
  bookingStatus: KioskBookingStatus;
}

export interface ChecklistOutdatedDetails {
  /** Позиции из запроса, которых в брони уже нет. */
  unknownBookingItemIds?: string[];
}

export interface DraftOutdatedDetails {
  /** Актуальная ревизия на сервере — от неё считать следующее сохранение. */
  revision: number;
  draft: ChecklistDraftV1 | null;
  /** ISO. */
  savedAt: string | null;
  savedBy: string | null;
}

export interface IssueTooEarlyDetails {
  /** ISO — начало аренды. */
  startDate: string;
}

export interface AddonOverStockDetails {
  /** Есть, когда превышение найдено в `/complete` (строка степпера). */
  bookingItemId?: string;
  equipmentId: string;
  name: string;
  addCap: number;
  requested: number;
  alreadyInBooking: number;
}

/** 409 `ADDON_CONFLICT`: держатель + из `/complete` ещё и строка. */
export interface AddonConflictDetails extends AddonConflict {
  bookingItemId?: string;
  equipmentId?: string;
}

export interface ScanSessionActiveDetails {
  sessionId: string;
  operation: ScanOperation;
  workerName: string;
  /** ISO. */
  startedAt: string;
  hasDraft: boolean;
}

export interface InvalidBookingStateDetails {
  status: KioskBookingStatus;
  action: string;
}

export interface NotEnoughUnitsDetails {
  equipmentId: string;
  available: number;
  requested: number;
}

export interface BookingWrongStatusDetails {
  status: KioskBookingStatus;
}

/** Что лежит в `details` у каждого кода (коды без деталей — `null`). */
export interface ScanErrorDetailsMap {
  SESSION_NOT_FOUND: null;
  SESSION_ALREADY_COMPLETED: SessionAlreadyCompletedDetails;
  SESSION_CANCELLED: SessionCancelledDetails;
  SESSION_STALE: SessionStaleDetails;
  CHECKLIST_OUTDATED: ChecklistOutdatedDetails;
  DRAFT_OUTDATED: DraftOutdatedDetails;
  DRAFT_TOO_LARGE: null;
  NOTHING_TO_ISSUE: null;
  ISSUE_TOO_EARLY: IssueTooEarlyDetails;
  ADDON_ONLY_ON_ISSUE: null;
  ADDON_OVER_STOCK: AddonOverStockDetails;
  ADDON_CONFLICT: AddonConflictDetails;
  SCAN_SESSION_ACTIVE: ScanSessionActiveDetails;
  INVALID_BOOKING_STATE: InvalidBookingStateDetails;
  NOT_ENOUGH_UNITS: NotEnoughUnitsDetails;
  BOOKING_WRONG_STATUS: BookingWrongStatusDetails;
  NETWORK_ERROR: null;
}

/** Код ошибки из отказа любого вызова `api.ts` или `null`. */
export function scanErrorCode(err: unknown): string | null {
  return isScanApiError(err) && typeof err.code === "string" ? err.code : null;
}

/** Сессия закрыта (выдача/приёмка оформлена, прервана, устарела или удалена). */
export function isSessionClosedError(
  err: unknown,
): err is ScanApiError & { code: SessionClosedCode } {
  const code = scanErrorCode(err);
  return code !== null && (SESSION_CLOSED_CODES as readonly string[]).includes(code);
}

/**
 * Детали ошибки с нужным кодом — или `null`, если код другой или деталей нет.
 * Форма деталей не перепроверяется (её гарантирует сервер); пришедший не
 * объект (например, HTML-страница прокси) деталями не считается.
 */
export function getScanErrorDetails<C extends keyof ScanErrorDetailsMap>(
  err: unknown,
  code: C,
): ScanErrorDetailsMap[C] | null {
  if (scanErrorCode(err) !== code) return null;
  const details = (err as ScanApiError).details;
  return isPlainObject(details) ? (details as unknown as ScanErrorDetailsMap[C]) : null;
}

// ── COUNT-mode return split (Task 2) ─────────────────────────────────────────

/**
 * Per-line «как разнести quantity по корзинам» for a COUNT-tracked position.
 * The UI keeps a `CountSplit` next to each `ChecklistItem` whose
 * `trackingMode === "COUNT"` and validates that
 * `accepted + repair + problem === quantity` before allowing complete.
 *
 * Forwarded into `CompletePayload.repairUnits` / `.problemUnits` as the
 * COUNT-form of {@link RepairUnitInput} / {@link ProblemUnitInput}
 * (`{ bookingItemId, quantity, … }`).
 */
export interface CountSplit {
  accepted: number;
  repair: number;
  problem: number;
}

/**
 * Inline «черновик» проблемного юнита/линии — то, что вводит кладовщик в
 * правом инлайн-блоке у строки. На отправке в API превращается в
 * `ProblemUnitInput` (UNIT-mode `{ unitId, reason, comment, … }` или
 * COUNT-mode `{ bookingItemId, quantity, reason, comment, … }`).
 *
 * `expectedBackDate` хранится в формате `YYYY-MM-DD` (сырое значение
 * `<input type="date">`) и заполняется только при `reason === "LEFT_ON_SITE"`.
 */
export interface ProblemDraft {
  reason: ProblemReason | null;
  comment: string;
  /** Bare `YYYY-MM-DD` (raw `<input type="date">`), `null` unless `LEFT_ON_SITE`. */
  expectedBackDate: string | null;
}

// ── «В работе» tab (mirrors GET /api/warehouse/in-work) ──────────────────────

/**
 * One card on the «В работе» tab — an ISSUED booking that has not been
 * returned yet. Mirrors `GET /api/warehouse/in-work` response shape
 * (`apps/api/src/routes/warehouse.ts`).
 *
 * `clientPhone` is `null` when the client record has no phone. `issuedAt`
 * is `null` for bookings that were ISSUED without going through CONFIRMED
 * (legacy / fixture data) — server sources it from `booking.confirmedAt`.
 * `finalAmount` is a serialised Decimal (string transport).
 * `isOverdue` / `overdueDays` are derived server-side from
 * `endDate` vs «сейчас».
 */
export interface InWorkBooking {
  bookingId: string;
  /** «#ABCDEF» — last 6 chars of bookingId, uppercase. */
  displayNo: string;
  projectName: string;
  clientName: string;
  /** `null` when the client record has no phone on file. */
  clientPhone?: string | null;
  /** ISO datetime; `null` for legacy bookings without `confirmedAt`. */
  issuedAt: string | null;
  /** ISO datetime — `booking.endDate` (planned return moment). */
  expectedReturnAt: string;
  /** Count of booking items with `quantity > 0`. */
  itemsCount: number;
  /** Serialised Decimal — `booking.finalAmount`. */
  finalAmount: string;
  isOverdue: boolean;
  /** Full days overdue (floor); 0 when not overdue. */
  overdueDays: number;
}

/**
 * Read-only details for one «В работе» booking. Mirrors
 * `GET /api/warehouse/in-work/:bookingId/details` (`apps/api warehouse.ts`).
 *
 * This is a peek-only view — the tab does not mutate state. The shape is
 * deliberately narrower than {@link ChecklistState}: no progress, no
 * per-unit checked flags, no addCap. Money fields are serialised Decimals.
 */
export interface InWorkDetails {
  bookingId: string;
  displayNo: string;
  projectName: string;
  clientName: string;
  /** `null` when the client record has no phone on file. */
  clientPhone?: string | null;
  /** ISO datetime; `null` for legacy bookings without `confirmedAt`. */
  issuedAt: string | null;
  /** ISO datetime — `booking.endDate`. */
  expectedReturnAt: string;
  items: Array<{
    bookingItemId: string;
    /** `null` for custom (non-catalog) items. */
    equipmentId: string | null;
    equipmentName: string;
    category: string;
    quantity: number;
    trackingMode: "COUNT" | "UNIT";
  }>;
  finance: {
    /** Serialised Decimal — `booking.finalAmount` (main + addon + transport). */
    finalAmount: string;
    /** Serialised Decimal — addon subtotal. */
    addonAmount: string;
    /** Serialised Decimal — `booking.amountPaid`. */
    amountPaid: string;
    /** Serialised Decimal — `finalAmount − amountPaid` (server-computed). */
    outstanding: string;
    /**
     * `booking.paymentStatus` — Prisma enum value as string so adding new
     * variants on the backend does not break the FE build
     * (NOT_PAID | PARTIALLY_PAID | PAID | OVERDUE | OVERPAID).
     */
    paymentStatus: string;
  };
}

// ── Реестр «Потеряшки» (mirrors /api/problem-items) ──────────────────────────

/**
 * Причины в РЕЕСТРЕ. Шире, чем {@link ProblemReason} приёмки: «Не нашли на
 * складе» рождается инвентаризацией или ручным вводом и в чек-листе возврата
 * не предлагается — поэтому отдельный тип, а не расширение `ProblemReason`.
 */
export type ProblemItemReason = ProblemReason | "NOT_ON_SHELF";

export type ProblemItemStatus = "EXPECTED" | "SEARCHING" | "FOUND" | "NOT_FOUND" | "WROTE_OFF";

/** Откуда карточка: приёмка / инвентаризация № N / вручную. */
export type ProblemSource = "RETURN" | "STOCK_COUNT" | "MANUAL";

/**
 * Карточка реестра — `GET /api/problem-items` (`routes/problemItems.ts`).
 * `equipment` — позиция по правилу системы: единица → позиция брони → прямая
 * ссылка; `null`, если позицию удалили из каталога. Штрихкодов нет.
 */
export interface ProblemRegistryItem {
  id: string;
  equipmentUnitId: string | null;
  equipmentId: string | null;
  sourceBookingId: string | null;
  reason: ProblemItemReason;
  comment: string;
  expectedBackDate: string | null;
  status: ProblemItemStatus;
  source: ProblemSource;
  stockCountId: string | null;
  createdBy: string;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
  quantity: number;
  equipmentUnit: { id: string; equipment: { name: string; category: string } } | null;
  bookingItem: {
    id: string;
    quantity: number;
    equipment: { name: string; category: string } | null;
  } | null;
  equipment: { name: string; category: string } | null;
  stockCount: { id: string; number: number } | null;
  /** Бронь (клиент + проект) — batch-обогащение на бэкенде; null без брони. */
  booking: {
    id: string;
    projectName: string;
    client: { name: string; phone: string | null } | null;
  } | null;
}

/**
 * Тело `POST /api/problem-items` — «Завести потеряшку» вручную.
 * Позиция без штучного учёта — `quantity`, штучная — `equipmentUnitId`.
 * `expectedBackDate` — ISO datetime и только для «Остался на площадке».
 */
export interface ManualProblemPayload {
  equipmentId: string;
  equipmentUnitId?: string;
  quantity?: number;
  reason: ProblemItemReason;
  comment: string;
  expectedBackDate?: string;
  sourceBookingId: string | null;
}
