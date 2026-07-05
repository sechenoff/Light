import type { Prisma } from "@prisma/client";

import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";
import { writeAuditEntry } from "./audit";

/**
 * Ссылка на бронь, на которой машина сейчас занята (или ближайшую предстоящую).
 * Нужна, чтобы менеджер со списка /vehicles видел занятость и мог ответить
 * на звонок «есть ли газель на завтра».
 */
export interface ActiveBookingRef {
  bookingId: string;
  projectName: string;
  clientName: string | null;
  startDate: string;
  endDate: string;
  status: "CONFIRMED" | "ISSUED";
  /** true — машина физически выдана прямо сейчас (ISSUED и период включает сегодня). */
  isCurrent: boolean;
}

/** Сериализованный summary автомобиля для списков. */
export interface VehicleSummary {
  id: string;
  name: string;
  slug: string;
  licensePlate: string | null;
  currentMileage: number;
  lastServiceAt: string | null;
  lastServiceMileage: number | null;
  lastServiceKind: string | null;
  notes: string | null;
  active: boolean;
  /** Активная/ближайшая бронь с этой машиной. null — машина свободна. */
  activeBooking: ActiveBookingRef | null;
}

/**
 * Брони, блокирующие машину: подтверждённые и выданные (не удалённые).
 * DRAFT / PENDING_APPROVAL / RETURNED / CANCELLED машину не занимают.
 */
const OCCUPYING_STATUSES = ["CONFIRMED", "ISSUED"] as const;

/**
 * Для набора машин находит по одной «активной» броне на каждую:
 * приоритет — выданная прямо сейчас (ISSUED, период включает сегодня),
 * иначе ближайшая по startDate предстоящая/текущая бронь.
 * Один запрос без N+1: тянем все занимающие BookingVehicle разом.
 */
async function loadActiveBookings(
  vehicleIds: string[],
): Promise<Map<string, ActiveBookingRef>> {
  const result = new Map<string, ActiveBookingRef>();
  if (vehicleIds.length === 0) return result;

  const now = new Date();
  const rows = await prisma.bookingVehicle.findMany({
    where: {
      vehicleId: { in: vehicleIds },
      booking: {
        status: { in: [...OCCUPYING_STATUSES] },
        deletedAt: null,
        // Только текущие/будущие: закончившиеся брони не занимают машину.
        endDate: { gte: now },
      },
    },
    select: {
      vehicleId: true,
      booking: {
        select: {
          id: true,
          projectName: true,
          startDate: true,
          endDate: true,
          status: true,
          client: { select: { name: true } },
        },
      },
    },
    orderBy: { booking: { startDate: "asc" } },
  });

  for (const row of rows) {
    const b = row.booking;
    const isCurrent =
      b.status === "ISSUED" && b.startDate <= now && b.endDate >= now;
    const candidate: ActiveBookingRef = {
      bookingId: b.id,
      projectName: b.projectName,
      clientName: b.client?.name ?? null,
      startDate: b.startDate.toISOString(),
      endDate: b.endDate.toISOString(),
      status: b.status as "CONFIRMED" | "ISSUED",
      isCurrent,
    };
    const existing = result.get(row.vehicleId);
    // Приоритет: выданная сейчас важнее просто ближайшей предстоящей.
    if (!existing || (candidate.isCurrent && !existing.isCurrent)) {
      result.set(row.vehicleId, candidate);
    }
  }
  return result;
}

/** Запись журнала пробега (для UI). */
export interface MileageLogView {
  id: string;
  mileage: number;
  recordedAt: string;
  bookingId: string | null;
  source: "RETURN" | "MANUAL";
  recordedBy: string;
  note: string | null;
}

/** Запись журнала обслуживания (ТО/ремонт). */
export interface ServiceLogView {
  id: string;
  kind: "SCHEDULED_TO" | "OIL_CHANGE" | "TIRE_CHANGE" | "REPAIR" | "INSPECTION" | "OTHER";
  performedAt: string;
  mileage: number | null;
  description: string;
  cost: string | null;
  documentUrl: string | null;
  createdBy: string;
}

function toSummary(
  v: {
    id: string;
    name: string;
    slug: string;
    licensePlate: string | null;
    currentMileage: number;
    lastServiceAt: Date | null;
    lastServiceMileage: number | null;
    lastServiceKind: string | null;
    notes: string | null;
    active: boolean;
  },
  activeBooking: ActiveBookingRef | null = null,
): VehicleSummary {
  return {
    id: v.id,
    name: v.name,
    slug: v.slug,
    licensePlate: v.licensePlate,
    currentMileage: v.currentMileage,
    lastServiceAt: v.lastServiceAt ? v.lastServiceAt.toISOString() : null,
    lastServiceMileage: v.lastServiceMileage,
    lastServiceKind: v.lastServiceKind,
    notes: v.notes,
    active: v.active,
    activeBooking,
  };
}

