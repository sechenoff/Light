import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
// zod/v4: helper zodOutputFormat из SDK принимает только схемы v4-API (у v3 нет _zod.def).
import { z } from "zod/v4";
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

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5";

export const ANTHROPIC_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AnthropicEffort = (typeof ANTHROPIC_EFFORT_LEVELS)[number];

export type AnthropicLlmOptions = {
  /**
   * Глубина размышления модели. Разбор списка приборов — задача на аккуратность,
   * а не на рассуждение, поэтому по умолчанию `low`: тот же результат, но
   * заметно быстрее и дешевле, чем дефолтный `high`.
   */
  effort?: AnthropicEffort;
  /** Повторы SDK на 429/5xx/обрыве соединения (default 2). */
  maxRetries?: number;
  /** Таймаут одного запроса, мс (default 60 000 — заявку ждёт живой человек). */
  timeoutMs?: number;
};

/**
 * Позиции — единственный ключ `items`: structured output требует объект на
 * верхнем уровне, а normalizeRawLines эту форму уже понимает.
 */
const LinesOutput = z.object({
  items: z.array(
    z.object({
      gafferPhrase: z.string(),
      interpretedName: z.string(),
      quantity: z.number().int(),
    }),
  ),
});

const DocumentOutput = z.object({
  projectName: z.string().nullable(),
  gafferName: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  telegram: z.string().nullable(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  items: LinesOutput.shape.items,
});

const LINES_SUFFIX = '\n\nВерни объект с единственным ключом "items" — массивом позиций.';

/** Ровно то, что нам нужно от ответа `messages.parse` — чтобы тесты могли подсунуть заглушку. */
type ParsedLike = {
  stop_reason: string | null;
  parsed_output: unknown;
  content: Array<{ type: string; text?: string }>;
};

/**
 * Structured output гарантирует форму, но не гарантирует, что ответ вообще
 * дошёл до конца: обрезка по max_tokens или отказ классификатора приходят
 * с HTTP 200. Такие ответы — ошибка ноги, а не «пустая заявка»: бросаем,
 * чтобы цепочка fallback передала запрос следующему провайдеру.
 */
function extractPayload(message: ParsedLike): unknown {
  if (message.stop_reason === "refusal") {
    throw new Error("Claude отказался обрабатывать запрос (stop_reason=refusal)");
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error("Ответ Claude обрезан по max_tokens");
  }
  if (message.parsed_output !== null && message.parsed_output !== undefined) {
    return message.parsed_output;
  }
  // parsed_output пуст — SDK не смог разобрать; пробуем текст как есть.
  const text = message.content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!text) throw new Error("Пустой ответ Claude");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Claude ответил не JSON: ${text.slice(0, 120)}`);
  }
}

export class AnthropicLlmProvider implements LlmProvider {
  private client: Anthropic;
  private model: string;
  private effort: AnthropicEffort;

  constructor(apiKey: string, model: string = DEFAULT_ANTHROPIC_MODEL, opts: AnthropicLlmOptions = {}) {
    this.client = new Anthropic({
      apiKey,
      maxRetries: opts.maxRetries ?? 2,
      timeout: opts.timeoutMs ?? 60_000,
    });
    this.model = model;
    this.effort = opts.effort ?? "low";
  }

  async extractGafferLines(text: string): Promise<GafferExtractedLine[]> {
    // thinking не задаём: на claude-opus-5 по умолчанию adaptive, глубину
    // регулирует effort. Server-side fallbacks на отказ классификатора не
    // включаем: у приложения своя страховочная нога (Gemini) в FallbackLlmProvider.
    const message = await this.client.messages.parse({
      model: this.model,
      max_tokens: 8192,
      system: EXTRACT_PROMPT_REVIEW + LINES_SUFFIX,
      messages: [{ role: "user", content: text }],
      output_config: { effort: this.effort, format: zodOutputFormat(LinesOutput) },
    });
    return normalizeRawLines(extractPayload(message));
  }

  async extractGafferDocument(doc: GafferDocumentInput): Promise<GafferDocumentExtraction> {
    const data = doc.data.toString("base64");
    const attachment: Anthropic.ContentBlockParam =
      doc.mimeType === "application/pdf"
        ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
        : { type: "image", source: { type: "base64", media_type: doc.mimeType, data } };

    const message = await this.client.messages.parse({
      model: this.model,
      // Заявка на две страницы — это 60–80 строк; с запасом на длинные названия.
      max_tokens: 16000,
      system: EXTRACT_DOCUMENT_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            attachment,
            {
              type: "text",
              text: doc.fileName
                ? `Заявка из файла «${doc.fileName}». Извлеки данные по инструкции.`
                : "Извлеки данные из этой заявки по инструкции.",
            },
          ],
        },
      ],
      output_config: { effort: this.effort, format: zodOutputFormat(DocumentOutput) },
    });
    return normalizeDocumentExtraction(extractPayload(message));
  }
}
