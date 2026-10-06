import { assertProjectStockForBooking } from "./projectStockGuard";
/**
 * Добор в подтверждённую / выданную бронь со страницы брони (не из киоска).
 *
 * Сценарий: оборудование уже у клиента (ISSUED), гафер звонит и просит довезти
 * ещё — менеджер открывает бронь, добавляет позиции и выбирает, как это считать:
 *
 *   mode = "ADDON"  — отдельной доп-сметой. MAIN не трогаем; ADDON = items − MAIN
 *                     (`recomputeAddonEstimate`), клиент получает документ
 *                     «Смета-добор» с номером «…/д».
 *   mode = "MERGE"  — в основную смету. Строки MAIN увеличиваются на добавленное
 *                     количество ТОЧЕЧНО (без пересборки всего снапшота), поэтому
 *                     ранее сделанные доборы остаются отдельным документом, а
 *                     остальные строки MAIN не перечитываются по текущему прайсу.
 *
 * Почему не PATCH /:id с items: у выданной брони состав заблокирован
 * (ITEMS_LOCKED_UNTIL_RETURN) — PATCH пересоздаёт BookingItem'ы delete+create и
 * каскадно сносит резервы юнитов, а сверка выдачи/приёмки на них держится.
 * Здесь — только инкремент количества (как quick-add на складе), резервы
 * существующих позиций не трогаются.
 *
 * Юниты (UNIT-режим): доставленные экземпляры резервируются сразу
 * (BookingItemUnit), а у выданной брони переводятся в ISSUED — иначе на приёмке
 * чек-лист их не покажет (RETURN строится по живым резервам), и единицы навсегда
 * останутся «доступными», хотя физически лежат у клиента.
 *
 * Доступность: soft-warn конфликта (`findAddonConflict`) + hard cap по
 * физическому складу — та же пара правил, что у quick-add на складе. Потолок
 * и конфликт считаются одной формулой (`stockCap.computeAddCaps` поверх
 * витрины: `BLOCKING_STATUSES`, архивные не занимают, пик, а не сумма,
 * потеряшки и ремонты вычтены), чтобы «свободно ×N» в поиске и отказ сервера
 * сходились на одном числе. Конфликт есть, если свободно меньше, чем «уже в
 * брони + просят»; «под ответственность» поднимает потолок до физического
 * склада (`ackCap`), но не выдаёт то, что в мастерской или потеряно.
 *
 * Окно проверки — `addonWindow`: у выданной брони позиция уезжает прямо
 * сейчас, поэтому [сейчас, конец брони), а у просроченной — текущий момент
 * (раньше проверка шла по прошедшим датам, и добор «проходил», хотя прибор
 * сегодня у другой брони). У подтверждённой — даты брони.
 */
import Decimal from "decimal.js";
import type { Prisma } from "@prisma/client";

import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";
import { billableShifts24h } from "../utils/dates";
import { writeAuditEntry } from "./audit";
import { findAddonConflict, findHoldersBatch, type AddonConflict } from "./addonAvailability";
import { recomputeAddonEstimate } from "./addonEstimate";
import { getAvailability } from "./availability";
import { createFinanceEvent, recomputeBookingFinance } from "./finance";
import { resolveBookingLinePrice, splitEquipmentDiscount } from "./pricing";
import { effectiveLineShifts } from "@light-rental/shared";
import { pluralShifts } from "./smetaExport/shiftsNote";
import { assertAddonAllowedForFamily } from "./bookingFamily";
import { findBlockingScanSession, scanSessionActiveError } from "./scanSessionPolicy";
import { addonWindow, computeAddCaps, overStockError, reserveUnits, type StockWindow } from "./stockCap";

type TxClient = Prisma.TransactionClient;

export type AddonMode = "ADDON" | "MERGE";
export const ADDON_MODES = ["ADDON", "MERGE"] as const satisfies readonly AddonMode[];

/** Статусы, в которых добор осмыслен: оборудование зарезервировано или уже у клиента. */
const ADDON_ALLOWED_STATUSES = ["CONFIRMED", "ISSUED"] as const;

