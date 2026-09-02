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

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, DATABASE_URL: `file:${TEST_DB_PATH}`, PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes" },
    stdio: "pipe",
  });
  const { prisma } = await import("../prisma");
  ({ matchGafferRequestOrdered } = await import("../services/equipmentMatcher"));
  const rows = [
    ["ChineVise Grip (цепной)", "Грип", 5],
    ["Прищепка металлическая большая, 160 мм, усиленная, черная", "Грип", 25],
    ["Прищепка металлическая малая, 50 мм, усиленная, черная", "Грип", 7],
    ["Aputure STORM 700x", "COB Light", 2],
    ["Линза френеля Aputure CF10 (для 700х)", "Насадки на приборы", 1],
  ] as const;
  for (const [name, category, totalQuantity] of rows) {
    await prisma.equipment.create({
      data: { importKey: `mg-${name}`, name, category, rentalRatePerShift: 1000, stockTrackingMode: "COUNT", totalQuantity },
    });
  }
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
