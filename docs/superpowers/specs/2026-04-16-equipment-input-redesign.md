# Equipment Input Redesign — Design Spec

## Goal

Redesign the equipment section (card 3 "Оборудование") on `/bookings/new` to support two input modes via a pill-switcher: AI text recognition (existing) and a new catalog browser with category accordions, search, and +/− quantity controls.

## Context

Currently the equipment card has a single AI paste zone and a "Добавить позицию вручную" link that creates an unmatched placeholder. Users want a full catalog browser as an alternative to AI input, with the ability to browse categories, search, and quickly add equipment with +/− buttons.

## Architecture

Two mutually exclusive modes share a common `items: EquipmentTableItem[]` state. A pill-switcher at the top of the equipment card toggles between modes. Switching modes preserves all items — the underlying data is the same, only the input UI changes.

The catalog mode fetches equipment from the existing `GET /api/availability` endpoint (which already supports `search` and `category` filtering) and `GET /api/equipment/categories` for the category list.

No backend changes required. All work is frontend-only.

## Mode 1: AI Input (existing, minor additions)

### What stays the same
- AI paste zone (textarea + "Распознать позиции" button)
- Equipment table with resolved/needsReview/unmatched rows
- All existing parsing, matching, and alias-learning logic

### What changes
- **Pill-switcher** added above the AI zone: `🤖 AI ввод` | `📋 Каталог`
- **Search bar** added below the equipment table: "Найти и добавить прибор..." — same search-and-select UX as the existing `UnmatchedRow` inline search, but standalone. Searches `GET /api/availability?start=...&end=...&search=...`, shows dropdown, selecting adds a resolved item to `items[]`.
- **"+ Добавить позицию вручную" link removed** — replaced by the search bar and catalog mode.

### Equipment card format in AI mode
Items displayed as cards (not the current grid table):
- Each card: rounded border, name on first line, "price/день · <span style="opacity:0.4">N шт.</span>" on second line
- Added items (qty > 0): green border + green background (`#f0fdf4` / `border-color: #bbf7d0`), −/qty/+ stepper on the right
- needsReview items: amber border + amber background, "· уточнить" label
- unmatched items: keep existing inline search UX within the card

## Mode 2: Catalog Browser (new)

### Layout (top to bottom)
1. **Search field** — "Поиск по названию...", debounce 300ms, queries `GET /api/availability?start=...&end=...&search=...`
2. **Category accordions** — fetched once from `GET /api/equipment/categories`, each accordion header shows category name + item count
3. **Equipment cards inside categories** — same card format as AI mode

### Category accordion behavior
- Categories load on first catalog mode activation (lazy fetch)
- Click category header → toggles open/closed
- Open category: fetches items from `GET /api/availability?start=...&end=...&category=...`
- Multiple categories can be open simultaneously

### Equipment card states (same in both modes)
1. **Not added** (qty = 0): white background, border `#e5e5e5`, button "＋ Добавить" on the right. First click sets qty = 1, card transitions to "added" state.
2. **Added** (qty > 0): green background `#f0fdf4`, border `#bbf7d0`, −/qty/+ stepper on the right. Pressing + increments, pressing − decrements. When qty reaches 0, card transitions back to "not added" state.
3. **Unavailable** (0 available): entire card at `opacity: 0.45`, no button, text "Нет в наличии" on the right. + button disabled.

### Availability display
- Below the price: `opacity: 0.4` text showing "· N шт." (available quantity for the selected date range)
- Uses the existing `availableQuantity` field from `AvailabilityRow`

### Search in catalog mode
- When user types in search field, filter results replace the category view
- Results shown as flat list of equipment cards (no category grouping)
- Clear search → back to category view

## Resizable Content Area

Both modes: the content area (items in AI mode, categories+items in catalog mode) has a configurable height.

- **Default**: compact, `max-height: ~280px`, overflow hidden
- **Resize handle**: gray pill (36×5px) at the bottom of the card, cursor `ns-resize`
- **Drag down**: increases `max-height`, page content below shifts down
- **Drag up**: decreases `max-height`, minimum ~180px
- **Hint**: when content is clipped, show "ещё N позиций ↓" at the bottom edge (fade gradient)
- **Implementation**: `mousedown` on handle → `mousemove` updates `max-height` state → `mouseup` stops. Also support touch events for mobile.

## Pill Switcher

- Full-width container with `background: #f0f0f0`, `border-radius: 7px`, `padding: 3px`
- Two segments: `🤖 AI ввод` and `📋 Каталог`
- Active segment: `background: #fff`, `box-shadow: 0 1px 3px rgba(0,0,0,0.08)`, `font-weight: 600`, `color: #333`
- Inactive segment: no background, `color: #888`
- State stored in `useState<"ai" | "catalog">("ai")`, default is AI mode

## Data Flow

### Shared state (lives in `page.tsx`)
- `items: EquipmentTableItem[]` — shared between both modes
- `inputMode: "ai" | "catalog"` — which mode is active
- All existing handlers: `onQuantityChange`, `onDelete`, `onSelectCandidate`, `onSkipItem`, `onSelectFromCatalog`

