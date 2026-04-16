"use client";

import { useMemo } from "react";
import { CatalogRow } from "./CatalogRow";
import type { AvailabilityRow, CatalogRowAdjustment, CatalogSelectedItem, OffCatalogItem } from "./types";

type Props = {
  rows: AvailabilityRow[];
  selected: Map<string, CatalogSelectedItem>;
  offCatalogItems: OffCatalogItem[];
  activeTab: string; // "all" or category name
  searchQuery: string;
  adjustments?: Map<string, CatalogRowAdjustment>;
  onAdd: (row: AvailabilityRow) => void;
  onChangeQty: (equipmentId: string, newQty: number) => void;
  onRemove: (equipmentId: string) => void;
  onChangeOffCatalogQty: (tempId: string, newQty: number) => void;
  onRemoveOffCatalog: (tempId: string) => void;
};

export function CatalogList({
  rows,
  selected,
  offCatalogItems,
  activeTab,
  searchQuery,
  adjustments,
  onAdd,
  onChangeQty,
  onRemove,
  onChangeOffCatalogQty,
  onRemoveOffCatalog,
}: Props) {
  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return rows.filter((r) => {
      if (activeTab !== "all" && r.category !== activeTab) return false;
      if (q && !r.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, activeTab, searchQuery]);

  const grouped = useMemo(() => {
    const map = new Map<string, AvailabilityRow[]>();
    for (const r of filtered) {
      if (!map.has(r.category)) map.set(r.category, []);
      map.get(r.category)!.push(r);
    }
    return Array.from(map.entries());
  }, [filtered]);

  const selectedByCat = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of selected.values()) {
      map.set(item.category, (map.get(item.category) ?? 0) + 1);
    }
    return map;
  }, [selected]);

  const hasOff = offCatalogItems.length > 0;
  const isEmpty = filtered.length === 0 && !hasOff;

  if (isEmpty) {
    return (
      <div className="px-5 py-12 text-center text-[13px] text-ink-3">Ничего не найдено</div>
    );
  }

  return (
    <div>
      {hasOff && (
        <div>
          <div className="flex items-center justify-between border-b border-t border-border bg-surface-subtle px-5 py-1.5 font-cond text-[10px] font-semibold uppercase tracking-wider text-ink-3">
            <span>Дополнительные позиции</span>
            <span className="font-mono text-emerald">{offCatalogItems.length} вне каталога</span>
          </div>
          {offCatalogItems.map((item) => (
            <div
              key={item.tempId}
              className="flex items-center gap-3 border-l-[3px] border-l-emerald bg-emerald-soft/40 px-5 py-2.5 hover:bg-emerald-soft/60"
            >
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-emerald">{item.name}</div>
                <div className="mt-0.5 text-[11.5px] text-ink-3">вне каталога</div>
              </div>
              <div className="inline-flex items-center overflow-hidden rounded border border-emerald-border bg-surface">
                <button
                  type="button"
                  aria-label="Уменьшить количество"
                  onClick={() =>
                    item.quantity - 1 <= 0
                      ? onRemoveOffCatalog(item.tempId)
                      : onChangeOffCatalogQty(item.tempId, item.quantity - 1)
                  }
                  className="flex h-7 w-7 items-center justify-center text-ink-2 hover:bg-emerald-soft"
                >
                  −
                </button>
                <div className="flex h-7 w-8 items-center justify-center border-x border-emerald-border bg-emerald-soft/30 font-mono text-[12px] font-semibold text-emerald">
                  {item.quantity}
                </div>
                <button
                  type="button"
                  aria-label="Увеличить количество"
                  onClick={() => onChangeOffCatalogQty(item.tempId, item.quantity + 1)}
                  className="flex h-7 w-7 items-center justify-center text-ink-2 hover:bg-emerald-soft"
                >
                  +
                </button>
                <button
                  type="button"
                  aria-label="Удалить позицию"
                  onClick={() => onRemoveOffCatalog(item.tempId)}
                  className="flex h-7 w-7 items-center justify-center border-l border-emerald-border text-rose hover:bg-rose-soft"
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {grouped.map(([category, catRows]) => {
        const selCount = selectedByCat.get(category) ?? 0;
        return (
          <div key={category}>
            <div className="flex items-center justify-between border-b border-t border-border bg-surface-subtle px-5 py-1.5 font-cond text-[10px] font-semibold uppercase tracking-wider text-ink-3">
              <span>{category}</span>
              {selCount > 0 && <span className="font-mono text-emerald">{selCount} выбрано</span>}
            </div>
            {catRows.map((row) => {
              const sel = selected.get(row.equipmentId);
              return (
                <CatalogRow
                  key={row.equipmentId}
                  row={row}
                  selectedQty={sel?.quantity ?? 0}
                  adjustment={adjustments?.get(row.equipmentId)}
                  onAdd={onAdd}
                  onChangeQty={onChangeQty}
                  onRemove={onRemove}
                />
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
