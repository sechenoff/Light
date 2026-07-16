/**
 * Warehouse-scan domain types.
 *
 * These mirror the EXACT backend contracts (Express API, proxied via
 * `apps/web/app/api/[...path]/route.ts`). Source of truth:
 *  - `apps/api/src/services/checklistService.ts` (ChecklistItem/Unit/State)
 *  - `apps/api/src/services/addonAvailability.ts` (AddonConflict)
 *  - `apps/api/src/routes/warehouse.ts` (request/response shapes)
 *
 * Keep field names byte-identical to the API. Adding/renaming a field here
 * silently desynchronises the UI from the server.
 */

// ── State machine ────────────────────────────────────────────────────────────

/**
 * Steps of the scan flow. Parity with the existing page's state machine
 * (`apps/web/app/warehouse/scan/page.tsx` — `type Step`).
 */
export type ScanStep = "login" | "operation" | "booking" | "checklist";

export type ScanOperation = "ISSUE" | "RETURN";

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
}

// ── Return-flow outcomes ─────────────────────────────────────────────────────

export type ReturnOutcome = "ACCEPTED" | "REPAIR" | "PROBLEM";

/** Problem reasons accepted by `POST /sessions/:id/complete` (`problemUnits[].reason`). */
export type ProblemReason = "LEFT_ON_SITE" | "LOST" | "DESTROYED" | "STOLEN";

export type RepairUrgency = "NOT_URGENT" | "NORMAL" | "URGENT";

// ── Add-on search (mirrors GET /sessions/:id/addon-search response) ──────────

/**
 * Conflict block: an article is busy by another CONFIRMED/ISSUED booking
 * for the dates of the current booking. Shape mirrors
 * `AddonConflict` in `addonAvailability.ts` (the API returns the raw object
 * inside each result, plus the same shape as 409 `details`).
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
  /** ISO date — nearest conflicting booking endDate. */
  freeFrom: string;
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
