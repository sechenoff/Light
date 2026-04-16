"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../../../lib/api";
import { CatalogItemCard } from "./CatalogItemCard";
import { CategoryAccordion } from "./CategoryAccordion";
import type { AvailabilityRow, EquipmentTableItem } from "./types";

type CatalogBrowserProps = {
  items: EquipmentTableItem[];
  pickupISO: string | null;
  returnISO: string | null;
  onCatalogAdd: (equipment: AvailabilityRow) => void;
  onCatalogQuantityChange: (equipmentId: string, qty: number) => void;
};

export function CatalogBrowser({
  items,
  pickupISO,
  returnISO,
  onCatalogAdd,
  onCatalogQuantityChange,
}: CatalogBrowserProps) {
  const [categories, setCategories] = useState<string[] | null>(null);
  const [openCats, setOpenCats] = useState<Set<string>>(new Set());

  // Search state
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<AvailabilityRow[] | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Date change key — forces CategoryAccordion to re-mount and re-fetch
  const dateKey = `${pickupISO ?? ""}-${returnISO ?? ""}`;

  // Load categories once
  useEffect(() => {
    let cancelled = false;
    apiFetch<string[]>("/api/equipment/categories").then((cats) => {
      if (!cancelled) setCategories(cats);
    });
    return () => { cancelled = true; };
  }, []);

  // Reset accordion caches when dates change
  useEffect(() => {
    setOpenCats(new Set());
    setSearchResults(null);
    setSearchQuery("");
  }, [pickupISO, returnISO]);

  const fetchCategoryItems = useCallback(
    async (category: string): Promise<AvailabilityRow[]> => {
      if (!pickupISO || !returnISO) return [];
      const params = new URLSearchParams({ start: pickupISO, end: returnISO, category });
      const data = await apiFetch<{ rows: AvailabilityRow[] }>(`/api/availability?${params}`);
      return data.rows;
    },
    [pickupISO, returnISO],
  );

  const toggleCategory = useCallback((cat: string) => {
    setOpenCats((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }, []);

  // Search
  const runSearch = useCallback(
    async (q: string) => {
      if (!q.trim() || !pickupISO || !returnISO) {
        setSearchResults(null);
        return;
      }
      const params = new URLSearchParams({ start: pickupISO, end: returnISO, search: q });
      const data = await apiFetch<{ rows: AvailabilityRow[] }>(`/api/availability?${params}`);
      setSearchResults(data.rows);
    },
    [pickupISO, returnISO],
  );

  const handleSearchChange = (value: string) => {
    setSearchQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!value.trim()) {
      setSearchResults(null);
      return;
    }
    debounceRef.current = setTimeout(() => runSearch(value), 300);
  };

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const getQtyForEquipment = useCallback(
    (equipmentId: string): number => {
      const found = items.find(
        (it) => it.match.kind === "resolved" && it.match.equipmentId === equipmentId,
      );
      return found ? found.quantity : 0;
    },
    [items],
  );

  if (!pickupISO || !returnISO) {
    return (
      <div className="py-6 text-center text-xs text-ink-3">
        Выберите даты аренды для просмотра каталога
      </div>
    );
  }

  return (
    <div>
      {/* Search */}
      <div className="mb-2">
        <div className="relative">
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3 text-sm select-none opacity-40" aria-hidden="true">
            🔍
          </span>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder="Поиск по названию..."
            className="w-full rounded-md border border-border bg-surface py-2 pl-8 pr-3 text-xs text-ink placeholder:text-ink-3 focus:border-accent-bright focus:outline-none"
          />
          {searchQuery && (
            <button
              type="button"
              aria-label="Очистить поиск"
              onClick={() => handleSearchChange("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-3 hover:text-ink"
            >
              ×
            </button>
          )}
        </div>
      </div>

      {/* Search results (flat list) */}
      {searchResults !== null ? (
        <div className="flex flex-col gap-1.5">
          {searchResults.length === 0 && (
            <div className="py-4 text-center text-xs text-ink-3">Ничего не найдено</div>
          )}
          {searchResults.map((row) => (
            <CatalogItemCard
              key={row.equipmentId}
              name={row.name}
              rentalRatePerShift={row.rentalRatePerShift}
              availableQuantity={row.availableQuantity}
              currentQty={getQtyForEquipment(row.equipmentId)}
              onAdd={() => onCatalogAdd(row)}
              onQuantityChange={(qty) => onCatalogQuantityChange(row.equipmentId, qty)}
            />
          ))}
        </div>
      ) : (
        /* Category accordions */
        <div className="rounded-md border border-border overflow-hidden">
          {categories === null && (
            <div className="py-4 text-center text-xs text-ink-3">Загрузка категорий...</div>
          )}
          {categories?.map((cat) => (
            <CategoryAccordion
              key={`${cat}-${dateKey}`}
              category={cat}
              isOpen={openCats.has(cat)}
              onToggle={() => toggleCategory(cat)}
              fetchItems={fetchCategoryItems}
              items={items}
              onCatalogAdd={onCatalogAdd}
              onCatalogQuantityChange={onCatalogQuantityChange}
            />
          ))}
        </div>
      )}
    </div>
  );
}
