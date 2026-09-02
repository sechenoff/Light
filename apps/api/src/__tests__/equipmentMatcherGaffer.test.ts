/**
 * Матчинг позиций заявки гаффера с каталогом (matchGafferRequestOrdered):
 * исходная фраза учитывается наравне с AI-нормализованным именем.
 */
import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-matcher-gaffer.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.NODE_ENV = "test";

let matchGafferRequestOrdered: typeof import("../services/equipmentMatcher")["matchGafferRequestOrdered"];
let stripQuantityTokens: typeof import("../services/equipmentMatcher")["stripQuantityTokens"];

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, DATABASE_URL: `file:${TEST_DB_PATH}`, PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes" },
    stdio: "pipe",
  });
  const { prisma } = await import("../prisma");
  ({ matchGafferRequestOrdered, stripQuantityTokens } = await import("../services/equipmentMatcher"));
  const rows = [
    ["ChineVise Grip (цепной)", "Грип", 5],
    ["Прищепка металлическая большая, 160 мм, усиленная, черная", "Грип", 25],
    ["Прищепка металлическая малая, 50 мм, усиленная, черная", "Грип", 7],
    ["Aputure STORM 700x", "COB Light", 2],
    ["Линза френеля Aputure CF10 (для 700х)", "Насадки на приборы", 1],
    ["Удлинитель PCE (15м)", "Электрика/Коммутация", 40],
    ["Штатив Avenger OVERHEAD 58", "Штативы / Стойки", 6],
    // Соседи, отличающиеся только числом в хвосте: усечение количества не должно их путать.
    ["K5600 Joker-800", "HMI", 2],
    ["K5600 Joker-400", "HMI", 2],
    ["Хейзер 1800W Мощный", "Дымы / Haze", 1],
    ["Хейзер Antari HZ350", "Дымы / Haze", 1],
    ["Автополе 100", "Штативы / Стойки", 2],
    ["Автополе 150", "Штативы / Стойки", 2],
    ["Автополе 235 - 410", "Штативы / Стойки", 1],
    ["Трубный бум двойной D42", "Трубы", 1],
    ["Трубный бум двойной D48", "Трубы", 1],
    ["Текстиль 8' х 8'  MattBounce/Ultrabounce", "Текстиль", 1],
    ["Текстиль 12' х 12'  MattBounce/Ultrabounce", "Текстиль", 2],
    ["Рельсы раскладные алюминевые 210х18см", "Периферия", 1],
    ["Дестрибьютор 32/380 - 3х32/220", "Электрика/Коммутация", 5],
    ["Дестрибьютор 63/380 - 2х32/380", "Электрика/Коммутация", 2],
    // «Штатив …» — родовое слово: семь позиций с тем же первым словом — это не семья.
    ["Штатив Manfrotto 1004BAC", "Штативы / Стойки", 3],
    ["Штатив Kupo 40", "Штативы / Стойки", 3],
    ["Штатив Kupo 20", "Штативы / Стойки", 3],
    ["Штатив Super B250", "Штативы / Стойки", 3],
    ["Штатив 5-ти метровый", "Штативы / Стойки", 1],
    ["Штатив 6-Метровый", "Штативы / Стойки", 1],
  ] as const;
  const created: Record<string, string> = {};
  let sortOrder = 0;
  for (const [name, category, totalQuantity] of rows) {
    const row = await prisma.equipment.create({
      data: { importKey: `mg-${name}`, name, category, rentalRatePerShift: 1000, stockTrackingMode: "COUNT", totalQuantity, sortOrder: sortOrder++ },
    });
    created[name] = row.id;
  }
  // Псевдонимы сленга — как в боевом словаре: без количества и слитно.
  await prisma.slangAlias.createMany({
    data: [
      { phraseNormalized: "быт", phraseOriginal: "быт", equipmentId: created["Удлинитель PCE (15м)"], source: "SEED" },
      { phraseNormalized: "хайроллер", phraseOriginal: "хайроллер", equipmentId: created["Штатив Avenger OVERHEAD 58"], source: "SEED" },
      // Общие слова семейства: словарь показывает на один вариант, а фраза размер не называет.
      { phraseNormalized: "хейзер", phraseOriginal: "хейзер", equipmentId: created["Хейзер Antari HZ350"], source: "SEED", usageCount: 5 },
      { phraseNormalized: "автополя", phraseOriginal: "автополя", equipmentId: created["Автополе 235 - 410"], source: "MANUAL_ADMIN", usageCount: 1 },
      { phraseNormalized: "трубный бум", phraseOriginal: "трубный бум", equipmentId: created["Трубный бум двойной D42"], source: "AUTO_LEARNED", usageCount: 6 },
      { phraseNormalized: "мбю", phraseOriginal: "мбю", equipmentId: created["Текстиль 8' х 8'  MattBounce/Ultrabounce"], source: "AUTO_LEARNED", usageCount: 3 },
      { phraseNormalized: "12 мбю", phraseOriginal: "12 мбю", equipmentId: created["Текстиль 12' х 12'  MattBounce/Ultrabounce"], source: "AUTO_LEARNED", usageCount: 2 },
      { phraseNormalized: "штатив", phraseOriginal: "штатив", equipmentId: created["Штатив Manfrotto 1004BAC"], source: "AUTO_LEARNED", usageCount: 1 },
    ],
  });
});

