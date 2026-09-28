/**
 * Приёмка: проверка заполненности и тело «Завершить приёмку».
 */
import { describe, it, expect } from "vitest";
import {
  buildReturnCompletePayload,
  computeAcceptedCount,
  computeReturnRowErrors,
  toIsoDatetime,
} from "../returnChecklistPayload";
import { emptySlots, returnableItems } from "../returnChecklistDraft";
import type { ChecklistItem } from "../types";
import type { UnitSlot } from "../UnitGridRow";

function countItem(id: string, quantity: number): ChecklistItem {
  return {
    bookingItemId: id,
    equipmentId: `eq-${id}`,
    equipmentName: `Позиция ${id}`,
    category: "Грип",
    quantity,
    checkedQty: 0,
    trackingMode: "COUNT",
    isExtra: false,
    rentalRatePerShift: "0",
    originalQuantity: quantity,
    addCap: 0,
  };
}

function grid(statuses: UnitSlot["status"][]): UnitSlot[] {
  return emptySlots(statuses.length).map((s, i) => ({ ...s, status: statuses[i] }));
}

describe("computeReturnRowErrors", () => {
  it("строка ×0 не требует отметок, когда её отфильтровали как не участвующую", () => {
    const items = returnableItems([countItem("a", 2), countItem("z", 0)]);
    const errs = computeReturnRowErrors(items, {}, new Map([["a", grid(["ACCEPTED", "ACCEPTED"])]]));
    expect(errs).toEqual({});
  });

  it("называет, что осталось: непомеченные ячейки, ремонт без комментария, проблема без причины", () => {
    const repair = grid(["ACCEPTED", "REPAIR"]);
    const problem = grid(["PROBLEM"]);
    const errs = computeReturnRowErrors(
      [countItem("a", 3), countItem("b", 2), countItem("c", 1), countItem("d", 2)],
      {},
      new Map([
        ["a", grid(["ACCEPTED", "PENDING", "PENDING"])],
        ["b", repair],
        ["c", problem],
      ]),
    );
    expect(errs).toEqual({
      a: "Осталось пометить 2 из 3",
      b: "Юнит #2: введите комментарий ремонта",
      c: "Юнит #1: выберите причину проблемы",
      d: "Помечьте все 2 шт",
    });
  });
});

describe("buildReturnCompletePayload", () => {
  it("одна запись на каждую непринятую ячейку, ISO-дата только для «Остался на площадке»", () => {
    const slots = grid(["ACCEPTED", "REPAIR", "PROBLEM", "PROBLEM"]);
    slots[1] = { ...slots[1], repairComment: " Порван шов " };
    slots[2] = {
      ...slots[2],
      problem: { reason: "LEFT_ON_SITE", comment: " на площадке ", expectedBackDate: "2026-10-05" },
    };
    slots[3] = {
      ...slots[3],
      problem: { reason: "DESTROYED", comment: "раздавили", expectedBackDate: "2026-10-05" },
    };
    const payload = buildReturnCompletePayload({
      items: [countItem("a", 4)],
      outcomes: {},
      unitGrids: new Map([["a", slots]]),
      mileages: [{ vehicleId: "v1", mileage: 120500 }],
    });
    expect(payload).toEqual({
      repairUnits: [{ bookingItemId: "a", quantity: 1, comment: "Порван шов" }],
      problemUnits: [
        {
          bookingItemId: "a",
          quantity: 1,
          reason: "LEFT_ON_SITE",
          comment: "на площадке",
          expectedBackDate: "2026-10-05T00:00:00.000Z",
        },
        { bookingItemId: "a", quantity: 1, reason: "DESTROYED", comment: "раздавили" },
      ],
      vehicleMileages: [{ vehicleId: "v1", mileage: 120500 }],
    });
  });

  it("всё принято — пустое тело", () => {
    expect(
      buildReturnCompletePayload({
        items: [countItem("a", 2)],
        outcomes: {},
        unitGrids: new Map([["a", grid(["ACCEPTED", "ACCEPTED"])]]),
        mileages: [],
      }),
    ).toEqual({});
  });
});

describe("мелочи", () => {
  it("computeAcceptedCount считает принятые ячейки", () => {
    expect(
      computeAcceptedCount(
        [countItem("a", 3)],
        {},
        new Map([["a", grid(["ACCEPTED", "REPAIR", "ACCEPTED"])]]),
      ),
    ).toBe(2);
  });

  it("toIsoDatetime принимает только голую дату", () => {
    expect(toIsoDatetime("2026-10-05")).toBe("2026-10-05T00:00:00.000Z");
    expect(toIsoDatetime("05.10.2026")).toBeUndefined();
    expect(toIsoDatetime(null)).toBeUndefined();
  });
});
