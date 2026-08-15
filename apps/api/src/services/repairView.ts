/**
 * Read-model мастерской: как ремонт выглядит в списке, на карточке и в сводке.
 *
 * Вынесено из `repairService.ts` намеренно: там живут мутации (создать, взять,
 * закрыть, списать), здесь — только чтение и расчёты поверх него. Смешивать их
 * в одном файле значило бы получить полторы тысячи строк, где транзакции и
 * агрегаты правятся вперемешку.
 *
 * Три вещи, ради которых файл существует:
 *  1. `resolveRepairTitle` — у ремонта ВСЕГДА есть название. До этого поломка
 *     позиции без штучного учёта (кабель, стойка, зарядка) приезжала как
 *     «Без позиции» и роняла первый экран техника.
 *  2. `computeRepairRiskMap` — три состояния риска вместо флажка «есть бронь».
 *     Экран, который одинаково кричит и про сорванную съёмку, и про ремонт,
 *     который успевает, перестают читать через неделю.
 *  3. `buildRepairHistory` — «раньше чинили»: сколько эта позиция уже съела
 *     денег, пересчитанных в смены аренды.
 */

import type { Prisma, RepairStatus } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";

import { prisma } from "../prisma";
import {
  BLOCKING_STATUSES,
  getLostCountByEquipmentMap,
  getRepairCountByEquipmentMap,
  getUsableUnitBaseMap,
} from "./availability";
import {
  moscowTodayStart,
  addDays,
  toMoscowDateString,
  fromMoscowDateString,
} from "../utils/moscowDate";

const CLOSED_STATUSES: RepairStatus[] = ["CLOSED", "WROTE_OFF"];

/**
 * Горизонт поиска блокирующей брони. Дальше месяца смотреть смысла нет:
 * ремонт либо закончится, либо к тому сроку успеют найти подмену. Тот же
 * горизонт у KPI «под угрозой» в `routes/dashboard.ts` — если разойдутся,
 * счётчик на «Моём дне» и красные карточки в мастерской будут про разное.
 */
const RISK_HORIZON_DAYS = 30;

/** Окно «раньше чинили» — год. Более старые ремонты уже не про этот прибор. */
const HISTORY_WINDOW_DAYS = 365;

/** Сколько закрытых ремонтов подряд делают позицию «проблемной». */
const REPEATED_THRESHOLD = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

// ─── Название позиции ────────────────────────────────────────────────────────

export type RepairTitleSource = "unit" | "estimate" | "catalog" | "gone";

export interface RepairTitleInput {
  unit?: { equipment?: { name: string } | null } | null;
  bookingItem?: { equipment?: { name: string } | null } | null;
  equipment?: { name: string } | null;
}

/**
 * Название ремонтируемой позиции в три ступени + честный «источник».
 *
 * Штучная единица знает свою позицию сама; безъюнитная поломка с приёмки —
 * через строку сметы; заявка, заведённая руками из раздела мастерской, — через
 * прямую ссылку на каталог. Если позицию удалили из каталога, пишем это прямым
 * текстом, а не оставляем пустоту: пустое название означает «непонятно, что
 * чинить», и его нельзя отличить от бага.
 *
 * `titleSource !== "unit"` фронт рисует серой меткой «название из каталога» —
 * чтобы кладовщик понимал, что конкретный экземпляр не отслеживается.
 */
export function resolveRepairTitle(r: RepairTitleInput): {
  title: string;
  titleSource: RepairTitleSource;
} {
  const fromUnit = r.unit?.equipment?.name?.trim();
  if (fromUnit) return { title: fromUnit, titleSource: "unit" };

  const fromEstimate = r.bookingItem?.equipment?.name?.trim();
  if (fromEstimate) return { title: fromEstimate, titleSource: "estimate" };

  const fromCatalog = r.equipment?.name?.trim();
  if (fromCatalog) return { title: fromCatalog, titleSource: "catalog" };

  return { title: "Позиция удалена из каталога", titleSource: "gone" };
}

// ─── Риск ────────────────────────────────────────────────────────────────────

export type RepairRiskLevel = "BLOCKS" | "TIGHT" | "COVERED" | "NONE";

export interface RepairRiskBooking {
  id: string;
  /** Человекочитаемый номер брони («#A1B2C3») — тот же формат, что в доборе. */
  no: string;
  projectName: string;
  clientName: string;
  /** ISO. */
  startDate: string;
}

