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
  const base = paidLeft(paidThrough, now) ? Date.parse(paidThrough as string) : now;
  const n = choice === "paid" ? 0 : choice;
  return new Date(base + n * SHIFT).toISOString();
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

export const shiftsWord = (n: number) =>
  n % 10 === 1 && n % 100 !== 11 ? "смена" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? "смены" : "смен";

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
    holder: { projectName: string; clientName: string | null } | null;
  }>;
  parentNegotiatedTotal: string | null;
};
