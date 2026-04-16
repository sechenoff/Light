# /bookings/new Rebuild — Design Spec

> **Reference mockup:** `docs/mockups/booking-create.html`
> **Goal:** Rebuild the booking creation page to match the approved mockup — two-column layout, AI paste zone, 3-tier equipment table, sticky summary panel.
> **Scope:** Frontend only. All required API endpoints already exist.

## Current State

`apps/web/app/bookings/new/page.tsx` — 1,600-line monolith. Basic form with flat equipment list, availability table with quantity +/- controls, gaffer text parser (basic textarea + parse button), right sidebar with selected items and quote. Functional but doesn't match the mockup's information architecture or visual design.

## Target State (from mockup)

### Layout
Two-column grid: main content (left, flexible) + sticky summary sidebar (right, 320px). Top bar with breadcrumbs, status chip ("Черновик · автосохранение"), and action buttons.

### Sections (left column, top to bottom)

1. **Client & Project card** — client search/select with pill (avatar initials + name + history stats), project name input. "Новый клиент" link.

2. **Dates card** — two datetime inputs in a row with arrow separator. Hint row: duration tag + human-readable description.

3. **Equipment card** — header shows position count + total. Contains:
   - **AI paste zone** — dashed-border textarea for gaffer text. "Распознать позиции" button. Result indicator: "5 точно · 1 уточнить · 1 не найдено".
   - **Equipment table** — grid rows with left color stripe (green=resolved, amber=needsReview, red=unmatched). Columns: stripe | name+alias | qty input | price/day | total | delete.
   - **Expandable rows** for needsReview items: option pills to choose between candidates. "Пропустить" option.
   - **Expandable rows** for unmatched items: inline catalog search with keyboard navigation, "запомнить алиас" checkbox.
   - **Footer links:** "+ Добавить вручную", "Открыть каталог", "Скопировать из прошлой брони".
   - **Legend:** green=Точно, amber=Уточнить, red=Не в каталоге.

4. **Comment card** — "Для руководителя" textarea.

### Summary panel (right column, sticky)

- Big total number (IBM Plex Mono, 32px)
- Breakdown rows: rental, discount, total
- Action buttons: "Отправить на согласование →", "Сохранить черновик"
- Checks section: conflict status, client debt status, unmatched warnings, AI suggestions

## API Endpoints Used (all existing)

| Endpoint | Purpose |
|----------|---------|
| `POST /api/bookings/parse-gaffer-review` | AI text → 3-tier equipment list |
| `POST /api/bookings/quote` | Compute estimate from selected items |
| `POST /api/bookings/draft` | Create draft (dryRun=true for preview) |
| `GET /api/availability?start=&end=` | Check equipment availability |
| `GET /api/equipment/categories` | Category filter list |

## File Decomposition

The 1,600-line monolith must be split into focused components:

| File | Responsibility |
|------|---------------|
| `app/bookings/new/page.tsx` | Page shell: layout grid, top bar, state orchestration (~200 lines) |
| `src/components/bookings/create/ClientProjectCard.tsx` | Client search/pill + project name (~120 lines) |
| `src/components/bookings/create/DatesCard.tsx` | Date/time pickers + duration hint (~80 lines) |
| `src/components/bookings/create/EquipmentCard.tsx` | Equipment section shell: paste zone + table + footer (~100 lines) |
| `src/components/bookings/create/PasteZone.tsx` | AI text input + parse button + result indicator (~100 lines) |
| `src/components/bookings/create/EquipmentTable.tsx` | Table rows: resolved + needsReview + unmatched (~200 lines) |
| `src/components/bookings/create/NeedsReviewRow.tsx` | Expandable row with candidate option pills (~80 lines) |
| `src/components/bookings/create/UnmatchedRow.tsx` | Expandable row with inline catalog search (~120 lines) |
| `src/components/bookings/create/SummaryPanel.tsx` | Sticky right panel: total, breakdown, actions, checks (~150 lines) |
| `src/components/bookings/create/CommentCard.tsx` | "Для руководителя" textarea (~40 lines) |
| `src/components/bookings/create/types.ts` | Shared types for the create flow (~60 lines) |

**Total: ~1,250 lines across 11 files** (down from 1,600 in one file).

## Key Design Decisions

1. **No client search endpoint** — client is entered as text, upserted on draft creation. Mockup shows a pill with history stats — for MVP, show pill styling but skip history lookup (no endpoint). History stats can be added when `/api/clients/:name/stats` is built.

2. **Equipment state is the 3-tier array** — `GafferReviewApiItem[]` from parse-gaffer-review response becomes the single source of truth for the table. Manual additions go in as `kind: "resolved"` with a synthetic match. Deletions remove from array.

3. **Quote is debounced** — on any change to items/dates/discount, debounce 500ms then POST `/api/bookings/quote`. Summary panel renders latest quote response.

4. **Paste zone replaces current gaffer modal** — the current implementation opens a modal for gaffer review. Mockup has it inline in the equipment card. No modals needed.

5. **Availability check integrated** — resolved items show availability in the price column. If a resolved item has quantity > available, stripe turns amber.

6. **IBM Plex Canon** — all styling uses existing Tailwind tokens from `tailwind.config.ts`. No new CSS variables needed.

## Out of Scope

- Client history/stats lookup (needs new API endpoint)
- "Скопировать из прошлой брони" (needs new API)
- Autosave / realtime status chip
- Equipment photo thumbnails
- Mobile-specific layout (desktop-first, same as current)
