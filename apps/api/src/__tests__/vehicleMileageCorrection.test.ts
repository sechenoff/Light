/**
 * Тесты ручной корректировки пробега (logMileageManual с correction).
 *
 * Покрываем:
 *  (a) обычная запись двигает одометр вперёд → source MANUAL, аудит VEHICLE_MILEAGE_LOG;
 *  (b) обычная запись НЕ может уменьшать → 409 MILEAGE_DECREASE, одометр не меняется;
 *  (c) корректировка уменьшает одометр с причиной → source CORRECTION, currentMileage
 *      падает, аудит VEHICLE_MILEAGE_CORRECTION (before/after);
 *  (d) корректировка без причины (пустой/пробельный note) → 400 CORRECTION_NOTE_REQUIRED,
 *      одометр не меняется;
 *  (e) корректировка вверх тоже работает (source CORRECTION);
 *  (f) getVehicleDetail отражает исправленный пробег и запись CORRECTION в журнале.
 */

import path from "path";
import { execSync } from "child_process";
import { describe, it, expect, beforeAll } from "vitest";

const TEST_DB_PATH = path.resolve(
  __dirname,
  "../../prisma/test-vehicle-mileage-correction.db",
);
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-mileage-correction";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-mileage-correction";
process.env.JWT_SECRET = "test-jwt-secret-mileage-correction-min16chars";

let prisma: any;
let logMileageManual: typeof import("../services/vehicleService").logMileageManual;
let getVehicleDetail: typeof import("../services/vehicleService").getVehicleDetail;
let userId: string;
let vehicleSeq = 0;

async function mkVehicle(currentMileage: number): Promise<string> {
  vehicleSeq += 1;
  const v = await prisma.vehicle.create({
    data: {
      slug: `mc-${vehicleSeq}`,
      name: `Машина ${vehicleSeq}`,
      shiftPriceRub: "10000",
      currentMileage,
    },
  });
  return v.id;
}

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
  const svc = await import("../services/vehicleService");
  logMileageManual = svc.logMileageManual;
  getVehicleDetail = svc.getVehicleDetail;

  const admin = await prisma.adminUser.create({
    data: { username: "mileage-tester", passwordHash: "x", role: "SUPER_ADMIN" },
  });
  userId = admin.id;
});

describe("logMileageManual — корректировка пробега", () => {
  it("(a) обычная запись двигает одометр вперёд (source MANUAL + аудит)", async () => {
    const vehicleId = await mkVehicle(50_000);
    const log = await logMileageManual({
      vehicleId,
      mileage: 51_000,
      recordedBy: "mileage-tester",
      userId,
    });
    expect(log.source).toBe("MANUAL");
    expect(log.mileage).toBe(51_000);

    const v = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
    expect(v.currentMileage).toBe(51_000);

    const audit = await prisma.auditEntry.findFirst({
      where: { entityId: vehicleId, action: "VEHICLE_MILEAGE_LOG" },
    });
    expect(audit).not.toBeNull();
  });

  it("(b) обычная запись НЕ уменьшает одометр → 409 MILEAGE_DECREASE", async () => {
    const vehicleId = await mkVehicle(50_000);
    await expect(
      logMileageManual({
        vehicleId,
        mileage: 49_000,
        recordedBy: "mileage-tester",
        userId,
        correction: false,
      }),
    ).rejects.toMatchObject({ status: 409, code: "MILEAGE_DECREASE" });

    // Одометр не изменился.
    const v = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
    expect(v.currentMileage).toBe(50_000);
  });

  it("(c) корректировка уменьшает одометр с причиной (CORRECTION + аудит)", async () => {
    const vehicleId = await mkVehicle(500_000); // ошибочно ввели лишний ноль
    const log = await logMileageManual({
      vehicleId,
      mileage: 50_000,
      recordedBy: "mileage-tester",
      userId,
      correction: true,
      note: "Опечатка: было 500000, верно 50000",
    });
    expect(log.source).toBe("CORRECTION");
    expect(log.mileage).toBe(50_000);
    expect(log.note).toBe("Опечатка: было 500000, верно 50000");

    const v = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
    expect(v.currentMileage).toBe(50_000);

    const audit = await prisma.auditEntry.findFirst({
      where: { entityId: vehicleId, action: "VEHICLE_MILEAGE_CORRECTION" },
    });
    expect(audit).not.toBeNull();
    // before/after хранятся JSON-строками (String? колонка).
    expect(JSON.parse(audit.before).currentMileage).toBe(500_000);
    expect(JSON.parse(audit.after).currentMileage).toBe(50_000);
  });

  it("(d) корректировка без причины → 400 CORRECTION_NOTE_REQUIRED, одометр цел", async () => {
    const vehicleId = await mkVehicle(100_000);
    await expect(
      logMileageManual({
        vehicleId,
        mileage: 90_000,
        recordedBy: "mileage-tester",
        userId,
        correction: true,
        note: "   ", // только пробелы
      }),
    ).rejects.toMatchObject({ status: 400, code: "CORRECTION_NOTE_REQUIRED" });

    const v = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
    expect(v.currentMileage).toBe(100_000);
  });

  it("(e) корректировка вверх тоже помечается CORRECTION", async () => {
    const vehicleId = await mkVehicle(10_000);
    const log = await logMileageManual({
      vehicleId,
      mileage: 12_000,
      recordedBy: "mileage-tester",
      userId,
      correction: true,
      note: "Забыли внести пробег за месяц",
    });
    expect(log.source).toBe("CORRECTION");
    const v = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
    expect(v.currentMileage).toBe(12_000);
  });

  it("(f) getVehicleDetail отражает исправленный пробег и запись CORRECTION", async () => {
    const vehicleId = await mkVehicle(300_000);
    await logMileageManual({
      vehicleId,
      mileage: 30_000,
      recordedBy: "mileage-tester",
      userId,
      correction: true,
      note: "Исправление одометра",
    });
    const detail = await getVehicleDetail(vehicleId);
    expect(detail.vehicle.currentMileage).toBe(30_000);
    const corr = detail.mileageLogs.find((m) => m.source === "CORRECTION");
    expect(corr).toBeDefined();
    expect(corr?.mileage).toBe(30_000);
  });
});
