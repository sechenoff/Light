import { describe, it, expect } from "vitest";
import { sortLinesByCatalog, estimateLineKey, bookingItemKey, type LineOrdering } from "../lineOrder";

const ordering: LineOrdering = {
  categoryOrder: ["COB Light", "Грип", "Транспорт"],
  sortOrderById: new Map([
    ["storm", 1],
    ["ls1200", 2],
    ["cstand", 1],
    ["flag", 2],
  ]),
};

const line = (equipmentId: string | null, categorySnapshot: string, nameSnapshot: string) => ({
  equipmentId,
  categorySnapshot,
  nameSnapshot,
});

describe("sortLinesByCatalog", () => {
  it("группирует строки по порядку категорий каталога, а не по порядку добавления", () => {
    const lines = [
      line("flag", "Грип", "Флаг 4x4"),
      line("ls1200", "COB Light", "Aputure LS 1200x"),
      line("cstand", "Грип", "C-стенд"),
      line("storm", "COB Light", "Electric Storm 52XT"),
    ];
    const sorted = sortLinesByCatalog(lines, estimateLineKey, ordering).map((l) => l.nameSnapshot);
    expect(sorted).toEqual(["Electric Storm 52XT", "Aputure LS 1200x", "C-стенд", "Флаг 4x4"]);
  });

  it("произвольные позиции без карточки каталога — в конце, в исходном порядке", () => {
    const lines = [
      line(null, "Произвольная позиция", "Доставка на площадку"),
      line("cstand", "Грип", "C-стенд"),
      line(null, "Произвольная позиция", "Работа техника"),
    ];
    const sorted = sortLinesByCatalog(lines, estimateLineKey, ordering).map((l) => l.nameSnapshot);
    expect(sorted).toEqual(["C-стенд", "Доставка на площадку", "Работа техника"]);
  });

  it("категория не из сохранённого порядка — после известных, «Транспорт» — последним", () => {
    const lines = [
      line("gen", "Транспорт", "Генератор"),
      line("x1", "Кабели", "Удлинитель"),
      line("storm", "COB Light", "Electric Storm 52XT"),
    ];
    const sorted = sortLinesByCatalog(lines, estimateLineKey, ordering).map((l) => l.categorySnapshot);
    expect(sorted).toEqual(["COB Light", "Кабели", "Транспорт"]);
  });

  it("не меняет исходный массив", () => {
    const lines = [line("flag", "Грип", "Флаг 4x4"), line("storm", "COB Light", "Electric Storm 52XT")];
    const copy = [...lines];
    sortLinesByCatalog(lines, estimateLineKey, ordering);
    expect(lines).toEqual(copy);
  });

  it("bookingItemKey: позиция без equipment считается произвольной", () => {
    const items = [
      { equipmentId: null, customName: "Своя позиция", equipment: null },
      { equipmentId: "cstand", customName: null, equipment: { category: "Грип", name: "C-стенд" } },
    ];
    const sorted = sortLinesByCatalog(items, bookingItemKey, ordering);
    expect(sorted.map((i) => i.equipment?.name ?? i.customName)).toEqual(["C-стенд", "Своя позиция"]);
  });
});
