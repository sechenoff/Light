/**
 * Добор в выданную бронь со страницы брони — HTTP-сценарии через supertest.
 *
 *   GET  /api/bookings/:id/addon-search?q=       — каталог с потолком добора
 *   POST /api/bookings/:id/addon-items           — mode ADDON | MERGE
 *   POST /api/bookings/:id/addon-estimate/merge  — влить доп-смету в основную
 *   PATCH /api/bookings/:id { extendEndDate }    — продление НЕ поглощает добор
 *
 * Арифметика фикстуры (бронь A, 2 смены, скидка 50 % на прайсовые строки):
 *   MAIN: «Прибор COUNT» ×1 по 1000/смена → 2000; «Прибор договорной» ×1 по
 *   договорной 1500/смена (прайс 2000) → 3000, скидка на него не начисляется.
 *   subtotal 5000, скидка 1000, итог 4000.
 */

import path from "path";
import { execSync } from "child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-booking-addon-items.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-booking-addon";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-booking-addon";
process.env.WAREHOUSE_SECRET = "test-warehouse-booking-addon-16";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-booking-addon-min16chars";

let app: any;
let prisma: any;
let saId: string;
let saToken: string;
let whToken: string;
let techToken: string;

let eqCountId: string;
let eqNegId: string;
let eqUnitId: string;
let eqBusyId: string;
let bookingAId: string;
let bookingBId: string;
let draftBookingId: string;
let otherBookingId: string;

const DAY = 24 * 60 * 60 * 1000;
const startA = new Date(Date.now() + DAY);
const endA = new Date(startA.getTime() + 2 * DAY); // ровно 48 ч → 2 смены
const startB = new Date(Date.now() + 10 * DAY); // не пересекается с A
const endB = new Date(startB.getTime() + 2 * DAY);

