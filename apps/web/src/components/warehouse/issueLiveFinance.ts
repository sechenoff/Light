/**
 * Живой блок финансов чек-листа выдачи — чистый расчёт (P16, P22).
 *
 * Считаем ОТ СНИМКА ОСНОВНОЙ СМЕТЫ, а не от прайса: «Согласовано» — это
 * `MAIN.totalAfterDiscount`, и снятое на выдаче вычитается из него по цене
 * строки MAIN (`mainUnitPrice`). Раньше всё считалось от каталожной ставки:
 * произвольная позиция стоила 0 ₽, и «Итого» без единой правки оказывалось
 * меньше «Согласовано» без объяснения.
 *
 *  - снятое = цена строки MAIN × (было − стало); процент скидки не ложится на
 *    договорную строку (`mainNegotiated`) — как `splitEquipmentDiscount`;
 *  - добор (сверх исходного) — по правилам доп-сметы: договорная строка — по
 *    своей цене без скидки, каталожная — ставка × смены со скидкой,
 *    произвольная — её фиксированная цена за период (без умножения на смены);
 *  - договорной итог брони (`booking.manualFinalAmount`) — это и есть сумма
 *    к оплате: ни добор, ни снятое её не меняют.
 *
 * Это отображение, не деньги: авторитетен сервер (`/complete` пересчитывает
 * смету). Числа — `number`, копейки округляет `formatRub`.
 */

import type { ChecklistItem, ChecklistState } from "./types";

export interface LiveFinance {
  /** `state.mainOriginalAfterDiscount` — «Согласовано» до выдачи. */
  mainOriginal: number;
  /** Основная смета после снятого на выдаче. */
  mainActual: number;
  /** Добор сверх исходного количества, со скидкой по правилам доп-сметы. */
  addonActual: number;
  /** Сколько снято на выдаче («Снято на выдаче»). */
  removalAmount: number;
  /** `mainActual + addonActual` — «Итого» по смете. */
  finalAmount: number;
  /** Хотя бы одна строка меньше исходного. */
  hasRemovals: boolean;
  /** Хотя бы одна строка больше исходного. */
  hasAddons: boolean;
  /**
   * Договорной итог брони или `null`. Задан — он и есть сумма к оплате,
   * «Итого» по смете её не меняет.
   */
  manualTotal: number | null;
}

function toNumber(value: string | null | undefined): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Цена единицы строки MAIN за весь период (снимок сметы). */
function mainPriceOf(item: ChecklistItem, shifts: number): number {
  const snapshot = toNumber(item.mainUnitPrice);
  if (snapshot !== null) return snapshot;
  if (item.equipmentId == null) return toNumber(item.customUnitPrice) ?? 0;
  // Старый сервер без снимка — ставка × смены, как раньше.
  return (toNumber(item.rentalRatePerShift) ?? 0) * shifts;
}

/** Цена единицы добора за весь период — правила доп-сметы. */
function addonPriceOf(item: ChecklistItem, shifts: number): number {
  if (item.equipmentId == null) {
    return toNumber(item.customUnitPrice) ?? mainPriceOf(item, shifts);
  }
  if (item.mainNegotiated === true) return mainPriceOf(item, shifts);
  return (toNumber(item.rentalRatePerShift) ?? 0) * shifts;
}

export function emptyLiveFinance(): LiveFinance {
  return {
    mainOriginal: 0,
    mainActual: 0,
    addonActual: 0,
    removalAmount: 0,
    finalAmount: 0,
    hasRemovals: false,
    hasAddons: false,
    manualTotal: null,
  };
}

/**
 * Пересчёт на каждое движение степпера. `intendedQty` — bookingItemId →
 * количество к выдаче (строки без значения выдаются по плану).
 */
export function computeLiveFinance(
  state: ChecklistState,
  intendedQty: ReadonlyMap<string, number>,
): LiveFinance {
  const shifts = state.shifts > 0 ? state.shifts : 1;
  const percent = Math.min(100, Math.max(0, Number(state.discountPercent ?? "0") || 0));
  const discount = percent / 100;

  let removalListed = 0;
  let removalNegotiated = 0;
  let addonListed = 0;
  let addonNegotiated = 0;
  let hasRemovals = false;
  let hasAddons = false;

  for (const item of state.items) {
    const intended = Math.max(0, intendedQty.get(item.bookingItemId) ?? item.quantity);
    const original = Math.max(0, item.originalQuantity);
    if (intended < original) hasRemovals = true;
    if (intended > original) hasAddons = true;

    const removed = Math.max(0, original - intended);
    const added = Math.max(0, intended - original);
    const negotiated = item.mainNegotiated === true;

    if (removed > 0) {
      const sum = mainPriceOf(item, shifts) * removed;
      if (negotiated) removalNegotiated += sum;
      else removalListed += sum;
    }
    if (added > 0) {
      const sum = addonPriceOf(item, shifts) * added;
      if (negotiated) addonNegotiated += sum;
      else addonListed += sum;
    }
  }

  const mainOriginal = toNumber(state.mainOriginalAfterDiscount) ?? 0;
  const removed = removalListed * (1 - discount) + removalNegotiated;
  // Снять больше, чем было согласовано, нельзя: строка «Снято» не длиннее «Согласовано».
  const mainActual = Math.max(0, mainOriginal - removed);
  const addonActual = addonListed * (1 - discount) + addonNegotiated;

  return {
    mainOriginal,
    mainActual,
    addonActual,
    removalAmount: mainOriginal - mainActual,
    finalAmount: mainActual + addonActual,
    hasRemovals,
    hasAddons,
    manualTotal: toNumber(state.booking?.manualFinalAmount ?? null),
  };
}
