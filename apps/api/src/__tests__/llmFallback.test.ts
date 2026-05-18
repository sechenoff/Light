/**
 * Unit tests for FallbackLlmProvider — automatic provider switchover.
 * Тесты автопереключения LLM-провайдера (ChatMock → OpenAI API).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { FallbackLlmProvider } from "../services/llm/fallback";
import { getLlmProvider, resetLlmProvider } from "../services/llm";
import type { LlmProvider, GafferExtractedLine } from "../services/llm/provider";

const LINE: GafferExtractedLine = { gafferPhrase: "52xt", interpretedName: "52xt", quantity: 1 };

function ok(lines: GafferExtractedLine[]): LlmProvider {
  return { extractGafferLines: vi.fn(async () => lines) };
}
function fail(err: unknown): LlmProvider {
  return {
    extractGafferLines: vi.fn(async () => {
      throw err;
    }),
  };
}

describe("FallbackLlmProvider", () => {
  it("returns primary result and does NOT call fallback when primary succeeds", async () => {
    const primary = ok([LINE]);
    const fallback = ok([]);
    const fb = new FallbackLlmProvider([
      { name: "primary", provider: primary },
      { name: "fallback", provider: fallback },
    ]);

    const res = await fb.extractGafferLines("2 prib 52xt");

    expect(res).toEqual([LINE]);
    expect(primary.extractGafferLines).toHaveBeenCalledTimes(1);
    expect(fallback.extractGafferLines).not.toHaveBeenCalled();
  });

  it("falls back to second provider when primary throws", async () => {
    const primary = fail(Object.assign(new Error("429 usage limit"), { status: 429 }));
    const fallback = ok([LINE]);
    const fb = new FallbackLlmProvider([
      { name: "chatmock", provider: primary },
      { name: "openai", provider: fallback },
    ]);

    const res = await fb.extractGafferLines("text");

    expect(res).toEqual([LINE]);
    expect(primary.extractGafferLines).toHaveBeenCalledTimes(1);
    expect(fallback.extractGafferLines).toHaveBeenCalledTimes(1);
  });

  it("falls back when primary returns an empty array (treated as failure to recognize)", async () => {
    const primary = ok([]);
    const fallback = ok([LINE]);
    const fb = new FallbackLlmProvider([
      { name: "chatmock", provider: primary },
      { name: "openai", provider: fallback },
    ]);

    const res = await fb.extractGafferLines("text");

    expect(res).toEqual([LINE]);
    expect(fallback.extractGafferLines).toHaveBeenCalledTimes(1);
  });

  it("returns empty array from the LAST provider without error (legit 'no equipment')", async () => {
    const primary = ok([]);
    const fallback = ok([]);
    const fb = new FallbackLlmProvider([
      { name: "chatmock", provider: primary },
      { name: "openai", provider: fallback },
    ]);

    const res = await fb.extractGafferLines("привет, как дела");

    expect(res).toEqual([]);
    expect(primary.extractGafferLines).toHaveBeenCalledTimes(1);
    expect(fallback.extractGafferLines).toHaveBeenCalledTimes(1);
  });

  it("throws the last error when ALL providers fail", async () => {
    const e1 = new Error("chatmock down");
    const e2 = new Error("openai 401");
    const fb = new FallbackLlmProvider([
      { name: "chatmock", provider: fail(e1) },
      { name: "openai", provider: fail(e2) },
    ]);

    await expect(fb.extractGafferLines("text")).rejects.toThrow("openai 401");
  });

  it("falls through throw (a) then empty (b) to the final non-empty leg (c)", async () => {
    const a = fail(new Error("a"));
    const b = ok([]);
    const c = ok([LINE]);
    const fb = new FallbackLlmProvider([
      { name: "a", provider: a },
      { name: "b", provider: b },
      { name: "c", provider: c },
    ]);

    const res = await fb.extractGafferLines("text");

    expect(res).toEqual([LINE]);
    expect(a.extractGafferLines).toHaveBeenCalledTimes(1);
    expect(b.extractGafferLines).toHaveBeenCalledTimes(1);
    expect(c.extractGafferLines).toHaveBeenCalledTimes(1);
  });

  it("single failing provider rethrows its error", async () => {
    const fb = new FallbackLlmProvider([{ name: "only", provider: fail(new Error("boom")) }]);
    await expect(fb.extractGafferLines("text")).rejects.toThrow("boom");
  });

  it("constructor throws when given no providers", () => {
    expect(() => new FallbackLlmProvider([])).toThrow();
  });
});

describe("getLlmProvider() — LLM_PROVIDER=fallback wiring", () => {
  const ENV_KEYS = [
    "LLM_PROVIDER",
    "OPENAI_BASE_URL",
    "OPENAI_API_KEY",
    "OPENAI_MODEL",
    "OPENAI_FALLBACK_API_KEY",
    "OPENAI_FALLBACK_MODEL",
  ];
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetLlmProvider();
  });

  it("constructs a FallbackLlmProvider when fully configured", () => {
    process.env.LLM_PROVIDER = "fallback";
    process.env.OPENAI_BASE_URL = "http://127.0.0.1:8000/v1";
    process.env.OPENAI_MODEL = "gpt-5.4-mini";
    delete process.env.OPENAI_API_KEY; // ChatMock leg → "unused" sentinel
    process.env.OPENAI_FALLBACK_API_KEY = "sk-proj-test-key";
    process.env.OPENAI_FALLBACK_MODEL = "gpt-4o";
    resetLlmProvider();

    const provider = getLlmProvider();
    expect(provider).toBeInstanceOf(FallbackLlmProvider);
  });

  it("throws a clear error when OPENAI_FALLBACK_API_KEY is missing", () => {
    process.env.LLM_PROVIDER = "fallback";
    process.env.OPENAI_BASE_URL = "http://127.0.0.1:8000/v1";
    delete process.env.OPENAI_FALLBACK_API_KEY;
    resetLlmProvider();

    expect(() => getLlmProvider()).toThrow(/OPENAI_FALLBACK_API_KEY/);
  });
});
