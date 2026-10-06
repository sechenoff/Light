import { pluralize } from "@/lib/format";

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
  /**
   * От какого момента сервер выставит лишние смены (исправление «Часть не
   * вернули»: конец оплаченного или приёмка). Есть — чипы «+N смен» считаются
   * от него, и «+1» — ровно одна смена.
   */
  billingAnchor?: string;
};

export type ReturnPlan = {
  bookingId: string;
  splitRevision: number;
  lines: ReturnPlanLine[];
  hasPlannedStays: boolean;
  kioskSession: { workerName: string; startedAt: string } | null;
};

/**
 * Срок «до» строки: «до конца оплаченного», «+N смен» сверх него (или от
 * приёмки, если оплаченное уже прошло) или своя дата.
 */
export type StayChoice = "paid" | number | "date";

/** Что отмечено по строке: сколько остаётся, до когда, какие единицы. */
export type StayDraft = {
  quantity: number;
  until: string;
  unitIds: string[];
  choice: StayChoice;
  /** Нужна другой брони сверх оплаченного — оставить «под ответственность». */
  acknowledged?: boolean;
};

/** Строку можно оставить у клиента в пределах оплаченного — оплачено ещё хотя бы час. */
const STAY_MIN_MS = 60 * 60 * 1000;
const SHIFT_MS = 24 * 60 * 60 * 1000;
/**
 * Запас на расхождение часов. Оплаченное прошло — «+N» считается от «сейчас»
 * браузера, а сервер выставляет смены от своего «сейчас»: спеши часы
 * компьютера хоть на секунду, «+1 смена» стала бы двумя. Срок берём на
 * четверть часа раньше и округляем вниз до 15 минут.
 */
const CLOCK_MARGIN_MS = 15 * 60 * 1000;

export function canStay(line: ReturnPlanLine, now = Date.now()): boolean {
  return Date.parse(line.paidThrough) - now > STAY_MIN_MS;
}

/**
 * Хоть что-то можно оставить — тогда окно предлагает «Вернули не всё».
 * Сверх оплаченного оставить можно любую строку (с дополнительной сметой).
 */
export function anyStayPossible(plan: ReturnPlan): boolean {
  return plan.lines.length > 0;
}

/**
 * Чипы срока строки. Пока оплачено — первый «до конца оплаченного», «+N» —
 * сверх оплаченного; оплаченное прошло — от момента приёмки, начиная с «+1».
 */
export function stayChoicesFor(line: ReturnPlanLine, now = Date.now()): Array<{ choice: StayChoice; label: string }> {
  const plus = (n: number) => ({ choice: n, label: `+${n} ${pluralize(n, "смена", "смены", "смен")}` });
  if (canStay(line, now)) return [{ choice: "paid", label: "до конца оплаченного" }, plus(1), plus(2), { choice: "date", label: "дата…" }];
  const first = firstAnchoredShift(line, now);
  return [plus(first), plus(first + 1), plus(first + 2), { choice: "date", label: "дата…" }];
}

/**
 * Первый чип «+N» от якоря счёта, срок которого ещё впереди. Без якоря —
 * «+1» от сейчас. Исправление через несколько дней после приёмки начинается,
 * например, с «+6 смен»: столько и выставит сервер.
 */
function firstAnchoredShift(line: ReturnPlanLine, now: number): number {
  if (!line.billingAnchor) return 1;
  return Math.max(1, Math.floor((now + STAY_MIN_MS - Date.parse(line.billingAnchor)) / SHIFT_MS) + 1);
}

/** Срок «до» для чипа: «+N» — от конца оплаченного, а если он прошёл — от сейчас. */
export function untilForChoice(line: ReturnPlanLine, choice: Exclude<StayChoice, "date">, now = Date.now()): string {
  const paid = Date.parse(line.paidThrough);
  if (choice === "paid") return line.paidThrough;
  if (canStay(line, now)) return new Date(paid + choice * SHIFT_MS).toISOString();
  // От якоря сервера — точно: смены считаются от того же момента.
  if (line.billingAnchor) return new Date(Date.parse(line.billingAnchor) + choice * SHIFT_MS).toISOString();
  const raw = now + choice * SHIFT_MS - CLOCK_MARGIN_MS;
  return new Date(Math.floor(raw / CLOCK_MARGIN_MS) * CLOCK_MARGIN_MS).toISOString();
}

/** Срок позже оплаченного — будут лишние смены в дополнительной смете. */
export function isBeyondPaid(stay: Pick<StayDraft, "until">, line: ReturnPlanLine): boolean {
  return Date.parse(stay.until) > Date.parse(line.paidThrough);
}

