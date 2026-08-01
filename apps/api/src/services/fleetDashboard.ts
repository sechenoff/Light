import Decimal from "decimal.js";

import { prisma } from "../prisma";

/**
 * Агрегаты дашборда автопарка: пробег/обслуживание/выручка за период плюс
 * прогноз ТО и полоса занятости вперёд.
 *
 * Отдельный модуль (не vehicleService), потому что это read-only витрина:
 * vehicleService отвечает за мутации и журналы, здесь — только счёт.
 */

/** Окно статистики. Совпадает с периодами «Статистики техники» для консистентности. */
export type FleetPeriod = 30 | 90 | 365;

export const FLEET_PERIODS: readonly FleetPeriod[] = [30, 90, 365] as const;

export function parseFleetPeriod(raw: unknown): FleetPeriod {
  const n = Number(raw);
  return n === 30 || n === 365 ? n : 90;
}

/**
 * Статусы броней, которые считаются «состоявшейся арендой» для денег и загрузки.
 * Совпадает с RENTAL_BOOKING_STATUSES в equipmentStats — единая семантика выручки
 * по всей системе (аудит финансовой математики 2026-07).
 */
const RENTAL_BOOKING_STATUSES = ["CONFIRMED", "ISSUED", "RETURNED"] as const;

/** Статусы, физически занимающие машину (для полосы занятости вперёд). */
const OCCUPYING_STATUSES = ["CONFIRMED", "ISSUED"] as const;

/** Горизонт полосы занятости, дней. */
export const OCCUPANCY_HORIZON_DAYS = 14;

/** Светофор состояния ТО. */
export type ServiceHealth =
  /** Интервал задан, запас больше 20 % — всё хорошо. */
  | "OK"
  /** Осталось ≤ 20 % интервала — пора планировать. */
  | "DUE_SOON"
  /** Интервал выбран полностью либо с последнего ТО больше года. */
  | "OVERDUE"
  /** Интервал задан, но ТО ни разу не записывали — считать не от чего. */
  | "NO_SERVICE"
  /** Интервал не задан — прогноз честно не строится. */
  | "NO_INTERVAL";

/** Порог «скоро ТО»: остаток ≤ 20 % интервала. */
const DUE_SOON_RATIO = 0.2;

/** Просрочка по времени: с последнего ТО больше года, независимо от пробега. */
const OVERDUE_DAYS = 365;

export interface VehicleStats {
  /** Пробег за период, км. null — меньше двух замеров, дельту не построить. */
  mileageDelta: number | null;
  /** Сколько замеров пробега попало в период — чтобы подписать «по N замерам». */
  mileageSamples: number;
  /** Км с последнего ТО. null — ТО не записывали. */
  kmSinceService: number | null;
  /** Дней с последнего ТО. null — ТО не записывали. */
  daysSinceService: number | null;
  /** Остаток до следующего ТО, км. null — нет интервала или нет записи ТО. */
  kmToNextService: number | null;
  /** Светофор ТО. */
  serviceHealth: ServiceHealth;
  /** Расход на ТО/ремонт за период, ₽ строкой (Decimal). */
  serviceCost: string;
  /** Число записей обслуживания за период. */
  serviceCount: number;
  /** Выручка машины за период, ₽ строкой. Считается по BookingVehicle.subtotalRub. */
  revenue: string;
  /** Выручка минус обслуживание за период, ₽ строкой. Может быть отрицательной. */
  net: string;
  /** Число броней с этой машиной за период. */
  bookingsCount: number;
  /** Дней аренды за период (пересечение периодов броней с окном, без двойного счёта). */
  rentedDays: number;
  /** Загрузка = rentedDays / днейВПериоде, 0..100, округлено до целого. */
  utilizationPct: number;
  /** Полоса занятости вперёд: по дню на элемент, начиная с сегодня (МСК). */
  occupancy: boolean[];
}

/** Строка «ближайшая бронь» для карточки. */
export interface UpcomingBooking {
  bookingId: string;
  projectName: string;
  clientName: string | null;
  startDate: string;
  endDate: string;
  status: "CONFIRMED" | "ISSUED";
  /** Машина физически на выдаче прямо сейчас. */
  isCurrent: boolean;
  /** Сумма машины в этой брони, ₽ строкой. null — не проставлена. */
  subtotalRub: string | null;
}

