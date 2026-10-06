/**
 * Логика окна «Принять возврат» (мокап docs/mockups/line-shifts-continuation/
 * m4-return-dialog.html) без React: план приёмки с сервера → что отмечено
 * «остаётся у клиента» → тело запроса и подписи итога.
 */

/** Строка плана приёмки — ответ GET /api/bookings/:id/return-plan. */
export type ReturnPlanLine = {
  bookingItemId: string;
  equipmentId: string | null;
  name: string;
  quantity: number;
  unitTracked: boolean;
  units: Array<{ id: string; label: string | null }>;
  /** До какого момента штуки оплачены (ISO). */
  paidThrough: string;
  /** Позиция «по плану у клиента» — до этого срока (ISO). */
  plannedStayUntil: string | null;
};

export type ReturnPlan = {
  bookingId: string;
  splitRevision: number;
  lines: ReturnPlanLine[];
  hasPlannedStays: boolean;
  kioskSession: { workerName: string; startedAt: string } | null;
};

/** Что отмечено по строке: сколько остаётся, до когда, какие единицы. */
export type StayDraft = { quantity: number; until: string; unitIds: string[] };

/** Строку можно оставить у клиента в пределах оплаченного — оплачено ещё хотя бы час. */
const STAY_MIN_MS = 60 * 60 * 1000;

export function canStay(line: ReturnPlanLine, now = Date.now()): boolean {
  return Date.parse(line.paidThrough) - now > STAY_MIN_MS;
}

/** Хоть что-то можно оставить — тогда окно предлагает «Вернули не всё». */
export function anyStayPossible(plan: ReturnPlan, now = Date.now()): boolean {
  return plan.lines.some((l) => canStay(l, now));
}

/** Начальные отметки: позиции «по плану» остаются целиком до своего срока. */
export function initialStays(plan: ReturnPlan): Map<string, StayDraft> {
  const stays = new Map<string, StayDraft>();
  for (const l of plan.lines) {
    if (!l.plannedStayUntil) continue;
    // У штучной позиции оставляем ровно те единицы, что на руках: сервер
    // требует, чтобы их число совпало с количеством, а живых единиц бывает
    // меньше, чем штук в строке.
    const unitIds = l.unitTracked ? l.units.slice(0, l.quantity).map((u) => u.id) : [];
    const quantity = l.unitTracked ? unitIds.length : l.quantity;
    if (quantity === 0) continue;
    stays.set(l.bookingItemId, { quantity, until: l.plannedStayUntil, unitIds });
  }
  return stays;
}

/** Поставить «остаётся у клиента N»: срок — конец оплаченного (или «по плану»), единицы — первые N. */
export function setStayQuantity(
  stays: Map<string, StayDraft>,
  line: ReturnPlanLine,
  quantity: number,
): Map<string, StayDraft> {
  const next = new Map(stays);
  const q = Math.max(0, Math.min(line.quantity, Math.floor(quantity)));
  if (q === 0) {
    next.delete(line.bookingItemId);
    return next;
  }
  const prev = stays.get(line.bookingItemId);
  const keptUnits = prev?.unitIds.filter((id) => line.units.some((u) => u.id === id)) ?? [];
  const unitIds = line.unitTracked
    ? [...keptUnits, ...line.units.map((u) => u.id).filter((id) => !keptUnits.includes(id))].slice(0, q)
    : [];
  next.set(line.bookingItemId, {
    quantity: q,
    until: prev?.until ?? line.plannedStayUntil ?? line.paidThrough,
    unitIds,
  });
  return next;
}

/** Отметить / снять конкретную единицу штучной позиции (количество — по числу отмеченных). */
export function toggleStayUnit(
  stays: Map<string, StayDraft>,
  line: ReturnPlanLine,
  unitId: string,
): Map<string, StayDraft> {
  const prev = stays.get(line.bookingItemId);
  const current = prev?.unitIds ?? [];
  const unitIds = current.includes(unitId) ? current.filter((id) => id !== unitId) : [...current, unitId];
  const next = new Map(stays);
  if (unitIds.length === 0) next.delete(line.bookingItemId);
  else next.set(line.bookingItemId, { quantity: unitIds.length, until: prev?.until ?? line.plannedStayUntil ?? line.paidThrough, unitIds });
  return next;
}

export type ReturnSummary = {
  /** Сколько единиц принимаем на склад. */
  acceptedUnits: number;
  /** Сколько позиций принимаем целиком или частично. */
  acceptedLines: number;
  /** Сколько единиц остаётся у клиента. */
  keptUnits: number;
  /** Сколько позиций остаётся у клиента (хотя бы частично). */
  keptLines: number;
  /** Сколько всего единиц в брони. */
  totalUnits: number;
};

export function summarize(plan: ReturnPlan, stays: Map<string, StayDraft>): ReturnSummary {
  let accepted = 0,
    acceptedLines = 0,
    kept = 0,
    total = 0;
  for (const l of plan.lines) {
    const k = stays.get(l.bookingItemId)?.quantity ?? 0;
    total += l.quantity;
    kept += k;
    accepted += l.quantity - k;
    if (l.quantity - k > 0) acceptedLines += 1;
  }
  return { acceptedUnits: accepted, acceptedLines, keptUnits: kept, keptLines: stays.size, totalUnits: total };
}

/** Тело POST /api/bookings/:id/return-partial. */
export function partialReturnBody(plan: ReturnPlan, stays: Map<string, StayDraft>) {
  return {
    expectedSplitRevision: plan.splitRevision,
    stays: plan.lines
      .filter((l) => stays.has(l.bookingItemId))
      .map((l) => {
        const s = stays.get(l.bookingItemId)!;
        return {
          bookingItemId: l.bookingItemId,
          quantity: s.quantity,
          until: s.until,
          ...(l.unitTracked ? { equipmentUnitIds: s.unitIds } : {}),
        };
      }),
  };
}

/** «ср 14 окт., 10:00» по Москве. */
export function formatWhen(iso: string): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("weekday")} ${get("day")} ${get("month").replace(".", "")}, ${get("hour")}:${get("minute")}`;
}
