/**
 * Сколько смен выставить за оборудование, оставленное у клиента в
 * продолжении брони, если часть срока уже оплачена.
 *
 * Оплаченное у позиции продолжения описывает «покрытие»: начало сетки смен
 * (`anchorAt`) и сколько смен по ней уже оплачено (`coveredShifts`). У первой
 * волны сетка — от начала основной брони, покрыто — действующие смены строки
 * основной сметы: длинная позиция «по плану» уже оплачена целиком. Сетка от
 * начала основной брони, а не от начала продолжения: у billableShifts24h
 * минимум одна смена, и отдельный короткий хвост выставлялся бы целой сменой
 * поверх уже оплаченного.
 *
 * Опоздание основной брони не тарифицируется (решение владельца №7, пока по
 * рекомендации): если основную часть приняли позже оплаченного срока, сетка
 * переносится на момент приёмки и счёт идёт от него.
 */
import { billableShifts24h, MS_PER_RENTAL_SHIFT, SECOND_DAY_GRACE_MS } from "../utils/dates";

/** Что уже оплачено у штук позиции: сетка смен и число оплаченных смен по ней. */
export type ShiftCoverage = { anchorAt: Date; coveredShifts: number };

/**
 * Покрытие позиции основной брони: сетка от её начала, оплачено — действующие
 * смены строки (свои «не меньше N» или смены брони).
 */
export function rootLineCoverage(rootStartDate: Date, effectiveLineShifts: number): ShiftCoverage {
  return { anchorAt: rootStartDate, coveredShifts: Math.max(0, effectiveLineShifts) };
}

/**
 * До какого момента покрытие оплачено. С «не считать вторые сутки» — с прощённым
 * хвостом: так же его прощает и billableShifts24h.
 */
export function paidThroughAt(coverage: ShiftCoverage, skipPartialDay: boolean): Date {
  const grace = skipPartialDay && coverage.coveredShifts > 0 ? SECOND_DAY_GRACE_MS : 0;
  return new Date(coverage.anchorAt.getTime() + coverage.coveredShifts * MS_PER_RENTAL_SHIFT + grace);
}

/**
 * Сколько смен выставить за оставленное до `until` и каким станет покрытие
 * (оно уходит в следующую волну, если оставят ещё).
 *
 *  - Оставили в пределах оплаченного (длинная позиция «по плану», или основную
 *    часть сдали раньше срока) — 0 смен.
 *  - Сверх оплаченного — ровно лишние смены по той же сетке.
 *  - Основную часть приняли позже оплаченного — сетка от момента приёмки.
 */
export function continuationBilling(a: {
  coverage: ShiftCoverage;
  /** Момент приёмки основной части (отделения продолжения). */
  splitAt: Date;
  /** До когда оставили. */
  until: Date;
  skipPartialDay: boolean;
}): { billedShifts: number; next: ShiftCoverage } {
  let coverage = a.coverage;
  if (a.splitAt.getTime() > paidThroughAt(coverage, a.skipPartialDay).getTime()) {
    coverage = { anchorAt: a.splitAt, coveredShifts: 0 };
  }
  const needed =
    a.until.getTime() > coverage.anchorAt.getTime()
      ? billableShifts24h(coverage.anchorAt, a.until, a.skipPartialDay)
      : 0;
  const billedShifts = Math.max(0, needed - coverage.coveredShifts);
  return {
    billedShifts,
    next: { anchorAt: coverage.anchorAt, coveredShifts: coverage.coveredShifts + billedShifts },
  };
}
