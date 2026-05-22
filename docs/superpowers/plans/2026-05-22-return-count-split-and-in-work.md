# Return COUNT-split + «В работе» Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add COUNT-mode «Принять/Ремонт/Проблема»-сплит на странице приёмки + новая tab «В работе» для просмотра активных выдач.

**Architecture:**
- Backend: relax `Repair.unitId` and `ProblemItem.equipmentUnitId` to nullable, add `bookingItemId + quantity`. `completeSession` accepts discriminated-union form (UNIT vs COUNT). New `/api/warehouse/in-work` + `/in-work/:id/details` endpoints.
- Frontend: new `CountSplitRow` component (3 buckets + pills + action buttons + inline panels). `ReturnChecklist` swaps `UnitRow` → `CountSplitRow` for COUNT-mode rows. `/warehouse/scan` adds third tab «В работе» with `InWorkList` + `InWorkDetails`.

**Tech Stack:** Prisma 6 (SQLite), Express + TypeScript, React 18, Next.js 14, Vitest, decimal.js, Zod.

**Spec:** `docs/superpowers/specs/2026-05-22-return-count-split-and-in-work.md`

---

## Task 1: Schema — relax Repair + ProblemItem for COUNT-mode

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (models `Repair` line ~801 and `ProblemItem` line ~1181, plus `BookingItem` to add reverse relations)
- Create: `apps/api/prisma/migrations/<timestamp>_count_mode_repair_problem/migration.sql` (auto-generated OR manual if migrate-dev fails like in PR #168)

- [ ] **Step 1: Edit `apps/api/prisma/schema.prisma` → `Repair` model**

Find `model Repair { ... }` at line ~801. Change:

```prisma
model Repair {
  id              String         @id @default(cuid())
  unitId          String?        // CHANGED: was `unitId String` (required)
  unit            EquipmentUnit? @relation(fields: [unitId], references: [id])  // CHANGED: nullable

  // NEW for COUNT-mode reports:
  bookingItemId   String?
  bookingItem     BookingItem?   @relation("RepairBookingItem", fields: [bookingItemId], references: [id], onDelete: SetNull)
  quantity        Int            @default(1)

  // ...keep all existing fields unchanged below:
  status          RepairStatus   @default(WAITING_REPAIR)
  urgency         RepairUrgency  @default(NORMAL)
  reason          String
  sourceBookingId String?
  sourceBooking   Booking?       @relation("RepairSourceBooking", fields: [sourceBookingId], references: [id], onDelete: SetNull)
  createdBy       String
  assignedTo      String?
  partsCost       Decimal        @default(0)
  totalTimeHours  Decimal        @default(0)
  createdAt       DateTime       @default(now())
  updatedAt       DateTime       @updatedAt
  closedAt        DateTime?

  workLog  RepairWorkLog[]
  expenses Expense[]
  photos   RepairPhoto[]

  @@index([unitId])
  @@index([status])
  @@index([assignedTo])
  @@index([bookingItemId])
}
```

- [ ] **Step 2: Edit `ProblemItem` model**

Find `model ProblemItem { ... }` at line ~1181. Change:

```prisma
model ProblemItem {
  id               String         @id @default(cuid())
  equipmentUnitId  String?        // CHANGED: was required
  equipmentUnit    EquipmentUnit? @relation(fields: [equipmentUnitId], references: [id])  // CHANGED: nullable

  // NEW for COUNT-mode reports:
  bookingItemId    String?
  bookingItem      BookingItem?   @relation("ProblemItemBookingItem", fields: [bookingItemId], references: [id], onDelete: SetNull)
  quantity         Int            @default(1)

  // ...keep all existing fields unchanged:
  sourceBookingId  String?
  reason           ProblemReason
  comment          String
  expectedBackDate DateTime?
  status           ProblemStatus  @default(SEARCHING)
  createdBy        String
  createdAt        DateTime       @default(now())
  resolvedAt       DateTime?
  resolvedBy       String?
  resolutionNote   String?

  @@index([status])
  @@index([equipmentUnitId])
  @@index([sourceBookingId])
  @@index([bookingItemId])
}
```

- [ ] **Step 3: Add reverse relations on `BookingItem`**

Find `model BookingItem { ... }` and add at the bottom of the field list (before `@@unique` / `@@index`):

```prisma
  repairs          Repair[]       @relation("RepairBookingItem")
  problems         ProblemItem[]  @relation("ProblemItemBookingItem")
```

- [ ] **Step 4: Generate migration**

```bash
cd /Users/sechenov/Documents/light-rental-system/apps/api && npx prisma migrate dev --name count_mode_repair_problem 2>&1 | tail -20
```

If it fails with shadow-DB / `P3006` (as in PR #168), fallback: create the migration manually.

```bash
TS=$(date +%Y%m%d%H%M%S) && mkdir -p prisma/migrations/${TS}_count_mode_repair_problem
```

Write `apps/api/prisma/migrations/${TS}_count_mode_repair_problem/migration.sql`:

```sql
-- Relax Repair.unitId to nullable; add bookingItemId + quantity.
-- Relax ProblemItem.equipmentUnitId to nullable; add bookingItemId + quantity.
-- SQLite-style: recreate tables with new schemas (Prisma's default for nullable changes).

PRAGMA foreign_keys=OFF;

-- Repair
CREATE TABLE "new_Repair" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "unitId" TEXT,
    "bookingItemId" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'WAITING_REPAIR',
    "urgency" TEXT NOT NULL DEFAULT 'NORMAL',
    "reason" TEXT NOT NULL,
    "sourceBookingId" TEXT,
    "createdBy" TEXT NOT NULL,
    "assignedTo" TEXT,
    "partsCost" DECIMAL NOT NULL DEFAULT 0,
    "totalTimeHours" DECIMAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "closedAt" DATETIME,
    CONSTRAINT "Repair_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "EquipmentUnit" ("id") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "Repair_bookingItemId_fkey" FOREIGN KEY ("bookingItemId") REFERENCES "BookingItem" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Repair_sourceBookingId_fkey" FOREIGN KEY ("sourceBookingId") REFERENCES "Booking" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Repair" ("id","unitId","status","urgency","reason","sourceBookingId","createdBy","assignedTo","partsCost","totalTimeHours","createdAt","updatedAt","closedAt")
SELECT "id","unitId","status","urgency","reason","sourceBookingId","createdBy","assignedTo","partsCost","totalTimeHours","createdAt","updatedAt","closedAt" FROM "Repair";
DROP TABLE "Repair";
ALTER TABLE "new_Repair" RENAME TO "Repair";
CREATE INDEX "Repair_unitId_idx" ON "Repair"("unitId");
CREATE INDEX "Repair_status_idx" ON "Repair"("status");
CREATE INDEX "Repair_assignedTo_idx" ON "Repair"("assignedTo");
CREATE INDEX "Repair_bookingItemId_idx" ON "Repair"("bookingItemId");

-- ProblemItem
CREATE TABLE "new_ProblemItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "equipmentUnitId" TEXT,
    "bookingItemId" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "sourceBookingId" TEXT,
    "reason" TEXT NOT NULL,
    "comment" TEXT NOT NULL,
    "expectedBackDate" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'SEARCHING',
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME,
    "resolvedBy" TEXT,
    "resolutionNote" TEXT,
    CONSTRAINT "ProblemItem_equipmentUnitId_fkey" FOREIGN KEY ("equipmentUnitId") REFERENCES "EquipmentUnit" ("id") ON DELETE NO ACTION ON UPDATE CASCADE,
    CONSTRAINT "ProblemItem_bookingItemId_fkey" FOREIGN KEY ("bookingItemId") REFERENCES "BookingItem" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ProblemItem" ("id","equipmentUnitId","sourceBookingId","reason","comment","expectedBackDate","status","createdBy","createdAt","resolvedAt","resolvedBy","resolutionNote")
SELECT "id","equipmentUnitId","sourceBookingId","reason","comment","expectedBackDate","status","createdBy","createdAt","resolvedAt","resolvedBy","resolutionNote" FROM "ProblemItem";
DROP TABLE "ProblemItem";
ALTER TABLE "new_ProblemItem" RENAME TO "ProblemItem";
CREATE INDEX "ProblemItem_status_idx" ON "ProblemItem"("status");
CREATE INDEX "ProblemItem_equipmentUnitId_idx" ON "ProblemItem"("equipmentUnitId");
CREATE INDEX "ProblemItem_sourceBookingId_idx" ON "ProblemItem"("sourceBookingId");
CREATE INDEX "ProblemItem_bookingItemId_idx" ON "ProblemItem"("bookingItemId");

PRAGMA foreign_keys=ON;
```

After manual file: `npx prisma migrate resolve --applied count_mode_repair_problem 2>&1 | tail -3` to align history.

- [ ] **Step 5: Regenerate Prisma client + typecheck**

```bash
cd /Users/sechenov/Documents/light-rental-system/apps/api && npx prisma generate 2>&1 | tail -3 && npx tsc -p tsconfig.json --noEmit 2>&1 | tail -10
```

Expected: no TS errors. Existing code that reads `repair.unit.id` still works because nullable types are forgiving (but new code must handle null). If any pre-existing call sites break (`repair.unitId` may be inferred as `string|null` now), fix them surgically by adding `if (!repair.unitId) continue;` guards. Don't restructure broadly.

- [ ] **Step 6: Commit**

```bash
cd /Users/sechenov/Documents/light-rental-system
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/
git commit -m "feat(api): schema — Repair/ProblemItem accept bookingItemId+quantity (COUNT-mode reports)"
```

---

## Task 2: Backend — completeSession accepts COUNT-mode repair/problem

**Files:**
- Modify: `apps/api/src/services/warehouseScan.ts` — function `completeSession`, types `RepairUnitInput`/`ProblemUnitInput`
- Modify: `apps/api/src/routes/warehouse.ts` — Zod schema for /complete body
- Create: `apps/api/src/services/__tests__/completeSessionCountSplit.test.ts`

- [ ] **Step 1: Extend input types**

In `apps/api/src/services/warehouseScan.ts`, find existing types `RepairUnitInput` and `ProblemUnitInput`. Replace with:

```ts
/**
 * Two discriminated forms:
 * - UNIT-mode: { equipmentUnitId, comment } — one Repair row created per unit scanned.
 * - COUNT-mode: { bookingItemId, quantity, comment } — one Repair row covering N untracked units of the same line.
 * Exactly one of equipmentUnitId or bookingItemId must be set.
 */
export type RepairUnitInput =
  | { equipmentUnitId: string; comment: string }
  | { bookingItemId: string; quantity: number; comment: string };

export type ProblemUnitInput =
  | { equipmentUnitId: string; reason: ProblemReason; comment: string; expectedBackDate?: string }
  | { bookingItemId: string; quantity: number; reason: ProblemReason; comment: string; expectedBackDate?: string };
```

(Reuse the existing `ProblemReason` type — don't redefine it.)

- [ ] **Step 2: Write failing tests in `completeSessionCountSplit.test.ts`**

```ts
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import path from "path";
import { execSync } from "child_process";

const TEST_DB = path.resolve(__dirname, "../../../prisma/test-return-count-split.db");
process.env.DATABASE_URL = `file:${TEST_DB}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.NODE_ENV = "test";

let prisma: PrismaClient;
let bookingId: string;
let sessionId: string;
let countBookingItemId: string;
let equipmentId: string;

beforeAll(async () => {
  execSync(`rm -f ${TEST_DB}`);
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../../.."),
    env: {
      ...process.env,
      DATABASE_URL: `file:${TEST_DB}`,
      PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes",
    },
    stdio: "pipe",
  });
  const pmod = await import("../../prisma");
  prisma = pmod.prisma;

  const client = await prisma.client.create({ data: { name: "Test", phone: "+70000000001" } });
  const eq = await prisma.equipment.create({
    data: {
      importKey: "split-eq", name: "Sandbag 5kg", category: "Acc",
      rentalRatePerShift: "100", totalQuantity: 10, stockTrackingMode: "COUNT",
    },
  });
  equipmentId = eq.id;
  const booking = await prisma.booking.create({
    data: {
      clientId: client.id, projectName: "Split test",
      startDate: new Date("2026-06-01"), endDate: new Date("2026-06-02"),
      status: "ISSUED",
      items: { create: [{ equipmentId: eq.id, quantity: 3 }] },
    },
    include: { items: true },
  });
  bookingId = booking.id;
  countBookingItemId = booking.items[0].id;
  const session = await prisma.scanSession.create({
    data: { bookingId, workerName: "test", operation: "RETURN", status: "ACTIVE" },
  });
  sessionId = session.id;
});

afterAll(async () => { await prisma?.$disconnect?.(); });

describe("completeSession — COUNT-mode repair/problem", () => {
  it("creates Repair rows with bookingItemId + quantity (null unitId) for COUNT repair form", async () => {
    const { completeSession } = await import("../warehouseScan");
    await completeSession(sessionId, {
      repairUnits: [{ bookingItemId: countBookingItemId, quantity: 2, comment: "Сломана защёлка" }],
      createdBy: "test",
    });
    const repairs = await prisma.repair.findMany({ where: { bookingItemId: countBookingItemId } });
    expect(repairs).toHaveLength(1);
    expect(repairs[0].unitId).toBeNull();
    expect(repairs[0].quantity).toBe(2);
    expect(repairs[0].reason).toBe("Сломана защёлка");
  });

  it("creates ProblemItem rows with bookingItemId + quantity (null equipmentUnitId) for COUNT problem form", async () => {
    const { completeSession } = await import("../warehouseScan");
    // Reset session to ACTIVE
    await prisma.scanSession.update({ where: { id: sessionId }, data: { status: "ACTIVE", completedAt: null } });
    await completeSession(sessionId, {
      problemUnits: [{
        bookingItemId: countBookingItemId, quantity: 1,
        reason: "LEFT_ON_SITE", comment: "Забыли на площадке",
        expectedBackDate: "2026-06-05T10:00:00.000Z",
      }],
      createdBy: "test",
    });
    const problems = await prisma.problemItem.findMany({ where: { bookingItemId: countBookingItemId } });
    expect(problems).toHaveLength(1);
    expect(problems[0].equipmentUnitId).toBeNull();
    expect(problems[0].quantity).toBe(1);
    expect(problems[0].reason).toBe("LEFT_ON_SITE");
  });

  it("rejects with 400 INVALID_SPLIT when accepted+repair+problem > totalQty", async () => {
    const { completeSession } = await import("../warehouseScan");
    await prisma.scanSession.update({ where: { id: sessionId }, data: { status: "ACTIVE", completedAt: null } });
    // BookingItem.quantity = 3; try to push 2 repair + 2 problem = 4 > 3
    await expect(completeSession(sessionId, {
      repairUnits: [{ bookingItemId: countBookingItemId, quantity: 2, comment: "x" }],
      problemUnits: [{
        bookingItemId: countBookingItemId, quantity: 2,
        reason: "BROKEN", comment: "y",
      }],
      createdBy: "test",
    })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_SPLIT",
    });
  });
});
```

- [ ] **Step 3: Run failing tests**

```bash
cd /Users/sechenov/Documents/light-rental-system/apps/api && npx vitest run src/services/__tests__/completeSessionCountSplit.test.ts 2>&1 | tail -15
```

Expected: all FAIL — completeSession doesn't yet handle COUNT-mode inputs.

- [ ] **Step 4: Implement COUNT-mode handling in completeSession**

In `apps/api/src/services/warehouseScan.ts`, find where repair and problem units are persisted (inside the RETURN-branch of completeSession transaction). Currently it likely does `tx.repair.create({ data: { unitId: r.equipmentUnitId, ... }})`. Refactor:

```ts
// BEFORE persisting repairs/problems, validate COUNT-mode splits don't exceed totalQty.
const repairs = options.repairUnits ?? [];
const problems = options.problemUnits ?? [];

