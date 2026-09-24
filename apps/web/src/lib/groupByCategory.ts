/**
 * Группы категорий для списков позиций брони и сметы.
 *
 * Порядок строк задаёт сервер — «по каталогу»: категории в порядке
 * /equipment/manage, внутри — sortOrder позиции, затем имя; произвольные
 * позиции в конце. Клиент его НЕ пересортировывает, а только собирает строки
 * одной категории под одну полосу-заголовок: группы идут в порядке первого
 * появления, строки внутри группы — в порядке прихода.
 */

export type CategoryGroup<T> = { category: string; items: T[] };

/** Подпись группы для строк без категории (например, произвольных позиций). */
export const NO_CATEGORY_LABEL = "Без категории";

export function groupByCategory<T>(
  items: ReadonlyArray<T>,
  categoryOf: (item: T) => string | null | undefined,
): CategoryGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const raw = categoryOf(item);
    const category = raw && raw.trim() ? raw : NO_CATEGORY_LABEL;
    const list = groups.get(category);
    if (list) list.push(item);
    else groups.set(category, [item]);
  }
  return Array.from(groups, ([category, groupItems]) => ({ category, items: groupItems }));
}
