import { describe, it, expect } from "vitest";
import { groupByCategory, NO_CATEGORY_LABEL } from "../groupByCategory";

type Row = { name: string; category?: string | null };

describe("groupByCategory", () => {
  it("keeps groups in first-seen order and rows in arrival order", () => {
    const rows: Row[] = [
      { name: "Aputure 600d", category: "Свет" },
      { name: "C-Stand", category: "Грип" },
      { name: "SkyPanel", category: "Свет" },
      { name: "Флаг", category: "Грип" },
    ];
    const groups = groupByCategory(rows, (r) => r.category);
    expect(groups.map((g) => g.category)).toEqual(["Свет", "Грип"]);
    expect(groups[0].items.map((r) => r.name)).toEqual(["Aputure 600d", "SkyPanel"]);
    expect(groups[1].items.map((r) => r.name)).toEqual(["C-Stand", "Флаг"]);
  });

  it("collects rows without a category under one «Без категории» group", () => {
    const rows: Row[] = [
      { name: "A", category: "Свет" },
      { name: "Своя позиция", category: null },
      { name: "Ещё одна", category: "   " },
    ];
    const groups = groupByCategory(rows, (r) => r.category);
    expect(groups.map((g) => g.category)).toEqual(["Свет", NO_CATEGORY_LABEL]);
    expect(groups[1].items.map((r) => r.name)).toEqual(["Своя позиция", "Ещё одна"]);
  });

  it("does not mutate the input and returns [] for an empty list", () => {
    const rows: Row[] = [{ name: "B", category: "Грип" }, { name: "A", category: "Свет" }];
    const snapshot = JSON.stringify(rows);
    groupByCategory(rows, (r) => r.category);
    expect(JSON.stringify(rows)).toBe(snapshot);
    expect(groupByCategory([], () => "x")).toEqual([]);
  });
});
