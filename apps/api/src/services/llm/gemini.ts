import { GoogleGenerativeAI } from "@google/generative-ai";
import { type LlmProvider, type GafferExtractedLine, EXTRACT_PROMPT_REVIEW, normalizeRawLines } from "./provider";

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

export class GeminiLlmProvider implements LlmProvider {
  private client: GoogleGenerativeAI;
  private model: string;

  constructor(apiKey: string, model: string = "gemini-2.5-flash") {
    this.client = new GoogleGenerativeAI(apiKey);
    this.model = model;
  }

  async extractGafferLines(text: string): Promise<GafferExtractedLine[]> {
    const geminiModel = this.client.getGenerativeModel({
      model: this.model,
      generationConfig: {
        maxOutputTokens: 8192,
        responseMimeType: "application/json",
      },
    });

    let raw = "";
    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        const result = await geminiModel.generateContent(EXTRACT_PROMPT_REVIEW + text);
        raw = readGeminiText(result);
        break;
      } catch (err: unknown) {
        const status = (err as { status?: number; response?: { status?: number } })?.status
          ?? (err as { status?: number; response?: { status?: number } })?.response?.status;
        if ((status === 503 || status === 429) && attempt < 2) {
          await new Promise((r) => setTimeout(r, (attempt + 1) * 2000));
          continue;
        }
        throw err;
      }
    }

    console.log(`[parse-gaffer] raw response length=${raw.length}, last 50: ...${raw.slice(-50)}`);

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const mdMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (mdMatch?.[1]) {
        try {
          parsed = JSON.parse(mdMatch[1].trim());
        } catch {
          // fall through to next strategy
        }
      }
      if (!parsed) {
        const arrMatch = raw.match(/\[[\s\S]*\]/);
        if (arrMatch) {
          try {
            parsed = JSON.parse(arrMatch[0]);
          } catch {
            // fall through to next strategy
          }
        }
      }
      // Попытка починить обрезанный JSON: закрыть незавершённые структуры
      if (!parsed && raw.startsWith("[")) {
        const lastComplete = raw.lastIndexOf("}");
        if (lastComplete > 0) {
          try {
            parsed = JSON.parse(raw.slice(0, lastComplete + 1) + "]");
            console.log(`[parse-gaffer] repaired truncated JSON, recovered array`);
          } catch {
            // give up
          }
        }
      }
    }

    if (!Array.isArray(parsed) && !(parsed && typeof parsed === "object" && "items" in parsed)) {
      console.warn(`[parse-gaffer] failed to parse as array, raw start: ${raw.slice(0, 200)}`);
      return [];
    }

    return normalizeRawLines(parsed);
  }
}
