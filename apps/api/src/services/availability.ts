import type { Equipment, BookingStatus } from "@prisma/client";
import { lineDueAt, MAX_LINE_SHIFTS, RENTAL_SHIFT_MS } from "@light-rental/shared";

import { prisma } from "../prisma";
import { billableShifts24h } from "../utils/dates";
import { projectReservations, peakOccupancy, reservationOverlaps, type Reservation } from "./projectReservations";
import { getMergedCategoryOrder } from "./categoryOrder";
import { compareEquipmentTransportLast } from "../utils/equipmentSort";
import { searchMatches } from "../utils/searchNormalize";

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
  /**
   * Физический склад позиции — то, от чего считается «Доступно»: для COUNT
   * totalQuantity минус открытые потеряшки и безъюнитные ремонты, для UNIT
   * пригодные единицы (AVAILABLE | ISSUED) минус безъюнитные ремонты. Нужен
   * потолку «под ответственность» (stockCap): чужую бронь подвинуть можно,
   * а мастерскую и потерянное — нет.
   */
  baseQuantity: number;
  occupiedQuantity: number;
  availableQuantity: number;
};

type AvailabilityEquipment = AvailabilityRow["equipment"];

const AVAILABILITY_EQUIPMENT_SELECT = {
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
} as const;

// MF-1: PENDING_APPROVAL резервирует оборудование наравне с CONFIRMED/ISSUED —
// бронь, отправленная на согласование, в одном клике от подтверждения и не должна
// продаваться второй раз, пока руководитель её рассматривает. DRAFT по-прежнему
// не блокирует (осознанное решение). ВАЖНО: confirmBooking передаёт
// excludeBookingId, чтобы PENDING_APPROVAL-бронь не блокировала собственный approve.
// Экспортируется, чтобы мастерская считала риск по тем же статусам, что и
// витрина: разъехавшиеся копии этого списка означали бы, что «занято» на
// календаре и «блокирует бронь» в ремонте — про разные брони.
export const BLOCKING_STATUSES: BookingStatus[] = ["PENDING_APPROVAL", "CONFIRMED", "ISSUED"];

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
 * (quantity, equipmentUnitId = null). Пока карточка не закрыта как FOUND (найдено,
 * вернулось в оборот), это количество физически недоступно и должно уменьшать
 * эффективный totalQuantity — иначе календарь и проверка доступности продолжают
 * «продавать» утерянное. WROTE_OFF/NOT_FOUND/SEARCHING/EXPECTED — все «не в
 * наличии»; только FOUND исключаем.
 *
 * Позиция строки — `equipmentId ?? bookingItem.equipmentId`. Потеряшка с приёмки
 * знает позицию через свою BookingItem (исторически — ТОЛЬКО через неё; новые
 * пишут и прямой equipmentId). А у потеряшки, заведённой вручную или
 * инвентаризацией («не нашли на складе»), брони нет вовсе — позиция живёт только
 * в `equipmentId`. Раньше фильтр шёл по одному `bookingItem.equipmentId`, и такие
 * строки просто не попадали в выборку: пропажа, найденная пересчётом полки, не
 * уменьшала бы доступность, и календарь продолжал бы продавать то, чего нет.
 *
 * Строка, у которой заполнены ОБА поля, приходит из запроса одной записью (OR по
 * условиям, а не два запроса), поэтому считается ровно один раз. Если два поля
 * вдруг указывают на разные позиции, побеждает прямой `equipmentId`, и строка
 * засчитывается только той позиции — и только если её спросили.
 *
 * Функция питает календарь, дашборд, чек-листы, добор, мастерскую и
 * инвентаризацию («на полке должно быть») — все они видят новые потеряшки сразу.
 */
export async function getLostCountByEquipmentMap(
  countEquipmentIds: string[],
  tx: TxClient = prisma
): Promise<Map<string, number>> {
  const lostByEquipment = new Map<string, number>();
  if (countEquipmentIds.length === 0) return lostByEquipment;
  const requested = new Set(countEquipmentIds);
  const lostRows = await tx.problemItem.findMany({
    where: {
      equipmentUnitId: null,
      status: { not: "FOUND" },
      OR: [
        { equipmentId: { in: countEquipmentIds } },
        { bookingItem: { equipmentId: { in: countEquipmentIds } } },
      ],
    },
    select: { quantity: true, equipmentId: true, bookingItem: { select: { equipmentId: true } } },
  });
  for (const row of lostRows) {
    const equipmentId = row.equipmentId ?? row.bookingItem?.equipmentId;
    if (!equipmentId || !requested.has(equipmentId)) continue;
    lostByEquipment.set(equipmentId, (lostByEquipment.get(equipmentId) ?? 0) + row.quantity);
  }
  return lostByEquipment;
}

