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
 * считается по политике витрины (`BLOCKING_STATUSES`, архивные не занимают,
 * потеряшки и ремонты вычтены), чтобы «свободно ×N» в поиске и отказ сервера
 * сходились на одном числе.
 */
import Decimal from "decimal.js";
import type { Prisma } from "@prisma/client";

import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";
import { writeAuditEntry } from "./audit";
import { findAddonConflict, type AddonConflict } from "./addonAvailability";
import { recomputeAddonEstimate } from "./addonEstimate";
import {
  BLOCKING_STATUSES,
  getAvailability,
  getLostCountByEquipmentMap,
  getRepairCountByEquipmentMap,
  getUsableUnitBaseMap,
} from "./availability";
import { createFinanceEvent, recomputeBookingFinance } from "./finance";
import { resolveCatalogLinePrice, splitEquipmentDiscount } from "./pricing";

type TxClient = Prisma.TransactionClient;

export type AddonMode = "ADDON" | "MERGE";
export const ADDON_MODES = ["ADDON", "MERGE"] as const satisfies readonly AddonMode[];

/** Статусы, в которых добор осмыслен: оборудование зарезервировано или уже у клиента. */
const ADDON_ALLOWED_STATUSES = ["CONFIRMED", "ISSUED"] as const;

/** Влить доп-смету можно и после приёмки — это решение о документах, не о складе. */
const MERGE_ALLOWED_STATUSES = ["CONFIRMED", "ISSUED", "RETURNED"] as const;

/** Верхняя граница выдачи поиска — как у складского quick-add. */
const SEARCH_LIMIT = 30;

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
  /** Сколько ещё можно добрать в ЭТУ бронь: свободно на даты минус уже в брони. */
  addCap: number;
  /** Сколько этой позиции уже в брони (0 — позиции ещё нет). */
  alreadyInBooking: number;
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
} as const;

// ── Поиск по каталогу с доступностью на даты брони ───────────────────────────

export async function searchAddonCandidates(args: {
  bookingId: string;
  q: string;
  limit?: number;
}): Promise<AddonSearchResult[]> {
  const booking = await prisma.booking.findUnique({
    where: { id: args.bookingId },
    select: { startDate: true, endDate: true },
  });
  if (!booking) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");

  const rows = await getAvailability({
    startDate: booking.startDate,
    endDate: booking.endDate,
    search: args.q,
    excludeBookingId: args.bookingId,
  });
  const trimmed = rows.slice(0, args.limit ?? SEARCH_LIMIT);
  if (trimmed.length === 0) return [];

  // addCap = max(0, availableQuantity − alreadyInThisBooking): `availableQuantity`
  // уже исключает текущую бронь через excludeBookingId, остаётся вычесть только
  // то, что эта же бронь уже держит.
  const existing = await prisma.bookingItem.findMany({
    where: {
      bookingId: args.bookingId,
      equipmentId: { in: trimmed.map((r) => r.equipment.id) },
    },
    select: { equipmentId: true, quantity: true },
  });
  const alreadyByEquipment = new Map<string, number>();
  for (const it of existing) {
    if (it.equipmentId) alreadyByEquipment.set(it.equipmentId, it.quantity);
  }

  return Promise.all(
    trimmed.map(async (row) => {
      const availability = row.availableQuantity > 0 ? "AVAILABLE" : "UNAVAILABLE";
      const conflict =
        availability === "UNAVAILABLE"
          ? await findAddonConflict(row.equipment.id, booking.startDate, booking.endDate, args.bookingId)
          : null;
      const alreadyInBooking = alreadyByEquipment.get(row.equipment.id) ?? 0;
      let addCap = Math.max(0, row.availableQuantity - alreadyInBooking);
      if (row.equipment.stockTrackingMode === "UNIT") {
        // Агрегат считает по датам, а выдаётся конкретный экземпляр: юнит,
        // застрявший в ISSUED у просроченной брони с чужими датами, агрегат
        // не вычтет, но на полке его нет. Потолок — реальный пул свободных.
        const free = await listFreeUnitIds(prisma, {
          bookingId: args.bookingId,
          bookingItemId: null,
          equipmentId: row.equipment.id,
          start: booking.startDate,
          end: booking.endDate,
        });
        addCap = Math.min(addCap, free.length);
      }
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
        alreadyInBooking,
        availability,
        conflict,
      } satisfies AddonSearchResult;
    }),
  );
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

/**
 * Физически доступное количество — как `baseQtyOf` в getAvailability:
 * UNIT — пригодные единицы (AVAILABLE|ISSUED) минус безъюнитные ремонты;
 * COUNT — totalQuantity минус открытые потеряшки и ремонты.
 */
