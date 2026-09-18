/**
 * «На полке должно быть» — одна формула на всю систему (спека §3):
 *
 *   expected = max(0, total − issued − calendar − repair − lost)
 *
 *  - total    — `Equipment.totalQuantity`;
 *  - issued   — Σ `BookingItem.quantity` броней в статусе ISSUED (у клиента),
 *               НЕЗАВИСИМО от дат: просроченная бронь, которую не приняли, всё
 *               равно держит оборудование вне склада;
 *  - calendar — Σ `BookingItem.quantity` броней CONFIRMED, у которых момент `at`
 *               попадает в [startDate; endDate]: по календарю они на съёмке, но
 *               выдачу никто не отметил. Считать их «на полке» значило бы
 *               записать в недостачу то, что просто уехало без кнопки;
 *  - repair   — безъюнитные активные ремонты (`getRepairCountByEquipmentMap`);
 *  - lost     — открытые безъюнитные потеряшки (`getLostCountByEquipmentMap`).
 *
 * Архивные брони (`deletedAt != null`) не держат ничего — как и в доступности.
 *
 * Все выборки батчем по списку позиций: инвентаризация на 300 позиций — это
 * четыре запроса, а не полторы тысячи.
 */

import { prisma } from "../../prisma";
import { getLostCountByEquipmentMap, getRepairCountByEquipmentMap } from "../availability";
import type { Breakdown, CalendarBooking } from "./types";

type TxClient = Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">;

export type ExpectedOnShelf = Breakdown & { calendarBookings: CalendarBooking[] };

/** Пустая разбивка — для строки, чья позиция удалена из каталога. */
export const EMPTY_BREAKDOWN: Breakdown = Object.freeze({
  total: 0,
  issued: 0,
  calendar: 0,
  repair: 0,
  lost: 0,
  expected: 0,
}) as Breakdown;

export function computeExpectedValue(parts: Omit<Breakdown, "expected">): number {
  return Math.max(0, parts.total - parts.issued - parts.calendar - parts.repair - parts.lost);
}

/**
 * Разбивка «на полке должно быть» на момент `at` для каждой позиции из списка.
 * Позиции, которых нет в каталоге, в карту не попадают.
 */
export async function computeExpectedOnShelf(
  equipmentIds: string[],
  at: Date,
  tx: TxClient = prisma,
): Promise<Map<string, ExpectedOnShelf>> {
  const result = new Map<string, ExpectedOnShelf>();
  const ids = Array.from(new Set(equipmentIds));
  if (ids.length === 0) return result;

  // Последовательно, а не Promise.all: функция зовётся и внутри интерактивной
  // транзакции, а у неё одно соединение — параллельные запросы там всё равно
  // выстраиваются в очередь, только с лишним риском для SQLite.
  const equipments = await tx.equipment.findMany({
    where: { id: { in: ids } },
    select: { id: true, totalQuantity: true },
  });
  const items = await tx.bookingItem.findMany({
    where: {
      equipmentId: { in: ids },
      booking: {
        deletedAt: null,
        OR: [
          { status: "ISSUED" },
          { status: "CONFIRMED", startDate: { lte: at }, endDate: { gte: at } },
        ],
      },
    },
    select: {
      equipmentId: true,
      quantity: true,
      booking: {
        select: {
          id: true,
          status: true,
          projectName: true,
          endDate: true,
          client: { select: { name: true } },
        },
      },
    },
    orderBy: [{ booking: { endDate: "asc" } }, { bookingId: "asc" }],
  });
  const repairMap = await getRepairCountByEquipmentMap(ids, tx);
  const lostMap = await getLostCountByEquipmentMap(ids, tx);

  const issuedBy = new Map<string, number>();
  const calendarBy = new Map<string, number>();
  const calendarBookingsBy = new Map<string, CalendarBooking[]>();
  for (const item of items) {
    const equipmentId = item.equipmentId;
    if (!equipmentId) continue;
    if (item.booking.status === "ISSUED") {
      issuedBy.set(equipmentId, (issuedBy.get(equipmentId) ?? 0) + item.quantity);
      continue;
    }
    calendarBy.set(equipmentId, (calendarBy.get(equipmentId) ?? 0) + item.quantity);
    const list = calendarBookingsBy.get(equipmentId) ?? [];
    list.push({
      bookingId: item.booking.id,
      projectName: item.booking.projectName,
      clientName: item.booking.client.name,
      quantity: item.quantity,
      endDate: item.booking.endDate.toISOString(),
    });
    calendarBookingsBy.set(equipmentId, list);
  }

  for (const eq of equipments) {
    const parts = {
      total: eq.totalQuantity,
      issued: issuedBy.get(eq.id) ?? 0,
      calendar: calendarBy.get(eq.id) ?? 0,
      repair: repairMap.get(eq.id) ?? 0,
      lost: lostMap.get(eq.id) ?? 0,
    };
    result.set(eq.id, {
      ...parts,
      expected: computeExpectedValue(parts),
      calendarBookings: calendarBookingsBy.get(eq.id) ?? [],
    });
  }
  return result;
}

/** Разбивка без списка броней — для снапшота и для «на полке сейчас». */
export function toBreakdown(e: ExpectedOnShelf): Breakdown {
  return {
    total: e.total,
    issued: e.issued,
    calendar: e.calendar,
    repair: e.repair,
    lost: e.lost,
    expected: e.expected,
  };
}
