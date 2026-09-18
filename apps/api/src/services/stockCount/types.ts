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
  /**
   * Для доступности «Нашлось»: открытые безъюнитные потеряшки позиции, заведённые
   * не позже счёта строки (у посчитанной строки; у непосчитанной — все открытые).
   */
  openProblemQty: number;
  /** Вычисляется сервером. */
  allowedDecisions: Decision[];
  /**
   * Позиция на штучном учёте (её перевели после старта) — решения не ждёт:
   * сверяют по единицам в карточке оборудования.
   */
  isUnitMode: boolean;
  /**
   * Живая разбивка ожидания на момент запроса — только у посчитанной строки
   * идущей инвентаризации с позицией в каталоге, иначе null. `expected` у такой
   * строки остаётся снапшотом.
   */
  live: Breakdown | null;
  /** Учёт позиции изменился после счёта: хоть одно слагаемое live ≠ снапшоту. */
  booksChangedSinceCount: boolean;
  /**
   * Текущее «Пропало» / «Ошибка учёта» подтверждено «оставить как посчитано»
   * против ровно этого живого учёта — завершение его примет.
   */
  booksAcknowledged: boolean;
  /**
   * Починено за последние 7 суток (безъюнитные ремонты позиции) — может ещё
   * лежать на верстаке. Живое, только у идущей инвентаризации; в формулу §3 не входит.
   */
  readyForPickupQty: number;
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

/**
 * События мастерской в окне следа по безъюнитным ремонтам позиции: списанное
 * (с начала окна до момента следа) и починенное за 7 суток до него. Любое из них
 * объясняет недостачу не хуже брони — подсказка брони при них не даётся.
 */
export interface TrailRepairEvents {
  writtenOffQty: number;
  readyForPickupQty: number;
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
  repairEvents: TrailRepairEvents;
}

/**
 * Подсказка следа для строки «Итога» без полного следа: та же бронь, что
 * `visibleSuggestion(trail)` (единственный кандидат среди показанных броней).
 */
export type TrailSuggestion = Pick<
  TrailBooking,
  "bookingId" | "projectName" | "clientName" | "quantity" | "startDate" | "endDate"
>;

/** Охват для «Начать инвентаризацию»: только позиции с учётом количеством. */
export interface StockCountScope {
  /** Порядок каталога. */
  categories: string[];
  /** Позиций с учётом количеством — их и посчитает инвентаризация. */
  counts: Record<string, number>;
  /** Позиций со штучным учётом — сверяются в карточке единиц. */
  unitCounts: Record<string, number>;
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
