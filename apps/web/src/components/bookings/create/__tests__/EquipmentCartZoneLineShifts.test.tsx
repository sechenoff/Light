/**
 * Смены позиции в «Составе заявки» (мокап M1): поле в ячейке на компьютере,
 * чип и шторка на телефоне, сумма строки на её смены, срок возврата и
 * предупреждение о складе.
 */
import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EquipmentCartZone, computeCartTotal } from "../EquipmentCartZone";
import { formatDueBy, formatDueLong, longLinesSummary, parseShiftsInput, sanitizeLineShifts } from "../lineShifts";
import type { CatalogSelectedItem, CustomItem } from "../types";

vi.mock("../../../ToastProvider", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));

const HOUR = 3_600_000;
// Конец брони — ровный час через неделю: без зашитых календарных дат.
const END = Math.ceil((Date.now() + 7 * 24 * HOUR) / HOUR) * HOUR;

function item(over: Partial<CatalogSelectedItem> & { equipmentId: string; name: string }): CatalogSelectedItem {
  return { category: "Свет", quantity: 2, dailyPrice: "9000", availableQuantity: 5, ...over };
}

function cart(items: CatalogSelectedItem[]) {
  return new Map(items.map((i) => [i.equipmentId, i]));
}

const CUSTOM: CustomItem[] = [{ tempId: "c1", name: "Расходники: гели, скотч", unitPrice: 1500, quantity: 1 }];
const onChangeLineShifts = vi.fn();

function renderCart(items: CatalogSelectedItem[], extra: Partial<Parameters<typeof EquipmentCartZone>[0]> = {}) {
  return render(
    <EquipmentCartZone
      selected={cart(items)}
      customItems={CUSTOM}
      shifts={1}
      onChangeQty={vi.fn()}
      onRemove={vi.fn()}
      onOpenCustomModal={vi.fn()}
      onChangeLineShifts={onChangeLineShifts}
      bookingEndMs={END}
      periodLabel="пн 12 окт. 10:00 → вт 13 окт. 10:00"
      {...extra}
    />,
  );
}

/** Строка десктопной таблицы по названию позиции. */
function row(container: HTMLElement, name: string): HTMLElement {
  const rows = Array.from(container.querySelectorAll("tbody tr:not([data-cart-band])")) as HTMLElement[];
  return rows.find((r) => r.textContent?.includes(name))!;
}

beforeEach(() => {
  onChangeLineShifts.mockReset();
});

describe("ячейка «Смен» (компьютер)", () => {
  it("по умолчанию — смены брони; ввод 2 и Enter задают свои смены", () => {
    const { container } = renderCart([item({ equipmentId: "storm", name: "Aputure STORM 1200x" })]);
    const r = row(container, "STORM");
    fireEvent.click(within(r).getByRole("button", { name: /Смен: 1, как у брони/ }));
    const input = within(r).getByRole("textbox", { name: "Смен для Aputure STORM 1200x" });
    fireEvent.change(input, { target: { value: "2" } });
    expect(within(r).getByText(/^возврат /)).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input, { target: { value: "2" } });
    expect(onChangeLineShifts).toHaveBeenCalledWith("storm", 2);
  });

  it("после Enter фокус возвращается на число — место в смете не теряется", () => {
    const { container } = renderCart([item({ equipmentId: "storm", name: "Aputure STORM 1200x" })]);
    const r = row(container, "STORM");
    fireEvent.click(within(r).getByRole("button", { name: /Смен: 1/ }));
    const input = within(r).getByRole("textbox");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(document.activeElement).toBe(within(r).getByRole("button", { name: /Смен: 1/ }));
  });

  it("без дат брони срок не выдумывается", () => {
    const { container } = renderCart([item({ equipmentId: "storm", name: "Aputure STORM 1200x", shifts: 2 })], {
      bookingEndMs: null,
    });
    expect(row(container, "STORM")).not.toHaveTextContent("возврат");
  });

  it("Esc отменяет ввод, ↑ прибавляет смену", () => {
    const { container } = renderCart([item({ equipmentId: "storm", name: "Aputure STORM 1200x" })]);
    const r = row(container, "STORM");
    fireEvent.click(within(r).getByRole("button", { name: /Смен: 1/ }));
    const input = within(r).getByRole("textbox") as HTMLInputElement;
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("2");
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);
    expect(onChangeLineShifts).not.toHaveBeenCalled();
  });

  it("свои смены — индиго, срок возврата, сумма на 2 смены; ↺ возвращает к брони", () => {
    const { container } = renderCart([item({ equipmentId: "storm", name: "Aputure STORM 1200x", shifts: 2 })]);
    const r = row(container, "STORM");
    expect(within(r).getByRole("button", { name: /Смен: 2, своё значение/ })).toBeInTheDocument();
    expect(within(r).getByText(/^возврат /)).toBeInTheDocument();
    // 9 000 × 2 шт × 2 смены
    expect(r).toHaveTextContent("36 000");
    fireEvent.click(within(r).getByRole("button", { name: /Как у брони: 1 смена/ }));
    expect(onChangeLineShifts).toHaveBeenCalledWith("storm", null);
  });

  it("своя позиция — «—», без поля смен", () => {
    const { container } = renderCart([item({ equipmentId: "storm", name: "Aputure STORM 1200x" })]);
    const r = row(container, "Расходники");
    expect(within(r).queryByRole("button", { name: /Смен:/ })).not.toBeInTheDocument();
    expect(within(r).getByTitle("У своей позиции нет смен — цена за весь срок")).toHaveTextContent("—");
    expect(r).toHaveTextContent("цена за весь срок аренды");
  });

  it("сводка и плашка: «2 позиции на 2 смены», склад держит до своего срока", () => {
    renderCart([
      item({ equipmentId: "storm", name: "Aputure STORM 1200x", shifts: 2 }),
      item({ equipmentId: "evoke", name: "Nanlux Evoke 1200", quantity: 1, dailyPrice: "7000", shifts: 2 }),
      item({ equipmentId: "ls60", name: "Aputure LS 60x", quantity: 4, dailyPrice: "1200" }),
    ]);
    expect(screen.getAllByText(/1 смена · 4 позиции/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("2 позиции на 2 смены").length).toBeGreaterThan(0);
    expect(screen.getByText("2 позиции взяты на 2 смены.")).toBeInTheDocument();
    expect(screen.getByText(/Склад держит их до своего срока/)).toBeInTheDocument();
  });

  it("не хватает склада на срок строки — предупреждение, а не запрет", () => {
    const { container } = renderCart([item({ equipmentId: "storm", name: "Aputure STORM 1200x", shifts: 2 })], {
      lineShortages: new Map([["storm", { available: 1, dueDay: "ср" }]]),
    });
    expect(row(container, "STORM")).toHaveTextContent("на ср свободно 1 из 2");
  });
});