/** Влить доп-смету можно и после приёмки — это решение о документах, не о складе. */
const MERGE_ALLOWED_STATUSES = ["CONFIRMED", "ISSUED", "RETURNED"] as const;

/** Верхняя граница выдачи поиска — как у складского quick-add. */
const SEARCH_LIMIT = 30;

/**
 * Транзакция добора читает доступность по всем позициям (пик, мастерская,
 * потеряшки, свободные экземпляры) — на SQLite под конкурентной записью
 * дефолтных 5 с бывает мало.
 */
const ADDON_TX_OPTIONS = { maxWait: 10_000, timeout: 15_000 } as const;

export interface AddonItemInput {
  equipmentId: string;
  quantity: number;
}

export interface AddonSearchResult {
  equipmentId: string;
  name: string;
  category: string;
  brand: string | null;
  model: string | null;
  stockTrackingMode: "COUNT" | "UNIT";
  rentalRatePerShift: string;
  availableQuantity: number;
  /** Сколько ещё можно добрать в ЭТУ бронь: свободно в окне минус уже в брони. */
  addCap: number;
  /**
   * Сколько можно добрать «под ответственность» — подвинув чужие брони, но не
   * трогая мастерскую и потеряшки. Больше `addCap` только когда позицию держат
   * другие брони; тогда в `conflict` — кто именно.
   */
  ackCap: number;
  /** Сколько этой позиции уже в брони (0 — позиции ещё нет). */
  alreadyInBooking: number;
  /**
   * На сколько смен считается добор этой позиции: у позиции, уже взятой в
   * бронь на свои смены, — её смены (так доп-смета и посчитает), иначе смены брони.
   */
  lineShifts: number;
  availability: "AVAILABLE" | "UNAVAILABLE";
  conflict: AddonConflict | null;
}

export interface AddonConflictDetail extends AddonConflict {
  equipmentId: string;
  name: string;
  quantity: number;
}

export interface AddedAddonItem {
  bookingItemId: string;
  equipmentId: string;
  name: string;
  quantity: number;
  /** Сколько юнитов зарезервировано под эту позицию (0 для COUNT). */
  unitsReserved: number;
  /** Сколько из них сразу переведено в ISSUED (только для выданной брони). */
  unitsIssued: number;
  hadConflict: boolean;
}

export interface AddAddonItemsResult {
  mode: AddonMode;
  added: AddedAddonItem[];
  conflicts: AddonConflictDetail[];
}

/** Ошибка формата ответа, чтобы у роута и тестов был один источник кодов. */
export const ADDON_ERROR_CODES = {
  FORBIDDEN_STATUS: "BOOKING_ADDON_FORBIDDEN",
  EMPTY: "ADDON_ITEMS_EMPTY",
  CONFLICT: "ADDON_CONFLICT",
  OVER_STOCK: "ADDON_OVER_STOCK",
  NOT_ENOUGH_UNITS: "NOT_ENOUGH_UNITS",
  NO_MAIN: "MAIN_ESTIMATE_NOT_FOUND",
  NO_ADDON: "ADDON_ESTIMATE_NOT_FOUND",
  SCAN_SESSION_ACTIVE: "SCAN_SESSION_ACTIVE",
  MERGE_SHIFTS_MISMATCH: "ADDON_MERGE_SHIFTS_MISMATCH",
} as const;

// ── Поиск по каталогу с доступностью на даты брони ───────────────────────────

/**
 * Поиск добора. Окно — `addonWindow`: по умолчанию «сейчас» только у выданной
 * брони; киоск выдачи передаёт `issuingNow: true` — позиция уезжает прямо
 * сейчас, даже если бронь начинается позже.
 *
 * `conflict` заполнен, когда без подтверждения нельзя добрать ни одной штуки
 * (addCap = 0), а под ответственность можно (ackCap > 0): это карточка «занято
 * бронью …». При addCap > 0 конфликта нет — строка «свободно ×N».
 */
