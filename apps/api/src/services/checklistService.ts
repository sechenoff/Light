/**
 * Сервис чек-листа склада (без сканера).
 *
 * Кладовщик отмечает позиции вручную. Для каждой позиции хранится «ручная» ScanRecord
 * с hmacVerified=false. COUNT-позиции хранят количество в поле payloadRaw.
 *
 * Ключевые операции:
 * - checkItem — отметить позицию (COUNT целиком или частично, UNIT по unitId)
 * - uncheckItem — снять отметку
 * - getChecklistState — текущее состояние чек-листа для сессии
 * - addExtraItem — добавить позицию из каталога прямо во время выдачи
 */

import { prisma } from "../prisma";
import { writeAuditEntry } from "./audit";
import { recomputeBookingFinance } from "./finance";
import { HttpError } from "../utils/errors";
import Decimal from "decimal.js";

type TxClient = Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">;

// ── Типы ────────────────────────────────────────────────────────────────────────

export interface ChecklistItem {
  bookingItemId: string;
  equipmentId: string | null;
  equipmentName: string;
  category: string;
  quantity: number;             // required qty
  checkedQty: number;           // how many marked (for COUNT)
  trackingMode: "COUNT" | "UNIT";
  isExtra: boolean;             // added on-site during this session
  units?: ChecklistUnit[];      // only for UNIT-mode items
}

export interface ChecklistUnit {
  unitId: string;
  barcode: string | null;
  checked: boolean;
  problemType: "BROKEN" | "LOST" | null;
}

export interface ChecklistState {
  sessionId: string;
  bookingId: string;
  operation: "ISSUE" | "RETURN";
  items: ChecklistItem[];
  progress: {
    checkedItems: number;   // items fully checked
    totalItems: number;     // total logical items
  };
}

// ── Вспомогательные функции ──────────────────────────────────────────────────────

/**
 * Формирует ключ для ScanRecord COUNT-позиций.
 * Для COUNT-позиций нет реального unitId, поэтому используем виртуальный составной ключ.
 * Формат: "count:{bookingItemId}"
 */
function countRecordKey(bookingItemId: string): string {
  return `count:${bookingItemId}`;
}

// Checklist state model:
// - COUNT positions: client-managed (no per-event tracking) — qty + checked count.
// - UNIT positions: persisted via ScanRecord (one record per unit checked).
// Frontend optimistically updates; server is authoritative on tap-confirm.

// ── getChecklistState ────────────────────────────────────────────────────────────

