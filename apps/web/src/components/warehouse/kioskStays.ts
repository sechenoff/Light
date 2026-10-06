import { pluralize } from "../../lib/format";

/**
 * «Остаётся у клиента» в киоске (мокап M3, этап 15) — без React.
 *
 * Срок оставленного: «до конца оплаченного» (пока оплачено), «+N смен» сверх
 * него — от конца оплаченного, а если он прошёл, от сейчас, — или своя дата.
 * Тот же расчёт, что в окне «Принять возврат» на карточке брони.
 */

export type KioskStayChoice = "paid" | 1 | 2 | 3 | "date";

/** Что остаётся у клиента по строке приёмки. */
export type KioskStay = {
  quantity: number;
  /** Штучная позиция — какие единицы остаются. */
  unitIds: string[];
  choice: KioskStayChoice;
  until: string;
  /** Нужна другой брони сверх оплаченного — «под ответственность». */
  acknowledged?: boolean;
};

const HOUR = 60 * 60 * 1000;
const SHIFT = 24 * HOUR;
/**
 * Запас на расхождение часов: оплаченное прошло — «+N» считается от «сейчас»
 * планшета, а сервер выставляет смены от своего. Спеши планшет на секунду —
 * «+1 смена» стала бы двумя. Срок — на четверть часа раньше, вниз до 15 минут.
 */
const CLOCK_MARGIN = 15 * 60 * 1000;
/** Срок «до» — не дальше года (так же проверяет сервер). */
export const MAX_STAY_AHEAD_MS = 365 * SHIFT;

/** Оплачено ещё хотя бы час — можно оставить без доплаты. */
export function paidLeft(paidThrough: string | undefined, now = Date.now()): boolean {
  return paidThrough != null && Date.parse(paidThrough) - now > HOUR;
}

export function stayChoices(paidThrough: string | undefined, now = Date.now()): Array<{ choice: KioskStayChoice; label: string }> {
  const plus = (n: 1 | 2 | 3) => ({ choice: n, label: `+${n} ${n === 1 ? "смена" : "смены"}` }) as const;
  return paidLeft(paidThrough, now)
    ? [{ choice: "paid", label: "до конца оплаченного" }, plus(1), plus(2), { choice: "date", label: "дата…" }]
    : [plus(1), plus(2), plus(3), { choice: "date", label: "дата…" }];
}

export function untilFor(paidThrough: string | undefined, choice: Exclude<KioskStayChoice, "date">, now = Date.now()): string {
  if (choice === "paid" && paidThrough) return paidThrough;
  const n = choice === "paid" ? 0 : choice;
  if (paidLeft(paidThrough, now)) return new Date(Date.parse(paidThrough as string) + n * SHIFT).toISOString();
  const raw = now + n * SHIFT - CLOCK_MARGIN;
  return new Date(Math.floor(raw / CLOCK_MARGIN) * CLOCK_MARGIN).toISOString();
}

/** Срок позже оплаченного — будет дополнительная смета. */
export function beyondPaid(until: string, paidThrough: string | undefined): boolean {
  return paidThrough == null || Date.parse(until) > Date.parse(paidThrough);
}

/** Новое «остаётся у клиента» по строке, оплата которой уже прошла или идёт. */
export function newStay(paidThrough: string | undefined, quantity: number, unitIds: string[] = []): KioskStay {
  const choice: KioskStayChoice = paidLeft(paidThrough) ? "paid" : 1;
  return { quantity, unitIds, choice, until: untilFor(paidThrough, choice) };
}

/** ISO → значение для <input type="datetime-local"> (время планшета). */
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const shiftsWord = (n: number) => pluralize(n, "смена", "смены", "смен");

/**
 * Новое «остаётся» по строке: подтверждение «под ответственность» давали за
 * прежние срок и количество — после их смены его спрашивают заново.
 */
export function withTerms(prev: KioskStay, next: Partial<KioskStay>): KioskStay {
  const merged = { ...prev, ...next };
  const same = merged.until === prev.until && merged.quantity === prev.quantity;
  return { ...merged, acknowledged: same ? merged.acknowledged : undefined };
}

/** Превью продолжений с сервера (POST /sessions/:id/stays-preview). */
export type KioskStaysPreview = {
  continuations: Array<{
    until: string;
    docNumber: string | null;
    lines: Array<{ bookingItemId: string | null; name: string; quantity: number; billedShifts: number; lineSum: string; afterDiscount: string; negotiated: boolean }>;
    discountPercent: string;
    surchargeAmount: string;
    total: string;
  }>;
  conflicts: Array<{
    bookingItemId: string;
    name: string;
    needed: number;
    available: number;
    from: string;
    /** С какого момента позиция нужна другой брони — его и показываем. */
    neededFrom?: string;
    holder: { projectName: string; clientName: string | null } | null;
  }>;
  parentNegotiatedTotal: string | null;
};
