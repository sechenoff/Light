/**
 * AnthropicLlmProvider — Claude через structured output.
 * SDK подменён целиком: проверяем форму запроса и разбор ответа, а не сеть.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const parseMock = vi.fn();
const ctorMock = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { parse: parseMock };
    constructor(opts: unknown) {
      ctorMock(opts);
    }
  },
}));

import { AnthropicLlmProvider, DEFAULT_ANTHROPIC_MODEL } from "../services/llm/anthropic";

type Reply = { stop_reason: string | null; parsed_output: unknown; content: Array<{ type: string; text?: string }> };
function reply(over: Partial<Reply> = {}): Reply {
  return { stop_reason: "end_turn", parsed_output: null, content: [], ...over };
}
function lastParams(): any {
  return parseMock.mock.calls[parseMock.mock.calls.length - 1][0];
}

const PDF = Buffer.from("%PDF-1.4 fake");
const EMPTY_DOC = {
  projectName: null, gafferName: null, phone: null, email: null, telegram: null,
  startDate: null, endDate: null, items: [],
};

describe("AnthropicLlmProvider — текст заявки", () => {
  beforeEach(() => {
    parseMock.mockReset();
    ctorMock.mockReset();
  });

  it("по умолчанию claude-opus-5, effort low, structured output с ключом items", async () => {
    parseMock.mockResolvedValue(
      reply({ parsed_output: { items: [{ gafferPhrase: "2 шт 52xt", interpretedName: "52xt", quantity: 2 }] } }),
    );
    const provider = new AnthropicLlmProvider("sk-ant-test");

    const lines = await provider.extractGafferLines("2 шт 52xt");

    expect(lines).toEqual([{ gafferPhrase: "2 шт 52xt", interpretedName: "52xt", quantity: 2 }]);
    const params = lastParams();
    expect(params.model).toBe(DEFAULT_ANTHROPIC_MODEL);
    expect(params.output_config.effort).toBe("low");
    expect(params.output_config.format.type).toBe("json_schema");
    expect(params.output_config.format.schema.properties).toHaveProperty("items");
    expect(params.messages).toEqual([{ role: "user", content: "2 шт 52xt" }]);
    expect(params.system).toContain("items");
    // thinking не задаём — на Opus 5 adaptive по умолчанию
    expect(params.thinking).toBeUndefined();
    expect(ctorMock).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "sk-ant-test", maxRetries: 2, timeout: 60_000 }),
    );
  });

  it("модель, effort и повторы берутся из опций", async () => {
    parseMock.mockResolvedValue(reply({ parsed_output: { items: [] } }));
    const provider = new AnthropicLlmProvider("k", "claude-sonnet-5", { effort: "medium", maxRetries: 1, timeoutMs: 5000 });

    await provider.extractGafferLines("x");

    expect(lastParams().model).toBe("claude-sonnet-5");
    expect(lastParams().output_config.effort).toBe("medium");
    expect(ctorMock).toHaveBeenCalledWith(expect.objectContaining({ maxRetries: 1, timeout: 5000 }));
  });

  it("отказ классификатора (stop_reason=refusal) — ошибка, а не пустой список", async () => {
    parseMock.mockResolvedValue(reply({ stop_reason: "refusal", parsed_output: { items: [] } }));
    await expect(new AnthropicLlmProvider("k").extractGafferLines("x")).rejects.toThrow(/refusal/);
  });

  it("обрезка по max_tokens — ошибка", async () => {
    parseMock.mockResolvedValue(reply({ stop_reason: "max_tokens", parsed_output: null }));
    await expect(new AnthropicLlmProvider("k").extractGafferLines("x")).rejects.toThrow(/max_tokens/);
  });

  it("parsed_output пуст, но текст — JSON: разбираем текст, количество приводится к числу", async () => {
    parseMock.mockResolvedValue(
      reply({
        content: [
          { type: "text", text: '{"items":[{"gafferPhrase":"4 ц-стенда","interpretedName":"c-stand","quantity":"4"}]}' },
        ],
      }),
    );
    const lines = await new AnthropicLlmProvider("k").extractGafferLines("4 ц-стенда");
    expect(lines).toEqual([{ gafferPhrase: "4 ц-стенда", interpretedName: "c-stand", quantity: 4 }]);
  });

  it("parsed_output пуст и текст не JSON — ошибка (цепочка передаст запрос дальше)", async () => {
    parseMock.mockResolvedValue(reply({ content: [{ type: "text", text: "Сначала разберём список…" }] }));
    await expect(new AnthropicLlmProvider("k").extractGafferLines("x")).rejects.toThrow(/не JSON/);
  });

  it("совсем пустой ответ — ошибка", async () => {
    parseMock.mockResolvedValue(reply());
    await expect(new AnthropicLlmProvider("k").extractGafferLines("x")).rejects.toThrow(/Пустой ответ/);
  });
});

describe("AnthropicLlmProvider — документ заявки", () => {
  beforeEach(() => {
    parseMock.mockReset();
    ctorMock.mockReset();
  });

  it("PDF уходит document-блоком, шапка нормализуется (дата 02.09.2026 → ISO)", async () => {
    parseMock.mockResolvedValue(
      reply({
        parsed_output: {
          projectName: "Яндекс Книги",
          gafferName: "Белых Геннадий",
          phone: "+7 981 790-34-51",
          email: null,
          telegram: "Belyhph",
          startDate: "02.09.2026",
          endDate: null,
          items: [{ gafferPhrase: "Aputure STORM 700x", interpretedName: "aputure storm 700x", quantity: 1 }],
        },
      }),
    );
    const provider = new AnthropicLlmProvider("k", DEFAULT_ANTHROPIC_MODEL, { effort: "medium" });

    const res = await provider.extractGafferDocument({ data: PDF, mimeType: "application/pdf", fileName: "zayavka.pdf" });

    expect(res.lines).toEqual([{ gafferPhrase: "Aputure STORM 700x", interpretedName: "aputure storm 700x", quantity: 1 }]);
    expect(res.meta).toEqual({
      projectName: "Яндекс Книги",
      gafferName: "Белых Геннадий",
      phone: "+7 981 790-34-51",
      email: null,
      telegram: "Belyhph",
      startDate: "2026-09-02",
      endDate: null,
    });
    const params = lastParams();
    const [attachment, textPart] = params.messages[0].content;
    expect(attachment).toEqual({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: PDF.toString("base64") },
    });
    expect(textPart.type).toBe("text");
    expect(textPart.text).toContain("zayavka.pdf");
    expect(params.output_config.effort).toBe("medium");
    expect(params.output_config.format.schema.properties).toHaveProperty("projectName");
    expect(params.max_tokens).toBeGreaterThanOrEqual(8192);
  });

  it("фото уходит image-блоком с его media_type", async () => {
    parseMock.mockResolvedValue(reply({ parsed_output: EMPTY_DOC }));
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

    const res = await new AnthropicLlmProvider("k").extractGafferDocument({ data: jpeg, mimeType: "image/jpeg" });

    expect(res.lines).toEqual([]);
    expect(res.meta.projectName).toBeNull();
    expect(lastParams().messages[0].content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: jpeg.toString("base64") },
    });
  });

  it("отказ на документе — ошибка", async () => {
    parseMock.mockResolvedValue(reply({ stop_reason: "refusal" }));
    await expect(
      new AnthropicLlmProvider("k").extractGafferDocument({ data: PDF, mimeType: "application/pdf" }),
    ).rejects.toThrow(/refusal/);
  });
});

describe("AnthropicLlmProvider — подбор каталога", () => {
  beforeEach(() => {
    parseMock.mockReset();
    ctorMock.mockReset();
  });

  it("каталог уходит кэшируемым блоком, ответ нормализуется по входу", async () => {
    parseMock.mockResolvedValue(reply({ parsed_output: { decisions: [{ line: 1, rows: [1, 99] }, { line: 2, rows: [2] }] } }));
    const input = {
      catalog: [
        { row: 1, name: "Aputure Electric storm 52XT (Blair)", category: "COB Light" },
        { row: 2, name: "Линза френеля Aputure CF16 для 52xt", category: "Насадки" },
      ],
      lines: [
        { line: 1, gafferPhrase: "2 шт 52xt блэр", interpretedName: "52xt", quantity: 2, decide: true, candidateRows: [1, 2] },
        { line: 2, gafferPhrase: "линза", interpretedName: "lens", quantity: 1, decide: false, matchedRow: 2 },
      ],
    };

    const res = await new AnthropicLlmProvider("k").pickCatalogMatches(input);

    expect(res).toEqual([{ line: 1, rows: [1] }]);
    const params = lastParams();
    expect(params.system).toContain("DECIDE");
    const [catalogBlock, linesBlock] = params.messages[0].content;
    expect(catalogBlock.cache_control).toEqual({ type: "ephemeral" });
    expect(catalogBlock.text).toContain("1. [COB Light] Aputure Electric storm 52XT (Blair)");
    expect(linesBlock.text).toContain("L1 DECIDE");
    expect(params.output_config.format.schema.properties).toHaveProperty("decisions");
  });
});
