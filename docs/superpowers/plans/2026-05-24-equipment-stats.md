# Equipment Stats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `/admin/equipment-stats` analytics page (SUPER_ADMIN only) with KPI hero, four ranked sections (demand / dead stock / revenue / quality) and a sortable master-table, computed over a rolling 30/90/365-day window.

**Architecture:** Single backend endpoint computes all metrics in one round-trip (Promise.all of per-equipment aggregates → merge by equipmentId → sort + slice per section). Frontend is a thin shell + reusable presentational components, using the project's IBM Plex canon design tokens.

**Tech Stack:** Express + Prisma 6 (SQLite) + Zod + vitest (API). Next.js 14 + React 18 + Tailwind + vitest+jsdom+@testing-library/react (Web).

**Spec:** `docs/superpowers/specs/2026-05-24-equipment-stats-design.md`

---

## File Map

### Backend (new)
- `apps/api/src/services/equipmentStats.ts` — pure compute function + private aggregation helpers.
- `apps/api/src/routes/equipmentStats.ts` — thin Express route, Zod parse, Decimal serialization.
- `apps/api/src/__tests__/equipmentStats.test.ts` — integration tests (isolated SQLite per dashboard.test.ts pattern).

### Backend (modify)
- `apps/api/src/routes/index.ts` — mount `/api/equipment-stats` with `rolesGuard(["SUPER_ADMIN"])`.

### Frontend (new)
- `apps/web/app/admin/equipment-stats/page.tsx` — Next.js page shell with `useRequireRole` + `<Suspense>`.
- `apps/web/src/components/equipment-stats/EquipmentStatsPage.tsx` — main container.
- `apps/web/src/components/equipment-stats/PeriodToggle.tsx` — segmented control, URL-state.
- `apps/web/src/components/equipment-stats/KpiHero.tsx` — 4 KPI cards row.
- `apps/web/src/components/equipment-stats/TopRankedSection.tsx` — reusable ranked-list block.
- `apps/web/src/components/equipment-stats/MasterTable.tsx` — sortable + filterable table.
- `apps/web/src/components/equipment-stats/useEquipmentStats.ts` — fetch hook.
- `apps/web/src/components/equipment-stats/types.ts` — shared TS types matching API.
- `apps/web/src/components/equipment-stats/__tests__/PeriodToggle.test.tsx`
- `apps/web/src/components/equipment-stats/__tests__/TopRankedSection.test.tsx`
- `apps/web/src/components/equipment-stats/__tests__/MasterTable.test.tsx`
- `docs/mockups/equipment-stats.html` — static design-fidelity reference.

### Frontend (modify)
- `apps/web/src/lib/roleMatrix.ts` — add menu entry under SUPER_ADMIN only.
- `apps/web/src/components/AppShell.tsx` — add `IconChart` and case `"chart":` in icon switch.

---

# Phase 1 — Backend foundation

## Task 1: Scaffold service and route returning an empty response

**Files:**
- Create: `apps/api/src/services/equipmentStats.ts`
- Create: `apps/api/src/routes/equipmentStats.ts`
- Modify: `apps/api/src/routes/index.ts`
- Create: `apps/api/src/__tests__/equipmentStats.test.ts`

- [ ] **Step 1: Write the failing auth tests**

Create `apps/api/src/__tests__/equipmentStats.test.ts`:

```ts
/**
 * Интеграционные тесты /api/equipment-stats
 */

import path from "path";
import { execSync } from "child_process";
import fs from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-equipment-stats.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-1,test-key-2";
process.env.AUTH_MODE = "enforce";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-eqstats";
process.env.WAREHOUSE_SECRET = "test-warehouse-secret-eqstats";
process.env.JWT_SECRET = "test-jwt-secret-eqstats-min16chars";

let app: Express;
let prisma: any;
let superAdminToken: string;
let warehouseToken: string;
let technicianToken: string;

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../.."),
    env: {
      ...process.env,
      DATABASE_URL: `file:${TEST_DB_PATH}`,
      PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes",
    },
    stdio: "pipe",
  });

  const mod = await import("../app");
  app = mod.app;
  const pmod = await import("../prisma");
  prisma = pmod.prisma;

  const { hashPassword, signSession } = await import("../services/auth");
  const hash = await hashPassword("test-pass-123");

  const sa = await prisma.adminUser.create({
    data: { username: "eqstats_sa", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  superAdminToken = signSession({ userId: sa.id, username: sa.username, role: "SUPER_ADMIN" });

  const wh = await prisma.adminUser.create({
    data: { username: "eqstats_wh", passwordHash: hash, role: "WAREHOUSE" },
  });
  warehouseToken = signSession({ userId: wh.id, username: wh.username, role: "WAREHOUSE" });

  const tech = await prisma.adminUser.create({
    data: { username: "eqstats_tech", passwordHash: hash, role: "TECHNICIAN" },
  });
  technicianToken = signSession({ userId: tech.id, username: tech.username, role: "TECHNICIAN" });
});

afterAll(async () => {
  await prisma.$disconnect();
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = TEST_DB_PATH + suffix;
    if (fs.existsSync(f)) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }
});

function AUTH_SA() { return { "X-API-Key": "test-key-1", Authorization: `Bearer ${superAdminToken}` }; }
function AUTH_WH() { return { "X-API-Key": "test-key-1", Authorization: `Bearer ${warehouseToken}` }; }
function AUTH_TECH() { return { "X-API-Key": "test-key-1", Authorization: `Bearer ${technicianToken}` }; }

describe("GET /api/equipment-stats — access control", () => {
  it("returns 403 for TECHNICIAN", async () => {
    const res = await request(app).get("/api/equipment-stats").set(AUTH_TECH());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN_BY_ROLE");
  });

  it("returns 403 for WAREHOUSE", async () => {
    const res = await request(app).get("/api/equipment-stats").set(AUTH_WH());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN_BY_ROLE");
  });

  it("returns 200 with empty arrays and zero KPI when DB is empty", async () => {
    const res = await request(app).get("/api/equipment-stats").set(AUTH_SA());
    expect(res.status).toBe(200);
    expect(res.body.period).toBe("90d");
    expect(res.body.kpi).toMatchObject({
      activeCount: 0,
      dormantCount: 0,
      totalCount: 0,
      revenueRub: "0",
      repairCostRub: "0",
    });
    expect(res.body.demand).toEqual([]);
    expect(res.body.deadStock).toEqual([]);
    expect(res.body.revenue).toEqual([]);
    expect(res.body.quality).toEqual([]);
    expect(res.body.table).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
npm run test -w apps/api -- equipmentStats.test.ts
```

Expected: FAIL — route does not exist yet, 403 or 404 mismatches.

- [ ] **Step 3: Create the service file (empty implementation)**

Create `apps/api/src/services/equipmentStats.ts`:

```ts
import type { PrismaClient } from "@prisma/client";

export type EquipmentStatRow = {
  id: string;
  name: string;
  category: string;
  totalQuantity: number;
  bookingsCount: number;
  qtyShifts: number;
  revenueRub: string;
  revenuePerStorageUnit: string;
  repairCount: number;
  problemCount: number;
  repairCostRub: string;
  lastBookingAt: string | null;
};

export type EquipmentStatsResponse = {
  period: "30d" | "90d" | "365d";
  rangeFrom: string;
  rangeTo: string;
  kpi: {
    activeCount: number;
    dormantCount: number;
    totalCount: number;
    revenueRub: string;
    repairCostRub: string;
  };
  demand: EquipmentStatRow[];
  deadStock: EquipmentStatRow[];
  revenue: EquipmentStatRow[];
  quality: EquipmentStatRow[];
  table: EquipmentStatRow[];
};

export type PeriodDays = 30 | 90 | 365;

function periodLabel(days: PeriodDays): "30d" | "90d" | "365d" {
  return `${days}d` as "30d" | "90d" | "365d";
}

/**
 * Computes equipment analytics over a rolling window.
 *
 * NOTE: Aggregates over both EstimateKind.MAIN and ADDON — both represent
 * realized rental revenue. Custom BookingItem (equipmentId=null) are excluded
 * (catalog-only). Booking status filter: CONFIRMED, ISSUED, RETURNED.
 */
export async function computeEquipmentStats(
  periodDays: PeriodDays,
  prismaClient: PrismaClient,
): Promise<EquipmentStatsResponse> {
  const rangeTo = new Date();
  const rangeFrom = new Date(rangeTo.getTime() - periodDays * 24 * 60 * 60 * 1000);

  // Phase 1 placeholder: return an empty payload. Aggregations are added in later tasks.
  return {
    period: periodLabel(periodDays),
    rangeFrom: rangeFrom.toISOString(),
    rangeTo: rangeTo.toISOString(),
    kpi: {
      activeCount: 0,
      dormantCount: 0,
      totalCount: 0,
      revenueRub: "0",
      repairCostRub: "0",
    },
    demand: [],
    deadStock: [],
    revenue: [],
    quality: [],
    table: [],
  };
}
```

- [ ] **Step 4: Create the route file**

Create `apps/api/src/routes/equipmentStats.ts`:

```ts
import express from "express";
import { z } from "zod";

import { prisma } from "../prisma";
import { computeEquipmentStats, type PeriodDays } from "../services/equipmentStats";

const router = express.Router();

const querySchema = z.object({
  period: z.enum(["30", "90", "365"]).optional(),
});

/**
 * GET /api/equipment-stats?period=30|90|365
 * Returns KPI hero + four ranked sections + master-table dataset.
 * Default period: 90 days. SUPER_ADMIN only (gated at router mount).
 */
router.get("/", async (req, res, next) => {
  try {
    const q = querySchema.parse(req.query);
    const periodDays: PeriodDays = q.period ? (Number(q.period) as PeriodDays) : 90;
    const payload = await computeEquipmentStats(periodDays, prisma);
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

export { router as equipmentStatsRouter };
```

- [ ] **Step 5: Mount the route**

Modify `apps/api/src/routes/index.ts`. Find the line that imports `dashboardRouter` and add an import for `equipmentStatsRouter` next to it. Then mount it next to `/api/dashboard`.

Add import (near other route imports at the top):
```ts
import { equipmentStatsRouter } from "./equipmentStats";
```

Add mount line (after the `/api/dashboard` line at ~line 116):
```ts
// /api/equipment-stats — SUPER_ADMIN only (read-only analytics)
router.use("/api/equipment-stats", rolesGuard(["SUPER_ADMIN"]), equipmentStatsRouter);
```

- [ ] **Step 6: Run the test to verify it passes**

Run:
```bash
npm run test -w apps/api -- equipmentStats.test.ts
```

Expected: all 3 access-control tests PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/equipmentStats.ts \
        apps/api/src/routes/equipmentStats.ts \
        apps/api/src/routes/index.ts \
        apps/api/src/__tests__/equipmentStats.test.ts
