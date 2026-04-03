import OpenAI from "openai";
import type { MatchedItem } from "../types";
import { parseGafferReview, matchEquipmentItems, type GafferReviewItem } from "./api";

export type ResolvedItem = {
  equipmentId: string;
  quantity: number;
  catalogName: string;
  category: string;
  availableQuantity: number;
  rentalRatePerShift: string;
};

export type MatchResult = {
  resolved: ResolvedItem[];
  needsReview: GafferReviewItem[];
  unmatched: string[];
};

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: 30_000,   // 30 секунд — не даём зависнуть на крупных запросах
  maxRetries: 0,     // не повторяем автоматически в контексте бота
});

/** Парсит произвольный текст с датами → { startDate, endDate } в ISO или null */
export async function parseDates(
  userText: string,
  today: string,
): Promise<{ startDate: string; endDate: string } | { error: string }> {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `Сегодняшняя дата: ${today}.
Ты извлекаешь диапазон дат из текста на русском языке.
Верни JSON: { "startDate": "YYYY-MM-DD", "endDate": "YYYY-MM-DD" }
Если текст содержит только одну дату — используй её как startDate, а endDate = startDate + 1 день.
Если не удаётся определить даты — верни { "error": "описание проблемы" }.
Всегда возвращай только JSON без комментариев.`,
      },
      { role: "user", content: userText },
    ],
  });

  try {
    const raw = response.choices[0].message.content ?? "{}";
    const parsed = JSON.parse(raw);
    if (parsed.error) return { error: parsed.error };
    if (!parsed.startDate || !parsed.endDate) return { error: "Не удалось определить даты" };
    return { startDate: parsed.startDate, endDate: parsed.endDate };
  } catch {
    return { error: "Ошибка разбора ответа LLM" };
  }
}

const EXTRACT_EQUIPMENT_PROMPT = `Ты парсер списков оборудования для компании аренды осветительной техники.

Извлеки ВСЕ позиции оборудования из текста гаффера.

Для каждой позиции верни JSON-объект с полями:
- gafferPhrase: точная цитата из текста (включая числа на той же строке, например "2x 52xt"). Если невозможно — кратчайшая верная цитата.
- interpretedName: короткое нормализованное название оборудования для поиска по каталогу (латиница/бренд/модель, например "52xt", "nova p300"). Количество НЕ включать.
- quantity: целое число, по умолчанию 1 если не указано.

КРИТИЧЕСКИ ВАЖНО: верни ТОЛЬКО валидный JSON-массив. Без markdown, без лишнего текста.

Пример:
[
  { "gafferPhrase": "2 шт 52xt blair", "interpretedName": "52xt", "quantity": 2 },
  { "gafferPhrase": "nova p300 с софтом", "interpretedName": "nova p300", "quantity": 1 }
]

Если позиции оборудования не найдены — верни пустой массив: []

Текст гаффера:
`;

type ExtractedEquipmentItem = {
  gafferPhrase: string;
  interpretedName: string;
  quantity: number;
};

/**
 * Извлекает позиции оборудования из произвольного текста через OpenAI.
 */
async function extractEquipmentItems(text: string): Promise<ExtractedEquipmentItem[]> {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: "Верни результат в виде JSON-объекта с полем \"items\", содержащим массив позиций оборудования.",
      },
      {
        role: "user",
        content: EXTRACT_EQUIPMENT_PROMPT + text,
      },
    ],
  });

  try {
    const raw = response.choices[0].message.content ?? "{}";
    const parsed = JSON.parse(raw);

    // Поддержка форматов: { items: [...] } или напрямую [...]
    const arr: unknown[] = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.items) ? parsed.items : []);

    const result: ExtractedEquipmentItem[] = [];
    for (const row of arr) {
      if (typeof row !== "object" || row === null) continue;
      const r = row as Record<string, unknown>;
      const interpretedName = (typeof r.interpretedName === "string" ? r.interpretedName : (typeof r.name === "string" ? r.name : "")).trim();
      if (!interpretedName) continue;
      const gafferPhrase = (typeof r.gafferPhrase === "string" ? r.gafferPhrase : interpretedName).trim() || interpretedName;
      const rawQty = r.quantity;
      const qty = typeof rawQty === "number" && rawQty > 0 ? Math.round(rawQty) : 1;
      result.push({ gafferPhrase, interpretedName, quantity: qty });
    }
    return result;
  } catch {
    return [];
  }
}

/**
 * Матчит текстовое описание оборудования к каталогу:
 * 1. OpenAI извлекает позиции из текста гаффера
 * 2. API match-equipment сопоставляет с каталогом без LLM
 */
