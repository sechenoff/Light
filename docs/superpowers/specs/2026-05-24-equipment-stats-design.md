# Equipment Stats — design spec

**Date:** 2026-05-24
**Scope:** New analytics page `/admin/equipment-stats` for SUPER_ADMIN. Surfaces four equipment-centric metric groups (demand, dead stock, profitability, quality) computed over a rolling time window (30 / 90 / 365 days, default 90).
**Out of scope this sprint:** Add-on/deficit metrics, seasonality charts, client-champion breakdowns, XLSX export. Documented in §9 as the next iteration.

## 1. Access and routing

- **URL:** `/admin/equipment-stats`.
- **Role:** `SUPER_ADMIN` only — frontend gates via `useRequireRole(["SUPER_ADMIN"])`, backend gates via `rolesGuard(["SUPER_ADMIN"])`. WAREHOUSE/TECHNICIAN see 403 → redirected to `/day` with `toast.error`.
- **Menu:** new entry «📊 Статистика техники» in `apps/web/src/lib/roleMatrix.ts` under `menuByRole.SUPER_ADMIN` only, placed after «Финансы». Not added to WAREHOUSE/TECHNICIAN menus.

## 2. API

Single endpoint, single round-trip. All four metric groups + KPI hero + master-table dataset are computed server-side and shipped in one payload.

### Endpoint

```
GET /api/equipment-stats?period=30|90|365
```

- `period` — Zod enum `z.enum(["30", "90", "365"])`, default `"90"`. Mapped to days.
- Returns 403 `FORBIDDEN_BY_ROLE` for WAREHOUSE/TECHNICIAN (via `rolesGuard`).
- Returns 401 `UNAUTHENTICATED` for valid API key without JWT (existing `rolesGuard` semantics).

### Response shape

```ts
type EquipmentStatRow = {
  id: string;                    // Equipment.id
  name: string;
  category: string;
  totalQuantity: number;         // Equipment.totalQuantity
  bookingsCount: number;         // distinct Booking in window (status in CONFIRMED|ISSUED|RETURNED)
  qtyShifts: number;             // Σ (BookingItem.quantity × shifts) in window
  revenueRub: string;            // Decimal as string, Σ EstimateLine.lineSum in window
  revenuePerStorageUnit: string; // Decimal as string, revenueRub / max(totalQuantity, 1)
  repairCount: number;           // Repair.createdAt in window for units of this equipment
  problemCount: number;          // ProblemItem.createdAt in window for units of this equipment
  repairCostRub: string;         // Σ Expense.amount where linkedRepair.unit.equipmentId = this, expenseDate in window
  lastBookingAt: string | null;  // max Booking.startDate ever (not limited to window) — for dead-stock empty case
};

type EquipmentStatsResponse = {
  period: "30d" | "90d" | "365d";
  rangeFrom: string;            // ISO
  rangeTo: string;              // ISO (= now())
  kpi: {
    activeCount: number;        // count of equipment with bookingsCount > 0
    dormantCount: number;       // count of equipment with bookingsCount === 0
    totalCount: number;
    revenueRub: string;         // Σ over all rows
    repairCostRub: string;      // Σ over all rows
  };
  demand: EquipmentStatRow[];     // top 10, sorted by bookingsCount desc, qtyShifts desc tiebreak
  deadStock: EquipmentStatRow[];  // top 10, sorted by lastBookingAt asc (nulls first = "never rented")
  revenue: EquipmentStatRow[];    // top 10, sorted by revenuePerStorageUnit desc, revenueRub desc tiebreak
  quality: EquipmentStatRow[];    // top 10, sorted by (repairCount + problemCount) desc, then repairCostRub desc
  table: EquipmentStatRow[];      // ALL catalog rows for master-table; client-side sort/filter. Current catalog ~500 rows → no server pagination in MVP. If catalog grows past ~3000 rows, move sort/filter/pagination server-side (out of scope).
};
```

### Files (backend)

- `apps/api/src/services/equipmentStats.ts` — pure compute fn `computeEquipmentStats(period: 30|90|365, prisma)`.
- `apps/api/src/routes/equipmentStats.ts` — thin Express route, Zod parse, calls service, serializes Decimals via existing `serializeDecimal.ts`.
- `apps/api/src/routes/index.ts` — mount `/api/equipment-stats` with router-level `rolesGuard(["SUPER_ADMIN"])`.

## 3. Metric definitions (precise)

These definitions are the source of truth — the service must follow them exactly so numbers on the page reconcile with bookings, finance, and repairs pages.

### Window membership

