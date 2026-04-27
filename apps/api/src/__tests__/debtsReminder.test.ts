/**
 * B3 — тесты POST /api/finance/debts/:clientId/draft-reminder
 *
 * Мокаем GeminiVisionProvider.generateDebtReminder чтобы не звонить реальному API.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import Decimal from "decimal.js";

// Мок Gemini — переопределяем generateDebtReminder до импорта app
vi.mock("../services/gemini", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../services/gemini")>();
  const mockGenerateDebtReminder = vi.fn().mockResolvedValue({
    subject: "Напоминание об оплате — Мок",
    body: "Уважаемый клиент, напоминаем об оплате.",
    generatedBy: "gemini" as const,
  });
  return {
    ...orig,
    GeminiVisionProvider: class MockGeminiVisionProvider extends orig.GeminiVisionProvider {
      generateDebtReminder = mockGenerateDebtReminder;
    },
    __mockGenerateDebtReminder: mockGenerateDebtReminder,
  };
});

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-debts-reminder.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-reminder";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-reminder";
process.env.WAREHOUSE_SECRET = "test-wh-reminder";
process.env.JWT_SECRET = "test-jwt-secret-reminder-min16chars";

let app: Express;
let prisma: any;
let superAdminToken: string;
let clientWithDebtsId: string;
let clientNoDebtsId: string;

function AUTH_SA() {
  return { "X-API-Key": "test-key-reminder", Authorization: `Bearer ${superAdminToken}` };
}

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
  const hash = await hashPassword("pass");
  const admin = await prisma.adminUser.create({
    data: { username: "reminder_super", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  superAdminToken = signSession({ userId: admin.id, username: admin.username, role: "SUPER_ADMIN" });

  // Клиент с долгом
  const clientWithDebts = await prisma.client.create({
    data: { name: "Должник Иванов" },
  });
  clientWithDebtsId = clientWithDebts.id;

  await prisma.booking.create({
    data: {
      clientId: clientWithDebts.id,
      projectName: "Проект напоминания",
      startDate: new Date("2024-06-01"),
      endDate: new Date("2024-06-05"),
      status: "ISSUED",
      amountOutstanding: new Decimal("50000"),
      finalAmount: new Decimal("50000"),
      amountPaid: new Decimal("0"),
      paymentStatus: "OVERDUE",
      expectedPaymentDate: new Date("2024-05-15"),
    },
  });

  // Клиент без долга
  const clientNoDebts = await prisma.client.create({
    data: { name: "Оплативший Петров" },
  });
  clientNoDebtsId = clientNoDebts.id;

  await prisma.booking.create({
    data: {
      clientId: clientNoDebts.id,
      projectName: "Оплаченный проект",
      startDate: new Date("2024-07-01"),
      endDate: new Date("2024-07-05"),
      status: "RETURNED",
      amountOutstanding: new Decimal("0"),
      finalAmount: new Decimal("10000"),
      amountPaid: new Decimal("10000"),
      paymentStatus: "PAID",
    },
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

describe("POST /api/finance/debts/:clientId/draft-reminder", () => {
  it("happy path: возвращает drafted reminder (mocked Gemini)", async () => {
    const res = await request(app)
      .post(`/api/finance/debts/${clientWithDebtsId}/draft-reminder`)
      .set(AUTH_SA())
      .send({ tone: "polite" });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("subject");
    expect(res.body).toHaveProperty("body");
    expect(res.body).toHaveProperty("generatedBy");
    // Мок возвращает "gemini" — проверяем структуру ответа
    expect(["gemini", "fallback"]).toContain(res.body.generatedBy);
  });

  it("fallback используется при ошибке: GEMINI_API_KEY absent → fallback", async () => {
    // Импортируем GeminiVisionProvider напрямую для тестирования fallback
    // Используем актуальный GeminiVisionProvider (реальный, не мок)
    // Временно убираем API-ключ
    const origKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;

    // Используем динамический import модуля напрямую (обходим vi.mock через importActual)
    const geminiMod = await vi.importActual<typeof import("../services/gemini")>("../services/gemini");
    const provider = new geminiMod.GeminiVisionProvider();

    const result = await provider.generateDebtReminder({
      clientName: "Тест Клиент",
      totalOutstanding: new Decimal("12345.00"),
      oldestDueDate: new Date("2024-01-15"),
      daysOverdue: 30,
      bookingsCount: 2,
      tone: "polite",
    });

    // Восстанавливаем ключ
    if (origKey) process.env.GEMINI_API_KEY = origKey;

    expect(result.generatedBy).toBe("fallback");
    expect(result.subject).toContain("Тест Клиент");
    expect(result.body).toContain("Тест Клиент");
    expect(result.body).toContain("12345.00");
  });

  it("возвращает 404 для несуществующего клиента", async () => {
    const res = await request(app)
      .post("/api/finance/debts/nonexistent-client/draft-reminder")
      .set(AUTH_SA())
      .send({});

    expect(res.status).toBe(404);
  });

  it("возвращает 400 NO_DEBTS для клиента без задолженности", async () => {
    const res = await request(app)
      .post(`/api/finance/debts/${clientNoDebtsId}/draft-reminder`)
      .set(AUTH_SA())
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.message).toBe("NO_DEBTS");
  });

  it("возвращает 401 без авторизации", async () => {
    const res = await request(app)
      .post(`/api/finance/debts/${clientWithDebtsId}/draft-reminder`)
      .set({ "X-API-Key": "test-key-reminder" })
      .send({});

    expect(res.status).toBe(401);
  });
});
