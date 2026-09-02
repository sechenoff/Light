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
const COMPACT_ALIAS_PREFIX = "~";

/**
 * Убирает из фразы гаффера обозначения количества: «Быт 25шт», «Хай роллер (4)»,
 * «Мотыль-6», «Капа — 12 шт.», «x2». Количество парсер уже вынес в отдельное поле,
 * а в словаре псевдонимы лежат без него — «быт» есть, «быт 25шт» нет.
 * Голое число в начале («12 мбю» — это размер 12×12, «4 систенда» — количество)
 * не трогаем: без контекста их не различить, а псевдонимы с числом ищутся по
 * полной фразе раньше усечённой.
 */
export function stripQuantityTokens(s: string): string {
  return s
    .replace(/\(\s*\d+\s*(?:шт\.?|штук|pcs)?\s*\)/gi, " ")
    .replace(/[-—–]\s*\d+\s*(?:шт\.?|штук|pcs)?\s*\.?\s*$/i, " ")
    .replace(/(?<![\d,.])\b\d+\s*(?:шт\.?|штук|pcs)(?![a-zа-яё])\.?/gi, " ")
    .replace(/\s[x×]\s*\d+\s*$/i, " ")
    .replace(/^\s*\d+\s*[x×]\s+/i, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Ищет псевдонимы по списку ключей: сначала как есть, потом без пробелов. */
function lookupAliases(dbAliases: DbAliasMap, keys: Array<string | null>): DbAliasEntry[] | undefined {
  const tried = new Set<string>();
  for (const key of keys) {
    if (!key || tried.has(key)) continue;
    tried.add(key);
    const direct = dbAliases.get(key);
    if (direct && direct.length > 0) return direct;
    const compact = key.replace(/ /g, "");
    if (compact !== key) {
      // Псевдоним мог быть записан и слитно («хайроллер») — тогда он лежит под
      // своим именем, а не под служебным ключом.
      const byCompact = dbAliases.get(COMPACT_ALIAS_PREFIX + compact) ?? dbAliases.get(compact);
      if (byCompact && byCompact.length > 0) return byCompact;
    }
  }
  return undefined;
}

function buildDbAliasMap(
  rows: { phraseNormalized: string; equipmentId: string; usageCount: number }[],
): DbAliasMap {
  const map: DbAliasMap = new Map();
  const add = (key: string, entry: DbAliasEntry) => {
    const existing = map.get(key);
    if (existing) existing.push(entry);
    else map.set(key, [entry]);
  };
  for (const row of rows) {
    const entry = { equipmentId: row.equipmentId, usageCount: row.usageCount };
    add(row.phraseNormalized, entry);
    // Тот же псевдоним без пробелов под служебным префиксом: «хай роллер» и
    // «хайроллер» — одно слово в разных написаниях. norm() тильду не пропускает,
    // поэтому с настоящими фразами такой ключ не пересечётся.
    const compact = row.phraseNormalized.replace(/ /g, "");
    if (compact !== row.phraseNormalized) add(COMPACT_ALIAS_PREFIX + compact, entry);
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
  /** Оригинальная фраза гаффера (до AI-интерпретации) для проверки по псевдонимам */
  gafferPhrase?: string;
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

  // Пустая после нормализации строка («—», эмодзи) — не запрос: иначе
  // `n.includes("")` ставит 0.9 первой же строке каталога.
  if (!q || !n) return 0;

  if (q === n) return 1.0;

  // Вхождение целыми словами — сильный сигнал («52xt» в «aputure electric storm 52xt blair»).
  const padQ = ` ${q} `;
  const padN = ` ${n} `;
  if (padN.includes(padQ) || padQ.includes(padN)) return 0.9;
  // Вхождение внутрь слова («расклад» в «раскладные») — только на проверку.
  if (n.includes(q) || q.includes(n)) return 0.45;

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

/** Псевдоним, подтверждённый столько раз, считаем домашней конвенцией и не переспрашиваем. */
const TRUSTED_ALIAS_USAGE = 8;

const wordTokens = (s: string): string[] => norm(s).split(" ").filter((t) => t && !/\d/.test(t));
const digitTokens = (s: string): string[] => norm(s).split(" ").filter((t) => /\d/.test(t));

/**
 * «Семья» позиции — соседи, отличающиеся только числом/размером (Автополе
 * 100/150/235, Трубный бум D42/D48, MattBounce 8×8/12×12), а для фразы из
 * одного слова, совпадающего с первым словом названия («хейзер», «страховка»),
 * — все позиции категории с тем же первым словом. Числа из фразы (pins)
 * оставляют только тех соседей, которым они подходят: «трубы 3 метра» держит
 * трёхметровые D42 и D48, «хейзер 1800» не оставляет никого.
 */
function familySiblings(target: CatalogRow, phraseNorm: string, pins: string[], catalog: CatalogRow[]): CatalogRow[] {
  const words = wordTokens(target.name);
  if (words.length === 0) return [];
  const key = [...words].sort().join(" ");
  const phraseTokens = phraseNorm.split(" ").filter(Boolean);
  const singleHead = phraseTokens.length === 1 && phraseTokens[0] === words[0];
  const out: CatalogRow[] = [];
  for (const row of catalog) {
    if (row.id === target.id || row.category !== target.category) continue;
    const w = wordTokens(row.name);
    const sameWords = w.length > 0 && [...w].sort().join(" ") === key;
    const sameHead = singleHead && w[0] === words[0];
    if (!sameWords && !sameHead) continue;
    const tokens = norm(row.name).split(" ");
    if (pins.every((p) => tokens.some((t) => t.includes(p) || p.includes(t)))) out.push(row);
  }
  return out;
}

/**
 * Находит top-N кандидатов из каталога для свободной фразы.
 * Сначала словарь сленга (SlangAlias), потом скоринг по AI-имени и исходной фразе.
 * Уверенный ответ даётся только там, где сомневаться не в чем: точное имя,
 * домашняя конвенция или единственный вариант в семье. Всё остальное —
 * needsReview, и дальше решает AI-подбор с каталогом или человек.
 */
function findTopCandidates(
  phrase: string,
  quantity: number,
  catalog: CatalogRow[],
  dbAliases: DbAliasMap,
  topN = 3,
  gafferPhrase?: string,
): { resolved?: GafferResolved; needsReview?: GafferNeedsReview; unmatched?: GafferUnmatched } {
  const q = norm(phrase);
  const gafferQ = gafferPhrase ? norm(gafferPhrase) : null;
  const gafferCore = gafferPhrase ? norm(stripQuantityTokens(gafferPhrase)) : null;
  // Числа фразы и AI-имени — размер, диаметр, мощность: то, что различает соседей.
  const pins = Array.from(new Set(digitTokens(`${gafferCore ?? ""} ${q}`)));

  const toCandidate = (row: CatalogRow, confidence: number): GafferCandidate => ({
    equipmentId: row.id,
    catalogName: row.name,
    category: row.category,
    availableQuantity: row.totalQuantity,
    rentalRatePerShift: row.rentalRatePerShift.toString(),
    confidence,
  });
  const toResolved = (row: CatalogRow, confidence: number): GafferResolved => ({
    equipmentId: row.id,
    catalogName: row.name,
    suggestedName: phrase,
    category: row.category,
    quantity: Math.min(quantity, row.totalQuantity),
    availableQuantity: row.totalQuantity,
    rentalRatePerShift: row.rentalRatePerShift.toString(),
    confidence,
  });
  /**
   * Уверенный выбор, если фраза не оставила семью без ответа («хейзер» —
   * 1800W или Antari? «трубный бум» — D42 или D48?). Иначе needsReview:
   * выбранный вариант первым, соседи следом.
   */
  const settle = (row: CatalogRow, confidence: number) => {
    const siblings = familySiblings(row, gafferCore ?? q, pins, catalog);
    if (siblings.length === 0) return { resolved: toResolved(row, confidence) };
    return {
      needsReview: {
        rawPhrase: phrase,
        quantity,
        candidates: [toCandidate(row, confidence), ...siblings.slice(0, 4).map((s) => toCandidate(s, 0.8))],
      },
    };
  };

  // 1. Словарь сленга: полная фраза гаффера → без количества → AI-имя.
  // Порядок важен: полная фраза («12 мбю» — размер) раньше усечённой.
  const aliasEntries = lookupAliases(dbAliases, [gafferQ, gafferCore, q, norm(stripQuantityTokens(phrase))]);
  if (aliasEntries && aliasEntries.length > 0) {
    if (aliasEntries.length === 1) {
      const entry = aliasEntries[0];
      const row = catalog.find((c) => c.id === entry.equipmentId);
      if (row) {
        // Домашняя конвенция («систенды» = 40") — не переспрашиваем, пока хватает наличия.
        if (entry.usageCount >= TRUSTED_ALIAS_USAGE && quantity <= row.totalQuantity) {
          return { resolved: toResolved(row, 1.0) };
        }
        return settle(row, 1.0);
      }
    } else {
      // Конфликт: несколько псевдонимов для одной фразы → needsReview
      const candidates = aliasEntries
        .map((e) => catalog.find((c) => c.id === e.equipmentId))
        .filter((r): r is CatalogRow => Boolean(r))
        .map((r) => toCandidate(r, 1.0));
      if (candidates.length > 0) return { needsReview: { rawPhrase: phrase, quantity, candidates } };
    }
  }

  // 2. Скоринг по AI-имени и по исходной фразе гаффера — полной и без количества.
  // Заявки из программ гафферов содержат наши названия дословно, а модель при
  // нормализации может исказить («chinavise») или перевести («metal clamp»);
  // полная фраза при этом держит точное совпадение («K5600 Joker-800»).
  const rawVariants = Array.from(
    new Set([gafferPhrase, gafferPhrase ? stripQuantityTokens(gafferPhrase) : null].filter((v): v is string => typeof v === "string" && v.length > 0 && norm(v) !== q)),
  );
  const scored = catalog
    .map((row) => ({
      row,
      score: Math.max(scoreRow(phrase, row), ...rawVariants.map((v) => scoreRow(v, row))),
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);

  if (scored.length === 0) {
    return { unmatched: { rawPhrase: phrase, quantity } };
  }

  const [best, second] = scored;

  if (best.score >= 0.7) {
    if (best.score === 1) return { resolved: toResolved(best.row, 1) };
    // Два почти равных счёта («Дестрибьютор 32/380 …» против «63/380 …») — не угадываем.
    if (second && best.score - second.score < 0.1) {
      return { needsReview: { rawPhrase: phrase, quantity, candidates: scored.map(({ row, score }) => toCandidate(row, score)) } };
    }
    return settle(best.row, best.score);
  }

  if (best.score >= 0.3) {
    return { needsReview: { rawPhrase: phrase, quantity, candidates: scored.map(({ row, score }) => toCandidate(row, score)) } };
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
    const result = findTopCandidates(item.name, item.quantity, catalog, dbAliases, 3, item.gafferPhrase);
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
    const result = findTopCandidates(item.name, item.quantity, catalog, dbAliases, 3, item.gafferPhrase);
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
