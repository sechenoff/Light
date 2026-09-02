import { GeminiLlmProvider } from "./gemini";
import { OpenAiLlmProvider, OPENAI_DIRECT_BASE_URL } from "./openai";
import {
  AnthropicLlmProvider,
  ANTHROPIC_EFFORT_LEVELS,
  DEFAULT_ANTHROPIC_MODEL,
  type AnthropicEffort,
} from "./anthropic";
import { FallbackLlmProvider } from "./fallback";
import type { LlmProvider } from "./provider";

let cached: LlmProvider | null = null;

/** Имена ног, которые понимает LLM_PROVIDER / LLM_FALLBACK_CHAIN. */
export const LLM_LEG_NAMES = ["anthropic", "gemini", "openai", "chatmock", "openai-api"] as const;

/** Боевая цепочка по умолчанию: Claude как основная нога, Gemini как страховка. */
export const DEFAULT_FALLBACK_CHAIN = "anthropic,gemini";

function requireEnv(name: string, hint: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} не задан в env (${hint})`);
  return value;
}

function readAnthropicEffort(): AnthropicEffort {
  const raw = (process.env.ANTHROPIC_EFFORT || "low").toLowerCase();
  if (!(ANTHROPIC_EFFORT_LEVELS as readonly string[]).includes(raw)) {
    throw new Error(`ANTHROPIC_EFFORT="${raw}" не поддерживается. Допустимо: ${ANTHROPIC_EFFORT_LEVELS.join(", ")}`);
  }
  return raw as AnthropicEffort;
}

/**
 * OpenAI-совместимая нога по OPENAI_* env. Когда OPENAI_BASE_URL указывает
 * на локальный прокси (ChatMock), ключ не нужен — прокси ходит своей
 * OAuth-сессией; SDK всё равно требует непустую строку, отсюда "unused".
 */
function buildOpenAi(maxRetries: number): OpenAiLlmProvider {
  const baseURL = process.env.OPENAI_BASE_URL;
  const apiKey = process.env.OPENAI_API_KEY || (baseURL ? "unused" : "");
  if (!apiKey) throw new Error("OPENAI_API_KEY не задан в env");
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  return new OpenAiLlmProvider(apiKey, model, baseURL, maxRetries);
}

/**
 * Одна нога по имени. `failFast` — нога не последняя в цепочке: меньше
 * внутренних повторов, чтобы отдать запрос следующей ноге за один round-trip,
 * а не после экспоненциального back-off.
 */
export function buildLlmLeg(name: string, failFast = false): LlmProvider {
  switch (name) {
    case "anthropic":
      return new AnthropicLlmProvider(
        requireEnv("ANTHROPIC_API_KEY", "ключ с console.anthropic.com"),
        process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL,
        { effort: readAnthropicEffort(), maxRetries: failFast ? 1 : 2 },
      );
    case "gemini":
      return new GeminiLlmProvider(
        requireEnv("GEMINI_API_KEY", "ключ Google AI Studio"),
        process.env.GEMINI_MODEL || "gemini-2.5-flash",
      );
    case "openai":
    case "chatmock": // историческое имя ноги через OPENAI_BASE_URL-прокси
      return buildOpenAi(failFast ? 1 : 3);
    case "openai-api":
      // Всегда прямой api.openai.com (или явный OPENAI_FALLBACK_BASE_URL) —
      // свои переменные, чтобы ключ и модель прокси-ноги с ними не путались.
      return new OpenAiLlmProvider(
        requireEnv("OPENAI_FALLBACK_API_KEY", "настоящий ключ api.openai.com для ноги openai-api"),
        process.env.OPENAI_FALLBACK_MODEL || "gpt-4o",
        process.env.OPENAI_FALLBACK_BASE_URL || OPENAI_DIRECT_BASE_URL,
        failFast ? 1 : 3,
      );
    default:
      throw new Error(
        `Неизвестный LLM-провайдер "${name}". Поддерживаются: ${LLM_LEG_NAMES.join(", ")} и fallback (цепочка из LLM_FALLBACK_CHAIN).`,
      );
  }
}

export function getLlmProvider(): LlmProvider {
  if (cached) return cached;

  const providerName = (process.env.LLM_PROVIDER || "gemini").toLowerCase();

  if (providerName === "fallback") {
    const names = (process.env.LLM_FALLBACK_CHAIN || DEFAULT_FALLBACK_CHAIN)
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (names.length < 2) {
      throw new Error(
        "LLM_FALLBACK_CHAIN должен перечислять минимум два провайдера через запятую, например anthropic,gemini",
      );
    }
    cached = new FallbackLlmProvider(
      names.map((name, i) => ({ name, provider: buildLlmLeg(name, i < names.length - 1) })),
    );
    return cached;
  }

  cached = buildLlmLeg(providerName);
  return cached;
}

export {
  type LlmProvider,
  type GafferExtractedLine,
  type GafferDocumentInput,
  type GafferDocumentExtraction,
  type GafferDocumentMeta,
  type GafferDocumentMimeType,
  GAFFER_DOCUMENT_MIME_TYPES,
} from "./provider";

/** For tests: reset cached provider between runs if env vars change. */
export function resetLlmProvider(): void {
  cached = null;
}