const H = (token: string) => ({ "X-API-Key": "test-key-booking-addon", Authorization: `Bearer ${token}` });
const num = (v: unknown) => Number(String(v));

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, DATABASE_URL: `file:${TEST_DB_PATH}`, PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes" },
    stdio: "pipe",
  });

  const pmod = await import("../prisma");
  prisma = pmod.prisma;
  const { app: expressApp } = await import("../app");
  app = expressApp;

  const { hashPassword, signSession } = await import("../services/auth");
  const hash = await hashPassword("addon-pass-123");
  const sa = await prisma.adminUser.create({ data: { username: "addon_sa", passwordHash: hash, role: "SUPER_ADMIN" } });
  saId = sa.id;
  saToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });
  const wh = await prisma.adminUser.create({ data: { username: "addon_wh", passwordHash: hash, role: "WAREHOUSE" } });
  whToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });
  const tech = await prisma.adminUser.create({ data: { username: "addon_tech", passwordHash: hash, role: "TECHNICIAN" } });
  techToken = signSession({ userId: tech.id, username: tech.username, role: "TECHNICIAN" });

  const client = await prisma.client.create({ data: { name: "Клиент добора", phone: "+70000009999" } });

  const eqCount = await prisma.equipment.create({
    data: { importKey: "addon-count", name: "Прибор COUNT", category: "Свет", rentalRatePerShift: "1000", stockTrackingMode: "COUNT", totalQuantity: 10 },
  });
  eqCountId = eqCount.id;
  const eqNeg = await prisma.equipment.create({
    data: { importKey: "addon-neg", name: "Прибор договорной", category: "Свет", rentalRatePerShift: "2000", stockTrackingMode: "COUNT", totalQuantity: 5 },
  });
  eqNegId = eqNeg.id;
  const eqUnit = await prisma.equipment.create({
    data: { importKey: "addon-unit", name: "Прибор UNIT", category: "Свет", rentalRatePerShift: "500", stockTrackingMode: "UNIT", totalQuantity: 3 },
  });
  eqUnitId = eqUnit.id;
  for (let i = 1; i <= 3; i++) {
    await prisma.equipmentUnit.create({ data: { equipmentId: eqUnitId, status: "AVAILABLE", internalInventoryNumber: `UNIT-${i}` } });
  }
  const eqBusy = await prisma.equipment.create({
    data: { importKey: "addon-busy", name: "Прибор занятый", category: "Свет", rentalRatePerShift: "100", stockTrackingMode: "COUNT", totalQuantity: 1 },
  });
  eqBusyId = eqBusy.id;

  // Бронь A — выдана, 2 смены, скидка 50 %.
  const bookingA = await prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: "Добор A",
      startDate: startA,
      endDate: endA,
      status: "ISSUED",
      issuedAt: new Date(),
      discountPercent: "50",
      totalEstimateAmount: "5000",
      discountAmount: "1000",
      finalAmount: "4000",
      amountOutstanding: "4000",
      legacyFinance: false,
      items: {
        create: [
          { equipmentId: eqCountId, quantity: 1 },
          { equipmentId: eqNegId, quantity: 1, negotiatedRatePerShift: "1500" },
        ],
      },
      estimates: {
        create: {
          kind: "MAIN",
          shifts: 2,
          subtotal: "5000",
          discountPercent: "50",
          discountAmount: "1000",
          totalAfterDiscount: "4000",
          lines: {
            create: [
              { equipmentId: eqCountId, categorySnapshot: "Свет", nameSnapshot: "Прибор COUNT", quantity: 1, unitPrice: "2000", lineSum: "2000" },
              { equipmentId: eqNegId, categorySnapshot: "Свет", nameSnapshot: "Прибор договорной", quantity: 1, unitPrice: "3000", lineSum: "3000", listUnitPrice: "4000" },
            ],
          },
        },
      },
    },
  });
  bookingAId = bookingA.id;

  // Чужая подтверждённая бронь держит единственный «Прибор занятый» на даты A.
  const other = await prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: "Другой проект",
      startDate: startA,
      endDate: endA,
      status: "CONFIRMED",
      finalAmount: "200",
      items: { create: [{ equipmentId: eqBusyId, quantity: 1 }] },
    },
  });
  otherBookingId = other.id;

  // Бронь B — выдана, без скидки, для сценария продления.
  const bookingB = await prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: "Добор B",
      startDate: startB,
      endDate: endB,
      status: "ISSUED",
      issuedAt: new Date(),
      totalEstimateAmount: "2000",
      discountAmount: "0",
      finalAmount: "2000",
      amountOutstanding: "2000",
      legacyFinance: false,
      items: { create: [{ equipmentId: eqCountId, quantity: 1 }] },
      estimates: {
        create: {
          kind: "MAIN",
          shifts: 2,
          subtotal: "2000",
          discountAmount: "0",
          totalAfterDiscount: "2000",
          lines: {
            create: [{ equipmentId: eqCountId, categorySnapshot: "Свет", nameSnapshot: "Прибор COUNT", quantity: 1, unitPrice: "2000", lineSum: "2000" }],
          },
        },
      },
    },
  });
  bookingBId = bookingB.id;

  const draft = await prisma.booking.create({
    data: { clientId: client.id, projectName: "Черновик", startDate: startB, endDate: endB, status: "DRAFT", finalAmount: "0" },
  });
  draftBookingId = draft.id;

  // Просроченная выданная бронь с ЧУЖИМИ датами держит третий юнит SkyPanel в
  // ISSUED: агрегат по датам его не вычтет, а на полке его нет — потолок UNIT
  // обязан считаться по реальному пулу свободных экземпляров.
  const overdueStart = new Date(Date.now() - 20 * DAY);
  const overdueEnd = new Date(overdueStart.getTime() + 2 * DAY);
  const unit3 = await prisma.equipmentUnit.findUnique({ where: { internalInventoryNumber: "UNIT-3" } });
  await prisma.equipmentUnit.update({ where: { id: unit3.id }, data: { status: "ISSUED" } });
  await prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: "Просроченная",
      startDate: overdueStart,
      endDate: overdueEnd,
      status: "ISSUED",
      issuedAt: overdueStart,
      finalAmount: "1000",
      items: { create: [{ equipmentId: eqUnitId, quantity: 1, unitReservations: { create: [{ equipmentUnitId: unit3.id }] } }] },
    },
  });
});

afterAll(async () => {
  await prisma?.$disconnect?.();
});

async function loadEstimates(bookingId: string) {
  const [main, addon, booking] = await Promise.all([
    prisma.estimate.findFirst({ where: { bookingId, kind: "MAIN" }, include: { lines: true } }),
    prisma.estimate.findFirst({ where: { bookingId, kind: "ADDON" }, include: { lines: true } }),
    prisma.booking.findUnique({ where: { id: bookingId } }),
  ]);
  return { main, addon, booking };
}