// Group COUNT-form entries by bookingItemId and sum quantity.
const countRepairByBi = new Map<string, number>();
const countProblemByBi = new Map<string, number>();
for (const r of repairs) {
  if ("bookingItemId" in r && r.bookingItemId) {
    countRepairByBi.set(r.bookingItemId, (countRepairByBi.get(r.bookingItemId) ?? 0) + r.quantity);
  }
}
for (const p of problems) {
  if ("bookingItemId" in p && p.bookingItemId) {
    countProblemByBi.set(p.bookingItemId, (countProblemByBi.get(p.bookingItemId) ?? 0) + p.quantity);
  }
}
const allBiIds = new Set([...countRepairByBi.keys(), ...countProblemByBi.keys()]);
if (allBiIds.size > 0) {
  const bis = await tx.bookingItem.findMany({
    where: { id: { in: Array.from(allBiIds) }, bookingId: session.bookingId },
    select: { id: true, quantity: true },
  });
  for (const bi of bis) {
    const r = countRepairByBi.get(bi.id) ?? 0;
    const p = countProblemByBi.get(bi.id) ?? 0;
    if (r + p > bi.quantity) {
      throw new HttpError(400, "Неверное распределение", "INVALID_SPLIT", {
        bookingItemId: bi.id,
        repair: r,
        problem: p,
        totalQty: bi.quantity,
      });
    }
  }
}

// Persist repairs — discriminate between UNIT and COUNT.
for (const r of repairs) {
  if ("equipmentUnitId" in r && r.equipmentUnitId) {
    await tx.repair.create({
      data: {
        unitId: r.equipmentUnitId,
        reason: r.comment,
        createdBy: options.createdBy ?? "warehouse",
        sourceBookingId: session.bookingId,
        // existing fields preserved
      },
    });
  } else if ("bookingItemId" in r && r.bookingItemId) {
    await tx.repair.create({
      data: {
        bookingItemId: r.bookingItemId,
        quantity: r.quantity,
        reason: r.comment,
        createdBy: options.createdBy ?? "warehouse",
        sourceBookingId: session.bookingId,
      },
    });
  }
}

