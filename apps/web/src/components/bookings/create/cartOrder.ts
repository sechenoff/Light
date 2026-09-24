import type { AvailabilityRow } from "./types";

// Порядок «Состава заявки» — по каталогу, а не по времени добавления: смета
// читается категория за категорией, и бронь так же комплектуется на складе.
//
// Свой порядок категорий здесь не заводим. Ответ /api/availability сервер уже
// отсортировал по канону (категории — как на /equipment/manage, «Транспорт» в
// конце, внутри — sortOrder, затем имя), поэтому индекс строки и есть ранг
// позиции, а порядок первого появления категории — её ранг.
//
// Сортируется только отображение. Map `selected` и порядок payload в API не
// трогаем: от них зависят подпись формы и черновик, а сервер сам отдаёт и
// печатает смету в порядке каталога.

export type CatalogOrder = {
  /** Ранг категории: порядок первого появления в ответе /api/availability. */
  categories: ReadonlyMap<string, number>;
  /** Ранг позиции (индекс строки) и её категория по каталогу. */
  items: ReadonlyMap<string, { rank: number; category: string }>;
};

/** Каталог ещё не загружен — ранга нет. */
export const EMPTY_CATALOG_ORDER: CatalogOrder = { categories: new Map(), items: new Map() };

export type CartOrderItem = { equipmentId: string; category: string; name: string };

export type CartGroup<T> = { category: string; items: T[] };

export function buildCatalogOrder(
  rows: ReadonlyArray<Pick<AvailabilityRow, "equipmentId" | "category">>,
): CatalogOrder {
  const categories = new Map<string, number>();
  const items = new Map<string, { rank: number; category: string }>();
  rows.forEach((r, index) => {
    if (!categories.has(r.category)) categories.set(r.category, categories.size);
    items.set(r.equipmentId, { rank: index, category: r.category });
  });
  return { categories, items };
}

/** Без ранга — после всех с рангом. */
function compareRanks(a: number | undefined, b: number | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return a - b;
}

/**
 * Группы категорий в порядке каталога; входной список не меняется.
 *
 * Категория неизвестная каталогу — после известных, по алфавиту; позиция без
 * ранга — после известных своей категории, по имени. Пока каталог пуст (правка
 * до ответа /availability, восстановленный черновик), категории идут по первому
 * появлению, а строки внутри не переставляются — иначе они прыгали бы дважды.
 */
export function groupCartItems<T extends CartOrderItem>(
  items: Iterable<T>,
  order: CatalogOrder,
): CartGroup<T>[] {
  // Категория — по каталогу: восстановленный черновик мог сохранить устаревшую.
  const categoryOf = (it: T) => order.items.get(it.equipmentId)?.category ?? it.category;

  const byCategory = new Map<string, T[]>();
  for (const it of items) {
    const category = categoryOf(it);
    byCategory.set(category, [...(byCategory.get(category) ?? []), it]);
  }
  const groups = Array.from(byCategory, ([category, list]) => ({ category, items: list }));
  if (order.items.size === 0) return groups;

  const itemRank = (it: T) => order.items.get(it.equipmentId)?.rank;
  return groups
    .map((g) => ({
      category: g.category,
      items: [...g.items].sort(
        (a, b) => compareRanks(itemRank(a), itemRank(b)) || a.name.localeCompare(b.name, "ru"),
      ),
    }))
    .sort(
      (a, b) =>
        compareRanks(order.categories.get(a.category), order.categories.get(b.category)) ||
        a.category.localeCompare(b.category, "ru"),
    );
}