export async function searchAddonCandidates(args: {
  bookingId: string;
  q: string;
  limit?: number;
  issuingNow?: boolean;
}): Promise<AddonSearchResult[]> {
  const booking = await prisma.booking.findUnique({
    where: { id: args.bookingId },
    select: { startDate: true, endDate: true, status: true, parentBookingId: true, skipPartialDay: true },
  });
  if (!booking) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");
  assertAddonAllowedForFamily(booking);
  const bookingShifts = billableShifts24h(booking.startDate, booking.endDate, booking.skipPartialDay ?? false);
  const window = addonWindow(booking, { issuingNow: args.issuingNow ?? booking.status === "ISSUED" });

  const rows = await getAvailability({
    startDate: window.start,
    endDate: window.end,
    search: args.q,
    excludeBookingId: args.bookingId,
  });
  const trimmed = rows.slice(0, args.limit ?? SEARCH_LIMIT);
  if (trimmed.length === 0) return [];

  const caps = await computeAddCaps(prisma, {
    bookingId: args.bookingId,
    equipmentIds: trimmed.map((r) => r.equipment.id),
    window,
  });
  const contested = trimmed
    .map((r) => caps.get(r.equipment.id))
    .filter((c): c is NonNullable<typeof c> => c != null && c.addCap === 0 && c.ackCap > 0)
    .map((c) => c.equipmentId);
  const holders = await findHoldersBatch(prisma, {
    equipmentIds: contested,
    start: window.start,
    end: window.end,
    excludeBookingId: args.bookingId,
  });
  const ownShifts = new Map(
    (
      await prisma.bookingItem.findMany({
        where: { bookingId: args.bookingId, equipmentId: { in: trimmed.map((r) => r.equipment.id) } },
        select: { equipmentId: true, shifts: true },
      })
    ).map((i) => [i.equipmentId, i.shifts]),
  );

  return trimmed.map((row) => {
    const cap = caps.get(row.equipment.id);
    const addCap = cap?.addCap ?? 0;
    const ackCap = cap?.ackCap ?? 0;
    return {
      equipmentId: row.equipment.id,
      name: row.equipment.name,
      category: row.equipment.category,
      brand: row.equipment.brand ?? null,
      model: row.equipment.model ?? null,
      stockTrackingMode: row.equipment.stockTrackingMode === "UNIT" ? "UNIT" : "COUNT",
      rentalRatePerShift: row.equipment.rentalRatePerShift.toString(),
      availableQuantity: row.availableQuantity,
      addCap,
      ackCap,
      alreadyInBooking: cap?.alreadyInBooking ?? 0,
      lineShifts: effectiveLineShifts(bookingShifts, ownShifts.get(row.equipment.id) ?? null),
      // Склад в окне (без учёта этой брони). «Свободно, но в брони уже добрано
      // до предела» — AVAILABLE при addCap 0: киоск показывает это отдельно.
      availability: row.availableQuantity > 0 ? "AVAILABLE" : "UNAVAILABLE",
      conflict: holders.get(row.equipment.id) ?? null,
    } satisfies AddonSearchResult;
  });
}

// ── Внутренние помощники ─────────────────────────────────────────────────────

/** Одна позиция — одна строка: дубли в теле запроса суммируем. */
function mergeDuplicateItems(items: AddonItemInput[]): AddonItemInput[] {
  const byEquipment = new Map<string, number>();
  for (const it of items) {
    const qty = Math.floor(it.quantity);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    byEquipment.set(it.equipmentId, (byEquipment.get(it.equipmentId) ?? 0) + qty);
  }
  return Array.from(byEquipment, ([equipmentId, quantity]) => ({ equipmentId, quantity }));
}

type MainAddition = {
  equipmentId: string;
  quantity: number;
  /**
   * Готовый снапшот цены/названия — когда вливаем существующую доп-смету:
   * клиент уже видел эти цифры, пересчитывать их по текущему прайсу нельзя.
   * Без снапшота цена считается от каталога и договорной ставки позиции.
   */
  snapshot?: {
    categorySnapshot: string;
    nameSnapshot: string;
    brandSnapshot: string | null;
    modelSnapshot: string | null;
    unitPrice: Decimal;
    listUnitPrice: Decimal | null;
    /** Смены строки снимка; null — как у сметы. */
    shifts?: number | null;
  };
};

