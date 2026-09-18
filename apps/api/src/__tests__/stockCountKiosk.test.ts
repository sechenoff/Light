/**
 * Инвентаризация с киоска склада (/api/warehouse/stock-count*).
 *
 * Кладовщик по PIN только СЧИТАЕТ: читает идущую инвентаризацию и её строки,
 * пишет счёт и «Пересчитать». Решения, завершение и отмена — десктоп
 * (/api/stock-counts), куда PIN-токен не пускает: он не сессия сотрудника.
 * Основная сессия SA/WH проходит в киоск через fallback warehouseAuth.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-stock-count-kiosk.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-stock-kiosk";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-stock-kiosk";
process.env.WAREHOUSE_SECRET = "test-warehouse-stock-kiosk-secret";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-secret-stock-kiosk-min16chars";

let app: Express;
let prisma: any;

let pinToken: string;
let saToken: string;
let whToken: string;
let techToken: string;
let stockCountId: string;
let lineId: string;
let equipmentId: string;

const apiKey = { "X-API-Key": "test-key-stock-kiosk" };
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

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

  app = (await import("../app")).app;
  prisma = (await import("../prisma")).prisma;

  const { hashPassword, signSession } = await import("../services/auth");
  const { generateToken } = await import("../services/warehouseAuth");
  const hash = await hashPassword("stock-kiosk-pass");
  const sa = await prisma.adminUser.create({ data: { username: "kiosk_super", passwordHash: hash, role: "SUPER_ADMIN" } });
  const wh = await prisma.adminUser.create({ data: { username: "kiosk_warehouse", passwordHash: hash, role: "WAREHOUSE" } });
  const tech = await prisma.adminUser.create({ data: { username: "kiosk_tech", passwordHash: hash, role: "TECHNICIAN" } });
  saToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });
  whToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });
  techToken = signSession({ userId: tech.id, username: tech.username, role: "TECHNICIAN" });
  pinToken = generateToken("Иван Кладовщик");

  const equipment = await prisma.equipment.create({
    data: {
      importKey: "kiosk-eq-1",
      name: "Кабель 10 м",
      category: "Коммутация",
      totalQuantity: 12,
      rentalRatePerShift: "150",
      stockTrackingMode: "COUNT",
    },
  });
  equipmentId = equipment.id;
  await prisma.equipment.create({
    data: {
      importKey: "kiosk-eq-2",
      name: "Тройник",
      category: "Коммутация",
      totalQuantity: 4,
      rentalRatePerShift: "50",
      stockTrackingMode: "COUNT",
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const f = TEST_DB_PATH + suffix;
    if (fs.existsSync(f)) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }
});

describe("киоск: инвентаризация по PIN", () => {
  it("без идущей инвентаризации — stockCount: null", async () => {
    const res = await request(app).get("/api/warehouse/stock-count").set(bearer(pinToken));
    expect(res.status).toBe(200);
    expect(res.body.stockCount).toBeNull();
  });

  it("без авторизации склада → 401; техник основной сессией → 401", async () => {
    expect((await request(app).get("/api/warehouse/stock-count")).status).toBe(401);
    expect((await request(app).get("/api/warehouse/stock-count").set(bearer(techToken))).status).toBe(401);
  });

  it("PIN-токен читает идущую инвентаризацию и её строки", async () => {
    const started = await request(app).post("/api/stock-counts").set({ ...apiKey, ...bearer(saToken) }).send({});
    expect(started.status).toBe(201);
    stockCountId = started.body.stockCount.id;

    const res = await request(app).get("/api/warehouse/stock-count").set(bearer(pinToken));
    expect(res.status).toBe(200);
    expect(res.body.stockCount.id).toBe(stockCountId);
    expect(res.body.stockCount.totals.lines).toBe(2);

    const lines = await request(app)
      .get(`/api/warehouse/stock-count/${stockCountId}/lines?category=${encodeURIComponent("Коммутация")}`)
      .set(bearer(pinToken));
    expect(lines.status).toBe(200);
    expect(lines.body.lines).toHaveLength(2);
    const cable = lines.body.lines.find((l: any) => l.equipmentId === equipmentId);
    expect(cable.expected.expected).toBe(12);
    lineId = cable.id;
    expect(JSON.stringify(lines.body)).not.toMatch(/barcode/i);

    // Пустой ?category= — все категории, а не 400.
    const all = await request(app).get(`/api/warehouse/stock-count/${stockCountId}/lines?category=`).set(bearer(pinToken));
    expect(all.status).toBe(200);
    expect(all.body.lines).toHaveLength(2);
  });

  it("PIN-токен считает: countedBy = имя кладовщика", async () => {
    const res = await request(app)
      .post(`/api/warehouse/stock-count/${stockCountId}/lines/${lineId}/count`)
      .set(bearer(pinToken))
      .send({ qty: 10 });
    expect(res.status).toBe(200);
    expect(res.body.line).toMatchObject({ countedQty: 10, countedBy: "Иван Кладовщик", diff: -2 });

    // Счёт не пишет аудит: имя кладовщика — не AdminUser.id.
    expect(await prisma.auditEntry.count({ where: { entityType: "StockCount", action: { not: "STOCK_COUNT_START" } } })).toBe(0);
  });

  it("невалидное количество и чужая строка — отказ", async () => {
    const bad = await request(app)
      .post(`/api/warehouse/stock-count/${stockCountId}/lines/${lineId}/count`)
      .set(bearer(pinToken))
      .send({ qty: -3 });
    expect(bad.status).toBe(400);
    const missing = await request(app)
      .post(`/api/warehouse/stock-count/${stockCountId}/lines/no-such-line/count`)
      .set(bearer(pinToken))
      .send({ qty: 1 });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("LINE_NOT_FOUND");
  });

  it("PIN-токен не решает, не завершает и не отменяет (десктоп требует сессию)", async () => {
    const headers = { ...apiKey, ...bearer(pinToken) };
    const decision = await request(app)
      .post(`/api/stock-counts/${stockCountId}/lines/${lineId}/decision`)
      .set(headers)
      .send({ decision: "ADJUST", note: "попытка с киоска" });
    expect(decision.status).toBe(401);
    const complete = await request(app).post(`/api/stock-counts/${stockCountId}/complete`).set(headers);
    expect(complete.status).toBe(401);
    const cancel = await request(app).post(`/api/stock-counts/${stockCountId}/cancel`).set(headers);
    expect(cancel.status).toBe(401);

    const line = await prisma.stockCountLine.findUnique({ where: { id: lineId } });
    expect(line.decision).toBeNull();
    const sc = await prisma.stockCount.findUnique({ where: { id: stockCountId } });
    expect(sc.status).toBe("OPEN");
  });

  it("PIN-токен «Пересчитать» — строка снова не посчитана", async () => {
    const res = await request(app)
      .post(`/api/warehouse/stock-count/${stockCountId}/lines/${lineId}/reset`)
      .set(bearer(pinToken));
    expect(res.status).toBe(200);
    expect(res.body.line).toMatchObject({ countedQty: null, countedBy: null, diff: null });
  });

  it("основная сессия WAREHOUSE считает в киоске под своим логином", async () => {
    const res = await request(app)
      .post(`/api/warehouse/stock-count/${stockCountId}/lines/${lineId}/count`)
      .set(bearer(whToken))
      .send({ qty: 12 });
    expect(res.status).toBe(200);
    expect(res.body.line).toMatchObject({ countedQty: 12, countedBy: "kiosk_warehouse", diff: 0 });
  });

  it("после отмены на десктопе киоск видит null и считать не может", async () => {
    const cancel = await request(app)
      .post(`/api/stock-counts/${stockCountId}/cancel`)
      .set({ ...apiKey, ...bearer(whToken) });
    expect(cancel.status).toBe(200);

    const active = await request(app).get("/api/warehouse/stock-count").set(bearer(pinToken));
    expect(active.body.stockCount).toBeNull();

    const res = await request(app)
      .post(`/api/warehouse/stock-count/${stockCountId}/lines/${lineId}/count`)
      .set(bearer(pinToken))
      .send({ qty: 5 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("STOCK_COUNT_NOT_OPEN");
  });
});
