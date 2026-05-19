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
export type ScanStep = "login" | "operation" | "booking" | "checklist" | "summary";

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
}

// ── Auth (mirrors POST /auth + GET /workers/names) ───────────────────────────

export interface WorkerAuthResult {
  token: string;
  name: string;
  /** ISO date. */
  expiresAt: string;
}

// ── Complete payload (mirrors completeSessionBodySchema) ─────────────────────

export interface RepairUnitInput {
  equipmentUnitId: string;
  comment: string;
  urgency?: RepairUrgency;
}

export interface ProblemUnitInput {
  equipmentUnitId: string;
  reason: ProblemReason;
  comment: string;
  /** ISO datetime. */
  expectedBackDate?: string;
}

export interface CompletePayload {
  repairUnits?: RepairUnitInput[];
  problemUnits?: ProblemUnitInput[];
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

export interface SummaryResult {
  sessionId: string;
  operation: ScanOperation;
  scannedCount: number;
  expectedCount: number;
  missingItems: ReconciliationUnitRef[];
  substitutedItems: ReconciliationUnitRef[];
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
