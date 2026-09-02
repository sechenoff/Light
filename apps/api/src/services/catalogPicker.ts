import { prisma } from "../prisma";
import { getLlmProvider, type GafferExtractedLine, type CatalogPickInput } from "./llm";
import type { GafferOrderedRowMatch } from "./equipmentMatcher";

/**
 * AI-подбор позиций каталога для спорных строк заявки.
 *
 * Матчер сравнивает строки: «52xt» одинаково похоже на прибор и на «линзу
 * для 52xt», а «нова р300 с софтом» — на прибор, софтбокс и шторки. Модель
 * видит весь каталог и соседние строки, поэтому различает прибор и насадку,
 * а «с софтом» разворачивает в две позиции. Работает только по строкам, где
 * матчер не уверен (needsReview / unmatched): уверенные совпадения не трогаем.
 */

/** Уверенность выбора модели: ниже точного совпадения (1.0), выше порога авто-принятия матчера (0.7). */
export const AI_PICK_CONFIDENCE = 0.95;

export type ResolvedMatch = Extract<GafferOrderedRowMatch, { kind: "resolved" }>;

export type RefinedMatches = {
  matches: GafferOrderedRowMatch[];
  /** Явно запрошенные дополнения («…с софтом» → софтбокс) — отдельными позициями. */
  extras: Array<{ lineIndex: number; match: ResolvedMatch }>;
  /** Сколько спорных строк решила модель. */
  aiDecided: number;
};

/** Выключатель на случай сбоя провайдера или спорного качества: LLM_CATALOG_PICK=off. */
export function isCatalogPickEnabled(): boolean {
  return (process.env.LLM_CATALOG_PICK ?? "on").trim().toLowerCase() !== "off";
}

export async function refineMatchesWithAi(
  lines: GafferExtractedLine[],
  matches: GafferOrderedRowMatch[],
): Promise<RefinedMatches> {
  const untouched: RefinedMatches = { matches, extras: [], aiDecided: 0 };
  if (!isCatalogPickEnabled()) return untouched;

  const disputed = new Set<number>();
  matches.forEach((m, i) => {
    if (m.kind !== "resolved") disputed.add(i);
  });
  if (disputed.size === 0) return untouched;

  const provider = getLlmProvider();
  if (typeof provider.pickCatalogMatches !== "function") return untouched;

  // Тот же срез каталога и тот же порядок, что у матчера: номера строк
  // существуют только внутри этого запроса.
  const catalog = await prisma.equipment.findMany({
    where: { totalQuantity: { gt: 0 } },
    select: { id: true, name: true, category: true, totalQuantity: true, rentalRatePerShift: true },
    orderBy: { sortOrder: "asc" },
  });
  const rowById = new Map(catalog.map((c, i) => [c.id, i + 1] as const));

  const input: CatalogPickInput = {
    catalog: catalog.map((c, i) => ({ row: i + 1, name: c.name, category: c.category })),
    lines: lines.map((l, i) => {
      const m = matches[i];
      return {
        line: i + 1,
        gafferPhrase: l.gafferPhrase,
        interpretedName: l.interpretedName,
        quantity: l.quantity,
        decide: m.kind !== "resolved",
        matchedRow: m.kind === "resolved" ? rowById.get(m.equipmentId) : undefined,
        candidateRows:
          m.kind === "needsReview"
            ? m.candidates.map((c) => rowById.get(c.equipmentId)).filter((r): r is number => r !== undefined)
            : undefined,
      };
    }),
  };

  const decisions = await provider.pickCatalogMatches(input);

  const toResolved = (c: (typeof catalog)[number]): ResolvedMatch => ({
    kind: "resolved",
    equipmentId: c.id,
    catalogName: c.name,
    category: c.category,
    availableQuantity: c.totalQuantity,
    rentalRatePerShift: c.rentalRatePerShift.toString(),
    confidence: AI_PICK_CONFIDENCE,
  });

  const out = [...matches];
  const extras: RefinedMatches["extras"] = [];
  let aiDecided = 0;
  for (const d of decisions) {
    const i = d.line - 1;
    if (!disputed.has(i)) continue;
    const picked = d.rows.map((r) => catalog[r - 1]).filter((c) => c !== undefined);
    // «В каталоге нет» — оставляем результат матчера: кандидаты или «не найдено» решает человек.
    if (picked.length === 0) continue;
    out[i] = toResolved(picked[0]);
    aiDecided++;
    for (const c of picked.slice(1)) extras.push({ lineIndex: i, match: toResolved(c) });
  }
  return { matches: out, extras, aiDecided };
}