export interface RepairRisk {
  level: RepairRiskLevel;
  booking: RepairRiskBooking | null;
  /** Сколько штук не хватает на ближайшую блокирующую бронь. */
  shortfall: number;
  /** Всего физически в парке (без списанных и потерянных). */
  inPark: number;
  /** Сколько из них сейчас в мастерской. */
  inRepair: number;
  /** Сколько просит ближайшая блокирующая бронь. */
  booked: number;
  /** Свободных после вычета мастерской. */
  sparesLeft: number;
  /** Запас в днях: срок готовности против даты выдачи. null — срок не назначен. */
  slackDays: number | null;
}

export interface RepairRiskInput {
  id: string;
  status: RepairStatus;
  expectedReadyAt: Date | null;
  equipmentId: string | null;
  unit?: { equipmentId: string } | null;
  bookingItem?: { equipmentId: string | null } | null;
}

/** Позиция каталога: юнит → прямая ссылка → строка сметы. */
export function resolveRepairEquipmentId(r: {
  equipmentId?: string | null;
  unit?: { equipmentId: string } | null;
  bookingItem?: { equipmentId: string | null } | null;
}): string | null {
  return r.unit?.equipmentId ?? r.equipmentId ?? r.bookingItem?.equipmentId ?? null;
}

function emptyRisk(partial?: Partial<RepairRisk>): RepairRisk {
  return {
    level: "NONE",
    booking: null,
    shortfall: 0,
    inPark: 0,
    inRepair: 0,
    booked: 0,
    sparesLeft: 0,
    slackDays: null,
    ...partial,
  };
}

function bookingNo(id: string): string {
  return "#" + id.slice(-6).toUpperCase();
}

/**
 * Риск по каждому ремонту — одним батчем на весь список (никаких запросов в цикле).
 *
 * Считаем и для позиций без штучного учёта: сорвать смену отсутствием кабеля
 * можно ровно так же, как отсутствием прибора, а прошлая версия пропускала их
 * гардом `r.unit`.
 *
 * Уровни:
 *  - `BLOCKS` — подмены не хватает И (срок не назначен ИЛИ позже даты выдачи);
 *  - `TIGHT`  — подмены не хватает, но срок раньше выдачи: успеваем, запас в днях;
 *  - `COVERED`— остальных единиц хватает, чтобы закрыть ближайшую бронь;
 *  - `NONE`   — блокирующих броней на горизонте нет.
 */
