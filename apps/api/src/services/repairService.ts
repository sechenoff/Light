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

import type { RepairUrgency, RepairStatus, BookingStatus } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { writeAuditEntry } from "./audit";
import {
  BLOCKING_STATUSES,
  getLostCountByEquipmentMap,
  getRepairCountByEquipmentMap,
} from "./availability";
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
  /** Штучный ремонт: единица уходит в MAINTENANCE. */
  unitId?: string | null;
  /** Ремонт позиции без штучного учёта (кабели, стойки, зарядки). */
  equipmentId?: string | null;
  bookingItemId?: string | null;
  quantity?: number;
  reason: string;
  urgency: RepairUrgency;
  sourceBookingId?: string;
  expectedReadyAt?: Date | null;
  partsNote?: string | null;
  createdBy: string;
}) {
  if (!args.unitId && !args.equipmentId && !args.bookingItemId) {
    throw new HttpError(400, "Не указано, что ремонтируем", "REPAIR_TARGET_REQUIRED");
  }

  // Данные — в одной транзакции (Repair + EquipmentUnit). Audit пишется
  // ПОСЛЕ commit как best-effort: `AuditEntry.userId` — FK на `AdminUser.id`,
  // а `createdBy` в warehouse-flow приходит как имя кладовщика/username (не
  // id). Audit-insert внутри tx даёт P2003 и откатывает создание Repair —
  // именно из-за этого «приёмка завершалась», но карточка ремонта не
  // появлялась в /repair. Документированный паттерн: audit = observability,
  // не бизнес-инвариант (см. completeSession.BOOKING_STATUS_CHANGED).
  const repair = await prisma.$transaction(async (tx: TxClient) => {
    let equipmentId = args.equipmentId ?? null;

    if (args.unitId) {
      // 1. Проверить: нет активной Repair на эту единицу
      const existing = await tx.repair.findFirst({
        where: {
          unitId: args.unitId,
          status: { in: ACTIVE_STATUSES },
        },
        select: { id: true },
      });
      if (existing) {
        throw new HttpError(
          409,
          "Активная карточка ремонта уже существует",
          "REPAIR_ACTIVE_EXISTS",
          { repairId: existing.id },
        );
      }

      // 2. Проверить: unit существует и не RETIRED
      const unit = await tx.equipmentUnit.findUniqueOrThrow({ where: { id: args.unitId } }).catch((e) => notFoundToHttpError(e, "Единица оборудования"));
      if (unit.status === "RETIRED") {
        throw new HttpError(400, "Нельзя ремонтировать списанную единицу", "UNIT_RETIRED");
      }
      // Позицию каталога подставляем с самой единицы: если единицу потом
      // удалят, `unitId` обнулится связью, и карточка осталась бы без имени.
      equipmentId = unit.equipmentId;
    } else if (equipmentId) {
      const equipment = await tx.equipment.findUnique({
        where: { id: equipmentId },
        select: { id: true },
      });
      if (!equipment) {
        throw new HttpError(404, "Позиция каталога не найдена", "EQUIPMENT_NOT_FOUND");
      }
    }

    // 3. Создать Repair
    const created = await tx.repair.create({
      data: {
        unitId: args.unitId ?? null,
        equipmentId,
        bookingItemId: args.bookingItemId ?? null,
        // Штучная поломка — всегда одна единица, сколько бы ни прислали.
        quantity: args.unitId ? 1 : Math.max(1, args.quantity ?? 1),
        reason: args.reason,
        urgency: args.urgency,
        sourceBookingId: args.sourceBookingId ?? null,
        expectedReadyAt: args.expectedReadyAt ?? null,
        partsNote: args.partsNote ?? null,
        createdBy: args.createdBy,
        status: "WAITING_REPAIR",
        partsCost: 0,
        totalTimeHours: 0,
      },
    });

    // 4. Перевести unit в MAINTENANCE
    if (args.unitId) {
      await tx.equipmentUnit.update({
        where: { id: args.unitId },
        data: { status: "MAINTENANCE" },
      });
    }

    return created;
  });

  // 5. Аудит — best-effort, ВНЕ tx (см. комментарий выше).
  await writeAuditEntry({
    userId: args.createdBy,
    action: "REPAIR_CREATE",
    entityType: "Repair",
    entityId: repair.id,
    before: null,
    after: {
      status: repair.status,
      unitId: repair.unitId,
      equipmentId: repair.equipmentId,
      quantity: repair.quantity,
      reason: repair.reason,
      expectedReadyAt: repair.expectedReadyAt?.toISOString() ?? null,
    },
  }).catch((err) => {
    console.warn(
      "[createRepair] audit failed:",
      err instanceof Error ? err.message : String(err),
    );
  });

  return repair;
}

