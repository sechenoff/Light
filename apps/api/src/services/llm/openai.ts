import OpenAI from "openai";
import { type LlmProvider, type GafferExtractedLine, EXTRACT_PROMPT_REVIEW, normalizeRawLines } from "./provider";

const JSON_MODE_SUFFIX = "\n\nОтвет верни в виде JSON-объекта с ключом \"items\" — массивом позиций.";

/**
 * Некоторые прокси (ChatMock, проксирующий gpt-5.x reasoning-модели из
 * ChatGPT Plus подписки) возвращают reasoning-трейс в виде `<think>...</think>`
 * блока ПЕРЕД фактическим JSON-ответом. `JSON.parse` на таком выводе падает.
 * Срезаем все такие блоки, после этого парсим.
 */
function stripReasoningTags(raw: string): string {
  return raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

export class OpenAiLlmProvider implements LlmProvider {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string = "gpt-4o-mini", baseURL?: string) {
    this.client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
    this.model = model;
  }

  async extractGafferLines(text: string): Promise<GafferExtractedLine[]> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await this.client.chat.completions.create({
          model: this.model,
          messages: [
            { role: "system", content: EXTRACT_PROMPT_REVIEW + JSON_MODE_SUFFIX },
            { role: "user", content: text },
          ],
          response_format: { type: "json_object" },
          max_tokens: 4096,
          temperature: 0,
        });
        const content = response.choices[0]?.message?.content ?? "";
        if (!content) return [];
        const cleaned = stripReasoningTags(content);
        if (!cleaned) return [];
        const parsed = JSON.parse(cleaned) as unknown;
        return normalizeRawLines(parsed);
      } catch (err: unknown) {
        lastError = err;
        const status = (err as { status?: number; response?: { status?: number } })?.status
          ?? (err as { status?: number; response?: { status?: number } })?.response?.status;
        if (status !== undefined && (status === 429 || status === 503 || status >= 500)) {
          await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }
}