- **Window:** `rangeTo = now()`, `rangeFrom = rangeTo - period_days`.
- **Booking inclusion:** a `Booking` enters the demand/revenue calculation if `Booking.startDate >= rangeFrom AND Booking.startDate <= rangeTo`. This matches "what the equipment was used for in this period", which aligns with the user's mental model. `createdAt` is rejected because a booking made today for August is not "demand in May".
- **Booking status filter:** `status IN (CONFIRMED, ISSUED, RETURNED)`. `DRAFT`, `PENDING_APPROVAL`, `CANCELLED` are excluded — they represent intent, not realized rental.
- **Repair / ProblemItem inclusion:** `createdAt >= rangeFrom AND createdAt <= rangeTo`.
- **Expense inclusion (repair cost):** `expenseDate >= rangeFrom AND expenseDate <= rangeTo AND linkedRepairId IS NOT NULL`. Joined to `Repair → EquipmentUnit → Equipment` to attribute to equipment.

### Catalog-only

`BookingItem.equipmentId = null` (custom items) are excluded from every metric. The page reports on catalog positions only; ad-hoc items have no `Equipment` row to pivot on.

### `qtyShifts` derivation

Prefer the snapshotted `Estimate.shifts` for the booking's MAIN estimate when present (this matches what was actually billed). If no estimate exists (legacy import, rare), fall back to `Math.max(1, Math.ceil((endDate - startDate) / 24h))` matching the existing rounding rule. `qtyShifts` for a booking item = `BookingItem.quantity × shifts`. The row's `qtyShifts` field is the sum across all matching `BookingItem` rows in the window.

### `revenueRub`

Sum of `EstimateLine.lineSum` for all `EstimateLine` rows joined `Estimate → Booking` where the booking is in the window. **Both `EstimateKind.MAIN` and `ADDON`** are included — both represent realized rental revenue for the equipment, and the user-facing question ("какую технику чаще берут") doesn't distinguish initial rental from on-site add-on. Document the kind-blind aggregation in the service header so a future iteration can split MAIN vs ADDON if needed.

### `revenuePerStorageUnit`

`revenueRub / Math.max(totalQuantity, 1)`. If `totalQuantity = 0` (data hygiene), divide-by-1 keeps the number sane; UI shows the position with a small badge «без склада» so admin can fix the catalog.

### Dead stock ordering

Sorted by `lastBookingAt asc`. SQLite sorts `NULL` first by default with `asc`, which is correct here — "never rented" should be at the top of the dead-stock list. The service must verify or explicitly use a `COALESCE`/sentinel to keep this deterministic across Prisma client versions.

### Quality combined score

`repairCount + problemCount`. Equal weight in MVP. Tiebreak by `repairCostRub desc` (more expensive incidents float up).

## 4. UI / components

### Page shell

```
apps/web/app/admin/equipment-stats/page.tsx
  "use client";
  useRequireRole(["SUPER_ADMIN"]);
  <Suspense fallback={<PageLoader/>}>
    <EquipmentStatsPage />
  </Suspense>
```

### Layout (top to bottom)

```
<SectionHeader eyebrow="Аналитика" title="Статистика техники"
               actions={<PeriodToggle/>} />

<KpiHero>
  ├─ DayKpiCard: eyebrow "Активных позиций" / value "234 / 567"            / sub "за период"
  ├─ DayKpiCard: eyebrow "Мёртвый груз"     / value "198"                  / sub "позиций без аренды" (subTone="rose" if dormant > 30% of total)
  ├─ DayKpiCard: eyebrow "Выручка"          / value "1.2 М ₽"              / sub "за период"
  └─ DayKpiCard: eyebrow "Расход на ремонт" / value "87 К ₽"               / sub "linked-расходы"

<TopRankedSection icon="🔥" title="Чаще всего берут"           rows={demand}    primaryKey="bookingsCount" secondaryFmt="X броней · Y ед.-смен" trailingFmt="revenueRub" />
<TopRankedSection icon="💤" title="Мёртвый груз"               rows={deadStock} primaryKey="lastBookingAt"  secondaryFmt="не брали с {date} | никогда" />
<TopRankedSection icon="💰" title="Лучшая доходность на ед. склада" rows={revenue} primaryKey="revenuePerStorageUnit" secondaryFmt="₽/ед · totalQty шт" trailingFmt="revenueRub" />
<TopRankedSection icon="🔧" title="Проблемные позиции"         rows={quality}   primaryKey="incidentsTotal" secondaryFmt="X ремонтов · Y потерь" trailingFmt="repairCostRub" />

<MasterTable rows={table}>
  Filters: <select category> [«Без аренды»] [«С поломками»]
  Columns (sortable): Позиция | Категория | Σ кол-во | Броней | Ед.-смен | Выручка ₽ | ₽/ед. склада | Ремонтов | Потерь
  Row click → /equipment/[id]
```

