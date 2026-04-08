/**
 * Тесты сервиса competitorMatcher.
 *
 * Тестирует sanitizeCell, batchMatchWithGemini (мок Gemini), saveAliases.
 * Используют отдельную тестовую БД: test-competitor.db
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-competitor.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-competitor";
process.env.WAREHOUSE_SECRET = "test-warehouse-competitor";

// Общий mock для generateContent — можно переопределять в каждом тесте
const mockGenerateContent = vi.fn();

// Мок Gemini SDK — класс должен быть function (не arrow) для совместимости с new
vi.mock("@google/generative-ai", () => {
  return {
    GoogleGenerativeAI: vi.fn().mockImplementation(function () {
      return {
        getGenerativeModel: vi.fn().mockReturnValue({
          generateContent: mockGenerateContent,
        }),
      };
    }),
  };
});

let prisma: any;

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../.."),
    env: {
      ...process.env,
      DATABASE_URL: `file:${TEST_DB_PATH}`,
      PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes",
    },
    stdio: "pipe",
  });

  const pmod = await import("../prisma");
  prisma = pmod.prisma;
});

afterAll(async () => {
  await prisma.$disconnect();
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = TEST_DB_PATH + suffix;
    if (fs.existsSync(f)) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* игнорируем */
      }
    }
  }
});

// Вспомогательная функция: создать оборудование в тестовой БД
async function createTestEquipment(name: string, category: string) {
  return prisma.equipment.create({
    data: {
      importKey: `${category.toUpperCase()}||${name.toUpperCase()}||||`,
      category,
      name,
      totalQuantity: 1,
      rentalRatePerShift: 1000,
    },
  });
}

// ──────────────────────────────────────────────────────────────────
// sanitizeCell
// ──────────────────────────────────────────────────────────────────

describe("sanitizeCell", () => {
  it("удаляет управляющие символы", async () => {
    const { sanitizeCell } = await import("../services/competitorMatcher");
    const input = "Aputure\x00LS\x1f1200x\x7f";
    const result = sanitizeCell(input);
    expect(result).toBe("AputureLS1200x");
  });

  it("обрезает строку до 500 символов", async () => {
    const { sanitizeCell } = await import("../services/competitorMatcher");
    const long = "A".repeat(600);
    const result = sanitizeCell(long);
    expect(result.length).toBe(500);
  });

  it("оставляет обычный текст без изменений", async () => {
    const { sanitizeCell } = await import("../services/competitorMatcher");
    const input = "Nanlite PavoSlim 240C";
    expect(sanitizeCell(input)).toBe("Nanlite PavoSlim 240C");
  });
});

// ──────────────────────────────────────────────────────────────────
// batchMatchWithGemini
// ──────────────────────────────────────────────────────────────────

describe("batchMatchWithGemini", () => {
  it("возвращает совпадения из мок-ответа Gemini", async () => {
    const { batchMatchWithGemini } = await import("../services/competitorMatcher");

    const eq = await createTestEquipment("Aputure LS 1200x PRO", "Осветительные приборы");

    // Настраиваем мок: возвращаем JSON-массив матчей
    const mockResponse = JSON.stringify([
      {
        competitorItem: "Aputure 1200x",
        catalogId: eq.id,
        confidence: 0.92,
        reason: "Идентичный прибор с немного другим названием",
      },
    ]);

    mockGenerateContent.mockResolvedValueOnce({
      response: { text: () => mockResponse },
    });

    // Нужен ключ для работы Gemini
    process.env.GEMINI_API_KEY = "test-key-mock";

    const items = [{ name: "Aputure 1200x", category: "Осветительные приборы" }];
    const catalog = [
      {
        id: eq.id,
        name: eq.name,
        category: eq.category,
        brand: null,
        model: null,
      },
    ];

    const matches = await batchMatchWithGemini(items, catalog, "Конкурент Альфа");

    expect(matches.length).toBe(1);
    expect(matches[0].competitorItem).toBe("Aputure 1200x");
    expect(matches[0].catalogId).toBe(eq.id);
    expect(matches[0].confidence).toBeCloseTo(0.92);
  });

  it("возвращает пустой массив при ошибке Gemini", async () => {
    const { batchMatchWithGemini } = await import("../services/competitorMatcher");

    mockGenerateContent.mockRejectedValueOnce(new Error("API Error"));

    process.env.GEMINI_API_KEY = "test-key-mock";

    const items = [{ name: "Что-то" }];
    const catalog = [{ id: "id1", name: "Что-то каталог", category: "Прочее", brand: null, model: null }];

    const matches = await batchMatchWithGemini(items, catalog, "Конкурент Бета");

    expect(matches).toEqual([]);
  });

  it("возвращает пустой массив если GEMINI_API_KEY не задан", async () => {
    const { batchMatchWithGemini } = await import("../services/competitorMatcher");

    const savedKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;

    const items = [{ name: "Что-то" }];
    const catalog = [{ id: "id1", name: "Что-то", category: "Прочее", brand: null, model: null }];

    const matches = await batchMatchWithGemini(items, catalog, "Конкурент Гамма");

    expect(matches).toEqual([]);

    process.env.GEMINI_API_KEY = savedKey;
  });
});

