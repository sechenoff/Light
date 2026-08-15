/**
 * GET /api/equipment/categories отдаёт счётчики позиций рядом с названиями —
 * без них список категорий в тулбаре каталога остаётся просто фильтром, а не
 * картой склада. Посчитать их на клиенте нельзя: при активном ?category=
 * сервер уже отдаёт урезанную выборку.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-equipment-cat-counts.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-eq-cat";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-eq-cat";
process.env.JWT_SECRET = "test-jwt-secret-eq-cat-min16chars";

let app: Express;
let prisma: any;

const AUTH = () => ({ "X-API-Key": "test-key-1" });

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

  await prisma.equipment.createMany({
    data: [
      { importKey: "cat-1", sortOrder: 0, category: "Грип", name: "C-STAND", totalQuantity: 5, rentalRatePerShift: "500.00" },
      { importKey: "cat-2", sortOrder: 1, category: "Грип", name: "Струбцина", totalQuantity: 9, rentalRatePerShift: "200.00" },
      { importKey: "cat-3", sortOrder: 2, category: "Грип", name: "Магик-рука", totalQuantity: 3, rentalRatePerShift: "300.00" },
      { importKey: "cat-4", sortOrder: 3, category: "COB Light", name: "Aputure 600d", totalQuantity: 4, rentalRatePerShift: "8000.00" },
      // Разное написание одной категории — в списке это две отдельные строки
      // (getMergedCategoryOrder берёт raw-distinct), счётчики тоже раздельные.
      { importKey: "cat-5", sortOrder: 4, category: " грип ", name: "Флажок", totalQuantity: 2, rentalRatePerShift: "150.00" },
      { importKey: "cat-6", sortOrder: 5, category: "Транспорт", name: "Газель", totalQuantity: 1, rentalRatePerShift: "12000.00" },
    ],
  });
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

describe("GET /api/equipment/categories — счётчики позиций", () => {
  it("отдаёт counts на каждую категорию из списка", async () => {
    const res = await request(app).get("/api/equipment/categories").set(AUTH());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.categories)).toBe(true);
    expect(res.body.counts).toBeTruthy();

    // Ключи counts покрывают весь список ровно один в один — иначе в UI
    // у части категорий молча нарисуется 0.
    expect(Object.keys(res.body.counts).sort()).toEqual([...res.body.categories].sort());
  });

  it("варианты написания («Грип» и « грип ») считаются раздельно — как и фильтрует ?category=", async () => {
    // Соблазн сложить их в одно число ломает главный инвариант: фильтр идёт
    // точным равенством, и «4» под строкой « грип » обещало бы вчетверо
    // больше, чем придёт по клику.
    const res = await request(app).get("/api/equipment/categories").set(AUTH());
    const gripKeys = (res.body.categories as string[]).filter(
      (c) => c.trim().toLocaleLowerCase("ru-RU") === "грип",
    );
    expect(gripKeys).toHaveLength(2);
    expect(res.body.counts["Грип"]).toBe(3);
    expect(res.body.counts[" грип "]).toBe(1);
  });

  it("сумма counts равна общему числу позиций каталога", async () => {
    const [cats, all] = await Promise.all([
      request(app).get("/api/equipment/categories").set(AUTH()),
      request(app).get("/api/equipment").set(AUTH()),
    ]);
    const sum = Object.values(cats.body.counts as Record<string, number>).reduce(
      (acc, n) => acc + n,
      0,
    );
    expect(sum).toBe(all.body.equipments.length);
  });

  it("counts согласован с фильтром ?category= — число совпадает с длиной выборки", async () => {
    const cats = await request(app).get("/api/equipment/categories").set(AUTH());
    const cob = (cats.body.categories as string[]).find((c) => c === "COB Light");
    expect(cob).toBeTruthy();

    const filtered = await request(app)
      .get(`/api/equipment?category=${encodeURIComponent(cob!)}`)
      .set(AUTH());
    expect(filtered.body.equipments.length).toBe(cats.body.counts[cob!]);
  });

  it("categories остаётся плоским массивом строк (обратная совместимость)", async () => {
    const res = await request(app).get("/api/equipment/categories").set(AUTH());
    for (const c of res.body.categories) {
      expect(typeof c).toBe("string");
    }
    // «Транспорт» по-прежнему замыкает порядок.
    expect(res.body.categories[res.body.categories.length - 1]).toBe("Транспорт");
  });
});
