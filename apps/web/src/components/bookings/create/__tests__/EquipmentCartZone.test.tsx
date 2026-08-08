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
  shifts: 1,
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
    const { container } = render(
      <EquipmentCartZone selected={mkSelected()} customItems={CUSTOM} {...handlers} />,
    );
    expect(screen.getByText("ARRI SkyPanel S60")).toBeInTheDocument();
    // Цена за смену × количество = сумма позиции.
    expect(container.textContent).toMatch(/4.?000/);
    expect(container.textContent).toMatch(/8.?000/);
    expect(screen.getByText("Скотч армированный")).toBeInTheDocument();
    expect(screen.getByText("своя")).toBeInTheDocument();
    expect(screen.queryByText(/пока пусто/i)).toBeNull();
  });

  it("цена позиции редактируется на месте: своя цена, пилюля «по прайсу» и возврат", () => {
    const onChangeNegotiatedRate = vi.fn();
    const { rerender } = render(
      <EquipmentCartZone
        selected={mkSelected()}
        customItems={[]}
        {...handlers}
        shifts={3}
        onChangeNegotiatedRate={onChangeNegotiatedRate}
      />,
    );
    const price = screen.getByLabelText("Цена за смену: ARRI SkyPanel S60");
    fireEvent.focus(price);
    fireEvent.change(price, { target: { value: "3000" } });
    fireEvent.blur(price);
    expect(onChangeNegotiatedRate).toHaveBeenCalledWith("a", 3000);

    // С договорной ценой рядом появляется прайсовая и кнопка возврата.
    const negotiated = mkSelected();
    negotiated.set("a", { ...negotiated.get("a")!, negotiatedRatePerShift: 3000 });
    rerender(
      <EquipmentCartZone
        selected={negotiated}
        customItems={[]}
        {...handlers}
        shifts={3}
        onChangeNegotiatedRate={onChangeNegotiatedRate}
      />,
    );
    expect(screen.getByText(/по прайсу/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Вернуть прайсовую цену: ARRI SkyPanel S60"));
    expect(onChangeNegotiatedRate).toHaveBeenLastCalledWith("a", null);
  });

  it("ввод прайсовой цены поверх договорной — это возврат к прайсу, а не новая уступка", () => {
    const onChangeNegotiatedRate = vi.fn();
    const negotiated = mkSelected();
    negotiated.set("a", { ...negotiated.get("a")!, negotiatedRatePerShift: 3000 });
    render(
      <EquipmentCartZone
        selected={negotiated}
        customItems={[]}
        {...handlers}
        shifts={1}
        onChangeNegotiatedRate={onChangeNegotiatedRate}
      />,
    );
    const price = screen.getByLabelText("Цена за смену: ARRI SkyPanel S60");
    fireEvent.focus(price);
    fireEvent.change(price, { target: { value: "4000" } });
    fireEvent.blur(price);
    expect(onChangeNegotiatedRate).toHaveBeenCalledWith("a", null);
  });

  it("клик по цене и уход без правки ничего не меняют", () => {
    // Иначе простой промах пальцем превращал прайсовую цену в «договорную»
    // и выводил позицию из-под процентной скидки.
    const onChangeNegotiatedRate = vi.fn();
    render(
      <EquipmentCartZone
        selected={mkSelected()}
        customItems={[]}
        {...handlers}
        shifts={3}
        onChangeNegotiatedRate={onChangeNegotiatedRate}
      />,
    );
    const price = screen.getByLabelText("Цена за смену: ARRI SkyPanel S60");
    fireEvent.focus(price);
    fireEvent.blur(price);
    expect(onChangeNegotiatedRate).not.toHaveBeenCalled();
  });

  it("Escape отменяет правку, а не фиксирует её", () => {
    const onChangeNegotiatedRate = vi.fn();
    render(
      <EquipmentCartZone
        selected={mkSelected()}
        customItems={[]}
        {...handlers}
        shifts={3}
        onChangeNegotiatedRate={onChangeNegotiatedRate}
      />,
    );
    const price = screen.getByLabelText("Цена за смену: ARRI SkyPanel S60");
    fireEvent.focus(price);
    fireEvent.change(price, { target: { value: "1" } });
    fireEvent.keyDown(price, { key: "Escape" });
    fireEvent.blur(price);
    expect(onChangeNegotiatedRate).not.toHaveBeenCalled();
  });

  it("возврат к прайсу и счётчик стоят в первой строке, арифметика — во второй", () => {
    // Сетка была на четыре колонки, и кнопка «убрать» сваливалась в третий
    // ряд, в 6-пиксельную колонку под точкой.
    const negotiated = mkSelected();
    negotiated.set("a", { ...negotiated.get("a")!, negotiatedRatePerShift: 3000 });
    render(
      <EquipmentCartZone
        selected={negotiated}
        customItems={[]}
        {...handlers}
        shifts={3}
        onChangeNegotiatedRate={vi.fn()}
      />,
    );
    const row = screen.getByLabelText("Убрать ARRI SkyPanel S60").parentElement!;
    expect(row.className).toContain("grid-cols-[6px_1fr_auto_auto_auto]");
    const remove = screen.getByLabelText("Убрать ARRI SkyPanel S60");
    expect(remove.className).toContain("col-start-5");
    expect(remove.className).toContain("row-start-1");
    const calc = Array.from(row.children).find((c) =>
      c.className.includes("col-start-2"),
    ) as HTMLElement;
    expect(calc.className).toContain("row-start-2");
    // Цена живёт в value инпута, сумма позиции — текстом рядом: 3 000 × 2 × 3.
    expect((screen.getByLabelText("Цена за смену: ARRI SkyPanel S60") as HTMLInputElement).value).toMatch(/3.?000/);
    expect(calc.textContent).toMatch(/18.?000/);
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

  it("строка состава считает сумму по числу смен, а не по одной", () => {
    // Цена каталога — ставка за смену. Без множителя строка врала: на
    // трёхдневной брони показывала треть настоящей суммы позиции.
    const { container } = render(
      <EquipmentCartZone selected={mkSelected()} customItems={[]} {...handlers} shifts={3} />,
    );
    // 4 000 ₽/см × 2 шт × 3 см = 24 000 ₽
    expect(container.textContent).toMatch(/24\s?000/);
    expect(container.textContent).toMatch(/× 3 см/);
  });

  it("на односменной брони множитель смен не показывается", () => {
    const { container } = render(
      <EquipmentCartZone selected={mkSelected()} customItems={[]} {...handlers} shifts={1} />,
    );
    expect(container.textContent).toMatch(/8\s?000/);
    expect(container.textContent).not.toMatch(/× 1 см/);
  });
});
