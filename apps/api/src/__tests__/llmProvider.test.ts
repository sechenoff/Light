/**
 * Чистые функции слоя LLM: нормализация дат и шапки документа,
 * терпимый разбор JSON из ответа Gemini.
 */
import { describe, it, expect } from "vitest";
import { normalizeIsoDate, normalizeDocumentExtraction, EMPTY_DOCUMENT_META } from "../services/llm/provider";
import { parseLooseJson } from "../services/llm/gemini";

describe("normalizeIsoDate", () => {
  it("ISO проходит как есть, русский формат переворачивается", () => {
    expect(normalizeIsoDate("2026-09-02")).toBe("2026-09-02");
    expect(normalizeIsoDate("2026-9-2")).toBe("2026-09-02");
    expect(normalizeIsoDate("02.09.2026")).toBe("2026-09-02");
    expect(normalizeIsoDate("2.9.2026")).toBe("2026-09-02");
    expect(normalizeIsoDate("02/09/2026")).toBe("2026-09-02");
    expect(normalizeIsoDate(" 2026-09-02T00:00:00Z ")).toBe("2026-09-02");
  });

  it("мусор и не-строки → null", () => {
    expect(normalizeIsoDate("сентябрь")).toBeNull();
    expect(normalizeIsoDate("13.13.2026")).toBeNull();
    expect(normalizeIsoDate(null)).toBeNull();
    expect(normalizeIsoDate(20260902)).toBeNull();
    expect(normalizeIsoDate("")).toBeNull();
  });
});

describe("normalizeDocumentExtraction", () => {
  it("полный ответ: позиции + шапка, пустые строки становятся null", () => {
    const res = normalizeDocumentExtraction({
      projectName: "  Яндекс Книги ",
      gafferName: "",
      phone: "+7 981 790-34-51",
      email: null,
      telegram: "Belyhph",
      startDate: "02.09.2026",
      endDate: "2026-09-04",
      items: [
        { gafferPhrase: "Aputure LS 1200x PRO (Blair)", interpretedName: "aputure 1200x pro", quantity: 2 },
        { gafferPhrase: "Стропа 6-10м", interpretedName: "стропа", quantity: "4" },
        { gafferPhrase: "мусор без названия", interpretedName: "", quantity: 1 },
      ],
    });
    expect(res.meta).toEqual({
      projectName: "Яндекс Книги",
      gafferName: null,
      phone: "+7 981 790-34-51",
      email: null,
      telegram: "Belyhph",
      startDate: "2026-09-02",
      endDate: "2026-09-04",
    });
    expect(res.lines).toEqual([
      { gafferPhrase: "Aputure LS 1200x PRO (Blair)", interpretedName: "aputure 1200x pro", quantity: 2 },
      { gafferPhrase: "Стропа 6-10м", interpretedName: "стропа", quantity: 4 },
    ]);
  });

  it("незнакомая форма → пустая шапка и ноль позиций, без исключения", () => {
    expect(normalizeDocumentExtraction("not an object")).toEqual({ lines: [], meta: EMPTY_DOCUMENT_META });
    expect(normalizeDocumentExtraction(null)).toEqual({ lines: [], meta: EMPTY_DOCUMENT_META });
    expect(normalizeDocumentExtraction({ items: "nope" })).toEqual({ lines: [], meta: EMPTY_DOCUMENT_META });
  });

  it("голый массив позиций тоже принимается (шапки нет)", () => {
    const res = normalizeDocumentExtraction([{ gafferPhrase: "c-stand", interpretedName: "c-stand", quantity: 4 }]);
    expect(res.lines).toHaveLength(1);
    expect(res.meta).toEqual(EMPTY_DOCUMENT_META);
  });
});

