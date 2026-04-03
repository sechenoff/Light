import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock api module before importing llm
vi.mock("./api", () => ({
  parseGafferReview: vi.fn(),
  matchEquipmentItems: vi.fn(),
}));

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

// Mock OpenAI before importing llm
vi.mock("openai", () => {
  return {
    default: class MockOpenAI {
      chat = { completions: { create: mockCreate } };
      constructor(_opts: unknown) {}
    },
  };
});

import * as apiModule from "./api";
import { matchEquipment } from "./llm";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("matchEquipment", () => {
  it("returns empty MatchResult when OpenAI extracts no items", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ items: [] }) } }],
    });

    const result = await matchEquipment("нет оборудования");
    expect(result).toEqual({ resolved: [], needsReview: [], unmatched: [] });
    // matchEquipmentItems should NOT be called when nothing extracted
    expect(apiModule.matchEquipmentItems).not.toHaveBeenCalled();
  });

  it("calls matchEquipmentItems with extracted items and returns resolved items", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              items: [
                { gafferPhrase: "2 шт nova p300", interpretedName: "nova p300", quantity: 2 },
              ],
            }),
          },
        },
      ],
    });

    (apiModule.matchEquipmentItems as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [
        {
          id: "abc",
          gafferPhrase: "2 шт nova p300",
          interpretedName: "nova p300",
          quantity: 2,
          match: {
            kind: "resolved",
            equipmentId: "eq-1",
            catalogName: "Nanlite Nova P300",
            category: "Источники света",
            availableQuantity: 3,
            rentalRatePerShift: "5000",
            confidence: 0.9,
          },
        },
      ],
    });

    const result = await matchEquipment("2 шт nova p300");
    expect("error" in result).toBe(false);
    if ("error" in result) return;

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].catalogName).toBe("Nanlite Nova P300");
    expect(result.resolved[0].quantity).toBe(2);
    expect(result.unmatched).toHaveLength(0);
    expect(result.needsReview).toHaveLength(0);

    expect(apiModule.matchEquipmentItems).toHaveBeenCalledWith([
      { name: "nova p300", quantity: 2, gafferPhrase: "2 шт nova p300" },
    ]);
  });

  it("returns error when OpenAI throws", async () => {
    mockCreate.mockRejectedValueOnce(new Error("OpenAI недоступен"));

    const result = await matchEquipment("любой текст");
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toContain("AI временно недоступен");
  });

  it("returns error when matchEquipmentItems returns error", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              items: [{ gafferPhrase: "c-stand", interpretedName: "c-stand", quantity: 1 }],
            }),
          },
        },
      ],
    });

    (apiModule.matchEquipmentItems as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [],
      error: "Ошибка каталога",
    });

    const result = await matchEquipment("c-stand");
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toBe("Ошибка каталога");
  });

  it("classifies needsReview and unmatched items correctly", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              items: [
                { gafferPhrase: "загадочный прибор", interpretedName: "загадочный прибор", quantity: 1 },
                { gafferPhrase: "непонятный свет", interpretedName: "непонятный свет", quantity: 1 },
              ],
            }),
          },
        },
      ],
    });

    (apiModule.matchEquipmentItems as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [
        {
          id: "x1",
          gafferPhrase: "загадочный прибор",
          interpretedName: "загадочный прибор",
          quantity: 1,
          match: {
            kind: "needsReview",
            candidates: [
              {
                equipmentId: "eq-2",
                catalogName: "Прибор А",
                category: "Прочее",
                availableQuantity: 1,
                rentalRatePerShift: "1000",
                confidence: 0.5,
              },
            ],
          },
        },
        {
          id: "x2",
          gafferPhrase: "непонятный свет",
          interpretedName: "непонятный свет",
          quantity: 1,
          match: { kind: "unmatched" },
        },
      ],
    });

    const result = await matchEquipment("загадочный прибор непонятный свет");
    if ("error" in result) throw new Error("Expected MatchResult, got error: " + result.error);

    expect(result.resolved).toHaveLength(0);
    expect(result.needsReview).toHaveLength(1);
    expect(result.unmatched).toEqual(["непонятный свет"]);
  });
});
