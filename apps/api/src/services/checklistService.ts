/**
 * Сервис чек-листа склада (без сканера).
 *
 * Кладовщик отмечает позиции вручную. Штучные (UNIT) отметки хранятся
 * ScanRecord'ами с hmacVerified=false; количества, отметки строк и исходы
 * приёмки — черновиком сессии (`checklistDraft.ts`).
 *
 * Ключевые операции:
 * - getChecklistState — чек-лист, потолки добора, черновик, версия состава;
 * - checkUnit / uncheckUnit — отметка штучной единицы;
 * - addExtraItem — добор позиции из каталога прямо на выдаче;
 * - saveChecklistDraft — черновик (реэкспорт из checklistDraft.ts).
 *
 * В сессию пишут только пока она живая (`assertSessionWritable`): завершённая,
 * прерванная и устаревшая (бронь уже выдали / приняли кнопкой) отвечают 409
 * `SESSION_*`, устаревшая при этом закрывается.
 *
 * Потолок добора — общая формула склада (`stockCap.computeAddCaps`, поверх
 * витринной доступности): пик занятости, блокирующие статусы, без черновиков
 * и архива, за вычетом мастерской и потеряшек. Раньше чек-лист считал сам
 * (сумма броней, DRAFT держал склад, PENDING — нет) и расходился с поиском.
 */

import type { BookingStatus, EstimateLine, Prisma, ScanSessionStatus } from "@prisma/client";

import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";
import { writeAuditEntry } from "./audit";
import { recomputeBookingFinance } from "./finance";
import { recomputeAddonEstimate } from "./addonEstimate";
import { findAddonConflict, findHoldersBatch, type AddonConflict } from "./addonAvailability";
import { addonWindow, computeAddCaps, overStockError, reserveUnits, type AddCapInfo } from "./stockCap";
import { bookingItemKey, loadLineOrdering, sortLinesByCatalog } from "./lineOrder";
import {
  SCAN_ERR,
  SCAN_MSG,
  assertSessionWritable,
  computeItemsVersion,
  ensureSystemAuditUser,
} from "./scanSessionPolicy";
import { parseStoredDraft, type ChecklistDraftV1 } from "./checklistDraft";

export {
  CHECKLIST_DRAFT_LIMITS,
  checklistDraftSchema,
  parseStoredDraft,
  saveChecklistDraft,
  saveChecklistDraftBodySchema,
  validateChecklistDraft,
  type ChecklistDraftV1,
} from "./checklistDraft";

// ── Типы ────────────────────────────────────────────────────────────────────────

