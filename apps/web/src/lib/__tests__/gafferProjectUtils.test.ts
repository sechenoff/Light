import { describe, it, expect } from "vitest";
import {
  clientDebtVariant,
  teamDebtVariant,
  formatShootDate,
} from "../gafferProjectUtils";

describe("clientDebtVariant", () => {
  it("returns rose pill when clientRemaining > 0", () => {
    const result = clientDebtVariant("1000", "500");
    expect(result?.colorClass).toBe("bg-rose-soft text-rose border-rose-border");
    expect(result?.label).toContain("500");
    expect(result?.label).toContain("Клиент должен");
  });

  it("returns emerald pill when plan > 0 and remaining = 0", () => {
    const result = clientDebtVariant("1000", "0");
    expect(result).toEqual({
      label: "Оплачено",
      colorClass: "bg-emerald-soft text-emerald border-emerald-border",
    });
  });

  it("returns null when plan = 0 and received = 0", () => {
    const result = clientDebtVariant("0", "0");
    expect(result).toBeNull();
  });

  it("handles string decimals", () => {
    const result = clientDebtVariant("5000.00", "1234.56");
    expect(result?.label).toContain("1");
    expect(result?.label).toContain("234");
    expect(result?.colorClass).toContain("rose");
  });
});

describe("teamDebtVariant", () => {
  it("returns amber pill when teamRemaining > 0", () => {
    const result = teamDebtVariant("2000", "500");
    expect(result?.colorClass).toBe("bg-amber-soft text-amber border-amber-border");
    expect(result?.label).toContain("500");
    expect(result?.label).toContain("Команде");
  });

  it("returns emerald pill when plan > 0 and remaining = 0", () => {
    const result = teamDebtVariant("2000", "0");
    expect(result).toEqual({
      label: "Выплачено",
      colorClass: "bg-emerald-soft text-emerald border-emerald-border",
    });
  });

  it("returns null when plan = 0", () => {
    const result = teamDebtVariant("0", "0");
    expect(result).toBeNull();
  });
});

describe("formatShootDate", () => {
  it("formats ISO date as Russian short date", () => {
    const result = formatShootDate("2026-07-15");
    expect(result).toMatch(/15/);
    expect(result).toMatch(/июл|июля/i);
  });

  it("returns empty string for empty input", () => {
    expect(formatShootDate("")).toBe("");
    expect(formatShootDate(null)).toBe("");
    expect(formatShootDate(undefined)).toBe("");
  });
});
