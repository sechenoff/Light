/**
 * Матричные тесты роловой системы (design §6.1).
 *
 * Каждый кейс — запрос от конкретной роли → ожидаемый HTTP-статус.
 * Запросы выполняются через суперtest с JWT-сессией для нужной роли.
 *
 * NOTE: тесты 13-22 из дизайна (payments, expenses, repairs, audit)
 * покрываются в Sprint 3/4. В Sprint 1 тестируем роуты, существующие сейчас.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-rolesgated.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-roles,openclaw-testbot123";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-roles-guard";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-roles";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-secret-roles-guard-min-16chars";

let app: Express;
let prisma: any;

// Токены для каждой роли
let superAdminToken: string;
let warehouseToken: string;
let technicianToken: string;

// Созданная тестовая бронь
let bookingId: string;
// Созданное оборудование
let equipmentId: string;

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

  // Создаём пользователей трёх ролей
  const { hashPassword, signSession } = await import("../services/auth");
  const hash = await hashPassword("test-password-123");

  const superAdmin = await prisma.adminUser.create({
    data: { username: "super_admin_test", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  const warehouse = await prisma.adminUser.create({
    data: { username: "warehouse_test", passwordHash: hash, role: "WAREHOUSE" },
  });
  const technician = await prisma.adminUser.create({
    data: { username: "technician_test", passwordHash: hash, role: "TECHNICIAN" },
  });

  superAdminToken = signSession({ userId: superAdmin.id, username: superAdmin.username, role: "SUPER_ADMIN" });
  warehouseToken = signSession({ userId: warehouse.id, username: warehouse.username, role: "WAREHOUSE" });
  technicianToken = signSession({ userId: technician.id, username: technician.username, role: "TECHNICIAN" });

  // Создаём оборудование и бронь для тестов DELETE
  const equipment = await prisma.equipment.create({
    data: {
      importKey: "TEST||LIGHT_ROLES",
      name: "Тестовый прожектор",
      category: "Свет",
      totalQuantity: 2,
      stockTrackingMode: "COUNT",
      rentalRatePerShift: "1000",
    },
  });
  equipmentId = equipment.id;

  const client = await prisma.client.create({ data: { name: "Тестовый клиент роли" } });
  const booking = await prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: "Тестовый проект ролей",
      startDate: new Date("2026-05-01T10:00:00.000Z"),
      endDate: new Date("2026-05-03T10:00:00.000Z"),
      status: "DRAFT",
      items: {
        create: [{ equipmentId: equipment.id, quantity: 1 }],
      },
    },
  });
  bookingId = booking.id;
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

// ──────────────────────────────────────────────────────────────────
// Helper
// ──────────────────────────────────────────────────────────────────

const apiKey = { "X-API-Key": "test-key-roles" };

function authHeaders(token: string) {
  return { ...apiKey, "Authorization": `Bearer ${token}` };
}

// ──────────────────────────────────────────────────────────────────
// Кейс 1: SUPER_ADMIN → GET /api/bookings → 200
// ──────────────────────────────────────────────────────────────────
describe("Role matrix: /api/bookings", () => {
  it("1. SUPER_ADMIN → GET /api/bookings → 200", async () => {
    const res = await request(app)
      .get("/api/bookings")
      .set(authHeaders(superAdminToken));
    expect(res.status).toBe(200);
  });

  it("2. WAREHOUSE → GET /api/bookings → 200", async () => {
    const res = await request(app)
      .get("/api/bookings")
      .set(authHeaders(warehouseToken));
    expect(res.status).toBe(200);
  });

  it("3. TECHNICIAN → GET /api/bookings → 403 FORBIDDEN_BY_ROLE", async () => {
    const res = await request(app)
      .get("/api/bookings")
      .set(authHeaders(technicianToken));
    expect(res.status).toBe(403);
    expect(res.body.details).toBe("FORBIDDEN_BY_ROLE");
  });

  it("4. WAREHOUSE → DELETE /api/bookings/:id → 403", async () => {
    const res = await request(app)
      .delete(`/api/bookings/${bookingId}`)
      .set(authHeaders(warehouseToken));
    expect(res.status).toBe(403);
    expect(res.body.details).toBe("FORBIDDEN_BY_ROLE");
  });

  it("5. SUPER_ADMIN → DELETE /api/bookings/:id → 200", async () => {
    // Создаём отдельную бронь для удаления
    const client2 = await prisma.client.create({ data: { name: "Клиент для удаления" } });
    const toDelete = await prisma.booking.create({
      data: {
        clientId: client2.id,
        projectName: "Для удаления",
        startDate: new Date("2026-06-01T10:00:00.000Z"),
        endDate: new Date("2026-06-02T10:00:00.000Z"),
        status: "DRAFT",
      },
    });
    const res = await request(app)
      .delete(`/api/bookings/${toDelete.id}`)
      .set(authHeaders(superAdminToken));
    expect(res.status).toBe(200);
  });
});

// ──────────────────────────────────────────────────────────────────
// Кейс 6-9: /api/equipment
// ──────────────────────────────────────────────────────────────────
describe("Role matrix: /api/equipment", () => {
  it("6. TECHNICIAN → GET /api/equipment → 200", async () => {
    const res = await request(app)
      .get("/api/equipment")
      .set(authHeaders(technicianToken));
    expect(res.status).toBe(200);
  });

  it("7. TECHNICIAN → POST /api/equipment → 403", async () => {
    const res = await request(app)
      .post("/api/equipment")
      .set(authHeaders(technicianToken))
      .send({
        category: "Свет",
        name: "Запрещённый прожектор",
        totalQuantity: 1,
        stockTrackingMode: "COUNT",
        rentalRatePerShift: 500,
      });
    expect(res.status).toBe(403);
    expect(res.body.details).toBe("FORBIDDEN_BY_ROLE");
  });

  it("8. WAREHOUSE → POST /api/equipment → 200", async () => {
    const res = await request(app)
      .post("/api/equipment")
      .set(authHeaders(warehouseToken))
      .send({
        category: "Свет",
        name: "Прожектор от кладовщика",
        totalQuantity: 1,
        stockTrackingMode: "COUNT",
        rentalRatePerShift: 500,
      });
    expect(res.status).toBe(200);
  });

  it("9. WAREHOUSE → PATCH /api/equipment/:id (price change) → 403", async () => {
    const res = await request(app)
      .patch(`/api/equipment/${equipmentId}`)
      .set(authHeaders(warehouseToken))
      .send({ rentalRatePerShift: 9999 });
    expect(res.status).toBe(403);
    expect(res.body.details).toBe("FORBIDDEN_BY_ROLE");
  });
});

// ──────────────────────────────────────────────────────────────────
// Кейс 10-12: /api/finance
// ──────────────────────────────────────────────────────────────────
describe("Role matrix: /api/finance", () => {
  it("10. WAREHOUSE → GET /api/finance/dashboard → 403", async () => {
    const res = await request(app)
      .get("/api/finance/dashboard")
      .set(authHeaders(warehouseToken));
    expect(res.status).toBe(403);
    expect(res.body.details).toBe("FORBIDDEN_BY_ROLE");
  });

  it("11. SUPER_ADMIN → GET /api/finance/dashboard → 200", async () => {
    const res = await request(app)
      .get("/api/finance/dashboard")
      .set(authHeaders(superAdminToken));
    expect(res.status).toBe(200);
  });

  it("12. TECHNICIAN → GET /api/finance/debts → 403", async () => {
    const res = await request(app)
      .get("/api/finance/debts")
      .set(authHeaders(technicianToken));
    expect(res.status).toBe(403);
    expect(res.body.details).toBe("FORBIDDEN_BY_ROLE");
  });
});

// ──────────────────────────────────────────────────────────────────
// Кейс 13-16: /api/payments и /api/expenses (placeholder — Sprint 3)
// В Sprint 1 тестируем что 404 (роут ещё не создан) или 403.
// ──────────────────────────────────────────────────────────────────
describe("Role matrix: /api/payments (Sprint 3 routes)", () => {
  it("13. SUPER_ADMIN → POST /api/payments → не 403 (роут Sprint 3, статус 404)", async () => {
    const res = await request(app)
      .post("/api/payments")
      .set(authHeaders(superAdminToken))
      .send({});
    // В Sprint 1 роут не создан → 404. Главное — не 403 FORBIDDEN_BY_ROLE
    expect(res.status).not.toBe(403);
  });

  it("14. WAREHOUSE → POST /api/payments → не реализован в Sprint 1", async () => {
    const res = await request(app)
      .post("/api/payments")
      .set(authHeaders(warehouseToken))
      .send({});
    // В Sprint 1 роут не создан → не заботимся о статусе, просто не падаем с 500
    expect(res.status).not.toBe(500);
  });
});

describe("Role matrix: /api/expenses (Sprint 3 routes)", () => {
  it("15. TECHNICIAN → POST /api/expenses → не реализован в Sprint 1", async () => {
    const res = await request(app)
      .post("/api/expenses")
      .set(authHeaders(technicianToken))
      .send({ category: "REPAIR" });
    expect(res.status).not.toBe(500);
  });

  it("16. TECHNICIAN → POST /api/expenses с RENT → Sprint 3 (placeholder)", async () => {
    const res = await request(app)
      .post("/api/expenses")
      .set(authHeaders(technicianToken))
      .send({ category: "RENT" });
    expect(res.status).not.toBe(500);
  });
});

// ──────────────────────────────────────────────────────────────────
// Кейс 17-20: /api/repairs (Sprint 4 routes)
// ──────────────────────────────────────────────────────────────────
describe("Role matrix: /api/repairs (Sprint 4 routes)", () => {
  it("17. TECHNICIAN → POST /api/repairs/:id/work-log → Sprint 4 placeholder", async () => {
    const res = await request(app)
      .post("/api/repairs/nonexistent/work-log")
      .set(authHeaders(technicianToken))
      .send({});
    expect(res.status).not.toBe(500);
  });

  it("18. WAREHOUSE → POST /api/repairs/:id/close → Sprint 4 placeholder", async () => {
    const res = await request(app)
      .post("/api/repairs/nonexistent/close")
      .set(authHeaders(warehouseToken))
      .send({});
    expect(res.status).not.toBe(500);
  });

  it("19. SUPER_ADMIN → POST /api/repairs/:id/write-off → Sprint 4 placeholder", async () => {
    const res = await request(app)
      .post("/api/repairs/nonexistent/write-off")
      .set(authHeaders(superAdminToken))
      .send({});
    expect(res.status).not.toBe(500);
  });
});

// ──────────────────────────────────────────────────────────────────
// Кейс 20: /api/bookings/:id/backdate — только SUPER_ADMIN
// ──────────────────────────────────────────────────────────────────
describe("Role matrix: /api/bookings/:id/backdate", () => {
  it("20. SUPER_ADMIN → PATCH /api/bookings/:id/backdate → 200", async () => {
    const res = await request(app)
      .patch(`/api/bookings/${bookingId}/backdate`)
      .set(authHeaders(superAdminToken))
      .send({
        startDate: "2026-05-02T10:00:00",
        endDate: "2026-05-04T10:00:00",
        reason: "Тест изменения дат задним числом",
      });
    expect(res.status).toBe(200);
    expect(res.body.booking).toBeDefined();
  });

  it("WAREHOUSE → PATCH /api/bookings/:id/backdate → 403", async () => {
    const res = await request(app)
      .patch(`/api/bookings/${bookingId}/backdate`)
      .set(authHeaders(warehouseToken))
      .send({
        startDate: "2026-05-02T10:00:00",
        endDate: "2026-05-04T10:00:00",
        reason: "Попытка от кладовщика",
      });
    expect(res.status).toBe(403);
    expect(res.body.details).toBe("FORBIDDEN_BY_ROLE");
  });
});

// ──────────────────────────────────────────────────────────────────
// Кейс 21-22: /api/audit (Sprint 2 routes)
// ──────────────────────────────────────────────────────────────────
describe("Role matrix: /api/audit (Sprint 2 routes)", () => {
  it("21. WAREHOUSE → GET /api/audit → не реализован в Sprint 1", async () => {
    const res = await request(app)
      .get("/api/audit")
      .set(authHeaders(warehouseToken));
    // Sprint 2 route — в Sprint 1 возвращает 404
    expect(res.status).not.toBe(500);
  });

  it("22. SUPER_ADMIN → GET /api/audit → не реализован в Sprint 1", async () => {
    const res = await request(app)
      .get("/api/audit")
      .set(authHeaders(superAdminToken));
    expect(res.status).not.toBe(500);
  });
});

// ──────────────────────────────────────────────────────────────────
// Дополнительные тесты: botAccess bypass
// ──────────────────────────────────────────────────────────────────
describe("botAccess bypass", () => {
  it("openclaw-ключ на /api/bookings GET → 200 (botAccess bypass)", async () => {
    const res = await request(app)
      .get("/api/bookings")
      .set("X-API-Key", "openclaw-testbot123");

    // Бот-ключ должен проходить через botScopeGuard → req.botAccess=true → rolesGuard skip
    // GET /api/bookings есть в BOT_WHITELIST, нет сессии → rolesGuard пропускает
    expect(res.status).toBe(200);
  });
});