git commit -m "feat(equipment-stats): scaffold /api/equipment-stats route + access control"
```

---

## Task 2: Seed scenario + master-table catalog

Adds shared seed helpers that subsequent tasks reuse, plus the first real assertion: every equipment row appears in `table` even when nothing has been rented.

**Files:**
- Modify: `apps/api/src/__tests__/equipmentStats.test.ts`
- Modify: `apps/api/src/services/equipmentStats.ts`

- [ ] **Step 1: Add seed helpers and a failing master-table test**

Append below the existing `describe(...)` block in `equipmentStats.test.ts`:

```ts
// ──────────────────────────────────────────────────────────────────
// Seed helpers reused across multi-task scenarios
// ──────────────────────────────────────────────────────────────────

async function clearScenario() {
  // Delete in FK-safe order
  await prisma.estimateLine.deleteMany();
  await prisma.estimate.deleteMany();
  await prisma.bookingItemUnit.deleteMany();
  await prisma.bookingItem.deleteMany();
  await prisma.expense.deleteMany();
  await prisma.problemItem.deleteMany();
  await prisma.repair.deleteMany();
  await prisma.booking.deleteMany();
  await prisma.equipmentUnit.deleteMany();
  await prisma.equipment.deleteMany();
  await prisma.client.deleteMany();
}

async function makeEquipment(opts: { name: string; category?: string; totalQuantity: number; rate: number }) {
  return prisma.equipment.create({
    data: {
      importKey: `${opts.category ?? "Свет"}||${opts.name.toUpperCase()}||||`,
      name: opts.name,
      category: opts.category ?? "Свет",
      totalQuantity: opts.totalQuantity,
      stockTrackingMode: "COUNT",
      rentalRatePerShift: opts.rate,
    },
  });
}

async function makeClient(name = "Тестовый клиент") {
  return prisma.client.create({ data: { name } });
}

type SeedBookingItem = { equipmentId: string | null; equipmentName?: string; category?: string; quantity: number; unitPrice: number };

async function makeBooking(opts: {
  clientId: string;
  projectName: string;
  status: "DRAFT" | "PENDING_APPROVAL" | "CONFIRMED" | "ISSUED" | "RETURNED" | "CANCELLED";
  startDaysAgo: number;
  endDaysAgo: number;
  items: SeedBookingItem[];
  withEstimate?: boolean; // default true when status not DRAFT
}) {
  const now = Date.now();
  const startDate = new Date(now - opts.startDaysAgo * 24 * 60 * 60 * 1000);
  const endDate = new Date(now - opts.endDaysAgo * 24 * 60 * 60 * 1000);
  const shifts = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000)));
  const subtotal = opts.items.reduce((acc, it) => acc + it.quantity * it.unitPrice * shifts, 0);

  const booking = await prisma.booking.create({
    data: {
      clientId: opts.clientId,
      projectName: opts.projectName,
      startDate,
      endDate,
      status: opts.status,
      finalAmount: subtotal,
      totalEstimateAmount: subtotal,
    },
  });

  for (const item of opts.items) {
    await prisma.bookingItem.create({
      data: {
        bookingId: booking.id,
        equipmentId: item.equipmentId,
        quantity: item.quantity,
        customName: item.equipmentId === null ? (item.equipmentName ?? "Кастомная позиция") : null,
        customCategory: item.equipmentId === null ? (item.category ?? "Свет") : null,
        customUnitPrice: item.equipmentId === null ? item.unitPrice : null,
      },
    });
  }

  const wantEstimate = opts.withEstimate ?? (opts.status !== "DRAFT");
  if (wantEstimate) {
    const est = await prisma.estimate.create({
      data: {
        bookingId: booking.id,
        kind: "MAIN",
        shifts,
        subtotal,
        discountAmount: 0,
        totalAfterDiscount: subtotal,
      },
    });
    for (const item of opts.items) {
      await prisma.estimateLine.create({
        data: {
          estimateId: est.id,
          equipmentId: item.equipmentId,
          categorySnapshot: item.category ?? "Свет",
          nameSnapshot: item.equipmentName ?? "(catalog)",
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          lineSum: item.quantity * item.unitPrice * shifts,
        },
      });
    }
  }
  return booking;
}

// ──────────────────────────────────────────────────────────────────
// Master-table — catalog visibility
// ──────────────────────────────────────────────────────────────────

