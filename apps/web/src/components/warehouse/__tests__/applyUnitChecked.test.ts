import { describe, it, expect } from "vitest";
import { applyUnitChecked } from "../useScanSession";
import type { ChecklistState } from "../types";

function makeState(): ChecklistState {
  return {
    sessionId: "s1",
    bookingId: "b1",
    operation: "ISSUE",
    items: [
      {
        bookingItemId: "bi-unit",
        equipmentId: "eq1",
        equipmentName: "Aputure 600D",
        category: "Свет",
        quantity: 2,
        checkedQty: 0,
        trackingMode: "UNIT",
        isExtra: false,
        rentalRatePerShift: "0",
        originalQuantity: 2,
        addCap: 0,
        units: [
          { unitId: "u1", barcode: null, checked: false, problemType: null },
          { unitId: "u2", barcode: null, checked: false, problemType: null },
        ],
      },
      {
        bookingItemId: "bi-count",
        equipmentId: "eq2",
        equipmentName: "Manfrotto 1004",
        category: "Стойки",
        quantity: 4,
        checkedQty: 0,
        trackingMode: "COUNT",
        isExtra: false,
        rentalRatePerShift: "0",
        originalQuantity: 4,
        addCap: 0,
      },
    ],
    progress: { checkedItems: 0, totalItems: 2 },
    shifts: 1,
    discountPercent: "0",
    mainOriginalAfterDiscount: "0",
  };
}

describe("applyUnitChecked", () => {
  it("does not mutate the input state (immutability)", () => {
    const state = makeState();
    const snapshot = JSON.parse(JSON.stringify(state));

    applyUnitChecked(state, "u1", true);

    // Original is byte-identical — no in-place mutation.
    expect(state).toEqual(snapshot);
    expect(state.items[0].units?.[0].checked).toBe(false);
    expect(state.items[0].checkedQty).toBe(0);
  });

  it("recomputes the owning item's checkedQty", () => {
    const state = makeState();

    const afterOne = applyUnitChecked(state, "u1", true);
    expect(afterOne.items[0].checkedQty).toBe(1);
    expect(afterOne.items[0].units?.find((u) => u.unitId === "u1")?.checked).toBe(true);
    expect(afterOne.items[0].units?.find((u) => u.unitId === "u2")?.checked).toBe(false);

    const afterTwo = applyUnitChecked(afterOne, "u2", true);
    expect(afterTwo.items[0].checkedQty).toBe(2);

    const afterUncheck = applyUnitChecked(afterTwo, "u1", false);
    expect(afterUncheck.items[0].checkedQty).toBe(1);
  });

  it("returns the same reference for untouched items and unknown unit ids", () => {
    const state = makeState();
    const next = applyUnitChecked(state, "u1", true);

    // The COUNT item (no units) is untouched → same reference preserved.
    expect(next.items[1]).toBe(state.items[1]);
    // The touched item is a new reference.
    expect(next.items[0]).not.toBe(state.items[0]);

    // Unknown unit id → whole state reference unchanged (no-op).
    const noop = applyUnitChecked(state, "does-not-exist", true);
    expect(noop).toBe(state);
  });
});
