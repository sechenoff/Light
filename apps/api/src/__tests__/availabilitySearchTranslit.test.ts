/**
 * P11: поиск доступности (витрина, добор со страницы и из киоска) находит
 * позиции, где в названии кириллица и латиница перемешаны.
 *
 * На проде «Линза френеля Aputure СF16» набрана с кириллической «С», «Соты для
 * рамы 8х8» — с кириллической «х». Поиск «cf16» и «8x8» отвечал «Ничего не
 * найдено» (06.09).
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-availability-search-translit.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-avail-translit";

const DAY = 24 * 3_600_000;
const START = new Date(Date.now() + 5 * DAY);
const END = new Date(START.getTime() + 2 * DAY);

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
  prisma = (await import("../prisma")).prisma;
  const rows = [
    ["translit-lens", "Линза френеля Aputure СF16 Fresnel Motorised", "Оптика"], // С — кириллица
    ["translit-grid", "Соты для рамы 8х8", "Рамы"], // х — кириллица
    ["translit-stand", "Штатив Manfrotto", "Грип"],
  ];
  for (const [importKey, name, category] of rows) {
    await prisma.equipment.create({
      data: { importKey, name, category, rentalRatePerShift: "1000", stockTrackingMode: "COUNT", totalQuantity: 2 },
    });
  }
});

afterAll(async () => {
  await prisma.$disconnect();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const f = TEST_DB_PATH + suffix;
    if (fs.existsSync(f)) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }
});

async function search(q: string): Promise<string[]> {
  const { getAvailability } = await import("../services/availability");
  const rows = await getAvailability({ startDate: START, endDate: END, search: q });
  return rows.map((r) => r.equipment.name);
}

describe("getAvailability: поиск с кириллицей и латиницей вперемешку", () => {
  it("латинское «cf16» находит линзу с кириллической «С»; кириллическое — тоже", async () => {
    expect(await search("cf16")).toEqual(["Линза френеля Aputure СF16 Fresnel Motorised"]);
    expect(await search("сf16")).toEqual(["Линза френеля Aputure СF16 Fresnel Motorised"]);
    expect(await search("CF16")).toEqual(["Линза френеля Aputure СF16 Fresnel Motorised"]);
  });

  it("размер находится при любом написании знака", async () => {
    for (const q of ["8x8", "8х8", "8×8", "8 x 8"]) {
      expect(await search(q)).toEqual(["Соты для рамы 8х8"]);
    }
  });

  it("поиск добора (страница брони и киоск) находит позиции по латинице и по кириллице", async () => {
    const { searchAddonCandidates } = await import("../services/bookingAddon");
    const client = await prisma.client.create({ data: { name: "Клиент поиска" } });
    const booking = await prisma.booking.create({
      data: { clientId: client.id, projectName: "Поиск добора", startDate: START, endDate: END, status: "CONFIRMED" },
    });
    const names = async (q: string) =>
      (await searchAddonCandidates({ bookingId: booking.id, q })).map((r) => r.name);
    expect(await names("cf16")).toEqual(["Линза френеля Aputure СF16 Fresnel Motorised"]); // раньше «Ничего не найдено»
    expect(await names("сf16")).toEqual(["Линза френеля Aputure СF16 Fresnel Motorised"]);
    expect(await names("8x8")).toEqual(["Соты для рамы 8х8"]);
    expect(await names("8х8")).toEqual(["Соты для рамы 8х8"]);
  });

  it("обычный поиск по-русски не сломан и не находит лишнего", async () => {
    expect(await search("штатив")).toEqual(["Штатив Manfrotto"]);
    expect(await search("грип")).toEqual(["Штатив Manfrotto"]); // по категории
    expect(await search("нет такого")).toEqual([]);
  });
});