async function computePhysicalStock(
  tx: TxClient,
  equipment: { id: string; stockTrackingMode: string; totalQuantity: number },
): Promise<number> {
  const inRepair = (await getRepairCountByEquipmentMap([equipment.id], tx)).get(equipment.id) ?? 0;
  if (equipment.stockTrackingMode === "UNIT") {
    const usable = (await getUsableUnitBaseMap([equipment.id], tx)).get(equipment.id) ?? 0;
    return Math.max(0, usable - inRepair);
  }
  const lost = (await getLostCountByEquipmentMap([equipment.id], tx)).get(equipment.id) ?? 0;
  return Math.max(0, equipment.totalQuantity - lost - inRepair);
}

/** Сколько этой позиции держат другие пересекающиеся брони (политика витрины). */
async function computeOccupiedByOthers(
  tx: TxClient,
  args: { equipmentId: string; bookingId: string; start: Date; end: Date },
): Promise<number> {
  const rows = await tx.bookingItem.findMany({
    where: {
      equipmentId: args.equipmentId,
      bookingId: { not: args.bookingId },
      booking: {
        status: { in: [...BLOCKING_STATUSES] },
        deletedAt: null,
        startDate: { lte: args.end },
        endDate: { gte: args.start },
      },
    },
    select: { quantity: true },
  });
  return rows.reduce((sum, r) => sum + r.quantity, 0);
}

/**
 * Свободные экземпляры UNIT-позиции, которые реально можно довезти: статус
 * AVAILABLE, не в живом резерве пересекающейся брони и не зарезервированы этой
 * же позицией. Общая выборка для потолка (поиск, hard cap) и для резерва —
 * иначе «свободно ×N» и отказ NOT_ENOUGH_UNITS считали бы по разным спискам.
 * Под ответственность чужие резервы НЕ отдаём: юнит, зарезервированный другой
 * подтверждённой бронью, физически нужен ей на выдаче.
 */
