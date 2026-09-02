/**
 * OpenAiLlmProvider — параметры под gpt-5.x (max_completion_tokens, без
 * temperature), strict structured output, документы. SDK подменён.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const createMock = vi.fn();
const ctorMock = vi.fn();

vi.mock("openai", () => ({
  default: class MockOpenAI {
    chat = { completions: { create: createMock } };
    baseURL: string;
    constructor(opts: { baseURL?: string }) {
      ctorMock(opts);
      this.baseURL = opts.baseURL ?? "";
    }
  },
}));

import { OpenAiLlmProvider, OPENAI_DIRECT_BASE_URL } from "../services/llm/openai";

type Choice = { finish_reason?: string; message: { content?: string | null; refusal?: string | null } };
function reply(choice: Choice) {
  return { choices: [choice] };
}
function lastParams(): any {
  return createMock.mock.calls[createMock.mock.calls.length - 1][0];
}

const PDF = Buffer.from("%PDF-1.4 fake");

describe("OpenAiLlmProvider — текст", () => {
  beforeEach(() => {
    createMock.mockReset();
    ctorMock.mockReset();
  });

  it("шлёт max_completion_tokens без temperature и strict json_schema", async () => {
    createMock.mockResolvedValue(
      reply({ finish_reason: "stop", message: { content: '{"items":[{"gafferPhrase":"2 шт 52xt","interpretedName":"52xt","quantity":2}]}' } }),
    );
    const provider = new OpenAiLlmProvider("sk-test", "gpt-5.6-sol");

    const lines = await provider.extractGafferLines("2 шт 52xt");

    expect(lines).toEqual([{ gafferPhrase: "2 шт 52xt", interpretedName: "52xt", quantity: 2 }]);
    const params = lastParams();
    expect(params.model).toBe("gpt-5.6-sol");
    expect(params.max_completion_tokens).toBe(4096);
    expect(params).not.toHaveProperty("max_tokens");
    expect(params).not.toHaveProperty("temperature");
    expect(params.response_format.type).toBe("json_schema");
    expect(params.response_format.json_schema.strict).toBe(true);
    expect(params.response_format.json_schema.schema.properties).toHaveProperty("items");
    expect(params.messages[1]).toEqual({ role: "user", content: "2 шт 52xt" });
    expect(ctorMock).toHaveBeenCalledWith({ apiKey: "sk-test", baseURL: OPENAI_DIRECT_BASE_URL });
  });

  it("срезает <think>-блок прокси перед JSON", async () => {
    createMock.mockResolvedValue(
      reply({ message: { content: '<think>думаю…</think>{"items":[{"gafferPhrase":"c-stand","interpretedName":"c-stand","quantity":"4"}]}' } }),
    );
    const lines = await new OpenAiLlmProvider("k", "gpt-5.4-mini", "http://127.0.0.1:8000/v1").extractGafferLines("4 c-stand");
    expect(lines).toEqual([{ gafferPhrase: "c-stand", interpretedName: "c-stand", quantity: 4 }]);
    expect(ctorMock).toHaveBeenCalledWith({ apiKey: "k", baseURL: "http://127.0.0.1:8000/v1" });
  });

  it("пустой content → пустой список (без исключения)", async () => {
    createMock.mockResolvedValue(reply({ message: { content: "" } }));
    expect(await new OpenAiLlmProvider("k").extractGafferLines("x")).toEqual([]);
  });

  it("refusal модели — ошибка ноги", async () => {
    createMock.mockResolvedValue(reply({ message: { content: null, refusal: "I can't help with that" } }));
    await expect(new OpenAiLlmProvider("k").extractGafferLines("x")).rejects.toThrow(/отказался/);
  });

  it("обрезка по лимиту (finish_reason=length) — ошибка ноги", async () => {
    createMock.mockResolvedValue(reply({ finish_reason: "length", message: { content: '{"items":[' } }));
    await expect(new OpenAiLlmProvider("k").extractGafferLines("x")).rejects.toThrow(/обрезан/);
  });

  it("400 не повторяется, 429 — повторяется с паузой", async () => {
    const bad = Object.assign(new Error("400 bad request"), { status: 400 });
    createMock.mockRejectedValueOnce(bad);
    await expect(new OpenAiLlmProvider("k", "m", undefined, 3).extractGafferLines("x")).rejects.toThrow("400 bad request");
    expect(createMock).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
    try {
      createMock.mockReset();
      createMock
        .mockRejectedValueOnce(Object.assign(new Error("429"), { status: 429 }))
        .mockResolvedValueOnce(reply({ message: { content: '{"items":[]}' } }));
      const pending = new OpenAiLlmProvider("k", "m", undefined, 2).extractGafferLines("x");
      await vi.advanceTimersByTimeAsync(1000);
      expect(await pending).toEqual([]);
      expect(createMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("OpenAiLlmProvider — документ заявки", () => {
  beforeEach(() => {
    createMock.mockReset();
    ctorMock.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("PDF уходит file-частью с data-URL, ответ нормализуется", async () => {
    createMock.mockResolvedValue(
      reply({
        finish_reason: "stop",
        message: {
          content: JSON.stringify({
            projectName: "Яндекс Книги",
            gafferName: "Белых Геннадий",
            phone: "+7 981 790-34-51",
            email: "Belyh.ph@gmail.com",
            telegram: "Belyhph",
            startDate: "02.09.2026",
            endDate: null,
            items: [{ gafferPhrase: "Aputure STORM 700x", interpretedName: "aputure storm 700x", quantity: 1 }],
          }),
        },
      }),
    );

    const res = await new OpenAiLlmProvider("k", "gpt-5.6-sol").extractGafferDocument({
      data: PDF,
      mimeType: "application/pdf",
      fileName: "заявка.pdf",
    });

    expect(res.lines).toEqual([{ gafferPhrase: "Aputure STORM 700x", interpretedName: "aputure storm 700x", quantity: 1 }]);
    expect(res.meta.startDate).toBe("2026-09-02");
    expect(res.meta.email).toBe("Belyh.ph@gmail.com");
    const params = lastParams();
    const [attachment, textPart] = params.messages[1].content;
    expect(attachment.type).toBe("file");
    expect(attachment.file.file_data).toBe(`data:application/pdf;base64,${PDF.toString("base64")}`);
    expect(attachment.file.filename).toMatch(/\.pdf$/);
    expect(textPart.type).toBe("text");
    expect(params.response_format.json_schema.name).toBe("gaffer_document");
    expect(params.response_format.json_schema.schema.properties.projectName).toEqual({ type: ["string", "null"] });
    expect(params.max_completion_tokens).toBeGreaterThanOrEqual(8192);
  });

  it("фото уходит image_url с data-URL своего типа", async () => {
    createMock.mockResolvedValue(reply({ message: { content: '{"items":[]}' } }));
    const jpeg = Buffer.from([0xff, 0xd8, 0xff]);
    const res = await new OpenAiLlmProvider("k").extractGafferDocument({ data: jpeg, mimeType: "image/jpeg" });
    expect(res.lines).toEqual([]);
    expect(lastParams().messages[1].content[0]).toEqual({
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${jpeg.toString("base64")}`, detail: "high" },
    });
  });

  it("не JSON в ответе — ошибка (цепочка идёт дальше)", async () => {
    createMock.mockResolvedValue(reply({ message: { content: "Сначала разберём документ…" } }));
    await expect(
      new OpenAiLlmProvider("k").extractGafferDocument({ data: PDF, mimeType: "application/pdf" }),
    ).rejects.toThrow(/не JSON/);
  });
});

describe("OpenAiLlmProvider — подбор каталога", () => {
  beforeEach(() => {
    createMock.mockReset();
    ctorMock.mockReset();
  });

  it("strict json_schema catalog_pick, решения нормализуются", async () => {
    createMock.mockResolvedValue(reply({ message: { content: '{"decisions":[{"line":1,"rows":[2]}]}' } }));
    const input = {
      catalog: [
        { row: 1, name: "A", category: "X" },
        { row: 2, name: "B", category: "Y" },
      ],
      lines: [{ line: 1, gafferPhrase: "b", interpretedName: "b", quantity: 1, decide: true }],
    };
    const res = await new OpenAiLlmProvider("k", "gpt-5.6-sol").pickCatalogMatches(input);
    expect(res).toEqual([{ line: 1, rows: [2] }]);
    const params = lastParams();
    expect(params.response_format.json_schema.name).toBe("catalog_pick");
    expect(params.response_format.json_schema.strict).toBe(true);
    expect(params.messages[1].content).toContain("Catalog:\n1. [X] A\n2. [Y] B");
  });
});
