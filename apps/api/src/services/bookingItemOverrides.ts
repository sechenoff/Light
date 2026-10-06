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
 * каталога (@@unique([bookingId, equipmentId])). У произвольной позиции
 * договорной цены нет. Сюда же встанут следующие настройки строки — каждая
 * должна переживать сохранение, которое её не трогает.
 */

type Numeric = { toString(): string } | number | string;

export type ItemOverridesInput = {
  equipmentId?: string;
  negotiatedRatePerShift?: number | null;
};

export type ExistingItemOverrides = {
  equipmentId: string | null;
  negotiatedRatePerShift: Numeric | null;
};

export function carryItemOverrides<T extends ItemOverridesInput>(
  items: readonly T[],
  existing: readonly ExistingItemOverrides[],
): Array<T & { negotiatedRatePerShift: number | null }> {
  const byEquipment = new Map<string, ExistingItemOverrides>();
  for (const e of existing) if (e.equipmentId) byEquipment.set(e.equipmentId, e);
  return items.map((it) => {
    if (!it.equipmentId) return { ...it, negotiatedRatePerShift: null };
    if (it.negotiatedRatePerShift !== undefined) {
      return { ...it, negotiatedRatePerShift: it.negotiatedRatePerShift };
    }
    const prev = byEquipment.get(it.equipmentId)?.negotiatedRatePerShift;
    return { ...it, negotiatedRatePerShift: prev != null ? Number(prev.toString()) : null };
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
  }>,
): Array<{
  equipmentId?: string;
  customName?: string;
  customUnitPrice?: number;
  quantity: number;
  negotiatedRatePerShift: number | null;
}> {
  return items.map((i) => ({
    equipmentId: i.equipmentId ?? undefined,
    customName: i.customName ?? undefined,
    customUnitPrice: i.customUnitPrice != null ? Number(i.customUnitPrice.toString()) : undefined,
    quantity: i.quantity,
    negotiatedRatePerShift:
      i.equipmentId && i.negotiatedRatePerShift != null ? Number(i.negotiatedRatePerShift.toString()) : null,
  }));
}