export async function computeRepairRiskMap(
  rows: RepairRiskInput[],
): Promise<Map<string, RepairRisk>> {
  const result = new Map<string, RepairRisk>();

  const active: Array<{ id: string; equipmentId: string; expectedReadyAt: Date | null }> = [];
  for (const r of rows) {
    const equipmentId = resolveRepairEquipmentId(r);
    // Закрытый ремонт ничью бронь не срывает; ремонт без позиции — нечего считать.
    if (CLOSED_STATUSES.includes(r.status) || !equipmentId) {
      result.set(r.id, emptyRisk());
      continue;
    }
    active.push({ id: r.id, equipmentId, expectedReadyAt: r.expectedReadyAt });
  }
  if (active.length === 0) return result;

  const equipmentIds = Array.from(new Set(active.map((a) => a.equipmentId)));
  const todayStart = moscowTodayStart();
  const horizonEnd = addDays(todayStart, RISK_HORIZON_DAYS);

  const equipments = await prisma.equipment.findMany({
    where: { id: { in: equipmentIds } },
    select: { id: true, stockTrackingMode: true, totalQuantity: true },
  });
  const unitEquipmentIds = equipments.filter((e) => e.stockTrackingMode === "UNIT").map((e) => e.id);
  const countEquipmentIds = equipments.filter((e) => e.stockTrackingMode !== "UNIT").map((e) => e.id);

  const [usableUnits, maintenanceUnits, lostCount, unitlessRepairs, blockingItems] =
    await Promise.all([
      getUsableUnitBaseMap(unitEquipmentIds),
      countUnitsInMaintenance(unitEquipmentIds),
      getLostCountByEquipmentMap(countEquipmentIds),
      getRepairCountByEquipmentMap(equipmentIds),
      // Только будущие выдачи: бронь, которая уже на руках у клиента, этим
      // ремонтом не срывается — оборудование по ней уже уехало.
      prisma.bookingItem.findMany({
        where: {
          equipmentId: { in: equipmentIds },
          booking: {
            status: { in: BLOCKING_STATUSES },
            deletedAt: null,
            startDate: { gte: todayStart, lte: horizonEnd },
          },
        },
        select: {
          equipmentId: true,
          quantity: true,
          booking: {
            select: {
              id: true,
              projectName: true,
              startDate: true,
              client: { select: { name: true } },
            },
          },
        },
      }),
    ]);

  // Наличие по позиции. Для UNIT «в парке» = пригодные (AVAILABLE/ISSUED) плюс
  // те, что стоят в MAINTENANCE: сломанный прибор из парка никуда не делся, он
  // в мастерской. Списанные (RETIRED) и потерянные (MISSING) в парк не входят —
  // у COUNT-позиций это же выражено вычетом открытых «потеряшек».
  // sparesLeft = inPark − inRepair совпадает с базой доступности в
  // availability.ts: у UNIT штучный ремонт учтён один раз (юнит в MAINTENANCE
  // выпал из usable и вернулся через inRepair), безъюнитные ремонты добирает
  // getRepairCountByEquipmentMap.
  const stock = new Map<string, { inPark: number; inRepair: number; sparesLeft: number }>();
  for (const e of equipments) {
    const unitless = unitlessRepairs.get(e.id) ?? 0;
    const inPark =
      e.stockTrackingMode === "UNIT"
        ? (usableUnits.get(e.id) ?? 0) + (maintenanceUnits.get(e.id) ?? 0)
        : Math.max(0, e.totalQuantity - (lostCount.get(e.id) ?? 0));
    const inRepair =
      e.stockTrackingMode === "UNIT" ? (maintenanceUnits.get(e.id) ?? 0) + unitless : unitless;
    stock.set(e.id, { inPark, inRepair, sparesLeft: Math.max(0, inPark - inRepair) });
  }

  // Ближайшая блокирующая бронь на позицию + сколько штук она просит.
  // Одна бронь может просить позицию несколькими строками — суммируем внутри брони.
  type Demand = { booking: RepairRiskBooking; startDate: Date; needed: number };
  const demandByEquipment = new Map<string, Map<string, Demand>>();
  for (const bi of blockingItems) {
    if (!bi.equipmentId || !bi.booking) continue;
    let bookings = demandByEquipment.get(bi.equipmentId);
    if (!bookings) {
      bookings = new Map();
      demandByEquipment.set(bi.equipmentId, bookings);
    }
    const prev = bookings.get(bi.booking.id);
    bookings.set(bi.booking.id, {
      booking: {
        id: bi.booking.id,
        no: bookingNo(bi.booking.id),
        projectName: bi.booking.projectName,
        clientName: bi.booking.client?.name ?? "",
        startDate: bi.booking.startDate.toISOString(),
      },
      startDate: bi.booking.startDate,
      needed: (prev?.needed ?? 0) + bi.quantity,
    });
  }

  const nearestByEquipment = new Map<string, Demand>();
  for (const [equipmentId, bookings] of demandByEquipment) {
    for (const d of bookings.values()) {
      const current = nearestByEquipment.get(equipmentId);
      // Ничьи разруливаем по id — иначе порядок выдачи БД менял бы карточку.
      if (
        !current ||
        d.startDate < current.startDate ||
        (d.startDate.getTime() === current.startDate.getTime() && d.booking.id < current.booking.id)
      ) {
        nearestByEquipment.set(equipmentId, d);
      }
    }
  }

  for (const a of active) {
    const s = stock.get(a.equipmentId) ?? { inPark: 0, inRepair: 0, sparesLeft: 0 };
    const nearest = nearestByEquipment.get(a.equipmentId);

    if (!nearest) {
      result.set(a.id, emptyRisk({ inPark: s.inPark, inRepair: s.inRepair, sparesLeft: s.sparesLeft }));
      continue;
    }

    const shortfall = Math.max(0, nearest.needed - s.sparesLeft);
    const slackDays =
      a.expectedReadyAt === null
        ? null
        : slackInMoscowDays(a.expectedReadyAt, nearest.startDate);

    let level: RepairRiskLevel;
    if (shortfall === 0) {
      level = "COVERED";
    } else if (a.expectedReadyAt !== null && a.expectedReadyAt <= nearest.startDate) {
      level = "TIGHT";
    } else {
      level = "BLOCKS";
    }

    result.set(a.id, {
      level,
      booking: nearest.booking,
      shortfall,
      inPark: s.inPark,
      inRepair: s.inRepair,
      booked: nearest.needed,
      sparesLeft: s.sparesLeft,
      slackDays,
    });
  }

  return result;
}

