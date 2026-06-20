import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

/**
 * eu-2: для UNIT-позиций база доступности — число ПРИГОДНЫХ к выдаче единиц
 * (AVAILABLE+ISSUED), а не totalQuantity. Единицы в MAINTENANCE/RETIRED/MISSING
 * не должны раздувать «Доступно». COUNT-позиции остаются на totalQuantity.
 */

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-avail-unitmode.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.NODE_ENV = "test";

beforeAll(() => {
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../.."),
    env: {
      ...process.env,
      DATABASE_URL: `file:${TEST_DB_PATH}`,
      PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes",
    },
    stdio: "pipe",
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

describe("getAvailability — UNIT base = usable units (eu-2)", () => {
  it("исключает MAINTENANCE/MISSING из базы доступности UNIT-позиции", async () => {
    const { prisma } = await import("../prisma");
    const { getAvailability } = await import("../services/availability");

    // UNIT-позиция: totalQuantity=5, но 3 AVAILABLE + 1 MAINTENANCE + 1 MISSING
    const unitEq = await prisma.equipment.create({
      data: {
        category: "Тест-категория",
        name: "UNIT-прибор",
        importKey: "eu2-unit-eq",
        rentalRatePerShift: "1000",
        stockTrackingMode: "UNIT",
        totalQuantity: 5,
      },
    });
    const statuses = ["AVAILABLE", "AVAILABLE", "AVAILABLE", "MAINTENANCE", "MISSING"] as const;
    for (let i = 0; i < statuses.length; i++) {
      await prisma.equipmentUnit.create({
        data: { equipmentId: unitEq.id, barcode: `EU2-${i}`, status: statuses[i] },
      });
    }

    // COUNT-позиция (контроль): база = totalQuantity, единиц нет
    const countEq = await prisma.equipment.create({
      data: {
        category: "Тест-категория",
        name: "COUNT-прибор",
        importKey: "eu2-count-eq",
        rentalRatePerShift: "500",
        stockTrackingMode: "COUNT",
        totalQuantity: 4,
      },
    });

    const rows = await getAvailability({
      startDate: new Date("2026-07-01T00:00:00.000Z"),
      endDate: new Date("2026-07-02T00:00:00.000Z"),
      equipmentIds: [unitEq.id, countEq.id],
    });

    const unitRow = rows.find((r) => r.equipment.id === unitEq.id);
    const countRow = rows.find((r) => r.equipment.id === countEq.id);

    // UNIT: доступно = 3 (только AVAILABLE/ISSUED), НЕ 5 (totalQuantity)
    expect(unitRow?.availableQuantity).toBe(3);
    // COUNT: доступно = totalQuantity = 4
    expect(countRow?.availableQuantity).toBe(4);
  });
});
