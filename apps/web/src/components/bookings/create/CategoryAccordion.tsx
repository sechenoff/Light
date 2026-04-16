"use client";

import { useCallback, useEffect, useState } from "react";
import { CatalogItemCard } from "./CatalogItemCard";
import type { AvailabilityRow, EquipmentTableItem } from "./types";

type CategoryAccordionProps = {
  category: string;
  isOpen: boolean;
  onToggle: () => void;
  fetchItems: (category: string) => Promise<AvailabilityRow[]>;
  items: EquipmentTableItem[];
  onCatalogAdd: (equipment: AvailabilityRow) => void;
  onCatalogQuantityChange: (equipmentId: string, qty: number) => void;
};

export function CategoryAccordion({
  category,
  isOpen,
  onToggle,
  fetchItems,
  items,
  onCatalogAdd,
  onCatalogQuantityChange,
}: CategoryAccordionProps) {
  const [rows, setRows] = useState<AvailabilityRow[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isOpen || rows !== null) return;
    let cancelled = false;
    setLoading(true);
    fetchItems(category)
      .then((data) => {
        if (!cancelled) {
          setRows(data);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRows([]);
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [isOpen, category, fetchItems, rows]);

  /** Reset cached rows when parent signals date change (rows set to null externally is not possible,
   *  so we provide a key-based reset via the parent re-mounting). */

  const getQtyForEquipment = useCallback(
    (equipmentId: string): number => {
      const found = items.find(
        (it) => it.match.kind === "resolved" && it.match.equipmentId === equipmentId,
      );
      return found ? found.quantity : 0;
    },
    [items],
  );

  return (
    <div className="border-b border-border last:border-b-0">
      {/* Header */}
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center px-3.5 py-2 text-left text-xs font-semibold text-ink hover:bg-surface-muted"
      >
        <span className={`mr-1.5 text-[10px] ${isOpen ? "text-accent-bright" : "text-ink-3"}`}>
          {isOpen ? "▾" : "▸"}
        </span>
        {category}
        <span className="ml-auto text-[10px] font-normal text-ink-3">
          {rows !== null ? rows.length : "..."}
        </span>
      </button>

      {/* Items */}
      {isOpen && (
        <div className="flex flex-col gap-1.5 px-2.5 pb-2.5">
          {loading && (
            <div className="py-3 text-center text-[11px] text-ink-3">Загрузка...</div>
          )}
          {rows !== null && rows.length === 0 && (
            <div className="py-3 text-center text-[11px] text-ink-3">Нет оборудования</div>
          )}
          {rows?.map((row) => {
            const qty = getQtyForEquipment(row.equipmentId);
            return (
              <CatalogItemCard
                key={row.equipmentId}
                name={row.name}
                rentalRatePerShift={row.rentalRatePerShift}
                availableQuantity={row.availableQuantity}
                currentQty={qty}
                onAdd={() => onCatalogAdd(row)}
                onQuantityChange={(newQty) => onCatalogQuantityChange(row.equipmentId, newQty)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