export interface ChecklistItem {
  bookingItemId: string;
  equipmentId: string | null;
  equipmentName: string;
  category: string;
  quantity: number;             // required qty
  checkedQty: number;           // how many marked (for UNIT)
  trackingMode: "COUNT" | "UNIT";
  /**
   * Устаревшее поле, всегда false. Добор виден по `addedOnSite` (эта сессия)
   * и `originalQuantity` (сколько было в основной смете).
   */
  isExtra: boolean;
  units?: ChecklistUnit[];      // only for UNIT-mode items
  /** Ставка за смену (Decimal-строка); "0" у произвольной позиции. */
  rentalRatePerShift: string;
  /**
   * Количество в основной смете (MAIN) — что согласовано с клиентом.
   * Произвольная позиция сопоставляется с MAIN по названию. 0 — строки в MAIN
   * нет (позиция целиком добор).
   */
  originalQuantity: number;
  /**
   * Сколько ещё можно добавить к `quantity` без подтверждения (stockCap.addCap
   * на окне «выдаю сейчас»). Степпер: max = quantity + addCap. 0 у произвольных
   * позиций и в приёмке.
   */
  addCap: number;
  /** Потолок «под ответственность» (stockCap.ackCap): чужую бронь подвинуть можно, мастерскую — нет. */
  ackCap: number;
  /** Кто держит единицы сверх `addCap` — только при ackCap > addCap. */
  capHolder: AddonConflict | null;
  /** Цена произвольной позиции за весь период (Decimal-строка), иначе null. */
  customUnitPrice: string | null;
  /** Цена строки основной сметы (MAIN) за весь период (Decimal-строка), иначе null. */
  mainUnitPrice: string | null;
  /** Строка MAIN с договорной ценой — процент скидки к ней не применяется. */
  mainNegotiated: boolean;
  /** Сколько единиц строки добавлено доборами в ЭТОЙ сессии (AddonRecord). */
  addedOnSite: number;
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
  /** Смены из MAIN (для живого расчёта денег); по умолчанию 1. */
  shifts: number;
  /** Процент скидки MAIN ("0".."100"). */
  discountPercent: string;
  /** MAIN.totalAfterDiscount — «Согласовано (исходно)». */
  mainOriginalAfterDiscount: string;
  session: {
    status: ScanSessionStatus;
    operation: "ISSUE" | "RETURN";
    /** Кто открыл сессию. */
    workerName: string;
    startedAt: string;
  };
  booking: {
    status: BookingStatus;
    startDate: string;
    endDate: string;
    finalAmount: string;
    manualFinalAmount: string | null;
  };
  draft: ChecklistDraftV1 | null;
  draftRevision: number;
  draftSavedAt: string | null;
  draftSavedBy: string | null;
  /**
   * Отпечаток состава брони — computeItemsVersion по ВСЕМ BookingItem брони
   * (включая строки ×0, которые в приёмку не попадают). Клиент возвращает его
   * в /complete: состав поменялся — 409 CHECKLIST_OUTDATED.
   */
  itemsVersion: string;
}

// Checklist state model:
// - COUNT positions: qty и отметки — в черновике сессии (клиент + PUT /draft).
// - UNIT positions: persisted via ScanRecord (one record per unit checked).

/** Категория произвольной позиции без своей. */
const CUSTOM_CATEGORY_FALLBACK = "Прочее";

const CHECKLIST_SESSION_INCLUDE = {
  scans: true,
  booking: {
    include: {
      items: {
        orderBy: { createdAt: "asc" },
        include: {
          equipment: {
            select: { id: true, name: true, category: true, stockTrackingMode: true, rentalRatePerShift: true },
          },
          unitReservations: {
            include: { equipmentUnit: { select: { id: true, barcode: true, status: true } } },
          },
        },
      },
    },
  },
} satisfies Prisma.ScanSessionInclude;

type LoadedSession = Prisma.ScanSessionGetPayload<{ include: typeof CHECKLIST_SESSION_INCLUDE }>;
type LoadedItem = LoadedSession["booking"]["items"][number];

interface PricingContext {
  mainByEquipment: Map<string, EstimateLine>;
  mainByCustomName: Map<string, EstimateLine>;
  caps: Map<string, AddCapInfo>;
  holders: Map<string, AddonConflict>;
  addedOnSite: Map<string, number>;
}

// ── getChecklistState ────────────────────────────────────────────────────────────