/**
 * Точечно увеличивает строки MAIN-сметы на добавленное количество и
 * пересчитывает итоги. Существующая строка — то же unitPrice (та же
 * договорная/прайсовая цена за период), новая — по правилам основной сметы.
 * Estimate.id сохраняется: ссылки на экспорт `/api/estimates/:id` не протухают.
 */
async function applyAdditionsToMainEstimate(
  tx: TxClient,
  bookingId: string,
  additions: MainAddition[],
): Promise<{ mainId: string; totalAfterDiscount: Decimal }> {
  const main = await tx.estimate.findFirst({
    where: { bookingId, kind: "MAIN" },
    include: { lines: true },
  });
  if (!main) {
    throw new HttpError(409, "У брони нет основной сметы — добор считать не от чего", ADDON_ERROR_CODES.NO_MAIN);
  }
  const shifts = main.shifts > 0 ? main.shifts : 1;
  const discountPercent = main.discountPercent
    ? new Decimal(main.discountPercent.toString())
    : new Decimal(0);

  type LineState = { equipmentId: string | null; lineSum: Decimal; isNegotiated: boolean };
  const state: LineState[] = main.lines.map((l) => ({
    equipmentId: l.equipmentId,
    lineSum: new Decimal(l.lineSum.toString()),
    isNegotiated: l.listUnitPrice != null,
  }));

  for (const add of additions) {
    if (add.quantity <= 0) continue;
    const existing = main.lines.find((l) => l.equipmentId === add.equipmentId);
    if (existing) {
      // Довезённое считается по цене строки MAIN — значит, и на её смены.
      // Если позиция теперь на другое число смен (своё «не меньше N» поменяли
      // без пересборки основной сметы), слить по количеству значило бы молча
      // пересчитать добор по чужому сроку и потерять деньги: отказ.
      const existingShifts = existing.shifts ?? shifts;
      const addShifts = add.snapshot
        ? add.snapshot.shifts ?? shifts
        : effectiveLineShifts(
            shifts,
            (
              await tx.bookingItem.findUnique({
                where: { bookingId_equipmentId: { bookingId, equipmentId: add.equipmentId } },
                select: { shifts: true },
              })
            )?.shifts,
          );
      if (existingShifts !== addShifts) {
        throw new HttpError(
          409,
          `«${existing.nameSnapshot}» в основной смете посчитана на ${existingShifts} ${pluralShifts(existingShifts)}, а добор — на ${addShifts}: в одну строку их не слить — оставьте добор отдельной сметой`,
          ADDON_ERROR_CODES.MERGE_SHIFTS_MISMATCH,
          { equipmentId: add.equipmentId, mainShifts: existingShifts, addonShifts: addShifts },
        );
      }
      const unitPrice = new Decimal(existing.unitPrice.toString());
      const quantity = existing.quantity + add.quantity;
      const lineSum = unitPrice.mul(quantity);
      await tx.estimateLine.update({
        where: { id: existing.id },
        data: { quantity, lineSum: lineSum.toDecimalPlaces(2).toString() },
      });
      const idx = state.findIndex((s) => s.equipmentId === add.equipmentId);
      state[idx] = { ...state[idx], lineSum };
      continue;
    }

    let snapshot = add.snapshot;
    if (!snapshot) {
      const bi = await tx.bookingItem.findUnique({
        where: { bookingId_equipmentId: { bookingId, equipmentId: add.equipmentId } },
        include: { equipment: true },
      });
      if (!bi?.equipment) {
        throw new HttpError(404, "Оборудование не найдено", "EQUIPMENT_NOT_FOUND", { equipmentId: add.equipmentId });
      }
      const { unitPrice, listUnitPrice, shifts: lineShifts } = resolveBookingLinePrice({
        ratePerShift: bi.equipment.rentalRatePerShift.toString(),
        bookingShifts: shifts,
        lineShifts: bi.shifts,
        negotiatedRatePerShift: bi.negotiatedRatePerShift?.toString() ?? null,
      });
      snapshot = {
        categorySnapshot: bi.equipment.category,
        nameSnapshot: bi.equipment.name,
        brandSnapshot: bi.equipment.brand ?? null,
        modelSnapshot: bi.equipment.model ?? null,
        unitPrice,
        listUnitPrice,
        shifts: lineShifts,
      };
    }
    const lineSum = snapshot.unitPrice.mul(add.quantity);
    await tx.estimateLine.create({
      data: {
        estimateId: main.id,
        equipmentId: add.equipmentId,
        categorySnapshot: snapshot.categorySnapshot,
        nameSnapshot: snapshot.nameSnapshot,
        brandSnapshot: snapshot.brandSnapshot,
        modelSnapshot: snapshot.modelSnapshot,
        quantity: add.quantity,
        unitPrice: snapshot.unitPrice.toDecimalPlaces(2).toString(),
        lineSum: lineSum.toDecimalPlaces(2).toString(),
        listUnitPrice: snapshot.listUnitPrice ? snapshot.listUnitPrice.toDecimalPlaces(2).toString() : null,
        shifts: snapshot.shifts ?? null,
      },
    });
    state.push({ equipmentId: add.equipmentId, lineSum, isNegotiated: snapshot.listUnitPrice != null });
  }

  const { subtotal, discountAmount, totalAfterDiscount } = splitEquipmentDiscount(state, discountPercent);
  await tx.estimate.update({
    where: { id: main.id },
    data: {
      subtotal: subtotal.toDecimalPlaces(2).toString(),
      discountAmount: discountAmount.toDecimalPlaces(2).toString(),
      totalAfterDiscount: totalAfterDiscount.toDecimalPlaces(2).toString(),
    },
  });
  return { mainId: main.id, totalAfterDiscount };
}

