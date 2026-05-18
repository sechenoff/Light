import Decimal from "decimal.js";
import type { VehicleRow, TransportBreakdown, SelectedVehicle } from "./types";

export type TransportInput = {
  vehicle: VehicleRow;
  withGenerator: boolean;
  shiftHours: number;
  skipOvertime: boolean;
  kmOutsideMkad: number;
  ttkEntry: boolean;
};

/**
 * Client-side mirror of the server transportCalculator
 * (apps/api/src/services/transportCalculator.ts). Keep the formula in sync:
 *   shiftRate     = shiftPriceRub + (generator if withGenerator && hasGeneratorOption)
 *   overtimeHours = skipOvertime ? 0 : max(0, shiftHours - vehicle.shiftHours)
 *   overtime      = shiftRate * overtimePercent/100 * overtimeHours
 *   km            = kmOutsideMkad * 120
 *   ttk           = ttkEntry ? 500 : 0
 *   total         = shiftRate + overtime + km + ttk
 */
export function computeTransportPriceClient(input: TransportInput): TransportBreakdown {
  const baseShift = Number(input.vehicle.shiftPriceRub);
  const generator =
    input.withGenerator && input.vehicle.hasGeneratorOption
      ? Number(input.vehicle.generatorPriceRub ?? 0)
      : 0;
  const shiftRate = baseShift + generator;

  const standardShiftHours = input.vehicle.shiftHours ?? 12;
  const overtimeHours = input.skipOvertime
    ? 0
    : Math.max(0, input.shiftHours - standardShiftHours);
  const overtimeRate = Number(input.vehicle.overtimePercent ?? 10) / 100;
  const overtime = shiftRate * overtimeRate * overtimeHours;

  const km = Math.max(0, input.kmOutsideMkad) * 120;
  const ttk = input.ttkEntry ? 500 : 0;

  const total = shiftRate + overtime + km + ttk;

  return {
    vehicleId: input.vehicle.id,
    vehicleName: input.vehicle.name,
    shiftRate: shiftRate.toFixed(2),
    overtime: overtime.toFixed(2),
    overtimeHours,
    km: km.toFixed(2),
    ttk: ttk.toFixed(2),
    total: total.toFixed(2),
  };
}

/**
 * Считает разбивку по каждой выбранной машине + суммарный subtotal.
 * Зеркалит серверный `quoteEstimate`: каждая машина независимо,
 * transportSubtotal = сумма всех .total. Машины без соответствия
 * в `vehicles` молча пропускаются.
 */
export function computeTransportListClient(
  selected: SelectedVehicle[],
  vehicles: VehicleRow[],
): { breakdowns: TransportBreakdown[]; subtotal: number } {
  const breakdowns: TransportBreakdown[] = [];
  for (const sel of selected) {
    const vehicle = vehicles.find((v) => v.id === sel.vehicleId);
    if (!vehicle) continue;
    breakdowns.push(
      computeTransportPriceClient({
        vehicle,
        withGenerator: sel.withGenerator,
        shiftHours: sel.shiftHours,
        skipOvertime: sel.skipOvertime,
        kmOutsideMkad: sel.kmOutsideMkad,
        ttkEntry: sel.ttkEntry,
      }),
    );
  }
  // Decimal sum of the pre-rounded 2dp `.total` strings — byte-for-byte mirror
  // of the server `sumDec(transport.map(t => new Decimal(t.total)))` in
  // apps/api/src/services/bookings.ts. Native float accumulation here could
  // drift a few cents vs the server Decimal sum on long multi-vehicle lists.
  const subtotalDec = breakdowns.reduce(
    (acc, b) => acc.add(new Decimal(b.total)),
    new Decimal(0),
  );
  const subtotal = subtotalDec.toNumber();
  return { breakdowns, subtotal };
}
