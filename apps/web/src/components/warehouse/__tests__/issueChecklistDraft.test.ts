import { describe, it, expect } from "vitest";
import type { ChecklistItem } from "../types";
import {
  buildIssueDraft,
  defaultRows,
  mergeNewItems,
  rowMax,
  seedIssueRows,
} from "../issueChecklistDraft";

function item(over: Partial<ChecklistItem> & { bookingItemId: string }): ChecklistItem {
  return {
    equipmentId: `eq-${over.bookingItemId}`,
    equipmentName: `Прибор ${over.bookingItemId}`,
    category: "Свет",
    quantity: 2,
    checkedQty: 0,
    trackingMode: "COUNT",
    isExtra: false,
    rentalRatePerShift: "1000",
    originalQuantity: 2,
    addCap: 1,
    ...over,
  };
}

describe("черновик выдачи: сборка", () => {
  it("в черновик попадают только строки, отличные от плана", () => {
    const items = [item({ bookingItemId: "a" }), item({ bookingItemId: "b" }), item({ bookingItemId: "c" })];
    const rows = defaultRows(items);
    rows.set("a", { qty: 0, checked: false, ack: false });
    rows.set("b", { qty: 2, checked: true, ack: false });

    const draft = buildIssueDraft(items, rows);

    expect(draft).toEqual({
      v: 1,
      issue: {
        rows: {
          a: { qty: 0, checked: false, equipmentId: "eq-a" },
          b: { qty: 2, checked: true, equipmentId: "eq-b" },
        },
      },
    });
  });

  it("«под ответственность» сохраняется флагом ack", () => {
    const items = [item({ bookingItemId: "a", addCap: 0, ackCap: 3 })];
    const rows = defaultRows(items);
    rows.set("a", { qty: 4, checked: false, ack: true });
    expect(buildIssueDraft(items, rows).issue?.rows.a).toEqual({
      qty: 4,
      checked: false,
      equipmentId: "eq-a",
      ack: true,
    });
  });
});

describe("черновик выдачи: восстановление", () => {
  it("строка находится по bookingItemId; нетронутые остаются по плану", () => {
    const items = [item({ bookingItemId: "a" }), item({ bookingItemId: "b", quantity: 5 })];
    const { rows, restored, clamped } = seedIssueRows(items, {
      v: 1,
      issue: { rows: { a: { qty: 0, checked: false, equipmentId: "eq-a" } } },
    });
    expect(rows.get("a")).toEqual({ qty: 0, checked: false, ack: false });
    expect(rows.get("b")).toEqual({ qty: 5, checked: false, ack: false });
    expect(restored).toBe(1);
    expect(clamped).toEqual([]);
  });

  it("позицию пересоздали — строка находится по equipmentId", () => {
    const items = [item({ bookingItemId: "new-a", equipmentId: "eq-lamp", quantity: 3, addCap: 0 })];
    const { rows, restored } = seedIssueRows(items, {
      v: 1,
      issue: { rows: { "old-a": { qty: 1, checked: true, equipmentId: "eq-lamp" } } },
    });
    expect(rows.get("new-a")).toEqual({ qty: 1, checked: true, ack: false });
    expect(restored).toBe(1);
  });

  it("количество не выше текущего потолка; превышение называется", () => {
    const items = [item({ bookingItemId: "a", quantity: 2, addCap: 1, equipmentName: "Штатив" })];
    const { rows, clamped } = seedIssueRows(items, {
      v: 1,
      issue: { rows: { a: { qty: 9, checked: true, equipmentId: "eq-a" } } },
    });
    expect(rows.get("a")?.qty).toBe(3);
    expect(clamped).toEqual(["Штатив"]);
  });

  it("ack восстанавливается только если путь «под ответственность» ещё есть", () => {
    const withPath = item({ bookingItemId: "a", quantity: 1, addCap: 0, ackCap: 2 });
    const noPath = item({ bookingItemId: "b", quantity: 1, addCap: 0, ackCap: 0 });
    const { rows } = seedIssueRows([withPath, noPath], {
      v: 1,
      issue: {
        rows: {
          a: { qty: 3, checked: false, equipmentId: "eq-a", ack: true },
          b: { qty: 3, checked: false, equipmentId: "eq-b", ack: true },
        },
      },
    });
    expect(rows.get("a")).toEqual({ qty: 3, checked: false, ack: true });
    expect(rows.get("b")).toEqual({ qty: 1, checked: false, ack: false });
    expect(rowMax(withPath, true)).toBe(3);
    expect(rowMax(withPath, false)).toBe(1);
  });

  it("обнулённая строка не остаётся отмеченной", () => {
    const { rows } = seedIssueRows([item({ bookingItemId: "a" })], {
      v: 1,
      issue: { rows: { a: { qty: 0, checked: true, equipmentId: "eq-a" } } },
    });
    expect(rows.get("a")).toEqual({ qty: 0, checked: false, ack: false });
  });

  it("без черновика — план", () => {
    const items = [item({ bookingItemId: "a", quantity: 4 })];
    expect(seedIssueRows(items, null).rows.get("a")).toEqual({ qty: 4, checked: false, ack: false });
  });

  it("новые строки после добора добавляются, выбранное оператором не трогается", () => {
    const a = item({ bookingItemId: "a" });
    const prev = new Map([["a", { qty: 0, checked: false, ack: false }]]);
    const next = mergeNewItems(prev, [a, item({ bookingItemId: "x", quantity: 1, originalQuantity: 0 })]);
    expect(next.get("a")).toEqual({ qty: 0, checked: false, ack: false });
    expect(next.get("x")).toEqual({ qty: 1, checked: false, ack: false });
    expect(mergeNewItems(next, [a])).toBe(next);
  });

  it("нетронутая строка идёт за новым количеством позиции, тронутая — остаётся как выбрал оператор", () => {
    const before = [
      item({ bookingItemId: "a", quantity: 2 }),
      item({ bookingItemId: "b", quantity: 2 }),
      item({ bookingItemId: "c", quantity: 2 }),
    ];
    // a — по плану (не трогали), b — оператор снял до 1, c — отмечено «Выдано».
    const prev = new Map([
      ["a", { qty: 2, checked: false, ack: false }],
      ["b", { qty: 1, checked: false, ack: false }],
      ["c", { qty: 2, checked: true, ack: false }],
    ]);
    const after = [
      item({ bookingItemId: "a", quantity: 3 }),
      item({ bookingItemId: "b", quantity: 3 }),
      item({ bookingItemId: "c", quantity: 3 }),
    ];
    const next = mergeNewItems(prev, after, before);
    expect(next.get("a")).toEqual({ qty: 3, checked: false, ack: false });
    expect(next.get("b")).toEqual({ qty: 1, checked: false, ack: false });
    expect(next.get("c")).toEqual({ qty: 2, checked: true, ack: false });
    // Отличий от плана по «a» больше нет — в черновик и в /complete она не попадёт.
    expect(buildIssueDraft(after, next).issue?.rows.a).toBeUndefined();
  });
});