export async function getChecklistState(sessionId: string): Promise<ChecklistState> {
  const session = await prisma.scanSession.findUnique({
    where: { id: sessionId },
    include: {
      scans: true,
      booking: {
        include: {
          items: {
            orderBy: { createdAt: "asc" },
            include: {
              equipment: {
                select: {
                  id: true,
                  name: true,
                  category: true,
                  stockTrackingMode: true,
                },
              },
              unitReservations: {
                include: {
                  equipmentUnit: {
                    select: { id: true, barcode: true, status: true },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  if (!session) throw new HttpError(404, "Сессия не найдена", "SESSION_NOT_FOUND");

  const scannedUnitIds = new Set(session.scans.map((s) => s.equipmentUnitId));

  // Для операции RETURN: дополнительно находим все UNIT юниты, связанные с бронью
  // (BookingItemUnit с returnedAt=null)
  let issuedUnitsByBookingItem: Map<string, Array<{ id: string; barcode: string | null; status: string }>> | null = null;

  if (session.operation === "RETURN") {
    const reservations = await prisma.bookingItemUnit.findMany({
      where: {
        bookingItem: { bookingId: session.bookingId },
        returnedAt: null,
      },
      include: {
        equipmentUnit: { select: { id: true, barcode: true, status: true } },
      },
    });
    issuedUnitsByBookingItem = new Map();
    for (const r of reservations) {
      const existing = issuedUnitsByBookingItem.get(r.bookingItemId) ?? [];
      existing.push({
        id: r.equipmentUnit.id,
        barcode: r.equipmentUnit.barcode,
        status: r.equipmentUnit.status,
      });
      issuedUnitsByBookingItem.set(r.bookingItemId, existing);
    }
  }

  const items: ChecklistItem[] = [];
  let totalItems = 0;
  let checkedItems = 0;

  for (const bi of session.booking.items) {
    const mode = bi.equipment?.stockTrackingMode as "COUNT" | "UNIT" | undefined ?? "COUNT";
    const isExtra = !bi.equipmentId || bi.customName != null;

    if (mode === "UNIT" && bi.equipmentId) {
      // UNIT-позиция: каждый юнит — отдельный checkbox
      let units: Array<{ id: string; barcode: string | null; status: string }> = [];

      if (session.operation === "ISSUE") {
        // При выдаче: зарезервированные юниты
        units = bi.unitReservations
          .filter((r) => r.equipmentUnit?.status === "AVAILABLE" || scannedUnitIds.has(r.equipmentUnit?.id ?? ""))
          .map((r) => ({
            id: r.equipmentUnit.id,
            barcode: r.equipmentUnit.barcode,
            status: r.equipmentUnit.status,
          }));

        // Если нет резерваций — не показываем юниты (покажем только qty)
        if (units.length === 0) {
          // fallback: используем quantity как количество
          for (let i = 0; i < bi.quantity; i++) {
            units.push({
              id: `placeholder-${bi.id}-${i}`,
              barcode: null,
              status: "AVAILABLE",
            });
          }
        }
      } else {
        // При возврате: выданные юниты
        units = issuedUnitsByBookingItem?.get(bi.id) ?? [];
      }

      const checkedUnits = units.filter((u) => scannedUnitIds.has(u.id));
      const allChecked = units.length > 0 && checkedUnits.length >= units.length;

      totalItems += units.length;
      checkedItems += checkedUnits.length;

      items.push({
        bookingItemId: bi.id,
        equipmentId: bi.equipmentId,
        equipmentName: bi.equipment?.name ?? "Неизвестно",
        category: bi.equipment?.category ?? "Без категории",
        quantity: bi.quantity,
        checkedQty: checkedUnits.length,
        trackingMode: "UNIT",
        isExtra: false,
        units: units.map((u) => ({
          unitId: u.id,
          barcode: u.barcode,
          checked: scannedUnitIds.has(u.id),
          problemType: null,
        })),
      });
    } else if (bi.customName) {
      // Произвольная позиция (добавлена на месте)
      // COUNT-чекбокс, считаем «все или ничего» — сервер не хранит state для COUNT
      // Отдаём quantity, checkedQty = 0 (клиент управляет локально)
      totalItems += 1;
      items.push({
        bookingItemId: bi.id,
        equipmentId: null,
        equipmentName: bi.customName,
        category: "Добавлено на месте",
        quantity: bi.quantity,
        checkedQty: 0, // клиент управляет локально
        trackingMode: "COUNT",
        isExtra: true,
      });
    } else {
      // COUNT-позиция из каталога
      totalItems += 1;
      items.push({
        bookingItemId: bi.id,
        equipmentId: bi.equipmentId,
        equipmentName: bi.equipment?.name ?? "Неизвестно",
        category: bi.equipment?.category ?? "Без категории",
        quantity: bi.quantity,
        checkedQty: 0, // клиент управляет локально
        trackingMode: "COUNT",
        isExtra: false,
      });
    }
  }

  return {
    sessionId: session.id,
    bookingId: session.bookingId,
    operation: session.operation as "ISSUE" | "RETURN",
    items,
    progress: { checkedItems, totalItems },
  };
}

// ── checkUnit ────────────────────────────────────────────────────────────────────

/**
 * Отмечает UNIT-позицию как выданную/принятую.
 * Создаёт ScanRecord с hmacVerified=false (ручной чек-лист).
 */
export async function checkUnit(
  sessionId: string,
  equipmentUnitId: string,
): Promise<{ alreadyChecked: boolean }> {
  const session = await prisma.scanSession.findUnique({
    where: { id: sessionId },
  });
  if (!session || session.status !== "ACTIVE") {
    throw new HttpError(409, "Сессия не активна", "SESSION_NOT_FOUND");
  }

  // Проверяем что юнит принадлежит броне
  const unit = await prisma.equipmentUnit.findUnique({
    where: { id: equipmentUnitId },
    include: { equipment: true },
  });
  if (!unit) throw new HttpError(404, "Единица оборудования не найдена", "UNIT_NOT_FOUND");

  // Проверяем, что есть BookingItem для этой брони и конкретный unit зарезервирован
  const bookingItem = await prisma.bookingItem.findFirst({
    where: {
      bookingId: session.bookingId,
      equipmentId: unit.equipmentId,
    },
    include: { unitReservations: { select: { equipmentUnitId: true } } },
  });
  if (!bookingItem) throw new HttpError(409, "Оборудование не входит в эту бронь", "UNIT_NOT_IN_BOOKING");

  // I3: Проверяем что конкретный unit зарезервирован в этой броне (для RETURN-операций)
  // Для ISSUE достаточно проверки оборудования — юниты могут быть заменены
  if (session.operation === "RETURN") {
    const isReserved = bookingItem.unitReservations.some(
      (r) => r.equipmentUnitId === equipmentUnitId,
    );
    if (!isReserved) {
      throw new HttpError(409, "Этот юнит не зарезервирован в этой броне", "UNIT_NOT_RESERVED");
    }
  }

  // Идемпотентность: если уже отмечено — no-op
  try {
    await prisma.scanRecord.create({
      data: {
        sessionId,
        equipmentUnitId,
        hmacVerified: false,
      },
    });
    return { alreadyChecked: false };
  } catch (err: any) {
    if (err?.code === "P2002") {
      return { alreadyChecked: true };
    }
    throw err;
  }
}

// ── uncheckUnit ──────────────────────────────────────────────────────────────────

/**
 * Снимает отметку с UNIT-позиции.
 */
export async function uncheckUnit(
  sessionId: string,
  equipmentUnitId: string,
): Promise<{ wasChecked: boolean }> {
  const session = await prisma.scanSession.findUnique({
    where: { id: sessionId },
  });
  if (!session || session.status !== "ACTIVE") {
    throw new HttpError(409, "Сессия не активна", "SESSION_NOT_ACTIVE");
  }

  const existing = await prisma.scanRecord.findUnique({
    where: {
      sessionId_equipmentUnitId: { sessionId, equipmentUnitId },
    },
  });

  if (!existing) {
    return { wasChecked: false };
  }

  await prisma.scanRecord.delete({
    where: {
      sessionId_equipmentUnitId: { sessionId, equipmentUnitId },
    },
  });

  return { wasChecked: true };
}

// ── addExtraItem ─────────────────────────────────────────────────────────────────

/**
 * Добавляет позицию из каталога в бронь во время выдачи (quick-add).
 * Создаёт BookingItem, пересчитывает финансы, пишет аудит.
 * Возвращает новый bookingItemId.
 */
export async function addExtraItem(
  sessionId: string,
  equipmentId: string,
  quantity: number,
  createdBy: string,
): Promise<{ bookingItemId: string }> {
  const session = await prisma.scanSession.findUnique({
    where: { id: sessionId },
    select: { id: true, status: true, bookingId: true },
  });
  if (!session || session.status !== "ACTIVE") {
    throw new HttpError(409, "Сессия не активна", "SESSION_NOT_FOUND");
  }

  const equipment = await prisma.equipment.findUnique({
    where: { id: equipmentId },
  });
  if (!equipment) throw new HttpError(404, "Оборудование не найдено", "EQUIPMENT_NOT_FOUND");

  const bookingId = session.bookingId;

  // I1: атомарный upsert с проверкой статуса брони
  const bookingItemId = await prisma.$transaction(async (tx: TxClient) => {
    const booking = await tx.booking.findUnique({
      where: { id: bookingId },
      select: { status: true },
    });
    if (!booking) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");
    if (!["DRAFT", "CONFIRMED", "ISSUED"].includes(booking.status)) {
      throw new HttpError(
        409,
        `Нельзя добавлять позиции в бронь со статусом ${booking.status}`,
        "BOOKING_LOCKED",
      );
    }

    // Atomic upsert через @@unique([bookingId, equipmentId]) — предотвращает race condition
    const item = await tx.bookingItem.upsert({
      where: { bookingId_equipmentId: { bookingId, equipmentId } },
      update: { quantity: { increment: quantity } },
      create: { bookingId, equipmentId, quantity },
    });

    return item.id;
  });

  // Аудит вне транзакции (observability, не бизнес-инвариант)
  await writeAuditEntry({
    userId: createdBy,
    action: "BOOKING_ITEM_ADDED_ON_SITE",
    entityType: "Booking",
    entityId: bookingId,
    before: null,
    after: { equipmentId, equipmentName: equipment.name, quantity, bookingItemId },
  }).catch((err: unknown) => {
    console.warn("[addExtraItem] audit failed:", err);
  });

  // Пересчитываем финансы вне транзакции (легитимно — read-modify-write)
  await recomputeBookingFinance(bookingId).catch((err: unknown) => {
    console.error("[addExtraItem] recomputeBookingFinance failed:", err);
  });

  return { bookingItemId };
}