afterAll(async () => {
  const { prisma } = await import("../prisma");
  await prisma.$disconnect();
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = TEST_DB_PATH + suffix;
    if (fs.existsSync(f)) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }
});

describe("matchGafferRequestOrdered — исходная фраза гаффера", () => {
  it("дословное название из каталога находится, даже если модель исказила имя", async () => {
    const [res] = await matchGafferRequestOrdered([
      { name: "chinavise grip", quantity: 4, gafferPhrase: "ChineVise Grip (цепной)" },
    ]);
    expect(res.kind).toBe("resolved");
    if (res.kind === "resolved") {
      expect(res.catalogName).toBe("ChineVise Grip (цепной)");
      expect(res.confidence).toBe(1);
    }
  });

  it("русская фраза находит русскую позицию, хотя модель перевела имя на английский", async () => {
    const [res] = await matchGafferRequestOrdered([
      { name: "metal clamp 160mm", quantity: 10, gafferPhrase: "Прищепка металлическая большая, 160 мм, усиленная," },
    ]);
    expect(res.kind).toBe("resolved");
    if (res.kind === "resolved") {
      expect(res.catalogName).toBe("Прищепка металлическая большая, 160 мм, усиленная, черная");
      expect(res.confidence).toBeGreaterThanOrEqual(0.7);
    }
  });

  it("без исходной фразы AI-имя матчится как раньше; насадка «для 700х» не подменяет прибор", async () => {
    const [res] = await matchGafferRequestOrdered([{ name: "aputure storm 700x", quantity: 1 }]);
    expect(res.kind).toBe("resolved");
    if (res.kind === "resolved") expect(res.catalogName).toBe("Aputure STORM 700x");
  });

  it("фраза без букв и цифр («—») не даёт ложного совпадения на 0.9", async () => {
    const [res] = await matchGafferRequestOrdered([
      { name: "неизвестный прибор xyz", quantity: 1, gafferPhrase: "—" },
    ]);
    expect(res.kind).toBe("unmatched");
  });

  it("чего нет в каталоге — честный unmatched, порядок результата совпадает с входом", async () => {
    const res = await matchGafferRequestOrdered([
      { name: "green ball", quantity: 10, gafferPhrase: "Green Ball" },
      { name: "chinavise grip", quantity: 1, gafferPhrase: "ChineVise Grip (цепной)" },
    ]);
    expect(res.map((r) => r.kind)).toEqual(["unmatched", "resolved"]);
  });
});

