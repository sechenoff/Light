/**
 * Форма оплаты брони и надбавка за безналичный расчёт.
 *
 * «Наличные» — цена как в смете. «По счёту (ИП)» — деньги проходят через
 * расчётный счёт, и к сумме брони плюсуется процент (компенсация налога и
 * банковской комиссии). Процент — снапшот на брони: дефолт живёт в
 * OrganizationSettings.cashlessSurchargePercent, на конкретной брони его
 * можно перебить.
 *
 * База надбавки — всё, что клиент платит по этой брони: оборудование после
 * скидки + доп-смета + транспорт. Транспорт входит намеренно: он тоже идёт
 * через счёт. Договорной итог (manualFinalAmount) надбавку не получает —
 * это уже финальная сумма, о которой сговорились.
 */
import Decimal from "decimal.js";

export const PAYMENT_FORMS = ["CASH", "CASHLESS"] as const;
export type PaymentForm = (typeof PAYMENT_FORMS)[number];

export const PAYMENT_FORM_LABELS: Record<PaymentForm, string> = {
  CASH: "Наличные",
  CASHLESS: "По счёту (ИП)",
};

type DecimalLike = Decimal | string | number;

export function isPaymentForm(value: unknown): value is PaymentForm {
  return typeof value === "string" && (PAYMENT_FORMS as readonly string[]).includes(value);
}

/**
 * Процент надбавки, который действует на брони: null для наличных и для
 * безнала без зафиксированного процента (тогда надбавки нет — не выдумываем).
 * `fallbackPercent` — дефолт из настроек, когда снапшот на брони ещё не записан.
 */
export function resolveSurchargePercent(args: {
  paymentForm: PaymentForm | string | null | undefined;
  cashlessSurchargePercent: DecimalLike | null | undefined;
  fallbackPercent?: DecimalLike | null;
}): Decimal | null {
  if (args.paymentForm !== "CASHLESS") return null;
  const raw = args.cashlessSurchargePercent ?? args.fallbackPercent;
  if (raw == null) return null;
  const percent = new Decimal(raw.toString());
  if (!percent.isFinite() || percent.lte(0)) return null;
  return percent;
}

/** Надбавка к базе: сумма (2 знака) и итог с надбавкой. При null — ноль. */
export function computeSurcharge(
  base: Decimal,
  percent: Decimal | null,
): { amount: Decimal; total: Decimal } {
  if (!percent) return { amount: new Decimal(0), total: base };
  const amount = base.mul(percent).div(100).toDecimalPlaces(2);
  return { amount, total: base.add(amount) };
}

/** «9», «9.5» — без хвостовых нулей, для подписей в документах и UI. */
export function formatPercent(percent: DecimalLike): string {
  return new Decimal(percent.toString()).toDecimalPlaces(2).toString();
}

/** Подпись строки надбавки в смете и счёте. */
export function surchargeLabel(percent: DecimalLike): string {
  return `Безналичный расчёт (+${formatPercent(percent)} %)`;
}
