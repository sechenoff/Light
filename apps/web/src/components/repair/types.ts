/**
 * Типы и чистые правила раздела «Мастерская».
 *
 * Форма данных зеркалит `apps/api/src/services/repairView.ts` — там же живёт
 * авторитетный расчёт риска. Здесь только то, что нужно отрисовать: группировка
 * очереди, сортировки и подписи. Ни одного запроса и ни одного JSX — чтобы
 * правила «что горит» можно было прочитать и проверить отдельно от вёрстки.
 */

// ── Данные с сервера ─────────────────────────────────────────────────────────

export type RepairStatus =
  | "WAITING_REPAIR"
  | "IN_REPAIR"
  | "WAITING_PARTS"
  | "CLOSED"
  | "WROTE_OFF";

export type RepairUrgency = "NOT_URGENT" | "NORMAL" | "URGENT";

/** Откуда взято название: единица → строка сметы → каталог → позиции больше нет. */
export type RepairTitleSource = "unit" | "estimate" | "catalog" | "gone";

export type RepairRiskLevel = "BLOCKS" | "TIGHT" | "COVERED" | "NONE";

export interface RepairRiskBooking {
  id: string;
  /** Человеческий номер брони, формат «#A1B2C3». */
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
  /** Физически в парке. */
  inPark: number;
  /** Из них сейчас в мастерской. */
  inRepair: number;
  /** Сколько просит ближайшая блокирующая бронь. */
  booked: number;
  /** Свободных после вычета мастерской. */
  sparesLeft: number;
  /** Календарные дни: срок ремонта → выдача брони. Отрицательное = опаздываем. */
  slackDays: number | null;
}

export interface RepairEquipmentRef {
  id: string;
  name: string;
  category: string;
}

export interface RepairListItem {
  id: string;
  unitId: string | null;
  bookingItemId: string | null;
  equipmentId: string | null;
  quantity: number;
  status: RepairStatus;
  urgency: RepairUrgency;
  reason: string;
  sourceBookingId: string | null;
  createdBy: string;
  assignedTo: string | null;
  partsCost: string;
  totalTimeHours: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  expectedReadyAt: string | null;
  partsNote: string | null;

  unit: { id: string; equipmentId: string; equipment: RepairEquipmentRef } | null;
  bookingItem: {
    id: string;
    quantity: number;
    equipmentId: string | null;
    equipment: RepairEquipmentRef | null;
  } | null;
  equipment: RepairEquipmentRef | null;
  sourceBooking: {
    id: string;
    projectName: string;
    startDate: string;
    endDate: string;
    client: { name: string };
  } | null;

  title: string;
  titleSource: RepairTitleSource;
  assignedToName: string | null;
  createdByName: string | null;
  photoCount: number;
  workLogCount: number;
  lastWorkLogAt: string | null;
  risk: RepairRisk;
}

export interface RepairListResponse {
  repairs: RepairListItem[];
  nextCursor: string | null;
}

export interface PendingExpenseItem {
  id: string;
  title: string;
  amount: string;
  createdByName: string | null;
  createdAt: string;
  repairId: string | null;
}

export interface ReadyForPickupItem {
  repairId: string;
  title: string;
  closedAt: string;
}

export interface RepairStats {
  openCount: number;
  newCount: number;
  closedThisMonth: number;
  writtenOffThisMonth: number;
  atRiskCount: number;
  quietCount: number;
  noEtaCount: number;
  readyForPickup: ReadyForPickupItem[];
  /** Денежные поля равны null для всех, кроме руководителя. */
  spentThisMonth: string | null;
  spentPrevMonth: string | null;
  pendingExpenses: { count: number; total: string; items: PendingExpenseItem[] } | null;
}

/** Позиция каталога для модалки «Завести поломку» (GET /api/equipment). */
export interface EquipmentSearchItem {
  id: string;
  name: string;
  category: string;
  totalQuantity: number;
  stockTrackingMode: "COUNT" | "UNIT";
  unitStatusCounts: Record<string, number> | null;
}

/** Единица штучного учёта (GET /api/equipment/:id/units). Штрихкод сознательно не читаем. */
export interface EquipmentUnitItem {
  id: string;
  status: "AVAILABLE" | "ISSUED" | "MAINTENANCE" | "RETIRED" | "MISSING";
  serialNumber: string | null;
  comment: string | null;
}

// ── Подписи ──────────────────────────────────────────────────────────────────

export const REPAIR_STATUS_LABEL: Record<RepairStatus, string> = {
  WAITING_REPAIR: "Ждёт ремонта",
  IN_REPAIR: "В ремонте",
  WAITING_PARTS: "Ждём запчасти",
  CLOSED: "Починено",
  WROTE_OFF: "Списано",
};

/** Классы пилюли статуса — по мокапу: ждёт/запчасти янтарные, в ремонте синяя. */
export const REPAIR_STATUS_PILL: Record<RepairStatus, string> = {
  WAITING_REPAIR: "bg-warn-soft text-warn border-amber-border",
  IN_REPAIR: "bg-accent-soft text-accent border-accent-border",
  WAITING_PARTS: "bg-warn-soft text-warn border-amber-border",
  CLOSED: "bg-ok-soft text-ok border-emerald-border",
  WROTE_OFF: "bg-surface text-ink-3 border-border",
};

const MONTHS_SHORT = [
  "янв", "фев", "мар", "апр", "мая", "июн",
  "июл", "авг", "сен", "окт", "ноя", "дек",
];

