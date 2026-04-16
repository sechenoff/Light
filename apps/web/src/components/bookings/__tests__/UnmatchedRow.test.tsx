import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { UnmatchedRow } from "../create/UnmatchedRow";
import type { AvailabilityRow } from "../create/types";

const mockResult: AvailabilityRow = {
  equipmentId: "eq99",
  category: "Осветители",
  name: "Litepanels Astra 1x",
  brand: "Litepanels",
  model: "Astra 1x",
  stockTrackingMode: "COUNT",
  totalQuantity: 5,
  rentalRatePerShift: "2500",
  occupiedQuantity: 1,
  availableQuantity: 4,
  availability: "AVAILABLE",
  comment: null,
};

const defaultProps = {
  itemId: "item-u1",
  gafferPhrase: "литепанель",
  quantity: 1,
  onSelectFromCatalog: vi.fn(),
  onQuantityChange: vi.fn(),
  onDelete: vi.fn(),
  searchCatalog: vi.fn().mockResolvedValue([mockResult]),
};

describe("UnmatchedRow", () => {
  it("renders gaffer phrase in quotes and 'не в каталоге' subtitle", () => {
    render(<UnmatchedRow {...defaultProps} />);
    // Gaffer phrase appears (may appear multiple times in main + footer)
    const phrases = screen.getAllByText(/литепанель/i);
    expect(phrases.length).toBeGreaterThan(0);
    expect(screen.getByText(/не в каталоге/i)).toBeInTheDocument();
  });

  it("renders dashes for price and total (no match)", () => {
    render(<UnmatchedRow {...defaultProps} />);
    // Should show dashes (at least 2)
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBeGreaterThanOrEqual(2);
  });

  it("shows search input in expansion area", () => {
    render(<UnmatchedRow {...defaultProps} />);
    expect(screen.getByPlaceholderText(/поиск/i)).toBeInTheDocument();
  });

  it("calls searchCatalog when user types in search", async () => {
    const searchCatalog = vi.fn().mockResolvedValue([]);
    render(<UnmatchedRow {...defaultProps} searchCatalog={searchCatalog} />);
    const input = screen.getByPlaceholderText(/поиск/i);
    fireEvent.change(input, { target: { value: "astra" } });
    await waitFor(() => expect(searchCatalog).toHaveBeenCalledWith("astra"), { timeout: 500 });
  });

  it("shows search results", async () => {
    const searchCatalog = vi.fn().mockResolvedValue([mockResult]);
    render(<UnmatchedRow {...defaultProps} searchCatalog={searchCatalog} />);
    const input = screen.getByPlaceholderText(/поиск/i);
    fireEvent.change(input, { target: { value: "литепанель" } });
    await waitFor(() => expect(screen.getByText("Litepanels Astra 1x")).toBeInTheDocument(), {
      timeout: 1000,
    });
  });

  it("calls onSelectFromCatalog when a result is clicked", async () => {
    const onSelect = vi.fn();
    render(<UnmatchedRow {...defaultProps} onSelectFromCatalog={onSelect} />);
    const input = screen.getByPlaceholderText(/поиск/i);
    fireEvent.change(input, { target: { value: "литепанель" } });
    await waitFor(() => screen.getByText("Litepanels Astra 1x"), { timeout: 1000 });
    fireEvent.click(screen.getByText("Litepanels Astra 1x"));
    expect(onSelect).toHaveBeenCalledWith("item-u1", mockResult, true);
  });

  it("calls onDelete when delete button is clicked", () => {
    const onDelete = vi.fn();
    render(<UnmatchedRow {...defaultProps} onDelete={onDelete} />);
    fireEvent.click(screen.getByRole("button", { name: /удалить/i }));
    expect(onDelete).toHaveBeenCalledWith("item-u1");
  });

  it("calls onQuantityChange when quantity input changes", () => {
    const onQuantityChange = vi.fn();
    render(<UnmatchedRow {...defaultProps} onQuantityChange={onQuantityChange} />);
    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "2" } });
    expect(onQuantityChange).toHaveBeenCalledWith("item-u1", 2);
  });

  it("clears search results when Escape key pressed", async () => {
    const searchCatalog = vi.fn().mockResolvedValue([mockResult]);
    render(<UnmatchedRow {...defaultProps} searchCatalog={searchCatalog} />);
    const input = screen.getByPlaceholderText(/поиск/i);
    fireEvent.change(input, { target: { value: "astra" } });
    await waitFor(() => screen.getByText("Litepanels Astra 1x"), { timeout: 1000 });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByText("Litepanels Astra 1x")).toBeNull();
  });
});