// Persist problems — same discriminator.
for (const p of problems) {
  const common = {
    reason: p.reason,
    comment: p.comment,
    expectedBackDate: p.expectedBackDate ? new Date(p.expectedBackDate) : null,
    sourceBookingId: session.bookingId,
    createdBy: options.createdBy ?? "warehouse",
  };
  if ("equipmentUnitId" in p && p.equipmentUnitId) {
    await tx.problemItem.create({ data: { ...common, equipmentUnitId: p.equipmentUnitId } });
  } else if ("bookingItemId" in p && p.bookingItemId) {
    await tx.problemItem.create({ data: { ...common, bookingItemId: p.bookingItemId, quantity: p.quantity } });
  }
}
```

NB: If the existing implementation has different field names (e.g. `Repair.reason` vs `Repair.notes`), preserve them. The point is the discriminator on `equipmentUnitId` vs `bookingItemId`.

- [ ] **Step 5: Update Zod schema in routes/warehouse.ts**

Find the existing `completeSessionBodySchema` in `apps/api/src/routes/warehouse.ts`. Update the `repairUnits` and `problemUnits` array schemas to accept both forms:

```ts
const repairUnitInputSchema = z.union([
  z.object({
    equipmentUnitId: z.string().min(1),
    comment: z.string().min(1),
  }),
  z.object({
    bookingItemId: z.string().min(1),
    quantity: z.number().int().min(1),
    comment: z.string().min(1),
  }),
]);

const problemUnitInputSchema = z.union([
  z.object({
    equipmentUnitId: z.string().min(1),
    reason: z.enum(["BROKEN", "LOST", "LEFT_ON_SITE"]),  // verify enum values match existing
    comment: z.string().min(1),
    expectedBackDate: z.string().datetime().optional(),
  }),
  z.object({
    bookingItemId: z.string().min(1),
    quantity: z.number().int().min(1),
    reason: z.enum(["BROKEN", "LOST", "LEFT_ON_SITE"]),
    comment: z.string().min(1),
    expectedBackDate: z.string().datetime().optional(),
  }),
]);
```

If the existing schema uses different enum values for `reason`, mirror them exactly.

- [ ] **Step 6: Verify tests pass**

```bash
cd /Users/sechenov/Documents/light-rental-system/apps/api && npx vitest run src/services/__tests__/completeSessionCountSplit.test.ts 2>&1 | tail -5
```

Expected: 3/3 PASS.

- [ ] **Step 7: Run full backend suite — no regressions**

```bash
cd /Users/sechenov/Documents/light-rental-system/apps/api && npm test 2>&1 | tail -5
```

Expected: previous tests still pass. If some break because they assumed `Repair.unitId` non-null, surgical fixes in test fixtures.

- [ ] **Step 8: Commit**

```bash
cd /Users/sechenov/Documents/light-rental-system
git add apps/api/src/services/warehouseScan.ts apps/api/src/routes/warehouse.ts apps/api/src/services/__tests__/completeSessionCountSplit.test.ts
git commit -m "feat(api): completeSession — COUNT-mode repair/problem (bookingItemId+quantity)"
```

---

## Task 3: Backend — /api/warehouse/in-work + /in-work/:id/details

**Files:**
- Modify: `apps/api/src/routes/warehouse.ts` — add 2 new routes
- Create: `apps/api/src/routes/__tests__/inWorkRoutes.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import path from "path";
import { execSync } from "child_process";
import request from "supertest";

const TEST_DB = path.resolve(__dirname, "../../../prisma/test-in-work.db");
process.env.DATABASE_URL = `file:${TEST_DB}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.NODE_ENV = "test";
process.env.WAREHOUSE_SECRET = "test-wh-in-work-min16chars";
process.env.JWT_SECRET = "test-jwt-in-work-min16chars000";

let prisma: PrismaClient;
let app: any;
let warehouseToken: string;
let issuedBookingId: string;
let confirmedBookingId: string;

beforeAll(async () => {
  execSync(`rm -f ${TEST_DB}`);
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../../.."),
    env: {
      ...process.env,
      DATABASE_URL: `file:${TEST_DB}`,
      PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes",
    },
    stdio: "pipe",
  });
  const pmod = await import("../../prisma");
  prisma = pmod.prisma;
  const { app: expressApp } = await import("../../app");
  app = expressApp;

  const { hashPin } = await import("../../services/warehouseAuth");
  await prisma.warehousePin.create({
    data: { name: "Test WH", pinHash: await hashPin("1234"), isActive: true },
  });
  const authRes = await request(app).post("/api/warehouse/auth").send({ name: "Test WH", pin: "1234" });
  warehouseToken = authRes.body.token;

  const client = await prisma.client.create({ data: { name: "ACME", phone: "+70000000002" } });
  const eq = await prisma.equipment.create({
    data: { importKey: "in-work-eq", name: "Stand", category: "Acc", rentalRatePerShift: "100", totalQuantity: 10 },
  });
  const issued = await prisma.booking.create({
    data: {
      clientId: client.id, projectName: "Активная съёмка",
      startDate: new Date("2026-05-20"), endDate: new Date("2026-05-21"),
      status: "ISSUED", issuedAt: new Date("2026-05-19"),
      finalAmount: "5000",
      items: { create: [{ equipmentId: eq.id, quantity: 3 }] },
    },
  });
  issuedBookingId = issued.id;

  const confirmed = await prisma.booking.create({
    data: {
      clientId: client.id, projectName: "Только подтверждена",
      startDate: new Date("2026-05-25"), endDate: new Date("2026-05-26"),
      status: "CONFIRMED",
      items: { create: [{ equipmentId: eq.id, quantity: 1 }] },
    },
  });
  confirmedBookingId = confirmed.id;
});

afterAll(async () => { await prisma?.$disconnect?.(); });

describe("GET /api/warehouse/in-work", () => {
  it("returns only ISSUED bookings, sorted by endDate asc, isOverdue computed", async () => {
    const res = await request(app)
      .get("/api/warehouse/in-work")
      .set("Authorization", `Bearer ${warehouseToken}`);
    expect(res.status).toBe(200);
    expect(res.body.bookings).toHaveLength(1);
    const b = res.body.bookings[0];
    expect(b.bookingId).toBe(issuedBookingId);
    expect(b.projectName).toBe("Активная съёмка");
    expect(b.clientName).toBe("ACME");
    expect(b.itemsCount).toBe(1);
    expect(b.displayNo).toMatch(/^#[A-Z0-9]{6}$/);
    expect(b.isOverdue).toBe(true);            // endDate 2026-05-21 < today 2026-05-22
    expect(b.overdueDays).toBeGreaterThanOrEqual(1);
  });

  it("excludes non-ISSUED bookings", async () => {
    const res = await request(app)
      .get("/api/warehouse/in-work")
      .set("Authorization", `Bearer ${warehouseToken}`);
    const ids = res.body.bookings.map((b: any) => b.bookingId);
    expect(ids).not.toContain(confirmedBookingId);
  });

  it("returns 401 without auth token", async () => {
    const res = await request(app).get("/api/warehouse/in-work");
    expect(res.status).toBe(401);
  });
});

describe("GET /api/warehouse/in-work/:bookingId/details", () => {
  it("returns items + finance for ISSUED booking", async () => {
    const res = await request(app)
      .get(`/api/warehouse/in-work/${issuedBookingId}/details`)
      .set("Authorization", `Bearer ${warehouseToken}`);
    expect(res.status).toBe(200);
    expect(res.body.bookingId).toBe(issuedBookingId);
    expect(res.body.items).toBeInstanceOf(Array);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.finance.finalAmount).toBe("5000");
  });

  it("returns 404 for non-ISSUED booking", async () => {
    const res = await request(app)
      .get(`/api/warehouse/in-work/${confirmedBookingId}/details`)
      .set("Authorization", `Bearer ${warehouseToken}`);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run failing tests**

```bash
cd /Users/sechenov/Documents/light-rental-system/apps/api && npx vitest run src/routes/__tests__/inWorkRoutes.test.ts 2>&1 | tail -10
```

Expected: all FAIL (routes don't exist).

- [ ] **Step 3: Add routes to `apps/api/src/routes/warehouse.ts`**

Find an existing route (e.g. /sessions/:id/state) for the `warehouseAuth` pattern, then add:

```ts
/** GET /api/warehouse/in-work — list of currently ISSUED bookings */
warehouseScanRouter.get("/in-work", warehouseAuth, async (_req, res, next) => {
  try {
    const bookings = await prisma.booking.findMany({
      where: { status: "ISSUED" },
      orderBy: { endDate: "asc" },
      include: {
        client: { select: { name: true, phone: true } },
        _count: { select: { items: { where: { quantity: { gt: 0 } } } } },
      },
    });
    const now = new Date();
    const out = bookings.map((b) => {
      const overdueMs = now.getTime() - b.endDate.getTime();
      const isOverdue = overdueMs > 0;
      return {
        bookingId: b.id,
        displayNo: "#" + b.id.slice(-6).toUpperCase(),
        projectName: b.projectName,
        clientName: b.client?.name ?? "",
        issuedAt: b.issuedAt?.toISOString() ?? null,
        expectedReturnAt: b.endDate.toISOString(),
        itemsCount: b._count.items,
        finalAmount: b.finalAmount.toString(),
        isOverdue,
        overdueDays: isOverdue ? Math.floor(overdueMs / 86400000) : 0,
      };
    });
    res.json({ bookings: out });
  } catch (err) {
    next(err);
  }
});

