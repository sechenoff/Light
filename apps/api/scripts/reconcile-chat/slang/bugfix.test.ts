import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { dbAt } from "../db/prisma";
import { fixSlangQtyMarker } from "./bugfix";

const TEST_DB = path.resolve(__dirname, "../../../prisma/test-slang-bugfix.db");
process.env.DATABASE_URL = `file:${TEST_DB}`;

beforeAll(() => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../../.."),
    env: {
      ...process.env,
      DATABASE_URL: `file:${TEST_DB}`,
      PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes",
    },
    stdio: "pipe",
  });
});

afterAll(() => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});

describe("fixSlangQtyMarker", () => {
  it("strips «(N)» from phraseOriginal and merges on UNIQUE conflict", async () => {
    const prisma = dbAt(TEST_DB);
    try {
      const eq = await prisma.equipment.create({
        data: {
          name: "Pena 1",
          importKey: "pena_1_test",
          category: "test",
          totalQuantity: 10,
          rentalRatePerShift: 100,
          stockTrackingMode: "COUNT",
        },
      });
      await prisma.slangAlias.create({
        data: { phraseOriginal: "Пена (1)", phraseNormalized: "пена (1)", equipmentId: eq.id, usageCount: 3 },
      });
      await prisma.slangAlias.create({
        data: { phraseOriginal: "Пена", phraseNormalized: "пена", equipmentId: eq.id, usageCount: 2 },
      });

      const result = await fixSlangQtyMarker(prisma);
      expect(result.deleted).toBe(1);
      expect(result.merged).toBe(1);

      const remaining = await prisma.slangAlias.findMany({ where: { equipmentId: eq.id } });
      expect(remaining).toHaveLength(1);
      expect(remaining[0].phraseOriginal).toBe("Пена");
      expect(remaining[0].usageCount).toBe(5);
    } finally {
      await prisma.$disconnect();
    }
  });
});
