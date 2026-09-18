import { describe, it, expect } from "vitest";
import { quoteName } from "../services/stockCount/act/buildStockCountAct";

describe("акт инвентаризации: название брони без удвоения кавычек", () => {
  it("оборачивает голое название", () => {
    expect(quoteName("Северный ветер")).toBe("«Северный ветер»");
  });
  it("не удваивает «ёлочки», „лапки“ и прямые кавычки", () => {
    expect(quoteName("«Северный ветер»")).toBe("«Северный ветер»");
    expect(quoteName("„Лето“")).toBe("„Лето“");
    expect(quoteName('"Река"')).toBe('"Река"');
  });
});
