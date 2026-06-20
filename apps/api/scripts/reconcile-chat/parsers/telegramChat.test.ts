import { describe, it, expect } from "vitest";
import path from "path";
import { parseTelegramChat, GROUP_WINDOW_HOURS } from "./telegramChat";

const FIXTURE = path.resolve(__dirname, "../__fixtures__/sample-chat.json");

describe("parseTelegramChat", () => {
  it("returns one PAIR for the request+xlsx within window", () => {
    const entries = parseTelegramChat(FIXTURE);
    const pair = entries.find((e) => e.sourceMsgId === 101);
    expect(pair).toBeDefined();
    expect(pair!.kind).toBe("PAIR");
    expect(pair!.gafferName).toBe("Старость");
    expect(pair!.totalRub).toBe(4500);
    expect(pair!.shootDate).toBe("2026-01-17");
    expect(pair!.sourcePasteMsgId).toBe(100);
    expect(pair!.projectName).toBe("17.01 бага погруз");
    expect(pair!.pasteItems).toEqual([
      { phrase: "Лантерн 120", qty: 1 },
      { phrase: "Лайтдом 150", qty: 2 },
      { phrase: "Сдл 8", qty: 2 },
    ]);
    expect(pair!.xlsxItems).toEqual([]);
  });

  it("returns REQUEST_ONLY for paste without xlsx in window", () => {
    const entries = parseTelegramChat(FIXTURE);
    const req = entries.find((e) => e.sourceMsgId === 200);
    expect(req).toBeDefined();
    expect(req!.kind).toBe("REQUEST_ONLY");
    expect(req!.pasteItems).toEqual([{ phrase: "Мбю 12", qty: 1 }]);
    expect(req!.xlsxItems).toEqual([]);
  });

  it("classifies inventory-xlsx as NON_ESTIMATE", () => {
    const entries = parseTelegramChat(FIXTURE);
    const nonEst = entries.find((e) => e.sourceMsgId === 300);
    expect(nonEst!.kind).toBe("NON_ESTIMATE");
  });

  it("ignores chatter without multi-line structure", () => {
    const entries = parseTelegramChat(FIXTURE);
    expect(entries.find((e) => e.sourceMsgId === 201)).toBeUndefined();
  });

  it(`pair window equals ${GROUP_WINDOW_HOURS}h`, () => {
    expect(GROUP_WINDOW_HOURS).toBe(24);
  });
});
