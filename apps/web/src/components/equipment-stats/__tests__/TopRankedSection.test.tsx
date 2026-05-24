import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TopRankedSection } from "../TopRankedSection";
import type { EquipmentStatRow } from "../types";

function row(overrides: Partial<EquipmentStatRow>): EquipmentStatRow {
  return {
    id: "id-1",
    name: "Прожектор Aputure",
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

describe("TopRankedSection", () => {
  it("renders given rows with title", () => {
    const rows = [row({ id: "a", name: "Aputure", bookingsCount: 17, qtyShifts: 88 }),
                  row({ id: "b", name: "Manfrotto", bookingsCount: 12, qtyShifts: 40 })];
    render(
      <TopRankedSection
        icon="🔥"
        title="Чаще всего берут"
        rows={rows}
        rowKey="demand"
      />,
    );
    expect(screen.getByText("Чаще всего берут")).toBeInTheDocument();
    expect(screen.getByText("Aputure")).toBeInTheDocument();
    expect(screen.getByText("Manfrotto")).toBeInTheDocument();
  });

  it("renders an empty-state message when rows are empty", () => {
    render(
      <TopRankedSection
        icon="💤"
        title="Мёртвый груз"
        rows={[]}
        rowKey="deadStock"
        emptyText="Все позиции в работе — мёртвого груза нет 🎉"
      />,
    );
    expect(screen.getByText(/мёртвого груза нет/i)).toBeInTheDocument();
  });
});
