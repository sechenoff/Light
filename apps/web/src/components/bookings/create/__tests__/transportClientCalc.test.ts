import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import { computeTransportPriceClient, computeTransportListClient } from "../transportClientCalc";
import type { TransportInput } from "../transportClientCalc";
import type { VehicleRow, SelectedVehicle } from "../types";

const BASE_VEHICLE = {
  id: "v1",
  slug: "gazelle",
  name: "Газель",
  shiftPriceRub: "5000",
  hasGeneratorOption: true,
  generatorPriceRub: "2000",
  shiftHours: 12,
  overtimePercent: "10",
  displayOrder: 1,
};

describe("computeTransportPriceClient", () => {
  it("returns base shift rate with no extras", () => {
    const input: TransportInput = {
      vehicle: BASE_VEHICLE,
      withGenerator: false,
      shiftHours: 12,
      skipOvertime: false,
      kmOutsideMkad: 0,
      ttkEntry: false,
    };
    const result = computeTransportPriceClient(input);
    expect(result.vehicleId).toBe("v1");
    expect(result.vehicleName).toBe("Газель");
    expect(Number(result.shiftRate)).toBe(5000);
    expect(Number(result.overtime)).toBe(0);
    expect(result.overtimeHours).toBe(0);
    expect(Number(result.km)).toBe(0);
    expect(Number(result.ttk)).toBe(0);
    expect(Number(result.total)).toBe(5000);
  });

  it("adds generator to shift rate", () => {
    const input: TransportInput = {
      vehicle: BASE_VEHICLE,
      withGenerator: true,
      shiftHours: 12,
      skipOvertime: false,
      kmOutsideMkad: 0,
      ttkEntry: false,
    };
    const result = computeTransportPriceClient(input);
    // shiftRate = 5000 + 2000 = 7000
    expect(Number(result.shiftRate)).toBe(7000);
    expect(Number(result.total)).toBe(7000);
  });

  it("calculates overtime for hours beyond 12", () => {
    const input: TransportInput = {
      vehicle: BASE_VEHICLE,
      withGenerator: false,
      shiftHours: 14, // 2 overtime hours
      skipOvertime: false,
      kmOutsideMkad: 0,
      ttkEntry: false,
    };
    const result = computeTransportPriceClient(input);
    // overtime = 5000 * 0.10 * 2 = 1000
    expect(result.overtimeHours).toBe(2);
    expect(Number(result.overtime)).toBe(1000);
    expect(Number(result.total)).toBe(6000);
  });

  it("skips overtime when skipOvertime is true", () => {
    const input: TransportInput = {
      vehicle: BASE_VEHICLE,
      withGenerator: false,
      shiftHours: 16,
      skipOvertime: true,
      kmOutsideMkad: 0,
      ttkEntry: false,
    };
    const result = computeTransportPriceClient(input);
    expect(result.overtimeHours).toBe(0);
    expect(Number(result.overtime)).toBe(0);
    expect(Number(result.total)).toBe(5000);
  });

  it("calculates km outside MKAD at 120/km", () => {
    const input: TransportInput = {
      vehicle: BASE_VEHICLE,
      withGenerator: false,
      shiftHours: 12,
      skipOvertime: false,
      kmOutsideMkad: 30,
      ttkEntry: false,
    };
    const result = computeTransportPriceClient(input);
    // km = 30 * 120 = 3600
    expect(Number(result.km)).toBe(3600);
    expect(Number(result.total)).toBe(8600);
  });

  it("adds TTK entry fee of 500", () => {
    const input: TransportInput = {
      vehicle: BASE_VEHICLE,
      withGenerator: false,
      shiftHours: 12,
      skipOvertime: false,
      kmOutsideMkad: 0,
      ttkEntry: true,
    };
    const result = computeTransportPriceClient(input);
    expect(Number(result.ttk)).toBe(500);
    expect(Number(result.total)).toBe(5500);
  });

  it("combines all extras correctly", () => {
    const input: TransportInput = {
      vehicle: BASE_VEHICLE,
      withGenerator: true, // +2000
      shiftHours: 15, // 3 overtime hours → (5000+2000)*0.10*3 = 2100
      skipOvertime: false,
      kmOutsideMkad: 10, // 10*120 = 1200
      ttkEntry: true, // +500
    };
    const result = computeTransportPriceClient(input);
    expect(Number(result.shiftRate)).toBe(7000);
    expect(result.overtimeHours).toBe(3);
    expect(Number(result.overtime)).toBe(2100);
    expect(Number(result.km)).toBe(1200);
    expect(Number(result.ttk)).toBe(500);
    // total = 7000 + 2100 + 1200 + 500 = 10800
    expect(Number(result.total)).toBe(10800);
  });

  it("does not add generator when vehicle has no generator option", () => {
    const vehicleNoGen = { ...BASE_VEHICLE, hasGeneratorOption: false, generatorPriceRub: null };
    const input: TransportInput = {
      vehicle: vehicleNoGen,
      withGenerator: true, // withGenerator=true but vehicle doesn't support it
      shiftHours: 12,
      skipOvertime: false,
      kmOutsideMkad: 0,
      ttkEntry: false,
    };
    const result = computeTransportPriceClient(input);
    expect(Number(result.shiftRate)).toBe(5000);
    expect(Number(result.total)).toBe(5000);
  });

  it("respects vehicle.overtimePercent / vehicle.shiftHours (mirrors server)", () => {
    // 8h standard shift, 20% overtime — must NOT use hardcoded 12/10%.
    const vehicle = { ...BASE_VEHICLE, shiftHours: 8, overtimePercent: "20" };
    const result = computeTransportPriceClient({
      vehicle,
      withGenerator: false,
      shiftHours: 10, // 2 hours over the 8h standard
      skipOvertime: false,
      kmOutsideMkad: 0,
      ttkEntry: false,
    });
    expect(result.overtimeHours).toBe(2);
    // overtime = 5000 * 0.20 * 2 = 2000
    expect(Number(result.overtime)).toBe(2000);
    expect(Number(result.total)).toBe(7000);
  });
});

