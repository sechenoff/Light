import Decimal from "decimal.js";
import { prisma } from "../prisma";
import type { SuggestedEquipmentItem } from "./vision/types";

// ── Типы ──────────────────────────────────────────────────────────────────────

/**
 * Как была найдена позиция:
 *   exact    — нормализованные имена совпали полностью
 *   contains — одно имя содержит другое
 *   token    — совпадение ≥2 значимых токенов (слов длиной ≥3)
 *   alias    — совпадение через DB-псевдоним (SlangAlias)
 *   analog   — точного совпадения нет, взят наиболее доступный прибор
 *              из той же категории каталога
 */
export type MatchType = "exact" | "contains" | "token" | "alias" | "analog";

export type MatchedItem = {
  equipmentId: string;
  /** Имя позиции из каталога (может отличаться от запроса AI) */
  catalogName: string;
  /** Что предложил AI */
  suggestedName: string;
  category: string;
  quantity: number;
  availableQuantity: number;
  rentalRatePerShift: string;
  matchType: MatchType;
};

export type UnmatchedItem = {
  suggestedName: string;
  suggestedCategory: string;
};

export type MatchResult = {
  matched: MatchedItem[];
  /** Позиции, для которых не нашлось даже аналога */
  unmatched: UnmatchedItem[];
};

// ── Внутренний тип строки каталога ───────────────────────────────────────────

type CatalogRow = {
  id: string;
  name: string;
  category: string;
  totalQuantity: number;
  rentalRatePerShift: Decimal;
};

// ── Тип записи DB-псевдонима ─────────────────────────────────────────────────

/** Один псевдоним из таблицы SlangAlias, сгруппированный по phraseNormalized */
type DbAliasEntry = {
  equipmentId: string;
  usageCount: number;
};

/**
 * Карта: phraseNormalized → массив {equipmentId, usageCount}.
 * Если у фразы несколько записей — это конфликт (фраза используется
 * для разного оборудования), и оба кандидата показываются менеджеру.
 */
type DbAliasMap = Map<string, DbAliasEntry[]>;

// ── Основная функция (photo analysis) ────────────────────────────────────────

/**
 * Сопоставляет список оборудования от AI с реальным каталогом.
 *
 * Алгоритм для каждой позиции (в порядке убывания точности):
 *  1. exact    — normalize(catalogName) === normalize(suggestedName)
 *  2. contains — одно нормализованное имя содержит другое
 *  3. token    — ≥2 общих значимых слова (длина ≥3)
 *  4. DB alias — фраза есть в таблице SlangAlias
 *  5. analog   — нет совпадения по имени → самый доступный прибор
 *                из той же категории каталога
 *  6. unmatched — ни одна стратегия не сработала
 *
 * Одна позиция каталога не используется дважды (защита от дублей).
 */
export async function matchEquipmentToInventory(
  equipment: SuggestedEquipmentItem[],
): Promise<MatchResult> {
  const [catalog, dbAliasRows] = await Promise.all([
    prisma.equipment.findMany({
      where: { totalQuantity: { gt: 0 } },
      select: {
        id: true,
        name: true,
        category: true,
        totalQuantity: true,
        rentalRatePerShift: true,
      },
      orderBy: { sortOrder: "asc" },
    }),
    prisma.slangAlias.findMany({
      select: { phraseNormalized: true, equipmentId: true, usageCount: true },
    }),
  ]);

  const dbAliases = buildDbAliasMap(dbAliasRows);

  const matched: MatchedItem[] = [];
  const unmatched: UnmatchedItem[] = [];
  const usedIds = new Set<string>();

  for (const suggested of equipment) {
    const result = findBestMatch(suggested, catalog, usedIds, dbAliases);
    if (result) {
      usedIds.add(result.equipmentId);
      matched.push(result);
    } else {
      unmatched.push({
        suggestedName: suggested.name,
        suggestedCategory: suggested.category,
      });
    }
  }

  return { matched, unmatched };
}

// ── Стратегии поиска ──────────────────────────────────────────────────────────

