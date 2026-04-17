import Decimal from "decimal.js";

export type VehicleInput = {
  shiftPriceRub: string | number; // Decimal string or number
  hasGeneratorOption: boolean;
  generatorPriceRub?: string | number | null;
  shiftHours: number;           // standard shift hours (usually 12)
  overtimePercent: string | number; // usually 10
};

export type TransportInput = {
  vehicle: VehicleInput;
  withGenerator: boolean;      // применимо только если vehicle.hasGeneratorOption
  shiftHours: number;          // часы одной смены (может отличаться от стандарта)
  skipOvertime: boolean;       // чекбокс «Без переработки»
  kmOutsideMkad: number;       // одно число «до площадки», умножается на 120
  ttkEntry: boolean;           // +500 ₽
};

export type TransportBreakdown = {
  shiftRate: string;      // base shift + optional generator
  overtime: string;       // OT surcharge
  overtimeHours: number;  // hours above standard shift
  km: string;             // km cost
  ttk: string;            // TTK surcharge
  total: string;          // grand total
};

/**
 * Вычисляет стоимость транспорта.
 * Pure функция — только арифметика, никаких побочных эффектов.
 *
 * Формула:
 *   shiftRate     = vehicle.shiftPriceRub + (generator if withGenerator && hasGeneratorOption)
 *   overtimeHours = skipOvertime ? 0 : max(0, shiftHours - 12)
 *   overtime      = shiftRate * overtimePercent/100 * overtimeHours
 *   km            = kmOutsideMkad * 120   (60 ₽/км × туда-обратно)
 *   ttk           = ttkEntry ? 500 : 0
 *   total         = shiftRate + overtime + km + ttk
 */
export function computeTransportPrice(input: TransportInput): TransportBreakdown {
  const baseShift = new Decimal(input.vehicle.shiftPriceRub);
  const generatorPrice =
    input.withGenerator && input.vehicle.hasGeneratorOption
      ? new Decimal(input.vehicle.generatorPriceRub ?? 0)
      : new Decimal(0);

  const shiftRate = baseShift.add(generatorPrice);

  const standardShiftHours = input.vehicle.shiftHours ?? 12;
  const rawOvertimeHours = input.skipOvertime
    ? 0
    : Math.max(0, input.shiftHours - standardShiftHours);

  const overtimeRate = new Decimal(input.vehicle.overtimePercent).div(100);
  const overtime = shiftRate.mul(overtimeRate).mul(rawOvertimeHours);

  const safeKm = Math.max(0, input.kmOutsideMkad);
  const km = new Decimal(safeKm).mul(120); // 60 ₽/км × туда-обратно

  const ttk = input.ttkEntry ? new Decimal(500) : new Decimal(0);

  const total = shiftRate.add(overtime).add(km).add(ttk);

  return {
    shiftRate: shiftRate.toFixed(2),
    overtime: overtime.toFixed(2),
    overtimeHours: rawOvertimeHours,
    km: km.toFixed(2),
    ttk: ttk.toFixed(2),
    total: total.toFixed(2),
  };
}
