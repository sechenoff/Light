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
    expect(list.getByText("· добор ×2")).toBeInTheDocument();
  });

  it("empty booking shows a plain note instead of an empty table", () => {
    render(<BookingItemsTable booking={{ items: [], estimate: null, addonEstimate: null }} {...NOOP} />);
    expect(screen.getByText("Нет позиций")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
