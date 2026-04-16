import { GeminiLlmProvider } from "./gemini";
import { OpenAiLlmProvider } from "./openai";
import type { LlmProvider } from "./provider";

let cached: LlmProvider | null = null;

export function getLlmProvider(): LlmProvider {
  if (cached) return cached;

  const providerName = (process.env.LLM_PROVIDER || "gemini").toLowerCase();

  if (providerName === "openai") {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY не задан в env");
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    cached = new OpenAiLlmProvider(apiKey, model);
    return cached;
  }

  if (providerName === "gemini") {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY не задан в env");
    const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
    cached = new GeminiLlmProvider(apiKey, model);
    return cached;
  }

  throw new Error(`Неизвестный LLM_PROVIDER="${providerName}". Поддерживаются: gemini, openai.`);
}

export { type LlmProvider, type GafferExtractedLine } from "./provider";

/** For tests: reset cached provider between runs if env vars change. */
export function resetLlmProvider(): void {
  cached = null;
}