describe("чип и шторка (телефон)", () => {
  it("чип «1 см» открывает шторку; «+» задаёт 2 смены, «Готово» закрывает", () => {
    renderCart([item({ equipmentId: "storm", name: "Aputure STORM 1200x" })]);
    fireEvent.click(screen.getByRole("button", { name: /Смены позиции: 1 — Aputure STORM 1200x/ }));
    const sheet = screen.getByRole("dialog", { name: /Aputure STORM 1200x · 2 шт/ });
    expect(sheet).toHaveTextContent("Бронь: 1 смена, пн 12 окт. 10:00 → вт 13 окт. 10:00");
    fireEvent.click(within(sheet).getByRole("button", { name: "На смену больше" }));
    expect(onChangeLineShifts).toHaveBeenCalledWith("storm", 2);
    fireEvent.click(within(sheet).getByRole("button", { name: "Готово" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("быстрые значения и «как у брони»", () => {
    renderCart([item({ equipmentId: "storm", name: "Aputure STORM 1200x", shifts: 3 })]);
    fireEvent.click(screen.getByRole("button", { name: /Смены позиции: 3/ }));
    const sheet = screen.getByRole("dialog");
    expect(sheet).toHaveTextContent("9 000 × 2 шт × 3 смены");
    fireEvent.click(within(sheet).getByRole("button", { name: "5" }));
    expect(onChangeLineShifts).toHaveBeenLastCalledWith("storm", 5);
    fireEvent.click(within(sheet).getByRole("button", { name: /как у брони · 1/ }));
    expect(onChangeLineShifts).toHaveBeenLastCalledWith("storm", null);
  });
});

describe("арифметика", () => {
  it("итог состава — каждая строка на свои смены, своя позиция без смен", () => {
    const selected = cart([
      item({ equipmentId: "storm", name: "STORM", shifts: 2 }),
      item({ equipmentId: "ls60", name: "LS 60x", quantity: 4, dailyPrice: "1200" }),
    ]);
    // 9000×2×2 + 1200×4×1 + 1500
    expect(computeCartTotal(selected, CUSTOM, 1)).toBe(36_000 + 4_800 + 1_500);
    // Бронь продлили до 3 смен — строка «на 2» идёт вместе с бронью.
    expect(computeCartTotal(selected, [], 3)).toBe(9000 * 2 * 3 + 1200 * 4 * 3);
  });

  it("ввод: целые 1…60, пусто и 0 — как у брони", () => {
    expect(parseShiftsInput("3")).toBe(3);
    expect(parseShiftsInput("")).toBeNull();
    expect(parseShiftsInput("0")).toBeNull();
    expect(parseShiftsInput("99")).toBe(60);
    // Запятую не выбрасываем: «1,5» — это 1, а не 15.
    expect(parseShiftsInput("1,5")).toBe(1);
    expect(parseShiftsInput("2.5")).toBe(2);
    expect(sanitizeLineShifts("2")).toBeNull();
    expect(sanitizeLineShifts(2.5)).toBeNull();
    expect(sanitizeLineShifts(4)).toBe(4);
  });

  it("сводка по нескольким срокам", () => {
    expect(longLinesSummary([{ shifts: 2 }, { shifts: 3 }, { shifts: 2 }, { shifts: null }], 1)).toBe(
      "2 позиции на 2 смены · 1 позиция на 3 смены",
    );
    expect(longLinesSummary([{ shifts: 1 }, { shifts: null }], 1)).toBeNull();
  });
});

describe("подписи срока", () => {
  // Дата-образец для формата, не для логики времени: тест не протухает.
  it("короткий месяц без лишней точки у «мая», с точкой у сокращённых", () => {
    expect(formatDueLong(new Date(2031, 4, 15, 10, 0).getTime())).toMatch(/^[а-я]{2} 15 мая 10:00$/);
    expect(formatDueLong(new Date(2031, 9, 15, 10, 0).getTime())).toMatch(/^[а-я]{2} 15 окт\. 10:00$/);
    expect(formatDueBy(new Date(2031, 4, 15, 10, 0).getTime())).toMatch(/^[а-я]{2} 15 мая к 10:00$/);
  });
});