/** Пересчёты после транзакции — best-effort, как у quick-add на складе. */
async function recomputeAfterAddon(bookingId: string, tag: string): Promise<void> {
  await recomputeAddonEstimate(bookingId).catch((err: unknown) => {
    console.error(`[${tag}] recomputeAddonEstimate failed:`, err);
  });
  await recomputeBookingFinance(bookingId).catch((err: unknown) => {
    console.error(`[${tag}] recomputeBookingFinance failed:`, err);
  });
}

/**
 * Добор со страницы живёт вне складских сессий, и это опасно, пока в киоске
 * идёт работа: приёмка (RETURN) по завершении переводит все живые резервы,
 * которых не было в сканах, в MISSING — довезённый только что юнит попал бы в
 * «не принято». Во время выдачи (ISSUE) позиция добавляется в чек-листе
 * киоска — там же её и отмечают.
 *
 * Блокирует только ЖИВАЯ сессия С РАБОТОЙ (черновик, скан, добор этой сессии):
 * «открыл и посмотрел» и устаревшие сессии (бронь уже выдана/принята кнопкой)
 * ничего не блокируют — раньше такая сессия запирала «+ Добор» навсегда
 * (05.09, 24.09). Текст называет кладовщика и время и советует прервать.
 */
async function assertNoActiveScanSession(client: TxClient | typeof prisma, bookingId: string): Promise<void> {
  const blocking = await findBlockingScanSession(client, bookingId);
  if (blocking) throw scanSessionActiveError(blocking);
}

/** Сколько каждой позиции уже в брони — для конфликта «уже + просят». */
async function loadAlreadyInBooking(
  client: TxClient | typeof prisma,
  bookingId: string,
  items: AddonItemInput[],
): Promise<Map<string, number>> {
  const rows = await client.bookingItem.findMany({
    where: { bookingId, equipmentId: { in: items.map((it) => it.equipmentId) } },
    select: { equipmentId: true, quantity: true },
  });
  const result = new Map<string, number>();
  for (const r of rows) {
    if (r.equipmentId) result.set(r.equipmentId, (result.get(r.equipmentId) ?? 0) + r.quantity);
  }
  return result;
}

async function loadBookingForAddon(bookingId: string) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { id: true, status: true, deletedAt: true, startDate: true, endDate: true, parentBookingId: true },
  });
  if (!booking) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");
  if (booking.deletedAt) {
    throw new HttpError(409, "Бронь в архиве — действие недоступно", "BOOKING_ARCHIVED");
  }
  assertAddonAllowedForFamily(booking);
  return booking;
}

// ── Добор ────────────────────────────────────────────────────────────────────

