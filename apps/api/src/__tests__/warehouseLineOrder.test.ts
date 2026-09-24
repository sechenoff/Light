/**
 * Интеграционный тест: киоск склада получает позиции брони в порядке каталога.
 *
 * PIN-кладовщик не может запросить /api/equipment/categories, поэтому порядок
 * категорий ему отдаёт сервер: чек-лист выдачи/приёмки (/sessions/:id/state) и
 * детали «В работе» (/in-work/:bookingId/details) идут категория за категорией
 * (порядок с /equipment/manage), внутри категории — sortOrder, затем имя;
 * произвольные позиции — в конце. Позиции нарочно заведены вперемешку.
 */

import path from "path";
import { execSync } from "child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-warehouse-line-order.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-wh-line-order";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-wh-line-order";
process.env.WAREHOUSE_SECRET = "test-warehouse-line-order-min16c";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-wh-line-order-min16chars";

let app: any;
let prisma: any;
let warehouseToken: string;
let bookingId: string;
let issueSessionId: string;
let returnSessionId: string;

/**
 * Порядок, в котором кладовщик должен видеть бронь. Внутри обеих категорий
 * sortOrder нарочно спорит с алфавитом — так видно, что работает порядок из
 * редактора, а не имя.
 */
const EXPECTED_NAMES = [
  "Electric Storm 52XT", // Свет, sortOrder 1
  "Aputure LS 1200x", // Свет, sortOrder 2
  "C-стенд", // Грип, sortOrder 1 (по имени «Флаг» раньше)
  "Флаг 4x4", // Грип, sortOrder 2
  "Удлинитель 25 м", // Кабели — нет в сохранённом порядке, после известных
  "Доставка на площадку", // произвольная — в конце
];

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

  prisma = (await import("../prisma")).prisma;
  app = (await import("../app")).app;

  const { hashPin } = await import("../services/warehouseAuth");
  await prisma.warehousePin.create({
    data: { name: "Кладовщик порядок", pinHash: await hashPin("246810"), isActive: true },
  });
  const authRes = await request(app)
    .post("/api/warehouse/auth")
    .send({ name: "Кладовщик порядок", pin: "246810" });
  expect(authRes.status).toBe(200);
  warehouseToken = authRes.body.token;

  // Порядок категорий с /equipment/manage: «Свет» раньше «Грип», хотя по
  // алфавиту наоборот — так видно, что работает именно сохранённый порядок.
  await prisma.appSetting.create({
    data: { key: "equipment_category_order", value: JSON.stringify(["Свет", "Грип"]) },
  });

  const eq = (importKey: string, name: string, category: string, sortOrder: number, mode = "COUNT") =>
    prisma.equipment.create({
      data: {
        importKey,
        name,
        category,
        sortOrder,
        totalQuantity: 10,
        rentalRatePerShift: 1000,
        stockTrackingMode: mode,
      },
    });
  const flag = await eq("lo-flag", "Флаг 4x4", "Грип", 2);
  const storm = await eq("lo-storm", "Electric Storm 52XT", "Свет", 1, "UNIT");
  const cable = await eq("lo-cable", "Удлинитель 25 м", "Кабели", 0);
  const cstand = await eq("lo-cstand", "C-стенд", "Грип", 1);
  const ls = await eq("lo-ls", "Aputure LS 1200x", "Свет", 2);

  const client = await prisma.client.create({
    data: { name: "Клиент порядок строк", phone: "+70000000077" },
  });
  const booking = await prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: "Порядок по категориям",
      startDate: new Date("2026-05-10"),
      endDate: new Date("2026-05-12"),
      status: "ISSUED",
      amountPaid: 0,
      amountOutstanding: 0,
    },
  });
  bookingId = booking.id;

  // Позиции добавлены «как попало»: произвольная — не последней, категории
  // вперемешку. createdAt разнесены явно, чтобы старый порядок был однозначен.
  const base = Date.parse("2026-05-01T10:00:00.000Z");
  const addItem = (i: number, data: Record<string, unknown>) =>
    prisma.bookingItem.create({
      data: { bookingId, quantity: 1, createdAt: new Date(base + i * 60_000), ...data },
    });
  await addItem(0, { equipmentId: flag.id });
  const stormItem = await addItem(1, { equipmentId: storm.id });
  await addItem(2, { customName: "Доставка на площадку", customUnitPrice: 5000 });
  await addItem(3, { equipmentId: cstand.id });
  await addItem(4, { equipmentId: cable.id });
  await addItem(5, { equipmentId: ls.id });

  const unit = await prisma.equipmentUnit.create({
    data: { equipmentId: storm.id, barcode: "LO-STORM-001", status: "ISSUED" },
  });
  await prisma.bookingItemUnit.create({
    data: { bookingItemId: stormItem.id, equipmentUnitId: unit.id },
  });

  const session = (operation: "ISSUE" | "RETURN") =>
    prisma.scanSession.create({
      data: { bookingId, workerName: "Кладовщик порядок", operation, status: "ACTIVE" },
    });
  issueSessionId = (await session("ISSUE")).id;
  returnSessionId = (await session("RETURN")).id;
});

afterAll(async () => {
  await prisma?.$disconnect();
});

describe("порядок позиций брони в киоске склада", () => {
  it("чек-лист выдачи — по категориям каталога, произвольные в конце", async () => {
    const res = await request(app)
      .get(`/api/warehouse/sessions/${issueSessionId}/state`)
      .set("Authorization", `Bearer ${warehouseToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items.map((i: any) => i.equipmentName)).toEqual(EXPECTED_NAMES);
    // Киоск группирует по category в порядке первого появления — группы
    // должны идти подряд, без повторов.
    const categories = res.body.items.map((i: any) => i.category);
    expect(categories).toEqual(["Свет", "Свет", "Грип", "Грип", "Кабели", "Добавлено на месте"]);
  });

  it("чек-лист приёмки — тот же порядок", async () => {
    const res = await request(app)
      .get(`/api/warehouse/sessions/${returnSessionId}/state`)
      .set("Authorization", `Bearer ${warehouseToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items.map((i: any) => i.equipmentName)).toEqual(EXPECTED_NAMES);
    const storm = res.body.items.find((i: any) => i.equipmentName === "Electric Storm 52XT");
    expect(storm.trackingMode).toBe("UNIT");
    expect(storm.units).toHaveLength(1);
  });

  it("детали «В работе» — тот же порядок и category у каждой позиции", async () => {
    const res = await request(app)
      .get(`/api/warehouse/in-work/${bookingId}/details`)
      .set("Authorization", `Bearer ${warehouseToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items.map((i: any) => i.equipmentName)).toEqual(EXPECTED_NAMES);
    expect(res.body.items.map((i: any) => i.category)).toEqual([
      "Свет",
      "Свет",
      "Грип",
      "Грип",
      "Кабели",
      "Без категории",
    ]);
  });
});
