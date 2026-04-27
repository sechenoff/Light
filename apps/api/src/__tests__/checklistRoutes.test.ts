/**
 * Интеграционный тест: маршруты чек-листа склада
 * /check, /uncheck, /state, /items — через warehouseAuth (Bearer token)
 */

import path from "path";
import { execSync } from "child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-checklist-routes.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-cl-routes";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-cl-routes";
process.env.WAREHOUSE_SECRET = "test-warehouse-cl-routes-min16c";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-cl-routes-min16chars00";

let app: any;
let prisma: any;
let warehouseToken: string;
let sessionId: string;
let unitId: string;
let unit2Id: string;
let equipmentId: string;
let countEquipmentId: string;
let bookingId: string;

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

  const { hashPin } = await import("../services/warehouseAuth");
  const pinHash = await hashPin("1234");

  await prisma.warehousePin.create({
    data: { name: "Тест кладовщик", pinHash, isActive: true },
  });

  // Получаем токен
  const authRes = await request(app)
    .post("/api/warehouse/auth")
    .send({ name: "Тест кладовщик", pin: "1234" });

  expect(authRes.status).toBe(200);
  warehouseToken = authRes.body.token;

  const client = await prisma.client.create({
    data: { name: "Тест клиент cl-routes", phone: "+70000000003" },
  });

  // UNIT оборудование
  const equipment = await prisma.equipment.create({
    data: {
      importKey: "cl-routes-unit-001",
      name: "Profoto B10",
      category: "Flash",
      rentalRatePerShift: 3000,
      stockTrackingMode: "UNIT",
    },
  });
  equipmentId = equipment.id;

  const unit = await prisma.equipmentUnit.create({
    data: { equipmentId, barcode: "PROFOTO-001", status: "AVAILABLE" },
  });
  unitId = unit.id;

  const unit2 = await prisma.equipmentUnit.create({
    data: { equipmentId, barcode: "PROFOTO-002", status: "AVAILABLE" },
  });
  unit2Id = unit2.id;

  // COUNT оборудование
  const countEquipment = await prisma.equipment.create({
    data: {
      importKey: "cl-routes-count-001",
      name: "C-stand 40",
      category: "Аксессуары",
      rentalRatePerShift: 600,
      stockTrackingMode: "COUNT",
    },
  });
  countEquipmentId = countEquipment.id;

  // Бронь
  const booking = await prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: "Тест маршруты чек-лист",
      startDate: new Date("2026-05-10"),
      endDate: new Date("2026-05-12"),
      status: "CONFIRMED",
      amountPaid: 0,
      amountOutstanding: 0,
    },
  });
  bookingId = booking.id;

  const unitBi = await prisma.bookingItem.create({
    data: { bookingId, equipmentId, quantity: 2 },
  });

  await prisma.bookingItemUnit.createMany({
    data: [
      { bookingItemId: unitBi.id, equipmentUnitId: unitId },
      { bookingItemId: unitBi.id, equipmentUnitId: unit2Id },
    ],
  });

  await prisma.bookingItem.create({
    data: { bookingId, equipmentId: countEquipmentId, quantity: 3 },
  });

  // Создаём сессию
  const session = await prisma.scanSession.create({
    data: {
      bookingId,
      workerName: "Тест кладовщик",
      operation: "ISSUE",
      status: "ACTIVE",
    },
  });
  sessionId = session.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("GET /api/warehouse/sessions/:id/state", () => {
  it("возвращает состояние чек-листа", async () => {
    const res = await request(app)
      .get(`/api/warehouse/sessions/${sessionId}/state`)
      .set("X-API-Key", "test-key-cl-routes")
      .set("Authorization", `Bearer ${warehouseToken}`);

    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe(sessionId);
    expect(res.body.bookingId).toBe(bookingId);
    expect(res.body.operation).toBe("ISSUE");
    expect(res.body.items).toBeInstanceOf(Array);

    const unitItem = res.body.items.find((i: any) => i.trackingMode === "UNIT");
    expect(unitItem).toBeDefined();
    expect(unitItem.units).toHaveLength(2);

    const countItem = res.body.items.find((i: any) => i.trackingMode === "COUNT");
    expect(countItem).toBeDefined();
    expect(countItem.quantity).toBe(3);
  });

  it("возвращает 401 без токена", async () => {
    const res = await request(app)
      .get(`/api/warehouse/sessions/${sessionId}/state`)
      .set("X-API-Key", "test-key-cl-routes");

    expect(res.status).toBe(401);
  });
});