// ─── setRepairEta ────────────────────────────────────────────────────────────

/**
 * Назначает/сдвигает срок готовности и заметку о запчастях.
 *
 * `expectedReadyAt: null` — не «забыли заполнить», а осознанное «срок не
 * назначен»: выдуманный прогноз хуже честного пробела, по нему начнут
 * планировать съёмку. Поэтому null принимается и сохраняется.
 */
export async function setRepairEta(
  id: string,
  args: { expectedReadyAt?: Date | null; partsNote?: string | null },
  userId: string,
) {
  return prisma.$transaction(async (tx: TxClient) => {
    const repair = await tx.repair.findUniqueOrThrow({ where: { id } }).catch((e) => notFoundToHttpError(e));

    if (CLOSED_STATUSES.includes(repair.status as RepairStatus)) {
      throw new HttpError(400, "Ремонт уже закрыт", "REPAIR_ALREADY_CLOSED");
    }

    const before = {
      expectedReadyAt: repair.expectedReadyAt?.toISOString() ?? null,
      partsNote: repair.partsNote,
    };

    const updated = await tx.repair.update({
      where: { id },
      data: {
        // undefined = поле не прислали, трогать не нужно; null = «срок снят».
        ...(args.expectedReadyAt !== undefined ? { expectedReadyAt: args.expectedReadyAt } : {}),
        ...(args.partsNote !== undefined ? { partsNote: args.partsNote } : {}),
      },
    });

    await writeAuditEntry({
      tx,
      userId,
      action: "REPAIR_ETA_SET",
      entityType: "Repair",
      entityId: id,
      before,
      after: {
        expectedReadyAt: updated.expectedReadyAt?.toISOString() ?? null,
        partsNote: updated.partsNote,
      },
    });

    return updated;
  });
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
 *
 * Guard: только assignedTo === loggedBy ИЛИ loggedByRole === SUPER_ADMIN.
 *
 * Первая запись в статусе «Ждёт ремонта» САМА переводит карточку в работу и,
 * если её никто не взял, назначает автора записи на себя. Раньше сервер отвечал
 * на неё 400-м: фронт форму показывал, человек заполнял описание и потраченные
 * часы — и получал отказ с требованием сначала нажать «Взять в работу».
 * Запись работ по определению означает, что работа началась; заставлять
 * подтверждать это отдельной кнопкой — бюрократия, которую система придумала
 * сама себе.
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

    // Никем не взятая карточка в очереди — открыта для любого, кто до неё дошёл:
    // именно этим «взять в работу» и является.
    const unclaimed = repair.status === "WAITING_REPAIR" && !repair.assignedTo;

    // Только assignedTo или SUPER_ADMIN
    if (loggedByRole !== "SUPER_ADMIN" && repair.assignedTo !== args.loggedBy && !unclaimed) {
      throw new HttpError(403, "Только назначенный техник может добавлять записи работ", "WORK_LOG_FORBIDDEN");
    }

    if (CLOSED_STATUSES.includes(repair.status as RepairStatus)) {
      throw new HttpError(400, "Ремонт уже закрыт", "REPAIR_ALREADY_CLOSED");
    }

    // Первая запись работ = старт ремонта (см. док-комментарий функции).
    const autoStart = repair.status === "WAITING_REPAIR";
    const autoAssignee = unclaimed ? args.loggedBy : repair.assignedTo;

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
        ...(autoStart ? { status: "IN_REPAIR" as RepairStatus, assignedTo: autoAssignee } : {}),
      },
    });

    if (autoStart) {
      await writeAuditEntry({
        tx,
        userId: args.loggedBy,
        action: "REPAIR_STATUS_CHANGE",
        entityType: "Repair",
        entityId: repairId,
        before: { status: repair.status, assignedTo: repair.assignedTo },
        // `auto: true` — чтобы в журнале было видно, что статус сменила запись
        // работ, а не отдельное нажатие «Взять в работу».
        after: { status: "IN_REPAIR", assignedTo: autoAssignee, auto: true },
      });
    }

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
