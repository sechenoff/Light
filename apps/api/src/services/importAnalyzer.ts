import { GoogleGenerativeAI } from "@google/generative-ai";

// ──────────────────────────────────────────────────────────────────
// Типы
// ──────────────────────────────────────────────────────────────────

export interface ColumnMapping {
  category?: string;
  name?: string;
  brand?: string;
  model?: string;
  quantity?: string;
  rentalRatePerShift?: string;
  rentalRateTwoShifts?: string;
  rentalRatePerProject?: string;
}

export interface ChangeInput {
  rowId: string;
  equipmentName: string;
  action: string;
  oldPrice?: number | null;
  newPrice?: number | null;
  oldQty?: number | null;
  newQty?: number | null;
  priceDelta?: number | null;
  category?: string | null;
}

export interface ChangeDescription {
  rowId: string;
  text: string;
}

export interface DescriptionResult {
  summary: string;
  descriptions: ChangeDescription[];
}

// ──────────────────────────────────────────────────────────────────
// Вспомогательные функции
// ──────────────────────────────────────────────────────────────────

function getModel() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY не задан");

  const client = new GoogleGenerativeAI(apiKey);
  return client.getGenerativeModel({
    model: "gemini-2.5-flash-lite",
    generationConfig: {
      maxOutputTokens: 4096,
      responseMimeType: "application/json",
    },
  });
}

function tryParseJSON(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // Пробуем извлечь из markdown-блока
    const mdMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (mdMatch?.[1]) {
      try {
        return JSON.parse(mdMatch[1].trim());
      } catch {
        /* игнорируем */
      }
    }
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────
// analyzeFileStructure
// ──────────────────────────────────────────────────────────────────

/**
 * Определяет соответствие столбцов Excel-файла полям нашей системы
 * с помощью Gemini LLM.
 *
 * @param headers  Заголовки столбцов из файла
 * @param sampleRows  Первые строки данных (до 5 штук)
 * @returns ColumnMapping с именами колонок из заголовков (null для несопоставленных)
 */
export async function analyzeFileStructure(
  headers: string[],
  sampleRows: Record<string, unknown>[],
): Promise<ColumnMapping> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {};
  }

  try {
    const model = getModel();

    const sample = sampleRows.slice(0, 5);
    const sampleStr = JSON.stringify(sample, null, 2);
    const headersStr = headers.join(", ");

    const prompt = `Ты — эксперт по прайс-листам осветительного оборудования для кино.

Тебе дан Excel-файл с оборудованием. Определи, какой столбец соответствует каждому полю нашей системы.

Заголовки столбцов: [${headersStr}]

Примеры строк данных:
${sampleStr}

Поля нашей системы:
- name: наименование/название оборудования
- category: категория оборудования
- brand: бренд/производитель
- model: модель оборудования
- quantity: количество единиц
- rentalRatePerShift: цена аренды за 1 смену
- rentalRateTwoShifts: цена аренды за 2 смены
- rentalRatePerProject: цена аренды за проект/неделю

КРИТИЧНО: Верни ТОЛЬКО валидный JSON-объект. Для каждого поля укажи точное название столбца из заголовков, или null если подходящего столбца нет.

Формат ответа:
{"name": "...", "category": "...", "brand": "...", "model": "...", "quantity": "...", "rentalRatePerShift": "...", "rentalRateTwoShifts": "...", "rentalRatePerProject": "..."}`;

    const result = await model.generateContent(prompt);
    const raw = result.response.text().trim();

    const parsed = tryParseJSON(raw);

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.error("[importAnalyzer] analyzeFileStructure: Gemini вернул неожиданный формат:", raw.slice(0, 200));
      return {};
    }

    const obj = parsed as Record<string, unknown>;
    const mapping: ColumnMapping = {};

    // Принимаем только значения, которые реально есть в заголовках
    const headerSet = new Set(headers);

    const fields: (keyof ColumnMapping)[] = [
      "name", "category", "brand", "model", "quantity",
      "rentalRatePerShift", "rentalRateTwoShifts", "rentalRatePerProject",
    ];

    for (const field of fields) {
      const val = obj[field];
      if (typeof val === "string" && headerSet.has(val)) {
        mapping[field] = val;
      }
    }

    return mapping;
  } catch (err) {
    console.error("[importAnalyzer] analyzeFileStructure ошибка:", err);
    return {};
  }
}

// ──────────────────────────────────────────────────────────────────
// generateDescriptions
// ──────────────────────────────────────────────────────────────────

/**
 * Генерирует читаемые описания изменений прайс-листа на русском языке.
 *
 * @param changes  Список изменений (до 100 строк)
 * @param mode  Тип импорта: свой прайс или конкурент
 * @returns Суммарное описание + описания по каждой строке
 */
