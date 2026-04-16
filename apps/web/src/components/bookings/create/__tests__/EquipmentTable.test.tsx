import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { EquipmentTable } from "../EquipmentTable";
import type { EquipmentTableItem, GafferCandidate, AvailabilityRow } from "../types";

const candidatesForNeedsReview: GafferCandidate[] = [
  {
    equipmentId: "eq1",
    catalogName: "Arri Skypanel S60",
    category: "Осветители",
    availableQuantity: 3,
    rentalRatePerShift: "5000",
    confidence: 0.9,
  },
];

const resolvedItem: EquipmentTableItem = {
  id: "item-resolved",
  gafferPhrase: "скайпанел большой",
  interpretedName: "Skypanel S60",
  quantity: 2,
  match: {
    kind: "resolved",
    equipmentId: "eq1",
    catalogName: "Arri Skypanel S60",
    category: "Осветители",
    availableQuantity: 3,
    rentalRatePerShift: "5000",
    confidence: 0.9,
  },
  unitPrice: "5000",
  lineTotal: "30000",
};

const needsReviewItem: EquipmentTableItem = {
  id: "item-review",
  gafferPhrase: "скайпанел маленький",
  interpretedName: "Skypanel S30",
  quantity: 1,
  match: { kind: "needsReview", candidates: candidatesForNeedsReview },
  unitPrice: null,
  lineTotal: null,
};

const unmatchedItem: EquipmentTableItem = {
  id: "item-unmatched",
  gafferPhrase: "непонятная штука",
  interpretedName: "непонятная штука",
  quantity: 1,
  match: { kind: "unmatched" },
  unitPrice: null,
  lineTotal: null,
};

const defaultProps = {
  items: [],
  shifts: 3,
  onQuantityChange: vi.fn(),
  onDelete: vi.fn(),
  onSelectCandidate: vi.fn(),
  onSkipItem: vi.fn(),
  onSelectFromCatalog: vi.fn(),
  searchCatalog: vi.fn(async (_q: string): Promise<AvailabilityRow[]> => []),
};

describe("EquipmentTable", () => {
  it("shows empty state when items array is empty", () => {
    render(<EquipmentTable {...defaultProps} />);
    expect(screen.getByText(/нет позиций/i)).toBeInTheDocument();
  });

  it("renders table header when items exist", () => {
    render(<EquipmentTable {...defaultProps} items={[resolvedItem]} />);
    expect(screen.getByText(/позиция/i)).toBeInTheDocument();
    expect(screen.getByText(/кол-во/i)).toBeInTheDocument();
  });

  it("shows pluralized day label in header for shifts=3", () => {
    render(<EquipmentTable {...defaultProps} items={[resolvedItem]} shifts={3} />);
    expect(screen.getByText(/3\s*дня/i)).toBeInTheDocument();
  });

  it("shows pluralized day label in header for shifts=1", () => {
    render(<EquipmentTable {...defaultProps} items={[resolvedItem]} shifts={1} />);
    expect(screen.getByText(/1\s*день/i)).toBeInTheDocument();
  });

  it("shows pluralized day label in header for shifts=5", () => {
    render(<EquipmentTable {...defaultProps} items={[resolvedItem]} shifts={5} />);
    expect(screen.getByText(/5\s*дней/i)).toBeInTheDocument();
  });

  it("renders resolved item with catalog name and alias subtitle", () => {
    render(<EquipmentTable {...defaultProps} items={[resolvedItem]} />);
    expect(screen.getByText("Arri Skypanel S60")).toBeInTheDocument();
    expect(screen.getByText(/скайпанел большой/i)).toBeInTheDocument();
  });

  it("renders resolved item price and total", () => {
    render(<EquipmentTable {...defaultProps} items={[resolvedItem]} shifts={3} />);
    // price: 5000, total: 5000 * 2 * 3 = 30000
    const prices = screen.getAllByText(/5\s*000/);
    expect(prices.length).toBeGreaterThan(0);
    expect(screen.getByText(/30\s*000/)).toBeInTheDocument();
  });

  it("calls onQuantityChange for resolved item", () => {
    const onQuantityChange = vi.fn();
    render(
      <EquipmentTable {...defaultProps} items={[resolvedItem]} onQuantityChange={onQuantityChange} />,
    );
    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "5" } });
    expect(onQuantityChange).toHaveBeenCalledWith("item-resolved", 5);
  });

  it("calls onDelete for resolved item when delete button is clicked", () => {
    const onDelete = vi.fn();
    render(<EquipmentTable {...defaultProps} items={[resolvedItem]} onDelete={onDelete} />);
    fireEvent.click(screen.getByRole("button", { name: /удалить/i }));
    expect(onDelete).toHaveBeenCalledWith("item-resolved");
  });

  it("delegates needsReview items to NeedsReviewRow", () => {
    render(<EquipmentTable {...defaultProps} items={[needsReviewItem]} />);
    // NeedsReviewRow shows "Какой именно?" expansion
    expect(screen.getByText(/какой именно/i)).toBeInTheDocument();
  });

  it("delegates unmatched items to UnmatchedRow", () => {
    render(<EquipmentTable {...defaultProps} items={[unmatchedItem]} />);
    // UnmatchedRow shows "не в каталоге"
    expect(screen.getByText(/не в каталоге/i)).toBeInTheDocument();
  });

  it("renders multiple items of different kinds", () => {
    render(
      <EquipmentTable
        {...defaultProps}
        items={[resolvedItem, needsReviewItem, unmatchedItem]}
      />,
    );
    // "Arri Skypanel S60" appears in both resolved row and needsReview candidate pill
    const skypanelElements = screen.getAllByText("Arri Skypanel S60");
    expect(skypanelElements.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/какой именно/i)).toBeInTheDocument();
    expect(screen.getByText(/не в каталоге/i)).toBeInTheDocument();
  });
});
