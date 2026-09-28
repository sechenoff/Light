/**
 * Потолок добора — «сколько ещё можно довезти в эту бронь». Одна формула для
 * всех мест, где склад отвечает на этот вопрос: поиск и «+» в киоске, степпер
 * чек-листа, положительная дельта в /complete, добор со страницы брони.
 *
 * Раньше киоск считал сам: сумма пересекающихся броней вместо пика, черновики
 * и архив занимали склад, брони на согласовании — нет, мастерская в /complete
 * не вычиталась. Поиск писал «свободно ×2», а кнопка «Добавить» — «Не хватает»
 * (24.09). Теперь всё считается поверх той же доступности, что у витрины
 * (`getAvailabilityForIds` → `computeAvailabilityRows`):
 *
 *   addCap = max(0, физически − занято чужими (пик) − уже в брони)
 *   ackCap = max(0, физически − уже в брони)
 *
 * ackCap — потолок «под ответственность»: чужую бронь подвинуть можно, а выдать
 * то, что в мастерской или потеряно, нельзя. Для штучного учёта (UNIT) оба
 * потолка не больше числа реально свободных экземпляров: агрегат по датам не
 * видит единицу, застрявшую у просроченной брони с чужими датами.
 */
import type { Prisma } from "@prisma/client";

import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";
import { BLOCKING_STATUSES, getAvailabilityForIds } from "./availability";

type Db = Prisma.TransactionClient | typeof prisma;

/** Коды ошибок потолка — общий список с разделом 2.2 плана. */
export const STOCK_CAP_CODES = {
  OVER_STOCK: "ADDON_OVER_STOCK",
  NOT_ENOUGH_UNITS: "NOT_ENOUGH_UNITS",
} as const;

export interface StockWindow {
  start: Date;
  end: Date;
}

/**
 * Окно, на которое проверяется добор.
 *
 * - `issuingNow` (киоск выдаёт сейчас или бронь уже ISSUED): с текущего момента
 *   до конца брони. Прошедшая часть брони склад уже не занимает, а позиция
 *   уезжает прямо сейчас — даже если выдача раньше срока. У просроченной
 *   выданной брони окно не пустое: [сейчас, сейчас + 1 мс).
 * - иначе (план, CONFIRMED со страницы): даты брони.
 */
export function addonWindow(
  b: { startDate: Date; endDate: Date },
  o: { issuingNow: boolean; now?: Date },
): StockWindow {
  if (!o.issuingNow) return { start: b.startDate, end: b.endDate };
  const now = o.now ?? new Date();
  return {
    start: now,
    end: new Date(Math.max(b.endDate.getTime(), now.getTime() + 1)),
  };
}

export interface AddCapInfo {
  equipmentId: string;
  /** Название позиции — для текста ADDON_OVER_STOCK. */
  name: string;
  trackingMode: "COUNT" | "UNIT";
  /** Физический склад: COUNT — всего минус потеряшки и мастерская, UNIT — пригодные единицы минус мастерская. */
  physicalStock: number;
  /** Пик занятости другими бронями в окне (блокирующие статусы, без архива, с проектными лотами). */
  occupiedByOthers: number;
  alreadyInBooking: number;
  /** UNIT: свободные экземпляры, которые можно довезти; COUNT: null. */
  freeUnits: number | null;
  /** Сколько можно добрать без подтверждения. */
  addCap: number;
  /** Сколько можно добрать «под ответственность» (подвинув чужие брони). */
  ackCap: number;
}

/**
 * Потолки добора по позициям брони на окно. Позиции, которых нет в каталоге,
 * в ответ не попадают.
 *
 * `alreadyInBooking` — переопределить «уже в брони» (например, количество со
 * степпера киоска); по умолчанию берётся `BookingItem.quantity` этой брони.
 */