### New handler: `onCatalogAdd(equipment: AvailabilityRow)`
- Creates a new `EquipmentTableItem` with `match.kind = "resolved"` and qty = 1
- If equipment already exists in `items[]` (same `equipmentId`), increments quantity instead
- Uses `AvailabilityRow` fields to populate the resolved match

### New handler: `onCatalogQuantityChange(equipmentId: string, qty: number)`
- If qty > 0: updates existing item's quantity, or creates new item
- If qty = 0: removes item from `items[]`

### Catalog state (lives in new `CatalogBrowser` component)
- `categories: string[]` — fetched once
- `openCategories: Set<string>` — which accordions are open
- `categoryItems: Map<string, AvailabilityRow[]>` — cached per category
- `searchQuery: string` — debounced search input
- `searchResults: AvailabilityRow[] | null` — null = show categories, array = show search results

## Component Structure

```
EquipmentCard (updated)
├── CardHeader (eyebrow + position count)
├── ModeSwitcher (pill: ai | catalog)
├── ResizableContainer (wraps content, drag handle at bottom)
│   ├── [mode === "ai"]
│   │   ├── PasteZone (existing, unchanged)
│   │   ├── EquipmentItemList (new — replaces EquipmentTable grid with card format)
│   │   │   ├── ResolvedItemCard (green, −/+)
│   │   │   ├── NeedsReviewItemCard (amber, candidates)
│   │   │   └── UnmatchedItemCard (red, inline search)
│   │   └── QuickSearchBar (new — "Найти и добавить прибор...")
│   └── [mode === "catalog"]
│       └── CatalogBrowser (new)
│           ├── CatalogSearchField
│           ├── CategoryAccordion (per category)
│           │   └── CatalogItemCard (per equipment — same card as ResolvedItemCard)
│           └── CatalogSearchResults (flat list when searching)
└── ResizeHandle (gray pill, drag to resize)
```

## Files to Create/Modify

### New files
- `apps/web/src/components/bookings/create/ModeSwitcher.tsx` — pill switcher component
- `apps/web/src/components/bookings/create/CatalogBrowser.tsx` — catalog mode: search + categories + items
- `apps/web/src/components/bookings/create/CatalogItemCard.tsx` — equipment card with +/−/Add button
- `apps/web/src/components/bookings/create/CategoryAccordion.tsx` — collapsible category with item list
- `apps/web/src/components/bookings/create/QuickSearchBar.tsx` — search bar for AI mode manual add
- `apps/web/src/components/bookings/create/ResizableContainer.tsx` — container with drag-to-resize handle
- `apps/web/src/components/bookings/create/EquipmentItemList.tsx` — card-based item list (replaces grid table in this context)

### Modified files
- `apps/web/src/components/bookings/create/EquipmentCard.tsx` — add ModeSwitcher, ResizableContainer, conditional rendering of AI vs Catalog mode
- `apps/web/src/components/bookings/create/types.ts` — add `InputMode` type
- `apps/web/app/bookings/new/page.tsx` — add `inputMode` state, `onCatalogAdd`/`onCatalogQuantityChange` handlers, pass new props to EquipmentCard

### Unchanged files
- `PasteZone.tsx` — no changes
- `NeedsReviewRow.tsx` — no changes (but rendered inside card wrapper)
- `UnmatchedRow.tsx` — no changes (but rendered inside card wrapper)
- `SummaryPanel.tsx` — no changes (items still flow to summary via same `items[]`)

## Edge Cases

1. **No dates selected**: catalog mode disabled (no availability data). Show message "Выберите даты аренды для просмотра каталога". AI mode still works (parsing doesn't need dates, but search bar is disabled).
2. **Date change**: invalidate all cached `categoryItems`, re-fetch open categories. Items already added keep their quantities but availability numbers refresh.
3. **Item exists from AI, visible in catalog**: catalog shows current qty with green card and −/+ stepper. Changes in catalog update the same item in `items[]`.
4. **Max quantity**: + button stops at `availableQuantity`. Visual: + button becomes disabled/gray when qty = availableQuantity.
5. **Empty catalog category**: category accordion shows "Нет оборудования" inside.
6. **Search returns nothing**: show "Ничего не найдено" placeholder.
7. **Resize handle on mobile**: support touch events (`touchstart`/`touchmove`/`touchend`).

## Design Tokens (IBM Plex Canon)

All colors use existing Tailwind tokens from the design system:
- Added card: `bg-emerald-soft border-emerald` (mapped to `#f0fdf4` / `#bbf7d0`)
- NeedsReview card: `bg-amber-soft border-amber` (mapped to `#fffbeb` / `#fde68a`)
- Unavailable: `opacity-45`
- Switcher: `bg-surface-muted` container, `bg-surface shadow-xs` active pill
- Stepper buttons: `border-border`, + button `text-accent-bright` when active
- Price: `text-ink-3`, availability: `text-ink-3 opacity-40`

## Out of Scope

- Drag-and-drop reordering of items
- Saving preferred catalog view (open categories) across sessions
- Category management/editing
- Mobile-specific layout (existing responsive behavior is sufficient)
- Changes to SummaryPanel or right column
