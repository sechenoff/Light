/**
 * «Как пропало» — след позиции между пересчётами (спека §5).
 *
 * Недостачу на полке объясняют брони, которые брали позицию после прошлой сверки,
 * и то, КАК их принимали. Приёмка в киоске подтверждает только свою бронь (что
 * приехало ровно то, что уехало), но не склад целиком, поэтому окно сужает лишь
 * инвентаризация (`Equipment.lastCountedAt` — момент, когда полку посчитали), а
 * не приёмка.
 *
 * Брони окна: `endDate ≥ окно`, ISSUED независимо от дат и фактически принятые в
 * окне (завершённая сессия возврата в киоске или аудит `BOOKING_RETURNED` не
 * раньше начала окна) — просроченная бронь, которую вернули уже после прошлой
 * сверки, тоже в следе. RETURNED без единого следа возврата (путь бот-ключа,
 * легаси-импорт) и `endDate` до окна датировать нечем — они в след не попадают.
 *
 * Режимы приёмки (`returnMode`) — на момент `at` (для посчитанной строки — момент
 * счёта, чтобы «ещё у клиента» совпадало со снапшотом):
 *  - KIOSK  — есть завершённая сессия возврата в киоске; `returnedBy` — кладовщик,
 *             замечания — потеряшки и ремонты по этой позиции этой брони;
 *  - AUTO   — возврат отметила система (аудит `BOOKING_RETURNED` от `_system_`);
 *  - MANUAL — возврат отметили кнопкой без пересчёта (любой другой аудит
 *             `BOOKING_RETURNED`) или бронь RETURNED без следа вовсе; сюда же —
 *             CONFIRMED с endDate < at: ни выдача, ни возврат не отмечены, а по
 *             формуле §3 оборудование уже на полке (`returnedBy = null`, статус
 *             остаётся CONFIRMED — по нему UI отличает «срок вышел, возврат не
 *             отмечен» от «вернули кнопкой»);
 *  - OUT    — бронь была у клиента на `at` по формуле §3: ISSUED, CONFIRMED с
 *             `at` внутри [startDate; endDate], или RETURNED, чей фактический
 *             возврат (сессия киоска / аудит) позже `at`.
 *
 * Кандидаты «с этой брони и ушло» — брони в окне, принятые НЕ через киоск; если
 * такой ровно один, он и есть подсказка. Исключены только брони OUT: лишь их
 * количество уже вычтено из «на полке должно быть». Подсказки нет, если в окне
 * мастерская списала или починила позицию (`repairEvents`): это объясняет
 * недостачу не хуже брони, и вешать её на клиента нельзя.
 *
 * Все выборки — батчем: один и тот же загрузчик (`loadTrailCores`) строит и
 * полный след одной позиции, и подсказки для всех строк «Итога» разом
 * (`getTrailSuggestions`), поэтому подсказка в строке и в раскрытом следе
 * совпадают по построению.
 */

import type { BookingStatus, Prisma } from "@prisma/client";

import { prisma } from "../../prisma";
import { HttpError } from "../../utils/errors";
import { READY_FOR_PICKUP_WINDOW_DAYS } from "../warehouseWorkstation";
import { computeExpectedOnShelf, toBreakdown, EMPTY_BREAKDOWN } from "./expected";
import type {
  EquipmentTrail,
  ReturnMode,
  TrailBooking,
  TrailOpenProblem,
  TrailRepairEvents,
  TrailSuggestion,
} from "./types";

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
   *  - Date      — явно (например, момент счёта позиции в прошлой инвентаризации);
   *  - null      — прошлой сверки не было: окно по умолчанию от `at`, без
   *                оглядки на `lastCountedAt`;
   *  - undefined — `equipment.lastCountedAt`, а без него окно по умолчанию.
   */
  since?: Date | null;
  /** Момент, на который строится след. По умолчанию — сейчас. */
  at?: Date;
}

