import { GoogleGenerativeAI } from "@google/generative-ai";
import { prisma } from "../prisma";

// ──────────────────────────────────────────────────────────────────
// Типы
// ──────────────────────────────────────────────────────────────────

export interface GeminiMatchResult {
  competitorItem: string;
  catalogId: string;
  confidence: number;
  reason: string;
}

export interface CatalogItemForMatch {
  id: string;
  name: string;
  category: string;
  brand?: string | null;
  model?: string | null;
}

export interface ItemToMatch {
  name: string;
  category?: string;
}

// ──────────────────────────────────────────────────────────────────
// sanitizeCell
// ──────────────────────────────────────────────────────────────────

/**
 * Убирает управляющие символы и обрезает до 500 символов.
 */
export function sanitizeCell(value: string): string {
  return value
    .replace(/[\x00-\x1f\x7f]/g, "")
    .slice(0, 500);
}

// ──────────────────────────────────────────────────────────────────
// batchMatchWithGemini
// ──────────────────────────────────────────────────────────────────

/**
 * Запрашивает Gemini для пакетного сопоставления позиций конкурента с каталогом.
 * При отсутствии API-ключа или ошибке — возвращает пустой массив.
 */
export async function batchMatchWithGemini(
  items: ItemToMatch[],
  catalog: CatalogItemForMatch[],
  competitorName: string,
): Promise<GeminiMatchResult[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return [];
  }

  if (items.length === 0 || catalog.length === 0) {
    return [];
  }

  try {
    const client = new GoogleGenerativeAI(apiKey);
    const model = client.getGenerativeModel({
      model: "gemini-2.5-flash-lite",
      generationConfig: {
        maxOutputTokens: 8192,
        responseMimeType: "application/json",
      },
    });

    const sanitizedItems = items.map((item) => ({
      name: sanitizeCell(item.name),
      category: item.category ? sanitizeCell(item.category) : undefined,
    }));

    const catalogList = catalog
      .map((c) => {
        const parts = [`id: ${c.id}`, `name: ${sanitizeCell(c.name)}`, `category: ${sanitizeCell(c.category)}`];
        if (c.brand) parts.push(`brand: ${sanitizeCell(c.brand)}`);
        if (c.model) parts.push(`model: ${sanitizeCell(c.model)}`);
        return `{${parts.join(", ")}}`;
      })
      .join("\n");

    const itemsList = sanitizedItems
      .map((item, i) => {
        const parts = [`${i + 1}. name: "${item.name}"`];
        if (item.category) parts.push(`category: "${item.category}"`);
        return parts.join(", ");
      })
      .join("\n");

    const prompt = `Ты — эксперт по прокату осветительного оборудования. Тебе нужно сопоставить позиции конкурента "${sanitizeCell(competitorName)}" с нашим каталогом.

Позиции конкурента для сопоставления:
${itemsList}

Наш каталог:
${catalogList}

Для каждой позиции конкурента найди наиболее подходящую позицию каталога. Учитывай синонимы, сокращения, русские и английские названия.

КРИТИЧНО: Ответ должен быть ТОЛЬКО валидным JSON-массивом без markdown-блоков, без комментариев.
Формат каждого элемента:
{"competitorItem": "название из позиций конкурента", "catalogId": "id из каталога или null", "confidence": 0.0-1.0, "reason": "краткое пояснение"}

Если подходящего элемента каталога нет — используй null для catalogId и confidence < 0.5.`;

    const result = await model.generateContent(prompt);
    const raw = result.response.text().trim();

    // Парсим JSON-ответ
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Пробуем извлечь из markdown-блока
      const mdMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (mdMatch?.[1]) {
        try {
          parsed = JSON.parse(mdMatch[1].trim());
        } catch {
          /* игнорируем */
        }
      }
    }

    if (!Array.isArray(parsed)) {
      console.error("[competitorMatcher] Gemini вернул не массив:", raw.slice(0, 200));
      return [];
    }

    // Фильтруем и нормализуем результаты
    const matches: GeminiMatchResult[] = [];
    for (const item of parsed) {
      if (
        item &&
        typeof item === "object" &&
        typeof item.competitorItem === "string" &&
        typeof item.catalogId === "string" &&
        typeof item.confidence === "number"
      ) {
        matches.push({
          competitorItem: item.competitorItem,
          catalogId: item.catalogId,
          confidence: item.confidence,
          reason: typeof item.reason === "string" ? item.reason : "",
        });
      }
    }

    return matches;
  } catch (err) {
    console.error("[competitorMatcher] batchMatchWithGemini ошибка:", err);
    return [];
  }
}

// ──────────────────────────────────────────────────────────────────
// saveAliases
// ──────────────────────────────────────────────────────────────────

/**
 * Сохраняет CompetitorAlias для матчей с уверенностью ≥ 0.8.
 */
export async function saveAliases(
  competitorName: string,
  matches: Array<{ competitorItem: string; catalogId: string; confidence: number }>,
): Promise<void> {
  const highConfidence = matches.filter((m) => m.confidence >= 0.8);

  for (const match of highConfidence) {
    await prisma.competitorAlias.upsert({
      where: {
        competitorName_competitorItem: {
          competitorName,
          competitorItem: match.competitorItem,
        },
      },
      update: {
        equipmentId: match.catalogId,
      },
      create: {
        competitorName,
        competitorItem: match.competitorItem,
        equipmentId: match.catalogId,
      },
    });
  }
}
