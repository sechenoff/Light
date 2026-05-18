import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { TransportCard } from "../TransportCard";
import type { VehicleRow, TransportBreakdown, SelectedVehicle } from "../types";

const ford: VehicleRow = {
  id: "ford-id",
  slug: "ford",
  name: "Ford",
  shiftPriceRub: "20000.00",
  hasGeneratorOption: false,
  generatorPriceRub: null,
  shiftHours: 12,
  overtimePercent: "10.00",
  displayOrder: 1,
};

const iveco: VehicleRow = {
  id: "iveco-id",
  slug: "iveco",
  name: "Ивеко",
  shiftPriceRub: "24000.00",
  hasGeneratorOption: true,
  generatorPriceRub: "25000.00",
  shiftHours: 12,
  overtimePercent: "10.00",
  displayOrder: 3,
};

const vehicles = [ford, iveco];

function sel(vehicleId: string, over: Partial<SelectedVehicle> = {}): SelectedVehicle {
  return {
    vehicleId,
    withGenerator: false,
    shiftHours: 12,
    skipOvertime: false,
    kmOutsideMkad: 0,
    ttkEntry: false,
    ...over,
  };
}

const baseProps = {
  vehicles,
  selected: [] as SelectedVehicle[],
  onToggleVehicle: vi.fn(),
  onPatchVehicle: vi.fn(),
  breakdownByVehicleId: {} as Record<string, TransportBreakdown>,
};

describe("TransportCard (multi-vehicle)", () => {
  it("renders a checkbox per vehicle + «Без транспорта» hint", () => {
    render(<TransportCard {...baseProps} />);

    expect(screen.getByText(/Без транспорта/)).toBeInTheDocument();
    expect(screen.getByText("Ford")).toBeInTheDocument();
    expect(screen.getByText("Ивеко")).toBeInTheDocument();
    // All checkboxes unchecked when nothing selected
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes.every((c) => !(c as HTMLInputElement).checked)).toBe(true);
  });

  it("clicking a vehicle checkbox calls onToggleVehicle(id, true)", () => {
    const onToggleVehicle = vi.fn();
    render(<TransportCard {...baseProps} onToggleVehicle={onToggleVehicle} />);

    fireEvent.click(screen.getByLabelText("Выбрать машину Ford"));
    expect(onToggleVehicle).toHaveBeenCalledWith("ford-id", true);
  });

  it("generator checkbox appears only for selected vehicle with hasGeneratorOption", () => {
    // Ford selected — no generator option
    const { rerender } = render(
      <TransportCard {...baseProps} selected={[sel("ford-id")]} />,
    );
    expect(screen.queryByText(/\+ Генератор/)).toBeNull();

    // Ивеко selected — generator option visible
    rerender(<TransportCard {...baseProps} selected={[sel("iveco-id")]} />);
    expect(screen.getByText(/\+ Генератор/)).toBeInTheDocument();
  });

  it("renders param cards for multiple selected vehicles + total", () => {
    const breakdownByVehicleId: Record<string, TransportBreakdown> = {
      "ford-id": {
        vehicleId: "ford-id",
        vehicleName: "Ford",
        shiftRate: "20000.00",
        overtime: "0.00",
        overtimeHours: 0,
        km: "0.00",
        ttk: "0.00",
        total: "20000.00",
      },
      "iveco-id": {
        vehicleId: "iveco-id",
        vehicleName: "Ивеко",
        shiftRate: "24000.00",
        overtime: "0.00",
        overtimeHours: 0,
        km: "0.00",
        ttk: "0.00",
        total: "24000.00",
      },
    };
    render(
      <TransportCard
        {...baseProps}
        selected={[sel("ford-id"), sel("iveco-id")]}
        breakdownByVehicleId={breakdownByVehicleId}
      />,
    );

    expect(screen.getByText("Итого Ford")).toBeInTheDocument();
    expect(screen.getByText("Итого Ивеко")).toBeInTheDocument();
    // Total row across all selected
    expect(screen.getByText(/Итого транспорт \(2\)/)).toBeInTheDocument();
  });

  it("patching shiftHours calls onPatchVehicle with the field", () => {
    const onPatchVehicle = vi.fn();
    render(
      <TransportCard
        {...baseProps}
        selected={[sel("ford-id")]}
        onPatchVehicle={onPatchVehicle}
      />,
    );

    fireEvent.change(screen.getByLabelText("Часы смены для Ford"), {
      target: { value: "14" },
    });
    expect(onPatchVehicle).toHaveBeenCalledWith("ford-id", { shiftHours: 14 });
  });
});
