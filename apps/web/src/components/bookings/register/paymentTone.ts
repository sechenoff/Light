import type { BookingRegisterRow as Row } from "@light-rental/shared";

/**
 * Тон строки и карточки реестра по оплате (решение владельца 2026-10-04):
 * зелёный — долга нет, красный — есть остаток, в том числе частичная оплата,
 * просрочка и будущая бронь, за которую ещё не платили.
 *
 * Только у состоявшихся броней. У черновика, согласования и отменённой брони
 * «не оплачено» ничего не значит — денег никто не ждёт, а лишний красный
 * приучил бы его не замечать. Сумма 0, «не рассчитано» и «нет начислений» —
 * тоже без тона. Мокап — docs/mockups/bookings-payment-tint.
 */
export type PaymentTone = "paid" | "unpaid";

const DEAL_STATUSES: ReadonlySet<Row["status"]> = new Set([
  "CONFIRMED",
  "ISSUED",
  "RETURNED",
]);
/** Долга нет: оплачено целиком, остаток прощён или клиент заплатил больше. */
const SETTLED_STATES: ReadonlySet<Row["financeState"]> = new Set([
  "PAID",
  "SETTLED",
  "CREDIT",
]);
/** Есть остаток (сервер ставит их ровно при amountOutstanding > 0). */
const OWED_STATES: ReadonlySet<Row["financeState"]> = new Set([
  "UNPAID",
  "PARTIAL",
]);

export function paymentTone(
  row: Pick<Row, "status" | "financeState">,
): PaymentTone | null {
  if (!DEAL_STATUSES.has(row.status)) return null;
  if (SETTLED_STATES.has(row.financeState)) return "paid";
  if (OWED_STATES.has(row.financeState)) return "unpaid";
  return null;
}

// Классы — целиком строками: Tailwind собирает только то, что видит в исходниках.
// Розовый на белом заметно слабее зелёного, поэтому его доля выше (70 против 60),
// иначе на ярком мониторе красные строки сливаются с белыми. Ночью мягкие тона —
// уже тёмные подложки, их берём целиком.

export const PAYMENT_ROW_TONE: Record<PaymentTone, string> = {
  paid: "bg-emerald-soft/60 hover:bg-emerald-soft dark:bg-emerald-soft dark:hover:bg-emerald-border/60",
  unpaid:
    "bg-rose-soft/70 hover:bg-rose-soft dark:bg-rose-soft dark:hover:bg-rose-border/60",
};

/** Тон закреплённой ячейки «Действия» (режим «Начислено и получено»): она
 *  непрозрачна (bg-surface), а тон строки повторяет градиентом поверх. */
export const PAYMENT_STICKY_TONE: Record<PaymentTone, string> = {
  paid: "from-emerald-soft/60 to-emerald-soft/60 group-hover:from-emerald-soft group-hover:to-emerald-soft dark:from-emerald-soft dark:to-emerald-soft dark:group-hover:from-emerald-border/60 dark:group-hover:to-emerald-border/60",
  unpaid:
    "from-rose-soft/70 to-rose-soft/70 group-hover:from-rose-soft group-hover:to-rose-soft dark:from-rose-soft dark:to-rose-soft dark:group-hover:from-rose-border/60 dark:group-hover:to-rose-border/60",
};

/** Карточка (телефон, планшет, «Доска», «Пульт дня») и образец в легенде. */
export const PAYMENT_CARD_TONE: Record<PaymentTone, string> = {
  paid: "border-emerald-border bg-emerald-soft/60 dark:bg-emerald-soft",
  unpaid: "border-rose-border bg-rose-soft/70 dark:bg-rose-soft",
};

/** Разделители внутри карточки в тон её рамке. */
export const PAYMENT_CARD_RULE: Record<PaymentTone, string> = {
  paid: "border-emerald-border",
  unpaid: "border-rose-border",
};

/** Выбор строки галочкой не перекрашивает её — иначе стёр бы цвет оплаты:
 *  выбранную отмечает синяя полоса у левого края. */
export const SELECTED_ROW_MARK = "shadow-[inset_3px_0_0] shadow-accent";