export async function generateDescriptions(
  changes: ChangeInput[],
  mode: "OWN_PRICE_UPDATE" | "COMPETITOR_IMPORT",
): Promise<DescriptionResult> {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey || changes.length === 0) {
    return buildFallbackResult(changes, mode);
  }

  try {
    const model = getModel();

    const modeLabel = mode === "OWN_PRICE_UPDATE" ? "обновление нашего прайс-листа" : "импорт прайса конкурента";
    const batch = changes.slice(0, 100);

    const changesStr = batch.map((c) => {
      const parts: string[] = [`rowId: "${c.rowId}"`, `name: "${c.equipmentName}"`, `action: "${c.action}"`];
      if (c.category) parts.push(`category: "${c.category}"`);
      if (c.oldPrice != null) parts.push(`oldPrice: ${c.oldPrice}`);
      if (c.newPrice != null) parts.push(`newPrice: ${c.newPrice}`);
      if (c.oldQty != null) parts.push(`oldQty: ${c.oldQty}`);
      if (c.newQty != null) parts.push(`newQty: ${c.newQty}`);
      if (c.priceDelta != null) parts.push(`priceDelta: ${c.priceDelta}%`);
      return `{${parts.join(", ")}}`;
    }).join("\n");

    const prompt = `Ты — эксперт по прокату осветительного оборудования для кино. Тип операции: ${modeLabel}.

Список изменений:
${changesStr}

Задача:
1. Напиши краткое итоговое резюме (1-2 предложения на русском) — что произошло с прайс-листом в целом.
2. Для каждой строки напиши краткое описание изменения (1 предложение на русском).

Возможные значения action: PRICE_CHANGE (изменение цены), QTY_CHANGE (изменение количества), NO_CHANGE (без изменений), NEW_ITEM (новая позиция), REMOVED_ITEM (позиция удалена).

КРИТИЧНО: Верни ТОЛЬКО валидный JSON-объект без markdown-блоков.

Формат ответа:
{"summary": "...", "descriptions": [{"rowId": "...", "text": "..."}]}`;

    const result = await model.generateContent(prompt);
    const raw = result.response.text().trim();

    const parsed = tryParseJSON(raw);

    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      typeof (parsed as Record<string, unknown>).summary !== "string" ||
      !Array.isArray((parsed as Record<string, unknown>).descriptions)
    ) {
      console.error("[importAnalyzer] generateDescriptions: неожиданный формат:", raw.slice(0, 200));
      return buildFallbackResult(changes, mode);
    }

    const obj = parsed as { summary: string; descriptions: unknown[] };
    const descriptions: ChangeDescription[] = [];

    for (const item of obj.descriptions) {
      if (
        item &&
        typeof item === "object" &&
        typeof (item as Record<string, unknown>).rowId === "string" &&
        typeof (item as Record<string, unknown>).text === "string"
      ) {
        descriptions.push({
          rowId: (item as Record<string, unknown>).rowId as string,
          text: (item as Record<string, unknown>).text as string,
        });
      }
    }

    return {
      summary: obj.summary,
      descriptions,
    };
  } catch (err) {
    console.error("[importAnalyzer] generateDescriptions ошибка:", err);
    return buildFallbackResult(changes, mode);
  }
}

// ──────────────────────────────────────────────────────────────────
// Fallback (без LLM)
// ──────────────────────────────────────────────────────────────────

function buildFallbackResult(changes: ChangeInput[], mode: "OWN_PRICE_UPDATE" | "COMPETITOR_IMPORT"): DescriptionResult {
  const priceChanges = changes.filter((c) => c.action === "PRICE_CHANGE").length;
  const qtyChanges = changes.filter((c) => c.action === "QTY_CHANGE").length;
  const newItems = changes.filter((c) => c.action === "NEW_ITEM").length;
  const removedItems = changes.filter((c) => c.action === "REMOVED_ITEM").length;

  const parts: string[] = [];
  if (priceChanges > 0) parts.push(`изменение цен у ${priceChanges} позиций`);
  if (qtyChanges > 0) parts.push(`изменение количества у ${qtyChanges} позиций`);
  if (newItems > 0) parts.push(`${newItems} новых позиций`);
  if (removedItems > 0) parts.push(`${removedItems} удалённых позиций`);

  const modeLabel = mode === "OWN_PRICE_UPDATE" ? "нашего прайс-листа" : "прайса конкурента";
  const summary = parts.length > 0
    ? `Обновление ${modeLabel}: ${parts.join(", ")}.`
    : `Изменений в ${modeLabel} не обнаружено.`;

  const descriptions: ChangeDescription[] = changes.map((c) => ({
    rowId: c.rowId,
    text: buildFallbackDescription(c),
  }));

  return { summary, descriptions };
}

function buildFallbackDescription(c: ChangeInput): string {
  switch (c.action) {
    case "PRICE_CHANGE": {
      if (c.priceDelta != null) {
        const sign = c.priceDelta > 0 ? "+" : "";
        return `${c.equipmentName}: цена изменилась на ${sign}${c.priceDelta.toFixed(1)}%.`;
      }
      return `${c.equipmentName}: цена изменилась.`;
    }
    case "QTY_CHANGE":
      return `${c.equipmentName}: количество изменилось с ${c.oldQty ?? "?"} до ${c.newQty ?? "?"}.`;
    case "NEW_ITEM":
      return `${c.equipmentName}: новая позиция в прайс-листе.`;
    case "REMOVED_ITEM":
      return `${c.equipmentName}: позиция удалена из прайс-листа.`;
    default:
      return `${c.equipmentName}: без изменений.`;
  }
}
