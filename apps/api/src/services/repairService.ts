/**
 * Сервис управления ремонтами оборудования.
 *
 * Sprint 4: Repair Workflow
 * - createRepair — создание карточки ремонта
 * - assignRepair — назначение техника
 * - setRepairStatus — смена статуса (не закрывает)
 * - closeRepair — завершение ремонта (unit → AVAILABLE)
 * - writeOffRepair — списание (unit → RETIRED)
 * - addWorkLog — запись работ по ремонту
 */

import type { RepairUrgency, RepairStatus } from "@prisma/client";
import { Prisma } from "@prisma/client";
import Decimal from "decimal.js";
import { prisma } from "../prisma";
import { writeAuditEntry } from "./audit";
import { HttpError } from "../utils/errors";

type TxClient = Omit<
  Prisma.TransactionClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends" | "$use"
>;

const ACTIVE_STATUSES: RepairStatus[] = ["WAITING_REPAIR", "IN_REPAIR", "WAITING_PARTS"];
const CLOSED_STATUSES: RepairStatus[] = ["CLOSED", "WROTE_OFF"];

// ─── createRepair ────────────────────────────────────────────────────────────

export async function createRepair(args: {
  unitId: string;
  reason: string;
  urgency: RepairUrgency;
  sourceBookingId?: string;
  createdBy: string;
}) {
  return prisma.$transaction(async (tx: TxClient) => {
    // 1. Проверить: нет активной Repair на эту единицу
    const existing = await tx.repair.findFirst({
      where: {
        unitId: args.unitId,
        status: { in: ACTIVE_STATUSES },
      },
    });
    if (existing) {
      throw new HttpError(409, "Активная карточка ремонта уже существует", "REPAIR_ACTIVE_EXISTS");
    }

    // 2. Проверить: unit существует и не RETIRED
    const unit = await tx.equipmentUnit.findUniqueOrThrow({ where: { id: args.unitId } });
    if (unit.status === "RETIRED") {
      throw new HttpError(400, "Нельзя ремонтировать списанную единицу", "UNIT_RETIRED");
    }

    // 3. Создать Repair
    const repair = await tx.repair.create({
      data: {
        unitId: args.unitId,
        reason: args.reason,
        urgency: args.urgency,
        sourceBookingId: args.sourceBookingId ?? null,
        createdBy: args.createdBy,
        status: "WAITING_REPAIR",
        partsCost: 0,
        totalTimeHours: 0,
      },
    });

    // 4. Перевести unit в MAINTENANCE
    await tx.equipmentUnit.update({
      where: { id: args.unitId },
      data: { status: "MAINTENANCE" },
    });

    // 5. Аудит
    await writeAuditEntry({
      tx,
      userId: args.createdBy,
      action: "REPAIR_CREATE",
      entityType: "Repair",
      entityId: repair.id,
      before: null,
      after: { status: repair.status, unitId: repair.unitId, reason: repair.reason },
    });

    return repair;
  });
}

// ─── assignRepair ────────────────────────────────────────────────────────────

export async function assignRepair(id: string, assigneeId: string, userId: string) {
  return prisma.$transaction(async (tx: TxClient) => {
    const repair = await tx.repair.findUniqueOrThrow({ where: { id } });

    const before = { assignedTo: repair.assignedTo };

    const updated = await tx.repair.update({
      where: { id },
      data: { assignedTo: assigneeId },
    });

    await writeAuditEntry({
      tx,
      userId,
      action: "REPAIR_ASSIGN",
      entityType: "Repair",
      entityId: id,
      before,
      after: { assignedTo: assigneeId },
    });

    return updated;
  });
}

// ─── setRepairStatus ─────────────────────────────────────────────────────────

export async function setRepairStatus(id: string, nextStatus: RepairStatus, userId: string) {
  return prisma.$transaction(async (tx: TxClient) => {
    const repair = await tx.repair.findUniqueOrThrow({ where: { id } });

    // Нельзя менять статус закрытого
    if (CLOSED_STATUSES.includes(repair.status as RepairStatus)) {
      throw new HttpError(400, "Ремонт уже закрыт", "REPAIR_ALREADY_CLOSED");
    }

    // Нельзя перевести в CLOSED/WROTE_OFF через эту функцию — только через closeRepair/writeOffRepair
    if (CLOSED_STATUSES.includes(nextStatus)) {
      throw new HttpError(400, "Используйте closeRepair или writeOffRepair для закрытия", "USE_DEDICATED_CLOSE");
    }

    const before = { status: repair.status };
    const updated = await tx.repair.update({
      where: { id },
      data: { status: nextStatus },
    });

    await writeAuditEntry({
      tx,
      userId,
      action: "REPAIR_STATUS_CHANGE",
      entityType: "Repair",
      entityId: id,
      before,
      after: { status: nextStatus },
    });

    return updated;
  });
}