export async function computeAddCaps(
  client: Db,
  a: {
    bookingId: string;
    equipmentIds: string[];
    window: StockWindow;
    alreadyInBooking?: ReadonlyMap<string, number>;
  },
): Promise<Map<string, AddCapInfo>> {
  const ids = Array.from(new Set(a.equipmentIds));
  const result = new Map<string, AddCapInfo>();
  if (ids.length === 0) return result;

  // Последовательно, а не Promise.all: внутри интерактивной транзакции запросы
  // всё равно идут по одному соединению.
  const rows = await getAvailabilityForIds({
    startDate: a.window.start,
    endDate: a.window.end,
    equipmentIds: ids,
    excludeBookingId: a.bookingId,
    tx: client,
  });
  const items = await client.bookingItem.findMany({
    where: { bookingId: a.bookingId, equipmentId: { in: ids } },
    select: { id: true, equipmentId: true, quantity: true },
  });
  const alreadyFromBooking = new Map<string, number>();
  const bookingItemIdByEquipment = new Map<string, string>();
  for (const it of items) {
    if (!it.equipmentId) continue;
    alreadyFromBooking.set(it.equipmentId, (alreadyFromBooking.get(it.equipmentId) ?? 0) + it.quantity);
    bookingItemIdByEquipment.set(it.equipmentId, it.id);
  }

  const unitEquipmentIds = Array.from(rows.values())
    .filter((r) => r.equipment.stockTrackingMode === "UNIT")
    .map((r) => r.equipment.id);
  const freeUnits = await freeUnitIdsByEquipment(client, {
    bookingId: a.bookingId,
    equipmentIds: unitEquipmentIds,
    ownBookingItemIds: unitEquipmentIds
      .map((id) => bookingItemIdByEquipment.get(id))
      .filter((id): id is string => Boolean(id)),
    start: a.window.start,
    end: a.window.end,
  });

  for (const row of rows.values()) {
    const equipmentId = row.equipment.id;
    const isUnit = row.equipment.stockTrackingMode === "UNIT";
    const physicalStock = row.baseQuantity;
    const occupiedByOthers = row.occupiedQuantity;
    const alreadyInBooking = Math.max(
      0,
      a.alreadyInBooking?.get(equipmentId) ?? alreadyFromBooking.get(equipmentId) ?? 0,
    );
    let addCap = Math.max(0, physicalStock - occupiedByOthers - alreadyInBooking);
    let ackCap = Math.max(0, physicalStock - alreadyInBooking);
    let free: number | null = null;
    if (isUnit) {
      free = freeUnits.get(equipmentId)?.length ?? 0;
      addCap = Math.min(addCap, free);
      ackCap = Math.min(ackCap, free);
    }
    result.set(equipmentId, {
      equipmentId,
      name: row.equipment.name,
      trackingMode: isUnit ? "UNIT" : "COUNT",
      physicalStock,
      occupiedByOthers,
      alreadyInBooking,
      freeUnits: free,
      addCap,
      ackCap,
    });
  }
  return result;
}

/**
 * Свободные экземпляры по позициям: статус AVAILABLE, не в живом резерве
 * пересекающейся брони (блокирующие статусы, без архива) и не в живом резерве
 * своих позиций брони. Окно полуоткрытое: бронь, закончившаяся ровно в начале
 * окна, экземпляр уже не держит. Под ответственность чужие резервы НЕ отдаём:
 * конкретная единица нужна той брони на выдаче.
 */
async function freeUnitIdsByEquipment(
  client: Db,
  a: { bookingId: string; equipmentIds: string[]; ownBookingItemIds: string[]; start: Date; end: Date },
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (a.equipmentIds.length === 0) return result;
  const takenByOthers = await client.bookingItemUnit.findMany({
    where: {
      returnedAt: null,
      equipmentUnit: { equipmentId: { in: a.equipmentIds } },
      bookingItem: {
        booking: {
          id: { not: a.bookingId },
          status: { in: BLOCKING_STATUSES },
          deletedAt: null,
          startDate: { lt: a.end },
          endDate: { gt: a.start },
        },
      },
    },
    select: { equipmentUnitId: true },
  });
  const mine = a.ownBookingItemIds.length > 0
    ? await client.bookingItemUnit.findMany({
        where: { bookingItemId: { in: a.ownBookingItemIds }, returnedAt: null },
        select: { equipmentUnitId: true },
      })
    : [];
  const excluded = new Set<string>([
    ...takenByOthers.map((r) => r.equipmentUnitId),
    ...mine.map((r) => r.equipmentUnitId),
  ]);
  const candidates = await client.equipmentUnit.findMany({
    where: { equipmentId: { in: a.equipmentIds }, status: "AVAILABLE" },
    select: { id: true, equipmentId: true },
    orderBy: { id: "asc" },
  });
  for (const u of candidates) {
    if (excluded.has(u.id)) continue;
    const list = result.get(u.equipmentId) ?? [];
    list.push(u.id);
    result.set(u.equipmentId, list);
  }
  return result;
}

