/**
 * Живой блок финансов выдачи (P16, P22): от снимка основной сметы, а не от
 * прайса. Произвольная позиция стоит свою цену, договорная строка — без
 * процента, договорной итог брони остаётся суммой к оплате.
 */
import { describe, it, expect } from "vitest";
import type { ChecklistItem, ChecklistState } from "../types";
import { computeLiveFinance } from "../issueLiveFinance";

function item(over: Partial<ChecklistItem> & { bookingItemId: string }): ChecklistItem {
  return {
    equipmentId: `eq-${over.bookingItemId}`,
    equipmentName: over.bookingItemId,
    category: "Свет",
    quantity: 2,
    checkedQty: 0,
    trackingMode: "COUNT",
    isExtra: false,
    rentalRatePerShift: "1000",
    originalQuantity: 2,
    addCap: 5,
    ...over,
  };
}

function state(items: ChecklistItem[], over: Partial<ChecklistState> = {}): ChecklistState {
  return {
    sessionId: "s1",
    bookingId: "b1",
    operation: "ISSUE",
    items,
    progress: { checkedItems: 0, totalItems: items.length },
    shifts: 2,
    discountPercent: "0",
    mainOriginalAfterDiscount: "0",
    ...over,
  };
}

describe("computeLiveFinance", () => {
  it("произвольная позиция по плану: «Итого» равно «Согласовано», ничего не снято", () => {
    // Штатив 2 × 1000 × 2 смены = 4000; генератор (субаренда) 5000 за период.
    const s = state(
      [
        item({ bookingItemId: "tripod", mainUnitPrice: "2000" }),
        item({
          bookingItemId: "gen",
          equipmentId: null,
          quantity: 1,
          originalQuantity: 1,
          addCap: 0,
          rentalRatePerShift: "0",
          customUnitPrice: "5000",
          mainUnitPrice: "5000",
        }),
      ],
      { mainOriginalAfterDiscount: "9000" },
    );
    const f = computeLiveFinance(s, new Map());
    expect(f.hasRemovals).toBe(false);
    expect(f.hasAddons).toBe(false);
    expect(f.finalAmount).toBe(9000);
    expect(f.removalAmount).toBe(0);
  });

  it("снятая произвольная позиция уменьшает сумму на свою цену, со скидкой", () => {
    const s = state(
      [
        item({
          bookingItemId: "gen",
          equipmentId: null,
          quantity: 1,
          originalQuantity: 1,
          rentalRatePerShift: "0",
          customUnitPrice: "5000",
          mainUnitPrice: "5000",
        }),
      ],
      { mainOriginalAfterDiscount: "2500", discountPercent: "50" },
    );
    const f = computeLiveFinance(s, new Map([["gen", 0]]));
    expect(f.removalAmount).toBe(2500);
    expect(f.finalAmount).toBe(0);
  });

  it("снятие считается по цене из снимка сметы, а не по текущему прайсу", () => {
    // В смете 1500 за период, прайс с тех пор вырос до 1000 × 2 = 2000.
    const s = state([item({ bookingItemId: "a", mainUnitPrice: "1500" })], {
      mainOriginalAfterDiscount: "3000",
    });
    const f = computeLiveFinance(s, new Map([["a", 1]]));
    expect(f.removalAmount).toBe(1500);
    expect(f.mainActual).toBe(1500);
  });

  it("договорная строка: без процента скидки и в снятом, и в доборе", () => {
    const s = state(
      [item({ bookingItemId: "a", mainUnitPrice: "3000", mainNegotiated: true, quantity: 2, originalQuantity: 2 })],
      { mainOriginalAfterDiscount: "6000", discountPercent: "50" },
    );
    expect(computeLiveFinance(s, new Map([["a", 1]])).removalAmount).toBe(3000);
    const up = computeLiveFinance(s, new Map([["a", 3]]));
    expect(up.addonActual).toBe(3000);
    expect(up.finalAmount).toBe(9000);
  });

  it("каталожный добор — ставка × смены со скидкой", () => {
    const s = state([item({ bookingItemId: "a", mainUnitPrice: "2000" })], {
      mainOriginalAfterDiscount: "2000",
      discountPercent: "50",
    });
    const f = computeLiveFinance(s, new Map([["a", 3]]));
    expect(f.addonActual).toBe(1000);
    expect(f.finalAmount).toBe(3000);
  });

  it("добор произвольной позиции — её цена за период, без умножения на смены", () => {
    const s = state(
      [
        item({
          bookingItemId: "gen",
          equipmentId: null,
          quantity: 2,
          originalQuantity: 1,
          rentalRatePerShift: "0",
          customUnitPrice: "5000",
          mainUnitPrice: "5000",
        }),
      ],
      { mainOriginalAfterDiscount: "5000" },
    );
    expect(computeLiveFinance(s, new Map()).addonActual).toBe(5000);
  });

  it("договорной итог брони отдаётся отдельно — «Итого» по смете его не подменяет", () => {
    const s = state([item({ bookingItemId: "a" })], {
      mainOriginalAfterDiscount: "4000",
      booking: {
        status: "CONFIRMED",
        startDate: new Date().toISOString(),
        endDate: new Date().toISOString(),
        finalAmount: "1000",
        manualFinalAmount: "1000",
      },
    });
    const f = computeLiveFinance(s, new Map([["a", 3]]));
    expect(f.manualTotal).toBe(1000);
    expect(f.finalAmount).toBe(6000);
  });

  it("старый сервер без снимка — как раньше: ставка × смены", () => {
    const s = state([item({ bookingItemId: "a" })], { mainOriginalAfterDiscount: "4000" });
    const f = computeLiveFinance(s, new Map([["a", 1]]));
    expect(f.removalAmount).toBe(2000);
    expect(f.finalAmount).toBe(2000);
  });
});
