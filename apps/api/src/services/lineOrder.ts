/**
 * Порядок строк брони и сметы «по каталогу» — чтобы смета читалась по категориям,
 * а кладовщик комплектовал бронь категория за категорией, а не в порядке, в каком
 * позиции добавляли.
 *
 * Сортируем при ЧТЕНИИ, а не при записи: у BookingItem и EstimateLine нет поля
 * позиции, добор дописывает строки в конец, а порядок категорий на
 * /equipment/manage может поменяться уже после снапшота сметы.
 *
 * Канон тот же, что у каталога и проверки доступности: порядок категорий из
 * getMergedCategoryOrder («Транспорт» в конце), внутри категории — sortOrder
 * позиции из редактора, затем имя (compareEquipmentTransportLast). Строки без
 * позиции каталога (произвольные) идут в конце в исходном порядке.
 */
import { prisma } from "../prisma";
import { getMergedCategoryOrder } from "./categoryOrder";
import { compareEquipmentTransportLast } from "../utils/equipmentSort";

export type LineOrdering = {
  categoryOrder: string[];
  sortOrderById: Map<string, number>;
};

export type LineOrderKey = {
  /** null/undefined — произвольная позиция без карточки каталога. */
  equipmentId: string | null | undefined;
  category: string;
  name: string;
};

/** Порядок категорий + sortOrder позиций одним запросом на набор строк. */
export async function loadLineOrdering(
  equipmentIds: ReadonlyArray<string | null | undefined>,
): Promise<LineOrdering> {
  const ids = Array.from(new Set(equipmentIds.filter((id): id is string => Boolean(id))));
  const [categoryOrder, rows] = await Promise.all([
    getMergedCategoryOrder(),
    ids.length > 0
      ? prisma.equipment.findMany({ where: { id: { in: ids } }, select: { id: true, sortOrder: true } })
      : Promise.resolve([] as Array<{ id: string; sortOrder: number }>),
  ]);
  return { categoryOrder, sortOrderById: new Map(rows.map((r) => [r.id, r.sortOrder])) };
}

/** Новый массив в порядке каталога; исходный не меняется. Сортировка стабильная. */
export function sortLinesByCatalog<T>(
  rows: ReadonlyArray<T>,
  key: (row: T) => LineOrderKey,
  ordering: LineOrdering,
): T[] {
  const catalog: Array<{ row: T; k: LineOrderKey; sortOrder?: number }> = [];
  const custom: T[] = [];
  for (const row of rows) {
    const k = key(row);
    if (k.equipmentId) catalog.push({ row, k, sortOrder: ordering.sortOrderById.get(k.equipmentId) });
    else custom.push(row);
  }
  catalog.sort((a, b) =>
    compareEquipmentTransportLast(
      { category: a.k.category, name: a.k.name, sortOrder: a.sortOrder },
      { category: b.k.category, name: b.k.name, sortOrder: b.sortOrder },
      ordering.categoryOrder,
    ),
  );
  return [...catalog.map((c) => c.row), ...custom];
}

/** Загрузить порядок и отсортировать — для мест, где сортируется один список. */
export async function sortLinesByCatalogAsync<T>(
  rows: ReadonlyArray<T>,
  key: (row: T) => LineOrderKey,
): Promise<T[]> {
  if (rows.length < 2) return [...rows];
  const ordering = await loadLineOrdering(rows.map((r) => key(r).equipmentId));
  return sortLinesByCatalog(rows, key, ordering);
}

/** Ключ для строки сметы (EstimateLine и её выборки). */
export function estimateLineKey(line: {
  equipmentId?: string | null;
  categorySnapshot: string;
  nameSnapshot: string;
}): LineOrderKey {
  return { equipmentId: line.equipmentId, category: line.categorySnapshot, name: line.nameSnapshot };
}

/** Ключ для позиции брони (BookingItem с подгруженным equipment). */
export function bookingItemKey(item: {
  equipmentId?: string | null;
  customName?: string | null;
  equipment?: { category: string; name: string } | null;
}): LineOrderKey {
  return {
    equipmentId: item.equipment ? item.equipmentId : null,
    category: item.equipment?.category ?? "",
    name: item.equipment?.name ?? item.customName ?? "",
  };
}
