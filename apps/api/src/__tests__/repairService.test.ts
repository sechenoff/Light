/**
 * Интеграционные тесты repairService
 * Sprint 4 — полный lifecycle ремонта
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-repair-service.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-repair-svc";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-repair-svc";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-repair-svc";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-secret-repair-svc-min16chars";

let prisma: any;
let superAdminId: string;
let technicianId: string;
let warehouseId: string;
let equipmentId: string;
let unitId: string;

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
  const hash = await hashPassword("test-pass-repair");

  const superAdmin = await prisma.adminUser.create({
    data: { username: "repair_super", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  superAdminId = superAdmin.id;

  const technician = await prisma.adminUser.create({
    data: { username: "repair_tech", passwordHash: hash, role: "TECHNICIAN" },
  });
  technicianId = technician.id;

  const warehouse = await prisma.adminUser.create({
    data: { username: "repair_warehouse", passwordHash: hash, role: "WAREHOUSE" },
  });
  warehouseId = warehouse.id;

  // Создаём оборудование и единицу
  const equipment = await prisma.equipment.create({
    data: {
      importKey: "repair-test-equipment-001",
      name: "Тестовый прибор",
      category: "Осветительные приборы",
      rentalRatePerShift: 500,
      stockTrackingMode: "UNIT",
    },
  });
  equipmentId = equipment.id;

  const unit = await prisma.equipmentUnit.create({
    data: {
      equipmentId,
      barcode: "TEST-001",
      status: "AVAILABLE",
    },
  });
  unitId = unit.id;
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

// ─────────────────────────────────────────────────────────────────────────────

describe("createRepair", () => {
  it("создаёт ремонт — статус WAITING_REPAIR, unit → MAINTENANCE, AuditEntry записана", async () => {
    const { createRepair } = await import("../services/repairService");

    const repair = await createRepair({
      unitId,
      reason: "Не включается",
      urgency: "NORMAL",
      createdBy: warehouseId,
    });

    expect(repair.status).toBe("WAITING_REPAIR");
    expect(repair.unitId).toBe(unitId);

    const unit = await prisma.equipmentUnit.findUnique({ where: { id: unitId } });
    expect(unit.status).toBe("MAINTENANCE");

    const audit = await prisma.auditEntry.findFirst({
      where: { entityType: "Repair", action: "REPAIR_CREATE", entityId: repair.id },
    });
    expect(audit).not.toBeNull();

    // Cleanup: вернём unit в AVAILABLE вручную и закроем ремонт для следующих тестов
    await prisma.repair.update({ where: { id: repair.id }, data: { status: "CLOSED", closedAt: new Date() } });
    await prisma.equipmentUnit.update({ where: { id: unitId }, data: { status: "AVAILABLE" } });
  });

  it("409 REPAIR_ACTIVE_EXISTS — вторая активная репейра на тот же unit", async () => {
    const { createRepair } = await import("../services/repairService");

    // Первая
    const repair1 = await createRepair({
      unitId,
      reason: "Первая поломка",
      urgency: "URGENT",
      createdBy: warehouseId,
    });

    // Вторая — должна упасть
    await expect(
      createRepair({
        unitId,
        reason: "Вторая поломка",
        urgency: "NORMAL",
        createdBy: warehouseId,
      }),
    ).rejects.toMatchObject({ status: 409, details: "REPAIR_ACTIVE_EXISTS" });

    // Cleanup
    await prisma.repair.update({ where: { id: repair1.id }, data: { status: "CLOSED", closedAt: new Date() } });
    await prisma.equipmentUnit.update({ where: { id: unitId }, data: { status: "AVAILABLE" } });
  });

  it("400 UNIT_RETIRED — нельзя создать ремонт на списанную единицу", async () => {
    const { createRepair } = await import("../services/repairService");

    // Создаём retired unit
    const retiredUnit = await prisma.equipmentUnit.create({
      data: { equipmentId, barcode: "RETIRED-001", status: "RETIRED" },
    });

    await expect(
      createRepair({
        unitId: retiredUnit.id,
        reason: "Списанная",
        urgency: "NORMAL",
        createdBy: warehouseId,
      }),
    ).rejects.toMatchObject({ status: 400, details: "UNIT_RETIRED" });

    await prisma.equipmentUnit.delete({ where: { id: retiredUnit.id } });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("assignRepair", () => {
  it("назначает технику — SUPER_ADMIN может назначить кому угодно", async () => {
    const { createRepair, assignRepair } = await import("../services/repairService");

    const repair = await createRepair({
      unitId,
      reason: "Назначение тест",
      urgency: "NORMAL",
      createdBy: warehouseId,
    });

    const updated = await assignRepair(repair.id, technicianId, superAdminId);
    expect(updated.assignedTo).toBe(technicianId);

    // Cleanup
    await prisma.repair.update({ where: { id: repair.id }, data: { status: "CLOSED", closedAt: new Date() } });
    await prisma.equipmentUnit.update({ where: { id: unitId }, data: { status: "AVAILABLE" } });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("setRepairStatus", () => {
  it("переводит из WAITING_REPAIR → IN_REPAIR", async () => {
    const { createRepair, setRepairStatus } = await import("../services/repairService");

    const repair = await createRepair({
      unitId,
      reason: "Статус тест",
      urgency: "NORMAL",
      createdBy: warehouseId,
    });

    const updated = await setRepairStatus(repair.id, "IN_REPAIR", technicianId);
    expect(updated.status).toBe("IN_REPAIR");

    // Cleanup
    await prisma.repair.update({ where: { id: repair.id }, data: { status: "CLOSED", closedAt: new Date() } });
    await prisma.equipmentUnit.update({ where: { id: unitId }, data: { status: "AVAILABLE" } });
  });

  it("400 REPAIR_ALREADY_CLOSED — нельзя менять статус CLOSED ремонта", async () => {
    const { createRepair, closeRepair, setRepairStatus } = await import("../services/repairService");

    const repair = await createRepair({
      unitId,
      reason: "Закрытый ремонт",
      urgency: "NORMAL",
      createdBy: warehouseId,
    });

    await closeRepair(repair.id, superAdminId);

    await expect(
      setRepairStatus(repair.id, "IN_REPAIR", technicianId),
    ).rejects.toMatchObject({ status: 400, details: "REPAIR_ALREADY_CLOSED" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("closeRepair", () => {
  it("полный lifecycle: create → IN_REPAIR → close → unit AVAILABLE", async () => {
    const { createRepair, setRepairStatus, closeRepair } = await import("../services/repairService");

    const repair = await createRepair({
      unitId,
      reason: "Полный цикл",
      urgency: "NORMAL",
      createdBy: warehouseId,
    });

    await setRepairStatus(repair.id, "IN_REPAIR", technicianId);
    const closed = await closeRepair(repair.id, superAdminId);

    expect(closed.status).toBe("CLOSED");
    expect(closed.closedAt).not.toBeNull();

    const unit = await prisma.equipmentUnit.findUnique({ where: { id: unitId } });
    expect(unit.status).toBe("AVAILABLE");

    const audit = await prisma.auditEntry.findFirst({
      where: { entityType: "Repair", action: "REPAIR_CLOSE", entityId: repair.id },
    });
    expect(audit).not.toBeNull();
  });

  it("400 REPAIR_ALREADY_CLOSED — повторное закрытие", async () => {
    const { createRepair, closeRepair } = await import("../services/repairService");

    const repair = await createRepair({
      unitId,
      reason: "Повторное закрытие",
      urgency: "NORMAL",
      createdBy: warehouseId,
    });

    await closeRepair(repair.id, superAdminId);

    await expect(
      closeRepair(repair.id, superAdminId),
    ).rejects.toMatchObject({ status: 400, details: "REPAIR_ALREADY_CLOSED" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("writeOffRepair", () => {
  it("списание — unit → RETIRED, статус WROTE_OFF", async () => {
    const { createRepair, writeOffRepair } = await import("../services/repairService");

    const woUnit = await prisma.equipmentUnit.create({
      data: { equipmentId, barcode: "WRITEOFF-001", status: "AVAILABLE" },
    });

    const repair = await createRepair({
      unitId: woUnit.id,
      reason: "Неремонтопригоден",
      urgency: "URGENT",
      createdBy: superAdminId,
    });

    const result = await writeOffRepair(repair.id, superAdminId);
    expect(result.status).toBe("WROTE_OFF");

    const unit = await prisma.equipmentUnit.findUnique({ where: { id: woUnit.id } });
    expect(unit.status).toBe("RETIRED");

    const audit = await prisma.auditEntry.findFirst({
      where: { entityType: "Repair", action: "REPAIR_WRITE_OFF", entityId: repair.id },
    });
    expect(audit).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────

describe("assignRepair — closed-guard (F7)", () => {
  it("400 REPAIR_ALREADY_CLOSED — нельзя назначить на закрытый ремонт", async () => {
    const { createRepair, closeRepair, assignRepair } = await import("../services/repairService");

    const guardUnit = await prisma.equipmentUnit.create({
      data: { equipmentId, barcode: "ASSIGN-GUARD-001", status: "AVAILABLE" },
    });

    const repair = await createRepair({
      unitId: guardUnit.id,
      reason: "Закрытый тест назначения",
      urgency: "NORMAL",
      createdBy: warehouseId,
    });

    await closeRepair(repair.id, superAdminId);

    await expect(
      assignRepair(repair.id, technicianId, superAdminId),
    ).rejects.toMatchObject({ status: 400, details: "REPAIR_ALREADY_CLOSED" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("takeRepair (F8)", () => {
  it("статус IN_REPAIR, assignedTo = userId, аудит REPAIR_TAKE", async () => {
    const { createRepair, takeRepair } = await import("../services/repairService");

    const takeUnit = await prisma.equipmentUnit.create({
      data: { equipmentId, barcode: "TAKE-001", status: "AVAILABLE" },
    });

    const repair = await createRepair({
      unitId: takeUnit.id,
      reason: "Взять в работу",
      urgency: "NORMAL",
      createdBy: warehouseId,
    });

    const taken = await takeRepair(repair.id, technicianId);
    expect(taken.status).toBe("IN_REPAIR");
    expect(taken.assignedTo).toBe(technicianId);

    const audit = await prisma.auditEntry.findFirst({
      where: { entityType: "Repair", action: "REPAIR_TAKE", entityId: repair.id },
    });
    expect(audit).not.toBeNull();

    // Cleanup
    await prisma.repair.update({ where: { id: repair.id }, data: { status: "CLOSED", closedAt: new Date() } });
    await prisma.equipmentUnit.update({ where: { id: takeUnit.id }, data: { status: "AVAILABLE" } });
  });

  it("400 REPAIR_ALREADY_CLOSED — нельзя взять закрытый ремонт", async () => {
    const { createRepair, closeRepair, takeRepair } = await import("../services/repairService");

    const takeUnit2 = await prisma.equipmentUnit.create({
      data: { equipmentId, barcode: "TAKE-002", status: "AVAILABLE" },
    });

    const repair = await createRepair({
      unitId: takeUnit2.id,
      reason: "Уже закрытый",
      urgency: "NORMAL",
      createdBy: warehouseId,
    });

    await closeRepair(repair.id, superAdminId);

    await expect(takeRepair(repair.id, technicianId))
      .rejects.toMatchObject({ status: 400, details: "REPAIR_ALREADY_CLOSED" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("addWorkLog", () => {
  it("добавляет запись работ — обновляет totalTimeHours и partsCost", async () => {
    const { createRepair, setRepairStatus, assignRepair, addWorkLog } = await import("../services/repairService");

    const wlUnit = await prisma.equipmentUnit.create({
      data: { equipmentId, barcode: "WORKLOG-001", status: "AVAILABLE" },
    });

    const repair = await createRepair({
      unitId: wlUnit.id,
      reason: "Работы тест",
      urgency: "NORMAL",
      createdBy: warehouseId,
    });

    await assignRepair(repair.id, technicianId, superAdminId);
    await setRepairStatus(repair.id, "IN_REPAIR", technicianId);

    const updated = await addWorkLog(
      repair.id,
      { description: "Замена лампы", timeSpentHours: 2, partCost: 500, loggedBy: technicianId },
      "TECHNICIAN",
    );

    expect(Number(updated.totalTimeHours)).toBe(2);
    expect(Number(updated.partsCost)).toBe(500);

    const logs = await prisma.repairWorkLog.findMany({ where: { repairId: repair.id } });
    expect(logs).toHaveLength(1);

    // Cleanup
    await prisma.repairWorkLog.deleteMany({ where: { repairId: repair.id } });
    await prisma.repair.update({ where: { id: repair.id }, data: { status: "CLOSED", closedAt: new Date() } });
    await prisma.equipmentUnit.update({ where: { id: wlUnit.id }, data: { status: "AVAILABLE" } });
  });

  it("F4: точность Decimal — 0.1 + 0.2 + 0.1 = 0.4 без float-мусора", async () => {
    const { createRepair, setRepairStatus, assignRepair, addWorkLog } = await import("../services/repairService");

    const precUnit = await prisma.equipmentUnit.create({
      data: { equipmentId, barcode: "PREC-001", status: "AVAILABLE" },
    });

    const repair = await createRepair({
      unitId: precUnit.id,
      reason: "Точность тест",
      urgency: "NORMAL",
      createdBy: warehouseId,
    });

    await assignRepair(repair.id, technicianId, superAdminId);
    await setRepairStatus(repair.id, "IN_REPAIR", technicianId);

    await addWorkLog(repair.id, { description: "шаг 1", timeSpentHours: 0.1, partCost: 100, loggedBy: technicianId }, "TECHNICIAN");
    await addWorkLog(repair.id, { description: "шаг 2", timeSpentHours: 0.2, partCost: 200, loggedBy: technicianId }, "TECHNICIAN");
    const final = await addWorkLog(repair.id, { description: "шаг 3", timeSpentHours: 0.1, partCost: 50, loggedBy: technicianId }, "TECHNICIAN");

    // 0.1 + 0.2 + 0.1 would be 0.4000000000000001 in native float; expect exact 0.4
    expect(Number(final.totalTimeHours)).toBe(0.4);
    // 100 + 200 + 50 = 350 (integer part checks accumulation)
    expect(Number(final.partsCost)).toBe(350);

    // Cleanup
    await prisma.repairWorkLog.deleteMany({ where: { repairId: repair.id } });
    await prisma.repair.update({ where: { id: repair.id }, data: { status: "CLOSED", closedAt: new Date() } });
    await prisma.equipmentUnit.update({ where: { id: precUnit.id }, data: { status: "AVAILABLE" } });
  });

  it("403 — TECHNICIAN не assignedTo не может логировать работы", async () => {
    const { createRepair, setRepairStatus, assignRepair, addWorkLog } = await import("../services/repairService");

    const wlUnit2 = await prisma.equipmentUnit.create({
      data: { equipmentId, barcode: "WORKLOG-002", status: "AVAILABLE" },
    });

    const repair = await createRepair({
      unitId: wlUnit2.id,
      reason: "Охрана работ",
      urgency: "NORMAL",
      createdBy: warehouseId,
    });

    // Назначаем на другого пользователя (superAdmin), а пытается залогировать technician
    await assignRepair(repair.id, superAdminId, superAdminId);
    await setRepairStatus(repair.id, "IN_REPAIR", superAdminId);

    await expect(
      addWorkLog(
        repair.id,
        { description: "Попытка", timeSpentHours: 1, partCost: 0, loggedBy: technicianId },
        "TECHNICIAN",
      ),
    ).rejects.toMatchObject({ status: 403 });

    // Cleanup
    await prisma.repair.update({ where: { id: repair.id }, data: { status: "CLOSED", closedAt: new Date() } });
    await prisma.equipmentUnit.update({ where: { id: wlUnit2.id }, data: { status: "AVAILABLE" } });
  });
});
