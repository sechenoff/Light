import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { CatalogList } from "../CatalogList";
import type { AvailabilityRow, CatalogSelectedItem, OffCatalogItem } from "../types";

function mkRow(overrides: Partial<AvailabilityRow>): AvailabilityRow {
  return {
    equipmentId: "eq1",
    category: "Свет",
    name: "ARRI SkyPanel S60-C",
    brand: null,
    model: null,
    stockTrackingMode: "COUNT",
    totalQuantity: 3,
    rentalRatePerShift: "4000",
    occupiedQuantity: 0,
    availableQuantity: 3,
    availability: "AVAILABLE",
    comment: null,
    ...overrides,
  };
}

describe("CatalogList", () => {
  it("renders category headers and rows for all categories when activeTab='all'", () => {
    const rows: AvailabilityRow[] = [
      mkRow({ equipmentId: "a", name: "ARRI S60", category: "Свет" }),
      mkRow({ equipmentId: "b", name: "Alexa", category: "Камеры" }),
    ];
    render(
      <CatalogList
        rows={rows}
        selected={new Map()}
        offCatalogItems={[]}
        activeTab="all"
        searchQuery=""
        onAdd={vi.fn()}
        onChangeQty={vi.fn()}
        onRemove={vi.fn()}
        onChangeOffCatalogQty={vi.fn()}
        onRemoveOffCatalog={vi.fn()}
      />,
    );
    expect(screen.getByText("Свет")).toBeInTheDocument();
    expect(screen.getByText("Камеры")).toBeInTheDocument();
    expect(screen.getByText("ARRI S60")).toBeInTheDocument();
    expect(screen.getByText("Alexa")).toBeInTheDocument();
  });

  it("filters by activeTab", () => {
    const rows = [
      mkRow({ equipmentId: "a", name: "ARRI S60", category: "Свет" }),
      mkRow({ equipmentId: "b", name: "Alexa", category: "Камеры" }),
    ];
    render(
      <CatalogList
        rows={rows}
        selected={new Map()}
        offCatalogItems={[]}
        activeTab="Свет"
        searchQuery=""
        onAdd={vi.fn()}
        onChangeQty={vi.fn()}
        onRemove={vi.fn()}
        onChangeOffCatalogQty={vi.fn()}
        onRemoveOffCatalog={vi.fn()}
      />,
    );
    expect(screen.getByText("ARRI S60")).toBeInTheDocument();
    expect(screen.queryByText("Alexa")).toBeNull();
  });

  it("filters by case-insensitive search query", () => {
    const rows = [
      mkRow({ equipmentId: "a", name: "ARRI SkyPanel S60" }),
      mkRow({ equipmentId: "b", name: "Kino Flo" }),
    ];
    render(
      <CatalogList
        rows={rows}
        selected={new Map()}
        offCatalogItems={[]}
        activeTab="all"
        searchQuery="kino"
        onAdd={vi.fn()}
        onChangeQty={vi.fn()}
        onRemove={vi.fn()}
        onChangeOffCatalogQty={vi.fn()}
        onRemoveOffCatalog={vi.fn()}
      />,
    );
    expect(screen.getByText("Kino Flo")).toBeInTheDocument();
    expect(screen.queryByText("ARRI SkyPanel S60")).toBeNull();
  });

  it("shows empty state when no rows match", () => {
    render(
      <CatalogList
        rows={[mkRow({ equipmentId: "a" })]}
        selected={new Map()}
        offCatalogItems={[]}
        activeTab="all"
        searchQuery="zzzzzz"
        onAdd={vi.fn()}
        onChangeQty={vi.fn()}
        onRemove={vi.fn()}
        onChangeOffCatalogQty={vi.fn()}
        onRemoveOffCatalog={vi.fn()}
      />,
    );
    expect(screen.getByText(/ничего не найдено/i)).toBeInTheDocument();
  });

  it("renders off-catalog section when offCatalogItems present", () => {
    const off: OffCatalogItem[] = [{ tempId: "t1", name: "Генератор 6кВт", quantity: 1 }];
    render(
      <CatalogList
        rows={[mkRow({ equipmentId: "a" })]}
        selected={new Map()}
        offCatalogItems={off}
        activeTab="all"
        searchQuery=""
        onAdd={vi.fn()}
        onChangeQty={vi.fn()}
        onRemove={vi.fn()}
        onChangeOffCatalogQty={vi.fn()}
        onRemoveOffCatalog={vi.fn()}
      />,
    );
    expect(screen.getByText(/дополнительные позиции/i)).toBeInTheDocument();
    expect(screen.getByText("Генератор 6кВт")).toBeInTheDocument();
  });

  it("shows selected quantity count in category header", () => {
    const rows = [mkRow({ equipmentId: "a", name: "ARRI", category: "Свет" })];
    const selected = new Map<string, CatalogSelectedItem>();
    selected.set("a", { equipmentId: "a", name: "ARRI", category: "Свет", quantity: 2, dailyPrice: "4000", availableQuantity: 3 });
    render(
      <CatalogList
        rows={rows}
        selected={selected}
        offCatalogItems={[]}
        activeTab="all"
        searchQuery=""
        onAdd={vi.fn()}
        onChangeQty={vi.fn()}
        onRemove={vi.fn()}
        onChangeOffCatalogQty={vi.fn()}
        onRemoveOffCatalog={vi.fn()}
      />,
    );
    expect(screen.getByText(/1 выбрано/i)).toBeInTheDocument();
  });
});
