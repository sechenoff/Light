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
import { prisma } from "../prisma";
import { writeAuditEntry } from "./audit";
import { HttpError } from "../utils/errors";

function notFoundToHttpError(err: unknown, entity = "Ремонт"): never {
  if (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === "P2025"
  ) {
    throw new HttpError(404, `${entity} не найден`, "NOT_FOUND");
  }
  throw err;
}

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
  // Данные — в одной транзакции (Repair + EquipmentUnit). Audit пишется
  // ПОСЛЕ commit как best-effort: `AuditEntry.userId` — FK на `AdminUser.id`,
  // а `createdBy` в warehouse-flow приходит как имя кладовщика/username (не
  // id). Audit-insert внутри tx даёт P2003 и откатывает создание Repair —
  // именно из-за этого «приёмка завершалась», но карточка ремонта не
  // появлялась в /repair. Документированный паттерн: audit = observability,
  // не бизнес-инвариант (см. completeSession.BOOKING_STATUS_CHANGED).
  const repair = await prisma.$transaction(async (tx: TxClient) => {
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
    const unit = await tx.equipmentUnit.findUniqueOrThrow({ where: { id: args.unitId } }).catch((e) => notFoundToHttpError(e, "Единица оборудования"));
    if (unit.status === "RETIRED") {
      throw new HttpError(400, "Нельзя ремонтировать списанную единицу", "UNIT_RETIRED");
    }

    // 3. Создать Repair
    const created = await tx.repair.create({
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

    return created;
  });

  // 5. Аудит — best-effort, ВНЕ tx (см. комментарий выше).
  await writeAuditEntry({
    userId: args.createdBy,
    action: "REPAIR_CREATE",
    entityType: "Repair",
    entityId: repair.id,
    before: null,
    after: { status: repair.status, unitId: repair.unitId, reason: repair.reason },
  }).catch((err) => {
    console.warn(
      "[createRepair] audit failed:",
      err instanceof Error ? err.message : String(err),
    );
  });

  return repair;
}

// ─── assignRepair ────────────────────────────────────────────────────────────

export async function assignRepair(id: string, assigneeId: string, userId: string) {
  return prisma.$transaction(async (tx: TxClient) => {
    const repair = await tx.repair.findUniqueOrThrow({ where: { id } }).catch((e) => notFoundToHttpError(e));

    if (CLOSED_STATUSES.includes(repair.status as RepairStatus)) {
      throw new HttpError(400, "Ремонт уже закрыт", "REPAIR_ALREADY_CLOSED");
    }

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
    const repair = await tx.repair.findUniqueOrThrow({ where: { id } }).catch((e) => notFoundToHttpError(e));

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

export interface CloseRepairExpense {
  amount: number;
  description: string;
}

/**
 * Закрывает ремонт (unit → AVAILABLE). Опциональный `expense` создаёт расход
 * категории REPAIR В ТОЙ ЖЕ транзакции, что и закрытие: при любом сбое ни
 * ремонт не закрыт, ни расход не записан (раньше UI слал два последовательных
 * запроса — при падении close оставался расход-сирота, а повтор создавал
 * дубль в финансах). `creatorRole` управляет флагом approved: только
 * SUPER_ADMIN-расход утверждён сразу (зеркалит expenseService.createExpense).
 */
export async function closeRepair(
  id: string,
  userId: string,
  expense?: CloseRepairExpense,
  creatorRole?: string,
) {
  return prisma.$transaction(async (tx: TxClient) => {
    const repair = await tx.repair.findUniqueOrThrow({ where: { id } }).catch((e) => notFoundToHttpError(e));

    if (CLOSED_STATUSES.includes(repair.status as RepairStatus)) {
      throw new HttpError(400, "Ремонт уже закрыт", "REPAIR_ALREADY_CLOSED");
    }

    const before = { status: repair.status };

    await tx.repair.update({
      where: { id },
      data: { status: "CLOSED", closedAt: new Date() },
    });

    if (repair.unitId) {
      await tx.equipmentUnit.update({
        where: { id: repair.unitId },
        data: { status: "AVAILABLE" },
      });
    }

    if (expense) {
      // Поля зеркалят expenseService.createExpense (legacy backfill name/
      // expenseDate/comment) — но внутри ЭТОЙ транзакции, а не отдельной.
      const createdExpense = await tx.expense.create({
        data: {
          category: "REPAIR",
          amount: new Prisma.Decimal(expense.amount),
          description: expense.description,
          linkedRepairId: id,
          approved: creatorRole === "SUPER_ADMIN",
          createdBy: userId,
          name: expense.description.slice(0, 100),
          expenseDate: new Date(),
          comment: expense.description,
        },
      });

      await writeAuditEntry({
        tx,
        userId,
        action: "EXPENSE_CREATE",
        entityType: "Expense",
        entityId: createdExpense.id,
        before: null,
        after: {
          category: "REPAIR",
          amount: createdExpense.amount.toString(),
          linkedRepairId: id,
          approved: createdExpense.approved,
        },
      });
    }

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
    const repair = await tx.repair.findUniqueOrThrow({ where: { id } }).catch((e) => notFoundToHttpError(e));

    if (CLOSED_STATUSES.includes(repair.status as RepairStatus)) {
      throw new HttpError(400, "Ремонт уже закрыт", "REPAIR_ALREADY_CLOSED");
    }

    const before = { status: repair.status };

    const updated = await tx.repair.update({
      where: { id },
      data: { status: "WROTE_OFF", closedAt: new Date() },
    });

    if (repair.unitId) {
      await tx.equipmentUnit.update({
        where: { id: repair.unitId },
        data: { status: "RETIRED" },
      });
    }

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
    const repair = await tx.repair.findUniqueOrThrow({ where: { id: repairId } }).catch((e) => notFoundToHttpError(e));

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

    // Атомарное обновление через Prisma increment с Prisma.Decimal — без потери точности
    const updated = await tx.repair.update({
      where: { id: repairId },
      data: {
        totalTimeHours: { increment: new Prisma.Decimal(args.timeSpentHours) },
        partsCost: { increment: new Prisma.Decimal(args.partCost) },
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

// ─── takeRepair ──────────────────────────────────────────────────────────────

/**
 * Атомарный «взять в работу»: назначает userId и переводит статус в IN_REPAIR.
 * TECHNICIAN self-takes (assignedTo = userId). SUPER_ADMIN тоже self-takes.
 */
export async function takeRepair(id: string, userId: string) {
  return prisma.$transaction(async (tx: TxClient) => {
    const repair = await tx.repair.findUniqueOrThrow({ where: { id } }).catch((e) => notFoundToHttpError(e));

    if (CLOSED_STATUSES.includes(repair.status as RepairStatus)) {
      throw new HttpError(400, "Ремонт уже закрыт", "REPAIR_ALREADY_CLOSED");
    }

    const before = { status: repair.status, assignedTo: repair.assignedTo };

    const updated = await tx.repair.update({
      where: { id },
      data: { assignedTo: userId, status: "IN_REPAIR" },
    });

    await writeAuditEntry({
      tx,
      userId,
      action: "REPAIR_TAKE",
      entityType: "Repair",
      entityId: id,
      before,
      after: { status: "IN_REPAIR", assignedTo: userId },
    });

    return updated;
  });
}
