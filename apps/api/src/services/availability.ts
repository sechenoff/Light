import type { Equipment, BookingStatus } from "@prisma/client";

import { prisma } from "../prisma";
import { getMergedCategoryOrder } from "./categoryOrder";
import { compareEquipmentTransportLast } from "../utils/equipmentSort";

type TxClient = Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">;

export type AvailabilityRow = {
  equipment: Pick<
    Equipment,
    | "id"
    | "category"
    | "name"
    | "brand"
    | "model"
    | "stockTrackingMode"
    | "sortOrder"
    | "totalQuantity"
    | "rentalRatePerShift"
    | "comment"
  >;
  occupiedQuantity: number;
  availableQuantity: number;
};

// MF-1: PENDING_APPROVAL резервирует оборудование наравне с CONFIRMED/ISSUED —
// бронь, отправленная на согласование, в одном клике от подтверждения и не должна
// продаваться второй раз, пока руководитель её рассматривает. DRAFT по-прежнему
// не блокирует (осознанное решение). ВАЖНО: confirmBooking передаёт
// excludeBookingId, чтобы PENDING_APPROVAL-бронь не блокировала собственный approve.
const BLOCKING_STATUSES: BookingStatus[] = ["PENDING_APPROVAL", "CONFIRMED", "ISSUED"];

function clampNonNegative(n: number) {
  return n < 0 ? 0 : n;
}

/**
 * eu-2: для UNIT-позиций база доступности = число ПРИГОДНЫХ к выдаче единиц
 * (статус AVAILABLE или ISSUED), а НЕ totalQuantity. totalQuantity у UNIT —
 * служебный счётчик, включающий MAINTENANCE/RETIRED/MISSING; нерабочие единицы
 * не должны раздувать «Доступно». Переиспользуется календарём (/api/calendar),
 * чтобы календарь и проверка доступности считали одинаково.
 */
export async function getUsableUnitBaseMap(
  unitEquipmentIds: string[],
  tx: TxClient = prisma
): Promise<Map<string, number>> {
  const usableUnitBase = new Map<string, number>();
  if (unitEquipmentIds.length === 0) return usableUnitBase;
  const grouped = await tx.equipmentUnit.groupBy({
    by: ["equipmentId"],
    where: { equipmentId: { in: unitEquipmentIds }, status: { in: ["AVAILABLE", "ISSUED"] } },
    _count: { _all: true },
  });
  for (const g of grouped) usableUnitBase.set(g.equipmentId, g._count._all);
  return usableUnitBase;
}

/**
 * F-LOST-1: сколько единиц COUNT-позиции сейчас безвозвратно вне оборота из-за
 * открытых «потеряшек». UNIT-потеряшка честно выводит юнит (status MISSING) и уже
 * учтена в usableUnitBase. Для COUNT нет юнита — потеря живёт строкой ProblemItem
 * (bookingItemId + quantity, equipmentUnitId = null). Пока карточка не закрыта как
 * FOUND (найдено, вернулось в оборот), это количество физически недоступно и должно
 * уменьшать эффективный totalQuantity — иначе календарь и проверка доступности
 * продолжают «продавать» утерянное. equipmentId берём с bookingItem, не с самой
 * потеряшки. WROTE_OFF/NOT_FOUND/SEARCHING/EXPECTED — все «не в наличии»; только
 * FOUND исключаем.
 */
export async function getLostCountByEquipmentMap(
  countEquipmentIds: string[],
  tx: TxClient = prisma
): Promise<Map<string, number>> {
  const lostByEquipment = new Map<string, number>();
  if (countEquipmentIds.length === 0) return lostByEquipment;
  const lostRows = await tx.problemItem.findMany({
    where: {
      equipmentUnitId: null,
      status: { not: "FOUND" },
      bookingItem: { equipmentId: { in: countEquipmentIds } },
    },
    select: { quantity: true, bookingItem: { select: { equipmentId: true } } },
  });
  for (const row of lostRows) {
    const equipmentId = row.bookingItem?.equipmentId;
    if (!equipmentId) continue;
    lostByEquipment.set(equipmentId, (lostByEquipment.get(equipmentId) ?? 0) + row.quantity);
  }
  return lostByEquipment;
}

