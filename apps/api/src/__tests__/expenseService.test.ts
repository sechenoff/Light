/**
 * Интеграционные тесты expenseService
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-expense-service.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-expense-svc";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-expense-svc";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-expense-svc";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-secret-expense-svc-min16chars";

let prisma: any;
let superAdminId: string;
let technicianId: string;
let warehouseId: string;

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

  const { hashPassword } = await import("../services/auth");
  const hash = await hashPassword("test-pass-123");

  const superAdmin = await prisma.adminUser.create({
    data: { username: "expense_super_admin", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  superAdminId = superAdmin.id;

  const technician = await prisma.adminUser.create({
    data: { username: "expense_technician", passwordHash: hash, role: "TECHNICIAN" },
  });
  technicianId = technician.id;

  const warehouse = await prisma.adminUser.create({
    data: { username: "expense_warehouse", passwordHash: hash, role: "WAREHOUSE" },
  });
  warehouseId = warehouse.id;
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

describe("createExpense", () => {
  it("TECHNICIAN создаёт REPAIR расход — approved=false, нет ошибки", async () => {
    const { createExpense } = await import("../services/expenseService");
    const expense = await createExpense({
      date: new Date("2026-05-01"),
      category: "REPAIR",
      amount: "1500",
      description: "Замена лампы",
      createdBy: technicianId,
      creatorRole: "TECHNICIAN",
    });

    expect(expense.id).toBeTruthy();
    expect(expense.approved).toBe(false);
    expect(expense.category).toBe("REPAIR");
    expect(expense.name).toBe("Замена лампы"); // legacy backfill
  });

  it("TECHNICIAN создаёт RENT расход — ошибка 403 EXPENSE_CATEGORY_FORBIDDEN", async () => {
    const { createExpense } = await import("../services/expenseService");
    await expect(
      createExpense({
        date: new Date("2026-05-01"),
        category: "RENT",
        amount: "5000",
        description: "Аренда склада",
        createdBy: technicianId,
        creatorRole: "TECHNICIAN",
      }),
    ).rejects.toMatchObject({ status: 403, details: "EXPENSE_CATEGORY_FORBIDDEN" });
  });

  it("SUPER_ADMIN создаёт RENT расход — approved=true", async () => {
    const { createExpense } = await import("../services/expenseService");
    const expense = await createExpense({
      date: new Date("2026-05-01"),
      category: "RENT",
      amount: "20000",
      description: "Аренда помещения",
      createdBy: superAdminId,
      creatorRole: "SUPER_ADMIN",
    });

    expect(expense.approved).toBe(true);
    expect(expense.category).toBe("RENT");
  });
});

describe("approveExpense", () => {
  it("approveExpense флипает approved=true и пишет аудит", async () => {
    const { approveExpense } = await import("../services/expenseService");

    // Напрямую создаём неодобренный расход
    const expense = await prisma.expense.create({
      data: {
        category: "TRANSPORT",
        amount: "3000",
        name: "Доставка оборудования",
        expenseDate: new Date("2026-05-02"),
        approved: false,
        createdBy: technicianId,
      },
    });

    const approved = await approveExpense(expense.id, superAdminId);
    expect(approved.approved).toBe(true);

    const auditEntry = await prisma.auditEntry.findFirst({
      where: { action: "EXPENSE_APPROVE", entityType: "Expense", entityId: expense.id },
    });
    expect(auditEntry).toBeTruthy();
  });

  it("повторный вызов approveExpense → 409 EXPENSE_ALREADY_APPROVED", async () => {
    const { createExpense, approveExpense } = await import("../services/expenseService");

    const expense = await createExpense({
      date: new Date("2026-05-02"),
      category: "PURCHASE",
      amount: "5000",
      description: "Закупка расходников",
      createdBy: superAdminId,
      creatorRole: "SUPER_ADMIN",
    });

    // Already approved=true
    await expect(approveExpense(expense.id, superAdminId)).rejects.toMatchObject({
      status: 409,
      details: "EXPENSE_ALREADY_APPROVED",
    });
  });
});

describe("listExpenses", () => {
  it("approvedOnly=true возвращает только одобренные расходы", async () => {
    const { listExpenses } = await import("../services/expenseService");

    const result = await listExpenses({ approvedOnly: true });

    expect(result.total).toBeGreaterThan(0);
    expect(result.items.every((e: any) => e.approved === true)).toBe(true);
  });
});