describe("computeTransportListClient (multi-vehicle sum, server parity)", () => {
  const ford: VehicleRow = {
    id: "ford",
    slug: "ford",
    name: "Ford",
    shiftPriceRub: "20000",
    hasGeneratorOption: false,
    generatorPriceRub: null,
    shiftHours: 12,
    overtimePercent: "10",
    displayOrder: 1,
  };
  const iveco: VehicleRow = {
    id: "iveco",
    slug: "iveco",
    name: "Ивеко",
    shiftPriceRub: "24000",
    hasGeneratorOption: true,
    generatorPriceRub: "25000",
    shiftHours: 12,
    overtimePercent: "10",
    displayOrder: 2,
  };

  function sel(vehicleId: string, over: Partial<SelectedVehicle> = {}): SelectedVehicle {
    return {
      vehicleId,
      withGenerator: false,
      shiftHours: 12,
      skipOvertime: false,
      kmOutsideMkad: 0,
      ttkEntry: false,
      ...over,
    };
  }

  it("subtotal == sum of per-vehicle totals (same formula as quoteEstimate)", () => {
    const { breakdowns, subtotal } = computeTransportListClient(
      [sel("ford"), sel("iveco", { withGenerator: true, ttkEntry: true })],
      [ford, iveco],
    );
    expect(breakdowns).toHaveLength(2);
    // Ford = 20000; Ивеко = 24000 + 25000 (gen) + 500 (ttk) = 49500
    const fordTotal = Number(breakdowns[0].total);
    const ivecoTotal = Number(breakdowns[1].total);
    expect(fordTotal).toBe(20000);
    expect(ivecoTotal).toBe(49500);
    expect(subtotal).toBe(fordTotal + ivecoTotal);
    expect(subtotal).toBe(69500);
  });

  it("empty selection → empty breakdowns, subtotal 0", () => {
    const { breakdowns, subtotal } = computeTransportListClient([], [ford, iveco]);
    expect(breakdowns).toHaveLength(0);
    expect(subtotal).toBe(0);
  });

  it("silently skips vehicles not present in vehicles list", () => {
    const { breakdowns, subtotal } = computeTransportListClient(
      [sel("ghost"), sel("ford")],
      [ford, iveco],
    );
    expect(breakdowns).toHaveLength(1);
    expect(breakdowns[0].vehicleId).toBe("ford");
    expect(subtotal).toBe(20000);
  });

  it("subtotal == server sumDec(Decimal) for float-drift-prone non-default overtime/shiftHours", () => {
    // Amounts/percentages chosen so each per-vehicle .total has cents that
    // accumulate float error under naive Number summation, but must match the
    // server `sumDec(transport.map(t => new Decimal(t.total)))` exactly.
    const v1: VehicleRow = {
      id: "v1",
      slug: "v1",
      name: "V1",
      shiftPriceRub: "10333.33",
      hasGeneratorOption: false,
      generatorPriceRub: null,
      shiftHours: 8, // non-default standard shift
      overtimePercent: "17", // non-default OT %
      displayOrder: 1,
    };
    const v2: VehicleRow = {
      id: "v2",
      slug: "v2",
      name: "V2",
      shiftPriceRub: "7777.77",
      hasGeneratorOption: true,
      generatorPriceRub: "3111.11",
      shiftHours: 10,
      overtimePercent: "23",
      displayOrder: 2,
    };
    const v3: VehicleRow = {
      id: "v3",
      slug: "v3",
      name: "V3",
      shiftPriceRub: "5050.55",
      hasGeneratorOption: false,
      generatorPriceRub: null,
      shiftHours: 12,
      overtimePercent: "11",
      displayOrder: 3,
    };
    const selected: SelectedVehicle[] = [
      sel("v1", { shiftHours: 13, kmOutsideMkad: 7, ttkEntry: true }), // 5 OT hrs over 8
      sel("v2", { shiftHours: 14, withGenerator: true, kmOutsideMkad: 3 }), // 4 OT hrs over 10
      sel("v3", { shiftHours: 15, ttkEntry: true }), // 3 OT hrs over 12
    ];
    const { breakdowns, subtotal } = computeTransportListClient(selected, [v1, v2, v3]);
    expect(breakdowns).toHaveLength(3);

    // Server parity: exact Decimal sum of the pre-rounded 2dp .total strings.
    const serverSum = breakdowns
      .map((b) => new Decimal(b.total))
      .reduce((acc, d) => acc.add(d), new Decimal(0));
    expect(subtotal).toBe(serverSum.toNumber());
    // And the precise 2dp string must round-trip identically.
    expect(new Decimal(subtotal).toFixed(2)).toBe(serverSum.toFixed(2));
  });
});