/** GET /api/warehouse/in-work/:bookingId/details — read-only booking details */
warehouseScanRouter.get("/in-work/:bookingId/details", warehouseAuth, async (req, res, next) => {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.bookingId },
      include: {
        client: { select: { name: true, phone: true } },
        items: {
          orderBy: { createdAt: "asc" },
          include: { equipment: { select: { name: true, category: true, stockTrackingMode: true, rentalRatePerShift: true } } },
        },
      },
    });
    if (!booking || booking.status !== "ISSUED") {
      throw new HttpError(404, "Бронь не найдена или не активна", "NOT_FOUND");
    }
    const items = booking.items.map((bi) => ({
      bookingItemId: bi.id,
      equipmentId: bi.equipmentId,
      equipmentName: bi.equipment?.name ?? bi.customName ?? "Неизвестно",
      category: bi.equipment?.category ?? "Без категории",
      quantity: bi.quantity,
      trackingMode: bi.equipment?.stockTrackingMode ?? "COUNT",
    }));
    const outstandingDec = new (require("decimal.js"))(booking.finalAmount.toString()).sub(booking.amountPaid?.toString() ?? "0");
    res.json({
      bookingId: booking.id,
      displayNo: "#" + booking.id.slice(-6).toUpperCase(),
      projectName: booking.projectName,
      clientName: booking.client?.name ?? "",
      issuedAt: booking.issuedAt?.toISOString() ?? null,
      expectedReturnAt: booking.endDate.toISOString(),
      items,
      finance: {
        mainAfterDiscount: booking.finalAmount.toString(),  // simplification — full breakdown not needed read-only
        addonAfterDiscount: booking.addonAmount?.toString() ?? "0",
        finalAmount: booking.finalAmount.toString(),
        amountPaid: booking.amountPaid?.toString() ?? "0",
        outstanding: outstandingDec.toString(),
        paymentStatus: booking.paymentStatus,
      },
    });
  } catch (err) {
    next(err);
  }
});
```

If the `decimal.js` import pattern in this file is different (e.g. top-level `import Decimal from "decimal.js"`), use the top-level import instead of `require`.

- [ ] **Step 4: Verify tests pass**

```bash
cd /Users/sechenov/Documents/light-rental-system/apps/api && npx vitest run src/routes/__tests__/inWorkRoutes.test.ts 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
cd /Users/sechenov/Documents/light-rental-system
git add apps/api/src/routes/warehouse.ts apps/api/src/routes/__tests__/inWorkRoutes.test.ts
git commit -m "feat(api): /warehouse/in-work + /in-work/:id/details endpoints"
```

---

## Task 4: Frontend — types + api methods

**Files:**
- Modify: `apps/web/src/components/warehouse/types.ts`
- Modify: `apps/web/src/components/warehouse/api.ts`

- [ ] **Step 1: Add types to `types.ts`**

```ts
/** COUNT-mode return split: how many units fall into each bucket. */
export interface CountSplit {
  accepted: number;
  repair: number;
  problem: number;
}

/** Repair input — either UNIT (equipmentUnitId) or COUNT (bookingItemId+quantity). */
export type RepairUnitInput =
  | { equipmentUnitId: string; comment: string }
  | { bookingItemId: string; quantity: number; comment: string };

/** Problem input — same discriminator. */
export type ProblemUnitInput =
  | { equipmentUnitId: string; reason: ProblemReason; comment: string; expectedBackDate?: string }
  | { bookingItemId: string; quantity: number; reason: ProblemReason; comment: string; expectedBackDate?: string };

/** In-work card data returned by /api/warehouse/in-work. */
export interface InWorkBooking {
  bookingId: string;
  displayNo: string;
  projectName: string;
  clientName: string;
  issuedAt: string | null;
  expectedReturnAt: string;
  itemsCount: number;
  finalAmount: string;
  isOverdue: boolean;
  overdueDays: number;
}

/** Read-only booking details for the «В работе» tab. */
export interface InWorkDetails {
  bookingId: string;
  displayNo: string;
  projectName: string;
  clientName: string;
  issuedAt: string | null;
  expectedReturnAt: string;
  items: Array<{
    bookingItemId: string;
    equipmentId: string | null;
    equipmentName: string;
    category: string;
    quantity: number;
    trackingMode: "COUNT" | "UNIT";
  }>;
  finance: {
    mainAfterDiscount: string;
    addonAfterDiscount: string;
    finalAmount: string;
    amountPaid: string;
    outstanding: string;
    paymentStatus: string;
  };
}
```

Locate the existing `RepairUnitInput`/`ProblemUnitInput` types (used by the existing `CompletePayload`) and replace them with the discriminated unions above. Make sure `CompletePayload.repairUnits` and `.problemUnits` still reference these new types — TS will guide.

- [ ] **Step 2: Add api methods to `api.ts`**

```ts
async listInWork(): Promise<{ bookings: InWorkBooking[] }> {
  const res = await fetch("/api/warehouse/in-work");
  if (!res.ok) throw new ScanApiError(res.status, "Не удалось загрузить «В работе»");
  return res.json();
},

async getInWorkDetails(bookingId: string): Promise<InWorkDetails> {
  const res = await fetch(`/api/warehouse/in-work/${bookingId}/details`);
  if (!res.ok) throw new ScanApiError(res.status, "Не удалось загрузить детали брони");
  return res.json();
},
```

Match the existing fetch + error-parsing pattern (likely `request<T>()` helper).

- [ ] **Step 3: Run web typecheck**

```bash
cd /Users/sechenov/Documents/light-rental-system/apps/web && npx tsc -p tsconfig.json --noEmit 2>&1 | tail -10
```

Expected: clean. If any existing components passed `equipmentUnitId` literally to RepairUnitInput, TS will still accept (it's the first union branch).

- [ ] **Step 4: Commit**

```bash
cd /Users/sechenov/Documents/light-rental-system
git add apps/web/src/components/warehouse/types.ts apps/web/src/components/warehouse/api.ts
git commit -m "feat(web): types + api for COUNT-split RepairUnitInput/ProblemUnitInput and in-work endpoints"
```

---

## Task 5: Frontend — CountSplitRow component

**Files:**
- Create: `apps/web/src/components/warehouse/CountSplitRow.tsx`
- Create: `apps/web/src/components/warehouse/__tests__/CountSplitRow.test.tsx`

- [ ] **Step 1: Write failing tests**

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CountSplitRow } from "../CountSplitRow";

const baseProps = {
  name: "Штатив Avenger A100",
  totalQty: 3,
  split: { accepted: 0, repair: 0, problem: 0 },
  repairComment: "",
  problem: { reason: null, comment: "", expectedBackDate: null },
  disabled: false,
  onIncrement: vi.fn(),
  onDecrement: vi.fn(),
  onAcceptAll: vi.fn(),
  onRepairCommentChange: vi.fn(),
  onProblemPatch: vi.fn(),
};

describe("CountSplitRow", () => {
  it("renders three action buttons + three pills + «осталось пометить» counter", () => {
    render(<CountSplitRow {...baseProps} />);
    expect(screen.getByRole("button", { name: /Принять.*Штатив/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Ремонт.*Штатив/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Проблема.*Штатив/i })).toBeInTheDocument();
    expect(screen.getByText(/осталось пометить.*3.*из.*3/i)).toBeInTheDocument();
  });

  it("disables action buttons when pending=0", () => {
    render(<CountSplitRow {...baseProps} split={{ accepted: 3, repair: 0, problem: 0 }} />);
    expect(screen.getByRole("button", { name: /Принять.*Штатив/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Ремонт.*Штатив/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Проблема.*Штатив/i })).toBeDisabled();
  });

  it("pill click triggers onDecrement when bucket >= 1", () => {
    const onDecrement = vi.fn();
    render(<CountSplitRow {...baseProps} split={{ accepted: 2, repair: 1, problem: 0 }} onDecrement={onDecrement} />);
    fireEvent.click(screen.getByRole("button", { name: /Снять отметку «Принято»/i }));
    expect(onDecrement).toHaveBeenCalledWith("accepted");
  });

  it("shortcut: pending=totalQty + click «Принять 1» → calls onAcceptAll, not onIncrement", () => {
    const onIncrement = vi.fn();
    const onAcceptAll = vi.fn();
    render(<CountSplitRow {...baseProps} onIncrement={onIncrement} onAcceptAll={onAcceptAll} />);
    fireEvent.click(screen.getByRole("button", { name: /Принять.*Штатив/i }));
    expect(onAcceptAll).toHaveBeenCalled();
    expect(onIncrement).not.toHaveBeenCalled();
  });

  it("regular click (pending < totalQty) on «Принять 1» calls onIncrement('accepted')", () => {
    const onIncrement = vi.fn();
    render(<CountSplitRow {...baseProps} split={{ accepted: 1, repair: 0, problem: 0 }} onIncrement={onIncrement} />);
    fireEvent.click(screen.getByRole("button", { name: /Принять.*Штатив/i }));
    expect(onIncrement).toHaveBeenCalledWith("accepted");
  });

  it("renders repair panel when split.repair >= 1", () => {
    render(<CountSplitRow {...baseProps} split={{ accepted: 0, repair: 1, problem: 0 }} />);
    expect(screen.getByLabelText(/Комментарий ремонта/i)).toBeInTheDocument();
  });

  it("renders problem panel when split.problem >= 1", () => {
    render(<CountSplitRow {...baseProps} split={{ accepted: 0, repair: 0, problem: 1 }} />);
    expect(screen.getByLabelText(/Причина проблемы/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Комментарий проблемы/i)).toBeInTheDocument();
  });

  it("calls onRepairCommentChange when typing in repair panel", () => {
    const onRepairCommentChange = vi.fn();
    render(<CountSplitRow {...baseProps} split={{ accepted: 0, repair: 2, problem: 0 }} onRepairCommentChange={onRepairCommentChange} />);
    const ta = screen.getByLabelText(/Комментарий ремонта/i);
    fireEvent.change(ta, { target: { value: "Сломана ножка" } });
    expect(onRepairCommentChange).toHaveBeenCalledWith("Сломана ножка");
  });
});
```