export async function getChecklistState(sessionId: string): Promise<ChecklistState> {
  // Завершённая / прерванная → 409 с её состоянием; устаревшая (бронь выдали
  // или приняли кнопкой) закрывается и → 409 SESSION_STALE.
  await assertSessionWritable(prisma, sessionId);
  const session = await prisma.scanSession.findUnique({ where: { id: sessionId }, include: CHECKLIST_SESSION_INCLUDE });
  if (!session) throw new HttpError(404, SCAN_MSG.SESSION_NOT_FOUND, SCAN_ERR.SESSION_NOT_FOUND);
  const { booking } = session;
  const isIssue = session.operation === "ISSUE";

  const main = await prisma.estimate.findFirst({
    where: { bookingId: session.bookingId, kind: "MAIN" },
    include: { lines: true },
  });

  // P5: строка, обнулённая на выдаче (×0), в приёмку не попадает — принимать
  // по ней нечего, а экран требовал «пометить все 0 шт» и не пускал дальше.
  const rows = isIssue ? booking.items : booking.items.filter((bi) => bi.quantity > 0);
  const equipmentIds = Array.from(
    new Set(rows.map((bi) => bi.equipmentId).filter((id): id is string => id !== null)),
  );

  const { caps, holders } = isIssue
    ? await loadIssueCaps(session.bookingId, booking, equipmentIds)
    : { caps: new Map<string, AddCapInfo>(), holders: new Map<string, AddonConflict>() };
  const addedGroups = await prisma.addonRecord.groupBy({
    by: ["bookingItemId"],
    where: { sessionId },
    _sum: { quantity: true },
  });
  const pricing: PricingContext = {
    ...indexMainLines(main?.lines ?? []),
    caps,
    holders,
    addedOnSite: new Map(addedGroups.map((g) => [g.bookingItemId, g._sum.quantity ?? 0])),
  };

  // Порядок каталога: кладовщик комплектует бронь категория за категорией, а
  // киоск (PIN-вход) порядок категорий сам запросить не может — берёт наш.
  // Произвольные позиции — в конце; createdAt из выборки остаётся запасным
  // ключом, сортировка стабильная.
  const ordered = sortLinesByCatalog(rows, bookingItemKey, await loadLineOrdering(equipmentIds));
  const { items, progress } = buildChecklistItems(ordered, {
    isIssue,
    pricing,
    scannedUnitIds: new Set(session.scans.map((s) => s.equipmentUnitId)),
    issuedUnits: isIssue ? null : await loadIssuedUnits(session.bookingId),
  });

  return {
    sessionId: session.id,
    bookingId: session.bookingId,
    operation: session.operation as "ISSUE" | "RETURN",
    items,
    progress,
    shifts: main && main.shifts > 0 ? main.shifts : 1,
    discountPercent: main?.discountPercent?.toString() ?? "0",
    mainOriginalAfterDiscount: main?.totalAfterDiscount?.toString() ?? "0",
    session: {
      status: session.status,
      operation: session.operation as "ISSUE" | "RETURN",
      workerName: session.workerName,
      startedAt: session.startedAt.toISOString(),
    },
    booking: {
      status: booking.status,
      startDate: booking.startDate.toISOString(),
      endDate: booking.endDate.toISOString(),
      finalAmount: booking.finalAmount.toString(),
      manualFinalAmount: booking.manualFinalAmount?.toString() ?? null,
    },
    draft: parseStoredDraft(session.draftJson),
    draftRevision: session.draftRevision,
    draftSavedAt: session.draftSavedAt?.toISOString() ?? null,
    draftSavedBy: session.draftSavedBy ?? null,
    itemsVersion: computeItemsVersion(booking.items),
  };
}

/** Строки основной сметы: каталожные — по позиции, произвольные — по названию. */
function indexMainLines(lines: EstimateLine[]): Pick<PricingContext, "mainByEquipment" | "mainByCustomName"> {
  const mainByEquipment = new Map<string, EstimateLine>();
  const mainByCustomName = new Map<string, EstimateLine>();
  for (const line of lines) {
    if (line.equipmentId) {
      if (!mainByEquipment.has(line.equipmentId)) mainByEquipment.set(line.equipmentId, line);
    } else if (!mainByCustomName.has(line.nameSnapshot)) {
      mainByCustomName.set(line.nameSnapshot, line);
    }
  }
  return { mainByEquipment, mainByCustomName };
}

type UnitRow = { id: string; barcode: string | null; status: string };

/**
 * Строки чек-листа и прогресс. Штучная позиция — по единице на отметку;
 * количественная и произвольная — одна строка (количества и отметки живут в
 * черновике сессии).
 */