/** Список всех машин. По умолчанию только активные. */
export async function listVehicles(opts?: { includeInactive?: boolean }): Promise<VehicleSummary[]> {
  const where = opts?.includeInactive ? {} : { active: true };
  const rows = await prisma.vehicle.findMany({
    where,
    orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
  });
  const active = await loadActiveBookings(rows.map((r) => r.id));
  return rows.map((r) => toSummary(r, active.get(r.id) ?? null));
}

/** Детальная карточка машины: summary + журналы пробега и ТО. */
export async function getVehicleDetail(vehicleId: string): Promise<{
  vehicle: VehicleSummary & { shiftPriceRub: string; shiftHours: number };
  mileageLogs: MileageLogView[];
  serviceLogs: ServiceLogView[];
}> {
  const vehicle = await prisma.vehicle.findUnique({
    where: { id: vehicleId },
    include: {
      mileageLogs: { orderBy: { recordedAt: "desc" } },
      serviceLogs: { orderBy: { performedAt: "desc" } },
    },
  });
  if (!vehicle) {
    throw new HttpError(404, "Машина не найдена", "VEHICLE_NOT_FOUND");
  }
  const active = await loadActiveBookings([vehicle.id]);
  return {
    vehicle: {
      ...toSummary(vehicle, active.get(vehicle.id) ?? null),
      shiftPriceRub: vehicle.shiftPriceRub.toString(),
      shiftHours: vehicle.shiftHours,
    },
    mileageLogs: vehicle.mileageLogs.map((m) => ({
      id: m.id,
      mileage: m.mileage,
      recordedAt: m.recordedAt.toISOString(),
      bookingId: m.bookingId,
      source: m.source as "RETURN" | "MANUAL",
      recordedBy: m.recordedBy,
      note: m.note,
    })),
    serviceLogs: vehicle.serviceLogs.map((s) => ({
      id: s.id,
      kind: s.kind as ServiceLogView["kind"],
      performedAt: s.performedAt.toISOString(),
      mileage: s.mileage,
      description: s.description,
      cost: s.cost ? s.cost.toString() : null,
      documentUrl: s.documentUrl,
      createdBy: s.createdBy,
    })),
  };
}

/** Обновить метаданные машины (гос. номер, заметки). Аудит пишется. */
export async function updateVehicleMeta(
  vehicleId: string,
  patch: { licensePlate?: string | null; notes?: string | null },
  userId: string,
): Promise<VehicleSummary> {
  const existing = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
  if (!existing) {
    throw new HttpError(404, "Машина не найдена", "VEHICLE_NOT_FOUND");
  }
  const data: Prisma.VehicleUpdateInput = {};
  if (patch.licensePlate !== undefined) data.licensePlate = patch.licensePlate;
  if (patch.notes !== undefined) data.notes = patch.notes;
  if (Object.keys(data).length === 0) {
    return toSummary(existing);
  }
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.vehicle.update({ where: { id: vehicleId }, data });
    await writeAuditEntry({
      tx,
      userId,
      action: "VEHICLE_UPDATE",
      entityType: "Vehicle",
      entityId: vehicleId,
      before: {
        licensePlate: existing.licensePlate,
        notes: existing.notes,
      },
      after: {
        licensePlate: u.licensePlate,
        notes: u.notes,
      },
    });
    return u;
  });
  return toSummary(updated);
}

/**
 * Записать пробег вручную (со страницы /vehicles/[id]).
 * Бизнес-правило: новый пробег должен быть ≥ текущего; иначе 409 MILEAGE_DECREASE.
 * Транзакция обновляет Vehicle.currentMileage и пишет аудит.
 */
export async function logMileageManual(args: {
  vehicleId: string;
  mileage: number;
  recordedBy: string;
  userId: string;
  note?: string | null;
}): Promise<MileageLogView> {
  const v = await prisma.vehicle.findUnique({ where: { id: args.vehicleId } });
  if (!v) {
    throw new HttpError(404, "Машина не найдена", "VEHICLE_NOT_FOUND");
  }
  if (args.mileage < v.currentMileage) {
    throw new HttpError(
      409,
      `Новый пробег (${args.mileage}) меньше текущего (${v.currentMileage}). Одометр не может уменьшаться.`,
      "MILEAGE_DECREASE",
      { current: v.currentMileage, attempted: args.mileage },
    );
  }
  return prisma.$transaction(async (tx) => {
    const log = await tx.vehicleMileageLog.create({
      data: {
        vehicleId: args.vehicleId,
        mileage: args.mileage,
        source: "MANUAL",
        recordedBy: args.recordedBy,
        note: args.note ?? null,
      },
    });
    await tx.vehicle.update({
      where: { id: args.vehicleId },
      data: { currentMileage: args.mileage },
    });
    await writeAuditEntry({
      tx,
      userId: args.userId,
      action: "VEHICLE_MILEAGE_LOG",
      entityType: "Vehicle",
      entityId: args.vehicleId,
      before: { currentMileage: v.currentMileage },
      after: { currentMileage: args.mileage, source: "MANUAL", logId: log.id },
    });
    return {
      id: log.id,
      mileage: log.mileage,
      recordedAt: log.recordedAt.toISOString(),
      bookingId: log.bookingId,
      source: log.source as "MANUAL",
      recordedBy: log.recordedBy,
      note: log.note,
    };
  });
}