/**
 * Запас в КАЛЕНДАРНЫХ днях по Москве, а не в миллисекундах, делённых на сутки.
 * «Починим 15-го, выдача 19-го» человек читает как «запас 4 дня» независимо от
 * того, на который час назначена выдача; отсчёт по часам давал бы то 3, то 4 в
 * зависимости от времени суток.
 */
function slackInMoscowDays(from: Date, to: Date): number {
  const a = fromMoscowDateString(toMoscowDateString(from)).getTime();
  const b = fromMoscowDateString(toMoscowDateString(to)).getTime();
  return Math.round((b - a) / DAY_MS);
}

async function countUnitsInMaintenance(equipmentIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (equipmentIds.length === 0) return map;
  const grouped = await prisma.equipmentUnit.groupBy({
    by: ["equipmentId"],
    where: { equipmentId: { in: equipmentIds }, status: "MAINTENANCE" },
    _count: { _all: true },
  });
  for (const g of grouped) map.set(g.equipmentId, g._count._all);
  return map;
}

// ─── Имена вместо cuid ───────────────────────────────────────────────────────

/** cuid — «c» + 24 знака. Годится, чтобы отличить id от человеческого имени. */
const CUID_RE = /^c[a-z0-9]{20,}$/i;

/**
 * Кто завёл и кто чинит — именами, не идентификаторами. FK на `AdminUser` нет
 * (как у `Task`), поэтому джойним словарём одним запросом.
 *
 * `Repair.createdBy` в складском сценарии хранит НЕ id, а имя кладовщика с
 * PIN-входа («Иван Кладовщик») — такое значение печатаем как есть. А вот
 * осиротевший cuid (пользователя удалили) печатать нельзя: на экране появится
 * мусор вида `cmb3x…`, поэтому такие гасим в null.
 */
export async function resolveActorNames(
  rawIds: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const ids = Array.from(new Set(rawIds.filter((v): v is string => Boolean(v))));
  const names = new Map<string, string>();
  if (ids.length === 0) return names;

  const users = await prisma.adminUser.findMany({
    where: { id: { in: ids } },
    select: { id: true, username: true },
  });
  for (const u of users) names.set(u.id, u.username);
  for (const id of ids) {
    if (!names.has(id) && !CUID_RE.test(id)) names.set(id, id);
  }
  return names;
}

export function actorName(
  names: Map<string, string>,
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  return names.get(raw) ?? null;
}

// ─── Последняя запись работ ──────────────────────────────────────────────────

/** Когда по ремонту последний раз что-то делали — батчем, без N+1. */
export async function getLastWorkLogAtMap(repairIds: string[]): Promise<Map<string, Date>> {
  const map = new Map<string, Date>();
  if (repairIds.length === 0) return map;
  const grouped = await prisma.repairWorkLog.groupBy({
    by: ["repairId"],
    where: { repairId: { in: repairIds } },
    _max: { loggedAt: true },
  });
  for (const g of grouped) {
    if (g._max.loggedAt) map.set(g.repairId, g._max.loggedAt);
  }
  return map;
}

// ─── Обогащение списка ───────────────────────────────────────────────────────

/**
 * Строка `Repair` с включёнными связями. Объявлена целиком, а не через
 * `extends RepairRiskInput, RepairTitleInput`: оба родителя описывают `unit` и
 * `bookingItem` под свои нужды, и TS справедливо считает такое наследование
 * конфликтом. Здесь — объединение обеих форм.
 */
export interface EnrichableRepair {
  id: string;
  status: RepairStatus;
  expectedReadyAt: Date | null;
  equipmentId: string | null;
  assignedTo: string | null;
  createdBy: string;
  unit?: { equipmentId: string; equipment?: { name: string } | null } | null;
  bookingItem?: { equipmentId: string | null; equipment?: { name: string } | null } | null;
  equipment?: { name: string } | null;
}

export interface RepairEnrichment {
  title: string;
  titleSource: RepairTitleSource;
  assignedToName: string | null;
  createdByName: string | null;
  /** ISO. */
  lastWorkLogAt: string | null;
  risk: RepairRisk;
}

/**
 * Всё, чего не хватает сырой строке `Repair`, чтобы её можно было показать
 * человеку. Четыре батч-запроса на страницу списка независимо от её длины.
 */
