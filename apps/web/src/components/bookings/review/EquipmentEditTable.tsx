"use client";

import { formatMoneyRub } from "../../../lib/format";
import { AddEquipmentSearch } from "./AddEquipmentSearch";

export type EditableItem = {
  id: string;
  equipmentId: string;
  quantity: number;
  equipment: {
    id: string;
    name: string;
    category: string;
    brand: string | null;
    model: string | null;
    rentalRatePerShift: string;
    totalQuantity: number;
    availableQuantity: number;
  };
};

type AddableEquipment = {
  equipmentId: string;
  name: string;
  category: string;
  rentalRatePerShift: string;
  availableQuantity: number;
  totalQuantity: number;
};

type Props = {
  items: EditableItem[];
  shifts: number;
  startISO: string;
  endISO: string;
  onChangeQty: (equipmentId: string, newQty: number) => void;
  onRemove: (equipmentId: string) => void;
  onAdd: (row: AddableEquipment) => void;
};

/** Group items by equipment.category */
function groupByCategory(items: EditableItem[]): Map<string, EditableItem[]> {
  const map = new Map<string, EditableItem[]>();
  for (const item of items) {
    const cat = item.equipment.category;
    const list = map.get(cat) ?? [];
    list.push(item);
    map.set(cat, list);
  }
  return map;
}

export function EquipmentEditTable({
  items,
  shifts,
  startISO,
  endISO,
  onChangeQty,
  onRemove,
  onAdd,
}: Props) {
  const grouped = groupByCategory(items);
  const categories = Array.from(grouped.keys());

  return (
    <div className="space-y-0">
      {items.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-ink-3">Нет позиций</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-subtle text-xs text-ink-2">
                <th className="px-4 py-2 text-left font-medium">Наименование</th>
                <th className="px-4 py-2 text-right font-medium w-28">Цена/день</th>
                <th className="px-4 py-2 text-center font-medium w-32">Кол-во</th>
                <th className="px-4 py-2 text-right font-medium w-28">Сумма</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {categories.map((cat) => {
                const catItems = grouped.get(cat)!;
                return (
                  <>
                    <tr key={`cat-${cat}`} className="border-t border-border bg-surface-subtle">
                      <td
                        colSpan={5}
                        className="px-4 py-1 text-[11px] font-semibold uppercase tracking-wider text-ink-3"
                      >
                        {cat}
                      </td>
                    </tr>
                    {catItems.map((item) => {
                      const rate = Number(item.equipment.rentalRatePerShift) || 0;
                      const lineTotal = rate * shifts * item.quantity;
                      const available = item.equipment.availableQuantity ?? item.equipment.totalQuantity;

                      return (
                        <tr
                          key={item.id}
                          className="border-t border-border hover:bg-surface-subtle/50 transition-colors"
                        >
                          <td className="px-4 py-2">
                            <div className="font-medium text-ink">{item.equipment.name}</div>
                            <div className="text-xs text-ink-3">
                              доступно {available} из {item.equipment.totalQuantity}
                            </div>
                          </td>
                          <td className="px-4 py-2 text-right mono-num text-ink-2">
                            {formatMoneyRub(item.equipment.rentalRatePerShift)} ₽
                          </td>
                          <td className="px-4 py-2">
                            <div className="flex items-center justify-center gap-1">
                              <button
                                type="button"
                                aria-label="-"
                                disabled={item.quantity <= 1}
                                onClick={() => onChangeQty(item.equipmentId, item.quantity - 1)}
                                className="flex h-6 w-6 items-center justify-center rounded border border-border text-ink-2 hover:bg-surface-muted disabled:opacity-40"
                              >
                                −
                              </button>
                              <span className="w-8 text-center mono-num font-medium">{item.quantity}</span>
                              <button
                                type="button"
                                aria-label="+"
                                onClick={() => onChangeQty(item.equipmentId, item.quantity + 1)}
                                className="flex h-6 w-6 items-center justify-center rounded border border-border text-ink-2 hover:bg-surface-muted"
                              >
                                +
                              </button>
                            </div>
                          </td>
                          <td className="px-4 py-2 text-right mono-num font-medium">
                            {formatMoneyRub(lineTotal)}
                          </td>
                          <td className="px-2 py-2">
                            <button
                              type="button"
                              aria-label="Удалить позицию"
                              onClick={() => onRemove(item.equipmentId)}
                              className="flex h-6 w-6 items-center justify-center rounded text-ink-3 hover:text-rose hover:bg-rose-soft transition-colors"
                            >
                              ×
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Add equipment search */}
      <div className="border-t border-border px-4 py-3">
        <AddEquipmentSearch
          startISO={startISO}
          endISO={endISO}
          onSelect={(row) =>
            onAdd({
              equipmentId: row.equipmentId,
              name: row.name,
              category: row.category,
              rentalRatePerShift: row.rentalRatePerShift,
              availableQuantity: row.availableQuantity,
              totalQuantity: row.availableQuantity,
            })
          }
        />
      </div>
    </div>
  );
}
