/**
 * refineMatchesWithAi — AI-подбор каталога для спорных строк.
 * Провайдер подменён: проверяем, что уходит модели и как применяются решения.
 */
import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-catalog-picker.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.NODE_ENV = "test";

const llm = vi.hoisted(() => ({ pick: vi.fn(), hasPick: true }));
vi.mock("../services/llm", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../services/llm")>();
  return {
    ...orig,
    getLlmProvider: () =>
      llm.hasPick
        ? { extractGafferLines: vi.fn(), pickCatalogMatches: llm.pick }
        : { extractGafferLines: vi.fn() },
  };
});

type Picker = typeof import("../services/catalogPicker");
type Matcher = typeof import("../services/equipmentMatcher");
let picker: Picker;
let matcher: Matcher;
const ids: Record<string, string> = {};
const rowOf: Record<string, number> = {};

const NAMES = {
  light52: "Aputure Electric storm 52XT (Blair)",
  lens52: "Линза френеля Aputure CF16 Fresnel Motorised для 52xt",
  nova: "Aputure NOVA P300C RGBWW",
  soft: "Софтбокс для Aputure NOVA P300C RGBWW",
  cstand: 'Штатив Avenger 40" C-STAND',
};

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, DATABASE_URL: `file:${TEST_DB_PATH}`, PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes" },
    stdio: "pipe",
  });
  const { prisma } = await import("../prisma");
  picker = await import("../services/catalogPicker");
  matcher = await import("../services/equipmentMatcher");
  let sortOrder = 0;
  for (const [key, name] of Object.entries(NAMES)) {
    const row = await prisma.equipment.create({
      data: { importKey: `cp-${key}`, name, category: key === "cstand" ? "Штативы / Стойки" : "Свет", rentalRatePerShift: 1000, stockTrackingMode: "COUNT", totalQuantity: 3, sortOrder: sortOrder++ },
    });
    ids[key] = row.id;
  }
  // Номера строк — по тому же запросу, что делает picker.
  const ordered = await prisma.equipment.findMany({ where: { totalQuantity: { gt: 0 } }, orderBy: { sortOrder: "asc" }, select: { id: true } });
  ordered.forEach((r, i) => {
    const key = Object.entries(ids).find(([, id]) => id === r.id)?.[0];
    if (key) rowOf[key] = i + 1;
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

beforeEach(() => {
  llm.pick.mockReset();
  llm.hasPick = true;
  delete process.env.LLM_CATALOG_PICK;
});
afterEach(() => {
  delete process.env.LLM_CATALOG_PICK;
});

/** Спорная строка (кандидаты) + уверенная — как отдаёт матчер. */
function baseMatches(): { lines: Parameters<Picker["refineMatchesWithAi"]>[0]; matches: Parameters<Picker["refineMatchesWithAi"]>[1] } {
  const cand = (key: keyof typeof NAMES) => ({
    equipmentId: ids[key], catalogName: NAMES[key], category: "Свет", availableQuantity: 3, rentalRatePerShift: "1000", confidence: 0.9,
  });
  return {
    lines: [
      { gafferPhrase: "2 шт 52xt блэр", interpretedName: "52xt", quantity: 2 },
      { gafferPhrase: "4 ц-стенда", interpretedName: "c-stand", quantity: 4 },
      { gafferPhrase: "нова р300 с софтом", interpretedName: "nova p300", quantity: 1 },
      { gafferPhrase: "апутура 600д", interpretedName: "aputure 600d", quantity: 1 },
    ],
    matches: [
      { kind: "needsReview", candidates: [cand("light52"), cand("lens52")] },
      { kind: "resolved", equipmentId: ids.cstand, catalogName: NAMES.cstand, category: "Штативы / Стойки", availableQuantity: 3, rentalRatePerShift: "1000", confidence: 1 },
      { kind: "needsReview", candidates: [cand("nova"), cand("soft")] },
      { kind: "unmatched" },
    ],
  };
}

describe("refineMatchesWithAi", () => {
  it("модели уходит весь каталог и все строки; решаются только спорные", async () => {
    llm.pick.mockResolvedValue([
      { line: 1, rows: [rowOf.light52] },
      { line: 3, rows: [rowOf.nova, rowOf.soft] },
      { line: 4, rows: [] },
    ]);
    const { lines, matches } = baseMatches();

    const res = await picker.refineMatchesWithAi(lines, matches);

    const input = llm.pick.mock.calls[0][0];
    expect(input.catalog).toHaveLength(Object.keys(NAMES).length);
    expect(input.catalog.map((r: { row: number }) => r.row)).toEqual([1, 2, 3, 4, 5]);
    expect(input.lines.map((l: { decide: boolean }) => l.decide)).toEqual([true, false, true, true]);
    expect(input.lines[0].candidateRows).toEqual([rowOf.light52, rowOf.lens52]);
    expect(input.lines[1].matchedRow).toBe(rowOf.cstand);
    expect(input.lines[3].candidateRows).toBeUndefined();

    expect(res.aiDecided).toBe(2);
    expect(res.matches[0]).toMatchObject({ kind: "resolved", equipmentId: ids.light52, confidence: picker.AI_PICK_CONFIDENCE });
    expect(res.matches[1]).toBe(matches[1]); // уверенное совпадение не тронуто
    expect(res.matches[2]).toMatchObject({ kind: "resolved", equipmentId: ids.nova });
    expect(res.extras).toEqual([{ lineIndex: 2, match: expect.objectContaining({ kind: "resolved", equipmentId: ids.soft }) }]);
    // «в каталоге нет» — остаётся unmatched
    expect(res.matches[3]).toEqual({ kind: "unmatched" });
  });

  it("решения по уверенным строкам и несуществующие номера игнорируются", async () => {
    llm.pick.mockResolvedValue([
      { line: 2, rows: [rowOf.nova] }, // строка уже resolved
      { line: 4, rows: [999] }, // такого номера нет
    ]);
    const { lines, matches } = baseMatches();
    const res = await picker.refineMatchesWithAi(lines, matches);
    expect(res.aiDecided).toBe(0);
    expect(res.matches).toEqual(matches);
    expect(res.extras).toEqual([]);
  });

  it("без спорных строк модель не вызывается", async () => {
    const { lines, matches } = baseMatches();
    const allResolved = matches.map((m) => (m.kind === "resolved" ? m : matches[1]));
    const res = await picker.refineMatchesWithAi(lines, allResolved);
    expect(llm.pick).not.toHaveBeenCalled();
    expect(res.matches).toBe(allResolved);
  });

  it("провайдер без подбора или LLM_CATALOG_PICK=off — результат матчера как есть", async () => {
    const { lines, matches } = baseMatches();
    llm.hasPick = false;
    expect((await picker.refineMatchesWithAi(lines, matches)).matches).toBe(matches);

    llm.hasPick = true;
    process.env.LLM_CATALOG_PICK = "off";
    expect((await picker.refineMatchesWithAi(lines, matches)).matches).toBe(matches);
    expect(llm.pick).not.toHaveBeenCalled();
  });

  it("сбой модели пробрасывается — маршрут решает, что делать", async () => {
    llm.pick.mockRejectedValue(new Error("529 overloaded"));
    const { lines, matches } = baseMatches();
    await expect(picker.refineMatchesWithAi(lines, matches)).rejects.toThrow("529 overloaded");
  });

  it("живой матчер: уверенное совпадение модель не пересматривает", async () => {
    const real = await matcher.matchGafferRequestOrdered([
      { name: "aputure nova p300c", quantity: 1, gafferPhrase: "Aputure NOVA P300C RGBWW" },
    ]);
    expect(real[0].kind).toBe("resolved");
    const res = await picker.refineMatchesWithAi(
      [{ gafferPhrase: "Aputure NOVA P300C RGBWW", interpretedName: "aputure nova p300c", quantity: 1 }],
      real,
    );
    expect(llm.pick).not.toHaveBeenCalled();
    expect(res.matches).toBe(real);
  });
});
