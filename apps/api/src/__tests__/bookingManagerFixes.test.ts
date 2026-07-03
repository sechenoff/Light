/**
 * Интеграционные тесты фиксов менеджерского аудита (кластер A — брони):
 *
 *  (a) POST /quote — чистое превью: клиент НЕ создаётся при частичном имени.
 *  (b) PATCH /:id применяет body.transport: BookingVehicle пересоздаются,
 *      transportSubtotalRub и finalAmount пересчитываются; transport: null
 *      очищает транспорт.
 *  (c) GET /:id — платежи включают voidedAt / voidReason (аннулированные
 *      остаются в выборке, UI сам их помечает).
 *  (d) POST /:id/status {action:"issue"} — юниты по живым резервам → ISSUED,
 *      booking.issuedAt проставлен; MAINTENANCE-юниты не трогаются.
 *  (e) POST /:id/status {action:"return"} — юниты ISSUED → AVAILABLE,
 *      резервы закрываются returnedAt (история сохраняется), аудит пишется;
 *      уже возвращённые сканером резервы не перезаписываются.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-manager-fixes.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-manager-fixes";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-mfix-min16chars";
process.env.JWT_SECRET = "test-jwt-secret-mfix-min16chars";

let app: Express;
let prisma: any;
let superAdminToken: string;
let clientId: string;
let countEquipmentId: string;
let unitEquipmentId: string;
let fordId: string;
let fotonId: string;

const AUTH_SA = () => ({ "X-API-Key": "test-key-1", Authorization: `Bearer ${superAdminToken}` });

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
  const sa = await prisma.adminUser.create({
    data: { username: "mfix_sa", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  superAdminToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });

  const c = await prisma.client.create({ data: { name: "Клиент Фиксы" } });
  clientId = c.id;

  const countEq = await prisma.equipment.create({
    data: {
      importKey: "СВЕТ||ФИКСЫ COUNT||GENERIC||MF-C",
      name: "Прожектор COUNT",
      category: "Свет",
      totalQuantity: 5,
      rentalRatePerShift: "3500",
      stockTrackingMode: "COUNT",
    },
  });
  countEquipmentId = countEq.id;

  const unitEq = await prisma.equipment.create({
    data: {
      importKey: "СВЕТ||ФИКСЫ UNIT||GENERIC||MF-U",
      name: "Прожектор UNIT",
      category: "Свет",
      totalQuantity: 3,
      rentalRatePerShift: "5000",
      stockTrackingMode: "UNIT",
    },
  });
  unitEquipmentId = unitEq.id;

  const ford = await prisma.vehicle.create({
    data: {
      slug: "ford-mfix",
      name: "Ford",
      shiftPriceRub: "20000",
      hasGeneratorOption: false,
      displayOrder: 1,
      shiftHours: 12,
      overtimePercent: "10",
      active: true,
    },
  });
  fordId = ford.id;
  const foton = await prisma.vehicle.create({
    data: {
      slug: "foton-mfix",
      name: "Фотон",
      shiftPriceRub: "25000",
      hasGeneratorOption: false,
      displayOrder: 2,
      shiftHours: 12,
      overtimePercent: "10",
      active: true,
    },
  });
  fotonId = foton.id;
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

// ── (a) /quote — не создаёт клиентов ─────────────────────────────────────────

describe("(a) POST /quote — превью без побочных записей", () => {
  it("частичное имя клиента НЕ создаёт запись Client", async () => {
    const res = await request(app)
      .post("/api/bookings/quote")
      .set(AUTH_SA())
      .send({
        client: { name: "Мосфи" }, // частичный набор имени
        projectName: "Превью",
        startDate: "2026-08-01T09:00:00.000Z",
        endDate: "2026-08-02T09:00:00.000Z",
        items: [{ equipmentId: countEquipmentId, quantity: 2 }],
      });
    expect(res.status).toBe(200);
    expect(Number(res.body.grandTotal)).toBeCloseTo(7000, 2);

    const junk = await prisma.client.findFirst({ where: { name: "Мосфи" } });
    expect(junk).toBeNull();
  });

  it("существующий клиент по имени не мутируется (превью read-only)", async () => {
    const before = await prisma.client.findUnique({ where: { id: clientId } });
    const res = await request(app)
      .post("/api/bookings/quote")
      .set(AUTH_SA())
      .send({
        client: { name: "Клиент Фиксы", phone: "+7-999-000-00-00" },
        projectName: "Превью 2",
        startDate: "2026-08-01T09:00:00.000Z",
        endDate: "2026-08-02T09:00:00.000Z",
        items: [{ equipmentId: countEquipmentId, quantity: 1 }],
      });
    expect(res.status).toBe(200);
    const after = await prisma.client.findUnique({ where: { id: clientId } });
    expect(after.phone).toBe(before.phone); // телефон не перезаписан превью
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });
});

// ── (b) PATCH применяет транспорт ─────────────────────────────────────────────

describe("(b) PATCH /:id — правки транспорта сохраняются", () => {
  async function makeDraftWithFord(): Promise<string> {
    const res = await request(app)
      .post("/api/bookings/draft")
      .set(AUTH_SA())
      .send({
        client: { name: "Клиент Фиксы" },
        projectName: `Транспорт ${Date.now()}`,
        startDate: "2026-08-10T09:00:00.000Z",
        endDate: "2026-08-11T09:00:00.000Z", // 1 смена
        items: [{ equipmentId: countEquipmentId, quantity: 2 }], // 7000
        transport: [
          { vehicleId: fordId, withGenerator: false, shiftHours: 12, skipOvertime: false, kmOutsideMkad: 0, ttkEntry: false },
        ],
      });
    expect(res.status).toBe(200);
    return res.body.booking.id;
  }

  it("замена машины: BookingVehicle пересоздан, transportSubtotalRub и finalAmount обновлены", async () => {
    const id = await makeDraftWithFord();

    const res = await request(app)
      .patch(`/api/bookings/${id}`)
      .set(AUTH_SA())
      .send({
        transport: [
          { vehicleId: fotonId, withGenerator: false, shiftHours: 12, skipOvertime: false, kmOutsideMkad: 0, ttkEntry: false },
        ],
      });
    expect(res.status).toBe(200);

    const saved = await prisma.booking.findUnique({
      where: { id },
      include: { vehicles: true },
    });
    expect(saved.vehicles).toHaveLength(1);
    expect(saved.vehicles[0].vehicleId).toBe(fotonId);
    expect(Number(saved.vehicles[0].subtotalRub)).toBeCloseTo(25000, 2);
    expect(Number(saved.transportSubtotalRub)).toBeCloseTo(25000, 2);
    // finalAmount = 7000 (оборудование) + 25000 (новый транспорт)
    expect(Number(saved.finalAmount)).toBeCloseTo(32000, 2);
  });

  it("transport: null очищает транспорт полностью", async () => {
    const id = await makeDraftWithFord();

    const res = await request(app)
      .patch(`/api/bookings/${id}`)
      .set(AUTH_SA())
      .send({ transport: null });
    expect(res.status).toBe(200);

    const saved = await prisma.booking.findUnique({
      where: { id },
      include: { vehicles: true },
    });
    expect(saved.vehicles).toHaveLength(0);
    expect(saved.transportSubtotalRub).toBeNull();
    expect(Number(saved.finalAmount)).toBeCloseTo(7000, 2);
  });

  it("водитель переживает PATCH с тем же составом машин (driverName/driverPhone переносятся)", async () => {
    const id = await makeDraftWithFord();
    // Водитель назначен «при погрузке» отдельным endpoint'ом — эмулируем напрямую в БД
    await prisma.bookingVehicle.updateMany({
      where: { bookingId: id, vehicleId: fordId },
      data: { driverName: "Иван Водителев", driverPhone: "+7-916-111-22-33" },
    });

    // Форма редактирования шлёт transport при КАЖДОМ сохранении (гидрируется
    // из initialBooking.vehicles), даже если состав не менялся
    const res = await request(app)
      .patch(`/api/bookings/${id}`)
      .set(AUTH_SA())
      .send({
        projectName: "Правка имени проекта",
        transport: [
          { vehicleId: fordId, withGenerator: false, shiftHours: 12, skipOvertime: false, kmOutsideMkad: 0, ttkEntry: false },
        ],
      });
    expect(res.status).toBe(200);

    const saved = await prisma.booking.findUnique({
      where: { id },
      include: { vehicles: true },
    });
    expect(saved.vehicles).toHaveLength(1);
    expect(saved.vehicles[0].vehicleId).toBe(fordId);
    expect(saved.vehicles[0].driverName).toBe("Иван Водителев");
    expect(saved.vehicles[0].driverPhone).toBe("+7-916-111-22-33");
  });

  it("при замене машины водитель НЕ переносится на новую, но переносится на оставшуюся", async () => {
    // Бронь с двумя машинами: Ford (с водителем) + Фотон (без)
    const draft = await request(app)
      .post("/api/bookings/draft")
      .set(AUTH_SA())
      .send({
        client: { name: "Клиент Фиксы" },
        projectName: `Транспорт 2 машины ${Date.now()}`,
        startDate: "2026-08-10T09:00:00.000Z",
        endDate: "2026-08-11T09:00:00.000Z",
        items: [{ equipmentId: countEquipmentId, quantity: 2 }],
        transport: [
          { vehicleId: fordId, withGenerator: false, shiftHours: 12, skipOvertime: false, kmOutsideMkad: 0, ttkEntry: false },
          { vehicleId: fotonId, withGenerator: false, shiftHours: 12, skipOvertime: false, kmOutsideMkad: 0, ttkEntry: false },
        ],
      });
    expect(draft.status).toBe(200);
    const id = draft.body.booking.id;
    await prisma.bookingVehicle.updateMany({
      where: { bookingId: id, vehicleId: fordId },
      data: { driverName: "Пётр Фордов", driverPhone: "+7-903-555-66-77" },
    });

    // Убираем Ford, оставляем только Фотон
    const res = await request(app)
      .patch(`/api/bookings/${id}`)
      .set(AUTH_SA())
      .send({
        transport: [
          { vehicleId: fotonId, withGenerator: false, shiftHours: 12, skipOvertime: false, kmOutsideMkad: 0, ttkEntry: false },
        ],
      });
    expect(res.status).toBe(200);

    const saved = await prisma.booking.findUnique({
      where: { id },
      include: { vehicles: true },
    });
    expect(saved.vehicles).toHaveLength(1);
    expect(saved.vehicles[0].vehicleId).toBe(fotonId);
    // У Фотона водителя не было — данные Ford'а на него не «переезжают»
    expect(saved.vehicles[0].driverName).toBeNull();
    expect(saved.vehicles[0].driverPhone).toBeNull();
  });

  it("PATCH без поля transport не трогает существующий транспорт", async () => {
    const id = await makeDraftWithFord();

    const res = await request(app)
      .patch(`/api/bookings/${id}`)
      .set(AUTH_SA())
      .send({ projectName: "Только имя проекта" });
    expect(res.status).toBe(200);

    const saved = await prisma.booking.findUnique({
      where: { id },
      include: { vehicles: true },
    });
    expect(saved.vehicles).toHaveLength(1);
    expect(saved.vehicles[0].vehicleId).toBe(fordId);
    expect(Number(saved.transportSubtotalRub)).toBeCloseTo(20000, 2);
  });
});

// ── (c) GET /:id — voided-платежи с voidedAt/voidReason ──────────────────────

describe("(c) GET /:id — аннулированные платежи видны с voidedAt/voidReason", () => {
  it("voided-платёж остаётся в payments и несёт voidedAt + voidReason", async () => {
    const booking = await prisma.booking.create({
      data: {
        clientId,
        projectName: "Платежи voided",
        startDate: new Date("2026-08-20T09:00:00.000Z"),
        endDate: new Date("2026-08-21T09:00:00.000Z"),
        status: "CONFIRMED",
      },
    });
    const voidedAt = new Date("2026-08-22T10:00:00.000Z");
    await prisma.payment.create({
      data: {
        bookingId: booking.id,
        amount: "10000",
        status: "RECEIVED",
        receivedAt: new Date("2026-08-21T12:00:00.000Z"),
        voidedAt,
        voidReason: "Ошибочный платёж",
      },
    });
    await prisma.payment.create({
      data: {
        bookingId: booking.id,
        amount: "5000",
        status: "RECEIVED",
        receivedAt: new Date("2026-08-21T13:00:00.000Z"),
      },
    });

    const res = await request(app).get(`/api/bookings/${booking.id}`).set(AUTH_SA());
    expect(res.status).toBe(200);
    const payments = res.body.booking.payments;
    expect(payments).toHaveLength(2);

    const voided = payments.find((p: any) => p.voidedAt !== null);
    const live = payments.find((p: any) => p.voidedAt === null);
    expect(voided).toBeDefined();
    expect(voided.voidedAt).toBe(voidedAt.toISOString());
    expect(voided.voidReason).toBe("Ошибочный платёж");
    expect(live).toBeDefined();
    expect(live.voidReason).toBeNull();
  });
});

// ── (d)+(e) Ручные issue/return реконсилируют юниты ──────────────────────────

async function makeUnitBooking(opts: {
  status: "CONFIRMED" | "ISSUED";
  unitStatuses: Array<"AVAILABLE" | "ISSUED" | "MAINTENANCE">;
}) {
  const booking = await prisma.booking.create({
    data: {
      clientId,
      projectName: `UNIT-бронь ${Date.now()}-${Math.random()}`,
      startDate: new Date("2026-09-01T09:00:00.000Z"),
      endDate: new Date("2026-09-02T09:00:00.000Z"),
      status: opts.status,
      ...(opts.status === "ISSUED" ? { issuedAt: new Date("2026-09-01T09:30:00.000Z") } : {}),
    },
  });
  const item = await prisma.bookingItem.create({
    data: { bookingId: booking.id, equipmentId: unitEquipmentId, quantity: opts.unitStatuses.length },
  });
  const units: any[] = [];
  for (let i = 0; i < opts.unitStatuses.length; i++) {
    const unit = await prisma.equipmentUnit.create({
      data: {
        equipmentId: unitEquipmentId,
        serialNumber: `MF-${Date.now()}-${i}-${Math.floor(Math.random() * 1e6)}`,
        status: opts.unitStatuses[i],
      },
    });
    await prisma.bookingItemUnit.create({
      data: { bookingItemId: item.id, equipmentUnitId: unit.id },
    });
    units.push(unit);
  }
  return { booking, item, units };
}

describe("(d) POST /:id/status issue — юниты переводятся в ISSUED", () => {
  it("живые резервы → юниты ISSUED, booking.issuedAt проставлен", async () => {
    const { booking, units } = await makeUnitBooking({
      status: "CONFIRMED",
      unitStatuses: ["AVAILABLE", "AVAILABLE"],
    });

    const res = await request(app)
      .post(`/api/bookings/${booking.id}/status`)
      .set(AUTH_SA())
      .send({ action: "issue" });
    expect(res.status).toBe(200);
    expect(res.body.booking.status).toBe("ISSUED");

    const saved = await prisma.booking.findUnique({ where: { id: booking.id } });
    expect(saved.issuedAt).not.toBeNull();

    for (const u of units) {
      const fresh = await prisma.equipmentUnit.findUnique({ where: { id: u.id } });
      expect(fresh.status).toBe("ISSUED");
    }

    const audit = await prisma.auditEntry.findFirst({
      where: { action: "BOOKING_UNITS_ISSUED", entityId: booking.id },
    });
    expect(audit).not.toBeNull();
  });

  it("юнит в MAINTENANCE не трогается ручной выдачей", async () => {
    const { booking, units } = await makeUnitBooking({
      status: "CONFIRMED",
      unitStatuses: ["AVAILABLE", "MAINTENANCE"],
    });

    const res = await request(app)
      .post(`/api/bookings/${booking.id}/status`)
      .set(AUTH_SA())
      .send({ action: "issue" });
    expect(res.status).toBe(200);

    const u0 = await prisma.equipmentUnit.findUnique({ where: { id: units[0].id } });
    const u1 = await prisma.equipmentUnit.findUnique({ where: { id: units[1].id } });
    expect(u0.status).toBe("ISSUED");
    expect(u1.status).toBe("MAINTENANCE"); // ремонтный цикл — не наш
  });
});

describe("(e) POST /:id/status return — юниты освобождаются, история сохраняется", () => {
  it("юниты ISSUED → AVAILABLE, резервы закрыты returnedAt, аудит записан", async () => {
    const { booking, item, units } = await makeUnitBooking({
      status: "ISSUED",
      unitStatuses: ["ISSUED", "ISSUED"],
    });

    const res = await request(app)
      .post(`/api/bookings/${booking.id}/status`)
      .set(AUTH_SA())
      .send({ action: "return" });
    expect(res.status).toBe(200);
    expect(res.body.booking.status).toBe("RETURNED");

    for (const u of units) {
      const fresh = await prisma.equipmentUnit.findUnique({ where: { id: u.id } });
      expect(fresh.status).toBe("AVAILABLE");
    }

    // Резервы НЕ удалены (история приёмки), а закрыты returnedAt
    const reservations = await prisma.bookingItemUnit.findMany({
      where: { bookingItemId: item.id },
    });
    expect(reservations).toHaveLength(2);
    for (const r of reservations) {
      expect(r.returnedAt).not.toBeNull();
    }

    const audit = await prisma.auditEntry.findFirst({
      where: { action: "BOOKING_UNITS_RETURNED", entityId: booking.id },
    });
    expect(audit).not.toBeNull();
  });

  it("резерв, уже возвращённый сканером, не перезаписывается", async () => {
    const { booking, item, units } = await makeUnitBooking({
      status: "ISSUED",
      unitStatuses: ["ISSUED", "AVAILABLE"],
    });
    // Юнит №2 уже принят сканером: returnedAt в прошлом, статус AVAILABLE
    const scanReturnedAt = new Date("2026-09-01T18:00:00.000Z");
    const scanReservation = await prisma.bookingItemUnit.findFirst({
      where: { bookingItemId: item.id, equipmentUnitId: units[1].id },
    });
    await prisma.bookingItemUnit.update({
      where: { id: scanReservation.id },
      data: { returnedAt: scanReturnedAt },
    });

    const res = await request(app)
      .post(`/api/bookings/${booking.id}/status`)
      .set(AUTH_SA())
      .send({ action: "return" });
    expect(res.status).toBe(200);

    const fresh = await prisma.bookingItemUnit.findUnique({ where: { id: scanReservation.id } });
    // Историческая метка приёмки не тронута
    expect(fresh.returnedAt.getTime()).toBe(scanReturnedAt.getTime());

    // А живой резерв юнита №1 закрыт, сам юнит вернулся в AVAILABLE
    const u0 = await prisma.equipmentUnit.findUnique({ where: { id: units[0].id } });
    expect(u0.status).toBe("AVAILABLE");
  });
});