/**
 * Свободные экземпляры одной UNIT-позиции, которые реально можно довезти.
 * Общая выборка для потолка и для резерва — иначе «свободно ×N» и отказ
 * NOT_ENOUGH_UNITS считали бы по разным спискам. `bookingItemId` — позиция
 * этой брони (её живые резервы не считаются свободными); null, если позиции
 * в брони ещё нет.
 */
export async function listFreeUnitIds(
  client: Db,
  a: { bookingId: string; bookingItemId: string | null; equipmentId: string; start: Date; end: Date },
): Promise<string[]> {
  const byEquipment = await freeUnitIdsByEquipment(client, {
    bookingId: a.bookingId,
    equipmentIds: [a.equipmentId],
    ownBookingItemIds: a.bookingItemId ? [a.bookingItemId] : [],
    start: a.start,
    end: a.end,
  });
  return byEquipment.get(a.equipmentId) ?? [];
}

/**
 * Резервирует под позицию `quantity` свободных экземпляров (BookingItemUnit) и,
 * если позиция уезжает прямо сейчас (`issueNow`), переводит их в ISSUED — иначе
 * на приёмке чек-лист их не покажет, а единицы останутся «доступными», хотя
 * физически у клиента. Не хватает экземпляров — 409 NOT_ENOUGH_UNITS, ничего
 * не записано.
 */
export async function reserveUnits(
  tx: Prisma.TransactionClient,
  a: {
    bookingId: string;
    bookingItemId: string;
    equipmentId: string;
    equipmentName: string;
    quantity: number;
    start: Date;
    end: Date;
    issueNow: boolean;
  },
): Promise<string[]> {
  if (a.quantity <= 0) return [];
  const free = await listFreeUnitIds(tx, {
    bookingId: a.bookingId,
    bookingItemId: a.bookingItemId,
    equipmentId: a.equipmentId,
    start: a.start,
    end: a.end,
  });
  if (free.length < a.quantity) {
    throw notEnoughUnitsError({
      equipmentId: a.equipmentId,
      name: a.equipmentName,
      available: free.length,
      requested: a.quantity,
    });
  }
  const picked = free.slice(0, a.quantity);
  await tx.bookingItemUnit.createMany({
    data: picked.map((unitId) => ({ bookingItemId: a.bookingItemId, equipmentUnitId: unitId })),
  });
  if (a.issueNow) {
    await tx.equipmentUnit.updateMany({
      where: { id: { in: picked }, status: "AVAILABLE" },
      data: { status: "ISSUED" },
    });
  }
  return picked;
}

/** 409 NOT_ENOUGH_UNITS: «“{name}”: свободных экземпляров {n}, нужно {m}». */
export function notEnoughUnitsError(a: {
  equipmentId: string;
  name: string;
  available: number;
  requested: number;
}): HttpError {
  return new HttpError(
    409,
    `«${a.name}»: свободных экземпляров ${a.available}, нужно ${a.requested}`,
    STOCK_CAP_CODES.NOT_ENOUGH_UNITS,
    { equipmentId: a.equipmentId, name: a.name, available: a.available, requested: a.requested },
  );
}

/**
 * 409 ADDON_OVER_STOCK: «“{name}”: не хватает на складе — можно добрать ещё
 * {addCap}». Один текст для киоска (+, степпер, /complete) и страницы брони.
 * `bookingItemId` — строка чек-листа, которую подсветит киоск (из /complete).
 */
export function overStockError(a: {
  bookingItemId?: string;
  equipmentId: string;
  name: string;
  addCap: number;
  requested: number;
  alreadyInBooking: number;
}): HttpError {
  const addCap = Math.max(0, a.addCap);
  return new HttpError(
    409,
    `«${a.name}»: не хватает на складе — можно добрать ещё ${addCap}`,
    STOCK_CAP_CODES.OVER_STOCK,
    {
      ...(a.bookingItemId ? { bookingItemId: a.bookingItemId } : {}),
      equipmentId: a.equipmentId,
      name: a.name,
      addCap,
      requested: a.requested,
      alreadyInBooking: a.alreadyInBooking,
    },
  );
}