/**
 * F-REPAIR-1: сколько единиц позиции сейчас физически лежит в мастерской.
 *
 * Считаем ТОЛЬКО ремонты без `unitId`. Штучный ремонт переводит единицу в
 * MAINTENANCE, и она уже выпала из `getUsableUnitBaseMap` — учесть её здесь
 * значило бы вычесть один и тот же прибор дважды. Без юнита живут COUNT-поломки
 * (кабели, стойки, зарядки): одна строка Repair на `quantity` штук, статусы
 * единиц при этом не трогаются, и больше вычесть их неоткуда.
 *
 * Позицию каталога берём с `Repair.equipmentId` (заявка, заведённая из киоска
 * или из раздела мастерской), а если он пуст — через `bookingItem.equipmentId`
 * (поломка, оформленная на приёмке брони).
 *
 * Активный ремонт — любой статус, кроме CLOSED и WROTE_OFF: пока карточка
 * открыта, прибор не выдаётся. WROTE_OFF исключён потому, что списание — это
 * уже вопрос `totalQuantity`, а не временного изъятия: `writeOffRepair` у
 * безъюнитного ремонта COUNT-позиции уменьшает `totalQuantity` на его количество.
 */
export async function getRepairCountByEquipmentMap(
  equipmentIds: string[],
  tx: TxClient = prisma
): Promise<Map<string, number>> {
  const inRepairByEquipment = new Map<string, number>();
  if (equipmentIds.length === 0) return inRepairByEquipment;
  const repairRows = await tx.repair.findMany({
    where: {
      unitId: null,
      status: { notIn: ["CLOSED", "WROTE_OFF"] },
      OR: [
        { equipmentId: { in: equipmentIds } },
        { bookingItem: { equipmentId: { in: equipmentIds } } },
      ],
    },
    select: { quantity: true, equipmentId: true, bookingItem: { select: { equipmentId: true } } },
  });
  for (const row of repairRows) {
    const equipmentId = row.equipmentId ?? row.bookingItem?.equipmentId;
    if (!equipmentId) continue;
    inRepairByEquipment.set(equipmentId, (inRepairByEquipment.get(equipmentId) ?? 0) + row.quantity);
  }
  return inRepairByEquipment;
}

/**
 * Интервал, в который бронь занимает склад, — полуоткрытый [start, end):
 * бронь до 12:00 и бронь с 12:00 того же дня не пересекаются (стык-в-стык).
 *
 * Выданная бронь (ISSUED) держит оборудование по факту, а не по плану:
 *  - выданная раньше срока занимает склад с момента выдачи — иначе прибор,
 *    который уже у клиента, «свободен» до даты начала и его сдают второй раз;
 *  - просроченная и не принятая занимает всё окно, в которое попадает текущий
 *    момент: срок прошёл, а на полке прибора нет. Окна целиком в будущем
 *    считаются свободными — исходим из того, что к ним вернут (решение
 *    владельца: строже, «до приёмки на любые даты», заблокировало бы
 *    подтверждение будущих броней, пока не нажат «Вернуть»).
 *
 * `now + 1`, а не `now`: окно «выдаю сейчас» (stockCap.addonWindow) начинается
 * ровно в момент запроса, и полуоткрытый хвост [.., now) его бы не задел.
 */
export function bookingOccupancyInterval(
  b: { status: BookingStatus; startDate: Date; endDate: Date; issuedAt: Date | null },
  now: number = Date.now(),
): { start: number; end: number } {
  if (b.status !== "ISSUED") return { start: b.startDate.getTime(), end: b.endDate.getTime() };
  const issuedAt = b.issuedAt?.getTime() ?? b.startDate.getTime();
  return {
    start: Math.min(b.startDate.getTime(), issuedAt),
    end: Math.max(b.endDate.getTime(), now + 1),
  };
}

/**
 * Плановый конец позиции: конец брони, а у длинной позиции — её срок возврата
 * (конец брони + лишние смены по 24 ч). Смены брони — billableShifts24h с её
 * «не считать вторые сутки», как в смете. Без хвоста просрочки — это план,
 * по нему проверяют склад при подтверждении и подбирают единицы.
 */
export function linePlannedEnd(
  b: { startDate: Date; endDate: Date; skipPartialDay: boolean },
  lineShifts: number | null | undefined,
): Date {
  if (lineShifts == null) return b.endDate;
  return new Date(lineDueAt(b.endDate, billableShifts24h(b.startDate, b.endDate, b.skipPartialDay), lineShifts));
}

