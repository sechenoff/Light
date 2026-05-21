/**
 * Регрессионный route-level тест: `GET /api/warehouse/sessions/:id/summary`
 * ДОЛЖЕН пробрасывать `reservedButUnavailable` в HTTP-ответ.
 *
 * Существующий `warehouseScanIssueComplete.test.ts` тестирует сервисную
 * функцию `getReconciliationPreview` напрямую — она возвращает обогащённый
 * `reservedButUnavailable: Array<{equipmentUnitId, equipmentName, ordinalLabel, status}>`.
 *
 * Однако реальный HTTP-роут `apps/api/src/routes/warehouse.ts` строит
 * `res.json({...})` руками — то самое место, где в первой версии поле
 * пропустили, и фронтовая «⛔ Резерв недоступен» строка silently не
 * рендерилась. Этот тест ловит будущие регрессии в shape ответа.
 */

import path from "path";
import { execSync } from "child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-route-summary.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-route-summary";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-route-summary";
process.env.WAREHOUSE_SECRET = "test-warehouse-route-summary-1";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-route-summary-min16char";

let app: any;
let prisma: any;
let warehouseToken: string;
let sessionId: string;
let maintenanceUnitId: string;

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
    data: { name: "Тест summary route", pinHash, isActive: true },
  });

  const authRes = await request(app)
    .post("/api/warehouse/auth")
    .send({ name: "Тест summary route", pin: "1234" });
  warehouseToken = authRes.body.token;

  const client = await prisma.client.create({
    data: { name: "Route summary клиент", phone: "+70000000444" },
  });

  const equipment = await prisma.equipment.create({
    data: {
      importKey: "route-summary-skypanel",
      name: "SkyPanel S60",
      category: "Свет",
      rentalRatePerShift: 1000,
      stockTrackingMode: "UNIT",
    },
  });

  const unitAvailable = await prisma.equipmentUnit.create({
    data: { equipmentId: equipment.id, barcode: "RT-SUM-001", status: "AVAILABLE" },
  });
  const unitMaintenance = await prisma.equipmentUnit.create({
    data: { equipmentId: equipment.id, barcode: "RT-SUM-002", status: "MAINTENANCE" },
  });
  maintenanceUnitId = unitMaintenance.id;

  const booking = await prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: "Route-summary smoke",
      startDate: new Date(),
      endDate: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
      status: "CONFIRMED",
      amountPaid: 0,
      amountOutstanding: 0,
    },
  });

  const bi = await prisma.bookingItem.create({
    data: { bookingId: booking.id, equipmentId: equipment.id, quantity: 2 },
  });
  await prisma.bookingItemUnit.create({
    data: { bookingItemId: bi.id, equipmentUnitId: unitAvailable.id },
  });
  await prisma.bookingItemUnit.create({
    data: { bookingItemId: bi.id, equipmentUnitId: unitMaintenance.id },
  });

  const session = await prisma.scanSession.create({
    data: {
      bookingId: booking.id,
      workerName: "Тест summary route",
      operation: "ISSUE",
      status: "ACTIVE",
    },
  });
  sessionId = session.id;
});

afterAll(async () => {
  await prisma?.$disconnect?.();
});

describe("GET /api/warehouse/sessions/:id/summary — response shape", () => {
  it("includes `reservedButUnavailable` with enriched units (name+ordinal+status)", async () => {
    const res = await request(app)
      .get(`/api/warehouse/sessions/${sessionId}/summary`)
      .set("Authorization", `Bearer ${warehouseToken}`);

    expect(res.status).toBe(200);
    // Контрактный регресс-гард: поле обязательно присутствует и обогащено.
    expect(res.body.reservedButUnavailable).toBeDefined();
    expect(Array.isArray(res.body.reservedButUnavailable)).toBe(true);
    expect(res.body.reservedButUnavailable).toHaveLength(1);
    expect(res.body.reservedButUnavailable[0]).toEqual({
      equipmentUnitId: maintenanceUnitId,
      equipmentName: "SkyPanel S60",
      ordinalLabel: "прибор 2 из 2",
      status: "MAINTENANCE",
    });

    // Базовые поля shape — на случай если кто-то их случайно выкинет.
    expect(res.body.sessionId).toBe(sessionId);
    expect(res.body.operation).toBe("ISSUE");
    expect(res.body).toHaveProperty("scannedCount");
    expect(res.body).toHaveProperty("expectedCount");
    expect(res.body).toHaveProperty("missingItems");
    expect(res.body).toHaveProperty("substitutedItems");
  });
});