describe("stripQuantityTokens", () => {
  it("срезает количество в любом из ходовых написаний", () => {
    expect(stripQuantityTokens("Быт 25шт")).toBe("Быт");
    expect(stripQuantityTokens("Хай роллер (4)")).toBe("Хай роллер");
    expect(stripQuantityTokens("Мотыль-6")).toBe("Мотыль");
    expect(stripQuantityTokens("Капа — 12 шт.")).toBe("Капа");
    expect(stripQuantityTokens("Бытовой удлинитель — 25 шт.")).toBe("Бытовой удлинитель");
    expect(stripQuantityTokens("Дом 125(1)")).toBe("Дом 125");
    expect(stripQuantityTokens("2600 2шт")).toBe("2600");
    expect(stripQuantityTokens("Софтбокс x2")).toBe("Софтбокс");
  });

  it("не трогает размеры, модели и голое число в начале", () => {
    expect(stripQuantityTokens("12 мбю")).toBe("12 мбю");
    expect(stripQuantityTokens("Трубы 3м D42")).toBe("Трубы 3м D42");
    expect(stripQuantityTokens("Пена 1х0,5м")).toBe("Пена 1х0,5м");
    expect(stripQuantityTokens("Рама 20×20 трубная — 1 шт.")).toBe("Рама 20×20 трубная");
    expect(stripQuantityTokens("4 систенда")).toBe("4 систенда");
    expect(stripQuantityTokens("32/380(24)")).toBe("32/380");
  });
});

describe("matchGafferRequestOrdered — псевдонимы с количеством и пробелами", () => {
  it("«Быт 25шт» находит псевдоним «быт», хотя модель нормализовала в «byt»", async () => {
    const [res] = await matchGafferRequestOrdered([{ name: "byt", quantity: 25, gafferPhrase: "Быт 25шт" }]);
    expect(res.kind).toBe("resolved");
    if (res.kind === "resolved") expect(res.catalogName).toBe("Удлинитель PCE (15м)");
  });

  it("«Хай роллер (4)» находит слитный псевдоним «хайроллер»", async () => {
    const [res] = await matchGafferRequestOrdered([
      { name: "high roller stand", quantity: 4, gafferPhrase: "Хай роллер (4)" },
    ]);
    expect(res.kind).toBe("resolved");
    if (res.kind === "resolved") expect(res.catalogName).toBe("Штатив Avenger OVERHEAD 58");
  });

  it("число-модель в хвосте не принимается за количество: «K5600 Joker-800» ≠ Joker-400 (в любом порядке каталога)", async () => {
    for (const phrase of ["K5600 Joker-800", "K5600 Joker-400"]) {
      const [res] = await matchGafferRequestOrdered([{ name: "k5600 joker", quantity: 1, gafferPhrase: phrase }]);
      expect(res.kind).toBe("resolved");
      if (res.kind === "resolved") {
        expect(res.catalogName).toBe(phrase);
        expect(res.confidence).toBe(1);
      }
    }
  });
});