describe("GET /api/equipment-stats — master table", () => {
  it("lists every catalog equipment row even when nothing is rented", async () => {
    await clearScenario();
    await makeEquipment({ name: "Прожектор Aputure", totalQuantity: 5, rate: 1000 });
    await makeEquipment({ name: "Тренога Manfrotto", totalQuantity: 3, rate: 500 });

    const res = await request(app).get("/api/equipment-stats").set(AUTH_SA());
    expect(res.status).toBe(200);
    expect(res.body.table).toHaveLength(2);
    expect(res.body.table.map((r: any) => r.name).sort()).toEqual(["Прожектор Aputure", "Тренога Manfrotto"]);
    expect(res.body.kpi.totalCount).toBe(2);
    expect(res.body.kpi.dormantCount).toBe(2);
    expect(res.body.kpi.activeCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run test -w apps/api -- equipmentStats.test.ts
```

Expected: the new test FAILS — `table` is still empty and KPI counts are 0.

- [ ] **Step 3: Implement catalog row enumeration in the service**

Replace the placeholder in `computeEquipmentStats` body in `apps/api/src/services/equipmentStats.ts`:

```ts
export async function computeEquipmentStats(
  periodDays: PeriodDays,
  prismaClient: PrismaClient,
): Promise<EquipmentStatsResponse> {
  const rangeTo = new Date();
  const rangeFrom = new Date(rangeTo.getTime() - periodDays * 24 * 60 * 60 * 1000);

  const allEquipment = await prismaClient.equipment.findMany({
    select: { id: true, name: true, category: true, totalQuantity: true },
    orderBy: [{ category: "asc" }, { name: "asc" }],
  });

  const rows: EquipmentStatRow[] = allEquipment.map((e) => ({
    id: e.id,
    name: e.name,
    category: e.category,
    totalQuantity: e.totalQuantity,
    bookingsCount: 0,
    qtyShifts: 0,
    revenueRub: "0",
    revenuePerStorageUnit: "0",
    repairCount: 0,
    problemCount: 0,
    repairCostRub: "0",
    lastBookingAt: null,
  }));

  const activeCount = rows.filter((r) => r.bookingsCount > 0).length;
  const dormantCount = rows.length - activeCount;

  return {
    period: periodLabel(periodDays),
    rangeFrom: rangeFrom.toISOString(),
    rangeTo: rangeTo.toISOString(),
    kpi: {
      activeCount,
      dormantCount,
      totalCount: rows.length,
      revenueRub: "0",
      repairCostRub: "0",
    },
    demand: [],
    deadStock: [],
    revenue: [],
    quality: [],
    table: rows,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm run test -w apps/api -- equipmentStats.test.ts
```

Expected: master-table test PASSES, prior access-control tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/equipmentStats.ts apps/api/src/__tests__/equipmentStats.test.ts
git commit -m "feat(equipment-stats): enumerate catalog rows in master table"
```

---

## Task 3: Demand aggregation (bookingsCount + qtyShifts)

**Files:**
- Modify: `apps/api/src/services/equipmentStats.ts`
- Modify: `apps/api/src/__tests__/equipmentStats.test.ts`

- [ ] **Step 1: Write the failing demand test**

Append to the test file:

```ts
describe("GET /api/equipment-stats — demand", () => {
  it("counts distinct bookings and qty×shifts per equipment in the window", async () => {
    await clearScenario();
    const apu = await makeEquipment({ name: "Прожектор Aputure", totalQuantity: 5, rate: 1000 });
    const man = await makeEquipment({ name: "Тренога Manfrotto", totalQuantity: 3, rate: 500 });
    const client = await makeClient("Клиент A");

    // B1: CONFIRMED, last 10..8 days (2 shifts), apu×2 + man×1
    await makeBooking({
      clientId: client.id,
      projectName: "Проект 1",
      status: "CONFIRMED",
      startDaysAgo: 10,
      endDaysAgo: 8,
      items: [
        { equipmentId: apu.id, equipmentName: apu.name, quantity: 2, unitPrice: 1000 },
        { equipmentId: man.id, equipmentName: man.name, quantity: 1, unitPrice: 500 },
      ],
    });
    // B2: ISSUED, last 5..3 days (2 shifts), apu×1
    await makeBooking({
      clientId: client.id,
      projectName: "Проект 2",
      status: "ISSUED",
      startDaysAgo: 5,
      endDaysAgo: 3,
      items: [{ equipmentId: apu.id, equipmentName: apu.name, quantity: 1, unitPrice: 1000 }],
    });
    // B3: CANCELLED → must be excluded
    await makeBooking({
      clientId: client.id,
      projectName: "Проект 3 (отменён)",
      status: "CANCELLED",
      startDaysAgo: 2,
      endDaysAgo: 1,
      items: [{ equipmentId: apu.id, equipmentName: apu.name, quantity: 9, unitPrice: 1000 }],
    });

    const res = await request(app).get("/api/equipment-stats?period=90").set(AUTH_SA());
    expect(res.status).toBe(200);

    const tableById = new Map<string, any>(res.body.table.map((r: any) => [r.id, r]));
    expect(tableById.get(apu.id).bookingsCount).toBe(2);   // B1 + B2
    expect(tableById.get(apu.id).qtyShifts).toBe(2 * 2 + 1 * 2); // = 6
    expect(tableById.get(man.id).bookingsCount).toBe(1);   // B1
    expect(tableById.get(man.id).qtyShifts).toBe(1 * 2);   // = 2

    expect(res.body.demand).toHaveLength(2);
    expect(res.body.demand[0].id).toBe(apu.id);  // top = Aputure (2 bookings)
    expect(res.body.demand[1].id).toBe(man.id);

    expect(res.body.kpi.activeCount).toBe(2);
    expect(res.body.kpi.dormantCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run test -w apps/api -- equipmentStats.test.ts
```

Expected: demand test FAILS — `bookingsCount` and `qtyShifts` are 0, `demand` array is empty.

- [ ] **Step 3: Implement demand aggregation**

Edit `apps/api/src/services/equipmentStats.ts`. Add a private helper above `computeEquipmentStats`:

```ts
const RENTAL_BOOKING_STATUSES = ["CONFIRMED", "ISSUED", "RETURNED"] as const;

type DemandEntry = { bookingsCount: number; qtyShifts: number };

async function aggregateDemand(
  prismaClient: PrismaClient,
  rangeFrom: Date,
  rangeTo: Date,
): Promise<Map<string, DemandEntry>> {
  // Pull every BookingItem whose Booking falls in the window and has a counted status.
  // We need (equipmentId, quantity, booking.id, estimate.shifts ?? date-fallback).
  const items = await prismaClient.bookingItem.findMany({
    where: {
      equipmentId: { not: null },
      booking: {
        status: { in: [...RENTAL_BOOKING_STATUSES] },
        startDate: { gte: rangeFrom, lte: rangeTo },
      },
    },
    select: {
      bookingId: true,
      equipmentId: true,
      quantity: true,
      booking: {
        select: {
          startDate: true,
          endDate: true,
          estimates: {
            where: { kind: "MAIN" },
            select: { shifts: true },
            orderBy: { createdAt: "desc" },
            take: 1,
          },
        },
      },
    },
  });

  const out = new Map<string, DemandEntry>();
  // Track distinct bookings per equipment (to count each booking once even when item rows duplicate)
  const seen = new Map<string, Set<string>>(); // equipmentId -> Set<bookingId>

  for (const item of items) {
    if (!item.equipmentId) continue;
    const shifts =
      item.booking.estimates[0]?.shifts ??
      Math.max(
        1,
        Math.ceil(
          (item.booking.endDate.getTime() - item.booking.startDate.getTime()) / (24 * 60 * 60 * 1000),
        ),
      );
    const entry = out.get(item.equipmentId) ?? { bookingsCount: 0, qtyShifts: 0 };
    entry.qtyShifts += item.quantity * shifts;

    const seenSet = seen.get(item.equipmentId) ?? new Set<string>();
    if (!seenSet.has(item.bookingId)) {
      seenSet.add(item.bookingId);
      entry.bookingsCount += 1;
      seen.set(item.equipmentId, seenSet);
    }
    out.set(item.equipmentId, entry);
  }
  return out;
}
```

Now wire it into `computeEquipmentStats`. Replace the body so it calls the aggregator, merges the data, builds the `demand` array, and updates KPI:

```ts
export async function computeEquipmentStats(
  periodDays: PeriodDays,
  prismaClient: PrismaClient,
): Promise<EquipmentStatsResponse> {
  const rangeTo = new Date();
  const rangeFrom = new Date(rangeTo.getTime() - periodDays * 24 * 60 * 60 * 1000);

  const [allEquipment, demandMap] = await Promise.all([
    prismaClient.equipment.findMany({
      select: { id: true, name: true, category: true, totalQuantity: true },
      orderBy: [{ category: "asc" }, { name: "asc" }],
    }),
    aggregateDemand(prismaClient, rangeFrom, rangeTo),
  ]);

  const rows: EquipmentStatRow[] = allEquipment.map((e) => {
    const d = demandMap.get(e.id) ?? { bookingsCount: 0, qtyShifts: 0 };
    return {
      id: e.id,
      name: e.name,
      category: e.category,
      totalQuantity: e.totalQuantity,
      bookingsCount: d.bookingsCount,
      qtyShifts: d.qtyShifts,
      revenueRub: "0",
      revenuePerStorageUnit: "0",
      repairCount: 0,
      problemCount: 0,
      repairCostRub: "0",
      lastBookingAt: null,
    };
  });

  const demand = rows
    .filter((r) => r.bookingsCount > 0)
    .sort((a, b) => b.bookingsCount - a.bookingsCount || b.qtyShifts - a.qtyShifts)
    .slice(0, 10);

  const activeCount = rows.filter((r) => r.bookingsCount > 0).length;

  return {
    period: periodLabel(periodDays),
    rangeFrom: rangeFrom.toISOString(),
    rangeTo: rangeTo.toISOString(),
    kpi: {
      activeCount,
      dormantCount: rows.length - activeCount,
      totalCount: rows.length,
      revenueRub: "0",
      repairCostRub: "0",
    },
    demand,
    deadStock: [],
    revenue: [],
    quality: [],
    table: rows,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm run test -w apps/api -- equipmentStats.test.ts
```

Expected: demand test PASSES, prior tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/equipmentStats.ts apps/api/src/__tests__/equipmentStats.test.ts
git commit -m "feat(equipment-stats): aggregate demand (bookings + qty-shifts) per equipment"
```

---

## Task 4: Revenue aggregation (Σ EstimateLine.lineSum) + revenuePerStorageUnit + section

**Files:**
- Modify: `apps/api/src/services/equipmentStats.ts`
- Modify: `apps/api/src/__tests__/equipmentStats.test.ts`

- [ ] **Step 1: Write the failing revenue test**

Append:

```ts
describe("GET /api/equipment-stats — revenue", () => {
  it("sums EstimateLine.lineSum (MAIN + ADDON) per equipment and ranks by revenue per storage unit", async () => {
    await clearScenario();
    const apu = await makeEquipment({ name: "Прожектор Aputure", totalQuantity: 5, rate: 1000 });
    const man = await makeEquipment({ name: "Тренога Manfrotto", totalQuantity: 1, rate: 500 });
    const client = await makeClient("Клиент A");

    // B1: 2 shifts, apu×2 (lineSum=4000), man×1 (lineSum=1000)
    await makeBooking({
      clientId: client.id,
      projectName: "Проект 1",
      status: "CONFIRMED",
      startDaysAgo: 10,
      endDaysAgo: 8,
      items: [
        { equipmentId: apu.id, equipmentName: apu.name, quantity: 2, unitPrice: 1000 },
        { equipmentId: man.id, equipmentName: man.name, quantity: 1, unitPrice: 500 },
      ],
    });

    const res = await request(app).get("/api/equipment-stats?period=90").set(AUTH_SA());
    expect(res.status).toBe(200);

    const tableById = new Map<string, any>(res.body.table.map((r: any) => [r.id, r]));
    expect(tableById.get(apu.id).revenueRub).toBe("4000");
    expect(tableById.get(man.id).revenueRub).toBe("1000");
    // 4000 / 5 = 800 vs 1000 / 1 = 1000 → Manfrotto wins on per-unit-of-storage revenue
    expect(tableById.get(apu.id).revenuePerStorageUnit).toBe("800");
    expect(tableById.get(man.id).revenuePerStorageUnit).toBe("1000");

    expect(res.body.revenue).toHaveLength(2);
    expect(res.body.revenue[0].id).toBe(man.id); // ranked by revenuePerStorageUnit desc
    expect(res.body.revenue[1].id).toBe(apu.id);

    expect(res.body.kpi.revenueRub).toBe("5000");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run test -w apps/api -- equipmentStats.test.ts
```

Expected: revenue test FAILS — fields are still "0".

- [ ] **Step 3: Implement revenue aggregator + wire**

Add to `apps/api/src/services/equipmentStats.ts` above `computeEquipmentStats`:

```ts
import { Decimal } from "@prisma/client/runtime/library";

async function aggregateRevenue(
  prismaClient: PrismaClient,
  rangeFrom: Date,
  rangeTo: Date,
): Promise<Map<string, Decimal>> {
  const lines = await prismaClient.estimateLine.findMany({
    where: {
      equipmentId: { not: null },
      estimate: {
        booking: {
          status: { in: [...RENTAL_BOOKING_STATUSES] },
          startDate: { gte: rangeFrom, lte: rangeTo },
        },
      },
    },
    select: { equipmentId: true, lineSum: true },
  });

  const out = new Map<string, Decimal>();
  for (const line of lines) {
    if (!line.equipmentId) continue;
    const prev = out.get(line.equipmentId) ?? new Decimal(0);
    out.set(line.equipmentId, prev.plus(line.lineSum));
  }
  return out;
}
```

Update `computeEquipmentStats`. Add `aggregateRevenue` to the `Promise.all`, then enrich each row, build `revenue` array, and total KPI:

```ts
  const [allEquipment, demandMap, revenueMap] = await Promise.all([
    prismaClient.equipment.findMany({
      select: { id: true, name: true, category: true, totalQuantity: true },
      orderBy: [{ category: "asc" }, { name: "asc" }],
    }),
    aggregateDemand(prismaClient, rangeFrom, rangeTo),
    aggregateRevenue(prismaClient, rangeFrom, rangeTo),
  ]);

  const rows: EquipmentStatRow[] = allEquipment.map((e) => {
    const d = demandMap.get(e.id) ?? { bookingsCount: 0, qtyShifts: 0 };
    const rev = revenueMap.get(e.id) ?? new Decimal(0);
    const divisor = e.totalQuantity > 0 ? e.totalQuantity : 1;
    const revPerUnit = rev.div(divisor);
    return {
      id: e.id,
      name: e.name,
      category: e.category,
      totalQuantity: e.totalQuantity,
      bookingsCount: d.bookingsCount,
      qtyShifts: d.qtyShifts,
      revenueRub: rev.toString(),
      revenuePerStorageUnit: revPerUnit.toString(),
      repairCount: 0,
      problemCount: 0,
      repairCostRub: "0",
      lastBookingAt: null,
    };
  });

  const demand = rows
    .filter((r) => r.bookingsCount > 0)
    .sort((a, b) => b.bookingsCount - a.bookingsCount || b.qtyShifts - a.qtyShifts)
    .slice(0, 10);

  const revenue = rows
    .filter((r) => new Decimal(r.revenueRub).gt(0))
    .sort((a, b) => {
      const byUnit = new Decimal(b.revenuePerStorageUnit).comparedTo(new Decimal(a.revenuePerStorageUnit));
      if (byUnit !== 0) return byUnit;
      return new Decimal(b.revenueRub).comparedTo(new Decimal(a.revenueRub));
    })
    .slice(0, 10);

  const activeCount = rows.filter((r) => r.bookingsCount > 0).length;
  const totalRevenue = rows.reduce((acc, r) => acc.plus(r.revenueRub), new Decimal(0));

  return {
    period: periodLabel(periodDays),
    rangeFrom: rangeFrom.toISOString(),
    rangeTo: rangeTo.toISOString(),
    kpi: {
      activeCount,
      dormantCount: rows.length - activeCount,
      totalCount: rows.length,
      revenueRub: totalRevenue.toString(),
      repairCostRub: "0",
    },
    demand,
    deadStock: [],
    revenue,
    quality: [],
    table: rows,
  };
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm run test -w apps/api -- equipmentStats.test.ts
```

Expected: revenue test PASSES, all prior tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/equipmentStats.ts apps/api/src/__tests__/equipmentStats.test.ts
git commit -m "feat(equipment-stats): aggregate revenue and revenue-per-storage-unit"
```

---

## Task 5: Repair / problem / repair-cost aggregation + quality section

**Files:**
- Modify: `apps/api/src/services/equipmentStats.ts`
- Modify: `apps/api/src/__tests__/equipmentStats.test.ts`

- [ ] **Step 1: Write the failing quality test**

Append:

```ts
describe("GET /api/equipment-stats — quality", () => {
  it("counts repairs, problem items, and approved repair expenses in the window per equipment", async () => {
    await clearScenario();
    const apu = await makeEquipment({ name: "Прожектор Aputure", totalQuantity: 5, rate: 1000 });
    const sb = await makeEquipment({ name: "Софтбокс 60x90", category: "Свет", totalQuantity: 2, rate: 300 });
    await makeClient("Клиент A");

    const apuUnit = await prisma.equipmentUnit.create({
      data: { equipmentId: apu.id, status: "AVAILABLE", barcode: "LR-APU-001", barcodePayload: "APU001:xx" },
    });
    const sbUnit = await prisma.equipmentUnit.create({
      data: { equipmentId: sb.id, status: "AVAILABLE", barcode: "LR-SB-001", barcodePayload: "SB001:xx" },
    });

    // Repair in window
    const r1 = await prisma.repair.create({
      data: {
        unitId: apuUnit.id,
        status: "IN_REPAIR",
        urgency: "NORMAL",
        reason: "Сгорела лампа",
        createdBy: "tester",
        createdAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      },
    });
    // Repair outside 90-day window (100 days ago)
    await prisma.repair.create({
      data: {
        unitId: apuUnit.id,
        status: "CLOSED",
        urgency: "NORMAL",
        reason: "Старая поломка",
        createdBy: "tester",
        createdAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000),
      },
    });
    // ProblemItem on Софтбокс in window
    await prisma.problemItem.create({
      data: {
        equipmentUnitId: sbUnit.id,
        reason: "LOST",
        comment: "Не вернули",
        status: "SEARCHING",
        createdBy: "tester",
        createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
      },
    });
    // Approved expense linked to r1 in window
    await prisma.expense.create({
      data: {
        category: "REPAIR",
        name: "Запчасть",
        amount: 2000,
        expenseDate: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000),
        linkedRepairId: r1.id,
        approved: true,
      },
    });
    // Expense outside window — must be ignored
    await prisma.expense.create({
      data: {
        category: "REPAIR",
        name: "Старая запчасть",
        amount: 500,
        expenseDate: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000),
        linkedRepairId: r1.id,
        approved: true,
      },
    });

    const res = await request(app).get("/api/equipment-stats?period=90").set(AUTH_SA());
    expect(res.status).toBe(200);

    const tableById = new Map<string, any>(res.body.table.map((r: any) => [r.id, r]));
    expect(tableById.get(apu.id).repairCount).toBe(1);
    expect(tableById.get(apu.id).problemCount).toBe(0);
    expect(tableById.get(apu.id).repairCostRub).toBe("2000");
    expect(tableById.get(sb.id).repairCount).toBe(0);
    expect(tableById.get(sb.id).problemCount).toBe(1);

    expect(res.body.quality).toHaveLength(2);
    // Aputure (1 repair + 0 problems = 1) vs Софтбокс (0 + 1 = 1) → tie; tiebreak by repairCostRub desc → Aputure first
    expect(res.body.quality[0].id).toBe(apu.id);

    expect(res.body.kpi.repairCostRub).toBe("2000");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run test -w apps/api -- equipmentStats.test.ts
```

Expected: quality test FAILS.

- [ ] **Step 3: Implement repair/problem/cost aggregators + wire**

Add to `apps/api/src/services/equipmentStats.ts`:

```ts
type IncidentEntry = { repairCount: number; problemCount: number };

async function aggregateIncidents(
  prismaClient: PrismaClient,
  rangeFrom: Date,
  rangeTo: Date,
): Promise<Map<string, IncidentEntry>> {
  const [repairs, problems] = await Promise.all([
    prismaClient.repair.findMany({
      where: { createdAt: { gte: rangeFrom, lte: rangeTo } },
      select: { unit: { select: { equipmentId: true } } },
    }),
    prismaClient.problemItem.findMany({
      where: { createdAt: { gte: rangeFrom, lte: rangeTo } },
      select: { equipmentUnit: { select: { equipmentId: true } } },
    }),
  ]);

  const out = new Map<string, IncidentEntry>();
  for (const r of repairs) {
    const eid = r.unit.equipmentId;
    if (!eid) continue;
    const e = out.get(eid) ?? { repairCount: 0, problemCount: 0 };
    e.repairCount += 1;
    out.set(eid, e);
  }
  for (const p of problems) {
    const eid = p.equipmentUnit.equipmentId;
    if (!eid) continue;
    const e = out.get(eid) ?? { repairCount: 0, problemCount: 0 };
    e.problemCount += 1;
    out.set(eid, e);
  }
  return out;
}

async function aggregateRepairCosts(
  prismaClient: PrismaClient,
  rangeFrom: Date,
  rangeTo: Date,
): Promise<Map<string, Decimal>> {
  const expenses = await prismaClient.expense.findMany({
    where: {
      approved: true,
      linkedRepairId: { not: null },
      expenseDate: { gte: rangeFrom, lte: rangeTo },
    },
    select: {
      amount: true,
      linkedRepair: { select: { unit: { select: { equipmentId: true } } } },
    },
  });

  const out = new Map<string, Decimal>();
  for (const ex of expenses) {
    const eid = ex.linkedRepair?.unit.equipmentId;
    if (!eid) continue;
    const prev = out.get(eid) ?? new Decimal(0);
    out.set(eid, prev.plus(ex.amount));
  }
  return out;
}
```

Update `computeEquipmentStats` — add both aggregators to `Promise.all`, enrich rows, build `quality`, total `repairCostRub` KPI:

```ts
  const [allEquipment, demandMap, revenueMap, incidentMap, repairCostMap] = await Promise.all([
    prismaClient.equipment.findMany({
      select: { id: true, name: true, category: true, totalQuantity: true },
      orderBy: [{ category: "asc" }, { name: "asc" }],
    }),
    aggregateDemand(prismaClient, rangeFrom, rangeTo),
    aggregateRevenue(prismaClient, rangeFrom, rangeTo),
    aggregateIncidents(prismaClient, rangeFrom, rangeTo),
    aggregateRepairCosts(prismaClient, rangeFrom, rangeTo),
  ]);

  const rows: EquipmentStatRow[] = allEquipment.map((e) => {
    const d = demandMap.get(e.id) ?? { bookingsCount: 0, qtyShifts: 0 };
    const rev = revenueMap.get(e.id) ?? new Decimal(0);
    const inc = incidentMap.get(e.id) ?? { repairCount: 0, problemCount: 0 };
    const cost = repairCostMap.get(e.id) ?? new Decimal(0);
    const divisor = e.totalQuantity > 0 ? e.totalQuantity : 1;
    return {
      id: e.id,
      name: e.name,
      category: e.category,
      totalQuantity: e.totalQuantity,
      bookingsCount: d.bookingsCount,
      qtyShifts: d.qtyShifts,
      revenueRub: rev.toString(),
      revenuePerStorageUnit: rev.div(divisor).toString(),
      repairCount: inc.repairCount,
      problemCount: inc.problemCount,
      repairCostRub: cost.toString(),
      lastBookingAt: null,
    };
  });
```

Add the `quality` section build (after `revenue` build, before the return):

```ts
  const quality = rows
    .filter((r) => r.repairCount + r.problemCount > 0)
    .sort((a, b) => {
      const byIncidents = (b.repairCount + b.problemCount) - (a.repairCount + a.problemCount);
      if (byIncidents !== 0) return byIncidents;
      return new Decimal(b.repairCostRub).comparedTo(new Decimal(a.repairCostRub));
    })
    .slice(0, 10);

  const totalRepairCost = rows.reduce((acc, r) => acc.plus(r.repairCostRub), new Decimal(0));
```

And update the returned `kpi.repairCostRub` and `quality`:

```ts
    kpi: {
      activeCount,
      dormantCount: rows.length - activeCount,
      totalCount: rows.length,
      revenueRub: totalRevenue.toString(),
      repairCostRub: totalRepairCost.toString(),
    },
    demand,
    deadStock: [],
    revenue,
    quality,
    table: rows,
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm run test -w apps/api -- equipmentStats.test.ts
```

Expected: quality test PASSES, all prior tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/equipmentStats.ts apps/api/src/__tests__/equipmentStats.test.ts
git commit -m "feat(equipment-stats): aggregate repairs, problems and repair costs"
```

---

## Task 6: lastBookingAt + dead stock section ordering

**Files:**
- Modify: `apps/api/src/services/equipmentStats.ts`
- Modify: `apps/api/src/__tests__/equipmentStats.test.ts`

- [ ] **Step 1: Write the failing dead-stock test**

Append:

```ts
describe("GET /api/equipment-stats — dead stock", () => {
  it("lists never-rented equipment first, then by lastBookingAt asc", async () => {
    await clearScenario();
    const neverRented = await makeEquipment({ name: "Старый блин", totalQuantity: 1, rate: 200 });
    const oldRental = await makeEquipment({ name: "Тренога Manfrotto", totalQuantity: 3, rate: 500 });
    const recentRental = await makeEquipment({ name: "Прожектор Aputure", totalQuantity: 5, rate: 1000 });
    const client = await makeClient("Клиент A");

    // recentRental: booking 5 days ago → in 30d window AND in 90d window
    await makeBooking({
      clientId: client.id,
      projectName: "Свежий",
      status: "RETURNED",
      startDaysAgo: 5,
      endDaysAgo: 3,
      items: [{ equipmentId: recentRental.id, equipmentName: recentRental.name, quantity: 1, unitPrice: 1000 }],
    });
    // oldRental: booking 50 days ago → NOT in 30d window but in 90d window
    await makeBooking({
      clientId: client.id,
      projectName: "Старый",
      status: "RETURNED",
      startDaysAgo: 50,
      endDaysAgo: 48,
      items: [{ equipmentId: oldRental.id, equipmentName: oldRental.name, quantity: 2, unitPrice: 500 }],
    });

    // period=30 → both oldRental and neverRented appear in deadStock (neverRented first)
    const res30 = await request(app).get("/api/equipment-stats?period=30").set(AUTH_SA());
    expect(res30.status).toBe(200);
    const dead30Ids = res30.body.deadStock.map((r: any) => r.id);
    expect(dead30Ids[0]).toBe(neverRented.id); // null lastBookingAt sorts first
    expect(dead30Ids).toContain(oldRental.id);
    expect(dead30Ids).not.toContain(recentRental.id);

    // The neverRented row has lastBookingAt = null; oldRental has a real date
    const neverRow = res30.body.deadStock.find((r: any) => r.id === neverRented.id);
    const oldRow = res30.body.deadStock.find((r: any) => r.id === oldRental.id);
    expect(neverRow.lastBookingAt).toBe(null);
    expect(oldRow.lastBookingAt).not.toBe(null);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run test -w apps/api -- equipmentStats.test.ts
```

Expected: dead-stock test FAILS — `deadStock` is empty, `lastBookingAt` always null.

- [ ] **Step 3: Implement lastBookingAt aggregator + dead stock build**

Add to `apps/api/src/services/equipmentStats.ts`:

```ts
async function getLastBookingMap(prismaClient: PrismaClient): Promise<Map<string, Date>> {
  // All-time (not limited to the window) — used to label dead stock.
  const items = await prismaClient.bookingItem.findMany({
    where: {
      equipmentId: { not: null },
      booking: { status: { in: [...RENTAL_BOOKING_STATUSES] } },
    },
    select: {
      equipmentId: true,
      booking: { select: { startDate: true } },
    },
  });
  const out = new Map<string, Date>();
  for (const it of items) {
    if (!it.equipmentId) continue;
    const prev = out.get(it.equipmentId);
    if (!prev || it.booking.startDate.getTime() > prev.getTime()) {
      out.set(it.equipmentId, it.booking.startDate);
    }
  }
  return out;
}
```

Add to the `Promise.all`:

```ts
  const [allEquipment, demandMap, revenueMap, incidentMap, repairCostMap, lastBookingMap] = await Promise.all([
    prismaClient.equipment.findMany({
      select: { id: true, name: true, category: true, totalQuantity: true },
      orderBy: [{ category: "asc" }, { name: "asc" }],
    }),
    aggregateDemand(prismaClient, rangeFrom, rangeTo),
    aggregateRevenue(prismaClient, rangeFrom, rangeTo),
    aggregateIncidents(prismaClient, rangeFrom, rangeTo),
    aggregateRepairCosts(prismaClient, rangeFrom, rangeTo),
    getLastBookingMap(prismaClient),
  ]);
```

Update the row-mapping to populate `lastBookingAt`:

```ts
      lastBookingAt: lastBookingMap.get(e.id)?.toISOString() ?? null,
```

Add the `deadStock` build (after `quality`, before the return):

```ts
  const deadStock = rows
    .filter((r) => r.bookingsCount === 0)
    .sort((a, b) => {
      // never-rented (null lastBookingAt) first, then oldest lastBookingAt first
      if (a.lastBookingAt === null && b.lastBookingAt === null) return 0;
      if (a.lastBookingAt === null) return -1;
      if (b.lastBookingAt === null) return 1;
      return a.lastBookingAt.localeCompare(b.lastBookingAt);
    })
    .slice(0, 10);
```

And include it in the return:

```ts
    demand,
    deadStock,
    revenue,
    quality,
    table: rows,
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm run test -w apps/api -- equipmentStats.test.ts
```

Expected: dead-stock test PASSES, all prior tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/equipmentStats.ts apps/api/src/__tests__/equipmentStats.test.ts
git commit -m "feat(equipment-stats): compute lastBookingAt + dead-stock ordering"
```

---

## Task 7: Edge cases — custom items, period boundary, invalid period

**Files:**
- Modify: `apps/api/src/__tests__/equipmentStats.test.ts`

The service should already handle these (`equipmentId: { not: null }` filters in every aggregator, period math, Zod enum). We add explicit tests to lock the behaviour.

- [ ] **Step 1: Write the failing edge-case tests**

Append:

```ts
describe("GET /api/equipment-stats — edge cases", () => {
  it("excludes custom BookingItem (equipmentId=null) from every aggregate", async () => {
    await clearScenario();
    const apu = await makeEquipment({ name: "Прожектор Aputure", totalQuantity: 5, rate: 1000 });
    const client = await makeClient("Клиент A");

    // Booking with one catalog item + one custom item
    await makeBooking({
      clientId: client.id,
      projectName: "Микс",
      status: "CONFIRMED",
      startDaysAgo: 10,
      endDaysAgo: 8,
      items: [
        { equipmentId: apu.id, equipmentName: apu.name, quantity: 1, unitPrice: 1000 },
        { equipmentId: null, equipmentName: "Самопальная штука", category: "Свет", quantity: 3, unitPrice: 999 },
      ],
    });

    const res = await request(app).get("/api/equipment-stats?period=90").set(AUTH_SA());
    expect(res.status).toBe(200);
    expect(res.body.table).toHaveLength(1); // only the catalog row
    expect(res.body.table[0].id).toBe(apu.id);
    expect(res.body.table[0].revenueRub).toBe("2000"); // 1 × 1000 × 2 shifts, custom line excluded
    expect(res.body.kpi.revenueRub).toBe("2000");
  });

  it("excludes bookings whose startDate is older than the requested window", async () => {
    await clearScenario();
    const apu = await makeEquipment({ name: "Прожектор Aputure", totalQuantity: 5, rate: 1000 });
    const client = await makeClient("Клиент A");
    // booking 50 days ago — inside 90d, outside 30d
    await makeBooking({
      clientId: client.id,
      projectName: "Полтора месяца назад",
      status: "RETURNED",
      startDaysAgo: 50,
      endDaysAgo: 48,
      items: [{ equipmentId: apu.id, equipmentName: apu.name, quantity: 1, unitPrice: 1000 }],
    });

    const res30 = await request(app).get("/api/equipment-stats?period=30").set(AUTH_SA());
    const res90 = await request(app).get("/api/equipment-stats?period=90").set(AUTH_SA());
    const apu30 = res30.body.table.find((r: any) => r.id === apu.id);
    const apu90 = res90.body.table.find((r: any) => r.id === apu.id);
    expect(apu30.bookingsCount).toBe(0);
    expect(apu90.bookingsCount).toBe(1);
  });

  it("rejects invalid period value with 400", async () => {
    const res = await request(app).get("/api/equipment-stats?period=abc").set(AUTH_SA());
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run the tests to verify they pass**

```bash
npm run test -w apps/api -- equipmentStats.test.ts
```

Expected: all three new tests PASS on the first run (service already implements the behaviour). If any fail, fix the service before continuing.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/equipmentStats.test.ts
git commit -m "test(equipment-stats): lock down custom-item, period-boundary, invalid-period behaviour"
```

---

# Phase 2 — Frontend

## Task 8: Static HTML mockup for design fidelity

Per project convention (see existing `docs/mockups/warehouse-scan/`), build the mockup first so screenshots have a reference.

**Files:**
- Create: `docs/mockups/equipment-stats.html`

- [ ] **Step 1: Write the mockup**

Create `docs/mockups/equipment-stats.html`:

```html
<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Статистика техники — мокап</title>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@500&display=swap" rel="stylesheet">
<style>
  :root {
    --ink:#0F1115; --ink-2:#3A3E47; --ink-3:#6B7180;
    --surface:#FFFFFF; --surface-2:#F6F7F9;
    --border:#E5E7EB; --border-strong:#CBD0D8;
    --accent:#1F4FFF; --accent-bright:#1538D6;
    --rose:#B8344C; --rose-soft:#FCE7EA; --rose-border:#F6BFC9;
    --amber:#9A6B17; --amber-soft:#FBF3E1;
    --emerald:#0B6B45; --emerald-soft:#DBF1E6;
    --teal:#0E7490; --teal-soft:#DBF1F3;
    --indigo:#3730A3; --indigo-soft:#E0E1FA;
  }
  *{box-sizing:border-box}
  body{font-family:"IBM Plex Sans",system-ui,sans-serif;color:var(--ink);background:var(--surface-2);margin:0;padding:32px 24px;line-height:1.4}
  .page{max-width:1200px;margin:0 auto}
  .eyebrow{font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:var(--ink-3);margin-bottom:6px}
  .h1{font-size:28px;font-weight:600;margin:0 0 4px}
  .h2{font-size:18px;font-weight:600;margin:0}
  .mono{font-family:"IBM Plex Mono",monospace;font-weight:500}
  .header{display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:32px;gap:16px;flex-wrap:wrap}
  .period{display:inline-flex;background:var(--surface);border:1px solid var(--border);border-radius:999px;padding:4px}
  .period button{font-family:inherit;font-size:13px;font-weight:500;padding:6px 14px;border:none;background:transparent;border-radius:999px;cursor:pointer;color:var(--ink-3)}
  .period button.active{background:var(--accent);color:white}
  .kpi-row{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:32px}
  .kpi{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px}
  .kpi .lbl{font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:var(--ink-3);margin-bottom:8px}
  .kpi .val{font-size:26px;font-weight:600;font-family:"IBM Plex Mono",monospace}
  .kpi .sub{font-size:12px;color:var(--ink-3);margin-top:2px}
  .kpi .sub.rose{color:var(--rose)}
  .section{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:18px 18px 6px;margin-bottom:16px}
  .section-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
  .section-head .title{display:flex;gap:10px;align-items:center}
  .section-head .icon{font-size:18px}
  .section-head a{font-size:12px;color:var(--accent);text-decoration:none;font-weight:500}
  .row{display:grid;grid-template-columns:1fr auto auto;gap:12px;padding:10px 0;border-top:1px solid var(--border);font-size:14px;align-items:center}
  .row:first-of-type{border-top:none}
  .row .meta{font-size:12px;color:var(--ink-3)}
  .row .num{font-family:"IBM Plex Mono",monospace;font-weight:500;text-align:right}
  .row .trail{font-family:"IBM Plex Mono",monospace;font-size:12px;color:var(--ink-3);text-align:right}
  table.master{width:100%;border-collapse:collapse;font-size:13px;background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden}
  table.master th, table.master td{padding:10px 12px;border-bottom:1px solid var(--border);text-align:left}
  table.master th{background:var(--surface-2);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--ink-3);cursor:pointer}
  table.master td.num{font-family:"IBM Plex Mono",monospace;text-align:right}
  table.master tr:hover td{background:var(--surface-2)}
  .chips{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap}
  .chip{font-size:12px;background:var(--surface);border:1px solid var(--border);padding:5px 12px;border-radius:999px;cursor:pointer}
  .chip.active{background:var(--accent);color:white;border-color:var(--accent)}
  @media (max-width:760px){
    .kpi-row{grid-template-columns:repeat(2,1fr)}
    .row{grid-template-columns:1fr auto}
    .row .trail{grid-column:1/-1;text-align:left;padding-top:2px}
  }
</style>
</head>
<body>
<div class="page">
  <div class="header">
    <div>
      <div class="eyebrow">Аналитика</div>
      <h1 class="h1">Статистика техники</h1>
    </div>
    <div class="period">
      <button>30 дней</button>
      <button class="active">90 дней</button>
      <button>Год</button>
    </div>
  </div>

  <div class="kpi-row">
    <div class="kpi"><div class="lbl">Активных позиций</div><div class="val">234 / 567</div><div class="sub">за 90 дней</div></div>
    <div class="kpi"><div class="lbl">Мёртвый груз</div><div class="val">198</div><div class="sub rose">позиций без аренды</div></div>
    <div class="kpi"><div class="lbl">Выручка за период</div><div class="val">1 248 ₽</div><div class="sub">тысяч</div></div>
    <div class="kpi"><div class="lbl">Расход на ремонт</div><div class="val">87 ₽</div><div class="sub">тысяч</div></div>
  </div>

  <div class="section">
    <div class="section-head"><div class="title"><span class="icon">🔥</span><h2 class="h2">Чаще всего берут</h2></div><a href="#">Все позиции →</a></div>
    <div class="row"><div><div>Прожектор Aputure LS 600d</div><div class="meta">Свет</div></div><div class="num">17 броней · 88 ед.-смен</div><div class="trail">312 000 ₽</div></div>
    <div class="row"><div><div>Софтбокс 60×90</div><div class="meta">Свет</div></div><div class="num">14 броней · 56 ед.-смен</div><div class="trail">94 000 ₽</div></div>
    <div class="row"><div><div>Тренога Manfrotto 1041BAC</div><div class="meta">Опоры</div></div><div class="num">12 броней · 40 ед.-смен</div><div class="trail">52 000 ₽</div></div>
  </div>

  <div class="section">
    <div class="section-head"><div class="title"><span class="icon">💤</span><h2 class="h2">Мёртвый груз</h2></div><a href="#">Все позиции →</a></div>
    <div class="row"><div><div>Старый светофильтр 3200K</div><div class="meta">Свет · 6 шт. на складе</div></div><div class="num">никогда не брали</div><div class="trail"></div></div>
    <div class="row"><div><div>Кабель XLR 50 м</div><div class="meta">Звук · 2 шт.</div></div><div class="num">не брали с 12 ноября 2025</div><div class="trail"></div></div>
  </div>

  <div class="section">
    <div class="section-head"><div class="title"><span class="icon">💰</span><h2 class="h2">Лучшая доходность на единицу склада</h2></div><a href="#">Все позиции →</a></div>
    <div class="row"><div><div>Aputure LS 1200d Pro</div><div class="meta">Свет · 2 шт.</div></div><div class="num">152 000 ₽/ед</div><div class="trail">304 000 ₽</div></div>
    <div class="row"><div><div>Шторки Aputure</div><div class="meta">Свет · 3 шт.</div></div><div class="num">38 000 ₽/ед</div><div class="trail">114 000 ₽</div></div>
  </div>

  <div class="section">
    <div class="section-head"><div class="title"><span class="icon">🔧</span><h2 class="h2">Проблемные позиции</h2></div><a href="#">Все позиции →</a></div>
    <div class="row"><div><div>Aputure LS 300x</div><div class="meta">Свет</div></div><div class="num">3 ремонта · 0 потерь</div><div class="trail">24 000 ₽ на ремонт</div></div>
    <div class="row"><div><div>Радиосистема Sennheiser</div><div class="meta">Звук</div></div><div class="num">1 ремонт · 2 потери</div><div class="trail">8 500 ₽</div></div>
  </div>

  <div style="height:8px"></div>
  <div class="eyebrow">Все позиции</div>

  <div class="chips"><span class="chip active">Все</span><span class="chip">Без аренды</span><span class="chip">С поломками</span></div>

  <table class="master">
    <thead><tr><th>Позиция</th><th>Категория</th><th>Σ кол-во</th><th>Броней</th><th>Ед.-смен</th><th>Выручка ₽</th><th>₽/ед склада</th><th>Ремонтов</th><th>Потерь</th></tr></thead>
    <tbody>
      <tr><td>Aputure LS 600d</td><td>Свет</td><td class="num">5</td><td class="num">17</td><td class="num">88</td><td class="num">312 000</td><td class="num">62 400</td><td class="num">1</td><td class="num">0</td></tr>
      <tr><td>Aputure LS 1200d Pro</td><td>Свет</td><td class="num">2</td><td class="num">8</td><td class="num">22</td><td class="num">304 000</td><td class="num">152 000</td><td class="num">0</td><td class="num">0</td></tr>
      <tr><td>Софтбокс 60×90</td><td>Свет</td><td class="num">4</td><td class="num">14</td><td class="num">56</td><td class="num">94 000</td><td class="num">23 500</td><td class="num">0</td><td class="num">1</td></tr>
    </tbody>
  </table>
</div>
</body>
</html>
```

- [ ] **Step 2: Open the mockup in a browser and sanity-check**

```bash
open docs/mockups/equipment-stats.html
```

Expected: layout renders without horizontal scrollbar, KPI row collapses to 2×2 at narrow widths, sections look like a single page.

- [ ] **Step 3: Commit**

```bash
git add docs/mockups/equipment-stats.html
git commit -m "docs: static mockup for equipment-stats page"
```

---

## Task 9: Add `IconChart` icon and roleMatrix entry

**Files:**
- Modify: `apps/web/src/components/AppShell.tsx`
- Modify: `apps/web/src/lib/roleMatrix.ts`

- [ ] **Step 1: Add the icon function**

Edit `apps/web/src/components/AppShell.tsx`. Add this function next to `IconCalc` (around line 58):

```tsx
function IconChart() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
    </svg>
  );
}
```

Then in the icon switch (around line 214), add a new case before the closing `}`:

```tsx
    case "chart":    return <IconChart />;
```

- [ ] **Step 2: Add the menu entry**

Edit `apps/web/src/lib/roleMatrix.ts`. In the `SUPER_ADMIN` array, change the «Финансы» section to add a new section AFTER it (before «Настройки»):

```ts
    {
      title: "Аналитика",
      items: [
        { href: "/admin/equipment-stats", label: "Статистика техники", icon: "chart" },
      ],
    },
```

Do NOT add this section to WAREHOUSE or TECHNICIAN.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/AppShell.tsx apps/web/src/lib/roleMatrix.ts
git commit -m "feat(nav): add Аналитика section with /admin/equipment-stats for SUPER_ADMIN"
```

---

## Task 10: Shared TypeScript types

**Files:**
- Create: `apps/web/src/components/equipment-stats/types.ts`

- [ ] **Step 1: Write the types file**

Create `apps/web/src/components/equipment-stats/types.ts`:

```ts
export type EquipmentStatRow = {
  id: string;
  name: string;
  category: string;
  totalQuantity: number;
  bookingsCount: number;
  qtyShifts: number;
  revenueRub: string;
  revenuePerStorageUnit: string;
  repairCount: number;
  problemCount: number;
  repairCostRub: string;
  lastBookingAt: string | null;
};

export type EquipmentStatsResponse = {
  period: "30d" | "90d" | "365d";
  rangeFrom: string;
  rangeTo: string;
  kpi: {
    activeCount: number;
    dormantCount: number;
    totalCount: number;
    revenueRub: string;
    repairCostRub: string;
  };
  demand: EquipmentStatRow[];
  deadStock: EquipmentStatRow[];
  revenue: EquipmentStatRow[];
  quality: EquipmentStatRow[];
  table: EquipmentStatRow[];
};

export type PeriodValue = "30" | "90" | "365";

export const PERIOD_OPTIONS: { value: PeriodValue; label: string }[] = [
  { value: "30", label: "30 дней" },
  { value: "90", label: "90 дней" },
  { value: "365", label: "Год" },
];
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/equipment-stats/types.ts
git commit -m "feat(equipment-stats): shared types for response shape"
```

---

## Task 11: PeriodToggle component (TDD)

**Files:**
- Create: `apps/web/src/components/equipment-stats/PeriodToggle.tsx`
- Create: `apps/web/src/components/equipment-stats/__tests__/PeriodToggle.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/equipment-stats/__tests__/PeriodToggle.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PeriodToggle } from "../PeriodToggle";

const replaceMock = vi.fn();
const searchParamsMock = { get: vi.fn() };

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
  usePathname: () => "/admin/equipment-stats",
  useSearchParams: () => searchParamsMock,
}));

describe("PeriodToggle", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    searchParamsMock.get.mockReset();
  });

  it("defaults active pill to 90 when no period param is set", () => {
    searchParamsMock.get.mockReturnValue(null);
    render(<PeriodToggle />);
    const active = screen.getByRole("button", { name: "90 дней" });
    expect(active.getAttribute("aria-pressed")).toBe("true");
  });

  it("marks active pill based on ?period= query value", () => {
    searchParamsMock.get.mockReturnValue("30");
    render(<PeriodToggle />);
    expect(screen.getByRole("button", { name: "30 дней" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "90 дней" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("calls router.replace with the new period when a pill is clicked", () => {
    searchParamsMock.get.mockReturnValue("90");
    render(<PeriodToggle />);
    fireEvent.click(screen.getByRole("button", { name: "Год" }));
    expect(replaceMock).toHaveBeenCalledTimes(1);
    expect(replaceMock.mock.calls[0][0]).toContain("period=365");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm --workspace=apps/web run test -- PeriodToggle
```

Expected: FAIL — component does not exist.

- [ ] **Step 3: Implement the component**

Create `apps/web/src/components/equipment-stats/PeriodToggle.tsx`:

```tsx
"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { PERIOD_OPTIONS, type PeriodValue } from "./types";

export function PeriodToggle() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const raw = searchParams.get("period");
  const active: PeriodValue =
    raw === "30" || raw === "365" ? raw : "90";

  function setPeriod(value: PeriodValue) {
    const next = new URLSearchParams(searchParams.toString());
    next.set("period", value);
    router.replace(`${pathname}?${next.toString()}`);
  }

  return (
    <div className="inline-flex items-center bg-surface border border-border rounded-full p-1">
      {PERIOD_OPTIONS.map((opt) => {
        const isActive = opt.value === active;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={isActive}
            onClick={() => setPeriod(opt.value)}
            className={
              "text-sm font-medium px-3.5 py-1.5 rounded-full transition-colors " +
              (isActive
                ? "bg-accent text-white"
                : "text-ink-3 hover:text-ink")
            }
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm --workspace=apps/web run test -- PeriodToggle
```

Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/equipment-stats/PeriodToggle.tsx apps/web/src/components/equipment-stats/__tests__/PeriodToggle.test.tsx
git commit -m "feat(equipment-stats): PeriodToggle component with URL-state"
```

---

## Task 12: KpiHero component

**Files:**
- Create: `apps/web/src/components/equipment-stats/KpiHero.tsx`

- [ ] **Step 1: Implement the component**

Create `apps/web/src/components/equipment-stats/KpiHero.tsx`:

```tsx
import { DayKpiCard } from "../day/DayKpiCard";
import { formatRub } from "../../lib/format";
import { pluralize } from "../../lib/format";
import type { EquipmentStatsResponse } from "./types";

interface KpiHeroProps {
  kpi: EquipmentStatsResponse["kpi"];
  periodLabel: string;
}

export function KpiHero({ kpi, periodLabel }: KpiHeroProps) {
  const dormantShare = kpi.totalCount > 0 ? kpi.dormantCount / kpi.totalCount : 0;
  return (
    <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 mb-8">
      <DayKpiCard
        eyebrow="Активных позиций"
        value={
          <span className="mono-num">
            {kpi.activeCount} <span className="text-ink-3 text-base">/ {kpi.totalCount}</span>
          </span>
        }
        sub={periodLabel}
      />
      <DayKpiCard
        eyebrow="Мёртвый груз"
        value={<span className="mono-num">{kpi.dormantCount}</span>}
        sub={`${pluralize(kpi.dormantCount, "позиция", "позиции", "позиций")} без аренды`}
        subTone={dormantShare > 0.3 ? "rose" : "muted"}
      />
      <DayKpiCard
        eyebrow="Выручка"
        value={<span className="mono-num">{formatRub(kpi.revenueRub)}</span>}
        sub={periodLabel}
      />
      <DayKpiCard
        eyebrow="Расход на ремонт"
        value={<span className="mono-num">{formatRub(kpi.repairCostRub)}</span>}
        sub="linked-расходы"
      />
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/equipment-stats/KpiHero.tsx
git commit -m "feat(equipment-stats): KpiHero with 4 cards reusing DayKpiCard"
```

---

## Task 13: TopRankedSection component (TDD)

**Files:**
- Create: `apps/web/src/components/equipment-stats/TopRankedSection.tsx`
- Create: `apps/web/src/components/equipment-stats/__tests__/TopRankedSection.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/equipment-stats/__tests__/TopRankedSection.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TopRankedSection } from "../TopRankedSection";
import type { EquipmentStatRow } from "../types";

function row(overrides: Partial<EquipmentStatRow>): EquipmentStatRow {
  return {
    id: "id-1",
    name: "Прожектор Aputure",
    category: "Свет",
    totalQuantity: 5,
    bookingsCount: 0,
    qtyShifts: 0,
    revenueRub: "0",
    revenuePerStorageUnit: "0",
    repairCount: 0,
    problemCount: 0,
    repairCostRub: "0",
    lastBookingAt: null,
    ...overrides,
  };
}

describe("TopRankedSection", () => {
  it("renders given rows with title", () => {
    const rows = [row({ id: "a", name: "Aputure", bookingsCount: 17, qtyShifts: 88 }),
                  row({ id: "b", name: "Manfrotto", bookingsCount: 12, qtyShifts: 40 })];
    render(
      <TopRankedSection
        icon="🔥"
        title="Чаще всего берут"
        rows={rows}
        rowKey="demand"
      />,
    );
    expect(screen.getByText("Чаще всего берут")).toBeInTheDocument();
    expect(screen.getByText("Aputure")).toBeInTheDocument();
    expect(screen.getByText("Manfrotto")).toBeInTheDocument();
  });

  it("renders an empty-state message when rows are empty", () => {
    render(
      <TopRankedSection
        icon="💤"
        title="Мёртвый груз"
        rows={[]}
        rowKey="deadStock"
        emptyText="Все позиции в работе — мёртвого груза нет 🎉"
      />,
    );
    expect(screen.getByText(/мёртвого груза нет/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm --workspace=apps/web run test -- TopRankedSection
```

Expected: FAIL — component does not exist.

- [ ] **Step 3: Implement the component**

Create `apps/web/src/components/equipment-stats/TopRankedSection.tsx`:

```tsx
import Link from "next/link";
import { formatRub, pluralize } from "../../lib/format";
import type { EquipmentStatRow } from "./types";

type RowKey = "demand" | "deadStock" | "revenue" | "quality";

interface TopRankedSectionProps {
  icon: string;
  title: string;
  rows: EquipmentStatRow[];
  rowKey: RowKey;
  allLink?: string;
  emptyText?: string;
}

function formatLastBooking(iso: string | null): string {
  if (!iso) return "никогда не брали";
  const d = new Date(iso);
  const fmt = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", year: "numeric" });
  return `не брали с ${fmt.format(d)}`;
}

function renderPrimary(row: EquipmentStatRow, key: RowKey): string {
  if (key === "demand") {
    return `${row.bookingsCount} ${pluralize(row.bookingsCount, "бронь", "брони", "броней")} · ${row.qtyShifts} ед.-смен`;
  }
  if (key === "deadStock") {
    return formatLastBooking(row.lastBookingAt);
  }
  if (key === "revenue") {
    return `${formatRub(row.revenuePerStorageUnit)}/ед · ${row.totalQuantity} шт.`;
  }
  // quality
  const incidents = row.repairCount + row.problemCount;
  return `${row.repairCount} ${pluralize(row.repairCount, "ремонт", "ремонта", "ремонтов")} · ${row.problemCount} ${pluralize(row.problemCount, "потеря", "потери", "потерь")}`;
}

function renderTrail(row: EquipmentStatRow, key: RowKey): string | null {
  if (key === "demand" || key === "revenue") return formatRub(row.revenueRub);
  if (key === "quality") return Number(row.repairCostRub) > 0 ? `${formatRub(row.repairCostRub)} на ремонт` : null;
  return null;
}

export function TopRankedSection({ icon, title, rows, rowKey, allLink, emptyText }: TopRankedSectionProps) {
  return (
    <section className="bg-surface border border-border rounded-xl p-5 mb-4">
      <header className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <span aria-hidden className="text-lg">{icon}</span>
          <h2 className="text-base font-semibold m-0">{title}</h2>
        </div>
        {allLink ? (
          <Link href={allLink} className="text-xs text-accent font-medium hover:underline">Все позиции →</Link>
        ) : null}
      </header>
      {rows.length === 0 ? (
        <div className="text-sm text-ink-3 py-6 text-center">{emptyText ?? "Нет данных за период"}</div>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((r) => {
            const trail = renderTrail(r, rowKey);
            return (
              <li key={r.id} className="grid grid-cols-[1fr_auto_auto] gap-3 items-center py-2.5">
                <Link href={`/equipment/${r.id}`} className="text-sm text-ink hover:text-accent">
                  <div>{r.name}</div>
                  <div className="text-xs text-ink-3">{r.category}</div>
                </Link>
                <div className="text-sm font-mono text-right">{renderPrimary(r, rowKey)}</div>
                <div className="text-xs font-mono text-ink-3 text-right min-w-[6rem]">{trail ?? ""}</div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm --workspace=apps/web run test -- TopRankedSection
```

Expected: both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/equipment-stats/TopRankedSection.tsx apps/web/src/components/equipment-stats/__tests__/TopRankedSection.test.tsx
git commit -m "feat(equipment-stats): TopRankedSection with empty-state and per-section formatters"
```

---

## Task 14: MasterTable component (TDD)

**Files:**
- Create: `apps/web/src/components/equipment-stats/MasterTable.tsx`
- Create: `apps/web/src/components/equipment-stats/__tests__/MasterTable.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/equipment-stats/__tests__/MasterTable.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { MasterTable } from "../MasterTable";
import type { EquipmentStatRow } from "../types";

function row(overrides: Partial<EquipmentStatRow>): EquipmentStatRow {
  return {
    id: "id-1",
    name: "Прожектор",
    category: "Свет",
    totalQuantity: 5,
    bookingsCount: 0,
    qtyShifts: 0,
    revenueRub: "0",
    revenuePerStorageUnit: "0",
    repairCount: 0,
    problemCount: 0,
    repairCostRub: "0",
    lastBookingAt: null,
    ...overrides,
  };
}

const rows: EquipmentStatRow[] = [
  row({ id: "a", name: "Aputure", category: "Свет", bookingsCount: 5, revenueRub: "10000" }),
  row({ id: "b", name: "Manfrotto", category: "Опоры", bookingsCount: 0, revenueRub: "0", repairCount: 2 }),
  row({ id: "c", name: "Софтбокс", category: "Свет", bookingsCount: 3, revenueRub: "5000" }),
];

describe("MasterTable", () => {
  it("renders all rows by default sorted alphabetically", () => {
    render(<MasterTable rows={rows} />);
    const dataRows = screen.getAllByRole("row").slice(1); // skip header
    const names = dataRows.map((r) => within(r).getAllByRole("cell")[0].textContent);
    expect(names).toEqual(["Aputure", "Manfrotto", "Софтбокс"]);
  });

  it("filters to rows with bookingsCount = 0 when 'Без аренды' chip is active", () => {
    render(<MasterTable rows={rows} />);
    fireEvent.click(screen.getByRole("button", { name: "Без аренды" }));
    const dataRows = screen.getAllByRole("row").slice(1);
    expect(dataRows).toHaveLength(1);
    expect(within(dataRows[0]).getAllByRole("cell")[0].textContent).toBe("Manfrotto");
  });

  it("filters to rows with incidents when 'С поломками' chip is active", () => {
    render(<MasterTable rows={rows} />);
    fireEvent.click(screen.getByRole("button", { name: "С поломками" }));
    const dataRows = screen.getAllByRole("row").slice(1);
    expect(dataRows).toHaveLength(1);
    expect(within(dataRows[0]).getAllByRole("cell")[0].textContent).toBe("Manfrotto");
  });

  it("sorts by Броней desc when column header clicked", () => {
    render(<MasterTable rows={rows} />);
    fireEvent.click(screen.getByRole("columnheader", { name: /Броней/ }));
    const dataRows = screen.getAllByRole("row").slice(1);
    const names = dataRows.map((r) => within(r).getAllByRole("cell")[0].textContent);
    expect(names).toEqual(["Aputure", "Софтбокс", "Manfrotto"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm --workspace=apps/web run test -- MasterTable
```

Expected: FAIL — component does not exist.

- [ ] **Step 3: Implement the component**

Create `apps/web/src/components/equipment-stats/MasterTable.tsx`:

```tsx
"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { formatRub } from "../../lib/format";
import type { EquipmentStatRow } from "./types";

type SortKey =
  | "name"
  | "category"
  | "totalQuantity"
  | "bookingsCount"
  | "qtyShifts"
  | "revenueRub"
  | "revenuePerStorageUnit"
  | "repairCount"
  | "problemCount";

type FilterChip = "all" | "no-rental" | "with-incidents";

const COLUMNS: { key: SortKey; label: string; align: "left" | "right" }[] = [
  { key: "name", label: "Позиция", align: "left" },
  { key: "category", label: "Категория", align: "left" },
  { key: "totalQuantity", label: "Σ кол-во", align: "right" },
  { key: "bookingsCount", label: "Броней", align: "right" },
  { key: "qtyShifts", label: "Ед.-смен", align: "right" },
  { key: "revenueRub", label: "Выручка ₽", align: "right" },
  { key: "revenuePerStorageUnit", label: "₽/ед. склада", align: "right" },
  { key: "repairCount", label: "Ремонтов", align: "right" },
  { key: "problemCount", label: "Потерь", align: "right" },
];

function cmp(a: EquipmentStatRow, b: EquipmentStatRow, key: SortKey, dir: 1 | -1): number {
  const av = a[key];
  const bv = b[key];
  if (typeof av === "string" && typeof bv === "string") {
    // numeric strings (Decimal serialized) → compare as numbers when possible
    const an = Number(av);
    const bn = Number(bv);
    if (Number.isFinite(an) && Number.isFinite(bn) && (an !== 0 || bn !== 0 || av === bv)) {
      return dir * (an - bn);
    }
    return dir * av.localeCompare(bv);
  }
  return dir * ((av as number) - (bv as number));
}

interface MasterTableProps {
  rows: EquipmentStatRow[];
}

export function MasterTable({ rows }: MasterTableProps) {
  const router = useRouter();
  const [chip, setChip] = useState<FilterChip>("all");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<1 | -1>(1);

  const visible = useMemo(() => {
    let r = rows;
    if (chip === "no-rental") r = r.filter((x) => x.bookingsCount === 0);
    else if (chip === "with-incidents") r = r.filter((x) => x.repairCount + x.problemCount > 0);
    return [...r].sort((a, b) => cmp(a, b, sortKey, sortDir));
  }, [rows, chip, sortKey, sortDir]);

  function onHeader(key: SortKey) {
    if (sortKey === key) {
      setSortDir(sortDir === 1 ? -1 : 1);
    } else {
      setSortKey(key);
      // default desc for numeric, asc for string
      setSortDir(key === "name" || key === "category" ? 1 : -1);
    }
  }

  return (
    <div>
      <div className="flex gap-2 mb-3 flex-wrap">
        <ChipButton active={chip === "all"} onClick={() => setChip("all")}>Все</ChipButton>
        <ChipButton active={chip === "no-rental"} onClick={() => setChip("no-rental")}>Без аренды</ChipButton>
        <ChipButton active={chip === "with-incidents"} onClick={() => setChip("with-incidents")}>С поломками</ChipButton>
      </div>
      <div className="overflow-x-auto bg-surface border border-border rounded-xl">
        <table className="w-full text-sm border-collapse">
          <thead className="bg-surface-2">
            <tr>
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className={
                    "px-3 py-2.5 text-xs uppercase tracking-wide font-semibold text-ink-3 cursor-pointer select-none " +
                    (c.align === "right" ? "text-right" : "text-left")
                  }
                  onClick={() => onHeader(c.key)}
                  aria-sort={sortKey === c.key ? (sortDir === 1 ? "ascending" : "descending") : "none"}
                >
                  {c.label}{sortKey === c.key ? (sortDir === 1 ? " ↑" : " ↓") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr
                key={r.id}
                className="border-t border-border hover:bg-surface-2 cursor-pointer"
                onClick={() => router.push(`/equipment/${r.id}`)}
              >
                <td className="px-3 py-2">{r.name}</td>
                <td className="px-3 py-2 text-ink-3">{r.category}</td>
                <td className="px-3 py-2 text-right mono-num">{r.totalQuantity}</td>
                <td className="px-3 py-2 text-right mono-num">{r.bookingsCount}</td>
                <td className="px-3 py-2 text-right mono-num">{r.qtyShifts}</td>
                <td className="px-3 py-2 text-right mono-num">{formatRub(r.revenueRub)}</td>
                <td className="px-3 py-2 text-right mono-num">{formatRub(r.revenuePerStorageUnit)}</td>
                <td className="px-3 py-2 text-right mono-num">{r.repairCount}</td>
                <td className="px-3 py-2 text-right mono-num">{r.problemCount}</td>
              </tr>
            ))}
            {visible.length === 0 ? (
              <tr>
                <td colSpan={COLUMNS.length} className="px-3 py-6 text-center text-ink-3">
                  Нет позиций под выбранный фильтр
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ChipButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "text-xs px-3 py-1.5 rounded-full border transition-colors " +
        (active
          ? "bg-accent text-white border-accent"
          : "bg-surface text-ink-3 border-border hover:text-ink")
      }
    >
      {children}
    </button>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm --workspace=apps/web run test -- MasterTable
```

Expected: all 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/equipment-stats/MasterTable.tsx apps/web/src/components/equipment-stats/__tests__/MasterTable.test.tsx
git commit -m "feat(equipment-stats): MasterTable with sort + filter chips"
```

---

## Task 15: useEquipmentStats hook + EquipmentStatsPage container

**Files:**
- Create: `apps/web/src/components/equipment-stats/useEquipmentStats.ts`
- Create: `apps/web/src/components/equipment-stats/EquipmentStatsPage.tsx`

- [ ] **Step 1: Implement the fetch hook**

Create `apps/web/src/components/equipment-stats/useEquipmentStats.ts`:

```ts
"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiFetch } from "../../lib/api";
import type { EquipmentStatsResponse, PeriodValue } from "./types";

export function useEquipmentStats() {
  const searchParams = useSearchParams();
  const rawPeriod = searchParams.get("period");
  const period: PeriodValue =
    rawPeriod === "30" || rawPeriod === "365" ? rawPeriod : "90";

  const [data, setData] = useState<EquipmentStatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<EquipmentStatsResponse>(`/api/equipment-stats?period=${period}`)
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setLoading(false);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Не удалось загрузить статистику");
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [period]);

  return { data, error, loading, period };
}
```

- [ ] **Step 2: Implement the page container**

Create `apps/web/src/components/equipment-stats/EquipmentStatsPage.tsx`:

```tsx
"use client";

import { SectionHeader } from "../SectionHeader";
import { PeriodToggle } from "./PeriodToggle";
import { KpiHero } from "./KpiHero";
import { TopRankedSection } from "./TopRankedSection";
import { MasterTable } from "./MasterTable";
import { useEquipmentStats } from "./useEquipmentStats";

const PERIOD_LABEL: Record<"30d" | "90d" | "365d", string> = {
  "30d": "за 30 дней",
  "90d": "за 90 дней",
  "365d": "за год",
};

export function EquipmentStatsPage() {
  const { data, error, loading } = useEquipmentStats();

  return (
    <div className="space-y-2">
      <SectionHeader
        eyebrow="Аналитика"
        title="Статистика техники"
        actions={<PeriodToggle />}
      />

      {loading && !data ? (
        <div className="py-12 text-center text-ink-3">Загружаем…</div>
      ) : error ? (
        <div className="py-6 px-4 bg-rose-soft border border-rose-border rounded-xl text-rose">
          {error}
        </div>
      ) : data ? (
        <>
          <KpiHero kpi={data.kpi} periodLabel={PERIOD_LABEL[data.period]} />

          <TopRankedSection
            icon="🔥"
            title="Чаще всего берут"
            rows={data.demand}
            rowKey="demand"
            emptyText="Нет броней за выбранный период"
          />
          <TopRankedSection
            icon="💤"
            title="Мёртвый груз"
            rows={data.deadStock}
            rowKey="deadStock"
            emptyText="Все позиции в работе — мёртвого груза нет 🎉"
          />
          <TopRankedSection
            icon="💰"
            title="Лучшая доходность на единицу склада"
            rows={data.revenue}
            rowKey="revenue"
            emptyText="Нет выручки за выбранный период"
          />
          <TopRankedSection
            icon="🔧"
            title="Проблемные позиции"
            rows={data.quality}
            rowKey="quality"
            emptyText="За выбранный период ничего не ломали 🎉"
          />

          <div className="mt-8 mb-2 eyebrow">Все позиции</div>
          <MasterTable rows={data.table} />
        </>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/equipment-stats/useEquipmentStats.ts apps/web/src/components/equipment-stats/EquipmentStatsPage.tsx
git commit -m "feat(equipment-stats): page container + fetch hook"
```

---

## Task 16: Next.js page shell

**Files:**
- Create: `apps/web/app/admin/equipment-stats/page.tsx`

- [ ] **Step 1: Implement the page shell**

Create `apps/web/app/admin/equipment-stats/page.tsx`:

```tsx
"use client";

import { Suspense } from "react";
import { useRequireRole } from "../../../src/hooks/useRequireRole";
import { EquipmentStatsPage } from "../../../src/components/equipment-stats/EquipmentStatsPage";

export default function Page() {
  const ready = useRequireRole(["SUPER_ADMIN"]);
  if (!ready) return null;
  return (
    <Suspense fallback={<div className="py-12 text-center text-ink-3">Загружаем…</div>}>
      <EquipmentStatsPage />
    </Suspense>
  );
}
```

- [ ] **Step 2: Type-check the workspace**

```bash
npm --workspace=apps/web exec -- tsc --noEmit
```

Expected: PASS, no new errors. If `useRequireRole` returns `void` instead of a boolean in this codebase, drop the `if (!ready) return null` line and rely on the redirect side-effect — the hook returns `void` by convention there. Check the file at `apps/web/src/hooks/useRequireRole.ts` and adjust accordingly.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/admin/equipment-stats/page.tsx
git commit -m "feat(equipment-stats): /admin/equipment-stats page shell with role guard"
```

---

## Task 17: Manual smoke test + design fidelity capture

This is the final acceptance step. No new code — just verify the page works in the real app and matches the mockup.

**Files:** none modified.

- [ ] **Step 1: Run the dev server**

In one terminal:
```bash
npm run dev
```

Wait until both API (`:4000`) and web (`:3000`) are listening.

- [ ] **Step 2: Log in as SUPER_ADMIN and navigate to the page**

In a browser, open `http://localhost:3000/login`, log in as the seeded SUPER_ADMIN user, then navigate to `/admin/equipment-stats`.

- [ ] **Step 3: Verify functional behaviour**

Visually check:
- All 4 KPI cards render with real numbers.
- All 4 ranked sections render — empty sections show their friendly empty-state message.
- The period toggle works: clicking «30 дней» / «90 дней» / «Год» updates the URL and triggers a refetch.
- The master-table sorts on column-header click, filter chips «Без аренды» and «С поломками» narrow rows.
- Clicking a row in either a top-ranked section or the master-table navigates to `/equipment/[id]`.
- The «Аналитика» menu section only appears for SUPER_ADMIN — log in as WAREHOUSE (if a seeded user exists) and confirm it is hidden, and direct navigation to `/admin/equipment-stats` redirects to `/day`.

- [ ] **Step 4: Capture design-fidelity screenshots**

Use the browser dev-tools responsive mode to capture:
- Width 1440 px, full page screenshot → save as `docs/qa/equipment-stats-1440.png` (path is conventional, see `docs/qa/` precedent).
- Width 375 px, full page screenshot → save as `docs/qa/equipment-stats-375.png`.
- Open `docs/mockups/equipment-stats.html` at the same widths and compare side-by-side. Note any visible drift in a one-paragraph note added to the spec under §10 (Risks) — only if drift is real.

- [ ] **Step 5: Run full test suites**

```bash
npm test
```

Expected: all tests (shared + api + bot + web) PASS.

- [ ] **Step 6: Commit the screenshots**

```bash
git add docs/qa/equipment-stats-1440.png docs/qa/equipment-stats-375.png
git commit -m "test(equipment-stats): design-fidelity screenshots at 1440 and 375"
```

---

# Done

After Task 17, the feature is complete and ready for the merge → deploy flow (autonomous-mode per CLAUDE.local.md):
1. `git push origin HEAD`
2. Open PR with summary of new endpoint, new page, screenshots.
3. After CI green + self-review, merge to `main`.
4. Deploy via the documented SSH command in CLAUDE.local.md.

## Self-Review (plan author notes)

The plan was reviewed against the spec for coverage and consistency:

- **Spec §1 (access/routing):** Task 1 (rolesGuard SA), Task 9 (menu entry SA-only), Task 16 (useRequireRole SA) — covered.
- **Spec §2 (API endpoint and response shape):** Task 1 (route + Zod), Tasks 2–6 (each field populated), Task 7 (invalid period 400) — covered.
- **Spec §3 (metric definitions):** Tasks 3 (demand), 4 (revenue + revenuePerStorageUnit), 5 (incidents + repair cost), 6 (lastBookingAt + dead stock ordering) — covered. The catalog-only and status filter rules are enforced through the `equipmentId: { not: null }` and `status: { in: [...RENTAL_BOOKING_STATUSES] }` filters, locked by Task 7.
- **Spec §4 (UI components):** Tasks 11–14 (each component with tests for the testable ones), Task 15 (container + hook), Task 16 (page shell). Static mockup as design reference in Task 8.
- **Spec §5 (data flow):** Promise.all aggregation pattern shown in Tasks 3–6 incrementally.
- **Spec §6 (edge cases):** Task 7 locks custom-item exclusion, period boundary, invalid period. `totalQuantity = 0` divide-by-1 clamp is shown in Task 4's row mapper.
- **Spec §7 (no audit):** no audit-writing code in any task — correct.
- **Spec §8 (testing):** API integration tests grown across Tasks 1–7. Web component tests in Tasks 11/13/14. Manual smoke + screenshots in Task 17.
- **Spec §10 (risks):** SQLite NULL ordering risk is handled by the client-side custom comparator in Task 6 (`if (a.lastBookingAt === null) return -1`), not relying on DB sort order.

No placeholders found. Function/type names are consistent across tasks (`computeEquipmentStats`, `EquipmentStatRow`, `aggregateDemand`, `RENTAL_BOOKING_STATUSES`).