function buildChecklistItems(
  rows: LoadedItem[],
  ctx: {
    isIssue: boolean;
    pricing: PricingContext;
    scannedUnitIds: ReadonlySet<string>;
    issuedUnits: Map<string, UnitRow[]> | null;
  },
): { items: ChecklistItem[]; progress: ChecklistState["progress"] } {
  const items: ChecklistItem[] = [];
  let totalItems = 0;
  let checkedItems = 0;
  for (const bi of rows) {
    const mode = (bi.equipment?.stockTrackingMode as "COUNT" | "UNIT" | undefined) ?? "COUNT";
    if (mode === "UNIT" && bi.equipmentId) {
      const units = ctx.isIssue ? issueUnitsOf(bi, ctx.scannedUnitIds) : ctx.issuedUnits?.get(bi.id) ?? [];
      const checkedCount = units.filter((u) => ctx.scannedUnitIds.has(u.id)).length;
      totalItems += units.length;
      checkedItems += checkedCount;
      items.push({
        ...catalogRowBase(bi, ctx.pricing),
        checkedQty: checkedCount,
        trackingMode: "UNIT",
        units: units.map((u) => ({
          unitId: u.id,
          barcode: u.barcode,
          checked: ctx.scannedUnitIds.has(u.id),
          problemType: null,
        })),
      });
    } else if (bi.customName) {
      // Произвольная позиция: не каталожная, потолка нет, цена — своя.
      totalItems += 1;
      items.push(customRow(bi, ctx.pricing));
    } else {
      totalItems += 1;
      items.push({ ...catalogRowBase(bi, ctx.pricing), checkedQty: 0, trackingMode: "COUNT" });
    }
  }
  return { items, progress: { checkedItems, totalItems } };
}

/**
 * Потолки степпера на окне «выдаю сейчас» и держатели для строк, где
 * «под ответственность» даёт больше, чем свободно (подпись «Занято: …»).
 */
async function loadIssueCaps(
  bookingId: string,
  booking: { startDate: Date; endDate: Date },
  equipmentIds: string[],
): Promise<{ caps: Map<string, AddCapInfo>; holders: Map<string, AddonConflict> }> {
  const window = addonWindow(booking, { issuingNow: true });
  const caps = await computeAddCaps(prisma, { bookingId, equipmentIds, window });
  const contested = Array.from(caps.values())
    .filter((c) => c.ackCap > c.addCap)
    .map((c) => c.equipmentId);
  const holders = contested.length > 0
    ? await findHoldersBatch(prisma, {
        equipmentIds: contested,
        start: window.start,
        end: window.end,
        excludeBookingId: bookingId,
      })
    : new Map<string, AddonConflict>();
  return { caps, holders };
}

/** Приёмка: выданные единицы брони (живые резервы) по позициям. */
async function loadIssuedUnits(bookingId: string): Promise<Map<string, UnitRow[]>> {
  const reservations = await prisma.bookingItemUnit.findMany({
    where: { bookingItem: { bookingId }, returnedAt: null },
    include: { equipmentUnit: { select: { id: true, barcode: true, status: true } } },
  });
  const byItem = new Map<string, UnitRow[]>();
  for (const r of reservations) {
    const list = byItem.get(r.bookingItemId) ?? [];
    list.push({ id: r.equipmentUnit.id, barcode: r.equipmentUnit.barcode, status: r.equipmentUnit.status });
    byItem.set(r.bookingItemId, list);
  }
  return byItem;
}

/**
 * Выдача: зарезервированные единицы, ещё стоящие на полке (или уже отмеченные).
 * Нет резервов (старые данные) — заглушки по количеству: отметить их нельзя,
 * позиция выдаётся количеством.
 */
function issueUnitsOf(bi: LoadedItem, scannedUnitIds: ReadonlySet<string>): UnitRow[] {
  const units = bi.unitReservations
    .filter((r) => r.equipmentUnit?.status === "AVAILABLE" || scannedUnitIds.has(r.equipmentUnit?.id ?? ""))
    .map((r) => ({ id: r.equipmentUnit.id, barcode: r.equipmentUnit.barcode, status: r.equipmentUnit.status }));
  if (units.length > 0) return units;
  return Array.from({ length: bi.quantity }, (_, i) => ({
    id: `placeholder-${bi.id}-${i}`,
    barcode: null,
    status: "AVAILABLE",
  }));
}

