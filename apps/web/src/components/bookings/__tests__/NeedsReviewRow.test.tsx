import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { NeedsReviewRow } from "../create/NeedsReviewRow";
import type { GafferCandidate } from "../create/types";

const candidates: GafferCandidate[] = [
  {
    equipmentId: "eq1",
    catalogName: "Arri Skypanel S60",
    category: "Осветители",
    availableQuantity: 3,
    rentalRatePerShift: "5000",
    confidence: 0.9,
  },
  {
    equipmentId: "eq2",
    catalogName: "Arri Skypanel S30",
    category: "Осветители",
    availableQuantity: 2,
    rentalRatePerShift: "3000",
    confidence: 0.7,
  },
];

const defaultProps = {
  itemId: "item-1",
  gafferPhrase: "скайпанел большой",
  interpretedName: "Skypanel S60",
  quantity: 1,
  candidates,
  selectedEquipmentId: null,
  onSelectCandidate: vi.fn(),
  onSkip: vi.fn(),
  onQuantityChange: vi.fn(),
  onDelete: vi.fn(),
  shifts: 3,
};

describe("NeedsReviewRow", () => {
  it("renders interpreted name and gaffer phrase as alias", () => {
    render(<NeedsReviewRow {...defaultProps} />);
    expect(screen.getByText("Skypanel S60")).toBeInTheDocument();
    expect(screen.getByText(/скайпанел большой/i)).toBeInTheDocument();
  });

  it("shows uточнить when no candidate selected", () => {
    render(<NeedsReviewRow {...defaultProps} selectedEquipmentId={null} />);
    expect(screen.getByText(/уточнить/i)).toBeInTheDocument();
  });

  it("renders candidate pills in expansion row", () => {
    render(<NeedsReviewRow {...defaultProps} />);
    expect(screen.getByText("Arri Skypanel S60")).toBeInTheDocument();
    expect(screen.getByText("Arri Skypanel S30")).toBeInTheDocument();
  });

  it("calls onSelectCandidate when a pill is clicked", () => {
    const onSelect = vi.fn();
    render(<NeedsReviewRow {...defaultProps} onSelectCandidate={onSelect} />);
    fireEvent.click(screen.getByText("Arri Skypanel S60"));
    expect(onSelect).toHaveBeenCalledWith("item-1", candidates[0]);
  });

  it("calls onSkip when skip button is clicked", () => {
    const onSkip = vi.fn();
    render(<NeedsReviewRow {...defaultProps} onSkip={onSkip} />);
    fireEvent.click(screen.getByText(/пропустить/i));
    expect(onSkip).toHaveBeenCalledWith("item-1");
  });

  it("calls onDelete when delete button is clicked", () => {
    const onDelete = vi.fn();
    render(<NeedsReviewRow {...defaultProps} onDelete={onDelete} />);
    fireEvent.click(screen.getByRole("button", { name: /удалить/i }));
    expect(onDelete).toHaveBeenCalledWith("item-1");
  });

  it("calls onQuantityChange when quantity input changes", () => {
    const onQuantityChange = vi.fn();
    render(<NeedsReviewRow {...defaultProps} onQuantityChange={onQuantityChange} />);
    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "3" } });
    expect(onQuantityChange).toHaveBeenCalledWith("item-1", 3);
  });

  it("shows price and total when candidate is selected", () => {
    render(
      <NeedsReviewRow
        {...defaultProps}
        selectedEquipmentId="eq1"
        quantity={2}
        shifts={3}
      />,
    );
    // Price and total should be shown (5000 * 2 * 3 = 30000)
    const allMatches = screen.getAllByText(/5\s*000/);
    expect(allMatches.length).toBeGreaterThan(0);
    // Line total: 5000 * 2 qty * 3 shifts = 30000
    expect(screen.getByText(/30\s*000/)).toBeInTheDocument();
  });

  it("marks selected candidate pill as dark", () => {
    render(<NeedsReviewRow {...defaultProps} selectedEquipmentId="eq1" />);
    // The selected pill should have the dark ink bg class
    const selectedPill = screen.getByText("Arri Skypanel S60").closest("button");
    expect(selectedPill?.className).toMatch(/bg-ink/);
  });
});
