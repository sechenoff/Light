import OpenAI from "openai";
import {
  type LlmProvider,
  type GafferExtractedLine,
  type GafferDocumentInput,
  type GafferDocumentExtraction,
  EXTRACT_PROMPT_REVIEW,
  EXTRACT_DOCUMENT_PROMPT,
  normalizeRawLines,
  normalizeDocumentExtraction,
} from "./provider";

/** Прямой endpoint OpenAI — сюда идёт нога без прокси. */
export const OPENAI_DIRECT_BASE_URL = "https://api.openai.com/v1";

const JSON_MODE_SUFFIX = "\n\nОтвет верни в виде JSON-объекта с ключом \"items\" — массивом позиций.";

/**
 * JSON Schema для strict structured output. Правила strict-режима OpenAI:
 * каждое поле в `required`, `additionalProperties: false`, а «может быть
 * null» — это тип `["string", "null"]`, а не отсутствие поля.
 */
const LINE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["gafferPhrase", "interpretedName", "quantity"],
  properties: {
    gafferPhrase: { type: "string" },
    interpretedName: { type: "string" },
    quantity: { type: "integer" },
  },
};
const NULLABLE_STRING = { type: ["string", "null"] };

export const OPENAI_LINES_FORMAT: OpenAI.ResponseFormatJSONSchema = {
  type: "json_schema",
  json_schema: {
    name: "gaffer_lines",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["items"],
      properties: { items: { type: "array", items: LINE_SCHEMA } },
    },
  },
};

export const OPENAI_DOCUMENT_FORMAT: OpenAI.ResponseFormatJSONSchema = {
  type: "json_schema",
  json_schema: {
    name: "gaffer_document",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["projectName", "gafferName", "phone", "email", "telegram", "startDate", "endDate", "items"],
      properties: {
        projectName: NULLABLE_STRING,
        gafferName: NULLABLE_STRING,
        phone: NULLABLE_STRING,
        email: NULLABLE_STRING,
        telegram: NULLABLE_STRING,
        startDate: NULLABLE_STRING,
        endDate: NULLABLE_STRING,
        items: { type: "array", items: LINE_SCHEMA },
      },
    },
  },
};

/**
 * Некоторые прокси (ChatMock, проксирующий gpt-5.x reasoning-модели из
 * ChatGPT Plus подписки) возвращают reasoning-трейс в виде `<think>...</think>`
 * блока ПЕРЕД фактическим JSON-ответом. `JSON.parse` на таком выводе падает.
 * Срезаем все такие блоки, после этого парсим.
 */
function stripReasoningTags(raw: string): string {
  return raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

/**
 * OpenAI (или OpenAI-совместимый endpoint). Текст и документы — оба через
 * strict structured output, поэтому «проза вместо JSON» отсекается схемой.
 *
 * Параметры запроса рассчитаны на gpt-5.x: `max_completion_tokens`, а не
 * `max_tokens` (второй эти модели отвергают с 400), и без `temperature`
 * (reasoning-модели принимают только значение по умолчанию). gpt-4o / 4.1
 * тот же набор параметров тоже понимают.
 */
export class OpenAiLlmProvider implements LlmProvider {
  private client: OpenAI;
  private model: string;
  private maxRetries: number;

  /**
   * @param baseURL endpoint; если не передан — ВСЕГДА прямой api.openai.com.
   *   Раньше при пустом baseURL опция не передавалась вовсе, а SDK в этом случае
   *   сам читает OPENAI_BASE_URL из env — и «прямая» нога fallback-цепочки
   *   молча уходила в тот же ChatMock, что и первая. В логах за всё время
   *   не было ни одного успешного переключения на неё.
   * @param maxRetries internal retry attempts on 429/5xx (default 3).
   *   Pass 1 when this provider is a non-final leg of a FallbackLlmProvider:
   *   the fallback chain is the retry strategy, so failing fast (one attempt,
   *   no exponential back-off) hands off to the next leg in ~1 round-trip.
   */
  constructor(apiKey: string, model: string = "gpt-4o-mini", baseURL?: string, maxRetries = 3) {
    this.client = new OpenAI({ apiKey, baseURL: baseURL || OPENAI_DIRECT_BASE_URL });
    this.model = model;
    this.maxRetries = Math.max(1, maxRetries);
  }

  /** Куда реально уходят запросы — для логов и регрессионного теста. */
  get baseURL(): string {
    return this.client.baseURL;
  }

  /**
   * Один вызов с повтором на 429/5xx. Отказ модели (`refusal`) и обрезка по
   * лимиту — ошибка ноги: цепочка должна попробовать следующую, а не принять
   * пустой или обрезанный список за ответ.
   */
  private async complete(params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const response = await this.client.chat.completions.create(params);
        const choice = response.choices[0];
        if (!choice) throw new Error("OpenAI вернул ответ без choices");
        if (choice.message.refusal) {
          throw new Error(`OpenAI отказался обрабатывать запрос: ${choice.message.refusal.slice(0, 120)}`);
        }
        if (choice.finish_reason === "length") {
          throw new Error("Ответ OpenAI обрезан по max_completion_tokens");
        }
        return stripReasoningTags(choice.message.content ?? "");
      } catch (err: unknown) {
        lastError = err;
        const status = (err as { status?: number; response?: { status?: number } })?.status
          ?? (err as { status?: number; response?: { status?: number } })?.response?.status;
        if (status !== undefined && (status === 429 || status >= 500) && attempt < this.maxRetries - 1) {
          await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  async extractGafferLines(text: string): Promise<GafferExtractedLine[]> {
    const content = await this.complete({
      model: this.model,
      messages: [
        { role: "system", content: EXTRACT_PROMPT_REVIEW + JSON_MODE_SUFFIX },
        { role: "user", content: text },
      ],
      response_format: OPENAI_LINES_FORMAT,
      max_completion_tokens: 4096,
    });
    if (!content) return [];
    return normalizeRawLines(JSON.parse(content) as unknown);
  }

  async extractGafferDocument(doc: GafferDocumentInput): Promise<GafferDocumentExtraction> {
    const data = doc.data.toString("base64");
    // PDF уходит file-частью (имя — латиницей, чтобы не упереться в кодировку),
    // фото — image_url с data-URL. Оба формата читают gpt-4o+ и gpt-5.x.
    const attachment: OpenAI.Chat.Completions.ChatCompletionContentPart =
      doc.mimeType === "application/pdf"
        ? { type: "file", file: { filename: "document.pdf", file_data: `data:application/pdf;base64,${data}` } }
        : { type: "image_url", image_url: { url: `data:${doc.mimeType};base64,${data}`, detail: "high" } };

    const content = await this.complete({
      model: this.model,
      messages: [
        { role: "system", content: EXTRACT_DOCUMENT_PROMPT },
        {
          role: "user",
          content: [attachment, { type: "text", text: "Извлеки данные из этой заявки по инструкции." }],
        },
      ],
      response_format: OPENAI_DOCUMENT_FORMAT,
      max_completion_tokens: 16000,
    });

    if (!content) throw new Error("Пустой ответ OpenAI на документ");
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error(`OpenAI ответил не JSON: ${content.slice(0, 120)}`);
    }
    return normalizeDocumentExtraction(parsed);
  }
}