/** Общая часть строки каталожной позиции (COUNT и UNIT). */
function catalogRowBase(
  bi: LoadedItem,
  p: PricingContext,
): Omit<ChecklistItem, "checkedQty" | "trackingMode" | "units"> {
  const eqId = bi.equipmentId;
  const cap = eqId ? p.caps.get(eqId) : undefined;
  const line = eqId ? p.mainByEquipment.get(eqId) : undefined;
  const addCap = cap?.addCap ?? 0;
  const ackCap = Math.max(addCap, cap?.ackCap ?? 0);
  return {
    bookingItemId: bi.id,
    equipmentId: bi.equipmentId,
    equipmentName: bi.equipment?.name ?? "Позиция удалена из каталога",
    category: bi.equipment?.category ?? "Без категории",
    quantity: bi.quantity,
    isExtra: false,
    rentalRatePerShift: bi.equipment?.rentalRatePerShift?.toString() ?? "0",
    originalQuantity: line?.quantity ?? 0,
    addCap,
    ackCap,
    capHolder: eqId && ackCap > addCap ? p.holders.get(eqId) ?? null : null,
    customUnitPrice: null,
    mainUnitPrice: line ? line.unitPrice.toString() : null,
    mainNegotiated: line?.listUnitPrice != null,
    addedOnSite: p.addedOnSite.get(bi.id) ?? 0,
  };
}

/** Строка произвольной позиции: своя категория и цена, сопоставление с MAIN по названию. */
function customRow(bi: LoadedItem, p: PricingContext): ChecklistItem {
  const line = bi.customName ? p.mainByCustomName.get(bi.customName) : undefined;
  return {
    bookingItemId: bi.id,
    equipmentId: null,
    equipmentName: bi.customName ?? "Произвольная позиция",
    category: bi.customCategory?.trim() || CUSTOM_CATEGORY_FALLBACK,
    quantity: bi.quantity,
    checkedQty: 0,
    trackingMode: "COUNT",
    isExtra: false,
    rentalRatePerShift: "0",
    originalQuantity: line?.quantity ?? 0,
    addCap: 0,
    ackCap: 0,
    capHolder: null,
    customUnitPrice: bi.customUnitPrice?.toString() ?? null,
    mainUnitPrice: line ? line.unitPrice.toString() : null,
    mainNegotiated: line?.listUnitPrice != null,
    addedOnSite: p.addedOnSite.get(bi.id) ?? 0,
  };
}

// ── checkUnit / uncheckUnit ──────────────────────────────────────────────────────

/**
 * Отмечает UNIT-позицию как выданную/принятую.
 * Создаёт ScanRecord с hmacVerified=false (ручной чек-лист).
 */
export async function checkUnit(
  sessionId: string,
  equipmentUnitId: string,
): Promise<{ alreadyChecked: boolean }> {
  const { session } = await assertSessionWritable(prisma, sessionId);

  const unit = await prisma.equipmentUnit.findUnique({ where: { id: equipmentUnitId } });
  if (!unit) throw new HttpError(404, "Единица оборудования не найдена", "UNIT_NOT_FOUND");

  const bookingItem = await prisma.bookingItem.findFirst({
    where: { bookingId: session.bookingId, equipmentId: unit.equipmentId },
    include: { unitReservations: { select: { equipmentUnitId: true } } },
  });
  if (!bookingItem) throw new HttpError(409, "Оборудование не входит в эту бронь", "UNIT_NOT_IN_BOOKING");

  // Приёмка: только единица, выданная по этой брони. Выдача — достаточно
  // позиции: единицу на полке можно заменить другой.
  if (session.operation === "RETURN") {
    const isReserved = bookingItem.unitReservations.some((r) => r.equipmentUnitId === equipmentUnitId);
    if (!isReserved) {
      throw new HttpError(409, "Эта единица не числится в брони", "UNIT_NOT_RESERVED");
    }
  }

  // Идемпотентность: если уже отмечено — no-op
  try {
    await prisma.scanRecord.create({ data: { sessionId, equipmentUnitId, hmacVerified: false } });
    return { alreadyChecked: false };
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === "P2002") return { alreadyChecked: true };
    throw err;
  }
}