- [ ] **Step 2: Run failing test**

```bash
cd /Users/sechenov/Documents/light-rental-system/apps/web && npx vitest run src/components/warehouse/__tests__/CountSplitRow.test.tsx 2>&1 | tail -10
```

Expected: FAIL (cannot find module).

- [ ] **Step 3: Implement `CountSplitRow.tsx`**

```tsx
"use client";

import type { CountSplit, ProblemDraft } from "./types";

interface Props {
  name: string;
  totalQty: number;
  split: CountSplit;
  repairComment: string;
  problem: ProblemDraft;
  disabled: boolean;
  onIncrement: (bucket: "accepted" | "repair" | "problem") => void;
  onDecrement: (bucket: "accepted" | "repair" | "problem") => void;
  onAcceptAll: () => void;
  onRepairCommentChange: (s: string) => void;
  onProblemPatch: (patch: Partial<ProblemDraft>) => void;
}

const REASON_LABEL: Record<string, string> = {
  BROKEN: "Сломан",
  LOST: "Потерян",
  LEFT_ON_SITE: "Оставлен на площадке",
};

export function CountSplitRow({
  name,
  totalQty,
  split,
  repairComment,
  problem,
  disabled,
  onIncrement,
  onDecrement,
  onAcceptAll,
  onRepairCommentChange,
  onProblemPatch,
}: Props) {
  const pending = totalQty - split.accepted - split.repair - split.problem;
  const noPending = pending <= 0;
  const allAccepted = split.accepted === totalQty;
  const hasRepair = split.repair >= 1;
  const hasProblem = split.problem >= 1;

  let railClass = "border-l-4 border-transparent";
  if (hasProblem) railClass = "border-l-4 border-rose";
  else if (hasRepair) railClass = "border-l-4 border-amber";
  else if (allAccepted) railClass = "border-l-4 border-emerald";

  let bgClass = "bg-surface";
  if (hasProblem) bgClass = "bg-rose-soft/30";
  else if (hasRepair) bgClass = "bg-amber-soft/30";
  else if (allAccepted) bgClass = "bg-emerald-soft/30";

  function handleAcceptClick() {
    if (pending === totalQty) onAcceptAll();
    else onIncrement("accepted");
  }

  return (
    <div className={`rounded-lg border border-border p-3 ${railClass} ${bgClass}`}>
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-ink truncate">{name}</div>
          <div className="text-[11px] text-ink-3 mt-0.5">
            осталось пометить {pending} из {totalQty}
          </div>
        </div>
        <div className="flex gap-1 shrink-0">
          {split.accepted > 0 && (
            <button
              type="button"
              onClick={() => onDecrement("accepted")}
              disabled={disabled}
              aria-label={`Снять отметку «Принято» — ${name}`}
              className="rounded-full bg-emerald-soft text-emerald px-2 py-0.5 text-[11px] font-semibold hover:opacity-80"
            >
              ✓ {split.accepted}
            </button>
          )}
          {split.repair > 0 && (
            <button
              type="button"
              onClick={() => onDecrement("repair")}
              disabled={disabled}
              aria-label={`Снять отметку «Ремонт» — ${name}`}
              className="rounded-full bg-amber-soft text-amber px-2 py-0.5 text-[11px] font-semibold hover:opacity-80"
            >
              🔧 {split.repair}
            </button>
          )}
          {split.problem > 0 && (
            <button
              type="button"
              onClick={() => onDecrement("problem")}
              disabled={disabled}
              aria-label={`Снять отметку «Проблема» — ${name}`}
              className="rounded-full bg-rose-soft text-rose px-2 py-0.5 text-[11px] font-semibold hover:opacity-80"
            >
              ✗ {split.problem}
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={handleAcceptClick}
          disabled={disabled || noPending}
          aria-label={`Принять 1 шт — ${name}`}
          className="h-10 rounded border border-emerald-border bg-emerald text-white px-3 text-[12px] font-semibold disabled:opacity-40 hover:opacity-90"
        >
          ✓ Принять 1
        </button>
        <button
          type="button"
          onClick={() => onIncrement("repair")}
          disabled={disabled || noPending}
          aria-label={`В ремонт 1 шт — ${name}`}
          className="h-10 rounded border border-amber-border bg-surface text-amber px-3 text-[12px] font-semibold disabled:opacity-40 hover:bg-amber-soft"
        >
          🔧 Ремонт 1
        </button>
        <button
          type="button"
          onClick={() => onIncrement("problem")}
          disabled={disabled || noPending}
          aria-label={`Проблема 1 шт — ${name}`}
          className="h-10 rounded border border-rose-border bg-surface text-rose px-3 text-[12px] font-semibold disabled:opacity-40 hover:bg-rose-soft"
        >
          ✗ Проблема 1
        </button>
      </div>

      {hasRepair && (
        <div className="mt-3 border-t border-border pt-3">
          <label className="block text-[11px] font-semibold text-amber mb-1">
            🔧 Комментарий ремонта (на все {split.repair} шт)
          </label>
          <textarea
            value={repairComment}
            onChange={(e) => onRepairCommentChange(e.target.value)}
            disabled={disabled}
            aria-label="Комментарий ремонта"
            rows={2}
            className="w-full rounded border border-border-strong bg-surface px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-amber"
            placeholder="Что сломано, что починить"
          />
        </div>
      )}

      {hasProblem && (
        <div className="mt-3 border-t border-border pt-3 space-y-2">
          <label className="block text-[11px] font-semibold text-rose">
            ✗ Проблема (на все {split.problem} шт)
          </label>
          <div className="flex flex-wrap gap-2">
            <select
              value={problem.reason ?? ""}
              onChange={(e) => onProblemPatch({ reason: (e.target.value || null) as any })}
              disabled={disabled}
              aria-label="Причина проблемы"
              className="rounded border border-border bg-surface px-2 py-1 text-[12px]"
            >
              <option value="">— причина —</option>
              <option value="BROKEN">{REASON_LABEL.BROKEN}</option>
              <option value="LOST">{REASON_LABEL.LOST}</option>
              <option value="LEFT_ON_SITE">{REASON_LABEL.LEFT_ON_SITE}</option>
            </select>
            {problem.reason === "LEFT_ON_SITE" && (
              <input
                type="date"
                value={problem.expectedBackDate ?? ""}
                onChange={(e) => onProblemPatch({ expectedBackDate: e.target.value || null })}
                disabled={disabled}
                aria-label="Дата ожидаемого возврата"
                className="rounded border border-border bg-surface px-2 py-1 text-[12px]"
              />
            )}
          </div>
          <textarea
            value={problem.comment}
            onChange={(e) => onProblemPatch({ comment: e.target.value })}
            disabled={disabled}
            aria-label="Комментарий проблемы"
            rows={2}
            className="w-full rounded border border-border-strong bg-surface px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-rose"
            placeholder="Что случилось"
          />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Verify tests pass**

```bash
cd /Users/sechenov/Documents/light-rental-system/apps/web && npx vitest run src/components/warehouse/__tests__/CountSplitRow.test.tsx 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
cd /Users/sechenov/Documents/light-rental-system
git add apps/web/src/components/warehouse/CountSplitRow.tsx apps/web/src/components/warehouse/__tests__/CountSplitRow.test.tsx
git commit -m "feat(web): CountSplitRow — three buckets + pills + inline panels"
```

---

## Task 6: Frontend — wire CountSplitRow into ReturnChecklist

**Files:**
- Modify: `apps/web/src/components/warehouse/ReturnChecklist.tsx`
- Modify: `apps/web/src/components/warehouse/__tests__/ReturnChecklist.test.tsx`

- [ ] **Step 1: Write failing test**

Append to `ReturnChecklist.test.tsx`:

```tsx
it("COUNT row uses CountSplitRow with three buckets (replacing single 'Принято' button)", async () => {
  // setup state with one COUNT-row × 3
  // ... existing mock pattern ...
  render(<ReturnChecklist {...props} />);
  await screen.findByText("Sandbag");
  expect(screen.getByRole("button", { name: /Принять 1 шт — Sandbag/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /В ремонт 1 шт — Sandbag/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Проблема 1 шт — Sandbag/ })).toBeInTheDocument();
});

