/**
 * Тесты «занятость машины» (F-FLEET): listVehicles / getVehicleDetail
 * возвращают ActiveBookingRef — активную или ближайшую предстоящую бронь.
 *
 * Покрываем:
 *  (a) выданная сейчас бронь (ISSUED, период включает today) → isCurrent=true;
 *  (b) приоритет: ISSUED-сейчас важнее просто предстоящей CONFIRMED;
 *  (c) свободная машина (нет занимающих броней) → activeBooking = null;
 *  (d) закончившаяся / отменённая / удалённая / DRAFT бронь машину НЕ занимает;
 *  (e) getVehicleDetail отдаёт тот же activeBooking + тариф (shiftPriceRub/shiftHours);
 *  (f) clientName проброшен из Client.name.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-vehicle-active.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-vehicle-active";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-vehicle-active";
process.env.JWT_SECRET = "test-jwt-secret-vehicle-active-min16chars";

let prisma: any;
let listVehicles: typeof import("../services/vehicleService").listVehicles;
let getVehicleDetail: typeof import("../services/vehicleService").getVehicleDetail;

let freeId: string;
let issuedId: string;
let dualId: string;
let clientId: string;

const DAY = 24 * 60 * 60 * 1000;

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
  listVehicles = svc.listVehicles;
  getVehicleDetail = svc.getVehicleDetail;

  const client = await prisma.client.create({ data: { name: "Клиент Занятость" } });
  clientId = client.id;

  const mkVehicle = async (slug: string, name: string, order: number) =>
    prisma.vehicle.create({
      data: {
        slug,
        name,
        shiftPriceRub: "20000",
        shiftHours: 12,
        overtimePercent: "10",
        displayOrder: order,
        active: true,
      },
    });

  freeId = (await mkVehicle("free", "Свободная", 1)).id;
  issuedId = (await mkVehicle("issued", "Выданная", 2)).id;
  dualId = (await mkVehicle("dual", "Двойная", 3)).id;

  const now = Date.now();

  const mkBooking = async (
    status: string,
    startOffsetDays: number,
    endOffsetDays: number,
    vehicleId: string,
    opts?: { deleted?: boolean },
  ) => {
    const b = await prisma.booking.create({
      data: {
        clientId,
        projectName: `Проект ${status} ${vehicleId.slice(-4)}`,
        startDate: new Date(now + startOffsetDays * DAY),
        endDate: new Date(now + endOffsetDays * DAY),
        status,
        deletedAt: opts?.deleted ? new Date() : null,
      },
    });
    await prisma.bookingVehicle.create({
      data: { bookingId: b.id, vehicleId },
    });
    return b;
  };

  // issuedId: выдана сейчас (вчера→завтра).
  await mkBooking("ISSUED", -1, 1, issuedId);

  // dualId: и выдана сейчас, и есть предстоящая CONFIRMED — должна победить ISSUED.
  await mkBooking("CONFIRMED", 5, 7, dualId);
  await mkBooking("ISSUED", -1, 2, dualId);

  // Шум, который НЕ должен занимать машины:
  await mkBooking("RETURNED", -10, -8, freeId); // прошедшая
  await mkBooking("CANCELLED", 1, 3, freeId); // отменённая
  await mkBooking("DRAFT", 1, 3, freeId); // черновик
  await mkBooking("CONFIRMED", 1, 3, freeId, { deleted: true }); // удалённая
});

afterAll(async () => {
  await prisma.$disconnect();
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = TEST_DB_PATH + suffix;
    if (fs.existsSync(f)) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
  }
});

describe("vehicle activeBooking (занятость)", () => {
  it("(a) выданная сейчас бронь → isCurrent, статус ISSUED, clientName проброшен", async () => {
    const vehicles = await listVehicles({ includeInactive: true });
    const issued = vehicles.find((v) => v.id === issuedId)!;
    expect(issued.activeBooking).not.toBeNull();
    expect(issued.activeBooking!.status).toBe("ISSUED");
    expect(issued.activeBooking!.isCurrent).toBe(true);
    expect(issued.activeBooking!.clientName).toBe("Клиент Занятость");
  });

  it("(b) ISSUED-сейчас важнее предстоящей CONFIRMED", async () => {
    const vehicles = await listVehicles({ includeInactive: true });
    const dual = vehicles.find((v) => v.id === dualId)!;
    expect(dual.activeBooking!.status).toBe("ISSUED");
    expect(dual.activeBooking!.isCurrent).toBe(true);
  });

  it("(c/d) RETURNED/CANCELLED/DRAFT/удалённые брони машину не занимают → null", async () => {
    const vehicles = await listVehicles({ includeInactive: true });
    const free = vehicles.find((v) => v.id === freeId)!;
    expect(free.activeBooking).toBeNull();
  });

  it("(e) getVehicleDetail отдаёт activeBooking + тариф", async () => {
    const detail = await getVehicleDetail(issuedId);
    expect(detail.vehicle.activeBooking).not.toBeNull();
    expect(detail.vehicle.activeBooking!.isCurrent).toBe(true);
    expect(detail.vehicle.shiftPriceRub).toBe("20000");
    expect(detail.vehicle.shiftHours).toBe(12);
  });

  it("(e2) свободная машина в detail → activeBooking null", async () => {
    const detail = await getVehicleDetail(freeId);
    expect(detail.vehicle.activeBooking).toBeNull();
  });
});
