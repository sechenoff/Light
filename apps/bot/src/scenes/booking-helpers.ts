import type { MatchedItem } from "../types";

export const DISCOUNT = Number(process.env.BOOKING_DISCOUNT) || 0.5; // по умолчанию 50%

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function fmtItem(i: MatchedItem, idx?: number): string {
  const prefix = idx !== undefined ? `${idx + 1}. ` : "• ";
  return `${prefix}${i.name} × ${i.quantity} шт — ${Number(i.rentalRatePerShift).toLocaleString("ru-RU")} ₽/смена`;
}

export function fmtList(items: MatchedItem[], numbered = false): string {
  return items.map((i, idx) => fmtItem(i, numbered ? idx : undefined)).join("\n");
}

export function totalCost(items: MatchedItem[], start: string, end: string): number {
  const days = Math.max(
    1,
    Math.ceil((new Date(end).getTime() - new Date(start).getTime()) / 86_400_000),
  );
  return items.reduce(
    (sum, i) => sum + Number(i.rentalRatePerShift) * i.quantity * days,
    0,
  );
}

/** Строка с полной ценой и ценой со скидкой */
export function fmtPrice(full: number): string {
  const discounted = Math.round(full * (1 - DISCOUNT));
  return (
    `💰 Полная стоимость: ~${full.toLocaleString("ru-RU")} ₽~\n` +
    `🏷 Со скидкой 50%: *${discounted.toLocaleString("ru-RU")} ₽*`
  );
}

/** Строим MatchedItem[] из результата matchEquipment (данные каталога уже в resolved) */
export function buildItems(
  resolved: Array<{ equipmentId: string; quantity: number; catalogName: string; category: string; availableQuantity: number; rentalRatePerShift: string }>,
): MatchedItem[] {
  return resolved
    .filter((i) => i.quantity > 0)
    .map((i) => ({
      equipmentId: i.equipmentId,
      name: i.catalogName,
      category: i.category,
      quantity: Math.min(i.quantity, i.availableQuantity),
      rentalRatePerShift: i.rentalRatePerShift,
      availableQuantity: i.availableQuantity,
    }));
}

/** Объединяет два списка: если equipmentId совпадает — суммирует qty */
export function mergeItems(existing: MatchedItem[], incoming: MatchedItem[]): MatchedItem[] {
  const map = new Map<string, MatchedItem>(existing.map((i) => [i.equipmentId, { ...i }]));
  for (const item of incoming) {
    if (map.has(item.equipmentId)) {
      const cur = map.get(item.equipmentId)!;
      cur.quantity = Math.min(cur.quantity + item.quantity, item.availableQuantity);
    } else {
      map.set(item.equipmentId, { ...item });
    }
  }
  return Array.from(map.values());
}