it("split COUNT row: 1 accepted + 1 repair + 1 problem builds correct payload", async () => {
  vi.mocked(scanApi.complete).mockResolvedValue(/* mock summary */);
  render(<ReturnChecklist {...props} />);
  await screen.findByText("Sandbag");

  // Accept 1
  fireEvent.click(screen.getByRole("button", { name: /Принять 1 шт — Sandbag/ }));
  // Repair 1
  fireEvent.click(screen.getByRole("button", { name: /В ремонт 1 шт — Sandbag/ }));
  fireEvent.change(screen.getByLabelText("Комментарий ремонта"), { target: { value: "Порвался" } });
  // Problem 1
  fireEvent.click(screen.getByRole("button", { name: /Проблема 1 шт — Sandbag/ }));
  fireEvent.change(screen.getByLabelText("Причина проблемы"), { target: { value: "LOST" } });
  fireEvent.change(screen.getByLabelText("Комментарий проблемы"), { target: { value: "Не нашли" } });

  // Submit
  fireEvent.click(screen.getByRole("button", { name: /Завершить приёмку/ }));

  await waitFor(() => expect(scanApi.complete).toHaveBeenCalled());
  const payload = vi.mocked(scanApi.complete).mock.calls[0][1];
  expect(payload.repairUnits).toEqual([
    { bookingItemId: "bi-count", quantity: 1, comment: "Порвался" },
  ]);
  expect(payload.problemUnits).toEqual([
    { bookingItemId: "bi-count", quantity: 1, reason: "LOST", comment: "Не нашли", expectedBackDate: undefined },
  ]);
});

it("validates pending > 0 — blocks submit with row error", async () => {
  render(<ReturnChecklist {...props} />);
  await screen.findByText("Sandbag");
  fireEvent.click(screen.getByRole("button", { name: /Принять 1 шт — Sandbag/ })); // only 1/3 accepted
  fireEvent.click(screen.getByRole("button", { name: /Завершить приёмку/ }));
  await waitFor(() => expect(screen.queryByText(/осталось пометить/i)).toBeInTheDocument());
});
```

(Match the existing fixture shape from earlier tests in the file. If `bookingItemId="bi-count"` doesn't match the mock, use whatever id the existing mock provides.)

- [ ] **Step 2: Run failing test**

- [ ] **Step 3: Refactor ReturnChecklist state**

Replace `const [countAccepted, setCountAccepted] = useState<Set<string>>(new Set());` with:

```ts
const [countSplits, setCountSplits] = useState<Map<string, CountSplit>>(new Map());
const [countRepairComments, setCountRepairComments] = useState<Map<string, string>>(new Map());
const [countProblems, setCountProblems] = useState<Map<string, ProblemDraft>>(new Map());

function getSplit(biId: string): CountSplit {
  return countSplits.get(biId) ?? { accepted: 0, repair: 0, problem: 0 };
}

function bumpSplit(biId: string, bucket: keyof CountSplit, delta: number) {
  setCountSplits((prev) => {
    const cur = prev.get(biId) ?? { accepted: 0, repair: 0, problem: 0 };
    const next = { ...cur, [bucket]: Math.max(0, cur[bucket] + delta) };
    const updated = new Map(prev);
    updated.set(biId, next);
    return updated;
  });
}

function acceptAllOfRow(biId: string, totalQty: number) {
  setCountSplits((prev) => {
    const updated = new Map(prev);
    updated.set(biId, { accepted: totalQty, repair: 0, problem: 0 });
    return updated;
  });
}
```

Replace the `setCountLine` definition and all its callers — the COUNT-row render branch (currently `<UnitRow mode="RETURN" .../>`) becomes:

```tsx
<CountSplitRow
  name={item.equipmentName}
  totalQty={item.quantity}
  split={getSplit(item.bookingItemId)}
  repairComment={countRepairComments.get(item.bookingItemId) ?? ""}
  problem={countProblems.get(item.bookingItemId) ?? { reason: null, comment: "", expectedBackDate: null }}
  disabled={interactionsDisabled}
  onIncrement={(bucket) => bumpSplit(item.bookingItemId, bucket, +1)}
  onDecrement={(bucket) => bumpSplit(item.bookingItemId, bucket, -1)}
  onAcceptAll={() => acceptAllOfRow(item.bookingItemId, item.quantity)}
  onRepairCommentChange={(s) =>
    setCountRepairComments((p) => new Map(p).set(item.bookingItemId, s))
  }
  onProblemPatch={(patch) =>
    setCountProblems((p) => {
      const cur = p.get(item.bookingItemId) ?? { reason: null, comment: "", expectedBackDate: null };
      const next = new Map(p);
      next.set(item.bookingItemId, { ...cur, ...patch });
      return next;
    })
  }
/>
```

Update `computeAcceptedCount`:

```ts
function computeAcceptedCount(
  state: ChecklistState,
  outcomes: OutcomeMap,
  countSplits: Map<string, CountSplit>,
): number {
  let accepted = 0;
  for (const item of state.items) {
    if (item.trackingMode === "UNIT" && item.units) {
      for (const u of item.units) {
        if (outcomes[u.unitId]?.outcome === "ACCEPTED") accepted += 1;
      }
    } else {
      accepted += countSplits.get(item.bookingItemId)?.accepted ?? 0;
    }
  }
  return accepted;
}
```

Update `acceptAll()` (the global button) to set every COUNT-row to `{accepted: bi.quantity, repair: 0, problem: 0}`.

Update validation + payload builder:

```ts
// Before /complete: validation
for (const item of state.items) {
  if (item.trackingMode === "UNIT") continue;
  const s = getSplit(item.bookingItemId);
  const pending = item.quantity - s.accepted - s.repair - s.problem;
  if (pending > 0) {
    setRowErrors((prev) => ({ ...prev, [item.bookingItemId]: `Осталось пометить ${pending} из ${item.quantity}` }));
    setValidationSummary("Не все позиции помечены");
    return;
  }
  if (s.repair > 0 && !(countRepairComments.get(item.bookingItemId) ?? "").trim()) {
    setRowErrors((prev) => ({ ...prev, [item.bookingItemId]: "Введите комментарий ремонта" }));
    setValidationSummary("Заполните комментарий ремонта");
    return;
  }
  if (s.problem > 0) {
    const p = countProblems.get(item.bookingItemId);
    if (!p || !p.reason || !p.comment.trim()) {
      setRowErrors((prev) => ({ ...prev, [item.bookingItemId]: "Заполните данные проблемы" }));
      setValidationSummary("Заполните данные проблемы");
      return;
    }
  }
}

// Payload
const repairUnits: RepairUnitInput[] = [];
const problemUnits: ProblemUnitInput[] = [];
// existing UNIT-mode loop stays unchanged.
for (const item of state.items) {
  if (item.trackingMode === "UNIT") continue;
  const s = getSplit(item.bookingItemId);
  if (s.repair > 0) {
    repairUnits.push({
      bookingItemId: item.bookingItemId,
      quantity: s.repair,
      comment: (countRepairComments.get(item.bookingItemId) ?? "").trim(),
    });
  }
  if (s.problem > 0) {
    const p = countProblems.get(item.bookingItemId)!;
    const entry: ProblemUnitInput = {
      bookingItemId: item.bookingItemId,
      quantity: s.problem,
      reason: p.reason!,
      comment: p.comment.trim(),
    };
    if (p.reason === "LEFT_ON_SITE" && p.expectedBackDate) {
      (entry as any).expectedBackDate = new Date(p.expectedBackDate).toISOString();
    }
    problemUnits.push(entry);
  }
}
```

- [ ] **Step 4: Verify tests pass**

```bash
cd /Users/sechenov/Documents/light-rental-system/apps/web && npx vitest run src/components/warehouse/__tests__/ReturnChecklist.test.tsx 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
cd /Users/sechenov/Documents/light-rental-system
git add apps/web/src/components/warehouse/ReturnChecklist.tsx apps/web/src/components/warehouse/__tests__/ReturnChecklist.test.tsx
git commit -m "feat(web): ReturnChecklist — COUNT-rows use CountSplitRow with split state"
```

---

## Task 7: Frontend — InWorkList + InWorkDetails components

**Files:**
- Create: `apps/web/src/components/warehouse/InWorkList.tsx`
- Create: `apps/web/src/components/warehouse/InWorkDetails.tsx`
- Create: `apps/web/src/components/warehouse/__tests__/InWorkList.test.tsx`
- Create: `apps/web/src/components/warehouse/__tests__/InWorkDetails.test.tsx`

- [ ] **Step 1: Write `InWorkList.test.tsx`**

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { InWorkList } from "../InWorkList";
import { scanApi } from "../api";

vi.mock("../api", () => ({
  scanApi: {
    listInWork: vi.fn(),
  },
}));

describe("InWorkList", () => {
  it("renders booking cards with overdue badge in red", async () => {
    vi.mocked(scanApi.listInWork).mockResolvedValue({
      bookings: [
        { bookingId: "b1", displayNo: "#ABCDEF", projectName: "Юверилка", clientName: "Виталий", issuedAt: "2026-05-19T10:00:00Z", expectedReturnAt: "2026-05-21T10:00:00Z", itemsCount: 17, finalAmount: "5000", isOverdue: true, overdueDays: 1 },
      ],
    });
    const onSelect = vi.fn();
    render(<InWorkList onSelect={onSelect} />);
    await screen.findByText(/Юверилка/);
    expect(screen.getByText(/просрочка/i)).toBeInTheDocument();
    expect(screen.getByText(/17 позиций/)).toBeInTheDocument();
  });

  it("clicking a card calls onSelect with bookingId", async () => {
    vi.mocked(scanApi.listInWork).mockResolvedValue({
      bookings: [
        { bookingId: "b1", displayNo: "#ABCDEF", projectName: "P1", clientName: "C1", issuedAt: null, expectedReturnAt: "2026-06-01T00:00:00Z", itemsCount: 3, finalAmount: "100", isOverdue: false, overdueDays: 0 },
      ],
    });
    const onSelect = vi.fn();
    render(<InWorkList onSelect={onSelect} />);
    await screen.findByText("P1");
    fireEvent.click(screen.getByText("P1"));
    expect(onSelect).toHaveBeenCalledWith("b1");
  });

  it("empty state when no bookings", async () => {
    vi.mocked(scanApi.listInWork).mockResolvedValue({ bookings: [] });
    render(<InWorkList onSelect={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/нет активных выдач/i)).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Implement `InWorkList.tsx`**

```tsx
"use client";

