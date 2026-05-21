/**
 * Интеграционный тест Task 14:
 *   ISSUE-сессия → /complete с issuanceAdjustments → BookingItem.quantity,
 *   MAIN-смета, ADDON-смета, paymentStatus, audit-лог.
 *
 * Покрывает оба сценария «issue-time stock cap and unit removal»:
 *
 *   1) Полный adjustment + OVERPAID
 *      CONFIRMED-бронь с quantity=3 ⇒ через issuanceAdjustments actualQuantity=2
 *      → MAIN.totalAfterDiscount = 2000, paymentStatus = OVERPAID
 *      (уплачено 3000 при новом finalAmount 2000), audit "BOOKING_ITEM_QUANTITY_REDUCED".
 *
 *   2) +Добор hard cap (ADDON_OVER_STOCK)
 *      totalQuantity=5, в текущей броне quantity=3 + в другой брони quantity=1
 *      → addCap = 5 − 1 − 3 = 1. POST /items с quantity=2 → 409 ADDON_OVER_STOCK,
 *      затем с quantity=1 → 201, затем ещё с quantity=1 → 409 addCap=0.
 *
 * Тест использует РЕАЛЬНЫЙ HTTP через supertest (а не прямые вызовы сервисов).
 *
 * NB: для проверки audit-лога SUPER_ADMIN.id используется как имя WarehousePin —
 *      тогда `userId` writeAuditEntry соответствует валидному FK на AdminUser,
 *      и записи в auditEntry создаются (по умолчанию они best-effort и тихо
 *      падают на P2003 в проде, когда workerName ≠ AdminUser.id).
 */

import path from "path";
import { execSync } from "child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-issue-adjust.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-issue-adjust";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-issue-adjust";
process.env.WAREHOUSE_SECRET = "test-warehouse-issue-adjust-min16";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-issue-adjust-min16chars";

let app: any;
let prisma: any;
let warehouseToken: string;

// Scenario 1 state
let clientId: string;
let equipmentId: string;
let bookingId: string;
let bookingItemId: string;
let sessionId: string;