/** Сводка по всему парку — верхняя KPI-строка. */
export interface FleetTotals {
  vehiclesTotal: number;
  vehiclesActive: number;
  /** Из них участвуют в бронировании (транспорт). Знаменатель для «свободны». */
  vehiclesBookable: number;
  /** Свободны прямо сейчас (активные, без текущей выдачи). */
  freeNow: number;
  /** На выдаче прямо сейчас. */
  issuedNow: number;
  /** Требуют внимания: OVERDUE + DUE_SOON + NO_SERVICE + NO_INTERVAL. */
  needAttention: number;
  revenue: string;
  serviceCost: string;
  net: string;
  /** Средняя загрузка активных машин за период, 0..100. */
  utilizationPct: number;
  /** Суммарный пробег парка за период, км. null — нигде нет дельты. */
  mileageDelta: number | null;
}

/** Полночь по Москве для указанного момента, в UTC. */
function moscowMidnight(at: Date): Date {
  const msk = new Date(at.getTime() + 3 * 60 * 60 * 1000);
  return new Date(Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate()) - 3 * 60 * 60 * 1000);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Число дней пересечения [aFrom, aTo] и [bFrom, bTo]. Границы включительно по дням:
 * бронь 05.08–07.08 — это 3 дня аренды, а не 2.
 */
function overlapDays(aFrom: Date, aTo: Date, bFrom: Date, bTo: Date): number {
  const from = Math.max(aFrom.getTime(), bFrom.getTime());
  const to = Math.min(aTo.getTime(), bTo.getTime());
  if (to < from) return 0;
  const fromDay = moscowMidnight(new Date(from)).getTime();
  const toDay = moscowMidnight(new Date(to)).getTime();
  return Math.round((toDay - fromDay) / DAY_MS) + 1;
}

function computeServiceHealth(args: {
  intervalKm: number | null;
  kmSinceService: number | null;
  daysSinceService: number | null;
}): ServiceHealth {
  const { intervalKm, kmSinceService, daysSinceService } = args;
  if (intervalKm == null) return "NO_INTERVAL";
  if (kmSinceService == null) return "NO_SERVICE";
  if (daysSinceService != null && daysSinceService > OVERDUE_DAYS) return "OVERDUE";
  const remaining = intervalKm - kmSinceService;
  if (remaining <= 0) return "OVERDUE";
  if (remaining <= intervalKm * DUE_SOON_RATIO) return "DUE_SOON";
  return "OK";
}

/** Состояния, которые владелец должен разобрать. */
function needsAttention(h: ServiceHealth): boolean {
  return h !== "OK";
}

export interface FleetDashboardRow {
  id: string;
  name: string;
  slug: string;
  /** Единица счётчика: км (машины) или моточасы (генератор). */
  usageUnit: "KM" | "HOURS";
  /** Участвует в подборе транспорта для брони. false — техника вне броней. */
  bookable: boolean;
  licensePlate: string | null;
  currentMileage: number;
  serviceIntervalKm: number | null;
  lastServiceAt: string | null;
  lastServiceMileage: number | null;
  lastServiceKind: string | null;
  lastServiceDescription: string | null;
  lastServiceCost: string | null;
  notes: string | null;
  active: boolean;
  /** Тариф за смену, ₽ строкой. */
  shiftPriceRub: string;
  shiftHours: number;
  overtimePercent: string;
  hasGeneratorOption: boolean;
  generatorPriceRub: string | null;
  stats: VehicleStats;
  /** Текущая и ближайшие брони на горизонте занятости. */
  upcomingBookings: UpcomingBooking[];
}

export interface FleetDashboard {
  period: FleetPeriod;
  rangeFrom: string;
  rangeTo: string;
  totals: FleetTotals;
  vehicles: FleetDashboardRow[];
}

/**
 * Собирает витрину автопарка за период. Все выборки — батчами по всем машинам
 * сразу (без N+1).
 */
