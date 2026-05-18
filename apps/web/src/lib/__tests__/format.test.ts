import { describe, it, expect } from "vitest";
import { formatRub, formatExpenseRub, formatMarginPercent } from "../format";

// Non-breaking space used by Intl ru-RU currency grouping/symbol separator.
const NB = " ";

describe("formatRub (regression — non-zero formats must not change)", () => {
  it("formats integer amounts without decimals", () => {
    expect(formatRub(42600)).toBe(`42${NB}600${NB}₽`);
  });

  it("formats fractional amounts with two decimals", () => {
    expect(formatRub(1031954.5)).toBe(`1${NB}031${NB}954,50${NB}₽`);
  });

  it("formats zero as a plain 0 ₽ (no negative zero)", () => {
    expect(formatRub(0)).toBe(`0${NB}₽`);
  });
});

describe("formatExpenseRub (no negative-zero, sign only when > 0)", () => {
  it("returns plain 0 ₽ for zero — never «−0 ₽»", () => {
    expect(formatExpenseRub(0)).toBe(`0${NB}₽`);
    expect(formatExpenseRub(0)).not.toContain("−");
  });

  it("returns plain 0 ₽ for negative zero", () => {
    expect(formatExpenseRub(-0)).toBe(`0${NB}₽`);
    expect(formatExpenseRub(-0)).not.toContain("−");
  });

  it("returns plain 0 ₽ for null/undefined/garbage", () => {
    expect(formatExpenseRub(null)).toBe(`0${NB}₽`);
    expect(formatExpenseRub(undefined)).toBe(`0${NB}₽`);
    expect(formatExpenseRub("not a number")).toBe(`0${NB}₽`);
  });

  it("prefixes a single U+2212 minus for positive amounts", () => {
    expect(formatExpenseRub(42600)).toBe(`−42${NB}600${NB}₽`);
  });

  it("normalises negative input to a single leading minus", () => {
    expect(formatExpenseRub(-42600)).toBe(`−42${NB}600${NB}₽`);
    // exactly one minus sign, not «−−»
    expect(formatExpenseRub(-42600).match(/−/g)?.length).toBe(1);
  });

  it("accepts string input (Decimal-serialized)", () => {
    expect(formatExpenseRub("1031954.50")).toBe(`−1${NB}031${NB}954,50${NB}₽`);
  });
});

describe("formatMarginPercent (percent of zero base is meaningless)", () => {
  it("returns em-dash when base is zero", () => {
    expect(formatMarginPercent(0, 0)).toBe("—");
    expect(formatMarginPercent(123, 0)).toBe("—");
  });

  it("returns em-dash when base is negative or non-finite", () => {
    expect(formatMarginPercent(50, -100)).toBe("—");
    expect(formatMarginPercent(50, Number.NaN)).toBe("—");
  });

  it("formats a positive margin with a leading +", () => {
    expect(formatMarginPercent(50000, 100000)).toBe("+50%");
  });

  it("formats a zero numerator over a positive base as +0%", () => {
    // base is real here (revenue > 0), so 0% IS meaningful
    expect(formatMarginPercent(0, 100000)).toBe("+0%");
  });

  it("formats a negative margin with a leading -", () => {
    expect(formatMarginPercent(-1000, 100000)).toBe("-1%");
  });
});