async function listFreeUnitIds(
  client: TxClient | typeof prisma,
  args: { bookingId: string; bookingItemId: string | null; equipmentId: string; start: Date; end: Date },
): Promise<string[]> {
  const takenByOthers = await client.bookingItemUnit.findMany({
    where: {
      returnedAt: null,
      bookingItem: {
        booking: {
          id: { not: args.bookingId },
          status: { in: [...BLOCKING_STATUSES] },
          deletedAt: null,
          startDate: { lte: args.end },
          endDate: { gte: args.start },
        },
      },
    },
    select: { equipmentUnitId: true },
  });
  const mine = args.bookingItemId
    ? await client.bookingItemUnit.findMany({
        where: { bookingItemId: args.bookingItemId, returnedAt: null },
        select: { equipmentUnitId: true },
      })
    : [];
  const excluded = new Set<string>([
    ...takenByOthers.map((r) => r.equipmentUnitId),
    ...mine.map((r) => r.equipmentUnitId),
  ]);
  const candidates = await client.equipmentUnit.findMany({
    where: { equipmentId: args.equipmentId, status: "AVAILABLE" },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  return candidates.map((u) => u.id).filter((id) => !excluded.has(id));
}

/**
 * Резервирует под позицию `quantity` свободных юнитов и, если бронь уже выдана,
 * сразу переводит их в ISSUED.
 */
async function reserveUnitsForAddon(
  tx: TxClient,
  args: {
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
  const free = await listFreeUnitIds(tx, {
    bookingId: args.bookingId,
    bookingItemId: args.bookingItemId,
    equipmentId: args.equipmentId,
    start: args.start,
    end: args.end,
  });
  if (free.length < args.quantity) {
    throw new HttpError(
      409,
      `«${args.equipmentName}»: свободных единиц ${free.length}, нужно ${args.quantity}`,
      ADDON_ERROR_CODES.NOT_ENOUGH_UNITS,
      { equipmentId: args.equipmentId, name: args.equipmentName, available: free.length, requested: args.quantity },
    );
  }
  const picked = free.slice(0, args.quantity);
  await tx.bookingItemUnit.createMany({
    data: picked.map((unitId) => ({ bookingItemId: args.bookingItemId, equipmentUnitId: unitId })),
  });
  if (args.issueNow) {
    await tx.equipmentUnit.updateMany({
      where: { id: { in: picked }, status: "AVAILABLE" },
      data: { status: "ISSUED" },
    });
  }
  return picked;
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
      const { unitPrice, listUnitPrice } = resolveCatalogLinePrice({
        ratePerShift: bi.equipment.rentalRatePerShift.toString(),
        shifts,
        negotiatedRatePerShift: bi.negotiatedRatePerShift?.toString() ?? null,
      });
      snapshot = {
        categorySnapshot: bi.equipment.category,
        nameSnapshot: bi.equipment.name,
        brandSnapshot: bi.equipment.brand ?? null,
        modelSnapshot: bi.equipment.model ?? null,
        unitPrice,
        listUnitPrice,
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
 * Добор со страницы живёт вне складских сессий, и это опасно, пока сессия
 * открыта: приёмка (RETURN) по завершении переводит все живые резервы, которых
 * не было в сканах, в MISSING — довезённый только что юнит попал бы в «не
 * принято». Во время выдачи (ISSUE) позиция добавляется в чек-листе киоска —
 * там же её и сканируют. Поэтому при активной сессии — 409 с подсказкой.
 */
async function assertNoActiveScanSession(client: TxClient | typeof prisma, bookingId: string): Promise<void> {
  const active = await client.scanSession.findFirst({
    where: { bookingId, status: "ACTIVE" },
    select: { id: true, operation: true, workerName: true, startedAt: true },
  });
  if (!active) return;
  throw new HttpError(
    409,
    active.operation === "RETURN"
      ? "На складе идёт приёмка по этой брони — завершите или отмените её в киоске, иначе довезённое попадёт в «не принято»"
      : "На складе идёт выдача по этой брони — добавьте позицию в чек-листе киоска или завершите сессию",
    ADDON_ERROR_CODES.SCAN_SESSION_ACTIVE,
    { sessionId: active.id, operation: active.operation, workerName: active.workerName, startedAt: active.startedAt.toISOString() },
  );
}

async function loadBookingForAddon(bookingId: string) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { id: true, status: true, deletedAt: true, startDate: true, endDate: true },
  });
  if (!booking) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");
  if (booking.deletedAt) {
    throw new HttpError(409, "Бронь в архиве — действие недоступно", "BOOKING_ARCHIVED");
  }
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

  // Soft-warn: конфликт по датам — не блокировка. Без подтверждения отдаём 409
  // со всеми конфликтами разом, чтобы оператор увидел картину целиком, а не
  // по одной позиции за запрос.
  const conflicts: AddonConflictDetail[] = [];
  for (const it of items) {
    const conflict = await findAddonConflict(it.equipmentId, booking.startDate, booking.endDate, bookingId);
    if (conflict) {
      conflicts.push({ ...conflict, equipmentId: it.equipmentId, name: equipmentById.get(it.equipmentId)!.name, quantity: it.quantity });
    }
  }
  if (conflicts.length > 0 && !args.acknowledgedConflict) {
    const first = conflicts[0];
    const names = conflicts.map((c) => `«${c.name}»`).join(", ");
    throw new HttpError(
      409,
      conflicts.length === 1 ? `${names} занят на даты брони` : `Заняты на даты брони: ${names}`,
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
    // Повторно внутри транзакции: сессию могли открыть между проверкой и записью.
    await assertNoActiveScanSession(tx, bookingId);
    const issueNow = txBooking.status === "ISSUED";

    const result: AddedAddonItem[] = [];
    for (const it of items) {
      const equipment = equipmentById.get(it.equipmentId)!;
      const existing = await tx.bookingItem.findUnique({
        where: { bookingId_equipmentId: { bookingId, equipmentId: it.equipmentId } },
        select: { id: true, quantity: true },
      });
      const alreadyMine = existing?.quantity ?? 0;
      const hadConflict = conflictedEquipment.has(it.equipmentId);

      // Hard cap — физический склад. «Под ответственность» разрешает подвинуть
      // чужую бронь (occupiedByOthers не вычитается), но не выдать то, чего нет
      // на полке. Без конфликта подтверждение ничего не расширяет.
      const physicalStock = await computePhysicalStock(tx, equipment);
      const occupiedByOthers = hadConflict && args.acknowledgedConflict
        ? 0
        : await computeOccupiedByOthers(tx, {
            equipmentId: it.equipmentId,
            bookingId,
            start: txBooking.startDate,
            end: txBooking.endDate,
          });
      let addCap = Math.max(0, physicalStock - occupiedByOthers - alreadyMine);
      if (equipment.stockTrackingMode === "UNIT") {
        // Агрегат по датам может обещать юнит, застрявший в ISSUED у просроченной
        // брони с чужими датами; выдать можно только реально свободный экземпляр.
        const free = await listFreeUnitIds(tx, {
          bookingId,
          bookingItemId: existing?.id ?? null,
          equipmentId: it.equipmentId,
          start: txBooking.startDate,
          end: txBooking.endDate,
        });
        addCap = Math.min(addCap, free.length);
      }
      if (it.quantity > addCap) {
        throw new HttpError(
          409,
          `«${equipment.name}»: не хватает на складе — можно добрать ещё ${addCap}`,
          ADDON_ERROR_CODES.OVER_STOCK,
          { equipmentId: it.equipmentId, name: equipment.name, addCap, requested: it.quantity, alreadyInBooking: alreadyMine },
        );
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
        const picked = await reserveUnitsForAddon(tx, {
          bookingId,
          bookingItemId: item.id,
          equipmentId: it.equipmentId,
          equipmentName: equipment.name,
          quantity: it.quantity,
          start: txBooking.startDate,
          end: txBooking.endDate,
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
  });

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