import { useEffect, useState } from "react";
import { scanApi } from "./api";
import type { InWorkBooking } from "./types";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2,"0")}.${String(d.getMonth()+1).padStart(2,"0")}`;
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

export function InWorkList({ onSelect }: { onSelect: (bookingId: string) => void }) {
  const [bookings, setBookings] = useState<InWorkBooking[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    scanApi.listInWork()
      .then((r) => { if (!cancelled) setBookings(r.bookings); })
      .catch((e) => { if (!cancelled) setError(e.message ?? "Ошибка загрузки"); });
    return () => { cancelled = true; };
  }, []);

  if (error) return (
    <div className="rounded-lg border border-rose-border bg-rose-soft px-4 py-3 text-rose">{error}</div>
  );
  if (bookings === null) return (
    <div className="space-y-2">
      {[1,2,3].map((i) => <div key={i} className="h-16 animate-pulse rounded-lg bg-surface-muted" />)}
    </div>
  );
  if (bookings.length === 0) return (
    <p className="text-center text-ink-3 py-12">Нет активных выдач</p>
  );

  return (
    <div className="space-y-2">
      {bookings.map((b) => (
        <button
          key={b.bookingId}
          type="button"
          onClick={() => onSelect(b.bookingId)}
          className={`w-full text-left rounded-lg border px-4 py-3 transition-colors hover:border-accent ${b.isOverdue ? "border-rose-border bg-rose-soft/30" : "border-border bg-surface"}`}
        >
          <div className="flex justify-between items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-[11px] text-ink-3 uppercase tracking-wide">
                {b.displayNo}{b.issuedAt ? ` · взято ${fmtDate(b.issuedAt)}` : ""}
              </p>
              <p className="mt-1 text-sm font-semibold text-ink truncate">{b.projectName}</p>
              <p className="text-[12px] text-ink-2 truncate">{b.clientName}</p>
            </div>
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${b.isOverdue ? "bg-rose text-white" : "bg-amber-soft text-amber"}`}>
              {b.isOverdue
                ? `просрочка ${b.overdueDays} ${plural(b.overdueDays, "день","дня","дней")}`
                : `до ${fmtDate(b.expectedReturnAt)}`}
            </span>
          </div>
          <p className="mt-2 text-[12px] text-ink-3">{b.itemsCount} {plural(b.itemsCount, "позиция","позиции","позиций")}</p>
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Write `InWorkDetails.test.tsx`**

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { InWorkDetails } from "../InWorkDetails";
import { scanApi } from "../api";

vi.mock("../api", () => ({
  scanApi: { getInWorkDetails: vi.fn() },
}));

