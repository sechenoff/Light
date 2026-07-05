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

    // L-AVAIL #28: без броней occupied = 0 → маршрут классифицирует AVAILABLE,
    // а не PARTIAL, несмотря на 4 usable < 5 totalQuantity у UNIT-позиции.
    expect(unitRow?.occupiedQuantity).toBe(0);
    expect(countRow?.occupiedQuantity).toBe(0);
  });
});

describe("getAvailability — COUNT-потеряшки уменьшают базу (F-LOST-1)", () => {
  it("вычитает открытые COUNT-потеряшки из totalQuantity, FOUND не вычитается", async () => {
    const { prisma } = await import("../prisma");
    const { getAvailability } = await import("../services/availability");

    // COUNT-позиция: 20 удлинителей всего
    const eq = await prisma.equipment.create({
      data: {
        category: "Тест-категория",
        name: "COUNT-удлинитель",
        importKey: "flost1-count-eq",
        rentalRatePerShift: "100",
        stockTrackingMode: "COUNT",
        totalQuantity: 20,
      },
    });
    const client = await prisma.client.create({ data: { name: "Клиент F-LOST-1" } });
    const booking = await prisma.booking.create({
      data: {
        client: { connect: { id: client.id } },
        projectName: "Проект F-LOST-1",
        status: "RETURNED",
        startDate: new Date("2026-06-01T00:00:00.000Z"),
        endDate: new Date("2026-06-02T00:00:00.000Z"),
      },
    });
    const bookingItem = await prisma.bookingItem.create({
      data: { bookingId: booking.id, equipmentId: eq.id, quantity: 20 },
    });

    // 5 утеряно (SEARCHING) + 2 списано (WROTE_OFF) → -7 из базы
    await prisma.problemItem.create({
      data: {
        bookingItemId: bookingItem.id, quantity: 5, sourceBookingId: booking.id,
        reason: "LOST", comment: "потеряны на площадке", status: "SEARCHING", createdBy: "tester",
      },
    });
    await prisma.problemItem.create({
      data: {
        bookingItemId: bookingItem.id, quantity: 2, sourceBookingId: booking.id,
        reason: "DESTROYED", comment: "сломаны", status: "WROTE_OFF", createdBy: "tester",
      },
    });
    // 3 «найдено» (FOUND) → НЕ вычитается (вернулось в оборот)
    await prisma.problemItem.create({
      data: {
        bookingItemId: bookingItem.id, quantity: 3, sourceBookingId: booking.id,
        reason: "LEFT_ON_SITE", comment: "нашлись", status: "FOUND", createdBy: "tester",
      },
    });

    // Проверяем в НЕ пересекающемся с броней окне, чтобы occupied по броне = 0.
    const rows = await getAvailability({
      startDate: new Date("2026-08-01T00:00:00.000Z"),
      endDate: new Date("2026-08-02T00:00:00.000Z"),
      equipmentIds: [eq.id],
    });
    const row = rows.find((r) => r.equipment.id === eq.id);

    // база = 20 − (5 + 2) = 13; occupied = 0 (бронь вне окна) → доступно 13
    expect(row?.occupiedQuantity).toBe(0);
    expect(row?.availableQuantity).toBe(13);
  });
});
