/**
 * Фикстуры ответов API инвентаризации для компонентных тестов.
 * Формы — ровно ../types (зеркало сервера).
 */
import type {
  EquipmentTrail,
  StockCountCategory,
  StockCountDetail,
  StockCountLineView,
  StockCountTotals,
  TrailBooking,
} from "../types";

export function makeTotals(patch: Partial<StockCountTotals> = {}): StockCountTotals {
  return {
    lines: 10,
    counted: 6,
    matched: 3,
    shortagePositions: 2,
    shortageQty: 5,
    surplusPositions: 1,
    surplusQty: 2,
    undecided: 0,
    shortageRatePerShift: "1350",
    ...patch,
  };
}

export function makeCategory(patch: Partial<StockCountCategory> = {}): StockCountCategory {
  return {
    category: "Электрика / Коммутация",
    lines: 4,
    counted: 1,
    discrepancies: 0,
    counters: ["Иван"],
    ...patch,
  };
}

export function makeDetail(patch: Partial<StockCountDetail> = {}): StockCountDetail {
  return {
    id: "sc-1",
    number: 1,
    status: "OPEN",
    categories: null,
    startedAt: "2026-09-18T06:30:00.000Z",
    closedAt: null,
    cancelledAt: null,
    createdByName: "sechenoff",
    closedByName: null,
    counters: ["Иван", "Олег"],
    totals: makeTotals(),
    categoryProgress: [makeCategory()],
    unitModeExcluded: 1,
    isFirst: true,
    decisionsPlan: {
      lostPositions: 1,
      lostQty: 3,
      adjustPositions: 1,
      adjustMinusQty: 2,
      adjustPlusQty: 0,
      foundPositions: 0,
      foundQty: 0,
    },
    ...patch,
  };
}

export function makeLine(patch: Partial<StockCountLineView> = {}): StockCountLineView {
  return {
    id: "line-1",
    equipmentId: "eq-1",
    name: "Удлинитель PCE (15м)",
    category: "Электрика / Коммутация",
    ratePerShift: "250",
    position: 0,
    expected: { total: 50, issued: 0, calendar: 0, repair: 0, lost: 0, expected: 50 },
    expectedIsSnapshot: false,
    calendarBookings: [],
    countedQty: null,
    countedBy: null,
    countedAt: null,
    diff: null,
    decision: null,
    decisionNote: null,
    decidedBy: null,
    decidedAt: null,
    sourceBookingId: null,
    sourceBooking: null,
    openProblemQty: 0,
    allowedDecisions: [],
    ...patch,
  };
}

/** Посчитанная строка с недостачей 50 → 47. */
export function shortageLine(patch: Partial<StockCountLineView> = {}): StockCountLineView {
  return makeLine({
    expectedIsSnapshot: true,
    countedQty: 47,
    countedBy: "Иван",
    countedAt: "2026-09-18T08:40:00.000Z",
    diff: -3,
    allowedDecisions: ["LOST", "ADJUST"],
    ...patch,
  });
}

/** Посчитанная строка с излишком 19 → 21. */
export function surplusLine(patch: Partial<StockCountLineView> = {}): StockCountLineView {
  return makeLine({
    id: "line-2",
    equipmentId: "eq-2",
    name: "Vmount",
    expected: { total: 19, issued: 0, calendar: 0, repair: 0, lost: 0, expected: 19 },
    expectedIsSnapshot: true,
    countedQty: 21,
    countedBy: "Олег",
    countedAt: "2026-09-18T08:45:00.000Z",
    diff: 2,
    allowedDecisions: ["ADJUST"],
    ...patch,
  });
}

export function makeTrailBooking(patch: Partial<TrailBooking> = {}): TrailBooking {
  return {
    bookingId: "b-1",
    projectName: "Северный ветер",
    clientName: "Студия «Норд»",
    startDate: "2026-09-14T07:00:00.000Z",
    endDate: "2026-09-16T07:00:00.000Z",
    quantity: 25,
    status: "RETURNED",
    returnMode: "MANUAL",
    returnedBy: "sechenoff",
    remarks: null,
    ...patch,
  };
}

export function makeTrail(patch: Partial<EquipmentTrail> = {}): EquipmentTrail {
  return {
    equipmentId: "eq-1",
    name: "Удлинитель PCE (15м)",
    category: "Электрика / Коммутация",
    windowFrom: "2026-07-20T07:00:00.000Z",
    windowIsDefault: true,
    totalBookings: 4,
    verifiedReturns: 1,
    bookings: [
      makeTrailBooking(),
      makeTrailBooking({
        bookingId: "b-2",
        projectName: "Сериал «Тихий дом»",
        clientName: "Кинокомпания «Север»",
        startDate: "2026-09-09T07:00:00.000Z",
        endDate: "2026-09-11T07:00:00.000Z",
        quantity: 12,
        returnMode: "AUTO",
        returnedBy: "_system_",
      }),
      makeTrailBooking({
        bookingId: "b-3",
        projectName: "Реклама «Полёт»",
        clientName: "Агентство «Мост»",
        startDate: "2026-09-05T07:00:00.000Z",
        endDate: "2026-09-08T07:00:00.000Z",
        quantity: 20,
        returnMode: "KIOSK",
        returnedBy: "Иван",
        remarks: { problemQty: 0, repairQty: 0 },
      }),
      makeTrailBooking({
        bookingId: "b-4",
        projectName: "Клип «Лето»",
        clientName: "Фёдор Ильин",
        startDate: "2026-09-17T07:00:00.000Z",
        endDate: "2026-09-20T07:00:00.000Z",
        quantity: 8,
        status: "ISSUED",
        returnMode: "OUT",
        returnedBy: null,
      }),
    ],
    suggestedBookingId: null,
    openProblems: [],
    onShelf: { total: 50, issued: 8, calendar: 0, repair: 0, lost: 0, expected: 42 },
    ...patch,
  };
}

/** Ошибка в форме ApiFetchError (status / code / details). */
export function apiError(status: number, code: string, message: string, details?: unknown): Error {
  return Object.assign(new Error(message), { status, code, details });
}
