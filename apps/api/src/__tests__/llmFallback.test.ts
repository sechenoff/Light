/**
 * FallbackLlmProvider — автопереключение ног (текст и документы) —
 * и сборка провайдера из env (getLlmProvider / buildLlmLeg).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { FallbackLlmProvider } from "../services/llm/fallback";
import { getLlmProvider, resetLlmProvider, buildLlmLeg } from "../services/llm";
import { AnthropicLlmProvider } from "../services/llm/anthropic";
import { GeminiLlmProvider } from "../services/llm/gemini";
import { OpenAiLlmProvider, OPENAI_DIRECT_BASE_URL } from "../services/llm/openai";
import type { LlmProvider, GafferExtractedLine, GafferDocumentExtraction } from "../services/llm/provider";
import { EMPTY_DOCUMENT_META } from "../services/llm/provider";

const LINE: GafferExtractedLine = { gafferPhrase: "52xt", interpretedName: "52xt", quantity: 1 };
const DOC = { data: Buffer.from("%PDF-1.4"), mimeType: "application/pdf" as const };
const quiet = () => {};

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
function docOk(lines: GafferExtractedLine[]): LlmProvider {
  return {
    extractGafferLines: vi.fn(async () => []),
    extractGafferDocument: vi.fn(async (): Promise<GafferDocumentExtraction> => ({ lines, meta: { ...EMPTY_DOCUMENT_META } })),
  };
}
function docFail(err: unknown): LlmProvider {
  return {
    extractGafferLines: vi.fn(async () => []),
    extractGafferDocument: vi.fn(async () => {
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
      { name: "anthropic", provider: primary },
      { name: "gemini", provider: fallback },
    ], quiet);

    const res = await fb.extractGafferLines("text");

    expect(res).toEqual([LINE]);
    expect(primary.extractGafferLines).toHaveBeenCalledTimes(1);
    expect(fallback.extractGafferLines).toHaveBeenCalledTimes(1);
  });

  it("falls back when primary returns an empty array (treated as failure to recognize)", async () => {
    const primary = ok([]);
    const fallback = ok([LINE]);
    const fb = new FallbackLlmProvider([
      { name: "anthropic", provider: primary },
      { name: "gemini", provider: fallback },
    ], quiet);

    const res = await fb.extractGafferLines("text");

    expect(res).toEqual([LINE]);
    expect(fallback.extractGafferLines).toHaveBeenCalledTimes(1);
  });

  it("returns empty array from the LAST provider without error (legit 'no equipment')", async () => {
    const primary = ok([]);
    const fallback = ok([]);
    const fb = new FallbackLlmProvider([
      { name: "anthropic", provider: primary },
      { name: "gemini", provider: fallback },
    ], quiet);

    const res = await fb.extractGafferLines("привет, как дела");

    expect(res).toEqual([]);
    expect(primary.extractGafferLines).toHaveBeenCalledTimes(1);
    expect(fallback.extractGafferLines).toHaveBeenCalledTimes(1);
  });

  it("throws the last error when ALL providers fail", async () => {
    const e1 = new Error("anthropic down");
    const e2 = new Error("gemini 401");
    const fb = new FallbackLlmProvider([
      { name: "anthropic", provider: fail(e1) },
      { name: "gemini", provider: fail(e2) },
    ], quiet);

    await expect(fb.extractGafferLines("text")).rejects.toThrow("gemini 401");
  });

  it("falls through throw (a) then empty (b) to the final non-empty leg (c)", async () => {
    const a = fail(new Error("a"));
    const b = ok([]);
    const c = ok([LINE]);
    const fb = new FallbackLlmProvider([
      { name: "a", provider: a },
      { name: "b", provider: b },
      { name: "c", provider: c },
    ], quiet);

    const res = await fb.extractGafferLines("text");

    expect(res).toEqual([LINE]);
    expect(a.extractGafferLines).toHaveBeenCalledTimes(1);
    expect(b.extractGafferLines).toHaveBeenCalledTimes(1);
    expect(c.extractGafferLines).toHaveBeenCalledTimes(1);
  });

  it("single failing provider rethrows its error", async () => {
    const fb = new FallbackLlmProvider([{ name: "only", provider: fail(new Error("boom")) }], quiet);
    await expect(fb.extractGafferLines("text")).rejects.toThrow("boom");
  });

  it("constructor throws when given no providers", () => {
    expect(() => new FallbackLlmProvider([])).toThrow();
  });

  it("legNames перечисляет ноги по порядку", () => {
    const fb = new FallbackLlmProvider([
      { name: "anthropic", provider: ok([]) },
      { name: "gemini", provider: ok([]) },
    ]);
    expect(fb.legNames).toEqual(["anthropic", "gemini"]);
  });
});

describe("FallbackLlmProvider — документы заявки", () => {
  it("ноги без зрения пропускаются; результат — от первой, которая прочитала", async () => {
    const blind = ok([LINE]); // текстовая нога без extractGafferDocument
    const broken = docFail(new Error("529 overloaded"));
    const good = docOk([LINE]);
    const fb = new FallbackLlmProvider([
      { name: "openai", provider: blind },
      { name: "anthropic", provider: broken },
      { name: "gemini", provider: good },
    ], quiet);

    const res = await fb.extractGafferDocument(DOC);

    expect(res.lines).toEqual([LINE]);
    expect(blind.extractGafferLines).not.toHaveBeenCalled();
    expect(broken.extractGafferDocument).toHaveBeenCalledWith(DOC);
    expect(good.extractGafferDocument).toHaveBeenCalledTimes(1);
  });

  it("ноль позиций у не последней ноги → следующая; у последней — честный пустой результат", async () => {
    const first = docOk([]);
    const second = docOk([]);
    const fb = new FallbackLlmProvider([
      { name: "anthropic", provider: first },
      { name: "gemini", provider: second },
    ], quiet);

    const res = await fb.extractGafferDocument(DOC);

    expect(res.lines).toEqual([]);
    expect(second.extractGafferDocument).toHaveBeenCalledTimes(1);
  });

  it("ни одной ноги со зрением → понятная ошибка конфигурации", async () => {
    const fb = new FallbackLlmProvider([{ name: "openai", provider: ok([LINE]) }], quiet);
    await expect(fb.extractGafferDocument(DOC)).rejects.toThrow(/anthropic или gemini/);
  });
});

const ENV_KEYS = [
  "LLM_PROVIDER",
  "LLM_FALLBACK_CHAIN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_EFFORT",
  "GEMINI_API_KEY",
  "GEMINI_MODEL",
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "OPENAI_FALLBACK_API_KEY",
  "OPENAI_FALLBACK_MODEL",
  "OPENAI_FALLBACK_BASE_URL",
];
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

function setEnv(vars: Record<string, string>) {
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  resetLlmProvider();
}

function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetLlmProvider();
}

describe("getLlmProvider() — сборка из env", () => {
  afterEach(restoreEnv);

  it("LLM_PROVIDER=anthropic → AnthropicLlmProvider", () => {
    setEnv({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant-test" });
    expect(getLlmProvider()).toBeInstanceOf(AnthropicLlmProvider);
  });

  it("anthropic без ключа → ошибка называет ANTHROPIC_API_KEY", () => {
    setEnv({ LLM_PROVIDER: "anthropic" });
    expect(() => getLlmProvider()).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("ANTHROPIC_EFFORT вне списка → ошибка при сборке, а не 400 от API на первом запросе", () => {
    setEnv({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k", ANTHROPIC_EFFORT: "turbo" });
    expect(() => getLlmProvider()).toThrow(/ANTHROPIC_EFFORT/);
  });

  it("fallback по умолчанию — цепочка anthropic → gemini", () => {
    setEnv({ LLM_PROVIDER: "fallback", ANTHROPIC_API_KEY: "k", GEMINI_API_KEY: "g" });
    const provider = getLlmProvider();
    expect(provider).toBeInstanceOf(FallbackLlmProvider);
    expect((provider as FallbackLlmProvider).legNames).toEqual(["anthropic", "gemini"]);
  });

  it("fallback: без ключа одной из ног — ошибка при сборке", () => {
    setEnv({ LLM_PROVIDER: "fallback", ANTHROPIC_API_KEY: "k" });
    expect(() => getLlmProvider()).toThrow(/GEMINI_API_KEY/);
  });

  it("LLM_FALLBACK_CHAIN из одной ноги — ошибка", () => {
    setEnv({ LLM_PROVIDER: "fallback", LLM_FALLBACK_CHAIN: "gemini", GEMINI_API_KEY: "g" });
    expect(() => getLlmProvider()).toThrow(/минимум два/);
  });

  it("историческая цепочка chatmock,openai-api по-прежнему собирается", () => {
    setEnv({
      LLM_PROVIDER: "fallback",
      LLM_FALLBACK_CHAIN: "chatmock, openai-api",
      OPENAI_BASE_URL: "http://127.0.0.1:8000/v1",
      OPENAI_MODEL: "gpt-5.4-mini",
      OPENAI_FALLBACK_API_KEY: "sk-proj-test-key",
    });
    const provider = getLlmProvider() as FallbackLlmProvider;
    expect(provider).toBeInstanceOf(FallbackLlmProvider);
    expect(provider.legNames).toEqual(["chatmock", "openai-api"]);
  });

  it("нога openai-api без OPENAI_FALLBACK_API_KEY — ошибка называет переменную", () => {
    setEnv({ LLM_PROVIDER: "openai-api" });
    expect(() => getLlmProvider()).toThrow(/OPENAI_FALLBACK_API_KEY/);
  });

  it("неизвестное имя → ошибка со списком поддерживаемых", () => {
    setEnv({ LLM_PROVIDER: "bard" });
    expect(() => getLlmProvider()).toThrow(/Неизвестный LLM-провайдер/);
  });

  it("без LLM_PROVIDER — gemini, как и раньше", () => {
    setEnv({ GEMINI_API_KEY: "g" });
    expect(getLlmProvider()).toBeInstanceOf(GeminiLlmProvider);
  });
});

describe("OpenAiLlmProvider — куда реально уходят запросы", () => {
  afterEach(restoreEnv);

  it("без baseURL идёт на api.openai.com даже при OPENAI_BASE_URL в env (регрессия: «прямая» нога уходила в ChatMock)", () => {
    setEnv({ OPENAI_BASE_URL: "http://127.0.0.1:8000/v1" });
    expect(new OpenAiLlmProvider("k", "gpt-4o").baseURL).toBe(OPENAI_DIRECT_BASE_URL);
  });

  it("явный baseURL уважается", () => {
    setEnv({});
    expect(new OpenAiLlmProvider("k", "m", "http://127.0.0.1:8000/v1").baseURL).toBe("http://127.0.0.1:8000/v1");
  });

  it("нога openai-api — прямая, нога chatmock — через прокси из OPENAI_BASE_URL", () => {
    setEnv({ OPENAI_BASE_URL: "http://127.0.0.1:8000/v1", OPENAI_FALLBACK_API_KEY: "sk-proj-test" });
    expect((buildLlmLeg("openai-api") as OpenAiLlmProvider).baseURL).toBe(OPENAI_DIRECT_BASE_URL);
    expect((buildLlmLeg("chatmock") as OpenAiLlmProvider).baseURL).toBe("http://127.0.0.1:8000/v1");
  });
});

describe("FallbackLlmProvider — подбор каталога", () => {
  const INPUT = { catalog: [{ row: 1, name: "A", category: "X" }], lines: [{ line: 1, gafferPhrase: "a", interpretedName: "a", quantity: 1, decide: true }] };

  it("ноги без подбора пропускаются, сбойная нога уступает следующей", async () => {
    const blind = ok([LINE]);
    const broken: LlmProvider = { extractGafferLines: vi.fn(async () => []), pickCatalogMatches: vi.fn(async () => { throw new Error("529"); }) };
    const good: LlmProvider = { extractGafferLines: vi.fn(async () => []), pickCatalogMatches: vi.fn(async () => [{ line: 1, rows: [1] }]) };
    const fb = new FallbackLlmProvider([
      { name: "openai", provider: blind },
      { name: "anthropic", provider: broken },
      { name: "gemini", provider: good },
    ], quiet);

    expect(await fb.pickCatalogMatches(INPUT)).toEqual([{ line: 1, rows: [1] }]);
    expect(broken.pickCatalogMatches).toHaveBeenCalledWith(INPUT);
  });

  it("пустой список решений — легитимный ответ первой ноги, дальше не идём", async () => {
    const first: LlmProvider = { extractGafferLines: vi.fn(async () => []), pickCatalogMatches: vi.fn(async () => []) };
    const second: LlmProvider = { extractGafferLines: vi.fn(async () => []), pickCatalogMatches: vi.fn(async () => [{ line: 1, rows: [1] }]) };
    const fb = new FallbackLlmProvider([{ name: "a", provider: first }, { name: "b", provider: second }], quiet);
    expect(await fb.pickCatalogMatches(INPUT)).toEqual([]);
    expect(second.pickCatalogMatches).not.toHaveBeenCalled();
  });

  it("ни одной ноги с подбором → ошибка конфигурации", async () => {
    const fb = new FallbackLlmProvider([{ name: "openai", provider: ok([LINE]) }], quiet);
    await expect(fb.pickCatalogMatches(INPUT)).rejects.toThrow(/подбирать позиции/);
  });
});