/** Начальный выбор срока: в пределах оплаченного, если можно, иначе +1 смена. */
function defaultChoice(line: ReturnPlanLine, now = Date.now()): { choice: StayChoice; until: string } {
  if (line.plannedStayUntil) return { choice: "paid", until: line.plannedStayUntil };
  const choice: StayChoice = canStay(line, now) ? "paid" : firstAnchoredShift(line, now);
  return { choice, until: untilForChoice(line, choice, now) };
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
    stays.set(l.bookingItemId, { quantity, until: l.plannedStayUntil, unitIds, choice: "paid" });
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
  const start = prev ?? defaultChoice(line);
  next.set(line.bookingItemId, {
    quantity: q,
    until: start.until,
    choice: start.choice,
    unitIds,
    // «Под ответственность» давали за другое количество — спросить заново.
    acknowledged: prev?.quantity === q ? prev.acknowledged : undefined,
  });
  return next;
}

/** Выбрать срок строки: чип или своя дата (ISO). */
export function setStayChoice(
  stays: Map<string, StayDraft>,
  line: ReturnPlanLine,
  choice: StayChoice,
  customUntil?: string,
): Map<string, StayDraft> {
  const prev = stays.get(line.bookingItemId);
  if (!prev) return stays;
  const until = choice === "date" ? customUntil ?? prev.until : untilForChoice(line, choice);
  const next = new Map(stays);
  // Другой срок — другой держатель и другие дни: подтверждение не переносится.
  next.set(line.bookingItemId, { ...prev, choice, until, acknowledged: until === prev.until ? prev.acknowledged : undefined });
  return next;
}

/** «Оставить под ответственность» по строке, нужной другой брони. */
export function setStayAcknowledged(
  stays: Map<string, StayDraft>,
  line: ReturnPlanLine,
  acknowledged: boolean,
): Map<string, StayDraft> {
  const prev = stays.get(line.bookingItemId);
  if (!prev) return stays;
  const next = new Map(stays);
  next.set(line.bookingItemId, { ...prev, acknowledged });
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
  // Больше потолка строки не отметить.
  if (!current.includes(unitId) && current.length >= line.quantity) return stays;
  const unitIds = current.includes(unitId) ? current.filter((id) => id !== unitId) : [...current, unitId];
  const next = new Map(stays);
  if (unitIds.length === 0) next.delete(line.bookingItemId);
  else {
    const start = prev ?? defaultChoice(line);
    next.set(line.bookingItemId, {
      quantity: unitIds.length,
      until: start.until,
      choice: start.choice,
      unitIds,
      acknowledged: undefined,
    });
  }
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
          ...(s.acknowledged ? { acknowledgedConflict: true } : {}),
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

/** «с пн», «со вт», «со ср» — предлог перед днём недели из `formatWhen`. */
export function fromWhen(iso: string): string {
  const f = formatWhen(iso);
  return `${/^(вт|ср)/.test(f) ? "со" : "с"} ${f}`;
}

/** Держатель: кому нужна оставленная позиция (ответ превью). */
export type StayHolder = {
  bookingId: string;
  projectName: string;
  clientName: string | null;
  from: string;
};

/** Позиция нужна другой брони на дни сверх оплаченного. */
export type StayConflict = {
  bookingItemId: string;
  equipmentId: string;
  name: string;
  needed: number;
  available: number;
  /** С какого момента проверяли (конец оплаченного или сейчас). */
  from: string;
  until: string;
  /** С какого момента позиция нужна другой брони — его и показываем. */
  neededFrom?: string;
  holder: StayHolder | null;
};

/** Превью продолжения — POST /api/bookings/:id/return-partial/preview. */
export type ContinuationPreview = {
  until: string;
  docNumber: string | null;
  expectedPaymentDate: string | null;
  lines: Array<{
    bookingItemId: string | null;
    name: string;
    quantity: number;
    billedShifts: number;
    lineSum: string;
    afterDiscount: string;
    negotiated: boolean;
  }>;
  discountPercent: string;
  subtotal: string;
  discountAmount: string;
  surchargeAmount: string;
  total: string;
};

export type ReturnPreview = {
  continuations: ContinuationPreview[];
  conflicts: StayConflict[];
  /** Договорной итог основной брони — дополнительная смета оплачивается сверху. */
  parentNegotiatedTotal: string | null;
};

/** Хоть одна отмеченная строка — дольше оплаченного: есть что считать в превью. */
export function anyBeyondPaid(plan: ReturnPlan, stays: Map<string, StayDraft>): boolean {
  return plan.lines.some((l) => {
    const s = stays.get(l.bookingItemId);
    return s != null && isBeyondPaid(s, l);
  });
}

/** Строки «нужна другой брони», по которым не нажали «под ответственность». */
export function unacknowledgedConflicts(preview: ReturnPreview | null, stays: Map<string, StayDraft>): StayConflict[] {
  if (!preview) return [];
  return preview.conflicts.filter((c) => !stays.get(c.bookingItemId)?.acknowledged);
}
