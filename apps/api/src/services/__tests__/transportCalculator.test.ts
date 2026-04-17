import { describe, it, expect } from "vitest";
import { computeTransportPrice } from "../transportCalculator";
import type { VehicleInput } from "../transportCalculator";

const ford: VehicleInput = {
  shiftPriceRub: "20000",
  hasGeneratorOption: false,
  generatorPriceRub: null,
  shiftHours: 12,
  overtimePercent: "10",
};

const iveco: VehicleInput = {
  shiftPriceRub: "24000",
  hasGeneratorOption: true,
  generatorPriceRub: "25000",
  shiftHours: 12,
  overtimePercent: "10",
};

describe("computeTransportPrice", () => {
  it("чисто сменная ставка в Москве, 12 часов, без доп. опций", () => {
    const result = computeTransportPrice({
      vehicle: ford,
      withGenerator: false,
      shiftHours: 12,
      skipOvertime: false,
      kmOutsideMkad: 0,
      ttkEntry: false,
    });

    expect(result.shiftRate).toBe("20000.00");
    expect(result.overtime).toBe("0.00");
    expect(result.overtimeHours).toBe(0);
    expect(result.km).toBe("0.00");
    expect(result.ttk).toBe("0.00");
    expect(result.total).toBe("20000.00");
  });

  it("с генератором (Ивеко + генератор)", () => {
    const result = computeTransportPrice({
      vehicle: iveco,
      withGenerator: true,
      shiftHours: 12,
      skipOvertime: false,
      kmOutsideMkad: 0,
      ttkEntry: false,
    });

    expect(result.shiftRate).toBe("49000.00"); // 24000 + 25000
    expect(result.overtime).toBe("0.00");
    expect(result.total).toBe("49000.00");
  });

  it("генератор игнорируется если hasGeneratorOption=false (Ford)", () => {
    const result = computeTransportPrice({
      vehicle: ford,
      withGenerator: true, // попытка включить — должна быть проигнорирована
      shiftHours: 12,
      skipOvertime: false,
      kmOutsideMkad: 0,
      ttkEntry: false,
    });

    expect(result.shiftRate).toBe("20000.00"); // генератор не добавляется
    expect(result.total).toBe("20000.00");
  });

  it("с переработкой 2 часа (Ford: 20000 + 2×2000 = 24000)", () => {
    const result = computeTransportPrice({
      vehicle: ford,
      withGenerator: false,
      shiftHours: 14,
      skipOvertime: false,
      kmOutsideMkad: 0,
      ttkEntry: false,
    });

    // overtime = 20000 × 10% × 2 = 4000 (2 hours × 2000/h)
    expect(result.overtimeHours).toBe(2);
    expect(result.overtime).toBe("4000.00"); // 20000 * 0.10 * 2
    expect(result.total).toBe("24000.00"); // 20000 + 4000
  });

  it("с skipOvertime=true — переработка = 0 даже при 14 часах", () => {
    const result = computeTransportPrice({
      vehicle: ford,
      withGenerator: false,
      shiftHours: 14,
      skipOvertime: true,
      kmOutsideMkad: 0,
      ttkEntry: false,
    });

    expect(result.overtimeHours).toBe(0);
    expect(result.overtime).toBe("0.00");
    expect(result.total).toBe("20000.00");
  });

  it("с километражем 100 км → 12 000 ₽ (100 × 120)", () => {
    const result = computeTransportPrice({
      vehicle: ford,
      withGenerator: false,
      shiftHours: 12,
      skipOvertime: false,
      kmOutsideMkad: 100,
      ttkEntry: false,
    });

    expect(result.km).toBe("12000.00");
    expect(result.total).toBe("32000.00"); // 20000 + 12000
  });

  it("с ТТК → +500 ₽", () => {
    const result = computeTransportPrice({
      vehicle: ford,
      withGenerator: false,
      shiftHours: 12,
      skipOvertime: false,
      kmOutsideMkad: 0,
      ttkEntry: true,
    });

    expect(result.ttk).toBe("500.00");
    expect(result.total).toBe("20500.00");
  });

  it("комбинация: Ивеко + генератор + 14 часов + 50 км + ТТК", () => {
    const result = computeTransportPrice({
      vehicle: iveco,
      withGenerator: true,
      shiftHours: 14,
      skipOvertime: false,
      kmOutsideMkad: 50,
      ttkEntry: true,
    });

    // shiftRate = 24000 + 25000 = 49000
    // overtimeHours = 14 - 12 = 2
    // overtime = 49000 × 10% × 2 = 9800
    // km = 50 × 120 = 6000
    // ttk = 500
    // total = 49000 + 9800 + 6000 + 500 = 65300

    expect(result.shiftRate).toBe("49000.00");
    expect(result.overtimeHours).toBe(2);
    expect(result.overtime).toBe("9800.00");
    expect(result.km).toBe("6000.00");
    expect(result.ttk).toBe("500.00");
    expect(result.total).toBe("65300.00");
  });

  it("граничный случай: shiftHours=0 — overtime=0, shiftRate только base", () => {
    const result = computeTransportPrice({
      vehicle: ford,
      withGenerator: false,
      shiftHours: 0,
      skipOvertime: false,
      kmOutsideMkad: 0,
      ttkEntry: false,
    });

    // shiftHours=0 меньше 12 → overtimeHours = max(0, 0-12) = 0
    expect(result.overtimeHours).toBe(0);
    expect(result.overtime).toBe("0.00");
    expect(result.total).toBe("20000.00"); // только base shift
  });

  it("граничный случай: kmOutsideMkad отрицательный → 0", () => {
    const result = computeTransportPrice({
      vehicle: ford,
      withGenerator: false,
      shiftHours: 12,
      skipOvertime: false,
      kmOutsideMkad: -50,
      ttkEntry: false,
    });

    expect(result.km).toBe("0.00");
    expect(result.total).toBe("20000.00");
  });
});