/** Снимает отметку с UNIT-позиции. */
export async function uncheckUnit(
  sessionId: string,
  equipmentUnitId: string,
): Promise<{ wasChecked: boolean }> {
  await assertSessionWritable(prisma, sessionId);
  const res = await prisma.scanRecord.deleteMany({ where: { sessionId, equipmentUnitId } });
  return { wasChecked: res.count > 0 };
}

// ── addExtraItem ─────────────────────────────────────────────────────────────────

/**
 * Добор позиции из каталога прямо на выдаче (quick-add в киоске).
 *
 * Только живая ISSUE-сессия (бронь подтверждена): на приёмке — 409
 * ADDON_ONLY_ON_ISSUE, довезти в выданную бронь можно «+ Добор» на карточке.
 * Окно проверки — «выдаю сейчас»: с текущего момента до конца брони.
 *
 *  - свободно меньше, чем «уже в брони + запрошено», и есть чужая бронь-
 *    держатель → 409 ADDON_CONFLICT с карточкой держателя (soft-warn);
 *  - с `acknowledgedConflict` при таком конфликте потолок — ackCap (чужую
 *    бронь подвинуть можно, мастерскую и потерянное — нет), аудит
 *    `BOOKING_ITEM_ADDED_WITH_CONFLICT`;
 *  - иначе потолок addCap; сверх — 409 ADDON_OVER_STOCK с названием позиции.
 *
 * Штучная позиция сразу резервирует свободные экземпляры (выдача переведёт их
 * в ISSUED): без резерва в чек-листе были «заглушки», отметить их было нельзя,
 * и выданные приборы оставались «на полке».
 *
 * Аудит пишется в той же транзакции: автор — `auditUserId` (киоск открыт
 * главной сессией) или `_system_` с именем кладовщика в `after.workerName`
 * (PIN-вход).
 */
export async function addExtraItem(
  sessionId: string,
  equipmentId: string,
  quantity: number,
  createdBy: string,
  acknowledgedConflict = false,
  auditUserId?: string,
): Promise<{ bookingItemId: string }> {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new HttpError(400, "Количество должно быть целым числом больше нуля", "INVALID_QUANTITY");
  }
  const { session, booking } = await assertSessionWritable(prisma, sessionId);
  if (session.operation !== "ISSUE") {
    throw new HttpError(409, SCAN_MSG.ADDON_ONLY_ON_ISSUE, SCAN_ERR.ADDON_ONLY_ON_ISSUE);
  }
  const equipment = await prisma.equipment.findUnique({
    where: { id: equipmentId },
    select: { id: true, name: true, stockTrackingMode: true },
  });
  if (!equipment) throw new HttpError(404, "Оборудование не найдено", "EQUIPMENT_NOT_FOUND");
  const bookingId = booking.id;

  let result: { bookingItemId: string };
  try {
    result = await prisma.$transaction(
      (tx) => addExtraItemTx(tx, {
        sessionId, bookingId, equipment, quantity, createdBy, acknowledgedConflict, auditUserId,
      }),
      { maxWait: 10_000, timeout: 15_000 },
    );
  } catch (err) {
    // Бронь выдали или отменили между проверкой и записью: сессия устарела —
    // закрываем её вне транзакции (assertSessionWritable бросит тот же 409).
    if (err instanceof HttpError && err.code === SCAN_ERR.SESSION_STALE) {
      await assertSessionWritable(prisma, sessionId);
    }
    throw err;
  }

  // ADDON-смета и финансы — после транзакции, best-effort: следующий успешный
  // пересчёт восстановит инвариант, а физический добор уже записан.
  await recomputeAddonEstimate(bookingId).catch((err: unknown) => {
    console.error("[addExtraItem] recomputeAddonEstimate failed:", err);
  });
  await recomputeBookingFinance(bookingId).catch((err: unknown) => {
    console.error("[addExtraItem] recomputeBookingFinance failed:", err);
  });

  return result;
}