export async function enrichRepairs<T extends EnrichableRepair>(
  rows: T[],
): Promise<Map<string, RepairEnrichment>> {
  const enrichment = new Map<string, RepairEnrichment>();
  if (rows.length === 0) return enrichment;

  const [names, lastWorkLog, risks] = await Promise.all([
    resolveActorNames(rows.flatMap((r) => [r.assignedTo, r.createdBy])),
    getLastWorkLogAtMap(rows.map((r) => r.id)),
    computeRepairRiskMap(rows),
  ]);

  for (const r of rows) {
    enrichment.set(r.id, {
      ...resolveRepairTitle(r),
      assignedToName: actorName(names, r.assignedTo),
      createdByName: actorName(names, r.createdBy),
      lastWorkLogAt: lastWorkLog.get(r.id)?.toISOString() ?? null,
      risk: risks.get(r.id) ?? emptyRisk(),
    });
  }
  return enrichment;
}

// ─── «Раньше чинили» ─────────────────────────────────────────────────────────

export interface RepairHistoryItem {
  id: string;
  /** ISO. */
  closedAt: string | null;
  reason: string;
  outcome: "CLOSED" | "WROTE_OFF";
  /** Decimal-строка: запчасти по карточке + связанные расходы. */
  cost: string;
}

export interface RepairHistory {
  count: number;
  totalCost: string;
  /**
   * Во сколько смен аренды обошлись прошлые ремонты. null — ставки нет или она
   * нулевая: делить на ноль ради красивой цифры нельзя, честнее промолчать.
   */
  shiftsEquivalent: string | null;
  /**
   * Считая текущий ремонт, позицию чинят REPEATED_THRESHOLD раз и больше —
   * это уже не невезение, а кандидат на списание.
   */
  repeated: boolean;
  items: RepairHistoryItem[];
}

/**
 * История ремонтов этой же позиции за год.
 *
 * Ищем по единице, а если её нет (позиция без штучного учёта) — по позиции
 * каталога. Деньги считаем полностью: `partsCost` карточки плюс все связанные
 * расходы, включая неутверждённые — на утверждение они ждут в бухгалтерии, а
 * потрачены уже.
 */
export async function buildRepairHistory(repair: {
  id: string;
  unitId: string | null;
  equipmentId: string | null;
  unit?: { equipmentId: string } | null;
  bookingItem?: { equipmentId: string | null } | null;
}): Promise<RepairHistory> {
  const equipmentId = resolveRepairEquipmentId(repair);
  const empty: RepairHistory = {
    count: 0,
    totalCost: "0",
    shiftsEquivalent: null,
    repeated: false,
    items: [],
  };
  const since = addDays(new Date(), -HISTORY_WINDOW_DAYS);
  let scope: Prisma.RepairWhereInput;
  if (repair.unitId) {
    scope = { unitId: repair.unitId };
  } else if (equipmentId) {
    // Позиция без штучного учёта: собираем прошлые ремонты по всем трём
    // способам, которыми ремонт может быть привязан к каталогу.
    scope = {
      OR: [
        { equipmentId },
        { unit: { equipmentId } },
        { bookingItem: { equipmentId } },
      ],
    };
  } else {
    return empty;
  }

  const past = await prisma.repair.findMany({
    where: {
      id: { not: repair.id },
      status: { in: CLOSED_STATUSES },
      closedAt: { gte: since },
      ...scope,
    },
    orderBy: { closedAt: "desc" },
    select: {
      id: true,
      reason: true,
      status: true,
      closedAt: true,
      partsCost: true,
      expenses: { select: { amount: true } },
    },
  });

  if (past.length === 0) return empty;

  let total = new Decimal(0);
  const items: RepairHistoryItem[] = past.map((p) => {
    const cost = p.expenses.reduce(
      (sum, e) => sum.add(new Decimal(e.amount)),
      new Decimal(p.partsCost),
    );
    total = total.add(cost);
    return {
      id: p.id,
      closedAt: p.closedAt?.toISOString() ?? null,
      reason: p.reason,
      outcome: p.status === "WROTE_OFF" ? "WROTE_OFF" : "CLOSED",
      cost: cost.toString(),
    };
  });

  let shiftsEquivalent: string | null = null;
  if (equipmentId) {
    const equipment = await prisma.equipment.findUnique({
      where: { id: equipmentId },
      select: { rentalRatePerShift: true },
    });
    const rate = equipment ? new Decimal(equipment.rentalRatePerShift) : null;
    if (rate && !rate.isZero()) shiftsEquivalent = total.div(rate).toFixed(1);
  }

  return {
    count: past.length,
    totalCost: total.toString(),
    shiftsEquivalent,
    // +1 — сам текущий ремонт: «чиним третий раз» видно уже на третьем заходе,
    // а не на четвёртом.
    repeated: past.length + 1 >= REPEATED_THRESHOLD,
    items,
  };
}