describe("GET /api/bookings/:id/addon-search", () => {
  it("TECHNICIAN → 403 (роутер броней закрыт для техника)", async () => {
    const res = await request(app).get(`/api/bookings/${bookingAId}/addon-search?q=Прибор`).set(H(techToken));
    expect(res.status).toBe(403);
  });

  it("отдаёт потолок добора с учётом уже взятого и конфликт по занятой позиции", async () => {
    const res = await request(app).get(`/api/bookings/${bookingAId}/addon-search?q=Прибор`).set(H(whToken));
    expect(res.status).toBe(200);
    const byId = new Map<string, any>(res.body.results.map((r: any) => [r.equipmentId, r]));

    const count = byId.get(eqCountId);
    expect(count.alreadyInBooking).toBe(1);
    expect(count.addCap).toBe(9);
    expect(count.availability).toBe("AVAILABLE");
    expect(count.stockTrackingMode).toBe("COUNT");

    const unit = byId.get(eqUnitId);
    // Пригодных 3, но один застрял в ISSUED у просроченной брони — свободных 2.
    expect(unit.addCap).toBe(2);
    expect(unit.stockTrackingMode).toBe("UNIT");

    const busy = byId.get(eqBusyId);
    expect(busy.availability).toBe("UNAVAILABLE");
    expect(busy.addCap).toBe(0);
    expect(busy.conflict?.projectName).toBe("Другой проект");
    expect(busy.conflict?.bookingId).toBe(otherBookingId);
  });
});

