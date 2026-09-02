import { GoogleGenerativeAI, type Part } from "@google/generative-ai";
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

function readGeminiText(result: {
  response: {
    text: () => string;
    candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string }> } }>;
  };
}): string {
  try {
    return result.response.text();
  } catch (first: unknown) {
    const c = result.response.candidates?.[0];
    const reason = c?.finishReason;
    if (reason && reason !== "STOP") {
      throw new Error(`Gemini завершила ответ со статусом ${reason}`);
    }
    const parts = c?.content?.parts;
    if (Array.isArray(parts)) {
      const joined = parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
      if (joined.trim()) return joined;
    }
    const msg = first instanceof Error ? first.message : String(first);
    throw new Error(`Пустой ответ AI: ${msg}`);
  }
}

/**
 * JSON-режим Gemini не абсолютен: ответ бывает в ```json-заборе, с преамбулой
 * или обрезан по лимиту токенов. Пробуем стратегии по убыванию строгости;
 * `undefined` — не удалось ничего.
 */
export function parseLooseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // fall through
  }
  const mdMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (mdMatch?.[1]) {
    try {
      return JSON.parse(mdMatch[1].trim());
    } catch {
      // fall through
    }
  }
  const blockMatch = raw.match(/[[{][\s\S]*[\]}]/);
  if (blockMatch) {
    try {
      return JSON.parse(blockMatch[0]);
    } catch {
      // fall through
    }
  }
  // Обрезанный массив: закрываем на последнем целом объекте.
  if (raw.trimStart().startsWith("[")) {
    const lastComplete = raw.lastIndexOf("}");
    if (lastComplete > 0) {
      try {
        const repaired = JSON.parse(raw.slice(0, lastComplete + 1) + "]");
        console.log("[parse-gaffer] repaired truncated JSON, recovered array");
        return repaired;
      } catch {
        // give up
      }
    }
  }
  return undefined;
}

export class GeminiLlmProvider implements LlmProvider {
  private client: GoogleGenerativeAI;
  private model: string;

  constructor(apiKey: string, model: string = "gemini-2.5-flash") {
    this.client = new GoogleGenerativeAI(apiKey);
    this.model = model;
  }

  /** Один вызов с повтором на 429/503 — общий для текста и документов. */
  private async generate(parts: Array<string | Part>, maxOutputTokens: number): Promise<string> {
    const geminiModel = this.client.getGenerativeModel({
      model: this.model,
      generationConfig: {
        maxOutputTokens,
        responseMimeType: "application/json",
      },
    });

    let lastError: unknown;
    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        const result = await geminiModel.generateContent(parts);
        return readGeminiText(result);
      } catch (err: unknown) {
        lastError = err;
        const status = (err as { status?: number; response?: { status?: number } })?.status
          ?? (err as { status?: number; response?: { status?: number } })?.response?.status;
        if ((status === 503 || status === 429) && attempt < 2) {
          await new Promise((r) => setTimeout(r, (attempt + 1) * 2000));
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  async extractGafferLines(text: string): Promise<GafferExtractedLine[]> {
    const raw = await this.generate([EXTRACT_PROMPT_REVIEW + text], 8192);
    console.log(`[parse-gaffer] raw response length=${raw.length}, last 50: ...${raw.slice(-50)}`);

    const parsed = parseLooseJson(raw);
    if (!Array.isArray(parsed) && !(parsed && typeof parsed === "object" && "items" in parsed)) {
      console.warn(`[parse-gaffer] failed to parse as array, raw start: ${raw.slice(0, 200)}`);
      return [];
    }

    return normalizeRawLines(parsed);
  }

  async extractGafferDocument(doc: GafferDocumentInput): Promise<GafferDocumentExtraction> {
    const raw = await this.generate(
      [{ inlineData: { mimeType: doc.mimeType, data: doc.data.toString("base64") } }, EXTRACT_DOCUMENT_PROMPT],
      16384,
    );
    console.log(`[parse-gaffer-document] gemini raw length=${raw.length}`);

    const parsed = parseLooseJson(raw);
    if (!parsed || typeof parsed !== "object") {
      // Документ без единой позиции — не «пусто», а сбой чтения: пусть цепочка
      // попробует другую ногу, а маршрут честно ответит 503.
      throw new Error(`Gemini ответила не JSON: ${raw.slice(0, 120)}`);
    }
    return normalizeDocumentExtraction(parsed);
  }
}
