import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { EquipmentCartZone } from "../EquipmentCartZone";
import type { CatalogSelectedItem, CustomItem } from "../types";

function mkSelected(): Map<string, CatalogSelectedItem> {
  const m = new Map<string, CatalogSelectedItem>();
  m.set("a", {
    equipmentId: "a",
    name: "ARRI SkyPanel S60",
    category: "Свет",
    quantity: 2,
    dailyPrice: "4000",
    availableQuantity: 3,
  });
  return m;
}

const CUSTOM: CustomItem[] = [{ tempId: "c1", name: "Скотч армированный", unitPrice: 500, quantity: 2 }];

const handlers = {
  onChangeQty: vi.fn(),
  onRemove: vi.fn(),
  onChangeCustomQty: vi.fn(),
  onRemoveCustom: vi.fn(),
  onOpenCustomModal: vi.fn(),
};

describe("EquipmentCartZone", () => {
  it("пустое состояние с подсказкой и кнопкой «+ Своя позиция»", () => {
    const onOpenCustomModal = vi.fn();
    render(
      <EquipmentCartZone
        selected={new Map()}
        customItems={[]}
        {...handlers}
        onOpenCustomModal={onOpenCustomModal}
      />,
    );
    expect(screen.getByText(/пока пусто/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /\+ своя позиция/i }));
    expect(onOpenCustomModal).toHaveBeenCalled();
  });

  it("рендерит выбранное с ценой строки и произвольные с меткой «своя»", () => {
    render(<EquipmentCartZone selected={mkSelected()} customItems={CUSTOM} {...handlers} />);
    expect(screen.getByText("ARRI SkyPanel S60")).toBeInTheDocument();
    expect(screen.getByText(/4[\s ]000,00 × 2 = 8[\s ]000,00 ₽/)).toBeInTheDocument();
    expect(screen.getByText("Скотч армированный")).toBeInTheDocument();
    expect(screen.getByText("своя")).toBeInTheDocument();
    expect(screen.queryByText(/пока пусто/i)).toBeNull();
  });

  it("степперы: − на qty=1 удаляет, + зовёт onChangeQty, + заблокирован на максимуме", () => {
    const selected = mkSelected();
    const one = selected.get("a")!;
    selected.set("a", { ...one, quantity: 1 });
    const onChangeQty = vi.fn();
    const onRemove = vi.fn();
    render(
      <EquipmentCartZone
        selected={selected}
        customItems={[]}
        {...handlers}
        onChangeQty={onChangeQty}
        onRemove={onRemove}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /уменьшить количество/i }));
    expect(onRemove).toHaveBeenCalledWith("a");
    fireEvent.click(screen.getByRole("button", { name: /увеличить количество/i }));
    expect(onChangeQty).toHaveBeenCalledWith("a", 2);
  });

  it("крестик убирает позицию из состава", () => {
    const onRemove = vi.fn();
    render(<EquipmentCartZone selected={mkSelected()} customItems={[]} {...handlers} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole("button", { name: /убрать arri skypanel s60/i }));
    expect(onRemove).toHaveBeenCalledWith("a");
  });

  it("корректировка «недоступно на новые даты» тонирует строку и прячет степпер", () => {
    const adjustments = new Map([["a", { kind: "unavailable" as const }]]);
    render(
      <EquipmentCartZone selected={mkSelected()} customItems={[]} adjustments={adjustments} {...handlers} />,
    );
    expect(screen.getByText(/недоступно на новые даты/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /увеличить количество/i })).toBeNull();
  });
});