/** «13 авг» — короткая дата по Москве, день всегда двумя цифрами. */
export function formatDayMonth(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const parts = d
    .toLocaleString("en-CA", {
      timeZone: "Europe/Moscow",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
    .split("-");
  const month = MONTHS_SHORT[Number(parts[1]) - 1] ?? "";
  return `${parts[2]} ${month}`;
}

// ── Календарная арифметика ───────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/** «YYYY-MM-DD» по Москве → миллисекунды полуночи. Даты сравниваем днями, не секундами. */
function moscowMidnightMs(iso: string): number {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return NaN;
  const ymd = d.toLocaleString("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return new Date(`${ymd}T00:00:00+03:00`).getTime();
}

/** Календарных дней между двумя ISO-датами по Москве (to − from). */
export function moscowDaysBetween(fromIso: string, toIso: string): number {
  const a = moscowMidnightMs(fromIso);
  const b = moscowMidnightMs(toIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / DAY_MS);
}

/** Сколько дней назад была дата (по Москве). Сегодня → 0, вчера → 1. */
export function daysAgo(iso: string): number {
  return moscowDaysBetween(iso, new Date().toISOString());
}

/** Сколько дней осталось до даты (по Москве). Прошедшая дата → отрицательное. */
export function daysUntil(iso: string): number {
  return moscowDaysBetween(new Date().toISOString(), iso);
}

// ── Правила очереди ──────────────────────────────────────────────────────────

/** Ремонт без записей столько суток считается «тихим»: о нём забыли. */
export const QUIET_DAYS = 5;

/** Момент последнего движения: запись журнала, а если её нет — заведение карточки. */
export function lastActivityAt(r: RepairListItem): string {
  return r.lastWorkLogAt ?? r.createdAt;
}

/** Молчит ли карточка. Молчание — такой же сигнал, как просроченный срок. */
export function isQuiet(r: RepairListItem): boolean {
  return daysAgo(lastActivityAt(r)) >= QUIET_DAYS;
}

/** Свой срок уже прошёл, а ремонт всё ещё открыт. */
export function isEtaOverdue(r: RepairListItem): boolean {
  return r.expectedReadyAt != null && daysUntil(r.expectedReadyAt) < 0;
}

export type RepairGroup = "hot" | "warm" | "calm";

/**
 * Три группы очереди.
 *
 * hot  — риск срыва брони: подмены нет и к сроку не успеваем (или срока нет);
 * warm — молчит, просрочен собственный срок, срока нет вовсе либо подмены нет,
 *        но по расчёту успеваем (TIGHT);
 * calm — подмена есть, срок назначен, работы идут. Такое не должно бороться
 *        за внимание с горящим, поэтому в интерфейсе сворачивается.
 */
export function repairGroup(r: RepairListItem): RepairGroup {
  if (r.risk.level === "BLOCKS") return "hot";
  if (r.risk.level === "TIGHT") return "warm";
  if (r.expectedReadyAt === null) return "warm";
  if (isEtaOverdue(r)) return "warm";
  if (isQuiet(r)) return "warm";
  return "calm";
}

const RISK_WEIGHT: Record<RepairRiskLevel, number> = {
  BLOCKS: 0,
  TIGHT: 1,
  COVERED: 2,
  NONE: 3,
};

export type RepairSort = "risk" | "date" | "eta";

/** Сортировка по риску: сначала срыв, внутри — по дате ближайшей брони. */
export function compareByRisk(a: RepairListItem, b: RepairListItem): number {
  const byLevel = RISK_WEIGHT[a.risk.level] - RISK_WEIGHT[b.risk.level];
  if (byLevel !== 0) return byLevel;

  const aStart = a.risk.booking?.startDate;
  const bStart = b.risk.booking?.startDate;
  if (aStart && bStart && aStart !== bStart) return aStart.localeCompare(bStart);
  if (aStart && !bStart) return -1;
  if (!aStart && bStart) return 1;

  const byUrgency = Number(b.urgency === "URGENT") - Number(a.urgency === "URGENT");
  if (byUrgency !== 0) return byUrgency;

  // Дальше — кто дольше лежит, тот выше.
  return a.createdAt.localeCompare(b.createdAt);
}

/** Сортировка по дате заведения: свежие сверху. */
export function compareByDate(a: RepairListItem, b: RepairListItem): number {
  return b.createdAt.localeCompare(a.createdAt);
}

/** Сортировка по сроку возврата: у кого срок ближе — тот выше, безсрочные в конце. */
export function compareByEta(a: RepairListItem, b: RepairListItem): number {
  if (a.expectedReadyAt && b.expectedReadyAt) {
    return a.expectedReadyAt.localeCompare(b.expectedReadyAt);
  }
  if (a.expectedReadyAt) return -1;
  if (b.expectedReadyAt) return 1;
  return compareByRisk(a, b);
}

export function comparatorFor(sort: RepairSort) {
  if (sort === "date") return compareByDate;
  if (sort === "eta") return compareByEta;
  return compareByRisk;
}

export type QueueFilter = "all" | "mine" | "urgent" | "quiet" | "unassigned";

export function matchesFilter(
  r: RepairListItem,
  filter: QueueFilter,
  currentUserId: string | undefined,
): boolean {
  switch (filter) {
    case "mine":
      // Без userId в сессии «моя очередь» пустая — это честнее, чем показать чужую.
      return Boolean(currentUserId) && r.assignedTo === currentUserId;
    case "urgent":
      return r.urgency === "URGENT";
    case "quiet":
      return isQuiet(r);
    case "unassigned":
      return r.assignedTo === null;
    default:
      return true;
  }
}
