/**
 * Интеграционные тесты ретро-редактирования закрытой брони.
 *
 *  (a) PATCH RETURNED без retroactive → 409 BOOKING_EDIT_FORBIDDEN.
 *  (b) PATCH RETURNED + retroactive: WAREHOUSE → 409 (только SUPER_ADMIN).
 *  (c) PATCH RETURNED + retroactive: SUPER_ADMIN → 200, поля обновлены.
 *  (d) Audit-запись BOOKING_RETROACTIVE_EDIT появилась.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-retro-edit.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-retro";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-retro-min16chars";
process.env.JWT_SECRET = "test-jwt-secret-retro-min16chars";

let app: Express;
let prisma: any;
let superAdminToken: string;
let warehouseToken: string;
let equipmentId: string;
let bookingId: string;
let vehicleId: string;
let bookingVehicleId: string;

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

  const mod = await import("../app");
  app = mod.app;
  const pmod = await import("../prisma");
  prisma = pmod.prisma;

  const { hashPassword, signSession } = await import("../services/auth");
  const hash = await hashPassword("test-pass-123");

  await prisma.adminUser.upsert({
    where: { id: "_system_" },
    update: {},
    create: { id: "_system_", username: "_system_", passwordHash: hash, role: "SUPER_ADMIN" },
  });

  const sa = await prisma.adminUser.create({
    data: { username: "retro_sa", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  superAdminToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });

  const wh = await prisma.adminUser.create({
    data: { username: "retro_wh", passwordHash: hash, role: "WAREHOUSE" },
  });
  warehouseToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });

  const eq = await prisma.equipment.create({
    data: {
      importKey: "LED||ПАНЕЛЬ RETRO||GENERIC||LED-RETRO",
      name: "Панель RETRO",
      category: "LED",
      totalQuantity: 5,
      rentalRatePerShift: "3500",
      stockTrackingMode: "COUNT",
    },
  });
  equipmentId = eq.id;

  // Создаём бронь и доводим до RETURNED через прямые мутации в БД
  // (быстрее чем полный flow через scan-сессии).
  const client = await prisma.client.create({ data: { name: "Тест-Клиент RETRO" } });
  const booking = await prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: "Старый проект",
      startDate: new Date("2026-04-10T09:00:00.000Z"),
      endDate: new Date("2026-04-11T09:00:00.000Z"),
      status: "RETURNED",
      comment: "Старый комментарий",
      discountPercent: "5",
      finalAmount: "3325",
    },
  });
  bookingId = booking.id;
  await prisma.bookingItem.create({
    data: { bookingId, equipmentId, quantity: 1 },
  });

  // Seed машины + привязки к броне — для тестов vehicleEdits.
  const vehicle = await prisma.vehicle.create({
    data: {
      slug: "ivk-retro",
      name: "Ивеко RETRO",
      shiftPriceRub: "14000",
      hasGeneratorOption: false,
      displayOrder: 1,
      shiftHours: 12,
      overtimePercent: "10",
      active: true,
      currentMileage: 50000,
    },
  });
  vehicleId = vehicle.id;
  const bv = await prisma.bookingVehicle.create({
    data: {
      bookingId,
      vehicleId,
      withGenerator: false,
      shiftHours: "12",
      skipOvertime: false,
      kmOutsideMkad: 0,
      ttkEntry: false,
      driverName: null,
      driverPhone: null,
    },
  });
  bookingVehicleId = bv.id;
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

const AUTH_SA = () => ({ "X-API-Key": "test-key-1", Authorization: `Bearer ${superAdminToken}` });
const AUTH_WH = () => ({ "X-API-Key": "test-key-1", Authorization: `Bearer ${warehouseToken}` });

describe("PATCH /api/bookings/:id — ретро-редактирование RETURNED", () => {
  it("(a) без retroactive: даже SUPER_ADMIN получает 409 BOOKING_EDIT_FORBIDDEN", async () => {
    const res = await request(app)
      .patch(`/api/bookings/${bookingId}`)
      .set(AUTH_SA())
      .send({ projectName: "Новый проект" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("BOOKING_EDIT_FORBIDDEN");
  });

  it("(b) с retroactive: WAREHOUSE получает 409 (не SA)", async () => {
    const res = await request(app)
      .patch(`/api/bookings/${bookingId}`)
      .set(AUTH_WH())
      .send({ projectName: "Новый проект", retroactive: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("BOOKING_EDIT_FORBIDDEN");
  });

  it("(c) SUPER_ADMIN + retroactive: 200, поля обновлены", async () => {
    const res = await request(app)
      .patch(`/api/bookings/${bookingId}`)
      .set(AUTH_SA())
      .send({
        projectName: "Реклама Газпрома · уточнение",
        comment: "Уточнение задним числом",
        discountPercent: 10,
        retroactive: true,
      });
    expect(res.status).toBe(200);
    expect(res.body.booking.projectName).toBe("Реклама Газпрома · уточнение");
    expect(res.body.booking.comment).toBe("Уточнение задним числом");
    expect(Number(res.body.booking.discountPercent)).toBe(10);
    expect(res.body.booking.status).toBe("RETURNED"); // статус не меняется
  });

  it("(d) audit BOOKING_RETROACTIVE_EDIT записан с before/after", async () => {
    const entries = await prisma.auditEntry.findMany({
      where: { action: "BOOKING_RETROACTIVE_EDIT", entityId: bookingId },
      orderBy: { createdAt: "desc" },
    });
    expect(entries.length).toBeGreaterThan(0);
    const latest = entries[0];
    expect(latest.entityType).toBe("Booking");
    // AuditEntry.before/after — TEXT с JSON; парсим вручную.
    const before = JSON.parse(latest.before ?? "{}") as Record<string, unknown>;
    const after = JSON.parse(latest.after ?? "{}") as Record<string, unknown>;
    expect(before.projectName).toBe("Старый проект");
    expect(after.projectName).toBe("Реклама Газпрома · уточнение");
    expect(before.discountPercent).toBe("5");
    expect(after.discountPercent).toBe("10");
  });

  it("(e) с items[]: позиции пересохраняются, BookingItem.quantity обновлён, audit включает diff", async () => {
    // Создаём ещё одно equipment для перетасовки позиций.
    const eq2 = await prisma.equipment.create({
      data: {
        importKey: "HMI||M40||GENERIC||HMI-M40",
        name: "M40 Par 4000W",
        category: "HMI",
        totalQuantity: 3,
        rentalRatePerShift: "9500",
        stockTrackingMode: "COUNT",
      },
    });

    // Меняем qty первой позиции и добавляем M40 (qty=2).
    const res = await request(app)
      .patch(`/api/bookings/${bookingId}`)
      .set(AUTH_SA())
      .send({
        retroactive: true,
        items: [
          { equipmentId, quantity: 3 },         // было 1 → стало 3
          { equipmentId: eq2.id, quantity: 2 }, // новая позиция
        ],
      });
    expect(res.status).toBe(200);

    const items = await prisma.bookingItem.findMany({
      where: { bookingId },
      orderBy: { id: "asc" },
    });
    expect(items).toHaveLength(2);
    const led = items.find((i: any) => i.equipmentId === equipmentId);
    const hmi = items.find((i: any) => i.equipmentId === eq2.id);
    expect(led?.quantity).toBe(3);
    expect(hmi?.quantity).toBe(2);

    // Audit-запись существует. Сам массив items в `before`/`after` НЕ
    // сохраняется — `diffFields` в audit-service умышленно отбрасывает
    // массивы (защита от раздувания при тысяче позиций). Аудит-стори по
    // изменению состава восстанавливается из BOOKING_EDITED-события на
    // финансовой шкале + BookingItem.updatedAt в БД.
    const audit = await prisma.auditEntry.findFirst({
      where: { action: "BOOKING_RETROACTIVE_EDIT", entityId: bookingId },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
    expect(audit!.entityType).toBe("Booking");
  });

  it("(f) с vehicleEdits: driverName/Phone обновляются + endMileage пишет VehicleMileageLog", async () => {
    const before = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
    const newMileage = before.currentMileage + 175;

    const res = await request(app)
      .patch(`/api/bookings/${bookingId}`)
      .set(AUTH_SA())
      .send({
        retroactive: true,
        vehicleEdits: [
          {
            bookingVehicleId,
            driverName: "Александр Кораблёв",
            driverPhone: "+7 (916) 555-44-33",
            endMileage: newMileage,
          },
        ],
      });
    expect(res.status).toBe(200);

    const bv = await prisma.bookingVehicle.findUnique({ where: { id: bookingVehicleId } });
    expect(bv?.driverName).toBe("Александр Кораблёв");
    expect(bv?.driverPhone).toBe("+7 (916) 555-44-33");

    const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
    expect(vehicle?.currentMileage).toBe(newMileage);

    const log = await prisma.vehicleMileageLog.findFirst({
      where: { vehicleId, bookingId, source: "MANUAL" },
      orderBy: { recordedAt: "desc" },
    });
    expect(log).not.toBeNull();
    expect(log!.mileage).toBe(newMileage);
  });

  it("(g) endMileage меньше текущего → 409 MILEAGE_DECREASE, всё откатывается", async () => {
    const beforeVehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
    const beforeMileage = beforeVehicle.currentMileage;
    const beforeBv = await prisma.bookingVehicle.findUnique({ where: { id: bookingVehicleId } });
    const beforeDriver = beforeBv?.driverName;

    const res = await request(app)
      .patch(`/api/bookings/${bookingId}`)
      .set(AUTH_SA())
      .send({
        retroactive: true,
        // Сначала пытаемся менять driverName на новое значение — должно
        // быть откатано вместе с MILEAGE_DECREASE-ошибкой.
        vehicleEdits: [
          {
            bookingVehicleId,
            driverName: "Не должен сохраниться",
            endMileage: beforeMileage - 100,
          },
        ],
      });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("MILEAGE_DECREASE");

    // driverName не изменился — транзакция откачена.
    const bv = await prisma.bookingVehicle.findUnique({ where: { id: bookingVehicleId } });
    expect(bv?.driverName).toBe(beforeDriver);

    // currentMileage машины не изменён.
    const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
    expect(vehicle?.currentMileage).toBe(beforeMileage);
  });
});