describe("parseLooseJson", () => {
  it("чистый JSON, JSON в ```-заборе, JSON с преамбулой", () => {
    expect(parseLooseJson('{"items":[]}')).toEqual({ items: [] });
    expect(parseLooseJson('Вот ответ:\n```json\n{"items":[{"a":1}]}\n```')).toEqual({ items: [{ a: 1 }] });
    expect(parseLooseJson('Сначала разберём.\n{"projectName":"X","items":[]}\nГотово.')).toEqual({ projectName: "X", items: [] });
  });

  it("обрезанный массив чинится по последнему целому объекту", () => {
    expect(parseLooseJson('[{"a":1},{"a":2},{"a":')).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("совсем не JSON → undefined", () => {
    expect(parseLooseJson("Сначала разберём список приборов")).toBeUndefined();
  });
});

import { normalizePickDecisions, renderCatalogPickInput, type CatalogPickInput } from "../services/llm/provider";

const PICK_INPUT: CatalogPickInput = {
  catalog: [
    { row: 1, name: "Aputure Electric storm 52XT (Blair)", category: "COB Light" },
    { row: 2, name: "Линза френеля Aputure CF16 Fresnel Motorised для 52xt", category: "Насадки на приборы" },
    { row: 3, name: "Aputure NOVA P300C RGBWW", category: "Led Panel" },
  ],
  lines: [
    { line: 1, gafferPhrase: "2 шт 52xt блэр", interpretedName: "52xt", quantity: 2, decide: true, candidateRows: [1, 2] },
    { line: 2, gafferPhrase: "4 ц-стенда", interpretedName: "c-stand", quantity: 4, decide: false, matchedRow: 3 },
    { line: 3, gafferPhrase: "апутура 600д", interpretedName: "aputure 600d", quantity: 1, decide: true },
  ],
};

describe("renderCatalogPickInput", () => {
  it("каталог нумерован, спорные строки помечены DECIDE с подсказками матчера", () => {
    const { catalogText, linesText } = renderCatalogPickInput(PICK_INPUT);
    expect(catalogText.split("\n")).toHaveLength(3);
    expect(catalogText).toContain("1. [COB Light] Aputure Electric storm 52XT (Blair)");
    expect(linesText).toContain("L1 DECIDE: «2 шт 52xt блэр» (AI name: 52xt, qty 2); matcher candidates: rows 1, 2");
    expect(linesText).toContain("L2 ok: «4 ц-стенда» (AI name: c-stand, qty 4) → row 3");
    expect(linesText).toContain("L3 DECIDE: «апутура 600д» (AI name: aputure 600d, qty 1); matcher found nothing");
  });
});

describe("normalizePickDecisions", () => {
  it("принимает объект с decisions и голый массив; строки в числа", () => {
    expect(normalizePickDecisions({ decisions: [{ line: "1", rows: ["1"] }] }, PICK_INPUT)).toEqual([{ line: 1, rows: [1] }]);
    expect(normalizePickDecisions([{ line: 3, rows: [] }], PICK_INPUT)).toEqual([{ line: 3, rows: [] }]);
  });

  it("отбрасывает уверенные строки, чужие номера, дубли и лишние позиции", () => {
    const res = normalizePickDecisions(
      {
        decisions: [
          { line: 2, rows: [1] }, // строка не спорная
          { line: 1, rows: [2, 2, 0, 99, 1, 3, 1] }, // дубль, вне диапазона, больше трёх
          { line: 1, rows: [3] }, // повтор строки — игнор
          { line: 9, rows: [1] }, // такой строки нет
          "мусор",
        ],
      },
      PICK_INPUT,
    );
    expect(res).toEqual([{ line: 1, rows: [2, 1, 3] }]);
  });

  it("мусор вместо ответа → пустой список решений", () => {
    expect(normalizePickDecisions("nope", PICK_INPUT)).toEqual([]);
    expect(normalizePickDecisions(null, PICK_INPUT)).toEqual([]);
  });
});

import { EXTRACT_PROMPT_REVIEW } from "../services/llm/provider";
describe("EXTRACT_PROMPT_REVIEW", () => {
  it("велит разбивать «прибор + насадка» на две позиции и держать «все» во фразе", () => {
    expect(EXTRACT_PROMPT_REVIEW).toMatch(/SEPARATE items/);
    expect(EXTRACT_PROMPT_REVIEW).toMatch(/all units in stock/);
    expect(EXTRACT_PROMPT_REVIEW).toMatch(/one item per element/);
    expect(EXTRACT_PROMPT_REVIEW).toMatch(/Skip lines that are not equipment requests/);
  });
});
