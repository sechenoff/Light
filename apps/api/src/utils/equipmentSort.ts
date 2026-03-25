/**
 * Сортировка списка оборудования для UI (остатки, бронь, редактор).
 *
 * Порядок категорий задаётся только списком из БД (AppSetting + mergeCategoryOrder в categoryOrder.ts).
 * Здесь нет отдельных «предпочтительных» категорий — только transport в конце и sortOrder внутри категории.
 */

/** Категория «Транспорт» всегда в конце списков (без учёта регистра). */
export function isTransportCategory(category: string): boolean {
  return category.trim().toLowerCase().replace(/\s+/g, " ") === "транспорт";
}

export function normalizeCategoryName(category: string): string {
  return category.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Индекс категории в списке getMergedCategoryOrder(); не найдена — ∞ (далее сортировка по имени категории). */
export function dynamicCategoryRank(category: string, orderedCategories: string[]): number {
  const n = normalizeCategoryName(category);
  for (let i = 0; i < orderedCategories.length; i++) {
    if (normalizeCategoryName(orderedCategories[i]) === n) return i;
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * 1) «Транспорт» в конце;
 * 2) порядок категорий — по mergedCategoryOrder (массив из getMergedCategoryOrder);
 * 3) внутри категории — sortOrder из редактора, затем имя.
 */
export function compareEquipmentTransportLast(
  a: { category: string; name: string; sortOrder?: number },
  b: { category: string; name: string; sortOrder?: number },
  orderedCategories: string[],
): number {
  const aT = isTransportCategory(a.category);
  const bT = isTransportCategory(b.category);
  if (aT !== bT) return aT ? 1 : -1;

  const aRank = dynamicCategoryRank(a.category, orderedCategories);
  const bRank = dynamicCategoryRank(b.category, orderedCategories);
  if (aRank !== bRank) return aRank - bRank;

  if (aRank === Number.POSITIVE_INFINITY && bRank === Number.POSITIVE_INFINITY) {
    const cat = a.category.localeCompare(b.category, "ru");
    if (cat !== 0) return cat;
  }

  if (typeof a.sortOrder === "number" && typeof b.sortOrder === "number" && a.sortOrder !== b.sortOrder) {
    return a.sortOrder - b.sortOrder;
  }

  const cat = a.category.localeCompare(b.category, "ru");
  if (cat !== 0) return cat;
  return a.name.localeCompare(b.name, "ru");
}
