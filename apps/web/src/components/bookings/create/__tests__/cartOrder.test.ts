import { describe, it, expect } from "vitest";
import { buildCatalogOrder, EMPTY_CATALOG_ORDER, groupCartItems, type CartGroup } from "../cartOrder";

// Ответ /api/availability уже отсортирован сервером по канону каталога:
// категории — в порядке /equipment/manage, внутри — sortOrder, затем имя.
const CATALOG = [
  { equipmentId: "sky", category: "Свет", name: "ARRI SkyPanel S60" },
  { equipmentId: "m18", category: "Свет", name: "ARRI M18" },
  { equipmentId: "stand", category: "Штативы", name: "C-Stand" },
  { equipmentId: "flag", category: "Штативы", name: "Флаг 18×24" },
  { equipmentId: "cable", category: "Коммутация", name: "Кабель 63/380" },
];

type Item = { equipmentId: string; category: string; name: string };

function item(equipmentId: string, category: string, name: string): Item {
  return { equipmentId, category, name };
}

function shape(groups: CartGroup<Item>[]) {
  return groups.map((g) => [g.category, g.items.map((i) => i.equipmentId)]);
}

describe("buildCatalogOrder", () => {
  it("ранг категории — порядок первого появления, ранг позиции — индекс строки", () => {
    const order = buildCatalogOrder(CATALOG);
    expect(Array.from(order.categories)).toEqual([
      ["Свет", 0],
      ["Штативы", 1],
      ["Коммутация", 2],
    ]);
    expect(order.items.get("sky")).toEqual({ rank: 0, category: "Свет" });
    expect(order.items.get("cable")).toEqual({ rank: 4, category: "Коммутация" });
  });
});

describe("groupCartItems", () => {
  it("позиции, добавленные вперемешку, собираются в группы по порядку каталога", () => {
    // Добавляли как попало: кабель, штатив, свет, флаг, ещё свет.
    const added = [
      item("cable", "Коммутация", "Кабель 63/380"),
      item("stand", "Штативы", "C-Stand"),
      item("m18", "Свет", "ARRI M18"),
      item("flag", "Штативы", "Флаг 18×24"),
      item("sky", "Свет", "ARRI SkyPanel S60"),
    ];
    expect(shape(groupCartItems(added, buildCatalogOrder(CATALOG)))).toEqual([
      ["Свет", ["sky", "m18"]],
      ["Штативы", ["stand", "flag"]],
      ["Коммутация", ["cable"]],
    ]);
  });

  it("исходный список не меняется", () => {
    const added = [item("m18", "Свет", "ARRI M18"), item("sky", "Свет", "ARRI SkyPanel S60")];
    const snapshot = added.map((i) => i.equipmentId);
    groupCartItems(added, buildCatalogOrder(CATALOG));
    expect(added.map((i) => i.equipmentId)).toEqual(snapshot);
  });

  it("пока каталог не загружен: категории по первому появлению, строки без перестановки", () => {
    // Правка брони до ответа /availability или восстановленный черновик:
    // ранга ещё нет, и строки не должны прыгать по алфавиту.
    const added = [
      item("m18", "Свет", "ARRI M18"),
      item("cable", "Коммутация", "Кабель 63/380"),
      item("sky", "Свет", "ARRI SkyPanel S60"),
    ];
    expect(shape(groupCartItems(added, EMPTY_CATALOG_ORDER))).toEqual([
      ["Свет", ["m18", "sky"]],
      ["Коммутация", ["cable"]],
    ]);
  });

  it("категория вне каталога — после известных, между собой по алфавиту", () => {
    const added = [
      item("x2", "Эффекты", "Дым-машина"),
      item("x1", "Грип", "Автополе"),
      item("cable", "Коммутация", "Кабель 63/380"),
    ];
    expect(shape(groupCartItems(added, buildCatalogOrder(CATALOG)))).toEqual([
      ["Коммутация", ["cable"]],
      ["Грип", ["x1"]],
      ["Эффекты", ["x2"]],
    ]);
  });

  it("позиция без ранга встаёт после известных своей категории, затем по имени", () => {
    const added = [
      item("new2", "Свет", "Nova P300"),
      item("new1", "Свет", "Aputure 600d"),
      item("m18", "Свет", "ARRI M18"),
    ];
    expect(shape(groupCartItems(added, buildCatalogOrder(CATALOG)))).toEqual([
      ["Свет", ["m18", "new1", "new2"]],
    ]);
  });

  it("категорию берёт из каталога: черновик мог сохранить устаревшую", () => {
    // Позицию перенесли в другую категорию после того, как черновик сохранили.
    const added = [item("stand", "Свет", "C-Stand"), item("sky", "Свет", "ARRI SkyPanel S60")];
    expect(shape(groupCartItems(added, buildCatalogOrder(CATALOG)))).toEqual([
      ["Свет", ["sky"]],
      ["Штативы", ["stand"]],
    ]);
  });

  it("пустой состав — пустой список групп", () => {
    expect(groupCartItems([], buildCatalogOrder(CATALOG))).toEqual([]);
  });
});
