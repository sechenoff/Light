import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { BookingItemsTable } from "../BookingItemsTable";

const NOOP = {
  retroEditMode: false,
  retroItems: undefined,
  onOpenPicker: vi.fn(),
  onUpdateQty: vi.fn(),
  onToggleDeleted: vi.fn(),
};

const BOOKING = {
  items: [
    { id: "i1", equipmentId: "eq-main", quantity: 4, equipment: { id: "eq-main", name: "Aputure 600d", category: "Свет" } },
    { id: "i2", equipmentId: "eq-addon", quantity: 2, equipment: { id: "eq-addon", name: "ARRI SkyPanel S60", category: "Свет" } },
  ],
  estimate: {
    lines: [{ equipmentId: "eq-main", nameSnapshot: "Aputure 600d", unitPrice: "9000", lineSum: "9000" }],
  },
  addonEstimate: {
    lines: [
      // Частичный добор: 1 из 4 Aputure добран позже.
      { equipmentId: "eq-main", quantity: 3, unitPrice: "9000", lineSum: "27000" },
      // Позиция целиком добор — в MAIN её нет.
      { equipmentId: "eq-addon", quantity: 2, unitPrice: "27000", lineSum: "54000" },
    ],
  },
};

describe("BookingItemsTable — доборы", () => {
  // jsdom не применяет md:hidden — таблица и мобильный список рендерятся оба,
  // поэтому проверки ограничены своим контейнером.
  it("shows the «добор ×N» chip and MAIN + addon line sums", () => {
    render(<BookingItemsTable booking={BOOKING} {...NOOP} />);
    const table = within(screen.getByRole("table"));
    expect(table.getByText("· добор ×3")).toBeInTheDocument();
    expect(table.getByText("· добор ×2")).toBeInTheDocument();
    // Aputure: MAIN 9 000 + добор 27 000 = 36 000; цена за единицу — из MAIN.
    expect(table.getByText("36 000,00")).toBeInTheDocument();
    // SkyPanel: цен в MAIN нет — берутся из доп-сметы.
    expect(table.getByText("54 000,00")).toBeInTheDocument();
    expect(table.getByText("27 000,00")).toBeInTheDocument();
  });

  it("renders no chip when there is no addon estimate", () => {
    render(<BookingItemsTable booking={{ ...BOOKING, addonEstimate: null }} {...NOOP} />);
    expect(screen.queryByText(/добор ×/)).toBeNull();
    // Без доп-сметы позиция без строки MAIN остаётся без цены.
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("mobile list shows quantity × price and the same line sums", () => {
    render(<BookingItemsTable booking={BOOKING} {...NOOP} />);
    const list = within(screen.getByRole("list"));
    expect(list.getAllByRole("listitem")).toHaveLength(2);
    expect(list.getByText("4 × 9 000,00")).toBeInTheDocument();
    expect(list.getByText("36 000,00")).toBeInTheDocument();
    expect(list.getByText("добор ×2")).toBeInTheDocument();
  });

  it("empty booking shows a plain note instead of an empty table", () => {
    render(<BookingItemsTable booking={{ items: [], estimate: null, addonEstimate: null }} {...NOOP} />);
    expect(screen.getByText("Нет позиций")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

// Позиции из двух категорий в «серверном» порядке + произвольная позиция в конце.
const MIXED = {
  items: [
    { id: "b", equipmentId: "e-b", quantity: 2, equipment: { id: "e-b", name: "C-Stand", category: "Грип" } },
    { id: "a", equipmentId: "e-a", quantity: 1, equipment: { id: "e-a", name: "Aputure 600d", category: "Свет" } },
    { id: "c", equipmentId: "e-c", quantity: 3, equipment: { id: "e-c", name: "SkyPanel S60", category: "Свет" } },
    { id: "d", equipmentId: null, quantity: 1, customName: "Своя позиция", customCategory: null, equipment: null },
  ],
  estimate: null,
  addonEstimate: null,
};

/** Группы таблицы: [полоса, ...строки] для каждого <tbody> (шапку пропускаем). */
function tableGroups() {
  const table = screen.getByRole("table");
  return within(table)
    .getAllByRole("rowgroup")
    .filter((g) => g.tagName === "TBODY")
    .map((g) => within(g).getAllByRole("row").map((r) => r.textContent ?? ""));
}

describe("BookingItemsTable — группы по категориям", () => {
  it("desktop: rows go under category bands in arrival order, no «Категория» column", () => {
    render(<BookingItemsTable booking={MIXED} {...NOOP} />);
    const groups = tableGroups();
    expect(groups.map((g) => g[0])).toEqual(["Грип", "Свет", "Без категории"]);
    expect(groups[0].slice(1).join("|")).toMatch(/C-Stand/);
    expect(groups[1]).toHaveLength(3);
    expect(groups[1][1]).toMatch(/Aputure 600d/);
    expect(groups[1][2]).toMatch(/SkyPanel S60/);
    expect(groups[2][1]).toMatch(/Своя позиция/);
    const table = within(screen.getByRole("table"));
    expect(table.queryByRole("columnheader", { name: "Категория" })).toBeNull();
    expect(table.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Наименование", "Кол-во"]);
  });

  it("mobile: one list per category with the band right before it, no category caption per row", () => {
    render(<BookingItemsTable booking={MIXED} {...NOOP} />);
    const lists = screen.getAllByRole("list");
    expect(lists.map((l) => l.previousElementSibling?.textContent)).toEqual(["Грип", "Свет", "Без категории"]);
    expect(within(lists[1]).getAllByRole("listitem").map((li) => li.querySelector("p")?.textContent)).toEqual([
      "Aputure 600d",
      "SkyPanel S60",
    ]);
    expect(within(lists[1]).queryByText("Свет")).toBeNull();
  });

  it("retro edit: an added row joins its category group and keeps its highlight", () => {
    const retroItems = [
      { id: "b", equipmentId: "e-b", quantity: 2, originalQuantity: 2, equipment: { id: "e-b", name: "C-Stand", category: "Грип" } },
      { id: "a", equipmentId: "e-a", quantity: 1, originalQuantity: 1, equipment: { id: "e-a", name: "Aputure 600d", category: "Свет" } },
      // Добавлена «задним числом» — в конце массива, но встаёт к своему «Грипу».
      { id: "__new-1", equipmentId: "e-f", quantity: 1, _added: true, equipment: { id: "e-f", name: "Флаг 24x30", category: "Грип" } },
    ];
    render(<BookingItemsTable booking={MIXED} {...NOOP} retroEditMode retroItems={retroItems} />);
    const groups = tableGroups();
    expect(groups.map((g) => g[0])).toEqual(["Грип", "Свет"]);
    expect(groups[0]).toHaveLength(3);
    expect(groups[0][2]).toMatch(/Флаг 24x30/);
    expect(screen.getByText("· новая позиция").closest("tr")).toHaveClass("bg-emerald-soft");
    // Полоса занимает всю ширину таблицы, включая колонку «✕».
    expect(screen.getByRole("table").querySelector("th[scope=rowgroup]")).toHaveAttribute("colspan", "3");
  });
});