// Scenario 2 state
let bookingId2: string;
let sessionId2: string;
let otherBookingId: string;

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
  const { app: expressApp } = await import("../app");
  app = expressApp;

  // Создаём SUPER_ADMIN и используем его id как «name» WarehousePin —
  // тогда completeSession передаёт createdBy = pin.name = adminUser.id, что
  // удовлетворяет FK auditEntry.userId → adminUser.id и audit-записи реально
  // сохраняются (см. шапку файла).
  const { hashPassword } = await import("../services/auth");
  const passHash = await hashPassword("issue-adjust-pass");
  const admin = await prisma.adminUser.create({
    data: {
      username: "issue_adjust_super",
      passwordHash: passHash,
      role: "SUPER_ADMIN",
    },
  });

  const { hashPin } = await import("../services/warehouseAuth");
  const pinHash = await hashPin("1234");
  await prisma.warehousePin.create({
    data: { name: admin.id, pinHash, isActive: true },
  });

  const authRes = await request(app)
    .post("/api/warehouse/auth")
    .send({ name: admin.id, pin: "1234" });
  warehouseToken = authRes.body.token;
  expect(warehouseToken).toBeTruthy();

  // ── Общее оборудование Aputure — totalQuantity=5, COUNT-mode ───────────────
  const client = await prisma.client.create({
    data: { name: "Issue-adjust клиент", phone: "+70000007777" },
  });
  clientId = client.id;

  const eq = await prisma.equipment.create({
    data: {
      importKey: "issue-adjust-aputure",
      name: "Aputure",
      category: "Свет",
      rentalRatePerShift: "1000",
      stockTrackingMode: "COUNT",
      totalQuantity: 5,
    },
  });
  equipmentId = eq.id;

  // ── Scenario 1: CONFIRMED-бронь, 1 смена, qty=3, MAIN=3000, paid=3000 ──────
  const startDate = new Date("2026-06-10");
  const endDate = new Date("2026-06-11");

  const booking = await prisma.booking.create({
    data: {
      clientId,
      projectName: "Issue adjust full",
      startDate,
      endDate,
      status: "CONFIRMED",
      totalEstimateAmount: "3000",
      discountAmount: "0",
      finalAmount: "3000",
      amountOutstanding: "0",
      amountPaid: "3000",
      paymentStatus: "PAID",
      isFullyPaid: true,
    },
  });
  bookingId = booking.id;

  const bi = await prisma.bookingItem.create({
    data: { bookingId, equipmentId, quantity: 3 },
  });
  bookingItemId = bi.id;

  await prisma.estimate.create({
    data: {
      bookingId,
      kind: "MAIN",
      shifts: 1,
      subtotal: "3000",
      discountAmount: "0",
      totalAfterDiscount: "3000",
      lines: {
        create: [
          {
            equipmentId,
            quantity: 3,
            unitPrice: "1000",
            lineSum: "3000",
            categorySnapshot: "Свет",
            nameSnapshot: "Aputure",
          },
        ],
      },
    },
  });

  // amountPaid=3000 — фактическая оплата (Booking.amountPaid выставлено выше,
  // recomputeBookingFinance перечитает payments). Создаём Payment-запись,
  // чтобы recomputeBookingFinance корректно посчитал OVERPAID после adjustment.
  await prisma.payment.create({
    data: {
      bookingId,
      direction: "INCOME",
      amount: "3000",
      status: "RECEIVED",
      paymentMethod: "CASH",
      receivedAt: new Date("2026-06-09"),
    },
  });

  // ── Scenario 2: bookingId2 (qty=3) + otherBookingId (qty=1) → addCap=1 ────
  // Даты пересекаются с bookingId2, чтобы occupiedByOthers учитывался.
  const start2 = new Date("2026-07-01");
  const end2 = new Date("2026-07-02");

  const otherBooking = await prisma.booking.create({
    data: {
      clientId,
      projectName: "Параллельная бронь",
      startDate: start2,
      endDate: end2,
      status: "CONFIRMED",
      totalEstimateAmount: "1000",
      discountAmount: "0",
      finalAmount: "1000",
      amountOutstanding: "1000",
      amountPaid: "0",
    },
  });
  otherBookingId = otherBooking.id;
  await prisma.bookingItem.create({
    data: { bookingId: otherBooking.id, equipmentId, quantity: 1 },
  });

  const booking2 = await prisma.booking.create({
    data: {
      clientId,
      projectName: "Issue adjust addon-cap",
      startDate: start2,
      endDate: end2,
      status: "CONFIRMED",
      totalEstimateAmount: "3000",
      discountAmount: "0",
      finalAmount: "3000",
      amountOutstanding: "3000",
      amountPaid: "0",
    },
  });
  bookingId2 = booking2.id;
  await prisma.bookingItem.create({
    data: { bookingId: booking2.id, equipmentId, quantity: 3 },
  });
  await prisma.estimate.create({
    data: {
      bookingId: booking2.id,
      kind: "MAIN",
      shifts: 1,
      subtotal: "3000",
      discountAmount: "0",
      totalAfterDiscount: "3000",
      lines: {
        create: [
          {
            equipmentId,
            quantity: 3,
            unitPrice: "1000",
            lineSum: "3000",
            categorySnapshot: "Свет",
            nameSnapshot: "Aputure",
          },
        ],
      },
    },
  });
});

afterAll(async () => {
  await prisma?.$disconnect?.();
});

