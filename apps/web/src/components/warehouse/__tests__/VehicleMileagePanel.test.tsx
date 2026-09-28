/**
 * «Пробег машин» на приёмке: ввод, проверка «не меньше текущего» и
 * восстановление значений из черновика приёмки.
 */
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const listSessionVehicles = vi.fn();
vi.mock("../api", () => ({
  scanApi: {
    listSessionVehicles: (...args: unknown[]) => listSessionVehicles(...args),
  },
}));

import { VehicleMileagePanel } from "../VehicleMileagePanel";

const vehicles = [
  { id: "bv1", vehicleId: "v1", vehicle: { id: "v1", name: "Газель", currentMileage: 120000 } },
  { id: "bv2", vehicleId: "v2", vehicle: { id: "v2", name: "Генератор", currentMileage: 900 } },
];

beforeEach(() => {
  vi.clearAllMocks();
  listSessionVehicles.mockResolvedValue(vehicles);
});

describe("VehicleMileagePanel", () => {
  it("без машин ничего не рисует и считается заполненной", async () => {
    listSessionVehicles.mockResolvedValue([]);
    const onValidityChange = vi.fn();
    const { container } = render(
      <VehicleMileagePanel
        sessionId="s1"
        attemptedSubmit={false}
        onChange={() => {}}
        onValidityChange={onValidityChange}
      />,
    );
    await waitFor(() => expect(container.textContent).toBe(""));
    expect(onValidityChange).toHaveBeenLastCalledWith(true);
  });

  it("подставляет пробег из черновика и отдаёт его родителю", async () => {
    const onChange = vi.fn();
    const onValidityChange = vi.fn();
    render(
      <VehicleMileagePanel
        sessionId="s1"
        attemptedSubmit={false}
        onChange={onChange}
        onValidityChange={onValidityChange}
        initialMileages={{ v1: 120450, v2: null }}
      />,
    );
    const gazel = (await screen.findByLabelText("Пробег для Газель")) as HTMLInputElement;
    expect(gazel.value).toBe("120450");
    expect((screen.getByLabelText("Пробег для Генератор") as HTMLInputElement).value).toBe("");
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith([{ vehicleId: "v1", mileage: 120450 }]),
    );
    expect(onValidityChange).toHaveBeenLastCalledWith(false);
  });

  it("набранное руками не перетирается, пока черновик не пришёл заново", async () => {
    const initial = { v1: 120450 };
    const { rerender } = render(
      <VehicleMileagePanel
        sessionId="s1"
        attemptedSubmit={false}
        onChange={() => {}}
        onValidityChange={() => {}}
        initialMileages={initial}
      />,
    );
    const gazel = (await screen.findByLabelText("Пробег для Газель")) as HTMLInputElement;
    fireEvent.change(gazel, { target: { value: "120600" } });
    rerender(
      <VehicleMileagePanel
        sessionId="s1"
        attemptedSubmit={false}
        onChange={() => {}}
        onValidityChange={() => {}}
        initialMileages={initial}
      />,
    );
    expect(gazel.value).toBe("120600");
  });

  it("пока список машин грузится, пустой пробег родителю не отдаётся; правкой считается только ввод руками", async () => {
    let release: (v: typeof vehicles) => void = () => {};
    listSessionVehicles.mockReturnValue(new Promise((r) => (release = r)));
    const onChange = vi.fn();
    const onEdit = vi.fn();
    render(
      <VehicleMileagePanel
        sessionId="s1"
        attemptedSubmit={false}
        onChange={onChange}
        onValidityChange={() => {}}
        initialMileages={{ v1: 120450 }}
        onEdit={onEdit}
      />,
    );
    await screen.findByText("Загрузка...");
    expect(onChange).not.toHaveBeenCalled();

    release(vehicles);
    const gazel = (await screen.findByLabelText("Пробег для Газель")) as HTMLInputElement;
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith([{ vehicleId: "v1", mileage: 120450 }]),
    );
    expect(onEdit).not.toHaveBeenCalled();

    fireEvent.change(gazel, { target: { value: "120600" } });
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it("пробег меньше текущего — ошибка строки после попытки завершить", async () => {
    render(
      <VehicleMileagePanel
        sessionId="s1"
        attemptedSubmit
        onChange={() => {}}
        onValidityChange={() => {}}
        initialMileages={{ v1: 100, v2: 950 }}
      />,
    );
    expect(await screen.findByText(/Одометр не уменьшается/)).toBeInTheDocument();
  });
});
