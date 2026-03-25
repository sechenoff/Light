import type { Booking, BookingItem, Client, Equipment, Estimate, EstimateLine } from "@prisma/client";

export function serializeEquipmentForJson(e: Equipment) {
  return {
    ...e,
    rentalRatePerShift: e.rentalRatePerShift.toString(),
    rentalRateTwoShifts: e.rentalRateTwoShifts?.toString() ?? null,
    rentalRatePerProject: e.rentalRatePerProject?.toString() ?? null,
  };
}

export function serializeEstimateForJson(
  est: Estimate & { lines: EstimateLine[] },
) {
  const { booking: _drop, ...rest } = est as Estimate & { lines: EstimateLine[]; booking?: unknown };
  return {
    ...rest,
    subtotal: est.subtotal.toString(),
    discountPercent: est.discountPercent?.toString() ?? null,
    discountAmount: est.discountAmount.toString(),
    totalAfterDiscount: est.totalAfterDiscount.toString(),
    lines: est.lines.map((l) => ({
      ...l,
      unitPrice: l.unitPrice.toString(),
      lineSum: l.lineSum.toString(),
    })),
  };
}

export type BookingWithItemsEquipment = Booking & {
  client?: Client;
  items: Array<BookingItem & { equipment?: Equipment }>;
  estimate?: (Estimate & { lines: EstimateLine[] }) | null;
};

export function serializeBookingForApi(b: BookingWithItemsEquipment) {
  return {
    ...b,
    discountPercent: b.discountPercent?.toString() ?? null,
    totalEstimateAmount: (b as any).totalEstimateAmount?.toString?.() ?? (b as any).totalEstimateAmount ?? null,
    discountAmount: (b as any).discountAmount?.toString?.() ?? (b as any).discountAmount ?? null,
    finalAmount: (b as any).finalAmount?.toString?.() ?? (b as any).finalAmount ?? null,
    amountPaid: (b as any).amountPaid?.toString?.() ?? (b as any).amountPaid ?? null,
    amountOutstanding: (b as any).amountOutstanding?.toString?.() ?? (b as any).amountOutstanding ?? null,
    items: b.items.map((it) =>
      it.equipment
        ? { ...it, equipment: serializeEquipmentForJson(it.equipment) }
        : it,
    ),
    estimate: b.estimate ? serializeEstimateForJson(b.estimate) : null,
  };
}
