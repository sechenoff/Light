/**
 * «Как пропало» — след позиции между пересчётами (спека §5).
 *
 * Недостачу на полке объясняют брони, которые брали позицию после прошлой сверки,
 * и то, КАК их принимали. Приёмка в киоске подтверждает только свою бронь (что
 * приехало ровно то, что уехало), но не склад целиком, поэтому окно сужает лишь
 * инвентаризация (`Equipment.lastCountedAt`), а не приёмка.
 *
 * Режимы приёмки (`returnMode`):
 *  - KIOSK  — есть завершённая сессия возврата в киоске; `returnedBy` — кладовщик,
 *             замечания — потеряшки и ремонты по этой позиции этой брони;
 *  - AUTO   — возврат отметила система (аудит `BOOKING_RETURNED` от `_system_`);
 *  - MANUAL — возврат отметили кнопкой без пересчёта (любой другой аудит
 *             `BOOKING_RETURNED`) или бронь RETURNED без следа вовсе; сюда же —
 *             CONFIRMED с endDate < at: ни выдача, ни возврат не отмечены, а по
 *             формуле §3 оборудование уже на полке (`returnedBy = null`, статус
 *             остаётся CONFIRMED — по нему UI отличает «срок вышел, возврат не
 *             отмечен» от «вернули кнопкой»);
 *  - OUT    — бронь ещё у клиента по формуле §3: ISSUED или CONFIRMED, у которой
 *             `at` внутри [startDate; endDate].
 *
 * Кандидаты «с этой брони и ушло» — брони в окне, принятые НЕ через киоск; если
 * такой ровно один, он и есть подсказка. Исключены только брони OUT: лишь их
 * количество уже вычтено из «на полке должно быть».
 *
 * Все выборки — батчем по списку броней окна, без запроса на бронь.
 */

import type { BookingStatus, Prisma } from "@prisma/client";

import { prisma } from "../../prisma";
import { HttpError } from "../../utils/errors";
import { computeExpectedOnShelf, toBreakdown, EMPTY_BREAKDOWN } from "./expected";
import type { EquipmentTrail, ReturnMode, TrailBooking, TrailOpenProblem } from "./types";

/** Окно по умолчанию, если позиция ни разу не сверялась. */
export const TRAIL_DEFAULT_WINDOW_DAYS = 60;
/** Сколько броней отдаём в ответе. */
export const TRAIL_MAX_BOOKINGS = 50;
/**
 * Сколько броней окна разбираем для счётчиков (всего / принято в киоске /
 * кандидаты). Больше, чем отдаём, — иначе «принято в киоске 12 из 50» врало бы
 * при 80 бронях. Потолок страхует от патологического окна.
 */
const TRAIL_SCAN_CAP = 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
const TRAIL_STATUSES: BookingStatus[] = ["ISSUED", "RETURNED", "CONFIRMED"];

export interface EquipmentTrailOptions {
  /**
   * Начало окна.
   *  - Date      — явно (например, закрытие прошлой инвентаризации с этой позицией);
   *  - null      — прошлой сверки не было: окно по умолчанию от `at`, без
   *                оглядки на `lastCountedAt`;
   *  - undefined — `equipment.lastCountedAt`, а без него окно по умолчанию.
   */
  since?: Date | null;
  /** Момент, на который строится след. По умолчанию — сейчас. */
  at?: Date;
}

/** Возврат, отмеченный системой: пользователь `_system_` / `system…`. */
function isSystemUsername(username: string): boolean {
  return username.startsWith("system") || username.startsWith("_system");
}

/** Условие «строка относится к позиции» для потеряшек: прямо, через бронь или через единицу. */
function problemOfEquipment(equipmentId: string): Prisma.ProblemItemWhereInput {
  return {
    OR: [
      { equipmentId },
      { bookingItem: { equipmentId } },
      { equipmentUnit: { equipmentId } },
    ],
  };
}

function repairOfEquipment(equipmentId: string): Prisma.RepairWhereInput {
  return {
    OR: [{ equipmentId }, { bookingItem: { equipmentId } }, { unit: { equipmentId } }],
  };
}

