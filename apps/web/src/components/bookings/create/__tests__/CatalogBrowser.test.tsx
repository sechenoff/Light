import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { CatalogBrowser } from "../CatalogBrowser";
import type { AvailabilityRow, CatalogSelectedItem } from "../types";

function mkRow(overrides: Partial<AvailabilityRow>): AvailabilityRow {
  return {
    equipmentId: "eq1",
    category: "Свет",
    name: "ARRI SkyPanel S60-C",
    brand: null,
    model: null,
    stockTrackingMode: "COUNT",
    totalQuantity: 3,
    rentalRatePerShift: "4000",
    occupiedQuantity: 0,
    availableQuantity: 3,
    availability: "AVAILABLE",
    comment: null,
    ...overrides,
  };
}

const noop = { onAdd: vi.fn(), onChangeQty: vi.fn(), onRemove: vi.fn() };

describe("CatalogBrowser", () => {
  it("activeTab='all': desktop-панель показывает группировку, mobile — список категорий", () => {
    const rows = [
      mkRow({ equipmentId: "a", name: "ARRI S60", category: "Свет" }),
      mkRow({ equipmentId: "b", name: "Alexa", category: "Камеры" }),
    ];
    render(
      <CatalogBrowser
        rows={rows}
        selected={new Map()}
        activeTab="all"
        onActiveTabChange={vi.fn()}
        searchQuery=""
        {...noop}
      />,
    );
    // Названия категорий встречаются и в левой колонке, и в группах, и в mobile-списке
    expect(screen.getAllByText("Свет").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Камеры").length).toBeGreaterThanOrEqual(2);
    // Позиции отрендерены (grouped-view десктопа)
    expect(screen.getByText("ARRI S60")).toBeInTheDocument();
    expect(screen.getByText("Alexa")).toBeInTheDocument();
    expect(screen.getByText("Весь каталог")).toBeInTheDocument();
  });

  it("активная категория фильтрует правую панель", () => {
    const rows = [
      mkRow({ equipmentId: "a", name: "ARRI S60", category: "Свет" }),
      mkRow({ equipmentId: "b", name: "Alexa", category: "Камеры" }),
    ];
    render(
      <CatalogBrowser
        rows={rows}
        selected={new Map()}
        activeTab="Свет"
        onActiveTabChange={vi.fn()}
        searchQuery=""
        {...noop}
      />,
    );
    // Позиция в DOM дважды: desktop-панель + mobile drill-down (CSS-гейт jsdom не применяет)
    expect(screen.getAllByText("ARRI S60").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("Alexa")).toBeNull();
    // Mobile drill-down: есть кнопка возврата к категориям
    expect(screen.getByRole("button", { name: /← категории/i })).toBeInTheDocument();
  });

  it("клик по категории и по «← Категории» переключает activeTab", () => {
    const onActiveTabChange = vi.fn();
    const rows = [mkRow({ equipmentId: "a", category: "Свет" })];
    const { rerender } = render(
      <CatalogBrowser
        rows={rows}
        selected={new Map()}
        activeTab="all"
        onActiveTabChange={onActiveTabChange}
        searchQuery=""
        {...noop}
      />,
    );
    // В "all" категория встречается в двух списках (desktop-колонка + mobile) — кликаем первую
    fireEvent.click(screen.getAllByRole("button", { name: /Свет/ })[0]);
    expect(onActiveTabChange).toHaveBeenCalledWith("Свет");

    rerender(
      <CatalogBrowser
        rows={rows}
        selected={new Map()}
        activeTab="Свет"
        onActiveTabChange={onActiveTabChange}
        searchQuery=""
        {...noop}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /← категории/i }));
    expect(onActiveTabChange).toHaveBeenCalledWith("all");
  });

  it("поиск от 2 символов — плоский список, регистронезависимо, поверх категорий", () => {
    const rows = [
      mkRow({ equipmentId: "a", name: "ARRI SkyPanel S60", category: "Свет" }),
      mkRow({ equipmentId: "b", name: "Kino Flo", category: "Камеры" }),
    ];
    render(
      <CatalogBrowser
        rows={rows}
        selected={new Map()}
        activeTab="Свет"
        onActiveTabChange={vi.fn()}
        searchQuery="kino"
        {...noop}
      />,
    );
    // Совпадение из ДРУГОЙ категории найдено (поиск глобальный)
    expect(screen.getByText("Kino Flo")).toBeInTheDocument();
    expect(screen.queryByText("ARRI SkyPanel S60")).toBeNull();
    expect(screen.getByText(/найдено: 1/i)).toBeInTheDocument();
  });

  it("кириллический запрос находит латиницу («нова» → NOVA)", () => {
    const rows = [
      mkRow({ equipmentId: "a", name: "Aputure NOVA P600C" }),
      mkRow({ equipmentId: "b", name: "Kino Flo" }),
    ];
    render(
      <CatalogBrowser
        rows={rows}
        selected={new Map()}
        activeTab="all"
        onActiveTabChange={vi.fn()}
        searchQuery="нова"
        {...noop}
      />,
    );
    expect(screen.getByText("Aputure NOVA P600C")).toBeInTheDocument();
    expect(screen.queryByText("Kino Flo")).toBeNull();
  });

  it("пустой результат поиска — «Ничего не найдено»", () => {
    render(
      <CatalogBrowser
        rows={[mkRow({ equipmentId: "a" })]}
        selected={new Map()}
        activeTab="all"
        onActiveTabChange={vi.fn()}
        searchQuery="zzzzzz"
        {...noop}
      />,
    );
    expect(screen.getByText(/ничего не найдено/i)).toBeInTheDocument();
  });

  it("счётчик выбранного у категории (в группах — «1 выбрано»)", () => {
    const rows = [mkRow({ equipmentId: "a", name: "ARRI", category: "Свет" })];
    const selected = new Map<string, CatalogSelectedItem>();
    selected.set("a", {
      equipmentId: "a",
      name: "ARRI",
      category: "Свет",
      quantity: 2,
      dailyPrice: "4000",
      availableQuantity: 3,
    });
    render(
      <CatalogBrowser
        rows={rows}
        selected={selected}
        activeTab="all"
        onActiveTabChange={vi.fn()}
        searchQuery=""
        {...noop}
      />,
    );
    expect(screen.getByText(/1 выбрано/i)).toBeInTheDocument();
    // Бейдж в навигации категорий (desktop-колонка + mobile-список)
    expect(screen.getAllByText(/1✓/).length).toBeGreaterThanOrEqual(2);
  });
});