function findBestMatch(
  suggested: SuggestedEquipmentItem,
  catalog: CatalogRow[],
  usedIds: Set<string>,
  dbAliases: DbAliasMap,
): MatchedItem | null {
  const available = catalog.filter((c) => !usedIds.has(c.id));
  const query = norm(suggested.name);

  const strategies: Array<{
    type: MatchType;
    pick: (rows: CatalogRow[]) => CatalogRow | undefined;
  }> = [
    {
      // 1. Exact
      type: "exact",
      pick: (rows) => rows.find((c) => norm(c.name) === query),
    },
    {
      // 2. Contains — одно имя включает другое
      type: "contains",
      pick: (rows) =>
        rows.find((c) => {
          const n = norm(c.name);
          return n.includes(query) || query.includes(n);
        }),
    },
    {
      // 3. Token — ≥2 слова длиной ≥3 совпадают
      type: "token",
      pick: (rows) => rows.find((c) => tokenMatch(query, norm(c.name))),
    },
    {
      // 4. DB alias lookup — заменяет TYPE_SYNONYMS
      type: "alias",
      pick: (rows) => {
        const aliases = dbAliases.get(query);
        if (!aliases) return undefined;
        // Берём первый псевдоним с наибольшим usageCount, который есть в доступных строках
        for (const alias of aliases) {
          const found = rows.find((c) => c.id === alias.equipmentId);
          if (found) return found;
        }
        return undefined;
      },
    },
    {
      // 5. Analog — берём прибор из той же категории с наибольшим stock
      type: "analog",
      pick: (rows) =>
        rows
          .filter((c) => categoriesOverlap(norm(c.category), norm(suggested.category)))
          .sort((a, b) => b.totalQuantity - a.totalQuantity)[0],
    },
  ];

  for (const { type, pick } of strategies) {
    const found = pick(available);
    if (found) {
      return toMatchedItem(suggested, found, type);
    }
  }

  return null;
}

function toMatchedItem(
  suggested: SuggestedEquipmentItem,
  found: CatalogRow,
  matchType: MatchType,
): MatchedItem {
  return {
    equipmentId: found.id,
    catalogName: found.name,
    suggestedName: suggested.name,
    category: found.category,
    quantity: Math.min(suggested.quantity, found.totalQuantity),
    availableQuantity: found.totalQuantity,
    rentalRatePerShift: found.rentalRatePerShift.toString(),
    matchType,
  };
}

// ── Вспомогательные функции ───────────────────────────────────────────────────

/** Нормализация: нижний регистр, только буквы/цифры/пробелы */
export function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-zа-яё0-9\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Строит карту DB-псевдонимов: phraseNormalized → [{equipmentId, usageCount}],
 * отсортированных по usageCount убыванию.
 */
function buildDbAliasMap(
  rows: { phraseNormalized: string; equipmentId: string; usageCount: number }[],
): DbAliasMap {
  const map: DbAliasMap = new Map();
  for (const row of rows) {
    const existing = map.get(row.phraseNormalized);
    if (existing) {
      existing.push({ equipmentId: row.equipmentId, usageCount: row.usageCount });
    } else {
      map.set(row.phraseNormalized, [{ equipmentId: row.equipmentId, usageCount: row.usageCount }]);
    }
  }
  // Сортируем каждый массив по usageCount убыванию
  for (const entries of map.values()) {
    entries.sort((a, b) => b.usageCount - a.usageCount);
  }
  return map;
}

/**
 * Проверяет совпадение по токенам:
 * ≥2 слова длиной ≥3 символа из запроса присутствуют в catalogName
 * (или все слова если их меньше 2)
 */
function tokenMatch(query: string, catalogName: string): boolean {
  const tokens = query.split(" ").filter((t) => t.length >= 3);
  if (!tokens.length) return false;
  const hits = tokens.filter((t) => catalogName.includes(t));
  return hits.length >= Math.min(2, tokens.length);
}

/**
 * Мягкое сравнение категорий:
 * совпадение точное ИЛИ ≥1 значимого слова (длина ≥4) присутствует в обеих строках
 */
function categoriesOverlap(catA: string, catB: string): boolean {
  if (catA === catB) return true;
  const keywords = catA.split(" ").filter((t) => t.length >= 4);
  return keywords.some((k) => catB.includes(k));
}

// ── Типы для гаффер-парсера ───────────────────────────────────────────────────

/** Одна позиция из свободного текста заявки (после LLM-разбора) */
export type ParsedRequestItem = {
  name: string;
  quantity: number;
  notes?: string;
};