export async function matchEquipment(
  userText: string,
): Promise<MatchResult | { error: string }> {
  try {
    let extracted: ExtractedEquipmentItem[];
    try {
      extracted = await extractEquipmentItems(userText);
    } catch (e) {
      console.error("[matchEquipment] OpenAI extraction failed:", e);
      return { error: "AI временно недоступен. Используйте ручной режим добавления оборудования." };
    }

    if (extracted.length === 0) {
      return { resolved: [], needsReview: [], unmatched: [] };
    }

    const response = await matchEquipmentItems(
      extracted.map((item) => ({
        name: item.interpretedName,
        quantity: item.quantity,
        gafferPhrase: item.gafferPhrase,
      })),
    );

    if (response.error) {
      return { error: response.error };
    }

    const resolved: ResolvedItem[] = [];
    const needsReview: GafferReviewItem[] = [];
    const unmatched: string[] = [];

    for (const item of response.items) {
      if (item.match.kind === "resolved") {
        resolved.push({
          equipmentId: item.match.equipmentId,
          quantity: Math.min(item.quantity, item.match.availableQuantity),
          catalogName: item.match.catalogName,
          category: item.match.category,
          availableQuantity: item.match.availableQuantity,
          rentalRatePerShift: item.match.rentalRatePerShift,
        });
      } else if (item.match.kind === "needsReview") {
        needsReview.push(item);
      } else {
        unmatched.push(item.gafferPhrase);
      }
    }

    return { resolved, needsReview, unmatched };
  } catch (e) {
    if (e instanceof Error) return { error: e.message };
    return { error: "Ошибка при разборе запроса" };
  }
}

/** Парсит произвольный запрос пользователя внутри категории каталога */
export async function parseCatalogIntent(
  userText: string,
  categoryItems: Array<{ idx: number; name: string; model: string | null }>,
  cartItems: MatchedItem[],
): Promise<{
  add: Array<{ idx: number; qty: number }>;
  remove: Array<{ name: string }>;
  unclear: string[];
}> {
  const catalogStr = categoryItems
    .map((i) => `${i.idx}. ${i.name}${i.model ? ` ${i.model}` : ""}`)
    .join("\n");
  const cartStr = cartItems.length
    ? cartItems.map((i, n) => `${n + 1}. ${i.name} × ${i.quantity} шт`).join("\n")
    : "(пусто)";

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `Ты помощник для выбора оборудования из каталога аренды осветительной техники.

Доступные позиции текущей категории:
${catalogStr}

Текущий выбранный список (корзина):
${cartStr}

Пользователь пишет что добавить или удалить. Определи его намерения.

Правила:
- "add": добавить позиции из каталога категории; idx — номер из КАТАЛОГА выше; qty=1 если количество не указано.
- "remove": удалить позиции из КОРЗИНЫ по имени или части имени.
- "unclear": фразы, которые не удалось сопоставить ни с каталогом, ни с командой удаления.
- Распознавай сокращения, части названий, опечатки, транслит.
- Числа прописью: один/одна=1, два/две=2, три=3, четыре=4, пять=5, шесть=6, семь=7, восемь=8, девять=9, десять=10.
- Слова «удали», «убери», «удалить», «убрать» означают remove.
- Если количество явно не указано — qty=1.

Верни ТОЛЬКО JSON:
{"add":[{"idx":N,"qty":N}],"remove":[{"name":"..."}],"unclear":["..."]}`,
      },
      { role: "user", content: userText },
    ],
  });

  try {
    const raw = JSON.parse(response.choices[0].message.content ?? "{}");
    return {
      add: Array.isArray(raw.add) ? raw.add.filter((x: unknown) => typeof x === "object" && x !== null) : [],
      remove: Array.isArray(raw.remove) ? raw.remove.filter((x: unknown) => typeof x === "object" && x !== null) : [],
      unclear: Array.isArray(raw.unclear) ? raw.unclear.map(String) : [],
    };
  } catch {
    return { add: [], remove: [], unclear: [userText] };
  }
}

/** Финальная LLM-проверка всей брони перед подтверждением */
export async function validateBookingSummary(args: {
  clientName: string;
  projectName: string;
  startDate: string;
  endDate: string;
  items: MatchedItem[];
}): Promise<{ ok: true; summary: string } | { ok: false; issues: string }> {
  const itemsList = args.items
    .map((i) => `- ${i.name} × ${i.quantity} шт (доступно: ${i.availableQuantity})`)
    .join("\n");

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `Ты проверяешь заявку на аренду оборудования.
Верни JSON: { "ok": true, "summary": "краткое подтверждение на русском" }
или { "ok": false, "issues": "что не так" }

Проверяй:
- дата окончания не раньше даты начала
- количество не превышает доступное
- список оборудования не пустой`,
      },
      {
        role: "user",
        content: `Клиент: ${args.clientName}
Проект: ${args.projectName}
Период: ${args.startDate} — ${args.endDate}
Оборудование:
${itemsList}`,
      },
    ],
  });

  try {
    const raw = response.choices[0].message.content ?? "{}";
    return JSON.parse(raw);
  } catch {
    return { ok: true, summary: "Заявка выглядит корректно." };
  }
}
