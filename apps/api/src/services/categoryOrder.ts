/**
 * Единственное хранилище пользовательского порядка категорий (JSON в AppSetting).
 * Отображение списков: getMergedCategoryOrder → compareEquipmentTransportLast(..., merged).
 */
import { prisma } from "../prisma";
import { isTransportCategory, normalizeCategoryName } from "../utils/equipmentSort";

const SETTING_KEY = "equipment_category_order";

/** Слияние сохранённого порядка с актуальным списком категорий из БД (новые — в конец по алфавиту, «Транспорт» в самом конце). */
export function mergeCategoryOrder(saved: string[], dbCategories: string[]): string[] {
  const dbByNorm = new Map<string, string>();
  for (const c of dbCategories) {
    dbByNorm.set(normalizeCategoryName(c), c);
  }
  const used = new Set<string>();
  const result: string[] = [];

  for (const item of saved) {
    const n = normalizeCategoryName(item);
    const canonical = dbByNorm.get(n);
    if (canonical && !used.has(n)) {
      result.push(canonical);
      used.add(n);
    }
  }

  const missing = dbCategories.filter((c) => !used.has(normalizeCategoryName(c)));
  missing.sort((a, b) => {
    const aT = isTransportCategory(a);
    const bT = isTransportCategory(b);
    if (aT !== bT) return aT ? 1 : -1;
    return a.localeCompare(b, "ru");
  });

  return [...result, ...missing];
}

export async function getMergedCategoryOrder(): Promise<string[]> {
  const distinct = await prisma.equipment.findMany({
    distinct: ["category"],
    select: { category: true },
  });
  const names = distinct.map((d) => d.category);
  let saved: string[] = [];
  try {
    const raw = await prisma.appSetting.findUnique({ where: { key: SETTING_KEY } });
    if (raw?.value) {
      try {
        const parsed = JSON.parse(raw.value) as unknown;
        if (Array.isArray(parsed)) saved = parsed.filter((x): x is string => typeof x === "string");
      } catch {
        saved = [];
      }
    }
  } catch {
    // Таблица AppSetting ещё не создана (миграции) или недоступна — порядок только из БД.
    saved = [];
  }
  return mergeCategoryOrder(saved, names);
}

export async function setCategoryOrder(orderedCategories: string[]): Promise<string[]> {
  const distinct = await prisma.equipment.findMany({
    distinct: ["category"],
    select: { category: true },
  });
  const names = distinct.map((d) => d.category);
  const allowed = new Set(names.map((c) => normalizeCategoryName(c)));
  const filtered = orderedCategories.filter((c) => allowed.has(normalizeCategoryName(c)));
  const merged = mergeCategoryOrder(filtered, names);

  await prisma.appSetting.upsert({
    where: { key: SETTING_KEY },
    create: { key: SETTING_KEY, value: JSON.stringify(merged) },
    update: { value: JSON.stringify(merged) },
  });

  return merged;
}
