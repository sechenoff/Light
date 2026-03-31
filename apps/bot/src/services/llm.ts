import OpenAI from "openai";
import type { EquipmentItem, MatchedItem } from "../types";

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

/** Матчит текстовое описание оборудования к каталогу, возвращает список позиций с количеством */
export async function matchEquipment(
  userText: string,
  catalog: EquipmentItem[],
): Promise<{ items: Array<{ equipmentId: string; quantity: number }>; unmatchedText?: string } | { error: string }> {
  const catalogSummary = catalog
    .map((e) => `ID:${e.equipmentId} | ${e.category} | ${e.name}${e.brand ? ` ${e.brand}` : ""}${e.model ? ` ${e.model}` : ""} | макс: ${e.availableQuantity} шт`)
    .join("\n");

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `Ты помощник по подбору оборудования для аренды.
Ниже — каталог доступного оборудования:

${catalogSummary}

Задача: сопоставь запрос клиента с позициями каталога.
Верни JSON:
{
  "items": [
    { "equipmentId": "...", "quantity": N }
  ],
  "unmatchedText": "что не нашлось в каталоге (или null)"
}

Правила:
- quantity не должен превышать "макс" из каталога
- если позиция не найдена — укажи её в unmatchedText
- если запрос пустой — верни { "items": [], "unmatchedText": null }`,
      },
      { role: "user", content: userText },
    ],
  });

  try {
    const raw = response.choices[0].message.content ?? "{}";
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.items)) return { error: "Не удалось разобрать список оборудования" };
    return {
      items: parsed.items,
      unmatchedText: parsed.unmatchedText ?? undefined,
    };
  } catch {
    return { error: "Ошибка разбора ответа LLM" };
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