### PeriodToggle (URL state)

- Segmented control: `30д` `90д` `год`. Default selected = `90д`.
- URL param `?period=30|90|365`. On change → `router.replace` (no history push).
- `useSearchParams` requires wrapping in `<Suspense>` at the page level (already present).

### Empty states

- Whole period empty (0 bookings): KPI shows zeros, each ranked section shows centered `<EmptyState>` with text «Нет данных за период», master-table shows «Нет позиций в каталоге» if `table.length === 0`.
- Section partially empty (e.g., dead stock = 0): show «Все позиции в работе — мёртвого груза нет 🎉».

### Format helpers (reuse)

- `formatRub` / `formatMoneyRub` from `apps/web/src/lib/format.ts`.
- `pluralize(n, "бронь", "брони", "броней")`, `pluralize(n, "ремонт", "ремонта", "ремонтов")`, `pluralize(n, "потеря", "потери", "потерь")`, `pluralize(n, "единица", "единицы", "единиц")` — add if missing.
- Last-booking date: «не брали с 12 мар» (DD MMM, current year) or «никогда» (when `null`).

### Design tokens

IBM Plex canon. Pure tokens — no hex literals. Cards on `bg-surface`/`border-border`. KPI dormant value uses `subTone="rose"` when the dormant share is >30% of catalog. Section icons stay as plain emoji (consistent with `/day` style).

### Files (frontend)

- `apps/web/app/admin/equipment-stats/page.tsx` — thin shell with `useRequireRole` + `<Suspense>`.
- `apps/web/src/components/equipment-stats/EquipmentStatsPage.tsx` — main container.
- `apps/web/src/components/equipment-stats/PeriodToggle.tsx` — segmented control with URL state.
- `apps/web/src/components/equipment-stats/KpiHero.tsx` — 4 KPI cards wrapper (uses existing `DayKpiCard`).
- `apps/web/src/components/equipment-stats/TopRankedSection.tsx` — reusable ranked-list block, used 4 times.
- `apps/web/src/components/equipment-stats/MasterTable.tsx` — sortable + filterable table.
- `apps/web/src/components/equipment-stats/useEquipmentStats.ts` — fetch hook (`apiFetch<EquipmentStatsResponse>`).
- `apps/web/src/lib/roleMatrix.ts` — add menu item (SUPER_ADMIN only).
- `docs/mockups/equipment-stats.html` — static HTML mockup for design-fidelity check (per project convention; created before implementation).

## 5. Data flow

```
Browser → GET /api/equipment-stats?period=90
   ↓ (rolesGuard SUPER_ADMIN)
Express route (equipmentStats.ts)
   ↓ Zod parse period
computeEquipmentStats(90, prisma)
   ↓ Promise.all of:
       - aggregate per equipment: bookingsCount, qtyShifts, revenue, repairs, problems, repairCost
       - lastBookingAt: separate per-equipment max(Booking.startDate) all-time
   ↓ assemble + sort top-10 for each section
   ↓ compute KPI totals
   ↓ serialize Decimals
Response JSON
   ↓
Browser EquipmentStatsPage re-renders sections + table
```

### Query strategy

One pass over `BookingItem`-in-window grouped by `equipmentId`, joined to `Estimate/EstimateLine` for revenue, plus separate counts for `Repair` and `ProblemItem` and `Expense.linkedRepair`. All run via `Promise.all`:

```ts
const [bookingItemsAgg, estimateLinesAgg, repairsAgg, problemsAgg, expensesAgg, lastBookingMap, allEquipment]
  = await Promise.all([...]);
```

Then merge in-memory keyed by `equipmentId`. With ~500 catalog rows and ~1000 booking items/year, this is sub-100ms — no need to cache.

`Estimate.shifts` is shared across all items of one booking, so the join can stay simple: `BookingItem → Booking → Estimate (MAIN, latest by createdAt)`. For dual-mode finance bookings (`legacyFinance=true` mostly) the MAIN estimate is still authoritative for shifts.

## 6. Edge cases

