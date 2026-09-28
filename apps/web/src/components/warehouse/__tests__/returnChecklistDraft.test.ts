/**
 * Черновик приёмки: сборка с экрана и восстановление на текущий состав брони.
 */
import { describe, it, expect } from "vitest";
import {
  buildReturnDraft,
  emptySlots,
  hydrateReturnDraft,
  mileageEntries,
  returnableItems,
} from "../returnChecklistDraft";
import type { ChecklistDraftV1, ChecklistItem } from "../types";
import type { UnitSlot } from "../UnitGridRow";

function countItem(id: string, quantity: number, equipmentId: string | null = `eq-${id}`): ChecklistItem {
  return {
    bookingItemId: id,
    equipmentId,
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

function unitItem(id: string, units: Array<[string, boolean]>): ChecklistItem {
  return {
    ...countItem(id, units.length),
    trackingMode: "UNIT",
    units: units.map(([unitId, checked]) => ({ unitId, barcode: null, checked, problemType: null })),
  };
}

function slots(statuses: UnitSlot["status"][]): UnitSlot[] {
  return emptySlots(statuses.length).map((s, i) => ({ ...s, status: statuses[i] }));
}

describe("returnableItems", () => {
  it("отбрасывает строки ×0 — их сняли на выдаче", () => {
    const items = [countItem("a", 2), countItem("z", 0)];
    expect(returnableItems(items).map((i) => i.bookingItemId)).toEqual(["a"]);
  });
});

describe("buildReturnDraft", () => {
  it("кладёт исходы единиц, тронутые сетки и пробег; нетронутые и ×0 не кладёт", () => {
    const grid = slots(["ACCEPTED", "REPAIR"]);
    grid[1] = { ...grid[1], repairComment: "Погнута стойка" };
    const draft = buildReturnDraft({
      items: [
        unitItem("u", [["unit-1", false], ["unit-2", false]]),
        countItem("a", 2),
        countItem("b", 3),
        countItem("z", 0),
      ],
      outcomes: {
        "unit-1": { outcome: "ACCEPTED" },
        "unit-2": {
          outcome: "PROBLEM",
          problem: { reason: "LEFT_ON_SITE", comment: "на площадке", expectedBackDate: "2026-10-01" },
        },
      },
      unitGrids: new Map([
        ["a", grid],
        ["b", emptySlots(3)],
        ["z", emptySlots(2)],
      ]),
      mileages: [{ vehicleId: "v1", mileage: 120500 }],
    });

    expect(draft.v).toBe(1);
    expect(draft.return?.units).toEqual({
      "unit-1": { outcome: "ACCEPTED" },
      "unit-2": {
        outcome: "PROBLEM",
        problem: { reason: "LEFT_ON_SITE", comment: "на площадке", expectedBackDate: "2026-10-01" },
      },
    });
    expect(Object.keys(draft.return?.grids ?? {})).toEqual(["a"]);
    expect(draft.return?.grids.a).toEqual({
      equipmentId: "eq-a",
      slots: [
        { status: "ACCEPTED", repairComment: "", problem: { reason: null, comment: "", expectedBackDate: null } },
        { status: "REPAIR", repairComment: "Погнута стойка", problem: { reason: null, comment: "", expectedBackDate: null } },
      ],
    });
    expect(draft.return?.mileages).toEqual({ v1: 120500 });
  });

  it("обрезает комментарий до лимита черновика", () => {
    const grid = slots(["REPAIR"]);
    grid[0] = { ...grid[0], repairComment: "я".repeat(2500) };
    const draft = buildReturnDraft({
      items: [countItem("a", 1)],
      outcomes: {},
      unitGrids: new Map([["a", grid]]),
      mileages: [],
    });
    expect(draft.return?.grids.a.slots[0].repairComment).toHaveLength(2000);
    expect(draft.return).not.toHaveProperty("mileages");
  });
});

describe("hydrateReturnDraft", () => {
  function draftWith(ret: NonNullable<ChecklistDraftV1["return"]>): ChecklistDraftV1 {
    return { v: 1, return: ret };
  }

  it("восстанавливает сетку по bookingItemId вместе с комментариями", () => {
    const h = hydrateReturnDraft(
      [countItem("a", 2)],
      draftWith({
        units: {},
        grids: {
          a: {
            equipmentId: "eq-a",
            slots: [
              { status: "ACCEPTED", repairComment: "", problem: { reason: null, comment: "", expectedBackDate: null } },
              { status: "PROBLEM", repairComment: "", problem: { reason: "LOST", comment: "не нашли", expectedBackDate: null } },
            ],
          },
        },
      }),
    );
    expect(h.restoredAny).toBe(true);
    expect(h.resetRowIds).toEqual([]);
    expect(h.unitGrids.get("a")?.map((s) => [s.index, s.status])).toEqual([
      [1, "ACCEPTED"],
      [2, "PROBLEM"],
    ]);
    expect(h.unitGrids.get("a")?.[1].problem).toEqual({
      reason: "LOST",
      comment: "не нашли",
      expectedBackDate: null,
    });
  });

  it("позицию пересоздали — находит сетку по equipmentId", () => {
    const h = hydrateReturnDraft(
      [countItem("a-new", 1, "eq-a")],
      draftWith({
        units: {},
        grids: {
          "a-old": {
            equipmentId: "eq-a",
            slots: [{ status: "ACCEPTED", repairComment: "", problem: { reason: null, comment: "", expectedBackDate: null } }],
          },
        },
      }),
    );
    expect(h.unitGrids.get("a-new")?.[0].status).toBe("ACCEPTED");
  });

  it("количество изменилось — сетку сбрасывает и помечает строку", () => {
    const h = hydrateReturnDraft(
      [countItem("a", 3)],
      draftWith({
        units: {},
        grids: {
          a: {
            equipmentId: "eq-a",
            slots: [
              { status: "ACCEPTED", repairComment: "", problem: { reason: null, comment: "", expectedBackDate: null } },
              { status: "ACCEPTED", repairComment: "", problem: { reason: null, comment: "", expectedBackDate: null } },
            ],
          },
        },
      }),
    );
    expect(h.unitGrids.has("a")).toBe(false);
    expect(h.resetRowIds).toEqual(["a"]);
  });

  it("строки ×0 и пропавшие позиции не восстанавливает", () => {
    const h = hydrateReturnDraft(
      [countItem("z", 0)],
      draftWith({
        units: {},
        grids: {
          z: { equipmentId: "eq-z", slots: [] },
          gone: { equipmentId: "eq-gone", slots: [] },
        },
      }),
    );
    expect(h.unitGrids.size).toBe(0);
    expect(h.restoredAny).toBe(false);
  });

  it("штучные: исход из черновика, отметка сервера без черновика = «Принято», рассинхрон чинится", () => {
    const h = hydrateReturnDraft(
      [unitItem("u", [["u1", false], ["u2", true], ["u3", true]])],
      draftWith({
        units: {
          u1: { outcome: "ACCEPTED" },
          u3: { outcome: "REPAIR", repairComment: "разбит байонет" },
        },
        grids: {},
      }),
    );
    expect(h.outcomes).toEqual({
      u1: { outcome: "ACCEPTED" },
      u2: { outcome: "ACCEPTED" },
      u3: { outcome: "REPAIR", repairComment: "разбит байонет" },
    });
    expect(h.toCheck).toEqual(["u1"]);
    expect(h.toUncheck).toEqual(["u3"]);
  });

  it("мусор вместо черновика — пустое восстановление, без исключений", () => {
    for (const junk of [null, undefined, "x", { v: 2 }, { v: 1, return: { units: 5, grids: {} } }]) {
      const h = hydrateReturnDraft([countItem("a", 1)], junk);
      expect(h.restoredAny).toBe(false);
      expect(h.unitGrids.size).toBe(0);
    }
  });

  it("пробег: только целые неотрицательные значения; дата потеряшки — только для «Остался на площадке»", () => {
    const h = hydrateReturnDraft(
      [countItem("a", 1)],
      {
        v: 1,
        return: {
          units: {},
          grids: {
            a: {
              equipmentId: "eq-a",
              slots: [
                {
                  status: "PROBLEM",
                  repairComment: "",
                  problem: { reason: "LOST", comment: "", expectedBackDate: "2026-10-01" },
                },
              ],
            },
          },
          mileages: { v1: 1200, v2: null, v3: -5 as unknown as number },
        },
      },
    );
    expect(h.mileages).toEqual({ v1: 1200 });
    expect(h.unitGrids.get("a")?.[0].problem.expectedBackDate).toBeNull();
  });

  it("mileageEntries: восстановленный пробег в записях панели, пустые поля пропускаются", () => {
    expect(mileageEntries({ v1: 1200, v2: null })).toEqual([{ vehicleId: "v1", mileage: 1200 }]);
    expect(mileageEntries(null)).toEqual([]);
  });
});