/** Добавить запись ТО / ремонта. Обновляет denormalized lastService* на Vehicle. */
export async function addServiceLog(args: {
  vehicleId: string;
  kind: ServiceLogView["kind"];
  performedAt: Date;
  mileage: number | null;
  description: string;
  cost: number | null;
  userId: string;
}): Promise<ServiceLogView> {
  const v = await prisma.vehicle.findUnique({ where: { id: args.vehicleId } });
  if (!v) {
    throw new HttpError(404, "Машина не найдена", "VEHICLE_NOT_FOUND");
  }
  if (args.mileage !== null && args.mileage < 0) {
    throw new HttpError(400, "Пробег должен быть ≥ 0", "INVALID_MILEAGE");
  }
  return prisma.$transaction(async (tx) => {
    const log = await tx.vehicleServiceLog.create({
      data: {
        vehicleId: args.vehicleId,
        kind: args.kind,
        performedAt: args.performedAt,
        mileage: args.mileage,
        description: args.description,
        cost: args.cost,
        createdBy: args.userId,
      },
    });
    // Обновляем denormalized "last service" только если эта запись свежее предыдущей.
    const shouldDenorm =
      !v.lastServiceAt || args.performedAt.getTime() >= v.lastServiceAt.getTime();
    if (shouldDenorm) {
      await tx.vehicle.update({
        where: { id: args.vehicleId },
        data: {
          lastServiceAt: args.performedAt,
          lastServiceMileage: args.mileage,
          lastServiceKind: args.kind,
        },
      });
    }
    await writeAuditEntry({
      tx,
      userId: args.userId,
      action: "VEHICLE_SERVICE_ADD",
      entityType: "Vehicle",
      entityId: args.vehicleId,
      before: null,
      after: {
        serviceLogId: log.id,
        kind: args.kind,
        performedAt: args.performedAt.toISOString(),
        mileage: args.mileage,
        description: args.description,
        cost: args.cost,
      },
    });
    return {
      id: log.id,
      kind: log.kind as ServiceLogView["kind"],
      performedAt: log.performedAt.toISOString(),
      mileage: log.mileage,
      description: log.description,
      cost: log.cost ? log.cost.toString() : null,
      documentUrl: log.documentUrl,
      createdBy: log.createdBy,
    };
  });
}

/**
 * Записать пробег ВНУТРИ транзакции возврата (вызывается из warehouseScan.completeSession).
 * Возвращает массив созданных лог-записей.
 *
 * Валидирует mileage ≥ currentMileage по каждой машине, throws 409 если нет.
 *
 * NB: AuditEntry СОЗНАТЕЛЬНО не пишется здесь. В kiosk-сессии recordedBy — это
 * `WarehousePin.name`, а у `AuditEntry.userId` FK на `AdminUser` (Restrict);
 * вставка имени кладовщика как FK уронит всю транзакцию возврата. Сама запись
 * `VehicleMileageLog` уже самостоятельный audit trail (хранит bookingId +
 * recordedBy + recordedAt + source=RETURN). Консистентно с подходом
 * `autoResolveOnReturn` в проекте: аудит ≠ бизнес-инвариант.
 */
export async function recordReturnMileages(args: {
  tx: Prisma.TransactionClient;
  bookingId: string;
  recordedBy: string;
  entries: Array<{ vehicleId: string; mileage: number }>;
}): Promise<Array<{ vehicleId: string; logId: string; mileage: number }>> {
  if (args.entries.length === 0) return [];
  const result: Array<{ vehicleId: string; logId: string; mileage: number }> = [];
  for (const entry of args.entries) {
    const v = await args.tx.vehicle.findUnique({ where: { id: entry.vehicleId } });
    if (!v) {
      throw new HttpError(
        404,
        `Машина (vehicleId=${entry.vehicleId}) не найдена`,
        "VEHICLE_NOT_FOUND",
      );
    }
    if (entry.mileage < v.currentMileage) {
      throw new HttpError(
        409,
        `Пробег "${v.name}" (${entry.mileage}) меньше текущего (${v.currentMileage}). Одометр не может уменьшаться.`,
        "MILEAGE_DECREASE",
        { vehicleId: entry.vehicleId, current: v.currentMileage, attempted: entry.mileage },
      );
    }
    const log = await args.tx.vehicleMileageLog.create({
      data: {
        vehicleId: entry.vehicleId,
        mileage: entry.mileage,
        source: "RETURN",
        bookingId: args.bookingId,
        recordedBy: args.recordedBy,
      },
    });
    await args.tx.vehicle.update({
      where: { id: entry.vehicleId },
      data: { currentMileage: entry.mileage },
    });
    result.push({ vehicleId: entry.vehicleId, logId: log.id, mileage: entry.mileage });
  }
  return result;
}