export async function computeFleetDashboard(opts?: {
  period?: FleetPeriod;
  includeInactive?: boolean;
  now?: Date;
}): Promise<FleetDashboard> {
  const period = opts?.period ?? 90;
  const now = opts?.now ?? new Date();
  const todayStart = moscowMidnight(now);
  const rangeTo = now;
  const rangeFrom = new Date(todayStart.getTime() - (period - 1) * DAY_MS);
  const horizonTo = new Date(todayStart.getTime() + (OCCUPANCY_HORIZON_DAYS - 1) * DAY_MS + DAY_MS - 1);

  const vehicles = await prisma.vehicle.findMany({
    where: opts?.includeInactive ? {} : { active: true },
    orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
  });
  const ids = vehicles.map((v) => v.id);

  if (ids.length === 0) {
    return {
      period,
      rangeFrom: rangeFrom.toISOString(),
      rangeTo: rangeTo.toISOString(),
      totals: {
        vehiclesTotal: 0,
        vehiclesActive: 0,
        vehiclesBookable: 0,
        freeNow: 0,
        issuedNow: 0,
        needAttention: 0,
        revenue: "0",
        serviceCost: "0",
        net: "0",
        utilizationPct: 0,
        mileageDelta: null,
      },
      vehicles: [],
    };
  }

  const [mileageLogs, serviceLogs, lastServiceRows, bookingRows] = await Promise.all([
    // Все замеры пробега: таблица маленькая (запись на возврат брони), поэтому
    // берём целиком и считаем дельты в памяти — так корректно виден и baseline
    // ДО начала окна, и число замеров ВНУТРИ окна.
    prisma.vehicleMileageLog.findMany({
      where: { vehicleId: { in: ids } },
      select: { vehicleId: true, mileage: true, recordedAt: true },
      orderBy: { recordedAt: "asc" },
    }),
    prisma.vehicleServiceLog.findMany({
      where: { vehicleId: { in: ids }, performedAt: { gte: rangeFrom, lte: rangeTo } },
      select: { vehicleId: true, cost: true },
    }),
    // Последняя запись обслуживания — для описания и стоимости в карточке.
    prisma.vehicleServiceLog.findMany({
      where: { vehicleId: { in: ids } },
      select: { vehicleId: true, description: true, cost: true, performedAt: true },
      orderBy: { performedAt: "desc" },
    }),
    prisma.bookingVehicle.findMany({
      where: {
        vehicleId: { in: ids },
        booking: { deletedAt: null, status: { in: [...RENTAL_BOOKING_STATUSES] } },
        OR: [
          // пересекается с окном статистики
          { booking: { startDate: { lte: rangeTo }, endDate: { gte: rangeFrom } } },
          // либо попадает в горизонт занятости вперёд
          { booking: { startDate: { lte: horizonTo }, endDate: { gte: todayStart } } },
        ],
      },
      select: {
        vehicleId: true,
        subtotalRub: true,
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
    }),
  ]);

  const mileageByVehicle = new Map<string, { mileage: number; recordedAt: Date }[]>();
  for (const m of mileageLogs) {
    const arr = mileageByVehicle.get(m.vehicleId) ?? [];
    arr.push({ mileage: m.mileage, recordedAt: m.recordedAt });
    mileageByVehicle.set(m.vehicleId, arr);
  }

  const serviceAgg = new Map<string, { cost: Decimal; count: number }>();
  for (const s of serviceLogs) {
    const cur = serviceAgg.get(s.vehicleId) ?? { cost: new Decimal(0), count: 0 };
    cur.cost = cur.cost.plus(s.cost ? new Decimal(s.cost.toString()) : 0);
    cur.count += 1;
    serviceAgg.set(s.vehicleId, cur);
  }

  const lastServiceByVehicle = new Map<string, { description: string; cost: string | null }>();
  for (const s of lastServiceRows) {
    if (lastServiceByVehicle.has(s.vehicleId)) continue; // отсортировано desc — первый и есть последний
    lastServiceByVehicle.set(s.vehicleId, {
      description: s.description,
      cost: s.cost ? new Decimal(s.cost.toString()).toFixed(2) : null,
    });
  }

  const bookingsByVehicle = new Map<string, typeof bookingRows>();
  for (const b of bookingRows) {
    const arr = bookingsByVehicle.get(b.vehicleId) ?? [];
    arr.push(b);
    bookingsByVehicle.set(b.vehicleId, arr);
  }

  let totalRevenue = new Decimal(0);
  let totalServiceCost = new Decimal(0);
  let totalMileageDelta = 0;
  let anyMileageDelta = false;
  let freeNow = 0;
  let issuedNow = 0;
  let needAttentionCount = 0;
  let utilizationSum = 0;
  let activeCount = 0;
  /** Активная техника, которая реально бронируется — база для средней загрузки. */
  let bookableActiveCount = 0;

  const rows: FleetDashboardRow[] = vehicles.map((v) => {
    const logs = mileageByVehicle.get(v.id) ?? [];
    const inWindow = logs.filter((l) => l.recordedAt >= rangeFrom && l.recordedAt <= rangeTo);
    const before = logs.filter((l) => l.recordedAt < rangeFrom);
    const baseline = before.length > 0 ? before[before.length - 1] : inWindow[0];
    const latest = inWindow.length > 0 ? inWindow[inWindow.length - 1] : undefined;
    let mileageDelta: number | null = null;
    if (baseline && latest && latest !== baseline) {
      const d = latest.mileage - baseline.mileage;
      // Отрицательная дельта возможна только после ручной корректировки одометра —
      // такой «пробег за период» недостоверен, честнее не показывать вовсе.
      mileageDelta = d >= 0 ? d : null;
    }

    const kmSinceService =
      v.lastServiceMileage != null ? Math.max(0, v.currentMileage - v.lastServiceMileage) : null;
    const daysSinceService =
      v.lastServiceAt != null
        ? Math.max(0, Math.floor((now.getTime() - v.lastServiceAt.getTime()) / DAY_MS))
        : null;
    const serviceHealth = computeServiceHealth({
      intervalKm: v.serviceIntervalKm,
      kmSinceService,
      daysSinceService,
    });
    const kmToNextService =
      v.serviceIntervalKm != null && kmSinceService != null
        ? v.serviceIntervalKm - kmSinceService
        : null;

    const svc = serviceAgg.get(v.id) ?? { cost: new Decimal(0), count: 0 };

    const vBookings = bookingsByVehicle.get(v.id) ?? [];
    let revenue = new Decimal(0);
    let bookingsCount = 0;
    // Дни аренды считаем через множество дат, чтобы пересекающиеся брони
    // не давали загрузку больше 100 %.
    const rentedDaySet = new Set<number>();
    const occupancy = new Array<boolean>(OCCUPANCY_HORIZON_DAYS).fill(false);
    const upcoming: UpcomingBooking[] = [];

    for (const bv of vBookings) {
      const b = bv.booking;
      const overlapsWindow = b.startDate <= rangeTo && b.endDate >= rangeFrom;
      if (overlapsWindow) {
        bookingsCount += 1;
        if (bv.subtotalRub) revenue = revenue.plus(new Decimal(bv.subtotalRub.toString()));
        const dayCount = overlapDays(b.startDate, b.endDate, rangeFrom, rangeTo);
        const startDay = moscowMidnight(new Date(Math.max(b.startDate.getTime(), rangeFrom.getTime()))).getTime();
        for (let i = 0; i < dayCount; i += 1) rentedDaySet.add(startDay + i * DAY_MS);
      }
      // Полоса занятости вперёд — только реально занимающие статусы.
      if (
        (OCCUPYING_STATUSES as readonly string[]).includes(b.status) &&
        b.startDate <= horizonTo &&
        b.endDate >= todayStart
      ) {
        for (let i = 0; i < OCCUPANCY_HORIZON_DAYS; i += 1) {
          const dayStart = todayStart.getTime() + i * DAY_MS;
          const dayEnd = dayStart + DAY_MS - 1;
          if (b.startDate.getTime() <= dayEnd && b.endDate.getTime() >= dayStart) occupancy[i] = true;
        }
        const isCurrent =
          b.status === "ISSUED" && b.startDate <= now && b.endDate >= now;
        upcoming.push({
          bookingId: b.id,
          projectName: b.projectName,
          clientName: b.client?.name ?? null,
          startDate: b.startDate.toISOString(),
          endDate: b.endDate.toISOString(),
          status: b.status as "CONFIRMED" | "ISSUED",
          isCurrent,
          subtotalRub: bv.subtotalRub ? new Decimal(bv.subtotalRub.toString()).toFixed(2) : null,
        });
      }
    }
    // Текущая выдача — первой, дальше по дате начала.
    upcoming.sort((a, b) => {
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
      return a.startDate.localeCompare(b.startDate);
    });

    const rentedDays = rentedDaySet.size;
    const utilizationPct = Math.min(100, Math.round((rentedDays / period) * 100));
    const net = revenue.minus(svc.cost);

    if (v.active) {
      activeCount += 1;
      if (needsAttention(serviceHealth)) needAttentionCount += 1;
      // «Свободна / на выдаче» и загрузка осмысленны только для транспорта:
      // генератор не бронируется как машина, и в этих счётчиках он был бы
      // вечным «свободна», занижая среднюю загрузку парка.
      if (v.bookable) {
        bookableActiveCount += 1;
        utilizationSum += utilizationPct;
        if (upcoming.some((u) => u.isCurrent)) issuedNow += 1;
        else freeNow += 1;
      }
    }
    totalRevenue = totalRevenue.plus(revenue);
    totalServiceCost = totalServiceCost.plus(svc.cost);
    // Суммарный «пробег парка» складывается только по километровым счётчикам:
    // сложить километры с моточасами — получить бессмысленное число.
    if (mileageDelta != null && v.usageUnit === "KM") {
      totalMileageDelta += mileageDelta;
      anyMileageDelta = true;
    }

    const lastSvc = lastServiceByVehicle.get(v.id) ?? null;

    return {
      id: v.id,
      name: v.name,
      slug: v.slug,
      usageUnit: v.usageUnit as "KM" | "HOURS",
      bookable: v.bookable,
      licensePlate: v.licensePlate,
      currentMileage: v.currentMileage,
      serviceIntervalKm: v.serviceIntervalKm,
      lastServiceAt: v.lastServiceAt ? v.lastServiceAt.toISOString() : null,
      lastServiceMileage: v.lastServiceMileage,
      lastServiceKind: v.lastServiceKind,
      lastServiceDescription: lastSvc?.description ?? null,
      lastServiceCost: lastSvc?.cost ?? null,
      notes: v.notes,
      active: v.active,
      shiftPriceRub: new Decimal(v.shiftPriceRub.toString()).toFixed(2),
      shiftHours: v.shiftHours,
      overtimePercent: new Decimal(v.overtimePercent.toString()).toFixed(2),
      hasGeneratorOption: v.hasGeneratorOption,
      generatorPriceRub:
        v.generatorPriceRub != null ? new Decimal(v.generatorPriceRub.toString()).toFixed(2) : null,
      stats: {
        mileageDelta,
        mileageSamples: inWindow.length,
        kmSinceService,
        daysSinceService,
        kmToNextService,
        serviceHealth,
        serviceCost: svc.cost.toFixed(2),
        serviceCount: svc.count,
        revenue: revenue.toFixed(2),
        net: net.toFixed(2),
        bookingsCount,
        rentedDays,
        utilizationPct,
        occupancy,
      },
      upcomingBookings: upcoming,
    };
  });

  return {
    period,
    rangeFrom: rangeFrom.toISOString(),
    rangeTo: rangeTo.toISOString(),
    totals: {
      vehiclesTotal: vehicles.length,
      vehiclesActive: activeCount,
      vehiclesBookable: bookableActiveCount,
      freeNow,
      issuedNow,
      needAttention: needAttentionCount,
      revenue: totalRevenue.toFixed(2),
      serviceCost: totalServiceCost.toFixed(2),
      net: totalRevenue.minus(totalServiceCost).toFixed(2),
      utilizationPct:
        bookableActiveCount > 0 ? Math.round(utilizationSum / bookableActiveCount) : 0,
      mileageDelta: anyMileageDelta ? totalMileageDelta : null,
    },
    vehicles: rows,
  };
}