- **`totalQuantity = 0`:** `revenuePerStorageUnit` divides by 1 (clamp). UI shows the row in the «Доходность» section with badge «без склада»; master-table column shows the raw revenue.
- **Custom `BookingItem` (equipmentId=null):** excluded from every aggregate; document this as "catalog-only" in the service header comment.
- **Bookings with no MAIN Estimate:** rare (DRAFT or legacy import). Demand still counts the booking (since startDate is set); revenue contributes 0; `qtyShifts` falls back to date-based shift calculation.
- **MISSING/RETIRED units:** not relevant — we aggregate per equipment, not per unit; unit-status affects only `Repair`/`ProblemItem` counts which we count regardless of current unit status (the incident happened).
- **Equipment with no bookings ever (`lastBookingAt = null`):** sorts to top of dead stock; UI shows «никогда».
- **Period boundary:** `rangeFrom` is inclusive, `rangeTo = now()` is inclusive. No timezone normalization needed (this is admin analytics, not Moscow-date-only domain like Tasks).

## 7. Audit and observability

This is read-only analytics. **No `AuditEntry` writes.** The endpoint emits no side effects beyond the HTTP response.

If we ever want to track who looked at the stats (e.g., for compliance), it's a 1-line addition to the route, not core to the design.

## 8. Testing

### API (`apps/api/src/__tests__/equipmentStats.test.ts`)

Follow `dashboard.test.ts` pattern: isolated SQLite via `TEST_DB_PATH`, `prisma db push --force-reset`, `signSession()` for role tokens. Minimum cases:

1. TECHNICIAN → 403 `FORBIDDEN_BY_ROLE`.
2. WAREHOUSE → 403 `FORBIDDEN_BY_ROLE`.
3. SUPER_ADMIN + empty DB → 200, all arrays empty, KPI counters all 0, `kpi.revenueRub === "0"`.
4. SUPER_ADMIN + seed (3 equipment, 3 bookings of varying status incl. one CANCELLED + one DRAFT) → demand reflects only the CONFIRMED/ISSUED/RETURNED ones; revenue equals seed-known sum; `quality` reflects one seeded `Repair`.
5. Custom `BookingItem` (`equipmentId=null`) in a seeded booking → excluded from every aggregate; KPI doesn't double-count.
6. Equipment that was rented 6 months ago + nothing in last 30 days → appears in `deadStock` when `period=30`, in `demand` when `period=365`.
7. Equipment never rented → top of `deadStock` with `lastBookingAt: null`.
8. Invalid `period` query (e.g., `?period=abc`) → 400 from Zod with clear message.

### Web (`apps/web/src/components/equipment-stats/__tests__/`)

vitest + jsdom + @testing-library/react:

1. `TopRankedSection.test.tsx` — renders given rows with formatting; renders empty state when `rows.length === 0`.
2. `PeriodToggle.test.tsx` — clicking each pill updates URL (`router.replace` spy); active pill matches `?period=` param on mount.
3. `MasterTable.test.tsx` — sort by clicking column header (asc/desc/clear cycle); "Без аренды" filter chip narrows rows to `bookingsCount === 0`.

### Manual / design fidelity

- Run `npm run dev`, navigate to `/admin/equipment-stats`, verify all four sections render and master-table sorts.
- Capture screenshots at 375px and 1440px, compare to `docs/mockups/equipment-stats.html`. Required before merge per project convention (see `docs/mockups/warehouse-scan/FIDELITY-CHECK.md` precedent).

## 9. Out-of-scope (next iteration, when needed)

These are intentionally deferred to keep MVP focused. Adding any of them is a separate spec.

- **Add-on / deficit metrics** — top items added via `AddonRecord` (= what we keep forgetting in initial estimates), and items where `acknowledgedConflict=true` (demand exceeds stock). Signal for purchasing.
- **Seasonality chart** — monthly demand chart for top-N categories. Needs a chart library or rolled SVG.
- **Client-champion breakdown** — which clients drive demand for top equipment. Needs an additional grouping pass.
- **Period comparison** — show ±% vs previous equivalent window on each KPI/row. Doubles the aggregation cost; worth doing once base layout is validated.
- **XLSX export** — single-button export of the master-table via existing `exceljs` dependency. ~30 LOC.
- **Per-category rollup view** — KPI hero by category (e.g., "Свет" vs "Звук") rather than per-position. Useful when catalog grows past visual scan limit.

## 10. Risks and open questions (none blocking)

- **Estimate.shifts fallback accuracy:** the `Estimate` MAIN row is the source of truth for billed shifts. Legacy bookings without estimates use a date-based fallback that may differ from how they were actually billed. Acceptable for analytics, but flag in service comment so future readers know.
- **`legacyFinance=true` bookings:** they have estimates; the data path is identical. No special handling.
- **SQLite NULL ordering:** verify Prisma's emitted ORDER BY for `lastBookingAt asc` produces NULL-first in our SQLite version. If not, use a generated sort key `(lastBookingAt IS NULL DESC, lastBookingAt ASC)` or compute the sort client-side after fetching.