/** Окно следа: одно правило для полного следа и для подсказок «Итога». */
export function resolveTrailWindow(
  lastCountedAt: Date | null,
  since: Date | null | undefined,
  at: Date,
): { windowFrom: Date; windowIsDefault: boolean } {
  const defaultFrom = new Date(at.getTime() - TRAIL_DEFAULT_WINDOW_DAYS * DAY_MS);
  if (since instanceof Date) return { windowFrom: since, windowIsDefault: false };
  if (since === null) return { windowFrom: defaultFrom, windowIsDefault: true };
  return { windowFrom: lastCountedAt ?? defaultFrom, windowIsDefault: lastCountedAt == null };
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

// ── Загрузка (батчем) ────────────────────────────────────────────────────────

/** Для какой позиции, с какого момента и на какой момент строится след. */
export interface TrailTarget {
  equipmentId: string;
  windowFrom: Date;
  at: Date;
}

export interface TrailItem {
  quantity: number;
  booking: {
    id: string;
    projectName: string;
    startDate: Date;
    endDate: Date;
    status: BookingStatus;
    client: { name: string };
  };
}

/** Как и когда вернули брони — по последней сессии киоска и последнему аудиту возврата. */
export interface TrailReturnFacts {
  kiosk: Map<string, { workerName: string; completedAt: Date | null }>;
  audit: Map<string, { username: string; createdAt: Date }>;
}

interface TrailCore {
  /** Брони окна с позицией: startDate desc, не больше TRAIL_SCAN_CAP. */
  items: TrailItem[];
  repairEvents: TrailRepairEvents;
}

function maxDate(a: Date | null | undefined, b: Date | null | undefined): Date | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

/**
 * Брони, фактически принятые не раньше `from`: bookingId → момент последнего
 * возврата в окне (сессия киоска или аудит `BOOKING_RETURNED`).
 */
async function loadLateReturns(equipmentIds: string[], from: Date): Promise<Map<string, Date>> {
  const result = new Map<string, Date>();
  const sessions = await prisma.scanSession.findMany({
    where: {
      operation: "RETURN",
      status: "COMPLETED",
      completedAt: { gte: from },
      booking: { items: { some: { equipmentId: { in: equipmentIds } } } },
    },
    select: { bookingId: true, completedAt: true },
  });
  for (const s of sessions) {
    const t = maxDate(result.get(s.bookingId), s.completedAt);
    if (t) result.set(s.bookingId, t);
  }
  const audits = await prisma.auditEntry.findMany({
    where: { entityType: "Booking", action: "BOOKING_RETURNED", createdAt: { gte: from } },
    select: { entityId: true, createdAt: true },
  });
  for (const a of audits) {
    const t = maxDate(result.get(a.entityId), a.createdAt);
    if (t) result.set(a.entityId, t);
  }
  return result;
}

async function loadReturnFacts(returnedIds: string[]): Promise<TrailReturnFacts> {
  const facts: TrailReturnFacts = { kiosk: new Map(), audit: new Map() };
  if (returnedIds.length === 0) return facts;
  // Киоск: последняя завершённая сессия возврата по брони.
  const sessions = await prisma.scanSession.findMany({
    where: { bookingId: { in: returnedIds }, operation: "RETURN", status: "COMPLETED" },
    select: { bookingId: true, workerName: true, completedAt: true },
    orderBy: [{ completedAt: "desc" }, { startedAt: "desc" }],
  });
  for (const s of sessions) {
    if (!facts.kiosk.has(s.bookingId)) facts.kiosk.set(s.bookingId, { workerName: s.workerName, completedAt: s.completedAt });
  }
  // Кнопка / система: последняя запись аудита BOOKING_RETURNED по брони.
  // Сортировка сначала по entityId — именно она заставляет SQLite взять индекс
  // (entityType, entityId). С одним ORDER BY createdAt планировщик выбирает
  // (entityType, createdAt), чтобы не сортировать, и проходит ВСЮ историю
  // аудита броней.
  const audits = await prisma.auditEntry.findMany({
    where: { entityType: "Booking", action: "BOOKING_RETURNED", entityId: { in: returnedIds } },
    select: { entityId: true, createdAt: true, user: { select: { username: true } } },
    orderBy: [{ entityId: "asc" }, { createdAt: "desc" }, { id: "desc" }],
  });
  for (const a of audits) {
    if (!facts.audit.has(a.entityId)) facts.audit.set(a.entityId, { username: a.user.username, createdAt: a.createdAt });
  }
  return facts;
}

function emptyRepairEvents(): TrailRepairEvents {
  return { writtenOffQty: 0, readyForPickupQty: 0 };
}

async function loadRepairEvents(targets: TrailTarget[]): Promise<Map<string, TrailRepairEvents>> {
  const result = new Map<string, TrailRepairEvents>();
  const ids = targets.map((t) => t.equipmentId);
  const pickupMs = READY_FOR_PICKUP_WINDOW_DAYS * DAY_MS;
  const from = new Date(
    Math.min(...targets.map((t) => Math.min(t.windowFrom.getTime(), t.at.getTime() - pickupMs))),
  );
  const to = new Date(Math.max(...targets.map((t) => t.at.getTime())));
  const rows = await prisma.repair.findMany({
    where: {
      unitId: null,
      status: { in: ["WROTE_OFF", "CLOSED"] },
      closedAt: { gte: from, lte: to },
      OR: [{ equipmentId: { in: ids } }, { bookingItem: { equipmentId: { in: ids } } }],
    },
    select: {
      quantity: true,
      status: true,
      closedAt: true,
      equipmentId: true,
      bookingItem: { select: { equipmentId: true } },
    },
  });
  const byTarget = new Map(targets.map((t) => [t.equipmentId, t]));
  for (const row of rows) {
    const equipmentId = row.equipmentId ?? row.bookingItem?.equipmentId;
    const target = equipmentId ? byTarget.get(equipmentId) : undefined;
    if (!target || !row.closedAt) continue;
    const t = row.closedAt.getTime();
    if (t > target.at.getTime()) continue;
    const events = result.get(target.equipmentId) ?? emptyRepairEvents();
    if (row.status === "WROTE_OFF" && t >= target.windowFrom.getTime()) events.writtenOffQty += row.quantity;
    if (row.status === "CLOSED" && t >= target.at.getTime() - pickupMs) events.readyForPickupQty += row.quantity;
    result.set(target.equipmentId, events);
  }
  return result;
}

/**
 * Брони окна по каждой позиции, как вернули брони и события мастерской — для
 * любого числа позиций одним набором запросов.
 */
export async function loadTrailCores(
  targets: TrailTarget[],
): Promise<{ cores: Map<string, TrailCore>; returns: TrailReturnFacts }> {
  const cores = new Map<string, TrailCore>();
  if (targets.length === 0) return { cores, returns: { kiosk: new Map(), audit: new Map() } };
  const ids = targets.map((t) => t.equipmentId);
  const minFrom = new Date(Math.min(...targets.map((t) => t.windowFrom.getTime())));
  const maxAt = new Date(Math.max(...targets.map((t) => t.at.getTime())));

  const lateReturns = await loadLateReturns(ids, minFrom);
  const items = await prisma.bookingItem.findMany({
    where: {
      equipmentId: { in: ids },
      booking: {
        deletedAt: null,
        status: { in: TRAIL_STATUSES },
        startDate: { lte: maxAt },
        OR: [
          { endDate: { gte: minFrom } },
          { status: "ISSUED" },
          { id: { in: Array.from(lateReturns.keys()) } },
        ],
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
          endDate: true,
          status: true,
          client: { select: { name: true } },
        },
      },
    },
    orderBy: [{ booking: { startDate: "desc" } }, { bookingId: "desc" }],
    // Одна позиция — фильтр выше и есть её окно, потолок можно отдать базе.
    ...(targets.length === 1 ? { take: TRAIL_SCAN_CAP } : {}),
  });

  const byTarget = new Map(targets.map((t) => [t.equipmentId, t]));
  for (const t of targets) cores.set(t.equipmentId, { items: [], repairEvents: emptyRepairEvents() });
  for (const item of items) {
    const target = item.equipmentId ? byTarget.get(item.equipmentId) : undefined;
    const core = target ? cores.get(target.equipmentId) : undefined;
    if (!target || !core || core.items.length >= TRAIL_SCAN_CAP) continue;
    const b = item.booking;
    if (b.startDate.getTime() > target.at.getTime()) continue;
    const late = lateReturns.get(b.id);
    const inWindow =
      b.endDate.getTime() >= target.windowFrom.getTime() ||
      b.status === "ISSUED" ||
      (late != null && late.getTime() >= target.windowFrom.getTime());
    if (!inWindow) continue;
    core.items.push({ quantity: item.quantity, booking: b });
  }

  const returnedIds = Array.from(
    new Set(
      Array.from(cores.values()).flatMap((c) =>
        c.items.filter((i) => i.booking.status === "RETURNED").map((i) => i.booking.id),
      ),
    ),
  );
  const returns = await loadReturnFacts(returnedIds);
  const repairEvents = await loadRepairEvents(targets);
  for (const [equipmentId, events] of repairEvents) {
    const core = cores.get(equipmentId);
    if (core) core.repairEvents = events;
  }
  return { cores, returns };
}

