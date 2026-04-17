import { describe, it, expect } from "vitest";
import { computeTransportPriceClient } from "../transportClientCalc";
import type { TransportInput } from "../transportClientCalc";

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
});