describe("POST /api/warehouse/sessions/:id/check", () => {
  it("отмечает UNIT-позицию", async () => {
    const res = await request(app)
      .post(`/api/warehouse/sessions/${sessionId}/check`)
      .set("X-API-Key", "test-key-cl-routes")
      .set("Authorization", `Bearer ${warehouseToken}`)
      .send({ equipmentUnitId: unitId });

    expect(res.status).toBe(200);
    expect(res.body.alreadyChecked).toBe(false);

    // Проверяем что ScanRecord создан
    const record = await prisma.scanRecord.findFirst({
      where: { sessionId, equipmentUnitId: unitId },
    });
    expect(record).not.toBeNull();
  });

  it("идемпотентен — повторный check возвращает alreadyChecked=true", async () => {
    const res = await request(app)
      .post(`/api/warehouse/sessions/${sessionId}/check`)
      .set("X-API-Key", "test-key-cl-routes")
      .set("Authorization", `Bearer ${warehouseToken}`)
      .send({ equipmentUnitId: unitId });

    expect(res.status).toBe(200);
    expect(res.body.alreadyChecked).toBe(true);
  });

  it("возвращает 400 при отсутствии equipmentUnitId", async () => {
    const res = await request(app)
      .post(`/api/warehouse/sessions/${sessionId}/check`)
      .set("X-API-Key", "test-key-cl-routes")
      .set("Authorization", `Bearer ${warehouseToken}`)
      .send({});

    expect(res.status).toBe(400);
  });
});

describe("POST /api/warehouse/sessions/:id/uncheck", () => {
  it("снимает отметку", async () => {
    // Убедимся, что запись есть
    const before = await prisma.scanRecord.findFirst({
      where: { sessionId, equipmentUnitId: unitId },
    });
    expect(before).not.toBeNull();

    const res = await request(app)
      .post(`/api/warehouse/sessions/${sessionId}/uncheck`)
      .set("X-API-Key", "test-key-cl-routes")
      .set("Authorization", `Bearer ${warehouseToken}`)
      .send({ equipmentUnitId: unitId });

    expect(res.status).toBe(200);
    expect(res.body.wasChecked).toBe(true);

    const after = await prisma.scanRecord.findFirst({
      where: { sessionId, equipmentUnitId: unitId },
    });
    expect(after).toBeNull();
  });

  it("идемпотентен — uncheck несуществующего возвращает wasChecked=false", async () => {
    const res = await request(app)
      .post(`/api/warehouse/sessions/${sessionId}/uncheck`)
      .set("X-API-Key", "test-key-cl-routes")
      .set("Authorization", `Bearer ${warehouseToken}`)
      .send({ equipmentUnitId: unitId });

    expect(res.status).toBe(200);
    expect(res.body.wasChecked).toBe(false);
  });
});

describe("POST /api/warehouse/sessions/:id/items (quick-add)", () => {
  it("добавляет новую позицию в бронь", async () => {
    const extraEquipment = await prisma.equipment.create({
      data: {
        importKey: "cl-routes-extra-001",
        name: "Sandbag 5kg",
        category: "Аксессуары",
        rentalRatePerShift: 100,
        stockTrackingMode: "COUNT",
      },
    });

    const res = await request(app)
      .post(`/api/warehouse/sessions/${sessionId}/items`)
      .set("X-API-Key", "test-key-cl-routes")
      .set("Authorization", `Bearer ${warehouseToken}`)
      .send({ equipmentId: extraEquipment.id, quantity: 4 });

    expect(res.status).toBe(201);
    expect(res.body.bookingItemId).toBeTruthy();

    const item = await prisma.bookingItem.findUnique({
      where: { id: res.body.bookingItemId },
    });
    expect(item.quantity).toBe(4);
    expect(item.bookingId).toBe(bookingId);
  });

  it("возвращает 400 при отрицательном quantity", async () => {
    const res = await request(app)
      .post(`/api/warehouse/sessions/${sessionId}/items`)
      .set("X-API-Key", "test-key-cl-routes")
      .set("Authorization", `Bearer ${warehouseToken}`)
      .send({ equipmentId: countEquipmentId, quantity: -1 });

    expect(res.status).toBe(400);
  });
});
