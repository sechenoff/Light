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

