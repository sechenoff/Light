import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { TransportCard } from "../TransportCard";
import type { VehicleRow, TransportBreakdown } from "../types";

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

const noopVehicle = vi.fn();
const noopGenerator = vi.fn();
const noopHours = vi.fn();
const noopOvertime = vi.fn();
const noopKm = vi.fn();
const noopTtk = vi.fn();

const defaultProps = {
  vehicles,
  selectedVehicleId: null,
  onChangeVehicle: noopVehicle,
  withGenerator: false,
  onChangeGenerator: noopGenerator,
  shiftHours: 12,
  onChangeShiftHours: noopHours,
  skipOvertime: false,
  onChangeSkipOvertime: noopOvertime,
  kmOutsideMkad: 0,
  onChangeKm: noopKm,
  ttkEntry: false,
  onChangeTtk: noopTtk,
  breakdown: null,
};

describe("TransportCard", () => {
  it("renders radio кнопки для каждой машины и «Без транспорта»", () => {
    render(<TransportCard {...defaultProps} />);

    expect(screen.getByText("Без транспорта")).toBeInTheDocument();
    expect(screen.getByText("Ford")).toBeInTheDocument();
    expect(screen.getByText("Ивеко")).toBeInTheDocument();
  });

  it("«Без транспорта» выбрано по умолчанию (selectedVehicleId=null)", () => {
    render(<TransportCard {...defaultProps} />);

    const noTransportRadio = screen.getAllByRole("radio")[0];
    expect(noTransportRadio).toBeChecked();
  });

  it("клик на Ford — вызывает onChangeVehicle с id Ford", () => {
    const onChangeVehicle = vi.fn();
    render(<TransportCard {...defaultProps} onChangeVehicle={onChangeVehicle} />);

    const fordLabel = screen.getByText("Ford").closest("label")!;
    const fordRadio = fordLabel.querySelector("input[type='radio']")!;
    fireEvent.click(fordRadio);

    expect(onChangeVehicle).toHaveBeenCalledWith("ford-id");
  });

  it("чекбокс + генератор показывается только для Ивеко (не Ford)", () => {
    // Ford selected — no generator checkbox
    const { rerender } = render(
      <TransportCard {...defaultProps} selectedVehicleId="ford-id" />,
    );
    expect(screen.queryByText(/генератор/i)).toBeNull();

    // Ивеко selected — generator checkbox appears
    rerender(<TransportCard {...defaultProps} selectedVehicleId="iveco-id" />);
    expect(screen.getByText(/генератор/i)).toBeInTheDocument();
  });

  it("чекбокс «Без переработки» зануляет OT в breakdown", () => {
    const breakdown: TransportBreakdown = {
      vehicleId: "ford-id",
      vehicleName: "Ford",
      shiftRate: "20000.00",
      overtime: "4000.00",
      overtimeHours: 2,
      km: "0.00",
      ttk: "0.00",
      total: "24000.00",
    };

    // Without skipOvertime: overtime row visible
    const { rerender } = render(
      <TransportCard
        {...defaultProps}
        selectedVehicleId="ford-id"
        shiftHours={14}
        breakdown={breakdown}
      />,
    );
    expect(screen.getByText(/переработка/i)).toBeInTheDocument();

    // With skipOvertime + no overtime in breakdown: row hidden
    const zeroBreakdown: TransportBreakdown = {
      ...breakdown,
      overtime: "0.00",
      overtimeHours: 0,
      total: "20000.00",
    };
    rerender(
      <TransportCard
        {...defaultProps}
        selectedVehicleId="ford-id"
        shiftHours={14}
        skipOvertime={true}
        breakdown={zeroBreakdown}
      />,
    );
    expect(screen.queryByText(/переработка/i)).toBeNull();
  });
});