/**
 * Интервал, в который ПОЗИЦИЯ брони занимает склад. Как у брони
 * (`bookingOccupancyInterval`), но конец — срок возврата позиции: позиция со
 * своим числом смен сверх брони (BookingItem.shifts) держит склад дольше —
 * до `lineDueAt`. Без своих смен интервал совпадает с интервалом брони.
 *
 * `dueAt` — плановый срок возврата позиции без хвоста «до сейчас»: по нему
 * карточка держателя пишет «освободится …» и «просрочено».
 */
export function lineOccupancyInterval(
  b: { status: BookingStatus; startDate: Date; endDate: Date; issuedAt: Date | null; skipPartialDay: boolean },
  lineShifts: number | null | undefined,
  now: number = Date.now(),
): { start: number; end: number; dueAt: number } {
  const base = bookingOccupancyInterval(b, now);
  const endMs = b.endDate.getTime();
  const dueAt = linePlannedEnd(b, lineShifts).getTime();
  if (dueAt === endMs) return { ...base, dueAt };
  return { start: base.start, end: b.status === "ISSUED" ? Math.max(dueAt, now + 1) : dueAt, dueAt };
}

/**
 * Насколько раньше окна могла кончиться бронь, чья длинная позиция всё ещё
 * задевает окно: позиция не длиннее MAX_LINE_SHIFTS смен.
 */
export const LONG_LINE_LOOKBACK_MS = MAX_LINE_SHIFTS * RENTAL_SHIFT_MS;

/**
 * Резервы обычных (не проектных) броней на позиции в окне — ровно те, что
 * занимают склад в getAvailability: блокирующие статусы, без архива, только
 * mode = STANDARD (у проектов свои лоты, см. projectReservations). Интервал
 * позиции — `lineOccupancyInterval` (интервал брони, у длинной позиции — до её
 * срока); в ответ попадают только резервы, которые задевают окно
 * (`reservationOverlaps`).
 *
 * Экспортируется, чтобы «кто держит позицию» (addonAvailability) выбирал
 * держателей из того же списка, по которому посчитана занятость: иначе
 * «занято» и «занято вот этой бронью» разъехались бы.
 */
export async function standardReservations(
  tx: TxClient,
  args: { start: Date; end: Date; equipmentIds?: string[]; excludeBookingId?: string },
): Promise<Reservation[]> {
  const itemFilter = args.equipmentIds
    ? { equipmentId: { in: args.equipmentIds } }
    : { equipmentId: { not: null } };
  const ordinary = await tx.booking.findMany({
    where: {
      mode: "STANDARD",
      status: { in: BLOCKING_STATUSES },
      deletedAt: null,
      // Плановые даты задевают окно — или бронь выдана: у выданной интервал
      // фактический (ранняя выдача, просрочка), по плановым датам её не найти.
      // Третья ветка — бронь кончилась раньше окна, но её длинная позиция
      // (свои смены сверх брони) ещё может его задевать.
      OR: [
        { startDate: { lte: args.end }, endDate: { gte: args.start } },
        { status: "ISSUED" },
        {
          startDate: { lte: args.end },
          endDate: { gte: new Date(args.start.getTime() - LONG_LINE_LOOKBACK_MS) },
          items: { some: { ...itemFilter, shifts: { not: null } } },
        },
      ],
      ...(args.excludeBookingId ? { id: { not: args.excludeBookingId } } : {}),
      ...(args.equipmentIds ? { items: { some: itemFilter } } : {}),
    },
    select: {
      id: true,
      status: true,
      startDate: true,
      endDate: true,
      issuedAt: true,
      skipPartialDay: true,
      items: {
        where: itemFilter,
        select: { equipmentId: true, quantity: true, shifts: true, unitReservations: { select: { id: true } } },
      },
    },
  });
  const now = Date.now();
  const windowStart = args.start.getTime();
  const windowEnd = args.end.getTime();
  return ordinary.flatMap((b) =>
    b.items
      .filter((i) => i.equipmentId)
      .map((i) => {
        const interval = lineOccupancyInterval(b, i.shifts, now);
        return {
          bookingId: b.id,
          equipmentId: i.equipmentId!,
          start: interval.start,
          end: interval.end,
          dueAt: interval.dueAt,
          quantity: Math.max(i.quantity, i.unitReservations.length),
        };
      })
      .filter((r) => reservationOverlaps(r, windowStart, windowEnd)),
  );
}

/**
 * Сердце доступности: физический склад, резервы обычных броней и проектных
 * лотов, пик занятости. Общее для витрины (getAvailability) и для потолков
 * склада (getAvailabilityForIds → stockCap) — одна формула на все экраны.
 */
