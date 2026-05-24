import { describe, it, expect } from "vitest";
import path from "path";
import { parseXlsxEstimate } from "./xlsxEstimate";

const FIXTURE = path.resolve(__dirname, "../__fixtures__/sample-estimate.xlsx");

describe("parseXlsxEstimate", () => {
  it("extracts 3 rows from the fixture", () => {
    const rows = parseXlsxEstimate(FIXTURE);
    expect(rows).toHaveLength(3);
  });

  it("populates name, qty, unitPrice, lineSum", () => {
    const rows = parseXlsxEstimate(FIXTURE);
    expect(rows[0]).toEqual({ name: "Лантерн 120", qty: 1, unitPrice: 2500, lineSum: 2500 });
    expect(rows[1]).toEqual({ name: "Лайтдом 150", qty: 2, unitPrice: 1800, lineSum: 3600 });
    expect(rows[2]).toEqual({ name: "СДЛ 8", qty: 2, unitPrice: 1200, lineSum: 2400 });
  });

  it("skips the ИТОГО row", () => {
    const rows = parseXlsxEstimate(FIXTURE);
    expect(rows.find((r) => r.name?.toLowerCase().includes("итого"))).toBeUndefined();
  });

  it("throws for malformed xlsx", () => {
    const empty = path.resolve(__dirname, "__nonexistent__.xlsx");
    expect(() => parseXlsxEstimate(empty)).toThrow();
  });
});
