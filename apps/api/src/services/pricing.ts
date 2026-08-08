import Decimal from "decimal.js";

import type { Equipment } from "@prisma/client";

export type PricingMode = "SHIFT" | "TWO_SHIFTS" | "PROJECT";

export function computeUnitPriceForBookingPeriod(args: {
  equipment: Equipment;
  /** Число биллируемых смен по 24 ч (см. `billableShifts24h`). */
  shifts: number;
}): { unitPrice: Decimal; mode: PricingMode } {
  const ratePerShift = new Decimal(args.equipment.rentalRatePerShift.toString());
  const n = Math.floor(Number(args.shifts));
  const billable = Number.isFinite(n) && n >= 1 ? n : 1;
  // Ставка в смете — за одну смену (24 ч); итог по строке = ставка × кол-во единиц × число смен.
  return { unitPrice: ratePerShift.mul(billable), mode: "SHIFT" };
}

/**
 * Цена каталожной строки с учётом договорной ставки.
 *
 * Живёт здесь, а не в трёх построителях сметы, по горькому опыту: MAIN-снапшот
 * пересобирается в четырёх независимых местах (создание черновика, confirm,
 * PATCH брони, завершение приёмки на складе), и стоило одному из них считать
 * чуть иначе — колонка «цена/смена» в PDF поехала и это заметили спустя месяцы.
 *
 * Договорная цена задаётся ставкой ЗА СМЕНУ — в той же единице, что прайс,
 * каталог и колонка сметы. Наружу отдаётся цена за период, как и прайсовая.
 */
export function resolveCatalogLinePrice(args: {
  ratePerShift: Decimal | string | number;
  shifts: number;
  negotiatedRatePerShift?: Decimal | string | number | null;
}): {
  /** Цена за весь период — то, что уходит в EstimateLine.unitPrice. */
  unitPrice: Decimal;
  /** Прайсовая цена за период; null, если цена и есть прайсовая. */
  listUnitPrice: Decimal | null;
  isNegotiated: boolean;
} {
  const n = Math.floor(Number(args.shifts));
  const billable = Number.isFinite(n) && n >= 1 ? n : 1;
  const listUnitPrice = new Decimal(args.ratePerShift.toString()).mul(billable);
  if (args.negotiatedRatePerShift == null) {
    return { unitPrice: listUnitPrice, listUnitPrice: null, isNegotiated: false };
  }
  const unitPrice = new Decimal(args.negotiatedRatePerShift.toString()).mul(billable);
  return { unitPrice, listUnitPrice, isNegotiated: true };
}

/**
 * Раскладка сметы на прайсовую и договорную части.
 *
 * Процент ложится ТОЛЬКО на прайсовые строки: договорная цена — уже результат
 * переговоров, и начислять на неё скидку значило бы уступить дважды.
 */
export function splitEquipmentDiscount(
  lines: Array<{ lineSum: Decimal; isNegotiated: boolean }>,
  discountPercent: Decimal,
): {
  subtotal: Decimal;
  listedSubtotal: Decimal;
  negotiatedSubtotal: Decimal;
  discountAmount: Decimal;
  totalAfterDiscount: Decimal;
} {
  const sum = (xs: Decimal[]) => xs.reduce((a, v) => a.add(v), new Decimal(0));
  const subtotal = sum(lines.map((l) => l.lineSum));
  const listedSubtotal = sum(lines.filter((l) => !l.isNegotiated).map((l) => l.lineSum));
  const negotiatedSubtotal = sum(lines.filter((l) => l.isNegotiated).map((l) => l.lineSum));
  const discountAmount = listedSubtotal.mul(discountPercent).div(100);
  return {
    subtotal,
    listedSubtotal,
    negotiatedSubtotal,
    discountAmount,
    totalAfterDiscount: subtotal.sub(discountAmount),
  };
}