/** Конкретный кандидат из каталога для неуверенного совпадения */
export type GafferCandidate = {
  equipmentId: string;
  catalogName: string;
  category: string;
  availableQuantity: number;
  rentalRatePerShift: string;
  confidence: number;
};

/** Позиция с уверенным совпадением (score ≥ 0.7) */
export type GafferResolved = {
  equipmentId: string;
  catalogName: string;
  suggestedName: string;
  category: string;
  quantity: number;
  availableQuantity: number;
  rentalRatePerShift: string;
  confidence: number;
};

/** Позиция с неуверенными кандидатами (score 0.3–0.69 или конфликт псевдонимов) */
export type GafferNeedsReview = {
  rawPhrase: string;
  quantity: number;
  candidates: GafferCandidate[];
};

/** Полностью нераспознанная позиция */
export type GafferUnmatched = {
  rawPhrase: string;
  quantity: number;
};

export type GafferMatchResult = {
  resolved: GafferResolved[];
  needsReview: GafferNeedsReview[];
  unmatched: GafferUnmatched[];
};

/** Результат матчинга одной строки заявки (порядок совпадает с входным массивом). */
export type GafferOrderedRowMatch =
  | {
      kind: "resolved";
      equipmentId: string;
      catalogName: string;
      category: string;
      availableQuantity: number;
      rentalRatePerShift: string;
      confidence: number;
    }
  | { kind: "needsReview"; candidates: GafferCandidate[] }
  | { kind: "unmatched" };

// ── Scoring ───────────────────────────────────────────────────────────────────

/** Вычисляет confidence [0..1] для пары (query, catalogRow) */
function scoreRow(query: string, row: CatalogRow): number {
  const q = norm(query);
  const n = norm(row.name);

  if (q === n) return 1.0;

  const qInN = n.includes(q);
  const nInQ = q.includes(n);
  if (qInN || nInQ) return 0.9;

  // token score
  const qTokens = q.split(" ").filter((t) => t.length >= 3);
  const nTokens = n.split(" ").filter((t) => t.length >= 3);
  if (qTokens.length > 0 && nTokens.length > 0) {
    const hits = qTokens.filter((t) => nTokens.includes(t)).length;
    const tokenScore = hits / Math.max(qTokens.length, nTokens.length);
    if (tokenScore >= 0.5) return 0.5 + tokenScore * 0.3;
  }

  // category overlap only
  if (categoriesOverlap(norm(row.category), q)) return 0.25;

  return 0;
}

/**
 * Находит top-N кандидатов из каталога для свободной фразы.
 * Предварительно проверяет DB-псевдонимы (SlangAlias) — они имеют приоритет.
 *
 * Конфликт: если для одной фразы зарегистрировано 2+ разных equipmentId в SlangAlias,
 * оба показываются как кандидаты для проверки менеджером (needsReview).
 */