export async function getAvailability(args: {
  startDate: Date;
  endDate: Date;
  equipmentIds?: string[];
  search?: string;
  category?: string;
  excludeBookingId?: string;
  tx?: TxClient;
}) {
  const tx = args.tx ?? prisma;
  const searchNeedle = args.search?.trim().toLocaleLowerCase("ru-RU") ?? "";

  const categoryOrder = await getMergedCategoryOrder();

  const rawEquipments = await tx.equipment.findMany({
    where: {
      ...(args.equipmentIds ? { id: { in: args.equipmentIds } } : {}),
      ...(args.category ? { category: args.category } : {}),
    },
    orderBy: { id: "asc" },
    select: {
      id: true,
      category: true,
      name: true,
      brand: true,
      model: true,
      stockTrackingMode: true,
      sortOrder: true,
      totalQuantity: true,
      rentalRatePerShift: true,
      comment: true,
    },
  });
  const equipments =
    searchNeedle.length === 0
      ? rawEquipments
      : rawEquipments.filter((e) => {
          const haystack = [e.name, e.brand ?? "", e.model ?? "", e.category]
            .join(" ")
            .toLocaleLowerCase("ru-RU");
          return haystack.includes(searchNeedle);
        });

  equipments.sort((a, b) => compareEquipmentTransportLast(a, b, categoryOrder));

  if (equipments.length === 0) return [] as AvailabilityRow[];

  const equipmentIds = equipments.map((e) => e.id);

  // eu-2: см. getUsableUnitBaseMap. F-LOST-1: COUNT-база = totalQuantity минус
  // открытые COUNT-потеряшки (getLostCountByEquipmentMap) — утерянное безъюнитное
  // количество не должно оставаться в наличии.
  const unitEquipmentIds = equipments.filter((e) => e.stockTrackingMode === "UNIT").map((e) => e.id);
  const countEquipmentIds = equipments.filter((e) => e.stockTrackingMode !== "UNIT").map((e) => e.id);
  const usableUnitBase = await getUsableUnitBaseMap(unitEquipmentIds, tx);
  const lostCountBase = await getLostCountByEquipmentMap(countEquipmentIds, tx);
  const baseQtyOf = (e: { id: string; stockTrackingMode: string; totalQuantity: number }): number =>
    e.stockTrackingMode === "UNIT"
      ? (usableUnitBase.get(e.id) ?? 0)
      : clampNonNegative(e.totalQuantity - (lostCountBase.get(e.id) ?? 0));

  // Find all blocking bookings overlapping the requested range.
  const overlappingBookings = await tx.booking.findMany({
    where: {
      status: { in: BLOCKING_STATUSES },
      // RR-2: архивные (soft-deleted) брони не занимают доступность.
      deletedAt: null,
      startDate: { lte: args.endDate },
      endDate: { gte: args.startDate },
      ...(args.excludeBookingId ? { id: { not: args.excludeBookingId } } : {}),
    },
    select: { id: true },
  });
  const overlappingBookingIds = overlappingBookings.map((b) => b.id);

  if (overlappingBookingIds.length === 0) {
    return equipments.map((e) => ({
      equipment: e,
      occupiedQuantity: 0,
      availableQuantity: baseQtyOf(e),
    }));
  }

  const bookingItems = await tx.bookingItem.findMany({
    where: {
      bookingId: { in: overlappingBookingIds },
      equipmentId: { in: equipmentIds },
    },
    select: {
      id: true,
      equipmentId: true,
      quantity: true,
    },
  });

  // Count-based occupancy: sum BookingItem.quantity.
  const occupiedCountByEquipment = new Map<string, number>();
  for (const bi of bookingItems) {
    if (!bi.equipmentId) continue;
    occupiedCountByEquipment.set(bi.equipmentId, (occupiedCountByEquipment.get(bi.equipmentId) ?? 0) + bi.quantity);
  }

  // Unit-based occupancy: count distinct reserved equipment units via BookingItemUnit.
  const bookingItemIds = bookingItems.map((b) => b.id);
  const bookingItemIdToEquipmentId = new Map<string, string>();
  for (const bi of bookingItems) {
    if (bi.equipmentId) bookingItemIdToEquipmentId.set(bi.id, bi.equipmentId);
  }

  const occupiedUnitsByEquipment = new Map<string, Set<string>>();
  if (bookingItemIds.length > 0) {
    const reserved = await tx.bookingItemUnit.findMany({
      where: { bookingItemId: { in: bookingItemIds } },
      select: { bookingItemId: true, equipmentUnitId: true },
    });
    for (const r of reserved) {
      const equipmentId = bookingItemIdToEquipmentId.get(r.bookingItemId);
      if (!equipmentId) continue;
      if (!occupiedUnitsByEquipment.has(equipmentId)) occupiedUnitsByEquipment.set(equipmentId, new Set());
      occupiedUnitsByEquipment.get(equipmentId)!.add(r.equipmentUnitId);
    }
  }

  return equipments.map((e) => {
    // WSU-1: для UNIT-режима occupied = max(число зарезервированных юнитов,
    // сумма quantity по BookingItem). Quick-add/inline-добор со склада увеличивают
    // quantity БЕЗ создания BookingItemUnit — если считать только по резервациям,
    // добранное количество не занимает доступность и возможна двойная выдача.
    const occupied =
      e.stockTrackingMode === "UNIT"
        ? Math.max(occupiedUnitsByEquipment.get(e.id)?.size ?? 0, occupiedCountByEquipment.get(e.id) ?? 0)
        : (occupiedCountByEquipment.get(e.id) ?? 0);
    const available = clampNonNegative(baseQtyOf(e) - occupied);
    return {
      equipment: e,
      occupiedQuantity: occupied,
      availableQuantity: available,
    };
  });
}