describe("POST /api/bookings/:id/addon-items", () => {
  it("TECHNICIAN → 403", async () => {
    const res = await request(app)
      .post(`/api/bookings/${bookingAId}/addon-items`)
      .set(H(techToken))
      .send({ items: [{ equipmentId: eqCountId, quantity: 1 }] });
    expect(res.status).toBe(403);
  });

  it("черновик → 409 BOOKING_ADDON_FORBIDDEN", async () => {
    const res = await request(app)
      .post(`/api/bookings/${draftBookingId}/addon-items`)
      .set(H(saToken))
      .send({ items: [{ equipmentId: eqCountId, quantity: 1 }] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("BOOKING_ADDON_FORBIDDEN");
  });

  it("quantity 0 → 400 (Zod)", async () => {
    const res = await request(app)
      .post(`/api/bookings/${bookingAId}/addon-items`)
      .set(H(saToken))
      .send({ items: [{ equipmentId: eqCountId, quantity: 0 }] });
    expect(res.status).toBe(400);
  });

  it("mode ADDON: ×3 COUNT → доп-смета по правилам основной, финансы +3000, аудит, AddonRecord", async () => {
    const res = await request(app)
      .post(`/api/bookings/${bookingAId}/addon-items`)
      .set(H(whToken))
      .send({ items: [{ equipmentId: eqCountId, quantity: 3 }], mode: "ADDON" });
    expect(res.status).toBe(201);
    expect(res.body.mode).toBe("ADDON");
    expect(res.body.added).toHaveLength(1);
    expect(res.body.added[0]).toMatchObject({ equipmentId: eqCountId, quantity: 3, unitsIssued: 0, hadConflict: false });
    // Ответ несёт свежую бронь с доп-сметой — странице не нужен второй запрос.
    expect(res.body.booking.addonEstimate.lines[0].nameSnapshot).toBe("Прибор COUNT");

    const item = await prisma.bookingItem.findUnique({
      where: { bookingId_equipmentId: { bookingId: bookingAId, equipmentId: eqCountId } },
    });
    expect(item.quantity).toBe(4);

    const { main, addon, booking } = await loadEstimates(bookingAId);
    // MAIN не тронут.
    expect(num(main.totalAfterDiscount)).toBe(4000);
    expect(main.lines.find((l: any) => l.equipmentId === eqCountId).quantity).toBe(1);
    // ADDON: unitPrice — за ВЕСЬ период (1000 × 2 смены), lineSum = unitPrice × qty,
    // скидка 50 % — как в основной смете.
    expect(addon).toBeTruthy();
    const line = addon.lines.find((l: any) => l.equipmentId === eqCountId);
    expect(line.quantity).toBe(3);
    expect(num(line.unitPrice)).toBe(2000);
    expect(num(line.lineSum)).toBe(6000);
    expect(num(addon.subtotal)).toBe(6000);
    expect(num(addon.discountAmount)).toBe(3000);
    expect(num(addon.totalAfterDiscount)).toBe(3000);
    // finalAmount = MAIN + ADDON (транспорта нет).
    expect(num(booking.finalAmount)).toBe(7000);
    expect(num(booking.addonAmount)).toBe(3000);
    expect(num(booking.amountOutstanding)).toBe(7000);

    const records = await prisma.addonRecord.findMany({ where: { bookingId: bookingAId } });
    expect(records).toHaveLength(1);
    expect(records[0].sessionId).toBeNull();
    expect(records[0].quantity).toBe(3);
    expect(records[0].createdBy).toBe("addon_wh");

    const audit = await prisma.auditEntry.findMany({
      where: { entityType: "Booking", entityId: bookingAId, action: "BOOKING_ADDON_ADDED" },
    });
    expect(audit).toHaveLength(1);
    const after = JSON.parse(audit[0].after);
    expect(after).toMatchObject({ mode: "ADDON", equipmentId: eqCountId, quantity: 3, bookingStatus: "ISSUED" });

    const events = await prisma.bookingFinanceEvent.findMany({ where: { bookingId: bookingAId, eventType: "BOOKING_ADDON_ADDED" } });
    expect(events).toHaveLength(1);
  });

  it("mode MERGE: договорная позиция ×2 → строка MAIN растёт по договорной цене, ADDON не трогается", async () => {
    const res = await request(app)
      .post(`/api/bookings/${bookingAId}/addon-items`)
      .set(H(saToken))
      .send({ items: [{ equipmentId: eqNegId, quantity: 2 }], mode: "MERGE" });
    expect(res.status).toBe(201);
    expect(res.body.mode).toBe("MERGE");

    const { main, addon, booking } = await loadEstimates(bookingAId);
    const negLine = main.lines.find((l: any) => l.equipmentId === eqNegId);
    expect(negLine.quantity).toBe(3);
    expect(num(negLine.unitPrice)).toBe(3000); // договорная 1500 × 2 смены — не прайс
    expect(num(negLine.lineSum)).toBe(9000);
    expect(num(negLine.listUnitPrice)).toBe(4000);
    // subtotal 2000 + 9000; скидка только на прайсовые 2000 → 1000; итог 10000.
    expect(num(main.subtotal)).toBe(11000);
    expect(num(main.discountAmount)).toBe(1000);
    expect(num(main.totalAfterDiscount)).toBe(10000);
    // Доп-смета от прошлого шага живёт отдельно.
    expect(num(addon.totalAfterDiscount)).toBe(3000);
    expect(addon.lines).toHaveLength(1);
    expect(num(booking.finalAmount)).toBe(13000);

    const audit = await prisma.auditEntry.findMany({
      where: { entityType: "Booking", entityId: bookingAId, action: "BOOKING_ADDON_ADDED" },
      orderBy: { createdAt: "desc" },
    });
    expect(JSON.parse(audit[0].after).mode).toBe("MERGE");
    expect(audit[0].userId).toBe(saId);
  });

  it("UNIT-позиция у выданной брони: юниты резервируются и сразу уходят в ISSUED", async () => {
    const res = await request(app)
      .post(`/api/bookings/${bookingAId}/addon-items`)
      .set(H(whToken))
      .send({ items: [{ equipmentId: eqUnitId, quantity: 2 }] });
    expect(res.status).toBe(201);
    expect(res.body.added[0]).toMatchObject({ unitsReserved: 2, unitsIssued: 2 });

    const item = await prisma.bookingItem.findUnique({
      where: { bookingId_equipmentId: { bookingId: bookingAId, equipmentId: eqUnitId } },
      include: { unitReservations: { include: { equipmentUnit: true } } },
    });
    expect(item.quantity).toBe(2);
    expect(item.unitReservations).toHaveLength(2);
    expect(item.unitReservations.every((r: any) => r.returnedAt === null)).toBe(true);
    expect(item.unitReservations.every((r: any) => r.equipmentUnit.status === "ISSUED")).toBe(true);

    const units = await prisma.equipmentUnit.findMany({ where: { equipmentId: eqUnitId } });
    // Два выданы в A, третий — у просроченной брони; свободных не осталось.
    expect(units.filter((u: any) => u.status === "ISSUED")).toHaveLength(3);
    expect(units.filter((u: any) => u.status === "AVAILABLE")).toHaveLength(0);

    const { addon } = await loadEstimates(bookingAId);
    const unitLine = addon.lines.find((l: any) => l.equipmentId === eqUnitId);
    expect(unitLine.quantity).toBe(2);
    expect(num(unitLine.unitPrice)).toBe(1000); // 500 × 2 смены
  });

  it("hard cap: сверх реально свободных юнитов → 409 ADDON_OVER_STOCK с деталями", async () => {
    // Агрегат по датам обещал бы ещё 1 (пригодных 3 − в брони 2), но третий юнит
    // застрял у просроченной брони — свободных 0.
    const res = await request(app)
      .post(`/api/bookings/${bookingAId}/addon-items`)
      .set(H(whToken))
      .send({ items: [{ equipmentId: eqUnitId, quantity: 1 }] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ADDON_OVER_STOCK");
    expect(res.body.details).toMatchObject({ equipmentId: eqUnitId, addCap: 0, requested: 1, alreadyInBooking: 2 });

    // Отказ ничего не записал.
    const item = await prisma.bookingItem.findUnique({
      where: { bookingId_equipmentId: { bookingId: bookingAId, equipmentId: eqUnitId } },
    });
    expect(item.quantity).toBe(2);
  });

  it("конфликт по датам: 409 ADDON_CONFLICT, с acknowledgedConflict — добавлено «под ответственность» + аудит", async () => {
    const first = await request(app)
      .post(`/api/bookings/${bookingAId}/addon-items`)
      .set(H(whToken))
      .send({ items: [{ equipmentId: eqBusyId, quantity: 1 }] });
    expect(first.status).toBe(409);
    expect(first.body.code).toBe("ADDON_CONFLICT");
    expect(first.body.details.projectName).toBe("Другой проект");
    expect(first.body.details.conflicts).toHaveLength(1);
    expect(first.body.details.conflicts[0]).toMatchObject({ equipmentId: eqBusyId, name: "Прибор занятый", quantity: 1 });

    const ack = await request(app)
      .post(`/api/bookings/${bookingAId}/addon-items`)
      .set(H(whToken))
      .send({ items: [{ equipmentId: eqBusyId, quantity: 1 }], acknowledgedConflict: true });
    expect(ack.status).toBe(201);
    expect(ack.body.added[0].hadConflict).toBe(true);
    expect(ack.body.conflicts).toHaveLength(1);

    const audit = await prisma.auditEntry.findMany({
      where: { entityType: "Booking", entityId: bookingAId, action: "BOOKING_ADDON_ADDED" },
      orderBy: { createdAt: "desc" },
    });
    const after = JSON.parse(audit[0].after);
    expect(after.acknowledgedConflict).toBe(true);
    expect(after.conflictBookingId).toBe(otherBookingId);

    const record = await prisma.addonRecord.findFirst({ where: { bookingId: bookingAId, equipmentId: eqBusyId } });
    expect(record.acknowledgedConflict).toBe(true);
  });
});

describe("POST /api/bookings/:id/addon-estimate/merge", () => {
  it("без доп-сметы → 404 ADDON_ESTIMATE_NOT_FOUND", async () => {
    const res = await request(app).post(`/api/bookings/${bookingBId}/addon-estimate/merge`).set(H(saToken));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("ADDON_ESTIMATE_NOT_FOUND");
  });

  it("вливает доп-смету: ADDON исчезает, MAIN содержит доборы, сумма к оплате не меняется", async () => {
    const before = await loadEstimates(bookingAId);
    expect(before.addon).toBeTruthy();
    const finalBefore = num(before.booking.finalAmount);

    // Кладовщик тоже может: роут за rolesGuard(SA, WAREHOUSE), отдельного гарда нет.
    const res = await request(app).post(`/api/bookings/${bookingAId}/addon-estimate/merge`).set(H(whToken));
    expect(res.status).toBe(200);
    expect(res.body.mergedLines).toBe(3); // COUNT ×3, UNIT ×2, занятый ×1
    expect(res.body.mergedQuantity).toBe(6);
    expect(res.body.booking.addonEstimate).toBeNull();

    const { main, addon, booking } = await loadEstimates(bookingAId);
    expect(addon).toBeNull();
    expect(main.id).toBe(before.main.id); // снапшот обновлён на месте, ссылки живы
    expect(main.lines.find((l: any) => l.equipmentId === eqCountId).quantity).toBe(4);
    expect(main.lines.find((l: any) => l.equipmentId === eqUnitId).quantity).toBe(2);
    expect(main.lines.find((l: any) => l.equipmentId === eqBusyId).quantity).toBe(1);
    expect(main.lines.find((l: any) => l.equipmentId === eqNegId).quantity).toBe(3);
    expect(num(booking.finalAmount)).toBe(finalBefore);
    expect(num(booking.addonAmount)).toBe(0);

    const audit = await prisma.auditEntry.findMany({
      where: { entityType: "Booking", entityId: bookingAId, action: "BOOKING_ADDON_MERGED" },
    });
    expect(audit).toHaveLength(1);
  });
});

describe("активная складская сессия блокирует добор", () => {
  it("RETURN-сессия открыта → 409 SCAN_SESSION_ACTIVE; после отмены сессии добор проходит", async () => {
    const session = await prisma.scanSession.create({
      data: { bookingId: bookingBId, workerName: "Иван Кладовщик", operation: "RETURN", status: "ACTIVE" },
    });
    const blocked = await request(app)
      .post(`/api/bookings/${bookingBId}/addon-items`)
      .set(H(saToken))
      .send({ items: [{ equipmentId: eqCountId, quantity: 1 }] });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("SCAN_SESSION_ACTIVE");
    expect(blocked.body.details).toMatchObject({ sessionId: session.id, operation: "RETURN", workerName: "Иван Кладовщик" });
    expect(blocked.body.message).toMatch(/приёмка/);

    // Ничего не записано.
    const item = await prisma.bookingItem.findUnique({
      where: { bookingId_equipmentId: { bookingId: bookingBId, equipmentId: eqCountId } },
    });
    expect(item.quantity).toBe(1);

    await prisma.scanSession.update({ where: { id: session.id }, data: { status: "CANCELLED" } });
    const ok = await request(app)
      .post(`/api/bookings/${bookingBId}/addon-items`)
      .set(H(saToken))
      .send({ items: [{ equipmentId: eqCountId, quantity: 1 }] });
    expect(ok.status).toBe(201);
    // Откатываем, чтобы сценарий продления ниже считал от исходного состава.
    await prisma.bookingItem.update({
      where: { bookingId_equipmentId: { bookingId: bookingBId, equipmentId: eqCountId } },
      data: { quantity: 1 },
    });
    const { recomputeAddonEstimate } = await import("../services/addonEstimate");
    const { recomputeBookingFinance } = await import("../services/finance");
    await recomputeAddonEstimate(bookingBId);
    await recomputeBookingFinance(bookingBId);
  });
});

describe("PATCH extendEndDate вместе с items", () => {
  it("→ 409 ITEMS_LOCKED_UNTIL_RETURN: продление не меняет состав", async () => {
    const res = await request(app)
      .patch(`/api/bookings/${bookingBId}`)
      .set(H(saToken))
      .send({ extendEndDate: new Date(endB.getTime() + DAY).toISOString(), items: [{ equipmentId: eqCountId, quantity: 5 }] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ITEMS_LOCKED_UNTIL_RETURN");
  });
});

describe("продление выданной брони с доп-сметой", () => {
  it("MAIN не поглощает добор, обе сметы пересчитаны под новые смены, финансы без дубля", async () => {
    const added = await request(app)
      .post(`/api/bookings/${bookingBId}/addon-items`)
      .set(H(whToken))
      .send({ items: [{ equipmentId: eqCountId, quantity: 2 }], mode: "ADDON" });
    expect(added.status).toBe(201);
    let state = await loadEstimates(bookingBId);
    expect(num(state.booking.finalAmount)).toBe(6000); // 2000 + 2 × 2000

    const newEnd = new Date(endB.getTime() + DAY); // 72 ч → 3 смены
    const patched = await request(app)
      .patch(`/api/bookings/${bookingBId}`)
      .set(H(saToken))
      .send({ extendEndDate: newEnd.toISOString() });
    expect(patched.status).toBe(200);

    state = await loadEstimates(bookingBId);
    expect(state.main.shifts).toBe(3);
    const mainLine = state.main.lines.find((l: any) => l.equipmentId === eqCountId);
    expect(mainLine.quantity).toBe(1);
    expect(num(mainLine.unitPrice)).toBe(3000);
    expect(num(state.main.totalAfterDiscount)).toBe(3000);

    expect(state.addon).toBeTruthy();
    expect(state.addon.shifts).toBe(3);
    const addonLine = state.addon.lines.find((l: any) => l.equipmentId === eqCountId);
    expect(addonLine.quantity).toBe(2);
    expect(num(addonLine.unitPrice)).toBe(3000);
    expect(num(state.addon.totalAfterDiscount)).toBe(6000);

    // Было бы 15000 при двойном учёте (MAIN из всех позиций + устаревший ADDON).
    expect(num(state.booking.finalAmount)).toBe(9000);
  });
});