// ── Классификация (чистая) ───────────────────────────────────────────────────

export type TrailRemarks = Map<string, { problemQty: number; repairQty: number }>;

/**
 * Как принимали каждую бронь на момент `at` и какая бронь — подсказка.
 * Чистая функция: её зовут и полный след, и подсказки «Итога», чтобы правила
 * не разошлись.
 */
export function classifyTrailBookings(
  items: TrailItem[],
  returns: TrailReturnFacts,
  at: Date,
  opts: { remarks?: TrailRemarks; suppressSuggestion?: boolean } = {},
): { bookings: TrailBooking[]; suggestedBookingId: string | null } {
  const bookings: TrailBooking[] = items.map((item) => {
    const b = item.booking;
    const kiosk = returns.kiosk.get(b.id);
    const audit = returns.audit.get(b.id);
    const returnedAt = b.status === "RETURNED" ? maxDate(kiosk?.completedAt, audit?.createdAt) : null;
    let returnMode: ReturnMode;
    let returnedBy: string | null = null;
    let remarks: TrailBooking["remarks"] = null;
    // «Ещё у клиента» — ровно те брони, что формула §3 вычитала из полки на `at`:
    // ISSUED независимо от дат, CONFIRMED, у которой `at` внутри [startDate; endDate]
    // (startDate ≤ at уже в выборке), и RETURNED, которую приняли уже после `at`.
    const stillOut =
      b.status === "ISSUED" ||
      (b.status === "CONFIRMED" && b.endDate.getTime() >= at.getTime()) ||
      (returnedAt != null && returnedAt.getTime() > at.getTime());
    if (stillOut) {
      returnMode = "OUT";
    } else if (b.status !== "RETURNED") {
      // CONFIRMED и срок вышел: ни выдачу, ни возврат не отметили, а по формуле
      // оборудование уже должно быть на полке — кандидат, принять его было некому.
      returnMode = "MANUAL";
    } else if (kiosk) {
      returnMode = "KIOSK";
      returnedBy = kiosk.workerName;
      remarks = opts.remarks?.get(b.id) ?? { problemQty: 0, repairQty: 0 };
    } else {
      const username = audit?.username ?? null;
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
  const candidates = bookings.filter((b) => b.returnMode === "MANUAL" || b.returnMode === "AUTO");
  const suggestedBookingId = !opts.suppressSuggestion && candidates.length === 1 ? candidates[0]!.bookingId : null;
  return { bookings, suggestedBookingId };
}

function hasRepairEvents(events: TrailRepairEvents): boolean {
  return events.writtenOffQty + events.readyForPickupQty > 0;
}

/** Подсказка, которую видно в отданных броннях (первые TRAIL_MAX_BOOKINGS) — иначе её не показать. */
function visibleSuggestion(bookings: TrailBooking[], suggestedBookingId: string | null): TrailSuggestion | null {
  if (!suggestedBookingId) return null;
  const b = bookings.slice(0, TRAIL_MAX_BOOKINGS).find((x) => x.bookingId === suggestedBookingId);
  if (!b) return null;
  return {
    bookingId: b.bookingId,
    projectName: b.projectName,
    clientName: b.clientName,
    quantity: b.quantity,
    startDate: b.startDate,
    endDate: b.endDate,
  };
}

/**
 * Подсказки следа для многих позиций разом — без полного следа (замечаний
 * киоска, потеряшек, разбивки полки). Ровно `visibleSuggestion` полного следа
 * с теми же окном и моментом.
 */
export async function getTrailSuggestionsFor(targets: TrailTarget[]): Promise<Map<string, TrailSuggestion | null>> {
  const result = new Map<string, TrailSuggestion | null>();
  const { cores, returns } = await loadTrailCores(targets);
  for (const target of targets) {
    const core = cores.get(target.equipmentId);
    if (!core) {
      result.set(target.equipmentId, null);
      continue;
    }
    const { bookings, suggestedBookingId } = classifyTrailBookings(core.items, returns, target.at, {
      suppressSuggestion: hasRepairEvents(core.repairEvents),
    });
    result.set(target.equipmentId, visibleSuggestion(bookings, suggestedBookingId));
  }
  return result;
}

// ── Полный след одной позиции ────────────────────────────────────────────────

async function loadKioskRemarks(equipmentId: string, kioskIds: string[]): Promise<TrailRemarks> {
  const remarks: TrailRemarks = new Map();
  if (kioskIds.length === 0) return remarks;
  const entry = (id: string) => {
    const r = remarks.get(id) ?? { problemQty: 0, repairQty: 0 };
    remarks.set(id, r);
    return r;
  };
  const problems = await prisma.problemItem.findMany({
    where: { sourceBookingId: { in: kioskIds }, ...problemOfEquipment(equipmentId) },
    select: { sourceBookingId: true, quantity: true },
  });
  for (const p of problems) if (p.sourceBookingId) entry(p.sourceBookingId).problemQty += p.quantity;
  const repairs = await prisma.repair.findMany({
    where: { sourceBookingId: { in: kioskIds }, ...repairOfEquipment(equipmentId) },
    select: { sourceBookingId: true, quantity: true },
  });
  for (const r of repairs) if (r.sourceBookingId) entry(r.sourceBookingId).repairQty += r.quantity;
  return remarks;
}

async function loadOpenProblems(equipmentId: string): Promise<TrailOpenProblem[]> {
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
  return openProblemRows.map((p) => {
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

  const { windowFrom, windowIsDefault } = resolveTrailWindow(equipment.lastCountedAt, opts.since, at);
  const { cores, returns } = await loadTrailCores([{ equipmentId, windowFrom, at }]);
  const core = cores.get(equipmentId) ?? { items: [], repairEvents: emptyRepairEvents() };

  // Замечания приёмки в киоске — только по этой позиции этой брони.
  const kioskIds = core.items
    .filter((i) => i.booking.status === "RETURNED" && returns.kiosk.has(i.booking.id))
    .map((i) => i.booking.id);
  const remarks = await loadKioskRemarks(equipmentId, kioskIds);
  const { bookings: allBookings, suggestedBookingId } = classifyTrailBookings(core.items, returns, at, {
    remarks,
    suppressSuggestion: hasRepairEvents(core.repairEvents),
  });

  const openProblems = await loadOpenProblems(equipmentId);
  const shelf = (await computeExpectedOnShelf([equipmentId], at)).get(equipmentId);

  return {
    equipmentId: equipment.id,
    name: equipment.name,
    category: equipment.category,
    windowFrom: windowFrom.toISOString(),
    windowIsDefault,
    totalBookings: allBookings.length,
    verifiedReturns: allBookings.filter((b) => b.returnMode === "KIOSK").length,
    bookings: allBookings.slice(0, TRAIL_MAX_BOOKINGS),
    suggestedBookingId,
    openProblems,
    onShelf: shelf ? toBreakdown(shelf) : { ...EMPTY_BREAKDOWN },
    repairEvents: core.repairEvents,
  };
}
