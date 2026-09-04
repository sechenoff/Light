import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
  it("shows the «добор ×N» chip and MAIN + addon line sums", () => {
    render(<BookingItemsTable booking={BOOKING} {...NOOP} />);
    expect(screen.getByText("· добор ×3")).toBeInTheDocument();
    expect(screen.getByText("· добор ×2")).toBeInTheDocument();
    // Aputure: MAIN 9 000 + добор 27 000 = 36 000; цена за единицу — из MAIN.
    expect(screen.getByText("36 000,00")).toBeInTheDocument();
    // SkyPanel: цен в MAIN нет — берутся из доп-сметы.
    expect(screen.getByText("54 000,00")).toBeInTheDocument();
    expect(screen.getByText("27 000,00")).toBeInTheDocument();
  });

  it("renders no chip when there is no addon estimate", () => {
    render(<BookingItemsTable booking={{ ...BOOKING, addonEstimate: null }} {...NOOP} />);
    expect(screen.queryByText(/добор ×/)).toBeNull();
    // Без доп-сметы позиция без строки MAIN остаётся без цены.
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });
});
