import { describe, it, expect } from "vitest";
import { quoteName } from "../format";

describe("quoteName — название в «ёлочках» без удвоения", () => {
  it("оборачивает голое название", () => {
    expect(quoteName("Северный ветер")).toBe("«Северный ветер»");
  });
  it("не удваивает уже закавыченное название", () => {
    expect(quoteName("«Северный ветер»")).toBe("«Северный ветер»");
    expect(quoteName("„Лето“")).toBe("„Лето“");
    expect(quoteName('"Река"')).toBe('"Река"');
  });
  it("оборачивает название с кавычками внутри, но не по краям", () => {
    expect(quoteName("Клип «Лето» · досъёмка")).toBe("«Клип «Лето» · досъёмка»");
  });
  it("обрезает пробелы по краям", () => {
    expect(quoteName("  Река ")).toBe("«Река»");
  });
});