async function addExtraItemTx(
  tx: Prisma.TransactionClient,
  a: {
    sessionId: string;
    bookingId: string;
    equipment: { id: string; name: string; stockTrackingMode: string };
    quantity: number;
    createdBy: string;
    acknowledgedConflict: boolean;
    auditUserId?: string;
  },
): Promise<{ bookingItemId: string }> {
  const { booking } = await assertSessionWritable(tx, a.sessionId, { inTx: true });
  const equipmentId = a.equipment.id;
  const window = addonWindow(booking, { issuingNow: true });

  const existing = await tx.bookingItem.findUnique({
    where: { bookingId_equipmentId: { bookingId: a.bookingId, equipmentId } },
    select: { quantity: true },
  });
  const alreadyInBooking = existing?.quantity ?? 0;

  const conflict = await findAddonConflict(equipmentId, window.start, window.end, a.bookingId, {
    requested: a.quantity,
    alreadyInBooking,
    tx,
  });
  if (conflict && !a.acknowledgedConflict) {
    throw new HttpError(409, `«${a.equipment.name}» занят на даты брони`, SCAN_ERR.ADDON_CONFLICT, {
      ...conflict,
      equipmentId,
      name: a.equipment.name,
      quantity: a.quantity,
    });
  }

  const cap = (await computeAddCaps(tx, {
    bookingId: a.bookingId,
    equipmentIds: [equipmentId],
    window,
  })).get(equipmentId);
  // Без конфликта подтверждение ничего не расширяет: клиент не может выдать
  // сверх склада, просто прислав acknowledgedConflict.
  const limit = conflict && a.acknowledgedConflict ? cap?.ackCap ?? 0 : cap?.addCap ?? 0;
  if (a.quantity > limit) {
    throw overStockError({
      equipmentId,
      name: a.equipment.name,
      addCap: limit,
      requested: a.quantity,
      alreadyInBooking,
    });
  }

  const item = await tx.bookingItem.upsert({
    where: { bookingId_equipmentId: { bookingId: a.bookingId, equipmentId } },
    update: { quantity: { increment: a.quantity } },
    create: { bookingId: a.bookingId, equipmentId, quantity: a.quantity },
  });

  const reservedUnitIds = a.equipment.stockTrackingMode === "UNIT"
    ? await reserveUnits(tx, {
        bookingId: a.bookingId,
        bookingItemId: item.id,
        equipmentId,
        equipmentName: a.equipment.name,
        quantity: a.quantity,
        start: window.start,
        end: window.end,
        issueNow: false,
      })
    : [];

  // Дельта для ADDON-сметы: BookingItem.quantity хранит итог, а не «сколько добавили сейчас».
  await tx.addonRecord.create({
    data: {
      bookingId: a.bookingId,
      sessionId: a.sessionId,
      bookingItemId: item.id,
      equipmentId,
      quantity: a.quantity,
      acknowledgedConflict: Boolean(conflict && a.acknowledgedConflict),
      createdBy: a.createdBy,
    },
  });

  await writeAuditEntry({
    tx,
    userId: a.auditUserId ?? (await ensureSystemAuditUser(tx)),
    action: conflict ? "BOOKING_ITEM_ADDED_WITH_CONFLICT" : "BOOKING_ITEM_ADDED_ON_SITE",
    entityType: "Booking",
    entityId: a.bookingId,
    before: null,
    after: {
      via: "kiosk",
      sessionId: a.sessionId,
      workerName: a.createdBy,
      equipmentId,
      equipmentName: a.equipment.name,
      quantity: a.quantity,
      bookingItemId: item.id,
      ...(reservedUnitIds.length > 0 ? { unitsReserved: reservedUnitIds.length } : {}),
      ...(conflict ? { conflict } : {}),
    },
  });

  return { bookingItemId: item.id };
}