async function computeAvailabilityRows(
  tx: TxClient,
  equipments: AvailabilityEquipment[],
  args: { startDate: Date; endDate: Date; excludeBookingId?: string; excludeProjectLotId?: string },
): Promise<AvailabilityRow[]> {
  if (equipments.length === 0) return [];
  const equipmentIds = equipments.map((e) => e.id);

  // eu-2: см. getUsableUnitBaseMap. F-LOST-1: COUNT-база = totalQuantity минус
  // открытые COUNT-потеряшки (getLostCountByEquipmentMap) — утерянное безъюнитное
  // количество не должно оставаться в наличии. F-REPAIR-1: и там, и там дополнительно
  // вычитаем безъюнитные ремонты — сломанное не продаётся ни в одном режиме учёта.
  const unitEquipmentIds = equipments.filter((e) => e.stockTrackingMode === "UNIT").map((e) => e.id);
  const countEquipmentIds = equipments.filter((e) => e.stockTrackingMode !== "UNIT").map((e) => e.id);
  const usableUnitBase = await getUsableUnitBaseMap(unitEquipmentIds, tx);
  const lostCountBase = await getLostCountByEquipmentMap(countEquipmentIds, tx);
  const inRepairBase = await getRepairCountByEquipmentMap(equipmentIds, tx);
  const baseQtyOf = (e: { id: string; stockTrackingMode: string; totalQuantity: number }): number => {
    const inRepair = inRepairBase.get(e.id) ?? 0;
    return e.stockTrackingMode === "UNIT"
      ? clampNonNegative((usableUnitBase.get(e.id) ?? 0) - inRepair)
      : clampNonNegative(e.totalQuantity - (lostCountBase.get(e.id) ?? 0) - inRepair);
  };

  const reservations: Reservation[] = await standardReservations(tx, {
    start: args.startDate,
    end: args.endDate,
    equipmentIds,
    excludeBookingId: args.excludeBookingId,
  });
  reservations.push(...await projectReservations({ start: args.startDate, end: args.endDate, equipmentIds,
    excludeBookingId: args.excludeBookingId, excludeLotId: args.excludeProjectLotId }, tx));
  return equipments.map((e) => {
    const baseQuantity = baseQtyOf(e);
    const occupied = peakOccupancy(reservations.filter((r) => r.equipmentId === e.id), args.startDate.getTime(), args.endDate.getTime());
    return {
      equipment: e,
      baseQuantity,
      occupiedQuantity: occupied,
      availableQuantity: clampNonNegative(baseQuantity - occupied),
    };
  });
}

export async function getAvailability(args: {
  startDate: Date;
  endDate: Date;
  equipmentIds?: string[];
  search?: string;
  category?: string;
  excludeBookingId?: string;
  excludeProjectLotId?: string;
  tx?: TxClient;
}): Promise<AvailabilityRow[]> {
  const tx = args.tx ?? prisma;
  const search = args.search ?? "";

  const categoryOrder = await getMergedCategoryOrder();

  const rawEquipments = await tx.equipment.findMany({
    where: {
      ...(args.equipmentIds ? { id: { in: args.equipmentIds } } : {}),
      ...(args.category ? { category: args.category } : {}),
    },
    orderBy: { id: "asc" },
    select: AVAILABILITY_EQUIPMENT_SELECT,
  });
  // P11: кириллица и латиница в названиях перемешаны («СF16», «8х8») —
  // сравниваем нормализованный текст (utils/searchNormalize), не сырой.
  const equipments =
    search.trim().length === 0
      ? rawEquipments
      : rawEquipments.filter((e) =>
          searchMatches([e.name, e.brand ?? "", e.model ?? "", e.category].join(" "), search),
        );

  equipments.sort((a, b) => compareEquipmentTransportLast(a, b, categoryOrder));

  return computeAvailabilityRows(tx, equipments, args);
}

/**
 * Та же доступность, что у витрины, но по списку позиций: без поиска, фильтра
 * категории и сортировки витрины, с ответом по id. Для потолков склада
 * (stockCap) — вызывается и внутри транзакций, поэтому ходит только через `tx`
 * (сортировка витрины читает порядок категорий глобальным клиентом).
 */
export async function getAvailabilityForIds(args: {
  startDate: Date;
  endDate: Date;
  equipmentIds: string[];
  excludeBookingId?: string;
  excludeProjectLotId?: string;
  tx?: TxClient;
}): Promise<Map<string, AvailabilityRow>> {
  const tx = args.tx ?? prisma;
  const ids = Array.from(new Set(args.equipmentIds));
  if (ids.length === 0) return new Map();
  const equipments = await tx.equipment.findMany({
    where: { id: { in: ids } },
    orderBy: { id: "asc" },
    select: AVAILABILITY_EQUIPMENT_SELECT,
  });
  const rows = await computeAvailabilityRows(tx, equipments, args);
  return new Map(rows.map((r) => [r.equipment.id, r]));
}
