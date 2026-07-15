import { describe, it, expect } from "vitest";
import { matchesCatalogRow, transliterateRu } from "../searchNormalize";

const ROW = {
  name: "Aputure NOVA II 2x1 (1000w)",
  brand: "Aputure",
  model: "NOVA II",
  category: "Led Panel",
};

describe("transliterateRu", () => {
  it("транслитерирует кириллицу в латиницу", () => {
    expect(transliterateRu("нова")).toBe("nova");
    expect(transliterateRu("ари")).toBe("ari");
  });

  it("латиницу и цифры не трогает", () => {
    expect(transliterateRu("nova 2x1")).toBe("nova 2x1");
  });
});

describe("matchesCatalogRow", () => {
  it("пустой запрос матчит всё", () => {
    expect(matchesCatalogRow(ROW, "")).toBe(true);
    expect(matchesCatalogRow(ROW, "   ")).toBe(true);
  });

  it("прямое вхождение, регистронезависимо", () => {
    expect(matchesCatalogRow(ROW, "nova")).toBe(true);
    expect(matchesCatalogRow(ROW, "APUTURE")).toBe(true);
  });

  it("ищет по бренду, модели и категории", () => {
    expect(matchesCatalogRow(ROW, "led panel")).toBe(true);
  });

  it("кириллический запрос матчит латиницу через транслит («нова» → NOVA)", () => {
    expect(matchesCatalogRow(ROW, "нова")).toBe(true);
  });

  it("алиасы: «шторм» → STORM, «скай» → Sky", () => {
    const storm = { name: "Aputure STORM 700x", category: "COB Light" };
    const sky = { name: "ARRI SkyPanel S60-C", category: "Led Panel" };
    expect(matchesCatalogRow(storm, "шторм")).toBe(true);
    expect(matchesCatalogRow(sky, "скай")).toBe(true);
  });

  it("не матчит посторонний запрос", () => {
    expect(matchesCatalogRow(ROW, "генератор")).toBe(false);
  });
});