describe("InWorkDetails", () => {
  it("renders booking items + finance + «← Принять обратно» button", async () => {
    vi.mocked(scanApi.getInWorkDetails).mockResolvedValue({
      bookingId: "b1", displayNo: "#ABC123",
      projectName: "Test project", clientName: "Test client",
      issuedAt: "2026-05-19T10:00:00Z",
      expectedReturnAt: "2026-05-25T10:00:00Z",
      items: [
        { bookingItemId: "bi1", equipmentId: "e1", equipmentName: "Item A", category: "Cat", quantity: 3, trackingMode: "COUNT" },
      ],
      finance: { mainAfterDiscount: "5000", addonAfterDiscount: "0", finalAmount: "5000", amountPaid: "0", outstanding: "5000", paymentStatus: "NOT_PAID" },
    });
    const onAcceptBack = vi.fn();
    render(<InWorkDetails bookingId="b1" onAcceptBack={onAcceptBack} onBack={vi.fn()} />);
    await screen.findByText("Test project");
    expect(screen.getByText("Item A")).toBeInTheDocument();
    expect(screen.getByText(/×3/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Принять обратно/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 4: Implement `InWorkDetails.tsx`**

```tsx
"use client";

import { useEffect, useState } from "react";
import { scanApi } from "./api";
import { formatRub } from "../../lib/format";
import type { InWorkDetails as InWorkDetailsT } from "./types";

interface Props {
  bookingId: string;
  onAcceptBack: (bookingId: string) => void;
  onBack: () => void;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2,"0")}.${String(d.getMonth()+1).padStart(2,"0")}.${d.getFullYear()}`;
}

export function InWorkDetails({ bookingId, onAcceptBack, onBack }: Props) {
  const [data, setData] = useState<InWorkDetailsT | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    scanApi.getInWorkDetails(bookingId)
      .then((r) => { if (!cancelled) setData(r); })
      .catch((e) => { if (!cancelled) setError(e.message ?? "Ошибка"); });
    return () => { cancelled = true; };
  }, [bookingId]);

  if (error) return <div className="rounded-lg border border-rose-border bg-rose-soft px-4 py-3 text-rose">{error}</div>;
  if (!data) return <div className="h-32 animate-pulse rounded-lg bg-surface-muted" />;

  return (
    <div className="space-y-4">
      <button type="button" onClick={onBack} className="text-[12px] text-accent hover:underline">
        ← К списку «В работе»
      </button>

      <div>
        <p className="text-[11px] text-ink-3 uppercase tracking-wide">{data.displayNo}</p>
        <h2 className="text-lg font-semibold text-ink mt-1">{data.projectName}</h2>
        <p className="text-[13px] text-ink-2">{data.clientName}</p>
        <p className="text-[12px] text-ink-3 mt-2">
          Выдано: {fmtDate(data.issuedAt)} · Ожидаемый возврат: {fmtDate(data.expectedReturnAt)}
        </p>
      </div>

      <section>
        <h3 className="text-[13px] font-semibold text-ink mb-2">Оборудование ({data.items.length})</h3>
        <ul className="space-y-1">
          {data.items.map((it) => (
            <li key={it.bookingItemId} className="flex items-baseline justify-between rounded border border-border bg-surface px-3 py-2 text-[13px]">
              <span className="truncate">{it.equipmentName}</span>
              <span className="text-ink-3 ml-2 shrink-0">×{it.quantity}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-lg border border-border bg-surface-subtle p-3 text-[13px]">
        <h3 className="text-[12px] font-semibold text-ink mb-2">Финансы</h3>
        <dl className="space-y-1">
          <div className="flex justify-between"><dt className="text-ink-2">Согласовано</dt><dd>{formatRub(data.finance.mainAfterDiscount)}</dd></div>
          {Number(data.finance.addonAfterDiscount) > 0 && (
            <div className="flex justify-between"><dt className="text-ink-2">+ Доб-смета</dt><dd>{formatRub(data.finance.addonAfterDiscount)}</dd></div>
          )}
          <div className="flex justify-between font-semibold"><dt>К оплате</dt><dd>{formatRub(data.finance.finalAmount)}</dd></div>
          <div className="flex justify-between"><dt className="text-ink-2">Оплачено</dt><dd>{formatRub(data.finance.amountPaid)}</dd></div>
          {Number(data.finance.outstanding) > 0 && (
            <div className="flex justify-between text-rose"><dt>Остаток</dt><dd>{formatRub(data.finance.outstanding)}</dd></div>
          )}
        </dl>
      </section>

      <button
        type="button"
        onClick={() => onAcceptBack(data.bookingId)}
        className="block w-full rounded-lg bg-accent px-4 py-3 text-center text-sm font-semibold text-white hover:opacity-95"
      >
        ← Принять обратно
      </button>
    </div>
  );
}
```

- [ ] **Step 5: Verify tests pass**

```bash
cd /Users/sechenov/Documents/light-rental-system/apps/web && npx vitest run src/components/warehouse/__tests__/InWorkList.test.tsx src/components/warehouse/__tests__/InWorkDetails.test.tsx 2>&1 | tail -5
```

- [ ] **Step 6: Commit**

```bash
cd /Users/sechenov/Documents/light-rental-system
git add apps/web/src/components/warehouse/InWorkList.tsx apps/web/src/components/warehouse/InWorkDetails.tsx apps/web/src/components/warehouse/__tests__/InWorkList.test.tsx apps/web/src/components/warehouse/__tests__/InWorkDetails.test.tsx
git commit -m "feat(web): InWorkList + InWorkDetails — В работе tab components"
```

---

## Task 8: Frontend — wire 3rd tab into /warehouse/scan page

**Files:**
- Modify: `apps/web/app/warehouse/scan/page.tsx` (and/or whichever page-level state machine drives the two-tab UI)

- [ ] **Step 1: Inspect current tab/state machine**

```bash
grep -n "operation\|ISSUE\|RETURN\|setOperation" /Users/sechenov/Documents/light-rental-system/apps/web/app/warehouse/scan/page.tsx | head -20
```

Find the existing `operation: "ISSUE" | "RETURN"` state and render tree.

- [ ] **Step 2: Add `"IN_WORK"` variant**

Change state type:

```ts
type Operation = "ISSUE" | "RETURN" | "IN_WORK";
```

Render the third tab:

```tsx
<button onClick={() => setOperation("IN_WORK")} ...>В работе</button>
```

Render branch:

```tsx
{operation === "IN_WORK" && (
  selectedBookingId
    ? <InWorkDetails
        bookingId={selectedBookingId}
        onAcceptBack={(bid) => {
          // Transition: create-or-resume RETURN session for this booking, set selected, switch tab.
          setOperation("RETURN");
          setSelectedBookingId(bid);
          // ensure session creation downstream follows existing RETURN flow
        }}
        onBack={() => setSelectedBookingId(null)}
      />
    : <InWorkList onSelect={(bid) => setSelectedBookingId(bid)} />
)}
```

If the existing page uses URL-state instead of local state, mirror that pattern.

- [ ] **Step 3: Run web typecheck + full web suite**

```bash
cd /Users/sechenov/Documents/light-rental-system/apps/web && npx tsc -p tsconfig.json --noEmit 2>&1 | tail -3 && npm test 2>&1 | tail -5
```

Expected: clean + all tests pass.

- [ ] **Step 4: Commit**

```bash
cd /Users/sechenov/Documents/light-rental-system
git add apps/web/app/warehouse/scan/
git commit -m "feat(web): /warehouse/scan — третья tab «В работе»"
```

---

## Task 9: Integration test — full COUNT-split RETURN flow

**Files:**
- Create: `apps/api/src/__tests__/returnCountSplitFlow.test.ts`

- [ ] **Step 1: Write the integration test**

```ts
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import path from "path";
import { execSync } from "child_process";
import request from "supertest";

const TEST_DB = path.resolve(__dirname, "../../prisma/test-return-count-split-flow.db");
process.env.DATABASE_URL = `file:${TEST_DB}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.NODE_ENV = "test";
process.env.WAREHOUSE_SECRET = "test-wh-flow-min16chars000";
process.env.JWT_SECRET = "test-jwt-flow-min16chars00000";

let prisma: any;
let app: any;
let warehouseToken: string;
let bookingId: string;
let sessionId: string;
let bookingItemId: string;

beforeAll(async () => {
  execSync(`rm -f ${TEST_DB}`);
  execSync("npx prisma db push --skip-generate --force-reset", {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, DATABASE_URL: `file:${TEST_DB}`, PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes" },
    stdio: "pipe",
  });
  const pmod = await import("../prisma");
  prisma = pmod.prisma;
  const { app: expressApp } = await import("../app");
  app = expressApp;

  const { hashPin } = await import("../services/warehouseAuth");
  await prisma.warehousePin.create({ data: { name: "Test", pinHash: await hashPin("1234"), isActive: true } });
  const r = await request(app).post("/api/warehouse/auth").send({ name: "Test", pin: "1234" });
  warehouseToken = r.body.token;

  const client = await prisma.client.create({ data: { name: "C", phone: "+7000" } });
  const eq = await prisma.equipment.create({ data: { importKey: "f-eq", name: "Sandbag", category: "Acc", rentalRatePerShift: "100", totalQuantity: 10 } });
  const b = await prisma.booking.create({
    data: { clientId: client.id, projectName: "Flow", startDate: new Date(), endDate: new Date(Date.now()+86400000),
      status: "ISSUED", issuedAt: new Date(),
      items: { create: [{ equipmentId: eq.id, quantity: 3 }] },
    },
    include: { items: true },
  });
  bookingId = b.id;
  bookingItemId = b.items[0].id;
  const s = await prisma.scanSession.create({ data: { bookingId, workerName: "Test", operation: "RETURN", status: "ACTIVE" } });
  sessionId = s.id;
});

afterAll(async () => { await prisma?.$disconnect?.(); });

describe("RETURN COUNT-split flow", () => {
  it("POST /complete with 1 accepted + 1 repair + 1 problem → Repair + ProblemItem rows created", async () => {
    const res = await request(app)
      .post(`/api/warehouse/sessions/${sessionId}/complete`)
      .set("Authorization", `Bearer ${warehouseToken}`)
      .send({
        repairUnits: [{ bookingItemId, quantity: 1, comment: "Порвался шов" }],
        problemUnits: [{ bookingItemId, quantity: 1, reason: "LOST", comment: "Не нашли на возврате" }],
      });
    expect(res.status).toBe(200);

    const repairs = await prisma.repair.findMany({ where: { bookingItemId } });
    expect(repairs).toHaveLength(1);
    expect(repairs[0].unitId).toBeNull();
    expect(repairs[0].quantity).toBe(1);

    const problems = await prisma.problemItem.findMany({ where: { bookingItemId } });
    expect(problems).toHaveLength(1);
    expect(problems[0].equipmentUnitId).toBeNull();
    expect(problems[0].reason).toBe("LOST");
  });

  it("after /complete booking has status RETURNED", async () => {
    const fresh = await prisma.booking.findUnique({ where: { id: bookingId } });
    expect(fresh.status).toBe("RETURNED");
  });
});
```

- [ ] **Step 2: Run + commit**

```bash
cd /Users/sechenov/Documents/light-rental-system/apps/api && npx vitest run src/__tests__/returnCountSplitFlow.test.ts 2>&1 | tail -5
cd /Users/sechenov/Documents/light-rental-system
git add apps/api/src/__tests__/returnCountSplitFlow.test.ts
git commit -m "test(api): integration — RETURN COUNT-split flow end-to-end"
```

---

## Task 10: Sweep + PR + deploy

- [ ] **Step 1: Full backend sweep**

```bash
cd /Users/sechenov/Documents/light-rental-system && npm test -w apps/api 2>&1 | tail -5
```

Expected: all pass.

- [ ] **Step 2: Full frontend sweep**

```bash
npm test -w apps/web 2>&1 | tail -5
```

- [ ] **Step 3: Typecheck both**

```bash
cd apps/api && npx tsc -p tsconfig.json --noEmit && cd ../web && npx tsc -p tsconfig.json --noEmit
```

- [ ] **Step 4: Push + PR**

```bash
cd /Users/sechenov/Documents/light-rental-system
git push "https://sechenoff:$(gh auth token)@github.com/sechenoff/Light.git" feat/return-count-split-and-in-work:feat/return-count-split-and-in-work
git fetch origin feat/return-count-split-and-in-work
gh pr create --head feat/return-count-split-and-in-work \
  --title "feat(warehouse): COUNT-split на приёмке + «В работе» tab" \
  --body "$(cat docs/superpowers/specs/2026-05-22-return-count-split-and-in-work.md | head -60)"
```

- [ ] **Step 5: Squash-merge**

```bash
PR=$(gh pr list --head feat/return-count-split-and-in-work --json number --jq '.[0].number')
gh pr merge $PR --squash --subject "feat(warehouse): COUNT-split + «В работе» (#$PR)"
```

- [ ] **Step 6: Watch deploy**

```bash
RUN_ID=$(gh run list --branch main --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch $RUN_ID --interval 10 --exit-status 2>&1 | tail -8
```

- [ ] **Step 7: Cleanup + prod smoke**

```bash
git checkout main && git pull --ff-only origin main
git branch -D feat/return-count-split-and-in-work
curl -s -o /dev/null -w "%{http_code}\n" https://svetobazarent.ru/warehouse/scan
```

---

## Self-review checklist

- [x] Spec coverage:
  - §3.1 COUNT split row: Tasks 4, 5, 6
  - §3.2 Reversible accept via pill click: Task 5 (onDecrement)
  - §3.3 Repair/Problem inline panels for COUNT: Task 5 + Task 6
  - §3.4 «В работе» tab placement: Task 8
  - §3.5 In-work card layout: Task 7
  - §4 API contracts: Tasks 2, 3
  - §5 Schema migration: Task 1
  - §7 Edge cases (INVALID_SPLIT validation, pending>0 block): Task 2 + Task 6
  - §8 Testing: Tasks 2, 3, 5, 6, 7, 9
- [x] No TBD/TODO in any step.
- [x] Type names consistent: `CountSplit`, `RepairUnitInput`, `ProblemUnitInput`, `InWorkBooking`, `InWorkDetails`.
- [x] Function names consistent: `bumpSplit`, `acceptAllOfRow`, `getSplit`, `computeAcceptedCount`.
- [x] Audit codes referenced consistently (reuse existing UNIT-mode codes).
