/**
 * Типы ответов API инвентаризации склада — контракт спеки
 * docs/superpowers/specs/2026-09-18-inventory-design.md §6 «Типы ответов».
 *
 * Файл — источник правды для остальных потоков (десктоп, киоск, акт): они
 * импортируют отсюда, поэтому менять форму можно только вместе со спекой.
 * Даты везде — ISO-строки, деньги — Decimal-строки (никаких number для ₽).
 */

export type StockCountStatus = "OPEN" | "CLOSED" | "CANCELLED";
export type Decision = "LOST" | "ADJUST" | "FOUND";

/** Фильтр строк: все / не посчитано / с расхождением / расхождение без решения. */
export type StockCountLineFilter = "all" | "uncounted" | "discrepancy" | "undecided";

export interface StockCountTotals {
  lines: number;
  counted: number;
  matched: number;
  shortagePositions: number;
  shortageQty: number;
  surplusPositions: number;
  surplusQty: number;
  /** Посчитанные расхождения без решения. */
  undecided: number;
  /** Σ rateSnapshot × |diff| по недостачам, Decimal-строка. */
  shortageRatePerShift: string;
}

export interface StockCountSummary {
  id: string;
  number: number;
  status: StockCountStatus;
  categories: string[] | null;
  startedAt: string;
  closedAt: string | null;
  cancelledAt: string | null;
  createdByName: string;
  closedByName: string | null;
  /** Кто считал. */
  counters: string[];
  totals: StockCountTotals;
}

export interface StockCountCategory {
  category: string;
  lines: number;
  counted: number;
  discrepancies: number;
  counters: string[];
}

export interface StockCountDecisionsPlan {
  lostPositions: number;
  lostQty: number;
  adjustPositions: number;
  adjustMinusQty: number;
  adjustPlusQty: number;
  foundPositions: number;
  foundQty: number;
}

export interface StockCountDetail extends StockCountSummary {
  categoryProgress: StockCountCategory[];
  /** Позиций со штучным учётом вне охвата. */
  unitModeExcluded: number;
  /** Первая завершённая/идущая — для баннера «первая инвентаризация». */
  isFirst: boolean;
  decisionsPlan: StockCountDecisionsPlan;
}

export interface Breakdown {
  total: number;
  issued: number;
  calendar: number;
  repair: number;
  lost: number;
  expected: number;
}

/** Бронь, которая по календарю на съёмке, но не отмечена выданной. */
export interface CalendarBooking {
  bookingId: string;
  projectName: string;
  clientName: string;
  quantity: number;
  endDate: string;
}

export interface StockCountLineView {
  id: string;
  equipmentId: string | null;
  name: string;
  category: string;
  ratePerShift: string;
  position: number;
  /** Снапшот, если посчитано; иначе живое. */
  expected: Breakdown;
  expectedIsSnapshot: boolean;
  calendarBookings: CalendarBooking[];
  countedQty: number | null;
  countedBy: string | null;
  countedAt: string | null;
  /** counted − expected. */
  diff: number | null;
  decision: Decision | null;
  decisionNote: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  sourceBookingId: string | null;
  sourceBooking: { id: string; projectName: string; clientName: string } | null;
  /** Для доступности «Нашлось». */
  openProblemQty: number;
  /** Вычисляется сервером. */
  allowedDecisions: Decision[];
}

export type ReturnMode = "KIOSK" | "MANUAL" | "AUTO" | "OUT";

export interface TrailBooking {
  bookingId: string;
  projectName: string;
  clientName: string;
  startDate: string;
  endDate: string;
  quantity: number;
  status: string;
  returnMode: ReturnMode;
  returnedBy: string | null;
  remarks: { problemQty: number; repairQty: number } | null;
}

export interface TrailOpenProblem {
  id: string;
  quantity: number;
  reason: string;
  status: string;
  createdAt: string;
  projectName: string | null;
}

export interface EquipmentTrail {
  equipmentId: string;
  name: string;
  category: string;
  windowFrom: string;
  windowIsDefault: boolean;
  totalBookings: number;
  verifiedReturns: number;
  /** ≤ 50. */
  bookings: TrailBooking[];
  suggestedBookingId: string | null;
  openProblems: TrailOpenProblem[];
  onShelf: Breakdown;
}

export interface CompleteResult {
  matched: number;
  lostPositions: number;
  lostQty: number;
  createdProblemItemIds: string[];
  adjustedPositions: number;
  foundPositions: number;
  foundQty: number;
  unexplainedSurplusQty: number;
  verifiedPositions: number;
  uncounted: number;
  /**
   * Посчитанные строки, чью позицию перевели на штучный учёт после старта:
   * эффектов не дали (сверка — по единицам в карточке оборудования).
   */
  unitModeSkipped: number;
}
