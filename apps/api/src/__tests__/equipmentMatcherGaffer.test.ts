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