function findTopCandidates(
  phrase: string,
  quantity: number,
  catalog: CatalogRow[],
  dbAliases: DbAliasMap,
  topN = 3,
): { resolved?: GafferResolved; needsReview?: GafferNeedsReview; unmatched?: GafferUnmatched } {
  const q = norm(phrase);

  // 1. Check DB SlangAlias first
  const aliasEntries = dbAliases.get(q);
  if (aliasEntries && aliasEntries.length > 0) {
    if (aliasEntries.length === 1) {
      // Один однозначный псевдоним → resolved
      const row = catalog.find((c) => c.id === aliasEntries[0].equipmentId);
      if (row) {
        return {
          resolved: {
            equipmentId: row.id,
            catalogName: row.name,
            suggestedName: phrase,
            category: row.category,
            quantity: Math.min(quantity, row.totalQuantity),
            availableQuantity: row.totalQuantity,
            rentalRatePerShift: row.rentalRatePerShift.toString(),
            confidence: 1.0,
          },
        };
      }
    } else {
      // Конфликт: несколько псевдонимов для одной фразы → needsReview
      const candidates: GafferCandidate[] = [];
      for (const entry of aliasEntries) {
        const row = catalog.find((c) => c.id === entry.equipmentId);
        if (row) {
          candidates.push({
            equipmentId: row.id,
            catalogName: row.name,
            category: row.category,
            availableQuantity: row.totalQuantity,
            rentalRatePerShift: row.rentalRatePerShift.toString(),
            confidence: 1.0,
          });
        }
      }
      if (candidates.length > 0) {
        return { needsReview: { rawPhrase: phrase, quantity, candidates } };
      }
    }
  }

  // 2. Score all catalog rows
  const scored = catalog
    .map((row) => ({ row, score: scoreRow(phrase, row) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);

  if (scored.length === 0) {
    return { unmatched: { rawPhrase: phrase, quantity } };
  }

  const best = scored[0];

  if (best.score >= 0.7) {
    return {
      resolved: {
        equipmentId: best.row.id,
        catalogName: best.row.name,
        suggestedName: phrase,
        category: best.row.category,
        quantity: Math.min(quantity, best.row.totalQuantity),
        availableQuantity: best.row.totalQuantity,
        rentalRatePerShift: best.row.rentalRatePerShift.toString(),
        confidence: best.score,
      },
    };
  }

  if (best.score >= 0.3) {
    return {
      needsReview: {
        rawPhrase: phrase,
        quantity,
        candidates: scored.map(({ row, score }) => ({
          equipmentId: row.id,
          catalogName: row.name,
          category: row.category,
          availableQuantity: row.totalQuantity,
          rentalRatePerShift: row.rentalRatePerShift.toString(),
          confidence: score,
        })),
      },
    };
  }

  return { unmatched: { rawPhrase: phrase, quantity } };
}

/**
 * Основная функция для гаффер-парсера.
 * Принимает распознанные AI позиции и матчит их в каталог.
 * Использует DB-псевдонимы (SlangAlias) как приоритетный словарь.
 */
export async function matchGafferRequest(
  items: ParsedRequestItem[],
): Promise<GafferMatchResult> {
  const [catalog, dbAliasRows] = await Promise.all([
    prisma.equipment.findMany({
      where: { totalQuantity: { gt: 0 } },
      select: { id: true, name: true, category: true, totalQuantity: true, rentalRatePerShift: true },
      orderBy: { sortOrder: "asc" },
    }),
    prisma.slangAlias.findMany({
      select: { phraseNormalized: true, equipmentId: true, usageCount: true },
    }),
  ]);

  const dbAliases = buildDbAliasMap(dbAliasRows);

  const resolved: GafferResolved[] = [];
  const needsReview: GafferNeedsReview[] = [];
  const unmatched: GafferUnmatched[] = [];

  for (const item of items) {
    const result = findTopCandidates(item.name, item.quantity, catalog, dbAliases);
    if (result.resolved) resolved.push(result.resolved);
    else if (result.needsReview) needsReview.push(result.needsReview);
    else if (result.unmatched) unmatched.push(result.unmatched);
  }

  return { resolved, needsReview, unmatched };
}

/**
 * Матчинг каждой строки в том же порядке, что и вход (для UI «гаффер | понимание AI»).
 */
export async function matchGafferRequestOrdered(
  items: ParsedRequestItem[],
): Promise<GafferOrderedRowMatch[]> {
  const [catalog, dbAliasRows] = await Promise.all([
    prisma.equipment.findMany({
      where: { totalQuantity: { gt: 0 } },
      select: { id: true, name: true, category: true, totalQuantity: true, rentalRatePerShift: true },
      orderBy: { sortOrder: "asc" },
    }),
    prisma.slangAlias.findMany({
      select: { phraseNormalized: true, equipmentId: true, usageCount: true },
    }),
  ]);

  const dbAliases = buildDbAliasMap(dbAliasRows);

  const out: GafferOrderedRowMatch[] = [];
  for (const item of items) {
    const result = findTopCandidates(item.name, item.quantity, catalog, dbAliases);
    if (result.resolved) {
      out.push({
        kind: "resolved",
        equipmentId: result.resolved.equipmentId,
        catalogName: result.resolved.catalogName,
        category: result.resolved.category,
        availableQuantity: result.resolved.availableQuantity,
        rentalRatePerShift: result.resolved.rentalRatePerShift,
        confidence: result.resolved.confidence,
      });
    } else if (result.needsReview) {
      out.push({ kind: "needsReview", candidates: result.needsReview.candidates });
    } else {
      out.push({ kind: "unmatched" });
    }
  }
  return out;
}
