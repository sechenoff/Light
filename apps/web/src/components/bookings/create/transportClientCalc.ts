import type { VehicleRow, TransportBreakdown } from "./types";

export type TransportInput = {
  vehicle: VehicleRow;
  withGenerator: boolean;
  shiftHours: number;
  skipOvertime: boolean;
  kmOutsideMkad: number;
  ttkEntry: boolean;
};

/** Client-side mirror of the server transportCalculator. Keep in sync. */
export function computeTransportPriceClient(input: TransportInput): TransportBreakdown {
  const baseShift = Number(input.vehicle.shiftPriceRub);
  const generator =
    input.withGenerator && input.vehicle.hasGeneratorOption
      ? Number(input.vehicle.generatorPriceRub ?? 0)
      : 0;
  const shiftRate = baseShift + generator;

  const overtimeHours = input.skipOvertime ? 0 : Math.max(0, input.shiftHours - 12);
  const overtime = shiftRate * 0.1 * overtimeHours;

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
