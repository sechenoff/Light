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

type BookingVehicleRow = {
  id: string;
  bookingId: string;
  vehicleId: string;
  withGenerator: boolean;
  shiftHours: { toString(): string } | null;
  skipOvertime: boolean;
  kmOutsideMkad: number | null;
  ttkEntry: boolean;
  subtotalRub: { toString(): string } | null;
  createdAt: Date;
  vehicle?: { id: string; name: string; slug: string; shiftPriceRub?: { toString(): string } } | null;
};

export type BookingWithItemsEquipment = Booking & {
  client?: Client;
  items: Array<BookingItem & { equipment?: Equipment }>;
  estimate?: (Estimate & { lines: EstimateLine[] }) | null;
  vehicles?: BookingVehicleRow[];
};

function serializeBookingVehicle(v: BookingVehicleRow) {
  return {
    ...v,
    shiftHours: v.shiftHours != null ? v.shiftHours.toString() : null,
    subtotalRub: v.subtotalRub != null ? v.subtotalRub.toString() : null,
    vehicle: v.vehicle
      ? {
          ...v.vehicle,
          shiftPriceRub: v.vehicle.shiftPriceRub != null ? v.vehicle.shiftPriceRub.toString() : null,
        }
      : null,
  };
}

export function serializeBookingForApi(b: BookingWithItemsEquipment) {
  return {
    ...b,
    discountPercent: b.discountPercent?.toString() ?? null,
    totalEstimateAmount: (b as any).totalEstimateAmount?.toString?.() ?? (b as any).totalEstimateAmount ?? null,
    discountAmount: (b as any).discountAmount?.toString?.() ?? (b as any).discountAmount ?? null,
    finalAmount: (b as any).finalAmount?.toString?.() ?? (b as any).finalAmount ?? null,
    transportSubtotalRub: (b as any).transportSubtotalRub != null ? (b as any).transportSubtotalRub.toString() : null,
    amountPaid: (b as any).amountPaid?.toString?.() ?? (b as any).amountPaid ?? null,
    amountOutstanding: (b as any).amountOutstanding?.toString?.() ?? (b as any).amountOutstanding ?? null,
    items: b.items.map((it) => ({
      ...it,
      customUnitPrice: (it as any).customUnitPrice != null ? (it as any).customUnitPrice.toString() : null,
      equipment: it.equipment ? serializeEquipmentForJson(it.equipment) : null,
    })),
    estimate: b.estimate ? serializeEstimateForJson(b.estimate) : null,
    vehicles: b.vehicles ? b.vehicles.map(serializeBookingVehicle) : undefined,
  };
}
