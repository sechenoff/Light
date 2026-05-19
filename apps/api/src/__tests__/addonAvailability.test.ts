/**
 * Интеграционный тест: findAddonConflict — детекция конфликта добора
 * Phase 1 (warehouse-scan redesign) — Task 1.1
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-addon-avail.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-addon-avail";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-addon-avail";
process.env.WAREHOUSE_SECRET = "test-warehouse-addon-avail";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-addon-avail-min16chars";

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
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }
});

describe("findAddonConflict", () => {
  it("returns conflict when COUNT equipment fully booked in window by another CONFIRMED booking", async () => {
    const eq = await prisma.equipment.create({
      data: { importKey: "addon-eq-1", name: "Astera Titan", category: "Свет",
        rentalRatePerShift: 1000, stockTrackingMode: "COUNT", totalQuantity: 1 },
    });
    const client = await prisma.client.create({ data: { name: "К1" } });
    const other = await prisma.booking.create({
      data: { clientId: client.id, projectName: "Конфликт", status: "CONFIRMED",
        startDate: new Date("2026-06-10"), endDate: new Date("2026-06-12") },
    });
    await prisma.bookingItem.create({ data: { bookingId: other.id, equipmentId: eq.id, quantity: 1 } });
    const target = await prisma.booking.create({
      data: { clientId: client.id, projectName: "Целевая", status: "CONFIRMED",
        startDate: new Date("2026-06-11"), endDate: new Date("2026-06-13") },
    });

    const { findAddonConflict } = await import("../services/addonAvailability");
    const c = await findAddonConflict(eq.id, target.startDate, target.endDate, target.id);
    expect(c).not.toBeNull();
    expect(c!.bookingId).toBe(other.id);
    expect(new Date(c!.freeFrom).getTime()).toBe(new Date("2026-06-12").getTime());
  });

  it("returns null when free", async () => {
    const eq = await prisma.equipment.create({
      data: { importKey: "addon-eq-2", name: "Свободный", category: "Свет",
        rentalRatePerShift: 1, stockTrackingMode: "COUNT", totalQuantity: 2 },
    });
    const client = await prisma.client.create({ data: { name: "К2" } });
    const target = await prisma.booking.create({
      data: { clientId: client.id, projectName: "Ц2", status: "CONFIRMED",
        startDate: new Date("2026-07-01"), endDate: new Date("2026-07-02") },
    });
    const { findAddonConflict } = await import("../services/addonAvailability");
    expect(await findAddonConflict(eq.id, target.startDate, target.endDate, target.id)).toBeNull();
  });

  it("returns null at partial capacity (totalQuantity 2, one overlapping booking qty 1)", async () => {
    const eq = await prisma.equipment.create({
      data: { importKey: "addon-eq-3", name: "Полу-свободный", category: "Свет",
        rentalRatePerShift: 1, stockTrackingMode: "COUNT", totalQuantity: 2 },
    });
    const client = await prisma.client.create({ data: { name: "К3" } });
    const other = await prisma.booking.create({
      data: { clientId: client.id, projectName: "Частичный конфликт", status: "CONFIRMED",
        startDate: new Date("2026-08-10"), endDate: new Date("2026-08-12") },
    });
    await prisma.bookingItem.create({ data: { bookingId: other.id, equipmentId: eq.id, quantity: 1 } });
    const target = await prisma.booking.create({
      data: { clientId: client.id, projectName: "Ц3", status: "CONFIRMED",
        startDate: new Date("2026-08-11"), endDate: new Date("2026-08-13") },
    });
    const { findAddonConflict } = await import("../services/addonAvailability");
    expect(await findAddonConflict(eq.id, target.startDate, target.endDate, target.id)).toBeNull();
  });

  it("returns null when the only blocking booking does not overlap the window", async () => {
    const eq = await prisma.equipment.create({
      data: { importKey: "addon-eq-4", name: "Несовпадающий", category: "Свет",
        rentalRatePerShift: 1, stockTrackingMode: "COUNT", totalQuantity: 1 },
    });
    const client = await prisma.client.create({ data: { name: "К4" } });
    const other = await prisma.booking.create({
      data: { clientId: client.id, projectName: "Вне окна", status: "CONFIRMED",
        startDate: new Date("2026-09-01"), endDate: new Date("2026-09-03") },
    });
    await prisma.bookingItem.create({ data: { bookingId: other.id, equipmentId: eq.id, quantity: 1 } });
    const target = await prisma.booking.create({
      data: { clientId: client.id, projectName: "Ц4", status: "CONFIRMED",
        startDate: new Date("2026-09-20"), endDate: new Date("2026-09-22") },
    });
    const { findAddonConflict } = await import("../services/addonAvailability");
    expect(await findAddonConflict(eq.id, target.startDate, target.endDate, target.id)).toBeNull();
  });
});
