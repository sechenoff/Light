/**
 * Строки сметы из позиций брони — одно место на все построители.
 *
 * MAIN-снапшот собирается в нескольких независимых местах: превью и черновик
 * (quoteEstimate), пересборка после правки (rebuildBookingEstimate),
 * подтверждение (confirmBooking). Раньше у каждого была своя копия цикла по
 * позициям, и стоило одной считать чуть иначе — цена в смете расходилась с
 * карточкой (так уже было с договорной ценой и с колонкой «цена / смена»).
 * Здесь — цена каталожной строки на её смены и фиксированная цена своей
 * позиции; запись в базу — `estimateLineCreateData`.
 */
import Decimal from "decimal.js";

import { resolveBookingLinePrice, resolveCatalogLinePrice } from "./pricing";
import { continuationBilling } from "./continuationPricing";

/** Категория своей позиции (вне каталога) в снимке сметы. */
export const CUSTOM_LINE_CATEGORY = "Произвольная позиция";

/** Строка сметы до записи: деньги — Decimal, смены строки — null у своей позиции. */
export type EstimateLineDraft = {
  equipmentId: string | null;
  categorySnapshot: string;
  nameSnapshot: string;
  brandSnapshot: string | null;
  modelSnapshot: string | null;
  quantity: number;
  /** Цена за весь срок строки. */
  unitPrice: Decimal;
  lineSum: Decimal;
  /** Прайсовая цена за срок строки — только у договорной строки. */
  listUnitPrice: Decimal | null;
  isNegotiated: boolean;
  /** На сколько смен посчитана строка; null — своя позиция (цена за весь срок). */
  shifts: number | null;
};

type Money = { toString(): string } | number | string;

type CatalogEquipment = {
  rentalRatePerShift: Money;
  category: string;
  name: string;
  brand: string | null;
  model: string | null;
};

/** Каталожная строка: ставка × смены строки (свои «не меньше N» или брони) × количество. */
export function catalogEstimateLine(
  equipmentId: string,
  equipment: CatalogEquipment,
  item: { quantity: number; negotiatedRatePerShift?: Money | null; shifts?: number | null },
  bookingShifts: number,
): EstimateLineDraft {
  const { unitPrice, listUnitPrice, isNegotiated, shifts } = resolveBookingLinePrice({
    ratePerShift: equipment.rentalRatePerShift.toString(),
    bookingShifts,
    lineShifts: item.shifts ?? null,
    negotiatedRatePerShift: item.negotiatedRatePerShift != null ? item.negotiatedRatePerShift.toString() : null,
  });
  return {
    equipmentId,
    categorySnapshot: equipment.category,
    nameSnapshot: equipment.name,
    brandSnapshot: equipment.brand ?? null,
    modelSnapshot: equipment.model ?? null,
    quantity: item.quantity,
    unitPrice,
    lineSum: unitPrice.mul(item.quantity),
    listUnitPrice,
    isNegotiated,
    shifts,
  };
}

/** Срок продолжения брони: когда отделили оставленное и до когда его держат. */
export type ContinuationContext = { splitAt: Date; until: Date; skipPartialDay: boolean };

/**
 * Строка продолжения брони: выставляются только смены сверх уже оплаченного
 * (continuationBilling), по ставке, зафиксированной при переносе
 * (listRatePerShift; договорная — как у предка, без скидки). Всё в пределах
 * оплаченного — строка 0 ₽ с 0 смен: «оплачено в основной смете». Отдельная
 * ветка, а не resolveCatalogLinePrice: тот держит минимум одну смену.
 */
export function continuationEstimateLine(
  equipmentId: string,
  equipment: CatalogEquipment,
  item: {
    quantity: number;
    negotiatedRatePerShift?: Money | null;
    listRatePerShift?: Money | null;
    coveredShifts: number;
    shiftAnchorAt: Date;
  },
  ctx: ContinuationContext,
): EstimateLineDraft {
  const { billedShifts } = continuationBilling({
    coverage: { anchorAt: item.shiftAnchorAt, coveredShifts: item.coveredShifts },
    splitAt: ctx.splitAt,
    until: ctx.until,
    skipPartialDay: ctx.skipPartialDay,
  });
  const base = {
    equipmentId,
    categorySnapshot: equipment.category,
    nameSnapshot: equipment.name,
    brandSnapshot: equipment.brand ?? null,
    modelSnapshot: equipment.model ?? null,
    quantity: item.quantity,
  };
  if (billedShifts === 0) {
    const zero = new Decimal(0);
    return { ...base, unitPrice: zero, lineSum: zero, listUnitPrice: null, isNegotiated: false, shifts: 0 };
  }
  const { unitPrice, listUnitPrice, isNegotiated } = resolveCatalogLinePrice({
    ratePerShift: (item.listRatePerShift ?? equipment.rentalRatePerShift).toString(),
    shifts: billedShifts,
    negotiatedRatePerShift: item.negotiatedRatePerShift != null ? item.negotiatedRatePerShift.toString() : null,
  });
  return { ...base, unitPrice, lineSum: unitPrice.mul(item.quantity), listUnitPrice, isNegotiated, shifts: billedShifts };
}