describe("matchGafferRequestOrdered — семейства позиций и уверенность", () => {
  it("«Хейзер» без модели → на проверку с обоими хейзерами, словарный первым", async () => {
    const [res] = await matchGafferRequestOrdered([{ name: "hazer", quantity: 1, gafferPhrase: "Хейзер" }]);
    expect(res.kind).toBe("needsReview");
    if (res.kind === "needsReview") {
      expect(res.candidates[0].catalogName).toBe("Хейзер Antari HZ350");
      expect(res.candidates.map((c) => c.catalogName)).toContain("Хейзер 1800W Мощный");
    }
  });

  it("«Хейзер antari» — модель названа → уверенно", async () => {
    const [res] = await matchGafferRequestOrdered([{ name: "antari hazer", quantity: 1, gafferPhrase: "Хейзер antari" }]);
    expect(res.kind).toBe("resolved");
    if (res.kind === "resolved") expect(res.catalogName).toBe("Хейзер Antari HZ350");
  });

  it("«Автополя» → всё семейство на проверку; «Автополе 150» → уверенно", async () => {
    const [plural] = await matchGafferRequestOrdered([{ name: "autopole", quantity: 1, gafferPhrase: "Автополя" }]);
    expect(plural.kind).toBe("needsReview");
    if (plural.kind === "needsReview") expect(plural.candidates).toHaveLength(3);
    const [sized] = await matchGafferRequestOrdered([{ name: "autopole 150", quantity: 1, gafferPhrase: "Автополе 150" }]);
    expect(sized.kind).toBe("resolved");
    if (sized.kind === "resolved") expect(sized.catalogName).toBe("Автополе 150");
  });

  it("«Трубный бум 2шт» — диаметр не назван → D42 и D48 на проверку", async () => {
    const [res] = await matchGafferRequestOrdered([{ name: "pipe boom", quantity: 2, gafferPhrase: "Трубный бум 2шт" }]);
    expect(res.kind).toBe("needsReview");
    if (res.kind === "needsReview") {
      expect(res.candidates.map((c) => c.catalogName)).toEqual(["Трубный бум двойной D42", "Трубный бум двойной D48"]);
    }
  });

  it("«Мбю»: размер из AI-имени снимает неоднозначность, без размера — на проверку, «12 мбю» — уверенно", async () => {
    const [sized] = await matchGafferRequestOrdered([{ name: "textile 8x8 mattbounce", quantity: 1, gafferPhrase: "Мбю" }]);
    expect(sized.kind).toBe("resolved");
    if (sized.kind === "resolved") expect(sized.catalogName).toBe("Текстиль 8' х 8'  MattBounce/Ultrabounce");
    const [bare] = await matchGafferRequestOrdered([{ name: "mattbounce", quantity: 1, gafferPhrase: "мбю" }]);
    expect(bare.kind).toBe("needsReview");
    const [twelve] = await matchGafferRequestOrdered([{ name: "textile 12x12 mattbounce", quantity: 1, gafferPhrase: "12 мбю" }]);
    expect(twelve.kind).toBe("resolved");
    if (twelve.kind === "resolved") expect(twelve.catalogName).toBe("Текстиль 12' х 12'  MattBounce/Ultrabounce");
  });

  it("«Расклад» не принимается за «Рельсы раскладные» (вхождение внутрь слова — не совпадение)", async () => {
    const [res] = await matchGafferRequestOrdered([{ name: "layout", quantity: 1, gafferPhrase: "Расклад" }]);
    expect(res.kind).not.toBe("resolved");
  });

  it("два почти равных кандидата (колодка 63/380 на 3х32/380) → на проверку, не угадываем", async () => {
    const [res] = await matchGafferRequestOrdered([
      { name: "distributor 63/380 to 3x32/380", quantity: 1, gafferPhrase: "Колодка 63/380 -3х32/380" },
    ]);
    expect(res.kind).toBe("needsReview");
    if (res.kind === "needsReview") {
      expect(res.candidates.map((c) => c.catalogName).sort()).toEqual(
        ["Дестрибьютор 32/380 - 3х32/220", "Дестрибьютор 63/380 - 2х32/380"],
      );
    }
  });
});

describe("matchGafferRequestOrdered — родовое слово не образует семью", () => {
  it("«Штатив» при семи+ соседях по первому слову остаётся уверенным словарным выбором", async () => {
    const [res] = await matchGafferRequestOrdered([{ name: "stand", quantity: 1, gafferPhrase: "Штатив" }]);
    expect(res.kind).toBe("resolved");
    if (res.kind === "resolved") expect(res.catalogName).toBe("Штатив Manfrotto 1004BAC");
  });
});