export async function getEquipmentTrail(
  equipmentId: string,
  opts: EquipmentTrailOptions = {},
): Promise<EquipmentTrail> {
  const at = opts.at ?? new Date();

  const equipment = await prisma.equipment.findUnique({
    where: { id: equipmentId },
    select: { id: true, name: true, category: true, lastCountedAt: true },
  });
  if (!equipment) throw new HttpError(404, "Позиция не найдена", "EQUIPMENT_NOT_FOUND");

  const defaultFrom = new Date(at.getTime() - TRAIL_DEFAULT_WINDOW_DAYS * DAY_MS);
  let windowFrom: Date;
  let windowIsDefault: boolean;
  if (opts.since instanceof Date) {
    windowFrom = opts.since;
    windowIsDefault = false;
  } else if (opts.since === null) {
    windowFrom = defaultFrom;
    windowIsDefault = true;
  } else {
    windowFrom = equipment.lastCountedAt ?? defaultFrom;
    windowIsDefault = equipment.lastCountedAt == null;
  }

  const items = await prisma.bookingItem.findMany({
    where: {
      equipmentId,
      booking: {
        deletedAt: null,
        status: { in: TRAIL_STATUSES },
        startDate: { lte: at },
        endDate: { gte: windowFrom },
      },
    },
    select: {
      quantity: true,
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
    orderBy: [{ booking: { startDate: "desc" } }, { bookingId: "desc" }],
    take: TRAIL_SCAN_CAP,
  });

  const returnedIds = items.filter((i) => i.booking.status === "RETURNED").map((i) => i.booking.id);

  // Киоск: последняя завершённая сессия возврата по брони.
  const kioskByBooking = new Map<string, string>();
  if (returnedIds.length > 0) {
    const sessions = await prisma.scanSession.findMany({
      where: { bookingId: { in: returnedIds }, operation: "RETURN", status: "COMPLETED" },
      select: { bookingId: true, workerName: true },
      orderBy: [{ completedAt: "desc" }, { startedAt: "desc" }],
    });
    for (const s of sessions) {
      if (!kioskByBooking.has(s.bookingId)) kioskByBooking.set(s.bookingId, s.workerName);
    }
  }

  // Кнопка / система: последняя запись аудита BOOKING_RETURNED по брони.
  const returnedByAudit = new Map<string, string>();
  const nonKioskReturnedIds = returnedIds.filter((id) => !kioskByBooking.has(id));
  if (nonKioskReturnedIds.length > 0) {
    const audits = await prisma.auditEntry.findMany({
      where: { entityType: "Booking", action: "BOOKING_RETURNED", entityId: { in: nonKioskReturnedIds } },
      select: { entityId: true, user: { select: { username: true } } },
      orderBy: { createdAt: "desc" },
    });
    for (const a of audits) {
      if (!returnedByAudit.has(a.entityId)) returnedByAudit.set(a.entityId, a.user.username);
    }
  }

  // Замечания приёмки в киоске — только по этой позиции этой брони.
  const kioskIds = Array.from(kioskByBooking.keys());
  const problemQtyByBooking = new Map<string, number>();
  const repairQtyByBooking = new Map<string, number>();
  if (kioskIds.length > 0) {
    const problems = await prisma.problemItem.findMany({
      where: { sourceBookingId: { in: kioskIds }, ...problemOfEquipment(equipmentId) },
      select: { sourceBookingId: true, quantity: true },
    });
    for (const p of problems) {
      if (!p.sourceBookingId) continue;
      problemQtyByBooking.set(p.sourceBookingId, (problemQtyByBooking.get(p.sourceBookingId) ?? 0) + p.quantity);
    }
    const repairs = await prisma.repair.findMany({
      where: { sourceBookingId: { in: kioskIds }, ...repairOfEquipment(equipmentId) },
      select: { sourceBookingId: true, quantity: true },
    });
    for (const r of repairs) {
      if (!r.sourceBookingId) continue;
      repairQtyByBooking.set(r.sourceBookingId, (repairQtyByBooking.get(r.sourceBookingId) ?? 0) + r.quantity);
    }
  }

  const allBookings: TrailBooking[] = items.map((item) => {
    const b = item.booking;
    let returnMode: ReturnMode;
    let returnedBy: string | null = null;
    let remarks: TrailBooking["remarks"] = null;
    // «Ещё у клиента» — ровно те брони, что формула §3 вычитает из полки на `at`:
    // ISSUED независимо от дат и CONFIRMED, у которой `at` внутри [startDate; endDate]
    // (startDate ≤ at уже в выборке). Иначе след и «на полке должно быть» разошлись бы.
    const stillOut = b.status === "ISSUED" || (b.status === "CONFIRMED" && b.endDate.getTime() >= at.getTime());
    if (stillOut) {
      returnMode = "OUT";
    } else if (b.status !== "RETURNED") {
      // CONFIRMED и срок вышел: ни выдачу, ни возврат не отметили, а по формуле
      // оборудование уже должно быть на полке — кандидат, принять его было некому.
      returnMode = "MANUAL";
      returnedBy = null;
    } else if (kioskByBooking.has(b.id)) {
      returnMode = "KIOSK";
      returnedBy = kioskByBooking.get(b.id) ?? null;
      remarks = {
        problemQty: problemQtyByBooking.get(b.id) ?? 0,
        repairQty: repairQtyByBooking.get(b.id) ?? 0,
      };
    } else {
      const username = returnedByAudit.get(b.id) ?? null;
      returnMode = username && isSystemUsername(username) ? "AUTO" : "MANUAL";
      returnedBy = username;
    }
    return {
      bookingId: b.id,
      projectName: b.projectName,
      clientName: b.client.name,
      startDate: b.startDate.toISOString(),
      endDate: b.endDate.toISOString(),
      quantity: item.quantity,
      status: b.status,
      returnMode,
      returnedBy,
      remarks,
    };
  });

  const verifiedReturns = allBookings.filter((b) => b.returnMode === "KIOSK").length;
  const candidates = allBookings.filter((b) => b.returnMode === "MANUAL" || b.returnMode === "AUTO");
  const suggestedBookingId = candidates.length === 1 ? candidates[0]!.bookingId : null;

  const openProblemRows = await prisma.problemItem.findMany({
    where: { status: { in: ["EXPECTED", "SEARCHING"] }, ...problemOfEquipment(equipmentId) },
    select: {
      id: true,
      quantity: true,
      reason: true,
      status: true,
      createdAt: true,
      sourceBookingId: true,
      bookingItem: { select: { bookingId: true } },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const problemBookingIds = Array.from(
    new Set(
      openProblemRows
        .map((p) => p.sourceBookingId ?? p.bookingItem?.bookingId ?? null)
        .filter((id): id is string => id != null),
    ),
  );
  const projectByBooking = new Map<string, string>();
  if (problemBookingIds.length > 0) {
    const rows = await prisma.booking.findMany({
      where: { id: { in: problemBookingIds } },
      select: { id: true, projectName: true },
    });
    for (const r of rows) projectByBooking.set(r.id, r.projectName);
  }
  const openProblems: TrailOpenProblem[] = openProblemRows.map((p) => {
    const bookingId = p.sourceBookingId ?? p.bookingItem?.bookingId ?? null;
    return {
      id: p.id,
      quantity: p.quantity,
      reason: p.reason,
      status: p.status,
      createdAt: p.createdAt.toISOString(),
      projectName: bookingId ? (projectByBooking.get(bookingId) ?? null) : null,
    };
  });

  const shelf = (await computeExpectedOnShelf([equipmentId], at)).get(equipmentId);

  return {
    equipmentId: equipment.id,
    name: equipment.name,
    category: equipment.category,
    windowFrom: windowFrom.toISOString(),
    windowIsDefault,
    totalBookings: allBookings.length,
    verifiedReturns,
    bookings: allBookings.slice(0, TRAIL_MAX_BOOKINGS),
    suggestedBookingId,
    openProblems,
    onShelf: shelf ? toBreakdown(shelf) : { ...EMPTY_BREAKDOWN },
  };
}
