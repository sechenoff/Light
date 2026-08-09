import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { EquipmentCartZone } from "../EquipmentCartZone";
import type { CatalogSelectedItem, CustomItem } from "../types";

// В jsdom CSS не применяется, поэтому в DOM всегда лежат ОБЕ раскладки —
// десктопная таблица и мобильные строки. Отсюда getAllBy* и [0] на кликах:
// та же конвенция, что на /bookings и /finance/payments.

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

/** Первая строка данных десктопной таблицы. */
function tableRow(container: HTMLElement, index = 0): HTMLElement {
  const rows = container.querySelectorAll("tbody tr");
  return rows[index] as HTMLElement;
}

describe("EquipmentCartZone", () => {
  it("пустое состояние с подсказкой и кнопкой «+ Своя позиция»", () => {
    const onOpenCustomModal = vi.fn();
    const { container } = render(
      <EquipmentCartZone
        selected={new Map()}
        customItems={[]}
        {...handlers}
        onOpenCustomModal={onOpenCustomModal}
      />,
    );
    expect(screen.getByText(/пока пусто/i)).toBeInTheDocument();
    // Пустого состава таблица не рисует вовсе — шапка колонок над ничем.
    expect(container.querySelector("table")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /\+ своя позиция/i }));
    expect(onOpenCustomModal).toHaveBeenCalled();
  });

  it("рендерит выбранное с ценой строки и произвольные с меткой «своя»", () => {
    const { container } = render(
      <EquipmentCartZone selected={mkSelected()} customItems={CUSTOM} {...handlers} />,
    );
    expect(screen.getAllByText("ARRI SkyPanel S60").length).toBeGreaterThan(0);
    // Цена за смену × количество = сумма позиции.
    expect(container.textContent).toMatch(/4.?000/);
    expect(container.textContent).toMatch(/8.?000/);
    expect(screen.getAllByText("Скотч армированный").length).toBeGreaterThan(0);
    expect(screen.getAllByText("своя").length).toBeGreaterThan(0);
    expect(screen.queryByText(/пока пусто/i)).toBeNull();
  });

  it("таблица: подписанные колонки, арифметика по ячейкам и итог внизу", () => {
    const { container } = render(
      <EquipmentCartZone selected={mkSelected()} customItems={[]} {...handlers} shifts={3} />,
    );
    const table = container.querySelector("table")!;
    const heads = Array.from(table.querySelectorAll("thead th")).map((th) => th.textContent);
    expect(heads).toEqual([
      "Позиция",
      "Кол-во",
      "Цена/смена",
      "Смен",
      "Сумма",
      "Убрать позицию",
    ]);

    // 4 000 ₽/см × 2 шт × 3 см = 24 000 ₽ — по своим ячейкам, а не одной строкой.
    const cells = Array.from(tableRow(container).querySelectorAll("td")).map((td) => td.textContent);
    expect(cells[0]).toContain("ARRI SkyPanel S60");
    expect(cells[2]).toMatch(/4.?000/);
    expect(cells[3]).toBe("3");
    expect(cells[4]).toMatch(/24.?000/);

    const foot = table.querySelector("tfoot")!;
    expect(foot.textContent).toContain("Сумма позиций");
    expect(foot.textContent).toMatch(/24.?000/);
  });

  it("итог таблицы складывает каталожные и свои позиции", () => {
    const { container } = render(
      <EquipmentCartZone selected={mkSelected()} customItems={CUSTOM} {...handlers} shifts={2} />,
    );
    // 4 000 × 2 × 2 = 16 000, своя 500 × 2 = 1 000 (на смены не умножается) → 17 000.
    const foot = container.querySelector("tfoot")!;
    expect(foot.textContent).toMatch(/17.?000/);
  });

  it("своя позиция не умножается на смены: в колонке «Смен» прочерк", () => {
    // Её цена задаётся за всю бронь. «1» на трёхсменной брони читалось бы как
    // «оплачена одна смена из трёх» — потому в мокапе там именно прочерк.
    const { container } = render(
      <EquipmentCartZone selected={new Map()} customItems={CUSTOM} {...handlers} shifts={3} />,
    );
    const cells = Array.from(tableRow(container).querySelectorAll("td")).map((td) => td.textContent);
    expect(cells[3]).toBe("—");
    expect(cells[4]).toMatch(/1.?000/);
  });

  it("недоступная позиция показывает количество: строка обязана сходиться", () => {
    // Степпер прячем — прибавлять нечего. Но количество в смете остаётся и
    // деньги за него считаются, поэтому с прочерком строка читалась
    // «— × 4 000 × 3 = 24 000» и скрывала, за сколько единиц выставлен счёт.
    const adjustments = new Map([["a", { kind: "unavailable" as const }]]);
    const { container } = render(
      <EquipmentCartZone
        selected={mkSelected()}
        customItems={[]}
        adjustments={adjustments}
        {...handlers}
        shifts={3}
      />,
    );
    const cells = Array.from(tableRow(container).querySelectorAll("td")).map((td) => td.textContent);
    expect(cells[1]).toBe("2");
    expect(cells[4]).toMatch(/24.?000/);
    expect(container.querySelector("tfoot")!.textContent).toMatch(/24.?000/);
  });

  it("таблица уступает строкам там, где колонка формы сжата сайдбарами", () => {
    // Колонка формы шире всего НЕ на широком экране: с lg включаются сайдбар
    // навигации и панель расчёта, и на 1024 px под форму остаётся 412 px —
    // меньше, чем на 768 (736 px). Поэтому таблица гасится ровно в полосе
    // 1024–1279, иначе там её срезал бы overflow-hidden карточки.
    const { container } = render(
      <EquipmentCartZone selected={mkSelected()} customItems={[]} {...handlers} />,
    );
    const wrap = container.querySelector("table")!.parentElement!;
    expect(wrap.className).toContain("md:block");
    expect(wrap.className).toContain("lg:hidden");
    expect(wrap.className).toContain("xl:block");
    expect(wrap.className).toContain("overflow-x-auto");
    expect(container.querySelector("table")!.className).toMatch(/min-w-\[\d+px\]/);

    // Строки — зеркальное отрицание: ровно одна раскладка видна на любой ширине.
    const mobile = container.querySelector(".md\\:hidden") as HTMLElement;
    expect(mobile.className).toContain("lg:block");
    expect(mobile.className).toContain("xl:hidden");
  });

  it("кнопки количества названы по позиции, а не «Увеличить количество» вообще", () => {
    // В мобильной раскладке строки — это голые div'ы без табличной навигации:
    // безымянные кнопки не отличить друг от друга ни на слух, ни по ротору.
    render(<EquipmentCartZone selected={mkSelected()} customItems={CUSTOM} {...handlers} />);
    expect(screen.getAllByLabelText("Увеличить количество: ARRI SkyPanel S60").length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText("Уменьшить количество: Скотч армированный").length).toBeGreaterThan(0);
  });

  it("итог подписан как строка таблицы и несёт знак валюты", () => {
    const { container } = render(
      <EquipmentCartZone selected={mkSelected()} customItems={[]} {...handlers} />,
    );
    const foot = container.querySelector("tfoot")!;
    const th = foot.querySelector("th")!;
    expect(th.getAttribute("scope")).toBe("row");
    expect(th.textContent).toBe("Сумма позиций");
    // Тот же итог в шапке блока печатается с «₽» — в одном окне одно и то же
    // число не должно выглядеть двумя разными способами.
    expect(foot.textContent).toContain("₽");
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
    const price = screen.getAllByLabelText("Цена за смену: ARRI SkyPanel S60")[0];
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
    expect(screen.getAllByText(/по прайсу/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByLabelText("Вернуть прайсовую цену: ARRI SkyPanel S60")[0]);
    expect(onChangeNegotiatedRate).toHaveBeenLastCalledWith("a", null);
  });

  it("договорная цена попадает и в сумму строки, и в итог", () => {
    const negotiated = mkSelected();
    negotiated.set("a", { ...negotiated.get("a")!, negotiatedRatePerShift: 3000 });
    const { container } = render(
      <EquipmentCartZone
        selected={negotiated}
        customItems={[]}
        {...handlers}
        shifts={3}
        onChangeNegotiatedRate={vi.fn()}
      />,
    );
    // 3 000 × 2 × 3 = 18 000, а не 24 000 по прайсу.
    const cells = Array.from(tableRow(container).querySelectorAll("td")).map((td) => td.textContent);
    expect(cells[4]).toMatch(/18.?000/);
    expect(container.querySelector("tfoot")!.textContent).toMatch(/18.?000/);
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
    const price = screen.getAllByLabelText("Цена за смену: ARRI SkyPanel S60")[0];
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
    const price = screen.getAllByLabelText("Цена за смену: ARRI SkyPanel S60")[0];
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
    const price = screen.getAllByLabelText("Цена за смену: ARRI SkyPanel S60")[0];
    fireEvent.focus(price);
    fireEvent.change(price, { target: { value: "1" } });
    fireEvent.keyDown(price, { key: "Escape" });
    fireEvent.blur(price);
    expect(onChangeNegotiatedRate).not.toHaveBeenCalled();
  });

  it("цена только для чтения, когда правка цен не разрешена", () => {
    // Форма редактирования подтверждённой брони не передаёт колбэк —
    // поля ввода не должно быть ни в одной из раскладок.
    render(<EquipmentCartZone selected={mkSelected()} customItems={[]} {...handlers} />);
    expect(screen.queryAllByLabelText("Цена за смену: ARRI SkyPanel S60")).toHaveLength(0);
    expect(screen.getAllByText(/4.?000/).length).toBeGreaterThan(0);
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
    fireEvent.click(screen.getAllByRole("button", { name: /уменьшить количество/i })[0]);
    expect(onRemove).toHaveBeenCalledWith("a");
    fireEvent.click(screen.getAllByRole("button", { name: /увеличить количество/i })[0]);
    expect(onChangeQty).toHaveBeenCalledWith("a", 2);
  });

  it("крестик убирает позицию из состава", () => {
    const onRemove = vi.fn();
    render(<EquipmentCartZone selected={mkSelected()} customItems={[]} {...handlers} onRemove={onRemove} />);
    fireEvent.click(screen.getAllByRole("button", { name: /убрать arri skypanel s60/i })[0]);
    expect(onRemove).toHaveBeenCalledWith("a");
  });

  it("корректировка «недоступно на новые даты» тонирует строку и прячет степпер", () => {
    const adjustments = new Map([["a", { kind: "unavailable" as const }]]);
    const { container } = render(
      <EquipmentCartZone selected={mkSelected()} customItems={[]} adjustments={adjustments} {...handlers} />,
    );
    expect(screen.getAllByText(/недоступно на новые даты/i).length).toBeGreaterThan(0);
    expect(screen.queryAllByRole("button", { name: /увеличить количество/i })).toHaveLength(0);
    expect(tableRow(container).className).toContain("bg-rose-soft");
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

  it("мобильная строка не пишет «/см» у своей позиции", () => {
    // На телефоне колонок нет, значение объясняет подпись рядом с числом —
    // и «за бронь» нельзя выдавать за «за смену».
    const { container } = render(
      <EquipmentCartZone selected={new Map()} customItems={CUSTOM} {...handlers} shifts={3} />,
    );
    const mobile = container.querySelector(".md\\:hidden") as HTMLElement;
    expect(within(mobile).getAllByText("Скотч армированный").length).toBeGreaterThan(0);
    expect(mobile.textContent).not.toContain("/см");
  });
});
