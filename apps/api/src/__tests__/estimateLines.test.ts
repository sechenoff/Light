/**
 * Строки сметы из позиций брони — общий построитель для превью, черновика,
 * пересборки и подтверждения (services/estimateLines.ts).
 */
import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";

import {
  CUSTOM_LINE_CATEGORY,
  estimateLineCreateData,
  estimateLinesFromBookingItems,
} from "../services/estimateLines";

const STORM = { rentalRatePerShift: "1000", category: "Свет", name: "Aputure STORM 400x", brand: "Aputure", model: "STORM 400x" };

describe("estimateLinesFromBookingItems", () => {
  it("каталожная строка — ставка × смены строки × количество; своя позиция — целиком", () => {
    const [storm, custom] = estimateLinesFromBookingItems(
      [
        { equipmentId: "eq-storm", equipment: STORM, quantity: 2, negotiatedRatePerShift: null, shifts: 3 },
        { equipmentId: null, equipment: null, quantity: 1, customName: "Расходники", customUnitPrice: "1500" },
      ],
      1,
    );
    expect(storm.shifts).toBe(3);
    expect(storm.unitPrice.toString()).toBe("3000");
    expect(storm.lineSum.toString()).toBe("6000");
    expect(storm.listUnitPrice).toBeNull();
    expect(custom.shifts).toBeNull();
    expect(custom.categorySnapshot).toBe(CUSTOM_LINE_CATEGORY);
    expect(custom.lineSum.toString()).toBe("1500");
  });

  it("категория своей позиции — сохранённая у позиции, иначе «Произвольная позиция»", () => {
    const [kept, fallback] = estimateLinesFromBookingItems(
      [
        { equipmentId: null, equipment: null, quantity: 1, customName: "Доставка", customUnitPrice: "3000", customCategory: "Услуги" },
        { equipmentId: null, equipment: null, quantity: 1, customName: "Гели", customUnitPrice: "800", customCategory: null },
      ],
      1,
    );
    expect(kept.categorySnapshot).toBe("Услуги");
    expect(fallback.categorySnapshot).toBe(CUSTOM_LINE_CATEGORY);
  });

  it("договорная ставка — без скидки, с прайсом для подписи", () => {
    const [line] = estimateLinesFromBookingItems(
      [{ equipmentId: "eq-storm", equipment: STORM, quantity: 1, negotiatedRatePerShift: new Decimal(700), shifts: null }],
      2,
    );
    expect(line.isNegotiated).toBe(true);
    expect(line.unitPrice.toString()).toBe("1400");
    expect(line.listUnitPrice?.toString()).toBe("2000");
  });

  it("quantityOf урезает строку; ноль — строки нет", () => {
    const items = [{ equipmentId: "eq-storm", equipment: STORM, quantity: 5, shifts: null }];
    expect(estimateLinesFromBookingItems(items, 1, { quantityOf: () => 2 })[0].quantity).toBe(2);
    expect(estimateLinesFromBookingItems(items, 1, { quantityOf: () => 0 })).toHaveLength(0);
  });
});

describe("estimateLineCreateData", () => {
  it("деньги — строками с копейками, смены строки сохраняются", () => {
    const [line] = estimateLinesFromBookingItems(
      [{ equipmentId: "eq-storm", equipment: STORM, quantity: 1, shifts: 2 }],
      1,
    );
    expect(estimateLineCreateData(line)).toMatchObject({ unitPrice: "2000", lineSum: "2000", listUnitPrice: null, shifts: 2 });
  });
});