export async function addAddonItems(args: {
  bookingId: string;
  items: AddonItemInput[];
  mode: AddonMode;
  acknowledgedConflict?: boolean;
  /** AdminUser.id для аудита (FK). Без него аудит пропускается — как у бот-ключа. */
  userId?: string | null;
  /** Кто добавил — в AddonRecord.createdBy (username, не FK). */
  createdBy: string;
}): Promise<AddAddonItemsResult> {
  const { bookingId, mode } = args;
  const items = mergeDuplicateItems(args.items);
  if (items.length === 0) {
    throw new HttpError(400, "Нет позиций для добора", ADDON_ERROR_CODES.EMPTY);
  }

  const booking = await loadBookingForAddon(bookingId);
  if (!(ADDON_ALLOWED_STATUSES as readonly string[]).includes(booking.status)) {
    throw new HttpError(
      409,
      "Добор возможен только для подтверждённой или выданной брони",
      ADDON_ERROR_CODES.FORBIDDEN_STATUS,
      { status: booking.status },
    );
  }
  const main = await prisma.estimate.findFirst({ where: { bookingId, kind: "MAIN" }, select: { id: true } });
  if (!main) {
    throw new HttpError(409, "У брони нет основной сметы — добор считать не от чего", ADDON_ERROR_CODES.NO_MAIN);
  }
  await assertNoActiveScanSession(prisma, bookingId);

  const equipments = await prisma.equipment.findMany({
    where: { id: { in: items.map((it) => it.equipmentId) } },
  });
  const equipmentById = new Map(equipments.map((e) => [e.id, e]));
  const missing = items.find((it) => !equipmentById.has(it.equipmentId));
  if (missing) {
    throw new HttpError(404, "Оборудование не найдено", "EQUIPMENT_NOT_FOUND", { equipmentId: missing.equipmentId });
  }

  // Окно одно на весь запрос: и для конфликта, и для потолка, и для резерва
  // экземпляров — иначе «свободно» и отказ считались бы на разные моменты.
  const window: StockWindow = addonWindow(booking, { issuingNow: booking.status === "ISSUED" });

  // Soft-warn: конфликт — не блокировка. Без подтверждения отдаём 409 со всеми
  // конфликтами разом, чтобы оператор увидел картину целиком, а не по одной
  // позиции за запрос. Конфликт считается на запрошенное количество с учётом
  // уже взятого в бронь — та же формула, что у потолка и поиска.
  const alreadyInBooking = await loadAlreadyInBooking(prisma, bookingId, items);
  const conflicts: AddonConflictDetail[] = [];
  for (const it of items) {
    const conflict = await findAddonConflict(it.equipmentId, window.start, window.end, bookingId, {
      requested: it.quantity,
      alreadyInBooking: alreadyInBooking.get(it.equipmentId) ?? 0,
    });
    if (conflict) {
      conflicts.push({ ...conflict, equipmentId: it.equipmentId, name: equipmentById.get(it.equipmentId)!.name, quantity: it.quantity });
    }
  }
  if (conflicts.length > 0 && !args.acknowledgedConflict) {
    const first = conflicts[0];
    const names = conflicts.map((c) => `«${c.name}»`).join(", ");
    const when = booking.status === "ISSUED" ? "сейчас" : "на даты брони";
    throw new HttpError(
      409,
      conflicts.length === 1 ? `${names} занят ${when}` : `Заняты ${when}: ${names}`,
      ADDON_ERROR_CODES.CONFLICT,
      // Плоские поля первого конфликта — форма, которую уже понимает UI
      // складского добора; `conflicts` — полный список для новой модалки.
      { ...first, conflicts },
    );
  }
  const conflictedEquipment = new Set(conflicts.map((c) => c.equipmentId));

  const added = await prisma.$transaction(async (tx) => {
    const txBooking = await tx.booking.findUnique({
      where: { id: bookingId },
      select: { status: true, startDate: true, endDate: true, deletedAt: true },
    });
    if (!txBooking || txBooking.deletedAt) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");
    if (!(ADDON_ALLOWED_STATUSES as readonly string[]).includes(txBooking.status)) {
      throw new HttpError(409, "Статус брони изменился — обновите страницу", ADDON_ERROR_CODES.FORBIDDEN_STATUS, {
        status: txBooking.status,
      });
    }
    // Повторно внутри транзакции: работу в киоске могли начать между проверкой и записью.
    await assertNoActiveScanSession(tx, bookingId);
    // Статус мог смениться CONFIRMED ↔ ISSUED — окно берём от него же.
    const issueNow = txBooking.status === "ISSUED";
    const txWindow =
      issueNow === (booking.status === "ISSUED") ? window : addonWindow(txBooking, { issuingNow: issueNow });

    // Hard cap — физический склад, один расчёт на все позиции (позиции в
    // запросе уникальны: дубли уже слиты). «Под ответственность» при
    // конфликте поднимает потолок до ackCap — чужую бронь подвинуть можно,
    // выдать то, что в мастерской или потеряно, нельзя. Без конфликта
    // подтверждение ничего не расширяет.
    const caps = await computeAddCaps(tx, {
      bookingId,
      equipmentIds: items.map((it) => it.equipmentId),
      window: txWindow,
    });

    const result: AddedAddonItem[] = [];
    for (const it of items) {
      const equipment = equipmentById.get(it.equipmentId)!;
      const cap = caps.get(it.equipmentId);
      const alreadyMine = cap?.alreadyInBooking ?? 0;
      if (issueNow) await assertProjectStockForBooking(tx, bookingId, [{ equipmentId: it.equipmentId, quantity: alreadyMine + it.quantity }]);
      const hadConflict = conflictedEquipment.has(it.equipmentId);
      const limit = hadConflict && args.acknowledgedConflict ? cap?.ackCap ?? 0 : cap?.addCap ?? 0;
      if (it.quantity > limit) {
        throw overStockError({
          equipmentId: it.equipmentId,
          name: equipment.name,
          addCap: limit,
          requested: it.quantity,
          alreadyInBooking: alreadyMine,
        });
      }

      // Инкремент через @@unique([bookingId, equipmentId]) — без delete+create,
      // резервы существующих позиций не трогаются.
      const item = await tx.bookingItem.upsert({
        where: { bookingId_equipmentId: { bookingId, equipmentId: it.equipmentId } },
        update: { quantity: { increment: it.quantity } },
        create: { bookingId, equipmentId: it.equipmentId, quantity: it.quantity },
      });
      await tx.addonRecord.create({
        data: {
          bookingId,
          sessionId: null,
          bookingItemId: item.id,
          equipmentId: it.equipmentId,
          quantity: it.quantity,
          acknowledgedConflict: hadConflict,
          createdBy: args.createdBy,
        },
      });

      let unitsReserved = 0;
      let unitsIssued = 0;
      if (equipment.stockTrackingMode === "UNIT") {
        const picked = await reserveUnits(tx, {
          bookingId,
          bookingItemId: item.id,
          equipmentId: it.equipmentId,
          equipmentName: equipment.name,
          quantity: it.quantity,
          start: txWindow.start,
          end: txWindow.end,
          issueNow,
        });
        unitsReserved = picked.length;
        unitsIssued = issueNow ? picked.length : 0;
      }

      result.push({
        bookingItemId: item.id,
        equipmentId: it.equipmentId,
        name: equipment.name,
        quantity: it.quantity,
        unitsReserved,
        unitsIssued,
        hadConflict,
      });
    }

    if (mode === "MERGE") {
      await applyAdditionsToMainEstimate(
        tx,
        bookingId,
        items.map((it) => ({ equipmentId: it.equipmentId, quantity: it.quantity })),
      );
    }

    // Аудит — по записи на позицию: diffFields выбрасывает массивы, а плоские
    // поля ищутся в /admin/audit по equipmentId.
    if (args.userId) {
      for (const row of result) {
        const conflict = conflicts.find((c) => c.equipmentId === row.equipmentId);
        await writeAuditEntry({
          tx,
          userId: args.userId,
          action: "BOOKING_ADDON_ADDED",
          entityType: "Booking",
          entityId: bookingId,
          before: null,
          after: {
            mode,
            bookingStatus: txBooking.status,
            equipmentId: row.equipmentId,
            equipmentName: row.name,
            quantity: row.quantity,
            bookingItemId: row.bookingItemId,
            unitsReserved: row.unitsReserved,
            unitsIssued: row.unitsIssued,
            acknowledgedConflict: row.hadConflict,
            ...(conflict
              ? {
                  conflictBookingId: conflict.bookingId,
                  conflictBookingNo: conflict.bookingNo,
                  conflictProjectName: conflict.projectName,
                  conflictFreeFrom: conflict.freeFrom,
                }
              : {}),
          },
        });
      }
    }

    return result;
  }, ADDON_TX_OPTIONS);

  await recomputeAfterAddon(bookingId, "addAddonItems");
  await createFinanceEvent({
    bookingId,
    eventType: "BOOKING_ADDON_ADDED",
    payload: {
      mode,
      items: added.map((a) => ({ equipmentId: a.equipmentId, name: a.name, quantity: a.quantity })),
    },
  }).catch((err: unknown) => {
    console.error("[addAddonItems] createFinanceEvent failed:", err);
  });

  return { mode, added, conflicts };
}

