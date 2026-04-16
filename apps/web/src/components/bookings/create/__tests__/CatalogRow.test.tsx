import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { CatalogRow } from "../CatalogRow";
import type { AvailabilityRow } from "../types";

const row: AvailabilityRow = {
  equipmentId: "eq1",
  category: "Свет",
  name: "ARRI SkyPanel S60-C",
  brand: "ARRI",
  model: "S60-C",
  stockTrackingMode: "COUNT",
  totalQuantity: 3,
  rentalRatePerShift: "4000",
  occupiedQuantity: 0,
  availableQuantity: 3,
  availability: "AVAILABLE",
  comment: null,
};

describe("CatalogRow", () => {
  it("renders default state with '+ Добавить' button", () => {
    render(
      <CatalogRow row={row} selectedQty={0} onAdd={vi.fn()} onChangeQty={vi.fn()} onRemove={vi.fn()} />,
    );
    expect(screen.getByText("ARRI SkyPanel S60-C")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /добавить/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^−$|^-$/ })).toBeNull();
  });

  it("calls onAdd when '+ Добавить' is clicked", () => {
    const onAdd = vi.fn();
    render(<CatalogRow row={row} selectedQty={0} onAdd={onAdd} onChangeQty={vi.fn()} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /добавить/i }));
    expect(onAdd).toHaveBeenCalledWith(row);
  });

  it("renders stepper when selected (qty > 0)", () => {
    render(<CatalogRow row={row} selectedQty={2} onAdd={vi.fn()} onChangeQty={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /уменьшить/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /увеличить/i })).toBeInTheDocument();
  });

  it("plus button disabled when selectedQty === availableQuantity", () => {
    render(<CatalogRow row={row} selectedQty={3} onAdd={vi.fn()} onChangeQty={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByRole("button", { name: /увеличить/i })).toBeDisabled();
  });

  it("minus button calls onChangeQty with qty-1; onRemove when qty goes to 0", () => {
    const onChangeQty = vi.fn();
    const onRemove = vi.fn();
    const { rerender } = render(
      <CatalogRow row={row} selectedQty={2} onAdd={vi.fn()} onChangeQty={onChangeQty} onRemove={onRemove} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /уменьшить/i }));
    expect(onChangeQty).toHaveBeenCalledWith("eq1", 1);
    expect(onRemove).not.toHaveBeenCalled();

    rerender(<CatalogRow row={row} selectedQty={1} onAdd={vi.fn()} onChangeQty={onChangeQty} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole("button", { name: /уменьшить/i }));
    expect(onRemove).toHaveBeenCalledWith("eq1");
  });

  it("dims row and hides actions when availableQuantity === 0 and not selected", () => {
    const unavail = { ...row, availableQuantity: 0, availability: "UNAVAILABLE" as const };
    render(<CatalogRow row={unavail} selectedQty={0} onAdd={vi.fn()} onChangeQty={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText(/нет в наличии/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /добавить/i })).toBeNull();
  });

  it("shows amber adjustment badge when adjustment.kind === 'clampedDown'", () => {
    render(
      <CatalogRow
        row={row}
        selectedQty={2}
        adjustment={{ kind: "clampedDown", previousQty: 4, newQty: 2 }}
        onAdd={vi.fn()}
        onChangeQty={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByText(/скорректировано/i)).toBeInTheDocument();
  });
});
