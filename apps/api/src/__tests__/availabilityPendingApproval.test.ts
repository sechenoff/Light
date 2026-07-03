import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

/**
 * MF-1: PENDING_APPROVAL резервирует оборудование.
 * - бронь на согласовании занимает позиции в getAvailability;
 * - excludeBookingId исключает её (нужно для confirm/approve);
 * - confirmBooking НЕ конфликтует сам с собой при approve (регрессия:
 *   до передачи excludeBookingId бронь на полную партию блокировала
 *   собственное подтверждение);
 * - чужая PENDING_APPROVAL-бронь блокирует confirm при нехватке стока.
 */

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-avail-pending.db");
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

let seq = 0;

async function seedEquipment(totalQuantity: number) {
  const { prisma } = await import("../prisma");
  seq++;
  return prisma.equipment.create({
    data: {
      category: "Свет",
      name: `Прибор МФ-${seq}`,
      importKey: `mf1-eq-${seq}`,
      rentalRatePerShift: "1000",
      stockTrackingMode: "COUNT",
      totalQuantity,
    },
  });
}

async function seedBooking(args: {
  equipmentId: string;
  quantity: number;
  status: string;
}) {
  const { prisma } = await import("../prisma");
  seq++;
  const client = await prisma.client.create({ data: { name: `Клиент МФ-${seq}` } });
  return prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: `Проект МФ-${seq}`,
      startDate: new Date("2026-08-01T10:00:00.000Z"),
      endDate: new Date("2026-08-03T10:00:00.000Z"),
      status: args.status,
      items: { create: [{ equipmentId: args.equipmentId, quantity: args.quantity }] },
    },
  });
}

const RANGE = {
  startDate: new Date("2026-08-01T00:00:00.000Z"),
  endDate: new Date("2026-08-04T00:00:00.000Z"),
};

describe("getAvailability — PENDING_APPROVAL блокирует (MF-1)", () => {
  it("бронь на согласовании занимает позиции", async () => {
    const { getAvailability } = await import("../services/availability");
    const eq = await seedEquipment(5);
    await seedBooking({ equipmentId: eq.id, quantity: 2, status: "PENDING_APPROVAL" });

    const rows = await getAvailability({ ...RANGE, equipmentIds: [eq.id] });
    expect(rows[0]?.occupiedQuantity).toBe(2);
    expect(rows[0]?.availableQuantity).toBe(3);
  });

  it("DRAFT по-прежнему НЕ занимает позиции", async () => {
    const { getAvailability } = await import("../services/availability");
    const eq = await seedEquipment(5);
    await seedBooking({ equipmentId: eq.id, quantity: 2, status: "DRAFT" });

    const rows = await getAvailability({ ...RANGE, equipmentIds: [eq.id] });
    expect(rows[0]?.occupiedQuantity).toBe(0);
    expect(rows[0]?.availableQuantity).toBe(5);
  });

  it("excludeBookingId исключает pending-бронь из занятости", async () => {
    const { getAvailability } = await import("../services/availability");
    const eq = await seedEquipment(5);
    const booking = await seedBooking({ equipmentId: eq.id, quantity: 5, status: "PENDING_APPROVAL" });

    const rows = await getAvailability({
      ...RANGE,
      equipmentIds: [eq.id],
      excludeBookingId: booking.id,
    });
    expect(rows[0]?.occupiedQuantity).toBe(0);
    expect(rows[0]?.availableQuantity).toBe(5);
  });
});

describe("confirmBooking — self-exclusion при approve (MF-1)", () => {
  it("PENDING_APPROVAL-бронь на ВЕСЬ сток подтверждается без self-конфликта", async () => {
    const { confirmBooking } = await import("../services/bookings");
    const eq = await seedEquipment(3);
    const booking = await seedBooking({ equipmentId: eq.id, quantity: 3, status: "PENDING_APPROVAL" });

    const confirmed = await confirmBooking(booking.id);
    expect(confirmed.status).toBe("CONFIRMED");
  });

  it("чужая PENDING_APPROVAL-бронь блокирует confirm при нехватке стока (409)", async () => {
    const { confirmBooking } = await import("../services/bookings");
    const { HttpError } = await import("../utils/errors");
    const eq = await seedEquipment(3);
    const bookingA = await seedBooking({ equipmentId: eq.id, quantity: 3, status: "PENDING_APPROVAL" });
    await seedBooking({ equipmentId: eq.id, quantity: 3, status: "PENDING_APPROVAL" });

    await expect(confirmBooking(bookingA.id)).rejects.toSatisfy(
      (e: unknown) => e instanceof HttpError && e.status === 409
    );
  });
});
