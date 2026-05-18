import { GeminiLlmProvider } from "./gemini";
import { OpenAiLlmProvider } from "./openai";
import { FallbackLlmProvider } from "./fallback";
import type { LlmProvider } from "./provider";

let cached: LlmProvider | null = null;

/**
 * Build the ChatMock / proxy OpenAI-compatible leg from OPENAI_* env vars.
 * When OPENAI_BASE_URL points to a local proxy (ChatMock), the API key is
 * not needed — the proxy uses its own OAuth session.
 */
function buildOpenAiPrimary(maxRetries = 3): OpenAiLlmProvider {
  const baseURL = process.env.OPENAI_BASE_URL;
  // Sentinel "unused": ChatMock-style local proxies authenticate via their
  // own OAuth session, so no real key is needed when OPENAI_BASE_URL is set.
  // The OpenAI SDK still requires a non-empty string, hence "unused".
  const apiKey = process.env.OPENAI_API_KEY || (baseURL ? "unused" : "");
  if (!apiKey) throw new Error("OPENAI_API_KEY не задан в env");
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  return new OpenAiLlmProvider(apiKey, model, baseURL, maxRetries);
}

export function getLlmProvider(): LlmProvider {
  if (cached) return cached;

  const providerName = (process.env.LLM_PROVIDER || "gemini").toLowerCase();

  if (providerName === "openai") {
    cached = buildOpenAiPrimary();
    return cached;
  }

  if (providerName === "fallback") {
    // Leg 1 — ChatMock (free, ChatGPT Plus session) via OPENAI_BASE_URL.
    // maxRetries=1: fail fast so a ChatMock 429 hands off to the reliable
    // leg in ~1 round-trip instead of ~7s of exponential back-off.
    const primary = buildOpenAiPrimary(1);
    // Leg 2 — direct api.openai.com (billed, reliable). Distinct env vars so
    // the fallback key/model never collide with the ChatMock leg's config.
    const fbKey = process.env.OPENAI_FALLBACK_API_KEY;
    if (!fbKey) {
      throw new Error(
        'OPENAI_FALLBACK_API_KEY не задан в env (требуется при LLM_PROVIDER=fallback — это реальный ключ api.openai.com)'
      );
    }
    const fbModel = process.env.OPENAI_FALLBACK_MODEL || "gpt-4o";
    // No baseURL → SDK goes directly to api.openai.com.
    const fallback = new OpenAiLlmProvider(fbKey, fbModel);
    cached = new FallbackLlmProvider([
      { name: "chatmock", provider: primary },
      { name: "openai-api", provider: fallback },
    ]);
    return cached;
  }

  if (providerName === "gemini") {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY не задан в env");
    const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
    cached = new GeminiLlmProvider(apiKey, model);
    return cached;
  }

  throw new Error(`Неизвестный LLM_PROVIDER="${providerName}". Поддерживаются: gemini, openai, fallback.`);
}

export { type LlmProvider, type GafferExtractedLine } from "./provider";

/** For tests: reset cached provider between runs if env vars change. */
export function resetLlmProvider(): void {
  cached = null;
}
