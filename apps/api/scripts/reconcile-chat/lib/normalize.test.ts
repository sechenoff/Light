import { describe, it, expect } from "vitest";
import {
  normalizeRu,
  normalizeClientName,
  phraseNoQty,
  extractQty,
} from "./normalize";

describe("normalizeRu", () => {
  it("lowercases, trims, collapses spaces", () => {
    expect(normalizeRu("  Лантерн   120  ")).toBe("лантерн 120");
  });
  it("replaces ё with е", () => {
    expect(normalizeRu("Тёплый свет")).toBe("теплый свет");
  });
  it("strips punctuation but keeps slashes", () => {
    expect(normalizeRu("Систенды/минибум/мегабум,")).toBe("систенды/минибум/мегабум");
  });
});

describe("normalizeClientName", () => {
  it("treats Хакаги and Хокаге as different normalized but close", () => {
    expect(normalizeClientName("Хакаги")).toBe("хакаги");
    expect(normalizeClientName("Хокаге")).toBe("хокаге");
  });
  it("strips trailing whitespace and punctuation", () => {
    expect(normalizeClientName("Гена Белых.")).toBe("гена белых");
  });
});

describe("phraseNoQty", () => {
  it("strips trailing «(N)» qty marker", () => {
    expect(phraseNoQty("Пена (1)")).toBe("Пена");
    expect(phraseNoQty("1200х (2)")).toBe("1200х");
  });
  it("leaves phrase without qty untouched", () => {
    expect(phraseNoQty("Лантерн 120")).toBe("Лантерн 120");
  });
  it("strips multi-space before paren", () => {
    expect(phraseNoQty("Сдл 8   (2)")).toBe("Сдл 8");
  });
});

describe("extractQty", () => {
  it("returns 1 when no qty marker", () => {
    expect(extractQty("Лантерн 120")).toBe(1);
  });
  it("parses qty from trailing «(N)»", () => {
    expect(extractQty("Пена (3)")).toBe(3);
  });
});
