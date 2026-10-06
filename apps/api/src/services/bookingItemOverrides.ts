/**
 * Настройки позиции брони при PATCH с items.
 *
 * PATCH /api/bookings/:id с items пересоздаёт позиции целиком (deleteMany +
 * createMany). Поле позиции, которое клиент не прислал, раньше становилось
 * null: ретро-правка количества (useRetroEdit шлёт только количество) и любой
 * PATCH бота молча сбрасывали договорную цену на прайс. Правило трёх состояний:
 *
 *   поле не передано (undefined) — оставить как было у этой позиции;
 *   null                          — сбросить к прайсу;
 *   число                         — записать.
 *
 * Позиция сопоставляется по equipmentId: у брони одна строка на позицию
 * каталога (@@unique([bookingId, equipmentId])). У произвольной позиции нет ни
 * договорной цены, ни своих смен. Так же, по трём состояниям, переносятся и
 * свои смены позиции (`shifts`, «не меньше N»): каждая настройка строки
 * должна переживать сохранение, которое её не трогает.
 */

/** Prisma.Decimal, число или строка — всё, у чего есть точное строковое представление. */
type Numeric = { toString(): string } | number | string;

export type ItemOverridesInput = {
  equipmentId?: string;
  negotiatedRatePerShift?: number | null;
  shifts?: number | null;
};

export type ExistingItemOverrides = {
  equipmentId: string | null;
  negotiatedRatePerShift: Numeric | null;
  /** Обязательно: выборка без shifts молча сбрасывала бы свои смены при каждой правке. */
  shifts: number | null;
};

export function carryItemOverrides<T extends ItemOverridesInput>(
  items: readonly T[],
  existing: readonly ExistingItemOverrides[],
): Array<T & { negotiatedRatePerShift: number | null; shifts: number | null }> {
  const byEquipment = new Map<string, ExistingItemOverrides>();
  for (const e of existing) if (e.equipmentId) byEquipment.set(e.equipmentId, e);
  return items.map((it) => {
    if (!it.equipmentId) return { ...it, negotiatedRatePerShift: null, shifts: null };
    const prev = byEquipment.get(it.equipmentId);
    const prevRate = prev?.negotiatedRatePerShift;
    return {
      ...it,
      negotiatedRatePerShift:
        it.negotiatedRatePerShift !== undefined
          ? it.negotiatedRatePerShift
          : prevRate != null
            ? Number(prevRate.toString())
            : null,
      shifts: it.shifts !== undefined ? it.shifts : prev?.shifts ?? null,
    };
  });
}

/**
 * Позиции брони как вход quoteEstimate — когда PATCH не трогает состав
 * (меняются даты, скидка, форма оплаты). Раньше два таких места собирали
 * список вручную и теряли договорную цену: превью и пересчёт брони на
 * согласовании показывали сумму по прайсу.
 */
export function existingItemsForQuote(
  items: ReadonlyArray<{
    equipmentId: string | null;
    customName?: string | null;
    customUnitPrice?: Numeric | null;
    quantity: number;
    negotiatedRatePerShift?: Numeric | null;
    shifts: number | null;
    coveredShifts?: number | null;
    shiftAnchorAt?: Date | null;
    listRatePerShift?: Numeric | null;
  }>,
): QuoteItem[] {
  return items.map((i) => ({
    equipmentId: i.equipmentId ?? undefined,
    customName: i.customName ?? undefined,
    customUnitPrice: i.customUnitPrice != null ? Number(i.customUnitPrice.toString()) : undefined,
    quantity: i.quantity,
    negotiatedRatePerShift:
      i.equipmentId && i.negotiatedRatePerShift != null ? Number(i.negotiatedRatePerShift.toString()) : null,
    shifts: i.equipmentId ? i.shifts ?? null : null,
    // Покрытие позиции продолжения: превью правки продолжения считает только
    // смены сверх оплаченного, как и пересборка.
    coveredShifts: i.equipmentId ? i.coveredShifts ?? null : null,
    shiftAnchorAt: i.equipmentId ? i.shiftAnchorAt ?? null : null,
    listRatePerShift: i.equipmentId && i.listRatePerShift != null ? i.listRatePerShift.toString() : null,
  }));
}

/** Позиция как вход quoteEstimate и createBookingDraft. */
export type QuoteItem = {
  equipmentId?: string;
  customName?: string;
  customUnitPrice?: number;
  quantity: number;
  negotiatedRatePerShift: number | null;
  shifts: number | null;
  coveredShifts?: number | null;
  shiftAnchorAt?: Date | null;
  listRatePerShift?: string | null;
};

/**
 * Позиции из тела запроса как вход quoteEstimate / createBookingDraft — одно
 * место вместо четырёх копий (/quote, /quote/export, /draft и его dryRun) и
 * PATCH после carryItemOverrides. Копии уже расходились: новая настройка
 * строки, забытая в одной из них, молча терялась бы на этом пути.
 */
export function quoteItemsFromBody(
  items: ReadonlyArray<{
    equipmentId?: string;
    customName?: string;
    customUnitPrice?: number;
    quantity: number;
    negotiatedRatePerShift?: number | null;
    shifts?: number | null;
  }>,
): QuoteItem[] {
  return items.map((it) => ({
    equipmentId: it.equipmentId,
    customName: it.customName,
    customUnitPrice: it.customUnitPrice,
    quantity: it.quantity,
    negotiatedRatePerShift: it.negotiatedRatePerShift ?? null,
    shifts: it.equipmentId ? it.shifts ?? null : null,
  }));
}