/** Своя позиция: фиксированная цена, на смены не умножается. */
export function customEstimateLine(item: {
  customName: string;
  customUnitPrice: Money;
  quantity: number;
  customCategory?: string | null;
}): EstimateLineDraft {
  const unitPrice = new Decimal(item.customUnitPrice.toString());
  return {
    equipmentId: null,
    categorySnapshot: item.customCategory ?? CUSTOM_LINE_CATEGORY,
    nameSnapshot: item.customName,
    brandSnapshot: null,
    modelSnapshot: null,
    quantity: item.quantity,
    unitPrice,
    lineSum: unitPrice.mul(item.quantity),
    listUnitPrice: null,
    isNegotiated: false,
    shifts: null,
  };
}

/**
 * Строки сметы из позиций брони. `quantityOf` — сколько позиции идёт в эту
 * смету (пересборка с сохранением раскладки «основная / добор» держит
 * количество в пределах прежнего снимка); 0 и меньше — строки нет.
 */
export function estimateLinesFromBookingItems(
  items: ReadonlyArray<{
    equipmentId: string | null;
    equipment: CatalogEquipment | null;
    quantity: number;
    negotiatedRatePerShift?: Money | null;
    shifts?: number | null;
    coveredShifts?: number | null;
    shiftAnchorAt?: Date | null;
    listRatePerShift?: Money | null;
    customName?: string | null;
    customUnitPrice?: Money | null;
    customCategory?: string | null;
  }>,
  bookingShifts: number,
  opts: {
    quantityOf?: (item: { equipmentId: string; quantity: number }) => number;
    /** Бронь — продолжение: позиции с покрытием считаются сверх оплаченного. */
    continuation?: ContinuationContext | null;
  } = {},
): EstimateLineDraft[] {
  return items.flatMap((it): EstimateLineDraft[] => {
    if (it.equipmentId != null && it.equipment != null) {
      const quantity = opts.quantityOf
        ? opts.quantityOf({ equipmentId: it.equipmentId, quantity: it.quantity })
        : it.quantity;
      if (quantity <= 0) return [];
      if (opts.continuation && (it.coveredShifts != null) !== (it.shiftAnchorAt != null)) {
        // Покрытие пишет только сервер и всегда парой: половина — порча данных,
        // по которой нельзя молча посчитать полную цену уже оплаченного.
        throw new Error(`Позиция продолжения ${it.equipmentId}: покрытие записано не полностью`);
      }
      if (opts.continuation && it.coveredShifts != null && it.shiftAnchorAt != null) {
        return [
          continuationEstimateLine(
            it.equipmentId,
            it.equipment,
            { ...it, quantity, coveredShifts: it.coveredShifts, shiftAnchorAt: it.shiftAnchorAt },
            opts.continuation,
          ),
        ];
      }
      return [catalogEstimateLine(it.equipmentId, it.equipment, { ...it, quantity }, bookingShifts)];
    }
    const custom = customEstimateLine({
      customName: it.customName!,
      customUnitPrice: it.customUnitPrice!,
      quantity: it.quantity,
      customCategory: it.customCategory,
    });
    // Своя позиция, перешедшая в продолжение, уже оплачена в основной смете:
    // её цена фиксированная и по сменам не продлевается — 0 ₽ (доплату, если
    // нужна, руководитель ставит вручную).
    if (opts.continuation && it.coveredShifts != null) {
      const zero = new Decimal(0);
      return [{ ...custom, unitPrice: zero, lineSum: zero, shifts: 0 }];
    }
    return [custom];
  });
}

/** Строка для записи в EstimateLine: деньги — строками с копейками. */
export function estimateLineCreateData(l: {
  equipmentId: string | null;
  categorySnapshot: string;
  nameSnapshot: string;
  brandSnapshot: string | null;
  modelSnapshot: string | null;
  quantity: number;
  unitPrice: Decimal;
  lineSum: Decimal;
  listUnitPrice: Decimal | null;
  shifts?: number | null;
}) {
  return {
    equipmentId: l.equipmentId,
    categorySnapshot: l.categorySnapshot,
    nameSnapshot: l.nameSnapshot,
    brandSnapshot: l.brandSnapshot,
    modelSnapshot: l.modelSnapshot,
    quantity: l.quantity,
    unitPrice: l.unitPrice.toDecimalPlaces(2).toString(),
    lineSum: l.lineSum.toDecimalPlaces(2).toString(),
    listUnitPrice: l.listUnitPrice ? l.listUnitPrice.toDecimalPlaces(2).toString() : null,
    shifts: l.shifts ?? null,
  };
}
