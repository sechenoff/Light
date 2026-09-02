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