// ── Влить доп-смету в основную ───────────────────────────────────────────────

export async function mergeAddonIntoMain(args: {
  bookingId: string;
  userId?: string | null;
}): Promise<{ mergedLines: number; mergedQuantity: number; mergedTotal: string }> {
  const { bookingId } = args;
  const booking = await loadBookingForAddon(bookingId);
  if (!(MERGE_ALLOWED_STATUSES as readonly string[]).includes(booking.status)) {
    throw new HttpError(
      409,
      "Влить доп-смету можно только у подтверждённой, выданной или возвращённой брони",
      ADDON_ERROR_CODES.FORBIDDEN_STATUS,
      { status: booking.status },
    );
  }
  const addon = await prisma.estimate.findFirst({
    where: { bookingId, kind: "ADDON" },
    include: { lines: true },
  });
  const addonLines = addon?.lines.filter((l) => l.equipmentId != null) ?? [];
  if (!addon || addonLines.length === 0) {
    throw new HttpError(404, "Доб-сметы нет — вливать нечего", ADDON_ERROR_CODES.NO_ADDON);
  }

  const mergedQuantity = addonLines.reduce((sum, l) => sum + l.quantity, 0);
  await prisma.$transaction(async (tx) => {
    await applyAdditionsToMainEstimate(
      tx,
      bookingId,
      addonLines.map((l) => ({
        equipmentId: l.equipmentId!,
        quantity: l.quantity,
        snapshot: {
          categorySnapshot: l.categorySnapshot,
          nameSnapshot: l.nameSnapshot,
          brandSnapshot: l.brandSnapshot,
          modelSnapshot: l.modelSnapshot,
          unitPrice: new Decimal(l.unitPrice.toString()),
          listUnitPrice: l.listUnitPrice ? new Decimal(l.listUnitPrice.toString()) : null,
          shifts: l.shifts,
        },
      })),
    );
    // Удаляем внутри транзакции: если бы пересборка после commit'а упала,
    // финансы посчитали бы добор дважды — и в MAIN, и в живом ADDON.
    await tx.estimate.delete({ where: { id: addon.id } });
    if (args.userId) {
      await writeAuditEntry({
        tx,
        userId: args.userId,
        action: "BOOKING_ADDON_MERGED",
        entityType: "Booking",
        entityId: bookingId,
        before: { addonTotalAfterDiscount: addon.totalAfterDiscount.toString(), addonLines: addonLines.length },
        after: { mergedQuantity, mergedLines: addonLines.length },
      });
    }
  });

  await recomputeAfterAddon(bookingId, "mergeAddonIntoMain");
  await createFinanceEvent({
    bookingId,
    eventType: "BOOKING_ADDON_MERGED",
    payload: { mergedLines: addonLines.length, mergedQuantity, addonTotal: addon.totalAfterDiscount.toString() },
  }).catch((err: unknown) => {
    console.error("[mergeAddonIntoMain] createFinanceEvent failed:", err);
  });

  return {
    mergedLines: addonLines.length,
    mergedQuantity,
    mergedTotal: addon.totalAfterDiscount.toString(),
  };
}