// ──────────────────────────────────────────────────────────────────
// saveAliases
// ──────────────────────────────────────────────────────────────────

describe("saveAliases", () => {
  it("создаёт CompetitorAlias для матчей с уверенностью ≥ 0.8", async () => {
    const { saveAliases } = await import("../services/competitorMatcher");

    const eq = await createTestEquipment("Nanlite PavoSlim SaveTest", "Свет");

    await saveAliases("Конкурент Сохр", [
      { competitorItem: "PavoSlim 240", catalogId: eq.id, confidence: 0.85 },
    ]);

    const alias = await prisma.competitorAlias.findFirst({
      where: { competitorName: "Конкурент Сохр", competitorItem: "PavoSlim 240" },
    });

    expect(alias).not.toBeNull();
    expect(alias.equipmentId).toBe(eq.id);
  });

  it("не создаёт CompetitorAlias для матчей с уверенностью < 0.8", async () => {
    const { saveAliases } = await import("../services/competitorMatcher");

    const eq = await createTestEquipment("Прожектор LowConf", "Свет");

    await saveAliases("Конкурент Низкий", [
      { competitorItem: "Что-то низкое", catalogId: eq.id, confidence: 0.75 },
    ]);

    const alias = await prisma.competitorAlias.findFirst({
      where: { competitorName: "Конкурент Низкий", competitorItem: "Что-то низкое" },
    });

    expect(alias).toBeNull();
  });

  it("upsert: повторный вызов не создаёт дубликат", async () => {
    const { saveAliases } = await import("../services/competitorMatcher");

    const eq = await createTestEquipment("Прожектор Upsert", "Свет");

    await saveAliases("Конкурент Дубль", [
      { competitorItem: "Прожектор дубль", catalogId: eq.id, confidence: 0.9 },
    ]);

    await saveAliases("Конкурент Дубль", [
      { competitorItem: "Прожектор дубль", catalogId: eq.id, confidence: 0.95 },
    ]);

    const aliases = await prisma.competitorAlias.findMany({
      where: { competitorName: "Конкурент Дубль", competitorItem: "Прожектор дубль" },
    });

    expect(aliases.length).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────
// Интеграция: alias lookup при matchRow
// ──────────────────────────────────────────────────────────────────

describe("alias lookup в matchRow", () => {
  it("второй импорт использует alias и возвращает matchMethod=alias", async () => {
    const { saveAliases } = await import("../services/competitorMatcher");
    const { matchRow } = await import("../services/importSession");

    const eq = await createTestEquipment("Aputure STORM 400x AliasTest", "Свет");

    // Сохраняем alias вручную (имитируем первый импорт с Gemini)
    await saveAliases("АлиасКонкурент", [
      { competitorItem: "STORM 400x alias", catalogId: eq.id, confidence: 0.88 },
    ]);

    const catalog = [
      {
        id: eq.id,
        importKey: eq.importKey,
        category: eq.category,
        name: eq.name,
        brand: null,
        model: null,
        totalQuantity: eq.totalQuantity,
        rentalRatePerShift: eq.rentalRatePerShift,
        rentalRateTwoShifts: null,
        rentalRatePerProject: null,
      },
    ];

    // Pre-load alias map (as mapAndMatch does)
    const aliases = await prisma.competitorAlias.findMany({ where: { competitorName: "АлиасКонкурент" } });
    const aliasMap = new Map<string, string>();
    for (const a of aliases) aliasMap.set(a.competitorItem.toLowerCase(), a.equipmentId);

    const result = await matchRow(
      { sourceName: "STORM 400x alias", sourceCategory: "Свет", sourceBrand: null, sourceModel: null },
      catalog,
      "АлиасКонкурент",
      aliasMap,
    );

    expect(result.equipmentId).toBe(eq.id);
    expect(result.matchMethod).toBe("alias");
    expect(result.matchConfidence).toBe(0.9);
  });
});
