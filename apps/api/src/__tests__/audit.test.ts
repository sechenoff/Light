/**
 * Тесты сервиса аудита (design §6.5).
 *
 * Покрытие:
 * - writeAuditEntry пишет запись в БД.
 * - diffFields убирает вложенные relations (объекты с полем id).
 * - diffFields убирает массивы.
 * - Большой объект (> 10 KB) → обрезается до примитивов.
 * - writeAuditEntry с before/after → оба JSON сохраняются.
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-audit.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-audit";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-audit";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-audit";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-secret-audit-min-16chars";

let prisma: any;
let adminUserId: string;

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

  // Создаём AdminUser для аудита
  const { hashPassword } = await import("../services/auth");
  const hash = await hashPassword("audit-test-pass");
  const user = await prisma.adminUser.create({
    data: { username: "audit_tester", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  adminUserId = user.id;
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
// Импортируем после setup env
// ──────────────────────────────────────────────────────────────────

describe("writeAuditEntry", () => {
  it("записывает AuditEntry в БД для простого действия", async () => {
    const { writeAuditEntry } = await import("../services/audit");

    await writeAuditEntry({
      userId: adminUserId,
      action: "BOOKING_BACKDATE_EDIT",
      entityType: "Booking",
      entityId: "test-booking-123",
      before: { startDate: "2026-04-01", status: "CONFIRMED" },
      after: { startDate: "2026-04-02", status: "CONFIRMED" },
    });

    const entries = await prisma.auditEntry.findMany({
      where: { action: "BOOKING_BACKDATE_EDIT", entityId: "test-booking-123" },
    });

    expect(entries).toHaveLength(1);
    expect(entries[0].userId).toBe(adminUserId);
    expect(entries[0].entityType).toBe("Booking");
    expect(entries[0].entityId).toBe("test-booking-123");
    expect(entries[0].before).not.toBeNull();
    expect(entries[0].after).not.toBeNull();

    const before = JSON.parse(entries[0].before!);
    expect(before.startDate).toBe("2026-04-01");

    const after = JSON.parse(entries[0].after!);
    expect(after.startDate).toBe("2026-04-02");
  });

  it("записывает AuditEntry с before=null и after=obj для CREATE", async () => {
    const { writeAuditEntry } = await import("../services/audit");

    await writeAuditEntry({
      userId: adminUserId,
      action: "PAYMENT_CREATE",
      entityType: "Payment",
      entityId: "test-payment-1",
      before: null,
      after: { amount: "5000.00", method: "CASH" },
    });

    const entry = await prisma.auditEntry.findFirst({
      where: { action: "PAYMENT_CREATE", entityId: "test-payment-1" },
    });

    expect(entry).not.toBeNull();
    expect(entry!.before).toBeNull();
    expect(entry!.after).not.toBeNull();

    const after = JSON.parse(entry!.after!);
    expect(after.amount).toBe("5000.00");
  });

  it("записывает AuditEntry с after=null для DELETE", async () => {
    const { writeAuditEntry } = await import("../services/audit");

    await writeAuditEntry({
      userId: adminUserId,
      action: "PAYMENT_DELETE",
      entityType: "Payment",
      entityId: "test-payment-deleted",
      before: { amount: "1000.00", method: "CARD" },
      after: null,
    });

    const entry = await prisma.auditEntry.findFirst({
      where: { action: "PAYMENT_DELETE", entityId: "test-payment-deleted" },
    });

    expect(entry).not.toBeNull();
    expect(entry!.before).not.toBeNull();
    expect(entry!.after).toBeNull();
  });
});

describe("diffFields", () => {
  it("убирает вложенные объекты с полем id (relations)", async () => {
    const { diffFields } = await import("../services/audit");

    const obj = {
      id: "booking-1",
      status: "CONFIRMED",
      client: { id: "client-1", name: "Иван" }, // relation — должна быть удалена
      amount: "5000.00",
    };

    const result = diffFields(obj);

    expect(result).not.toHaveProperty("client");
    expect(result.status).toBe("CONFIRMED");
    expect(result.amount).toBe("5000.00");
  });

  it("убирает массивы (relations-to-many)", async () => {
    const { diffFields } = await import("../services/audit");

    const obj = {
      id: "booking-2",
      status: "DRAFT",
      items: [{ id: "item-1" }, { id: "item-2" }], // массив — должен быть удалён
      projectName: "Тестовый проект",
    };

    const result = diffFields(obj);

    expect(result).not.toHaveProperty("items");
    expect(result.projectName).toBe("Тестовый проект");
  });

  it("сохраняет null-значения", async () => {
    const { diffFields } = await import("../services/audit");

    const obj = {
      id: "booking-3",
      comment: null,
      status: "DRAFT",
    };

    const result = diffFields(obj);

    expect(result.comment).toBeNull();
    expect(result.status).toBe("DRAFT");
  });

  it("большой объект > 10KB → обрезается до примитивов", async () => {
    const { diffFields } = await import("../services/audit");

    // Создаём объект > 10KB через большое строковое поле
    const bigString = "x".repeat(11 * 1024); // 11KB строка
    const obj: Record<string, unknown> = {
      id: "big-entity-1",
      status: "CONFIRMED",
      bigField: bigString,
      nestedObj: { someKey: "someValue" }, // не relation (нет поля id) — остаётся до truncation
      amount: "5000.00",
      count: 42,
      flag: true,
    };

    const result = diffFields(obj);

    // После усечения должны остаться только примитивы
    expect(typeof result.status).toBe("string");
    expect(typeof result.amount).toBe("string");
    expect(typeof result.count).toBe("number");
    expect(typeof result.flag).toBe("boolean");

    // Объект nestedObj должен быть убран (не примитив)
    expect(result).not.toHaveProperty("nestedObj");
  });

  it("малый объект не усекается", async () => {
    const { diffFields } = await import("../services/audit");

    const obj = {
      status: "CONFIRMED",
      amount: "1000.00",
      projectName: "Тест",
    };

    const result = diffFields(obj);

    // Все поля сохраняются
    expect(result.status).toBe("CONFIRMED");
    expect(result.amount).toBe("1000.00");
    expect(result.projectName).toBe("Тест");
  });
});
