import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { MasterTable } from "../MasterTable";
import type { EquipmentStatRow } from "../types";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

function row(overrides: Partial<EquipmentStatRow>): EquipmentStatRow {
  return {
    id: "id-1",
    name: "Прожектор",
    category: "Свет",
    totalQuantity: 5,
    bookingsCount: 0,
    qtyShifts: 0,
    revenueRub: "0",
    revenuePerStorageUnit: "0",
    repairCount: 0,
    problemCount: 0,
    repairCostRub: "0",
    lastBookingAt: null,
    ...overrides,
  };
}

const rows: EquipmentStatRow[] = [
  row({ id: "a", name: "Aputure", category: "Свет", bookingsCount: 5, revenueRub: "10000" }),
  row({ id: "b", name: "Manfrotto", category: "Опоры", bookingsCount: 0, revenueRub: "0", repairCount: 2 }),
  row({ id: "c", name: "Софтбокс", category: "Свет", bookingsCount: 3, revenueRub: "5000" }),
];

describe("MasterTable", () => {
  it("renders all rows by default sorted alphabetically", () => {
    render(<MasterTable rows={rows} />);
    const dataRows = screen.getAllByRole("row").slice(1); // skip header
    const names = dataRows.map((r) => within(r).getAllByRole("cell")[0].textContent);
    expect(names).toEqual(["Aputure", "Manfrotto", "Софтбокс"]);
  });

  it("filters to rows with bookingsCount = 0 when 'Без аренды' chip is active", () => {
    render(<MasterTable rows={rows} />);
    fireEvent.click(screen.getByRole("button", { name: "Без аренды" }));
    const dataRows = screen.getAllByRole("row").slice(1);
    expect(dataRows).toHaveLength(1);
    expect(within(dataRows[0]).getAllByRole("cell")[0].textContent).toBe("Manfrotto");
  });

  it("filters to rows with incidents when 'С поломками' chip is active", () => {
    render(<MasterTable rows={rows} />);
    fireEvent.click(screen.getByRole("button", { name: "С поломками" }));
    const dataRows = screen.getAllByRole("row").slice(1);
    expect(dataRows).toHaveLength(1);
    expect(within(dataRows[0]).getAllByRole("cell")[0].textContent).toBe("Manfrotto");
  });

  it("sorts by Броней desc when column header clicked", () => {
    render(<MasterTable rows={rows} />);
    fireEvent.click(within(screen.getByRole("columnheader", { name: /Броней/ })).getByRole("button"));
    const dataRows = screen.getAllByRole("row").slice(1);
    const names = dataRows.map((r) => within(r).getAllByRole("cell")[0].textContent);
    expect(names).toEqual(["Aputure", "Софтбокс", "Manfrotto"]);
  });
});