// ─── closeRepair ─────────────────────────────────────────────────────────────

export async function closeRepair(id: string, userId: string) {
  return prisma.$transaction(async (tx: TxClient) => {
    const repair = await tx.repair.findUniqueOrThrow({ where: { id } });

    if (CLOSED_STATUSES.includes(repair.status as RepairStatus)) {
      throw new HttpError(400, "Ремонт уже закрыт", "REPAIR_ALREADY_CLOSED");
    }

    const before = { status: repair.status };

    await tx.repair.update({
      where: { id },
      data: { status: "CLOSED", closedAt: new Date() },
    });

    await tx.equipmentUnit.update({
      where: { id: repair.unitId },
      data: { status: "AVAILABLE" },
    });

    await writeAuditEntry({
      tx,
      userId,
      action: "REPAIR_CLOSE",
      entityType: "Repair",
      entityId: id,
      before,
      after: { status: "CLOSED" },
    });

    return tx.repair.findUnique({
      where: { id },
      include: { unit: true, workLog: true },
    });
  });
}

// ─── writeOffRepair ──────────────────────────────────────────────────────────

export async function writeOffRepair(id: string, userId: string) {
  return prisma.$transaction(async (tx: TxClient) => {
    const repair = await tx.repair.findUniqueOrThrow({ where: { id } });

    if (CLOSED_STATUSES.includes(repair.status as RepairStatus)) {
      throw new HttpError(400, "Ремонт уже закрыт", "REPAIR_ALREADY_CLOSED");
    }

    const before = { status: repair.status };

    const updated = await tx.repair.update({
      where: { id },
      data: { status: "WROTE_OFF", closedAt: new Date() },
    });

    await tx.equipmentUnit.update({
      where: { id: repair.unitId },
      data: { status: "RETIRED" },
    });

    await writeAuditEntry({
      tx,
      userId,
      action: "REPAIR_WRITE_OFF",
      entityType: "Repair",
      entityId: id,
      before,
      after: { status: "WROTE_OFF" },
    });

    return updated;
  });
}

// ─── addWorkLog ──────────────────────────────────────────────────────────────

/**
 * Добавляет запись работ по ремонту.
 * Guard: только assignedTo === loggedBy ИЛИ loggedByRole === SUPER_ADMIN.
 * Статус ремонта должен быть IN_REPAIR или WAITING_PARTS.
 */
export async function addWorkLog(
  repairId: string,
  args: {
    description: string;
    timeSpentHours: number;
    partCost: number;
    loggedBy: string;
  },
  loggedByRole: string,
) {
  return prisma.$transaction(async (tx: TxClient) => {
    const repair = await tx.repair.findUniqueOrThrow({ where: { id: repairId } });

    // Только assignedTo или SUPER_ADMIN
    if (loggedByRole !== "SUPER_ADMIN" && repair.assignedTo !== args.loggedBy) {
      throw new HttpError(403, "Только назначенный техник может добавлять записи работ", "WORK_LOG_FORBIDDEN");
    }

    // Статус должен быть IN_REPAIR или WAITING_PARTS
    if (repair.status !== "IN_REPAIR" && repair.status !== "WAITING_PARTS") {
      throw new HttpError(
        400,
        "Записи работ можно добавлять только в статусах IN_REPAIR или WAITING_PARTS",
        "REPAIR_STATUS_INVALID_FOR_LOG",
      );
    }

    const log = await tx.repairWorkLog.create({
      data: {
        repairId,
        description: args.description,
        timeSpentHours: args.timeSpentHours,
        partCost: args.partCost,
        loggedBy: args.loggedBy,
      },
    });

    // Атомарное обновление накопленных значений через Decimal
    const newTotalHours = new Decimal(repair.totalTimeHours.toString())
      .plus(new Decimal(args.timeSpentHours));
    const newPartsCost = new Decimal(repair.partsCost.toString())
      .plus(new Decimal(args.partCost));

    const updated = await tx.repair.update({
      where: { id: repairId },
      data: {
        totalTimeHours: newTotalHours.toDecimalPlaces(2).toNumber(),
        partsCost: newPartsCost.toDecimalPlaces(2).toNumber(),
      },
    });

    await writeAuditEntry({
      tx,
      userId: args.loggedBy,
      action: "REPAIR_WORK_LOG",
      entityType: "Repair",
      entityId: repairId,
      before: null,
      after: {
        logId: log.id,
        description: args.description,
        timeSpentHours: args.timeSpentHours,
        partCost: args.partCost,
      },
    });

    return updated;
  });
}
