# Equipment Input Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a two-mode equipment input (AI + Catalog browser) with pill-switcher, category accordions, +/− quantity controls, and resizable content area to `/bookings/new`.

**Architecture:** Frontend-only. Two mutually exclusive input modes share a single `items[]` state. A pill-switcher toggles between existing AI paste mode and a new catalog browser. All equipment data comes from existing `GET /api/availability` and `GET /api/equipment/categories` endpoints. No backend changes.

**Tech Stack:** React 18, Next.js 14, Tailwind CSS 3, TypeScript

**Spec:** `docs/superpowers/specs/2026-04-16-equipment-input-redesign.md`

---

## File Structure

### New files (all in `apps/web/src/components/bookings/create/`)
| File | Responsibility |
|------|---------------|
| `ModeSwitcher.tsx` | Pill-shaped toggle: "🤖 AI ввод" / "📋 Каталог" |
| `ResizableContainer.tsx` | Wrapper with drag handle at bottom, adjustable `max-height` |
| `CatalogItemCard.tsx` | Universal equipment card: 3 states (not added / added / unavailable) with −/+/Add |
| `QuickSearchBar.tsx` | Standalone search bar for AI mode: type → dropdown → select → add to items |
| `CategoryAccordion.tsx` | Collapsible category header + list of `CatalogItemCard` inside |
| `CatalogBrowser.tsx` | Catalog mode root: search field + list of `CategoryAccordion` |

### Modified files
| File | Changes |
|------|---------|
| `types.ts` | Add `InputMode` type alias |
| `EquipmentCard.tsx` | Complete rewrite: add ModeSwitcher, ResizableContainer, conditional AI/Catalog rendering |
| `page.tsx` | Add `inputMode` state, `handleCatalogAdd`, `handleCatalogQuantityChange` handlers, new props to EquipmentCard |

### Unchanged files
`PasteZone.tsx`, `EquipmentTable.tsx`, `NeedsReviewRow.tsx`, `UnmatchedRow.tsx`, `SummaryPanel.tsx` — no modifications needed. `EquipmentTable` is still used inside AI mode.

---

### Task 1: Add InputMode type

**Files:**
- Modify: `apps/web/src/components/bookings/create/types.ts`

- [ ] **Step 1: Add type to types.ts**

Add at the end of the file, after the `ParseResultCounts` type:

```typescript
/** Equipment input mode switcher */
export type InputMode = "ai" | "catalog";
```

- [ ] **Step 2: Verify no TypeScript errors**

Run: `cd /Users/sechenov/Documents/light-rental-system && npx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | head -20`
Expected: no new errors (existing errors may be present)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/bookings/create/types.ts
git commit -m "feat(web): add InputMode type for equipment input switcher"
```

---

### Task 2: ModeSwitcher component

**Files:**
- Create: `apps/web/src/components/bookings/create/ModeSwitcher.tsx`

- [ ] **Step 1: Create ModeSwitcher.tsx**

```tsx
"use client";

import type { InputMode } from "./types";

type ModeSwitcherProps = {
  mode: InputMode;
  onModeChange: (mode: InputMode) => void;
};

