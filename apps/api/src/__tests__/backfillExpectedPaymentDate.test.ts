/**
 * B3 — Тесты скрипта backfill-expected-payment-date.ts
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-backfill-epd.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.NODE_ENV = "test";

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

beforeEach(async () => {
  // Cleanup bookings and clients between tests
  await prisma.bookingItem.deleteMany({});
  await prisma.booking.deleteMany({});
  await prisma.client.deleteMany({});
});

let _counter = 0;
async function makeBooking(overrides: { expectedPaymentDate?: Date | null; status?: string } = {}) {
  const uid = `${Date.now()}_${++_counter}`;
  const client = await prisma.client.create({ data: { name: `Клиент ${uid}` } });
  return prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: "Проект",
      startDate: new Date("2026-05-08T10:00:00Z"),
      endDate: new Date("2026-05-10T10:00:00Z"),
      status: overrides.status ?? "DRAFT",
      expectedPaymentDate: overrides.expectedPaymentDate ?? null,
    },
  });
}

const SCRIPT_PATH = path.resolve(__dirname, "../../scripts/backfill-expected-payment-date.ts");

function runScript(args: string[] = []) {
  return execSync(`npx tsx "${SCRIPT_PATH}" ${args.join(" ")}`, {
    env: { ...process.env, DATABASE_URL: `file:${TEST_DB_PATH}` },
    encoding: "utf-8",
  });
}

describe("backfill-expected-payment-date", () => {
  it("dry-run: не изменяет записи, выводит статистику", async () => {
    // Set default terms to 7
    await prisma.organizationSettings.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", legalName: "", inn: "", defaultPaymentTermsDays: 7 },
      update: { defaultPaymentTermsDays: 7 },
    });

    // F6: backfill only processes CONFIRMED/ISSUED/RETURNED bookings
    const booking = await makeBooking({ expectedPaymentDate: null, status: "CONFIRMED" });
    expect(booking.expectedPaymentDate).toBeNull();

    const output = runScript([]); // dry-run (no --execute)
    expect(output).toMatch(/DRY-RUN/);
    expect(output).toMatch(/1/); // found 1 booking

    // DB unchanged
    const after = await prisma.booking.findUnique({ where: { id: booking.id } });
    expect(after.expectedPaymentDate).toBeNull();
  });

  it("execute: заполняет expectedPaymentDate = endDate + N дней", async () => {
    await prisma.organizationSettings.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", legalName: "", inn: "", defaultPaymentTermsDays: 7 },
      update: { defaultPaymentTermsDays: 7 },
    });

    // F6: backfill only processes CONFIRMED/ISSUED/RETURNED bookings
    const booking = await makeBooking({ expectedPaymentDate: null, status: "CONFIRMED" });
    expect(booking.expectedPaymentDate).toBeNull();

    const output = runScript(["--execute"]);
    expect(output).toMatch(/обновлено/);

    const after = await prisma.booking.findUnique({ where: { id: booking.id } });
    expect(after.expectedPaymentDate).not.toBeNull();

    // endDate = 2026-05-10 Moscow, +7d = 2026-05-17
    const { toMoscowDateString } = await import("../utils/moscowDate");
    expect(toMoscowDateString(after.expectedPaymentDate)).toBe("2026-05-17");
  });

  it("пропускает CANCELLED брони", async () => {
    await prisma.organizationSettings.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", legalName: "", inn: "", defaultPaymentTermsDays: 7 },
      update: { defaultPaymentTermsDays: 7 },
    });

    const cancelled = await makeBooking({ status: "CANCELLED", expectedPaymentDate: null });
    expect(cancelled.expectedPaymentDate).toBeNull();

    runScript(["--execute"]);

    const after = await prisma.booking.findUnique({ where: { id: cancelled.id } });
    // CANCELLED booking should remain unchanged
    expect(after.expectedPaymentDate).toBeNull();
  });
});
