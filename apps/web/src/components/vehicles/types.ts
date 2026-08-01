/**
 * Типы витрины автопарка. Зеркалят `apps/api/src/services/fleetDashboard.ts`.
 *
 * Денежные поля — `string | null`: строка это Decimal (не число, копейки нельзя
 * терять), null — роль без доступа к экономике (WAREHOUSE / TECHNICIAN).
 */

export type FleetPeriodValue = "30" | "90" | "365";

export const FLEET_PERIOD_OPTIONS: { value: FleetPeriodValue; label: string }[] = [
  { value: "30", label: "30 дней" },
  { value: "90", label: "90 дней" },
  { value: "365", label: "Год" },
];

export function parseFleetPeriod(raw: string | null): FleetPeriodValue {
  return raw === "30" || raw === "365" ? raw : "90";
}

export const FLEET_PERIOD_LABEL: Record<FleetPeriodValue, string> = {
  "30": "за 30 дней",
  "90": "за 90 дней",
  "365": "за год",
};

export type UsageUnit = "KM" | "HOURS";

/**
 * Подписи счётчика наработки. Вся арифметика одинакова для машин и генератора —
 * различаются только слова, поэтому единица живёт в одном месте.
 */
export const USAGE_UNIT_META: Record<
  UsageUnit,
  { short: string; counterLabel: string; sampleWord: string }
> = {
  KM: { short: "км", counterLabel: "Пробег", sampleWord: "замеров" },
  HOURS: { short: "ч", counterLabel: "Наработка", sampleWord: "показаний" },
};

/** «90 239 км» / «1 250 ч» — число со своей единицей. */
export function formatUsage(n: number, unit: UsageUnit): string {
  return `${n.toLocaleString("ru-RU")} ${USAGE_UNIT_META[unit].short}`;
}

export type ServiceHealth =
  | "OK"
  | "DUE_SOON"
  | "OVERDUE"
  | "NO_SERVICE"
  | "NO_INTERVAL";

export interface VehicleStats {
  mileageDelta: number | null;
  mileageSamples: number;
  kmSinceService: number | null;
  daysSinceService: number | null;
  kmToNextService: number | null;
  serviceHealth: ServiceHealth;
  serviceCost: string | null;
  serviceCount: number;
  revenue: string | null;
  net: string | null;
  bookingsCount: number;
  rentedDays: number;
  utilizationPct: number;
  /** По дню на элемент, начиная с сегодня (МСК). Длина — OCCUPANCY_HORIZON_DAYS. */
  occupancy: boolean[];
}

export interface UpcomingBooking {
  bookingId: string;
  projectName: string;
  clientName: string | null;
  startDate: string;
  endDate: string;
  status: "CONFIRMED" | "ISSUED";
  isCurrent: boolean;
  subtotalRub: string | null;
}

export interface FleetVehicle {
  id: string;
  name: string;
  slug: string;
  usageUnit: UsageUnit;
  /** Участвует в бронировании как транспорт. false — генератор и подобное. */
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
  shiftPriceRub: string;
  shiftHours: number;
  overtimePercent: string;
  hasGeneratorOption: boolean;
  generatorPriceRub: string | null;
  stats: VehicleStats;
  upcomingBookings: UpcomingBooking[];
}

export interface FleetTotals {
  vehiclesTotal: number;
  vehiclesActive: number;
  vehiclesBookable: number;
  freeNow: number;
  issuedNow: number;
  needAttention: number;
  revenue: string | null;
  serviceCost: string | null;
  net: string | null;
  utilizationPct: number;
  mileageDelta: number | null;
}

export interface FleetDashboardResponse {
  period: 30 | 90 | 365;
  rangeFrom: string;
  rangeTo: string;
  totals: FleetTotals;
  vehicles: FleetVehicle[];
}

export const SERVICE_KIND_LABEL: Record<string, string> = {
  SCHEDULED_TO: "Плановое ТО",
  OIL_CHANGE: "Замена масла",
  TIRE_CHANGE: "Шиномонтаж",
  REPAIR: "Ремонт",
  INSPECTION: "Диагностика",
  OTHER: "Прочее",
};

/**
 * Подпись и тон светофора ТО. Тон — семантический токен канона.
 * `bandLabel` — форма для строки ленты внимания («Ивеко — скоро ТО»); отдельное
 * поле, потому что toLowerCase() ломает аббревиатуру ТО.
 */
export const SERVICE_HEALTH_META: Record<
  ServiceHealth,
  { label: string; bandLabel: string; tone: "ok" | "warn" | "alert" | "none" }
> = {
  OK: { label: "ТО в норме", bandLabel: "ТО в норме", tone: "ok" },
  DUE_SOON: { label: "Скоро ТО", bandLabel: "скоро ТО", tone: "warn" },
  OVERDUE: { label: "Пора на ТО", bandLabel: "пора на ТО", tone: "alert" },
  NO_SERVICE: { label: "Нет записей о ТО", bandLabel: "нет записей о ТО", tone: "warn" },
  NO_INTERVAL: { label: "Интервал не задан", bandLabel: "интервал ТО не задан", tone: "none" },
};

/** Машина требует внимания владельца — всё, кроме нормы. */
export function needsAttention(h: ServiceHealth): boolean {
  return h !== "OK";
}