export function ModeSwitcher({ mode, onModeChange }: ModeSwitcherProps) {
  return (
    <div className="mx-5 mt-3">
      <div className="flex rounded-[7px] bg-surface-muted p-[3px]">
        <button
          type="button"
          onClick={() => onModeChange("ai")}
          className={
            mode === "ai"
              ? "flex-1 rounded-[5px] bg-surface py-1.5 text-center text-xs font-semibold text-ink shadow-xs"
              : "flex-1 rounded-[5px] py-1.5 text-center text-xs text-ink-3 hover:text-ink-2"
          }
        >
          🤖 AI ввод
        </button>
        <button
          type="button"
          onClick={() => onModeChange("catalog")}
          className={
            mode === "catalog"
              ? "flex-1 rounded-[5px] bg-surface py-1.5 text-center text-xs font-semibold text-ink shadow-xs"
              : "flex-1 rounded-[5px] py-1.5 text-center text-xs text-ink-3 hover:text-ink-2"
          }
        >
          📋 Каталог
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify no TypeScript errors**

Run: `cd /Users/sechenov/Documents/light-rental-system && npx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | head -20`

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/bookings/create/ModeSwitcher.tsx
git commit -m "feat(web): add ModeSwitcher pill component for AI/Catalog toggle"
```

---

### Task 3: ResizableContainer component

**Files:**
- Create: `apps/web/src/components/bookings/create/ResizableContainer.tsx`

- [ ] **Step 1: Create ResizableContainer.tsx**

```tsx
"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";

type ResizableContainerProps = {
  children: ReactNode;
  defaultHeight?: number;
  minHeight?: number;
};

export function ResizableContainer({
  children,
  defaultHeight = 280,
  minHeight = 180,
}: ResizableContainerProps) {
  const [maxH, setMaxH] = useState(defaultHeight);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const startY = useRef(0);
  const startH = useRef(0);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      dragging.current = true;
      startY.current = e.clientY;
      startH.current = maxH;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [maxH],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current) return;
      const delta = e.clientY - startY.current;
      setMaxH(Math.max(minHeight, startH.current + delta));
    },
    [minHeight],
  );

  const onPointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  const isClipped =
    containerRef.current
      ? containerRef.current.scrollHeight > maxH
      : false;

  return (
    <div className="mx-5">
      <div
        ref={containerRef}
        className="overflow-hidden transition-[max-height] duration-100"
        style={{ maxHeight: `${maxH}px` }}
      >
        {children}
      </div>

      {/* Clip hint */}
      {isClipped && (
        <div className="pointer-events-none -mt-6 h-6 bg-gradient-to-t from-surface to-transparent" />
      )}

      {/* Resize handle */}
      <div
        className="flex cursor-ns-resize justify-center py-1.5 select-none touch-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        role="separator"
        aria-label="Изменить высоту области"
      >
        <div className="h-[5px] w-9 rounded-full bg-border-strong" />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify no TypeScript errors**

Run: `cd /Users/sechenov/Documents/light-rental-system && npx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | head -20`

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/bookings/create/ResizableContainer.tsx
git commit -m "feat(web): add ResizableContainer with drag-to-resize handle"
```

---

### Task 4: CatalogItemCard component

**Files:**
- Create: `apps/web/src/components/bookings/create/CatalogItemCard.tsx`

- [ ] **Step 1: Create CatalogItemCard.tsx**

This is the universal equipment card used in both AI mode (for resolved items) and catalog mode. Three states: not added, added, unavailable.

```tsx
"use client";

import { formatMoneyRub } from "../../../lib/format";

type CatalogItemCardProps = {
  name: string;
  rentalRatePerShift: string;
  availableQuantity: number;
  currentQty: number;
  onAdd: () => void;
  onQuantityChange: (qty: number) => void;
};

export function CatalogItemCard({
  name,
  rentalRatePerShift,
  availableQuantity,
  currentQty,
  onAdd,
  onQuantityChange,
}: CatalogItemCardProps) {
  const unitPrice = Number(rentalRatePerShift);
  const isAdded = currentQty > 0;
  const isUnavailable = availableQuantity === 0 && currentQty === 0;
  const atMax = currentQty >= availableQuantity;

  if (isUnavailable) {
    return (
      <div className="flex items-center rounded-lg border border-border bg-surface-muted px-3 py-2 opacity-45">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-ink">{name}</div>
          <div className="mt-0.5 text-[11px] text-ink-3">
            {formatMoneyRub(unitPrice)} ₽/день{" "}
            <span className="opacity-40">· 0 шт.</span>
          </div>
        </div>
        <span className="shrink-0 text-[11px] text-ink-3">Нет в наличии</span>
      </div>
    );
  }

  if (!isAdded) {
    return (
      <div className="flex items-center rounded-lg border border-border bg-surface px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-ink">{name}</div>
          <div className="mt-0.5 text-[11px] text-ink-3">
            {formatMoneyRub(unitPrice)} ₽/день{" "}
            <span className="opacity-40">· {availableQuantity} шт.</span>
          </div>
        </div>
        <button
          type="button"
          onClick={onAdd}
          className="shrink-0 flex items-center gap-1 rounded-[5px] border border-accent-bright bg-surface px-2.5 py-1 text-[11px] font-medium text-accent-bright hover:bg-accent-soft"
        >
          <span className="text-sm">+</span> Добавить
        </button>
      </div>
    );
  }

  // Added state — green card with −/qty/+
  return (
    <div className="flex items-center rounded-lg border border-emerald bg-emerald-soft px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-ink">{name}</div>
        <div className="mt-0.5 text-[11px] text-ink-3">
          {formatMoneyRub(unitPrice)} ₽/день{" "}
          <span className="opacity-40">· {availableQuantity} шт.</span>
        </div>
      </div>
      <div className="flex shrink-0 items-center">
        <button
          type="button"
          aria-label="Уменьшить количество"
          onClick={() => onQuantityChange(currentQty - 1)}
          className="flex h-[30px] w-[30px] items-center justify-center rounded-l-[5px] border border-border bg-surface text-[16px] text-ink-2 hover:bg-surface-muted"
        >
          −
        </button>
        <div className="flex h-[30px] w-[34px] items-center justify-center border-y border-border bg-surface font-mono text-[13px] font-semibold text-ink">
          {currentQty}
        </div>
        <button
          type="button"
          aria-label="Увеличить количество"
          onClick={() => onQuantityChange(currentQty + 1)}
          disabled={atMax}
          className={
            atMax
              ? "flex h-[30px] w-[30px] items-center justify-center rounded-r-[5px] border border-border bg-surface-muted text-[16px] text-border-strong"
              : "flex h-[30px] w-[30px] items-center justify-center rounded-r-[5px] border border-border bg-surface text-[16px] text-accent-bright hover:bg-surface-muted"
          }
        >
          +
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify no TypeScript errors**

Run: `cd /Users/sechenov/Documents/light-rental-system && npx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | head -20`

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/bookings/create/CatalogItemCard.tsx
git commit -m "feat(web): add CatalogItemCard with 3 states (not added / added / unavailable)"
```

---

### Task 5: QuickSearchBar component

**Files:**
- Create: `apps/web/src/components/bookings/create/QuickSearchBar.tsx`

- [ ] **Step 1: Create QuickSearchBar.tsx**

Standalone search bar for AI mode. Type → debounced search → dropdown results → select → adds resolved item to `items[]`. Follows same pattern as `UnmatchedRow.tsx` inline search but without alias-saving.

```tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatMoneyRub } from "../../../lib/format";
import type { AvailabilityRow } from "./types";

type QuickSearchBarProps = {
  searchCatalog: (query: string) => Promise<AvailabilityRow[]>;
  onSelect: (equipment: AvailabilityRow) => void;
  disabled?: boolean;
};

export function QuickSearchBar({ searchCatalog, onSelect, disabled }: QuickSearchBarProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AvailabilityRow[]>([]);
  const [focusIdx, setFocusIdx] = useState(-1);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const runSearch = useCallback(
    (q: string) => {
      if (!q.trim()) {
        setResults([]);
        setFocusIdx(-1);
        return;
      }
      searchCatalog(q).then((rows) => {
        setResults(rows);
        setFocusIdx(-1);
      });
    },
    [searchCatalog],
  );

  const handleChange = (value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runSearch(value), 300);
  };

  const handleSelect = (row: AvailabilityRow) => {
    onSelect(row);
    setQuery("");
    setResults([]);
    setFocusIdx(-1);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusIdx((prev) => Math.min(prev + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusIdx((prev) => Math.max(prev - 1, -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (focusIdx >= 0 && focusIdx < results.length) {
        handleSelect(results[focusIdx]);
      }
    } else if (e.key === "Escape") {
      setQuery("");
      setResults([]);
      setFocusIdx(-1);
    }
  };

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  return (
    <div className="relative">
      <div className="relative">
        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3 text-sm select-none opacity-40" aria-hidden="true">
          🔍
        </span>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Найти и добавить прибор..."
          disabled={disabled}
          className="w-full rounded-md border border-border bg-surface py-2 pl-8 pr-3 text-xs text-ink placeholder:text-ink-3 focus:border-accent-bright focus:outline-none disabled:opacity-50"
        />
      </div>

      {results.length > 0 && (
        <ul className="absolute left-0 right-0 z-20 mt-1 max-h-48 overflow-y-auto rounded-md border border-border bg-surface shadow-xs">
          {results.map((row, idx) => (
            <li key={row.equipmentId}>
              <button
                type="button"
                onClick={() => handleSelect(row)}
                className={
                  idx === focusIdx
                    ? "flex w-full items-center justify-between gap-2 border-l-2 border-accent-bright bg-accent-soft px-3 py-2 text-left text-xs"
                    : "flex w-full items-center justify-between gap-2 border-l-2 border-transparent px-3 py-2 text-left text-xs hover:bg-accent-soft hover:border-accent-bright"
                }
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-ink">{row.name}</span>
                  <span className="text-[10.5px] text-ink-3">
                    {row.category} · {row.availableQuantity} шт.
                  </span>
                </span>
                <span className="shrink-0 font-mono text-[11px] text-ink-2">
                  {formatMoneyRub(row.rentalRatePerShift)} ₽/день
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {query.trim() && results.length === 0 && (
        <div className="absolute left-0 right-0 z-20 mt-1 rounded-md border border-border bg-surface px-3 py-3 text-center text-xs text-ink-3 shadow-xs">
          Ничего не найдено
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify no TypeScript errors**

Run: `cd /Users/sechenov/Documents/light-rental-system && npx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | head -20`

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/bookings/create/QuickSearchBar.tsx
git commit -m "feat(web): add QuickSearchBar for manual equipment search in AI mode"
```

---

### Task 6: CategoryAccordion component

**Files:**
- Create: `apps/web/src/components/bookings/create/CategoryAccordion.tsx`

- [ ] **Step 1: Create CategoryAccordion.tsx**

```tsx
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
    fetchItems(category).then((data) => {
      if (!cancelled) {
        setRows(data);
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
```

- [ ] **Step 2: Verify no TypeScript errors**

Run: `cd /Users/sechenov/Documents/light-rental-system && npx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | head -20`

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/bookings/create/CategoryAccordion.tsx
git commit -m "feat(web): add CategoryAccordion with lazy-load and CatalogItemCard integration"
```

---

### Task 7: CatalogBrowser component

**Files:**
- Create: `apps/web/src/components/bookings/create/CatalogBrowser.tsx`

- [ ] **Step 1: Create CatalogBrowser.tsx**

```tsx
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
```

- [ ] **Step 2: Verify no TypeScript errors**

Run: `cd /Users/sechenov/Documents/light-rental-system && npx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | head -20`

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/bookings/create/CatalogBrowser.tsx
git commit -m "feat(web): add CatalogBrowser with search, category accordions, and date-aware availability"
```

---

### Task 8: Rewrite EquipmentCard to support two modes

**Files:**
- Modify: `apps/web/src/components/bookings/create/EquipmentCard.tsx`

- [ ] **Step 1: Rewrite EquipmentCard.tsx**

Replace the entire file contents with:

```tsx
"use client";

import { formatMoneyRub, pluralize } from "../../../lib/format";
import { PasteZone } from "./PasteZone";
import { EquipmentTable } from "./EquipmentTable";
import { ModeSwitcher } from "./ModeSwitcher";
import { ResizableContainer } from "./ResizableContainer";
import { QuickSearchBar } from "./QuickSearchBar";
import { CatalogBrowser } from "./CatalogBrowser";
import type {
  InputMode,
  EquipmentTableItem,
  GafferCandidate,
  AvailabilityRow,
  ParseResultCounts,
} from "./types";

type EquipmentCardProps = {
  // Data
  items: EquipmentTableItem[];
  shifts: number;
  totalAmount: number;
  inputMode: InputMode;
  onInputModeChange: (mode: InputMode) => void;

  // PasteZone props
  text: string;
  onTextChange: (v: string) => void;
  onParse: () => void;
  onClear: () => void;
  isParsing: boolean;
  error: string | null;
  resultCounts: ParseResultCounts | null;

  // EquipmentTable props
  onQuantityChange: (itemId: string, qty: number) => void;
  onDelete: (itemId: string) => void;
  onSelectCandidate: (itemId: string, candidate: GafferCandidate) => void;
  onSkipItem: (itemId: string) => void;
  onSelectFromCatalog: (itemId: string, equipment: AvailabilityRow, saveAlias: boolean) => void;
  searchCatalog: (query: string) => Promise<AvailabilityRow[]>;

  // Catalog browser props
  pickupISO: string | null;
  returnISO: string | null;
  onCatalogAdd: (equipment: AvailabilityRow) => void;
  onCatalogQuantityChange: (equipmentId: string, qty: number) => void;

  // Quick search callback
  onQuickSearchSelect: (equipment: AvailabilityRow) => void;
};

export function EquipmentCard({
  items,
  shifts,
  totalAmount,
  inputMode,
  onInputModeChange,
  text,
  onTextChange,
  onParse,
  onClear,
  isParsing,
  error,
  resultCounts,
  onQuantityChange,
  onDelete,
  onSelectCandidate,
  onSkipItem,
  onSelectFromCatalog,
  searchCatalog,
  pickupISO,
  returnISO,
  onCatalogAdd,
  onCatalogQuantityChange,
  onQuickSearchSelect,
}: EquipmentCardProps) {
  const itemCount = items.length;
  const positionLabel = `${itemCount} ${pluralize(itemCount, "позиция", "позиции", "позиций")}`;
  const totalLabel = `${formatMoneyRub(totalAmount)} ₽ / период`;

  const hasDates = Boolean(pickupISO && returnISO);

  return (
    <div className="rounded-lg border border-border bg-surface shadow-xs">
      {/* Card header */}
      <div className="flex items-baseline justify-between px-5 pt-4 pb-3 border-b border-border">
        <div>
          <p className="eyebrow text-ink-3 mb-0.5">3. Оборудование</p>
        </div>
        <p className="text-sm text-ink-2 mono-num">
          {positionLabel} · {totalLabel}
        </p>
      </div>

      {/* Mode switcher */}
      <ModeSwitcher mode={inputMode} onModeChange={onInputModeChange} />

      {/* Content area */}
      <ResizableContainer defaultHeight={inputMode === "catalog" ? 360 : 280}>
        {inputMode === "ai" ? (
          <div>
            {/* AI paste zone */}
            <PasteZone
              text={text}
              onTextChange={onTextChange}
              onParse={onParse}
              onClear={onClear}
              isParsing={isParsing}
              error={error}
              resultCounts={resultCounts}
            />

            {/* Equipment table */}
            <div className="mx-5 mb-3">
              <EquipmentTable
                items={items}
                shifts={shifts}
                onQuantityChange={onQuantityChange}
                onDelete={onDelete}
                onSelectCandidate={onSelectCandidate}
                onSkipItem={onSkipItem}
                onSelectFromCatalog={onSelectFromCatalog}
                searchCatalog={searchCatalog}
              />
            </div>

            {/* Quick search bar */}
            <div className="mx-5 mb-3">
              <QuickSearchBar
                searchCatalog={searchCatalog}
                onSelect={onQuickSearchSelect}
                disabled={!hasDates}
              />
            </div>
          </div>
        ) : (
          <div className="mx-5 mt-3 mb-3">
            <CatalogBrowser
              items={items}
              pickupISO={pickupISO}
              returnISO={returnISO}
              onCatalogAdd={onCatalogAdd}
              onCatalogQuantityChange={onCatalogQuantityChange}
            />
          </div>
        )}
      </ResizableContainer>

      {/* Legend (AI mode only) */}
      {inputMode === "ai" && (
        <div className="flex items-center gap-4 px-5 pb-4 pt-0 text-xs text-ink-3">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald inline-block" aria-hidden="true" />
            Точно
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-amber inline-block" aria-hidden="true" />
            Уточнить
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-rose inline-block" aria-hidden="true" />
            Не в каталоге
          </span>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify no TypeScript errors**

Run: `cd /Users/sechenov/Documents/light-rental-system && npx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | head -20`
Expected: errors in `page.tsx` because new props (`inputMode`, `onInputModeChange`, etc.) are not yet passed. This is expected — Task 9 fixes it.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/bookings/create/EquipmentCard.tsx
git commit -m "feat(web): rewrite EquipmentCard with two-mode support (AI + Catalog)"
```

---

### Task 9: Wire page.tsx with new state and handlers

**Files:**
- Modify: `apps/web/app/bookings/new/page.tsx`

- [ ] **Step 1: Add InputMode import**

At the top of the file, add `InputMode` to the type import from `types`:

Replace:
```typescript
import type {
  EquipmentTableItem,
  GafferReviewApiItem,
  GafferReviewApiResponse,
  GafferCandidate,
  QuoteResponse,
  AvailabilityRow,
  ValidationCheck,
  ParseResultCounts,
} from "../../../src/components/bookings/create/types";
```

With:
```typescript
import type {
  InputMode,
  EquipmentTableItem,
  GafferReviewApiItem,
  GafferReviewApiResponse,
  GafferCandidate,
  QuoteResponse,
  AvailabilityRow,
  ValidationCheck,
  ParseResultCounts,
} from "../../../src/components/bookings/create/types";
```

- [ ] **Step 2: Add new state and handlers**

After the line `const [gafferText, setGafferText] = useState("");` (around line 86), add:

```typescript
  const [inputMode, setInputMode] = useState<InputMode>("ai");
```

After the `handleAddManual` function (around line 338), add these two new handlers:

```typescript
  function handleCatalogAdd(equipment: AvailabilityRow) {
    // If equipment already in items, increment qty
    const existing = items.find(
      (it) => it.match.kind === "resolved" && it.match.equipmentId === equipment.equipmentId,
    );
    if (existing) {
      setItems((prev) =>
        prev.map((it) => (it.id === existing.id ? { ...it, quantity: it.quantity + 1 } : it)),
      );
      return;
    }
    // Add new resolved item
    const id = `catalog-${equipment.equipmentId}-${Date.now()}`;
    setItems((prev) => [
      ...prev,
      {
        id,
        gafferPhrase: equipment.name,
        interpretedName: equipment.name,
        quantity: 1,
        match: {
          kind: "resolved" as const,
          equipmentId: equipment.equipmentId,
          catalogName: equipment.name,
          category: equipment.category,
          availableQuantity: equipment.availableQuantity,
          rentalRatePerShift: equipment.rentalRatePerShift,
          confidence: 1,
        },
        unitPrice: equipment.rentalRatePerShift,
        lineTotal: null,
      },
    ]);
  }

  function handleCatalogQuantityChange(equipmentId: string, qty: number) {
    if (qty <= 0) {
      // Remove item
      setItems((prev) =>
        prev.filter(
          (it) => !(it.match.kind === "resolved" && it.match.equipmentId === equipmentId),
        ),
      );
      return;
    }
    setItems((prev) =>
      prev.map((it) =>
        it.match.kind === "resolved" && it.match.equipmentId === equipmentId
          ? { ...it, quantity: qty }
          : it,
      ),
    );
  }

  function handleQuickSearchSelect(equipment: AvailabilityRow) {
    handleCatalogAdd(equipment);
  }
```

- [ ] **Step 3: Update EquipmentCard props**

Replace the `<EquipmentCard ... />` JSX block (around line 469-487) with:

```tsx
            <EquipmentCard
              items={items}
              shifts={shifts}
              totalAmount={quote ? Number(quote.totalAfterDiscount) : localTotal}
              inputMode={inputMode}
              onInputModeChange={setInputMode}
              text={gafferText}
              onTextChange={setGafferText}
              onParse={handleParse}
              onClear={handlePasteClear}
              isParsing={gafferParsing}
              error={gafferError}
              resultCounts={parseResultCounts}
              onQuantityChange={handleQuantityChange}
              onDelete={handleDeleteItem}
              onSelectCandidate={handleSelectCandidate}
              onSkipItem={handleSkipItem}
              onSelectFromCatalog={handleSelectFromCatalog}
              searchCatalog={searchCatalog}
              pickupISO={pickupISO}
              returnISO={returnISO}
              onCatalogAdd={handleCatalogAdd}
              onCatalogQuantityChange={handleCatalogQuantityChange}
              onQuickSearchSelect={handleQuickSearchSelect}
            />
```

- [ ] **Step 4: Remove onAddManual prop and footer link**

The `onAddManual={handleAddManual}` prop is no longer passed (it's removed from `EquipmentCardProps`). The `handleAddManual` function can remain in `page.tsx` as dead code for now — or delete it. Either is fine. The key point: the old `<EquipmentCard>` prop `onAddManual` no longer exists, so this is already handled by the rewrite in Task 8.

- [ ] **Step 5: Verify TypeScript compiles**

Run: `cd /Users/sechenov/Documents/light-rental-system && npx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | head -30`
Expected: no errors related to equipment card or catalog components.

- [ ] **Step 6: Verify the build**

Run: `cd /Users/sechenov/Documents/light-rental-system && npm run build -w apps/web 2>&1 | tail -20`
Expected: build succeeds.

- [ ] **Step 7: Commit**

```bash
git add apps/web/app/bookings/new/page.tsx
git commit -m "feat(web): wire equipment input modes — AI/Catalog state, handlers, and props"
```

---

## Self-Review Checklist

**Spec coverage:**
- ✅ Pill switcher (Task 2, wired in Task 8)
- ✅ AI mode preserved with PasteZone + EquipmentTable (Task 8)
- ✅ QuickSearchBar in AI mode (Task 5, wired in Task 8)
- ✅ Catalog browser with categories + search (Tasks 6-7, wired in Task 8)
- ✅ CatalogItemCard with 3 states (Task 4)
- ✅ Resizable container with drag handle (Task 3)
- ✅ Shared `items[]` with catalog add/qty handlers (Task 9)
- ✅ Date-aware availability (CatalogBrowser uses pickupISO/returnISO)
- ✅ No dates → catalog shows message (CatalogBrowser)
- ✅ Date change → reset accordion caches (CatalogBrowser useEffect)
- ✅ Availability display with opacity (CatalogItemCard)
- ✅ Max quantity enforcement (CatalogItemCard `atMax`)
- ✅ Unavailable items disabled (CatalogItemCard)
- ✅ Legend only in AI mode (Task 8)
- ✅ "Добавить позицию вручную" link removed (Task 8)
- ✅ InputMode type added (Task 1)
- ✅ Touch events for resize (PointerEvents cover mouse+touch)

**Placeholder scan:** No TBDs, TODOs, or vague instructions. All code is complete.

**Type consistency:** `InputMode`, `AvailabilityRow`, `EquipmentTableItem`, `GafferCandidate`, `onCatalogAdd`, `onCatalogQuantityChange`, `onQuickSearchSelect` — consistent across all tasks.
