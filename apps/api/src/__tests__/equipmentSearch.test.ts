/**
 * Регрессия eq-search: поиск каталога по кириллице должен быть регистронезависимым.
 *
 * SQLite LIKE регистронезависим только для ASCII — «штатив» не находил «Штатив».
 * Фикс: фильтрация в приложении через toLocaleLowerCase("ru-RU") (паттерн availability.ts).
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-equipment-search.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-eq-search";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-eq-search";
process.env.JWT_SECRET = "test-jwt-secret-eq-search-min16";

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
      {
        importKey: "eq-search-1",
        sortOrder: 0,
        category: "Штативы",
        name: "Штатив Avenger C-STAND",
        totalQuantity: 5,
        rentalRatePerShift: "500.00",
      },
      {
        importKey: "eq-search-2",
        sortOrder: 1,
        category: "Свет",
        name: "SkyPanel S60-C",
        brand: "ARRI",
        totalQuantity: 2,
        rentalRatePerShift: "9000.00",
      },
      {
        importKey: "eq-search-3",
        sortOrder: 2,
        category: "Свет",
        name: "Генератор дым-машины",
        model: "FOG-1500",
        totalQuantity: 1,
        rentalRatePerShift: "1500.00",
      },
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

describe("GET /api/equipment?search= — регистронезависимый кириллический поиск", () => {
  it("строчная «штатив» находит «Штатив Avenger C-STAND»", async () => {
    const res = await request(app).get("/api/equipment?search=штатив").set(AUTH());
    expect(res.status).toBe(200);
    const names = res.body.equipments.map((e: any) => e.name);
    expect(names).toContain("Штатив Avenger C-STAND");
    expect(names).not.toContain("SkyPanel S60-C");
  });

  it("ЗАГЛАВНАЯ «ГЕНЕРАТОР» находит «Генератор дым-машины» (по name)", async () => {
    const res = await request(app).get("/api/equipment?search=ГЕНЕРАТОР").set(AUTH());
    expect(res.status).toBe(200);
    const names = res.body.equipments.map((e: any) => e.name);
    expect(names).toEqual(["Генератор дым-машины"]);
  });

  it("латиница осталась регистронезависимой: «arri» находит бренд ARRI", async () => {
    const res = await request(app).get("/api/equipment?search=arri").set(AUTH());
    expect(res.status).toBe(200);
    const names = res.body.equipments.map((e: any) => e.name);
    expect(names).toEqual(["SkyPanel S60-C"]);
  });

  it("поиск по model: «fog» находит FOG-1500", async () => {
    const res = await request(app).get("/api/equipment?search=fog").set(AUTH());
    expect(res.status).toBe(200);
    const names = res.body.equipments.map((e: any) => e.name);
    expect(names).toEqual(["Генератор дым-машины"]);
  });

  it("пустой search возвращает весь каталог", async () => {
    const res = await request(app).get("/api/equipment").set(AUTH());
    expect(res.status).toBe(200);
    expect(res.body.equipments.length).toBe(3);
  });

  it("несуществующий запрос → пустой список (не ошибка)", async () => {
    const res = await request(app).get("/api/equipment?search=камера").set(AUTH());
    expect(res.status).toBe(200);
    expect(res.body.equipments).toEqual([]);
  });
});