describe("Issue-time adjustments + addon hard cap — full HTTP flow", () => {
  it("Scenario 1: CONFIRMED → +ISSUE session → /complete с actualQuantity=2 → OVERPAID + MAIN=2000 + audit", async () => {
    // 1. Создаём ISSUE-сессию через POST /api/warehouse/sessions.
    const sessionRes = await request(app)
      .post("/api/warehouse/sessions")
      .set("Authorization", `Bearer ${warehouseToken}`)
      .send({ bookingId, operation: "ISSUE" });
    expect(sessionRes.status).toBe(201);
    sessionId = sessionRes.body.session.id;
    expect(sessionId).toBeTruthy();

    // 2. Завершаем сессию с уменьшением BookingItem.quantity 3 → 2.
    const completeRes = await request(app)
      .post(`/api/warehouse/sessions/${sessionId}/complete`)
      .set("Authorization", `Bearer ${warehouseToken}`)
      .send({
        issuanceAdjustments: [
          { bookingItemId, actualQuantity: 2 },
        ],
      });

    expect(completeRes.status).toBe(200);

    // 3. paymentStatus = OVERPAID (paid 3000 > new finalAmount 2000).
    const freshBooking = await prisma.booking.findUnique({
      where: { id: bookingId },
    });
    expect(freshBooking.paymentStatus).toBe("OVERPAID");

    // 4. BookingItem.quantity уменьшен до 2.
    const freshItem = await prisma.bookingItem.findUnique({
      where: { id: bookingItemId },
    });
    expect(freshItem.quantity).toBe(2);

    // 5. MAIN.totalAfterDiscount = 2000 (1 смена × 2 шт × 1000).
    const freshMain = await prisma.estimate.findFirst({
      where: { bookingId, kind: "MAIN" },
    });
    expect(freshMain).toBeTruthy();
    expect(freshMain.totalAfterDiscount.toString()).toBe("2000");

    // 6. AuditEntry BOOKING_ITEM_QUANTITY_REDUCED для этой брони существует.
    const auditEntries = await prisma.auditEntry.findMany({
      where: {
        action: "BOOKING_ITEM_QUANTITY_REDUCED",
        entityType: "Booking",
        entityId: bookingId,
      },
    });
    expect(auditEntries.length).toBeGreaterThan(0);
    // before/after снапшоты содержат quantity до/после изменения.
    const afterSnap = JSON.parse(auditEntries[0].after ?? "{}");
    expect(afterSnap.quantity).toBe(2);
    const beforeSnap = JSON.parse(auditEntries[0].before ?? "{}");
    expect(beforeSnap.quantity).toBe(3);

    // 7. HTTP-ответ /complete сам тоже отдаёт paymentStatus + finance-разбивку
    //    (контракт Task 13). Регресс-гард на shape.
    expect(completeRes.body.paymentStatus).toBe("OVERPAID");
    expect(completeRes.body.mainAfterDiscount).toBe("2000");
  });

  it("Scenario 2: +Добор hard cap — addCap=1, потом 0", async () => {
    // 1. Создаём ISSUE-сессию для bookingId2.
    const sessionRes = await request(app)
      .post("/api/warehouse/sessions")
      .set("Authorization", `Bearer ${warehouseToken}`)
      .send({ bookingId: bookingId2, operation: "ISSUE" });
    expect(sessionRes.status).toBe(201);
    sessionId2 = sessionRes.body.session.id;

    // 2. +Добор quantity=2 → 409 ADDON_OVER_STOCK, addCap=1.
    //    `acknowledgedConflict: true` нужен, чтобы пройти soft-warn
    //    ADDON_CONFLICT (другая бронь занимает оборудование на те же даты) и
    //    дойти до hard-cap проверки внутри транзакции.
    //
    //    Контракт ответа HTTP-ошибки: центральный обработчик в `app.ts`
    //    кладёт structured-details из 4-арг формы HttpError в `body.details`
    //    как объект; машинно-читаемый код события — это `body.message`
    //    «Не хватает на складе» + дискриминирующий `details.addCap`.
    //    (Top-level `code` строкой выставляется только когда `details` —
    //    строка, см. backward-compat ветку в `app.ts`.)
    const overRes = await request(app)
      .post(`/api/warehouse/sessions/${sessionId2}/items`)
      .set("Authorization", `Bearer ${warehouseToken}`)
      .send({ equipmentId, quantity: 2, acknowledgedConflict: true });

    expect(overRes.status).toBe(409);
    expect(overRes.body.message).toBe("Не хватает на складе");
    expect(overRes.body.details).toMatchObject({
      addCap: 1,
      requested: 2,
      alreadyInBooking: 3,
    });

    // 3. +Добор quantity=1 → 201.
    const okRes = await request(app)
      .post(`/api/warehouse/sessions/${sessionId2}/items`)
      .set("Authorization", `Bearer ${warehouseToken}`)
      .send({ equipmentId, quantity: 1, acknowledgedConflict: true });

    expect(okRes.status).toBe(201);
    expect(okRes.body.bookingItemId).toBeTruthy();

    // 4. Повторный +Добор quantity=1 → 409 ADDON_OVER_STOCK, addCap=0.
    const zeroRes = await request(app)
      .post(`/api/warehouse/sessions/${sessionId2}/items`)
      .set("Authorization", `Bearer ${warehouseToken}`)
      .send({ equipmentId, quantity: 1, acknowledgedConflict: true });

    expect(zeroRes.status).toBe(409);
    expect(zeroRes.body.message).toBe("Не хватает на складе");
    expect(zeroRes.body.details).toMatchObject({
      addCap: 0,
      requested: 1,
      alreadyInBooking: 4, // 3 первоначальных + 1 успешный добор
    });
  });
});
