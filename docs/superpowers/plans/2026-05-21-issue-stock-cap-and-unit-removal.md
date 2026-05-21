# Issue-time stock cap and unit removal — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the unbounded-добор bug and add per-row stepper «Выдать N из M» to IssueChecklist so warehouse operators can remove broken/missing items on the spot.

**Architecture:**
- Backend hard cap in `addExtraItem` (no over-stock); `/addon/search` returns `addCap` so the UI shows real maximum.
- Per-row stepper [0..M] in `IssueChecklist`; adjustments held in local state, applied batched in `/complete`.
- `completeSession` extends with optional `issuanceAdjustments`; recreates MAIN-смета and recomputes finances; OVERPAID is a new payment status.

**Tech Stack:** Prisma 6 (SQLite), Express + TypeScript, React 18, Next.js 14, Vitest, decimal.js, ExcelJS, PDFKit.

**Spec:** `docs/superpowers/specs/2026-05-21-issue-stock-cap-and-unit-removal-design.md`

---

## Task 1: Schema — add OVERPAID to BookingPaymentStatus enum

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<timestamp>_add_overpaid_status/migration.sql` (auto-generated)

- [ ] **Step 1: Edit `apps/api/prisma/schema.prisma`**

Find the enum at line ~24:

```prisma
enum BookingPaymentStatus {
  NOT_PAID
  PARTIALLY_PAID
  PAID
  OVERDUE
}
```

Change to:

```prisma
enum BookingPaymentStatus {
  NOT_PAID
  PARTIALLY_PAID
  PAID
  OVERDUE
  OVERPAID
}
```

- [ ] **Step 2: Generate migration**

```bash
cd apps/api && npx prisma migrate dev --name add_overpaid_status
```

Expected: new directory `prisma/migrations/<timestamp>_add_overpaid_status/` with `migration.sql` that recreates the `Booking` table with the expanded CHECK constraint (SQLite enum handling).

- [ ] **Step 3: Regenerate Prisma client**

Already happens via `migrate dev`. Verify by typechecking:

```bash
cd apps/api && npx tsc -p tsconfig.json --noEmit
```

Expected: no errors. The TS type `BookingPaymentStatus` now includes `"OVERPAID"`.

- [ ] **Step 4: Commit**

```bash
cd /Users/sechenov/Documents/light-rental-system
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/
git commit -m "feat(api): schema — add OVERPAID to BookingPaymentStatus enum"
```

---

## Task 2: `calcBookingPaymentStatus` — OVERPAID branch

**Files:**
- Modify: `apps/api/src/services/finance.ts`
- Test: `apps/api/src/services/__tests__/finance.test.ts` (create if absent)

- [ ] **Step 1: Find existing finance.test.ts or create**

```bash
ls apps/api/src/services/__tests__/finance.test.ts 2>&1
```

If file does not exist, create the skeleton:

```ts
import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { calcBookingPaymentStatus } from "../finance";

describe("calcBookingPaymentStatus", () => {
  // tests here
});
```

- [ ] **Step 2: Write failing test for OVERPAID**

Append inside `describe`:

```ts
it("returns OVERPAID when amountPaid > finalAmount (strict greater)", () => {
  const status = calcBookingPaymentStatus({
    finalAmount: new Decimal(3500),
    amountPaid: new Decimal(5000),
    expectedPaymentDate: null,
  });
  expect(status).toBe("OVERPAID");
});

it("OVERPAID has priority over OVERDUE when paid > final", () => {
  const past = new Date(Date.now() - 86400000);
  const status = calcBookingPaymentStatus({
    finalAmount: new Decimal(3500),
    amountPaid: new Decimal(5000),
    expectedPaymentDate: past,
  });
  expect(status).toBe("OVERPAID");
});

it("returns PAID (not OVERPAID) when amountPaid === finalAmount", () => {
  const status = calcBookingPaymentStatus({
    finalAmount: new Decimal(3500),
    amountPaid: new Decimal(3500),
    expectedPaymentDate: null,
  });
  expect(status).toBe("PAID");
});
```

- [ ] **Step 3: Run tests, verify the new ones fail**

```bash
cd apps/api && npx vitest run src/services/__tests__/finance.test.ts -t OVERPAID
```

Expected: 3 FAIL (current code returns "PAID" because `fullyPaid` uses `>=`).

- [ ] **Step 4: Modify `calcBookingPaymentStatus`**

In `apps/api/src/services/finance.ts`, replace the body of `calcBookingPaymentStatus`:

```ts
export function calcBookingPaymentStatus(args: {
  finalAmount: Decimal;
  amountPaid: Decimal;
  expectedPaymentDate: Date | null;
  now?: Date;
}): BookingPaymentStatus {
  const now = args.now ?? new Date();
  const final = args.finalAmount;
  const paid = args.amountPaid;
  // OVERPAID has top priority — independent of due date.
  if (paid.greaterThan(final) && final.greaterThan(0)) return "OVERPAID";
  const fullyPaid = paid.greaterThanOrEqualTo(final) || final.lessThanOrEqualTo(0);
  if (fullyPaid) return "PAID";
  const isOverdue = !!args.expectedPaymentDate && args.expectedPaymentDate.getTime() < now.getTime();
  if (isOverdue) return "OVERDUE";
  if (paid.greaterThan(0)) return "PARTIALLY_PAID";
  return "NOT_PAID";
}
```

- [ ] **Step 5: Run tests, verify they pass**

```bash
cd apps/api && npx vitest run src/services/__tests__/finance.test.ts
```

Expected: all PASS (including existing tests).

- [ ] **Step 6: Commit**

```bash
cd /Users/sechenov/Documents/light-rental-system
git add apps/api/src/services/finance.ts apps/api/src/services/__tests__/finance.test.ts
git commit -m "feat(api): calcBookingPaymentStatus — OVERPAID branch when paid > finalAmount"
```

---

## Task 3: `recreateMainEstimate` helper

**Files:**
- Create: `apps/api/src/services/mainEstimate.ts`
- Create: `apps/api/src/services/__tests__/mainEstimate.test.ts`

**Context:** Mirror of `recomputeAddonEstimate`. Deletes existing MAIN Estimate, rebuilds from current `BookingItem.quantity > 0`, preserves `discountPercent`.

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import path from "path";
import { execSync } from "child_process";

const TEST_DB = path.resolve(__dirname, "../../../prisma/test-main-estimate.db");
process.env.DATABASE_URL = `file:${TEST_DB}`;

let prisma: PrismaClient;
let bookingId: string;
let eq1: string;
let eq2: string;

describe("recreateMainEstimate", () => {
  beforeEach(async () => {
    execSync(`rm -f ${TEST_DB}`);
    execSync("npx prisma migrate deploy", { cwd: path.resolve(__dirname, "../../..") });
    prisma = new PrismaClient();

    const e1 = await prisma.equipment.create({
      data: { name: "Aputure", category: "COB", totalQuantity: 5, dailyPrice: "1000", stockTrackingMode: "COUNT" },
    });
    eq1 = e1.id;
    const e2 = await prisma.equipment.create({
      data: { name: "Astera", category: "LED", totalQuantity: 3, dailyPrice: "500", stockTrackingMode: "COUNT" },
    });
    eq2 = e2.id;

    const b = await prisma.booking.create({
      data: {
        clientName: "Test",
        projectName: "Proj",
        startDate: new Date("2026-06-01"),
        endDate: new Date("2026-06-02"),
        status: "CONFIRMED",
        finalAmount: "0",
        amountPaid: "0",
        items: { create: [
          { equipmentId: eq1, quantity: 2 },
          { equipmentId: eq2, quantity: 1 },
        ]},
        estimates: { create: { kind: "MAIN", discountPercent: "10", subtotal: "2500", totalAfterDiscount: "2250", shifts: 1, lines: { create: [
          { equipmentId: eq1, quantity: 2, unitPrice: "1000", shifts: 1, lineSum: "2000" },
          { equipmentId: eq2, quantity: 1, unitPrice: "500", shifts: 1, lineSum: "500" },
        ]}}},
      },
    });
    bookingId = b.id;
  });

  afterEach(async () => { await prisma.$disconnect(); });

  it("recreates MAIN from current BookingItem quantities, preserving discountPercent", async () => {
    const { recreateMainEstimate } = await import("../mainEstimate");
    // Simulate adjustment: reduce eq1 from 2 to 1
    await prisma.bookingItem.updateMany({ where: { bookingId, equipmentId: eq1 }, data: { quantity: 1 } });

    await recreateMainEstimate(bookingId);

    const main = await prisma.estimate.findFirst({ where: { bookingId, kind: "MAIN" }, include: { lines: true } });
    expect(main).not.toBeNull();
    expect(main!.discountPercent.toString()).toBe("10");
    expect(main!.lines).toHaveLength(2);
    const eq1Line = main!.lines.find((l) => l.equipmentId === eq1)!;
    expect(eq1Line.quantity).toBe(1);
    expect(eq1Line.lineSum.toString()).toBe("1000");
    expect(main!.subtotal.toString()).toBe("1500");
    expect(main!.totalAfterDiscount.toString()).toBe("1350");
  });

  it("skips BookingItems with quantity=0", async () => {
    const { recreateMainEstimate } = await import("../mainEstimate");
    await prisma.bookingItem.updateMany({ where: { bookingId, equipmentId: eq2 }, data: { quantity: 0 } });

    await recreateMainEstimate(bookingId);

    const main = await prisma.estimate.findFirst({ where: { bookingId, kind: "MAIN" }, include: { lines: true } });
    expect(main!.lines).toHaveLength(1);
    expect(main!.lines[0].equipmentId).toBe(eq1);
  });

  it("is idempotent — second call yields same result", async () => {
    const { recreateMainEstimate } = await import("../mainEstimate");
    await recreateMainEstimate(bookingId);
    const first = await prisma.estimate.findFirst({ where: { bookingId, kind: "MAIN" }, include: { lines: true } });
    await recreateMainEstimate(bookingId);
    const second = await prisma.estimate.findFirst({ where: { bookingId, kind: "MAIN" }, include: { lines: true } });
    expect(second!.totalAfterDiscount.toString()).toBe(first!.totalAfterDiscount.toString());
    expect(second!.lines).toHaveLength(first!.lines.length);
  });
});
```

- [ ] **Step 2: Run test, verify fails (import resolves to nothing)**

```bash
cd apps/api && npx vitest run src/services/__tests__/mainEstimate.test.ts
```

Expected: FAIL ("Cannot find module '../mainEstimate'").

- [ ] **Step 3: Create `apps/api/src/services/mainEstimate.ts`**

```ts
import Decimal from "decimal.js";
import { prisma } from "../prisma";

/**
 * Пересоздаёт MAIN Estimate брони из текущих BookingItem с quantity > 0.
 * Сохраняет discountPercent существующей MAIN-сметы (если она есть, иначе 0).
 * Зеркало recomputeAddonEstimate. delete-then-create snapshot в транзакции.
 *
 * No-op если бронь не существует или у неё нет BookingItem с quantity > 0
 * (в этом случае MAIN тоже удаляется как «пустая смета»).
 */
export async function recreateMainEstimate(bookingId: string): Promise<void> {
  const [booking, existingMain, items] = await Promise.all([
    prisma.booking.findUnique({ where: { id: bookingId }, select: { startDate: true, endDate: true } }),
    prisma.estimate.findFirst({ where: { bookingId, kind: "MAIN" }, select: { discountPercent: true, shifts: true } }),
    prisma.bookingItem.findMany({
      where: { bookingId, quantity: { gt: 0 } },
      include: { equipment: true },
    }),
  ]);

  if (!booking) return;

  const discountPercent = existingMain ? new Decimal(existingMain.discountPercent.toString()) : new Decimal(0);
  // Количество смен: если у существующей MAIN было shifts > 0, используем его; иначе считаем 1 сутки.
  const shifts = existingMain && existingMain.shifts > 0 ? existingMain.shifts : 1;

  const lines = items.map((bi) => {
    const unitPrice = new Decimal(bi.equipment.dailyPrice.toString());
    const lineSum = unitPrice.mul(bi.quantity).mul(shifts);
    return {
      equipmentId: bi.equipmentId,
      quantity: bi.quantity,
      unitPrice: unitPrice.toString(),
      shifts,
      lineSum: lineSum.toString(),
    };
  });

  const subtotal = lines.reduce((acc, l) => acc.add(new Decimal(l.lineSum)), new Decimal(0));
  const discount = subtotal.mul(discountPercent).div(100);
  const totalAfterDiscount = subtotal.sub(discount);

  await prisma.$transaction(async (tx) => {
    await tx.estimate.deleteMany({ where: { bookingId, kind: "MAIN" } });
    if (lines.length === 0) return;
    await tx.estimate.create({
      data: {
        bookingId,
        kind: "MAIN",
        discountPercent: discountPercent.toString(),
        shifts,
        subtotal: subtotal.toString(),
        totalAfterDiscount: totalAfterDiscount.toString(),
        lines: { create: lines },
      },
    });
  });
}
```

- [ ] **Step 4: Verify tests pass**

```bash
cd apps/api && npx vitest run src/services/__tests__/mainEstimate.test.ts
```

Expected: 3/3 PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/sechenov/Documents/light-rental-system
git add apps/api/src/services/mainEstimate.ts apps/api/src/services/__tests__/mainEstimate.test.ts
git commit -m "feat(api): recreateMainEstimate service + tests"
```

---

## Task 4: `recomputeAddonEstimate` — switch to «BookingItem.quantity − MAIN.line.qty» formula

**Files:**
- Modify: `apps/api/src/services/addonEstimate.ts`
- Modify: `apps/api/src/services/__tests__/addonEstimate.test.ts` (extend)

**Why:** With per-row adjustment, AddonRecord-based aggregation goes stale (it accumulates raw deltas without knowing later reductions). New formula reads truth from current `BookingItem.quantity − MAIN.line.qty`.

- [ ] **Step 1: Read current implementation to understand starting point**

```bash
cat apps/api/src/services/addonEstimate.ts | head -80
```

Note: Note the current formula. We are replacing it.

- [ ] **Step 2: Write failing test «ADDON = quantity − MAIN.line.qty»**

Append in `apps/api/src/services/__tests__/addonEstimate.test.ts`:

```ts
it("uses formula addonQty = max(0, BookingItem.quantity − MAIN.line.qty)", async () => {
  // Setup: bookingItem qty=5, MAIN line says 3 → ADDON should have qty=2
  const booking = await seedBookingWithMain({ equipmentId: eq1, mainQty: 3, totalBookingItemQty: 5 });
  await recomputeAddonEstimate(booking.id);
  const addon = await prisma.estimate.findFirst({ where: { bookingId: booking.id, kind: "ADDON" }, include: { lines: true } });
  expect(addon!.lines[0].quantity).toBe(2);
});

it("emits no ADDON when BookingItem.quantity <= MAIN.line.qty", async () => {
  const booking = await seedBookingWithMain({ equipmentId: eq1, mainQty: 3, totalBookingItemQty: 3 });
  await recomputeAddonEstimate(booking.id);
  const addon = await prisma.estimate.findFirst({ where: { bookingId: booking.id, kind: "ADDON" } });
  expect(addon).toBeNull();
});

it("emits ADDON for equipment NOT in MAIN — full quantity counts as addon", async () => {
  const booking = await seedBookingWithMain({ equipmentId: eq1, mainQty: 3, totalBookingItemQty: 3 });
  // Add a new bookingItem NOT in MAIN
  await prisma.bookingItem.create({ data: { bookingId: booking.id, equipmentId: eq2, quantity: 2 } });
  await recomputeAddonEstimate(booking.id);
  const addon = await prisma.estimate.findFirst({ where: { bookingId: booking.id, kind: "ADDON" }, include: { lines: true } });
  expect(addon!.lines).toHaveLength(1);
  expect(addon!.lines[0].equipmentId).toBe(eq2);
  expect(addon!.lines[0].quantity).toBe(2);
});
```

Helper `seedBookingWithMain` — create it at the top of the file if absent (mirror existing test helpers).

- [ ] **Step 3: Run tests, verify failures**

```bash
cd apps/api && npx vitest run src/services/__tests__/addonEstimate.test.ts
```

Expected: the 3 new tests FAIL with wrong quantities.

- [ ] **Step 4: Modify `addonEstimate.ts`**

Replace the body of `recomputeAddonEstimate` so it aggregates from `BookingItem.quantity − MAIN.line.qty`:

```ts
export async function recomputeAddonEstimate(bookingId: string): Promise<void> {
  const main = await prisma.estimate.findFirst({
    where: { bookingId, kind: "MAIN" },
    include: { lines: true },
  });
  if (!main) return;

  const items = await prisma.bookingItem.findMany({
    where: { bookingId, quantity: { gt: 0 } },
    include: { equipment: true },
  });

  const mainQtyByEquipment = new Map<string, number>();
  for (const line of main.lines) {
    if (line.equipmentId) {
      mainQtyByEquipment.set(line.equipmentId, line.quantity);
    }
  }

  const discountPercent = new Decimal(main.discountPercent.toString());
  const shifts = main.shifts > 0 ? main.shifts : 1;

  type AddonLine = { equipmentId: string; quantity: number; unitPrice: string; shifts: number; lineSum: string };
  const lines: AddonLine[] = [];
  for (const bi of items) {
    const inMain = mainQtyByEquipment.get(bi.equipmentId) ?? 0;
    const addonQty = bi.quantity - inMain;
    if (addonQty <= 0) continue;
    const unitPrice = new Decimal(bi.equipment.dailyPrice.toString());
    const lineSum = unitPrice.mul(addonQty).mul(shifts);
    lines.push({
      equipmentId: bi.equipmentId,
      quantity: addonQty,
      unitPrice: unitPrice.toString(),
      shifts,
      lineSum: lineSum.toString(),
    });
  }

  const subtotal = lines.reduce((acc, l) => acc.add(new Decimal(l.lineSum)), new Decimal(0));
  const discount = subtotal.mul(discountPercent).div(100);
  const totalAfterDiscount = subtotal.sub(discount);

  await prisma.$transaction(async (tx) => {
    await tx.estimate.deleteMany({ where: { bookingId, kind: "ADDON" } });
    if (lines.length === 0) return;
    await tx.estimate.create({
      data: {
        bookingId,
        kind: "ADDON",
        discountPercent: discountPercent.toString(),
        shifts,
        subtotal: subtotal.toString(),
        totalAfterDiscount: totalAfterDiscount.toString(),
        lines: { create: lines },
      },
    });
  });
}
```

- [ ] **Step 5: Verify tests pass**

```bash
cd apps/api && npx vitest run src/services/__tests__/addonEstimate.test.ts
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/sechenov/Documents/light-rental-system
git add apps/api/src/services/addonEstimate.ts apps/api/src/services/__tests__/addonEstimate.test.ts
git commit -m "feat(api): recomputeAddonEstimate uses BookingItem.quantity − MAIN.line.qty"
```

---

## Task 5: `addExtraItem` — hard cap with `addCap`

**Files:**
- Modify: `apps/api/src/services/checklistService.ts:347-434` (function body of `addExtraItem`)
- Modify: `apps/api/src/services/__tests__/checklistService.test.ts` (extend)

- [ ] **Step 1: Find existing checklistService test patterns**

```bash
grep -n "describe.*addExtraItem\|seedBooking" apps/api/src/services/__tests__/checklistService.test.ts | head -10
```

Note the existing seed helpers and the `describe("addExtraItem")` block.

- [ ] **Step 2: Write failing test for hard cap**

Append inside `describe("addExtraItem")`:

```ts
it("rejects with 409 ADDON_OVER_STOCK when quantity exceeds addCap", async () => {
  // Setup: equipment totalQty=5, current booking has BookingItem.quantity=4
  await prisma.bookingItem.upsert({
    where: { bookingId_equipmentId: { bookingId, equipmentId } },
    update: { quantity: 4 },
    create: { bookingId, equipmentId, quantity: 4 },
  });
  // addCap = 5 − 0 (no other bookings) − 4 (alreadyMine) = 1
  // Requesting 2 must fail.
  await expect(addExtraItem(sessionId, equipmentId, 2, "ivan")).rejects.toMatchObject({
    status: 409,
    code: "ADDON_OVER_STOCK",
    details: { addCap: 1, requested: 2, alreadyInBooking: 4 },
  });
});

it("allows quantity exactly equal to addCap", async () => {
  await prisma.bookingItem.upsert({
    where: { bookingId_equipmentId: { bookingId, equipmentId } },
    update: { quantity: 4 },
    create: { bookingId, equipmentId, quantity: 4 },
  });
  const result = await addExtraItem(sessionId, equipmentId, 1, "ivan");
  expect(result.bookingItemId).toBeDefined();
  const bi = await prisma.bookingItem.findUnique({ where: { bookingId_equipmentId: { bookingId, equipmentId } } });
  expect(bi!.quantity).toBe(5);
});

it("second consecutive add fails when addCap exhausted", async () => {
  await prisma.bookingItem.upsert({
    where: { bookingId_equipmentId: { bookingId, equipmentId } },
    update: { quantity: 3 },
    create: { bookingId, equipmentId, quantity: 3 },
  });
  // addCap=2; first add of 2 succeeds, second add of 1 fails (addCap=0).
  await addExtraItem(sessionId, equipmentId, 2, "ivan");
  await expect(addExtraItem(sessionId, equipmentId, 1, "ivan")).rejects.toMatchObject({
    status: 409,
    code: "ADDON_OVER_STOCK",
  });
});
```

- [ ] **Step 3: Run tests, verify failures**

```bash
cd apps/api && npx vitest run src/services/__tests__/checklistService.test.ts -t addExtraItem
```

Expected: 3 new tests FAIL (current code does not check stock).

- [ ] **Step 4: Modify `addExtraItem` to add hard cap**

In `apps/api/src/services/checklistService.ts`, inside the `prisma.$transaction` callback in `addExtraItem`, **right before** `tx.bookingItem.upsert(...)`:

```ts
// Hard cap: запрещаем превысить физический склад. addCap считается
// внутри транзакции для защиты от race condition (SQLite serialize-mode
// гарантирует сериализацию параллельных upsert'ов на ту же бронь).
const equipment = await tx.equipment.findUnique({
  where: { id: equipmentId },
  select: { totalQuantity: true },
});
if (!equipment) throw new HttpError(404, "Оборудование не найдено", "EQUIPMENT_NOT_FOUND");

const overlappingBookings = await tx.booking.findMany({
  where: {
    id: { not: bookingId },
    status: { in: ["DRAFT", "CONFIRMED", "ISSUED"] },
    startDate: { lte: booking.endDate },
    endDate: { gte: booking.startDate },
    items: { some: { equipmentId } },
  },
  select: { items: { where: { equipmentId }, select: { quantity: true } } },
});
const occupiedByOthers = overlappingBookings.reduce(
  (sum, b) => sum + b.items.reduce((s, it) => s + it.quantity, 0),
  0,
);

const existing = await tx.bookingItem.findUnique({
  where: { bookingId_equipmentId: { bookingId, equipmentId } },
  select: { quantity: true },
});
const alreadyMine = existing?.quantity ?? 0;
const addCap = equipment.totalQuantity - occupiedByOthers - alreadyMine;

if (quantity > addCap) {
  throw new HttpError(409, "Не хватает на складе", "ADDON_OVER_STOCK", {
    addCap: Math.max(0, addCap),
    requested: quantity,
    alreadyInBooking: alreadyMine,
  });
}
```

Note: `booking.startDate` and `booking.endDate` must be loaded inside the transaction. If they're not already, expand the existing `tx.booking.findUnique` near line 398 to include `startDate: true, endDate: true`.

Update the existing query:

```ts
const booking = await tx.booking.findUnique({
  where: { id: bookingId },
  select: { status: true, startDate: true, endDate: true },
});
```

- [ ] **Step 5: Verify tests pass**

```bash
cd apps/api && npx vitest run src/services/__tests__/checklistService.test.ts
```

Expected: ALL existing tests still pass + the 3 new ones PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/sechenov/Documents/light-rental-system
git add apps/api/src/services/checklistService.ts apps/api/src/services/__tests__/checklistService.test.ts
git commit -m "feat(api): addExtraItem — hard cap (ADDON_OVER_STOCK)"
```

---

## Task 6: `/sessions/:id/addon/search` — return `addCap`

**Files:**
- Modify: `apps/api/src/routes/warehouse.ts:570-600` (results building)
- Modify: `apps/api/src/routes/__tests__/warehouseRouteSummary.test.ts` (or create addonSearchRoute.test.ts)

- [ ] **Step 1: Write failing test**

Either extend an existing test file or create `apps/api/src/routes/__tests__/addonSearchRoute.test.ts`. The simpler path: add to whichever file already exercises this route. If none, create it; mirror the auth pattern from `addonEstimateRoutes.test.ts`.

```ts
it("returns addCap per row, accounting for alreadyInBooking", async () => {
  // Seed: equipment totalQty=5, this booking already has BookingItem.quantity=2.
  // Other booking on same dates: 1.
  // Expected addCap = 5 − 1 − 2 = 2.
  // ... setup ...
  const res = await request(app).get(`/api/warehouse/sessions/${sessionId}/addon/search?q=Aputure`).set(AUTH);
  const row = res.body.results.find((r: any) => r.equipmentId === eqId);
  expect(row.addCap).toBe(2);
});

it("returns addCap=0 when stock is fully booked between other + this", async () => {
  // totalQty=3, this=2, other=1 → addCap=0
  // ...
  const res = await request(app).get(...).set(AUTH);
  const row = res.body.results.find((r: any) => r.equipmentId === eqId);
  expect(row.addCap).toBe(0);
});
```

- [ ] **Step 2: Run failing test**

```bash
cd apps/api && npx vitest run src/routes/__tests__/addonSearchRoute.test.ts
```

Expected: FAIL (addCap is undefined).

- [ ] **Step 3: Modify route**

In `apps/api/src/routes/warehouse.ts`, find the `addonSearch` GET handler (around line 540-600). Inside the `Promise.all` over rows, add `addCap` computation:

```ts
const results = await Promise.all(
  rows.slice(0, 30).map(async (row) => {
    const availability = row.availableQuantity > 0 ? "AVAILABLE" : "UNAVAILABLE";
    const conflict =
      availability === "UNAVAILABLE"
        ? await findAddonConflict(
            row.equipment.id,
            booking.startDate,
            booking.endDate,
            session.bookingId,
          )
        : null;

    // addCap = availableQuantity (already excludes other bookings) − alreadyInThisBooking
    const existing = await prisma.bookingItem.findUnique({
      where: {
        bookingId_equipmentId: {
          bookingId: session.bookingId,
          equipmentId: row.equipment.id,
        },
      },
      select: { quantity: true },
    });
    const alreadyMine = existing?.quantity ?? 0;
    const addCap = Math.max(0, row.availableQuantity - alreadyMine);

    return {
      equipmentId: row.equipment.id,
      name: row.equipment.name,
      category: row.equipment.category,
      availableQuantity: row.availableQuantity,
      addCap,
      availability,
      conflict,
    };
  }),
);
```

- [ ] **Step 4: Verify tests pass**

```bash
cd apps/api && npx vitest run src/routes/__tests__/addonSearchRoute.test.ts
```

- [ ] **Step 5: Commit**

```bash
cd /Users/sechenov/Documents/light-rental-system
git add apps/api/src/routes/warehouse.ts apps/api/src/routes/__tests__/addonSearchRoute.test.ts
git commit -m "feat(api): /addon/search returns addCap per row"
```

---

## Task 7: `completeSession` — accept `issuanceAdjustments`

**Files:**
- Modify: `apps/api/src/services/warehouseScan.ts` (function `completeSession` + `ReconciliationSummary`)
- Create: `apps/api/src/services/__tests__/completeSessionAdjustments.test.ts`

- [ ] **Step 1: Write failing test (COUNT-mode happy path)**

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import path from "path";
import { execSync } from "child_process";

const TEST_DB = path.resolve(__dirname, "../../../prisma/test-adjustments.db");
process.env.DATABASE_URL = `file:${TEST_DB}`;

let prisma: PrismaClient;

describe("completeSession with issuanceAdjustments", () => {
  beforeEach(async () => {
    execSync(`rm -f ${TEST_DB}`);
    execSync("npx prisma migrate deploy", { cwd: path.resolve(__dirname, "../../..") });
    prisma = new PrismaClient();
  });
  afterEach(async () => { await prisma.$disconnect(); });

  it("COUNT-mode: reduces BookingItem.quantity and recreates MAIN", async () => {
    // ... seed booking with eq1 qty=3, eq2 qty=2, MAIN snapshot ...
    const { createSession, completeSession } = await import("../warehouseScan");
    const session = await createSession(bookingId, "Ivan", "ISSUE");
    await completeSession(session.id, [{ bookingItemId: bi1.id, actualQuantity: 2 }]);
    const updated = await prisma.bookingItem.findUnique({ where: { id: bi1.id } });
    expect(updated!.quantity).toBe(2);
    const main = await prisma.estimate.findFirst({ where: { bookingId, kind: "MAIN" }, include: { lines: true } });
    const eq1Line = main!.lines.find((l) => l.equipmentId === eq1)!;
    expect(eq1Line.quantity).toBe(2);
  });

  it("N=0: BookingItem.quantity stays 0, MAIN excludes it", async () => {
    // ... seed eq1 qty=3 ...
    await completeSession(session.id, [{ bookingItemId: bi1.id, actualQuantity: 0 }]);
    const updated = await prisma.bookingItem.findUnique({ where: { id: bi1.id } });
    expect(updated!.quantity).toBe(0);
    const main = await prisma.estimate.findFirst({ where: { bookingId, kind: "MAIN" }, include: { lines: true } });
    expect(main!.lines.find((l) => l.equipmentId === eq1)).toBeUndefined();
  });

  it("UNIT-mode: releases (M − N) BookingItemUnit records for non-scanned units", async () => {
    // ... seed UNIT equipment with 3 reservations, only 2 scanned ...
    await completeSession(session.id, [{ bookingItemId: biUnit.id, actualQuantity: 2 }]);
    const remaining = await prisma.bookingItemUnit.findMany({ where: { bookingItemId: biUnit.id } });
    expect(remaining).toHaveLength(2);
    // Ensure remaining are the scanned ones
    const remainingUnitIds = new Set(remaining.map((r) => r.equipmentUnitId));
    expect(remainingUnitIds.has(scannedUnitId1)).toBe(true);
    expect(remainingUnitIds.has(scannedUnitId2)).toBe(true);
  });

  it("UNIT-mode: throws ADJUSTMENT_CONFLICTS_WITH_SCANS when actualQuantity < scannedCount", async () => {
    // ... seed 3 reservations, ALL 3 scanned ...
    // Trying to remove 1 should fail.
    await expect(
      completeSession(session.id, [{ bookingItemId: biUnit.id, actualQuantity: 2 }])
    ).rejects.toMatchObject({ status: 409, code: "ADJUSTMENT_CONFLICTS_WITH_SCANS" });
  });

  it("OVERPAID: paymentStatus transitions when paid > new finalAmount", async () => {
    // Seed: paid=5000, original finalAmount=5000. Adjustment reduces to 3500.
    await completeSession(session.id, [{ bookingItemId: bi1.id, actualQuantity: 2 }]);
    const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
    expect(booking!.paymentStatus).toBe("OVERPAID");
  });

  it("reports mainOriginalAfterDiscount in summary", async () => {
    const summary = await completeSession(session.id, [{ bookingItemId: bi1.id, actualQuantity: 2 }]);
    expect(summary.mainOriginalAfterDiscount).toBe("5000");
    expect(summary.mainAfterDiscount).toBe("3500");
  });

  it("empty adjustments array: equivalent to no adjustments at all", async () => {
    const before = await prisma.bookingItem.findUnique({ where: { id: bi1.id } });
    await completeSession(session.id, []);
    const after = await prisma.bookingItem.findUnique({ where: { id: bi1.id } });
    expect(after!.quantity).toBe(before!.quantity);
  });
});
```

(Fill in `seedBooking` helper inline at top of the test file with the equipment/unit creation patterns from `addonFinanceFlow.test.ts` if you want to model after an existing seed helper.)

- [ ] **Step 2: Run tests, verify failures**

```bash
cd apps/api && npx vitest run src/services/__tests__/completeSessionAdjustments.test.ts
```

Expected: all FAIL (signature does not accept adjustments parameter yet).

- [ ] **Step 3: Extend `ReconciliationSummary` interface**

In `apps/api/src/services/warehouseScan.ts`, find `interface ReconciliationSummary` (around line 50-70). Add:

```ts
/** MAIN Estimate.totalAfterDiscount как было ДО issuanceAdjustments. */
mainOriginalAfterDiscount: string;
```

Initialize defaults to `"0"` everywhere the summary object is built.

- [ ] **Step 4: Extend `completeSession` signature**

Change the function declaration:

```ts
export async function completeSession(
  sessionId: string,
  adjustments?: IssuanceAdjustment[],
): Promise<ReconciliationSummary>
```

Add type at the top of the file:

```ts
export interface IssuanceAdjustment {
  bookingItemId: string;
  actualQuantity: number;
}
```

- [ ] **Step 5: Snapshot mainOriginalAfterDiscount + apply adjustments**

Inside the existing transaction in `completeSession`, **at the very start** (before existing ISSUE/RETURN logic):

```ts
// Snapshot MAIN.totalAfterDiscount BEFORE any adjustments — used by UI «исходно / фактически».
const mainBefore = await tx.estimate.findFirst({
  where: { bookingId: session.bookingId, kind: "MAIN" },
  select: { totalAfterDiscount: true },
});
const mainOriginalAfterDiscount = mainBefore ? mainBefore.totalAfterDiscount.toString() : "0";

if (session.operation === "ISSUE" && adjustments && adjustments.length > 0) {
  // Load all involved BookingItems with their units in one query.
  const itemIds = adjustments.map((a) => a.bookingItemId);
  const items = await tx.bookingItem.findMany({
    where: { id: { in: itemIds }, bookingId: session.bookingId },
    include: { equipment: { select: { stockTrackingMode: true, name: true } }, units: true },
  });
  if (items.length !== itemIds.length) {
    throw new HttpError(400, "Некорректные adjustments — bookingItem не принадлежит этой брони", "INVALID_ADJUSTMENTS");
  }

  // For UNIT-mode: which units of THIS item were scanned in THIS session?
  const allScanned = await tx.scanRecord.findMany({
    where: { sessionId },
    select: { equipmentUnitId: true },
  });
  const scannedSet = new Set(allScanned.map((s) => s.equipmentUnitId));

  for (const adj of adjustments) {
    const bi = items.find((i) => i.id === adj.bookingItemId)!;
    if (adj.actualQuantity < 0 || adj.actualQuantity > bi.quantity) {
      throw new HttpError(400, "actualQuantity вне диапазона [0, quantity]", "INVALID_ADJUSTMENTS");
    }
    if (adj.actualQuantity === bi.quantity) continue; // no-op

    const releaseCount = bi.quantity - adj.actualQuantity;

    if (bi.equipment.stockTrackingMode === "UNIT") {
      const scannedForItem = bi.units.filter((u) => scannedSet.has(u.equipmentUnitId));
      const releasable = bi.units.filter((u) => !scannedSet.has(u.equipmentUnitId));
      if (releasable.length < releaseCount) {
        throw new HttpError(
          409,
          `Нельзя снять ${releaseCount} шт: ${scannedForItem.length} единиц уже отсканированы`,
          "ADJUSTMENT_CONFLICTS_WITH_SCANS",
          { bookingItemId: bi.id, scannedCount: scannedForItem.length, requestedQuantity: adj.actualQuantity },
        );
      }
      const toRelease = releasable.slice(0, releaseCount);
      for (const biu of toRelease) {
        await tx.bookingItemUnit.delete({ where: { id: biu.id } });
        await writeAuditEntryTx(tx, {
          action: "BOOKING_ITEM_UNIT_RELEASED",
          entityType: "Booking",
          entityId: session.bookingId,
          before: null,
          after: { bookingItemUnitId: biu.id, equipmentUnitId: biu.equipmentUnitId, sessionId },
        });
      }
    }

    const beforeQty = bi.quantity;
    await tx.bookingItem.update({ where: { id: bi.id }, data: { quantity: adj.actualQuantity } });

    await writeAuditEntryTx(tx, {
      action: "BOOKING_ITEM_QUANTITY_REDUCED",
      entityType: "Booking",
      entityId: session.bookingId,
      before: { quantity: beforeQty },
      after: {
        quantity: adj.actualQuantity,
        sessionId,
        equipmentId: bi.equipmentId,
        equipmentName: bi.equipment.name,
      },
    });
  }
}
```

Note: `writeAuditEntryTx` is a transaction-aware version of `writeAuditEntry`. If it doesn't exist, replace these calls with a deferred-write list applied after the transaction (or inline minimal `tx.auditEntry.create({...})` calls — check existing patterns).

- [ ] **Step 6: Recreate MAIN after adjustments (still inside the same transaction)**

After the loop, right after the `if` block:

```ts
if (session.operation === "ISSUE" && adjustments && adjustments.length > 0) {
  // Recreate MAIN snapshot inline (mirror recreateMainEstimate but using tx).
  // For simplicity & DRY: defer to recreateMainEstimate AFTER the transaction commits.
  // Mark a flag and call it below.
  needsMainRecreate = true;
}
```

Actually — easier: keep the existing `recomputeAddonEstimate` + `recomputeBookingFinance` calls **after** the transaction, and add `recreateMainEstimate` call before them.

Outside the transaction, after the existing logic:

```ts
if (operation === "ISSUE" && adjustments && adjustments.length > 0) {
  await recreateMainEstimate(session.bookingId);
}
// existing:
await recomputeAddonEstimate(session.bookingId).catch(...);
await recomputeBookingFinance(session.bookingId).catch(...);
```

- [ ] **Step 7: Populate `mainOriginalAfterDiscount` in returned summary**

In the final finance-snapshot read block (the one added in PR #167, which reads `main`/`addon`/`finalAmount`), include the captured `mainOriginalAfterDiscount`:

```ts
summary.mainOriginalAfterDiscount = mainOriginalAfterDiscount;
```

- [ ] **Step 8: Verify all tests pass**

```bash
cd apps/api && npx vitest run src/services/__tests__/completeSessionAdjustments.test.ts
```

- [ ] **Step 9: Commit**

```bash
cd /Users/sechenov/Documents/light-rental-system
git add apps/api/src/services/warehouseScan.ts apps/api/src/services/__tests__/completeSessionAdjustments.test.ts
git commit -m "feat(api): completeSession — issuanceAdjustments + mainOriginalAfterDiscount"
```

---

## Task 8: Route `/sessions/:id/complete` — Zod schema for body

**Files:**
- Modify: `apps/api/src/routes/warehouse.ts` (find `/sessions/:id/complete` handler)
- Test: extend `apps/api/src/routes/__tests__/warehouseScanIssueComplete.test.ts` or create

- [ ] **Step 1: Write failing test**

Add test for body parsing + forwarding to service:

```ts
it("accepts issuanceAdjustments in body and forwards to completeSession", async () => {
  // ... seed session + bookingItem ...
  const res = await request(app)
    .post(`/api/warehouse/sessions/${sessionId}/complete`)
    .set(AUTH)
    .send({ issuanceAdjustments: [{ bookingItemId: bi1.id, actualQuantity: 2 }] });
  expect(res.status).toBe(200);
  const bi = await prisma.bookingItem.findUnique({ where: { id: bi1.id } });
  expect(bi!.quantity).toBe(2);
});

it("rejects malformed body with 400", async () => {
  const res = await request(app)
    .post(`/api/warehouse/sessions/${sessionId}/complete`)
    .set(AUTH)
    .send({ issuanceAdjustments: [{ bookingItemId: "x", actualQuantity: "two" }] });
  expect(res.status).toBe(400);
});

it("response includes mainOriginalAfterDiscount", async () => {
  const res = await request(app).post(`/api/warehouse/sessions/${sessionId}/complete`).set(AUTH).send({});
  expect(res.body.mainOriginalAfterDiscount).toBeDefined();
});
```

- [ ] **Step 2: Run tests, verify failures**

- [ ] **Step 3: Modify route**

In `apps/api/src/routes/warehouse.ts`, find the `/sessions/:id/complete` handler. Add Zod schema:

```ts
const completeBodySchema = z.object({
  issuanceAdjustments: z.array(z.object({
    bookingItemId: z.string().min(1),
    actualQuantity: z.number().int().min(0),
  })).optional(),
}).strict();

warehouseScanRouter.post("/sessions/:id/complete", warehouseAuth, async (req, res, next) => {
  try {
    const body = completeBodySchema.parse(req.body ?? {});
    const summary = await completeSession(req.params.id, body.issuanceAdjustments);
    res.json({
      sessionId: req.params.id,
      expected: summary.expected,
      scanned: summary.scanned,
      // ... все existing fields ...
      mainAfterDiscount: summary.mainAfterDiscount,
      addonAfterDiscount: summary.addonAfterDiscount,
      finalAmount: summary.finalAmount,
      mainOriginalAfterDiscount: summary.mainOriginalAfterDiscount,
      reservedButUnavailable: summary.reservedButUnavailable,
    });
  } catch (err) {
    next(err);
  }
});
```

Match the existing field forwarding from the route (see PR #167 fix `87ab4ae` for the pattern).

- [ ] **Step 4: Verify tests pass**

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/warehouse.ts apps/api/src/routes/__tests__/warehouseScanIssueComplete.test.ts
git commit -m "feat(api): /complete — Zod schema for issuanceAdjustments + forward mainOriginalAfterDiscount"
```

---

## Task 9: Frontend types + api method

**Files:**
- Modify: `apps/web/src/components/warehouse/types.ts`
- Modify: `apps/web/src/components/warehouse/api.ts`

- [ ] **Step 1: Extend types**

In `types.ts`, find `AddonResult` interface and add `addCap`:

```ts
export interface AddonResult {
  equipmentId: string;
  name: string;
  category: string;
  availableQuantity: number;
  addCap: number;  // NEW: верхняя граница для picker'а
  availability: "AVAILABLE" | "UNAVAILABLE";
  conflict: AddonConflict | null;
}
```

Find `SummaryResult` and add `mainOriginalAfterDiscount`:

```ts
export interface SummaryResult {
  // ... existing fields ...
  mainAfterDiscount: string;
  addonAfterDiscount: string;
  finalAmount: string;
  mainOriginalAfterDiscount: string;  // NEW: MAIN до adjustments
}
```

Add new type for adjustment payload:

```ts
export interface IssuanceAdjustment {
  bookingItemId: string;
  actualQuantity: number;
}
```

- [ ] **Step 2: Extend `scanApi.completeSession`**

In `apps/web/src/components/warehouse/api.ts`, find the `completeSession` method (or equivalent) and accept an optional body:

```ts
async completeSession(
  sessionId: string,
  body?: { issuanceAdjustments?: IssuanceAdjustment[] },
): Promise<CompleteResult> {
  const res = await fetch(`/api/warehouse/sessions/${sessionId}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  // ... existing error handling ...
}
```

- [ ] **Step 3: Find all test fixtures that build `SummaryResult` and add default**

```bash
grep -rn "mainAfterDiscount.*:" apps/web/src/components/warehouse/__tests__/ | head
```

For each fixture builder, add `mainOriginalAfterDiscount: "0"` (or matching value).

- [ ] **Step 4: Run web typecheck**

```bash
cd apps/web && npx tsc -p tsconfig.json --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/warehouse/types.ts apps/web/src/components/warehouse/api.ts apps/web/src/components/warehouse/__tests__/
git commit -m "feat(web): types + api for issuanceAdjustments + addCap + mainOriginalAfterDiscount"
```

---

## Task 10: `AddonSearch` — use `addCap` as picker max

**Files:**
- Modify: `apps/web/src/components/warehouse/AddonSearch.tsx`
- Modify: `apps/web/src/components/warehouse/__tests__/AddonSearch.test.tsx`

- [ ] **Step 1: Write failing test**

Append in `AddonSearch.test.tsx`:

```ts
it("disables row when addCap=0", async () => {
  vi.mocked(scanApi.addonSearch).mockResolvedValue([
    { equipmentId: "e1", name: "Test", category: "Cat", availableQuantity: 5, addCap: 0, availability: "AVAILABLE", conflict: null },
  ]);
  render(<AddonSearch sessionId="s1" bookingId="b1" onAdded={() => {}} onClose={() => {}} />);
  const input = screen.getByLabelText(/Поиск артикула/);
  fireEvent.change(input, { target: { value: "test" } });
  await waitFor(() => expect(screen.getByText("Test")).toBeInTheDocument());
  const row = screen.getByRole("button", { name: /Уже добран максимум/ });
  expect(row).toBeDisabled();
});

it("picker max equals addCap, not availableQuantity", async () => {
  vi.mocked(scanApi.addonSearch).mockResolvedValue([
    { equipmentId: "e1", name: "Test", category: "Cat", availableQuantity: 5, addCap: 2, availability: "AVAILABLE", conflict: null },
  ]);
  render(<AddonSearch sessionId="s1" bookingId="b1" onAdded={() => {}} onClose={() => {}} />);
  fireEvent.change(screen.getByLabelText(/Поиск артикула/), { target: { value: "test" } });
  await waitFor(() => screen.getByText("Test"));
  fireEvent.click(screen.getByRole("button", { name: /Test.*свободно/ }));
  const qtyInput = screen.getByLabelText("Количество для добавления");
  expect(qtyInput).toHaveAttribute("max", "2");
});

it("shows inline error on 409 ADDON_OVER_STOCK", async () => {
  vi.mocked(scanApi.addonSearch).mockResolvedValue([
    { equipmentId: "e1", name: "Test", category: "Cat", availableQuantity: 5, addCap: 1, availability: "AVAILABLE", conflict: null },
  ]);
  vi.mocked(scanApi.addItem).mockRejectedValue({
    status: 409,
    code: "ADDON_OVER_STOCK",
    message: "Не хватает на складе",
    details: { addCap: 0, requested: 1, alreadyInBooking: 5 },
  });
  // ... open picker, click "Добавить 1" ...
  await waitFor(() => expect(screen.getByText(/Не хватает на складе/)).toBeInTheDocument());
});
```

- [ ] **Step 2: Run failing test**

```bash
cd apps/web && npx vitest run src/components/warehouse/__tests__/AddonSearch.test.tsx
```

- [ ] **Step 3: Modify `AddonSearch.tsx`**

Change `isAvailable` to use `addCap`:

```ts
function isAvailable(r: AddonResult): boolean {
  return r.availability !== "UNAVAILABLE" && r.addCap > 0;
}
```

Change `handleRowTap` to use `addCap`:

```ts
setPicking({
  equipmentId: r.equipmentId,
  name: r.name,
  qty: 1,
  availableMax: Math.max(1, r.addCap),
});
```

For the row aria-label and disabled state when `addCap=0`:

```tsx
aria-label={
  r.addCap === 0
    ? `${r.name} — уже добран максимум на даты, нельзя добавить`
    : free
    ? `${r.name} — свободно, выбрать количество и добавить в выдачу`
    : `${r.name} — занят, открыть предупреждение о доборе`
}
disabled={!!adding || r.addCap === 0}
```

For the pill display: keep `свободно ×{availableQuantity}` but if `addCap < availableQuantity` add a sub-line:

```tsx
{free && r.addCap < r.availableQuantity && (
  <span className="text-[10px] text-ink-3">
    можно добрать ×{r.addCap}
  </span>
)}
```

For the 409 ADDON_OVER_STOCK handler in `doAdd`, add a code-specific branch:

```ts
} catch (err: unknown) {
  if (isScanApiError(err) && err.status === 409 && err.code === "ADDON_OVER_STOCK") {
    const d = err.details as { addCap?: number; alreadyInBooking?: number } | undefined;
    setError(
      `Не хватает на складе. ` +
      (d?.alreadyInBooking !== undefined ? `Уже в брони: ${d.alreadyInBooking}, ` : "") +
      `осталось добрать: ${d?.addCap ?? 0}`,
    );
    setPicking(null);
    return;
  }
  // ... existing ADDON_CONFLICT branch ...
}
```

- [ ] **Step 4: Verify tests pass**

```bash
cd apps/web && npx vitest run src/components/warehouse/__tests__/AddonSearch.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/warehouse/AddonSearch.tsx apps/web/src/components/warehouse/__tests__/AddonSearch.test.tsx
git commit -m "feat(web): AddonSearch — addCap is picker max + ADDON_OVER_STOCK inline error"
```

---

## Task 11: `IssueChecklist` — per-row stepper + commit state machine

**Files:**
- Modify: `apps/web/src/components/warehouse/IssueChecklist.tsx`
- Modify: `apps/web/src/components/warehouse/__tests__/IssueChecklist.test.tsx`

**This is the largest UI task. Break into substeps.**

### 11.1: Local state for per-row intent

- [ ] **Step 1: Write failing test**

```ts
it("renders stepper with default N = bi.quantity on each row", () => {
  render(<IssueChecklist {...defaultProps} />);
  const rows = screen.getAllByRole("group", { name: /Astera Pixel Brick/ });
  const stepper = within(rows[0]).getByLabelText("Количество к выдаче");
  expect(stepper).toHaveValue(3);
});

it("plus disabled at max, minus disabled at 0", () => {
  render(<IssueChecklist {...defaultProps} />);
  const row = screen.getByRole("group", { name: /Astera/ });
  fireEvent.click(within(row).getByLabelText("Уменьшить количество"));
  fireEvent.click(within(row).getByLabelText("Уменьшить количество"));
  fireEvent.click(within(row).getByLabelText("Уменьшить количество"));
  expect(within(row).getByLabelText("Уменьшить количество")).toBeDisabled();
  // click + back to max
  // ... click plus 3 times ...
  expect(within(row).getByLabelText("Увеличить количество")).toBeDisabled();
});
```

- [ ] **Step 2: Add state to `IssueChecklist.tsx`**

```ts
const [intendedQty, setIntendedQty] = useState<Map<string, number>>(() => {
  const m = new Map<string, number>();
  for (const bi of state.bookingItems) m.set(bi.id, bi.quantity);
  return m;
});

const [committedRows, setCommittedRows] = useState<Set<string>>(new Set());
```

Helper functions:

```ts
function setRowQty(bookingItemId: string, value: number) {
  setIntendedQty((m) => {
    const next = new Map(m);
    const original = state.bookingItems.find((bi) => bi.id === bookingItemId)?.quantity ?? 0;
    next.set(bookingItemId, Math.max(0, Math.min(original, Math.floor(value))));
    return next;
  });
}

function bumpRowQty(bookingItemId: string, delta: number) {
  const current = intendedQty.get(bookingItemId) ?? 0;
  setRowQty(bookingItemId, current + delta);
}

function commitRow(bookingItemId: string) {
  setCommittedRows((s) => new Set(s).add(bookingItemId));
}

function uncommitRow(bookingItemId: string) {
  setCommittedRows((s) => {
    const next = new Set(s);
    next.delete(bookingItemId);
    return next;
  });
}
```

### 11.2: Render stepper + commit button per row

- [ ] **Step 3: Replace the binary buttons in the row JSX**

For COUNT-mode rows (and as the primary control for all rows), replace the existing «✓ выдано» / «✕ не выдаём» pair:

```tsx
{!committedRows.has(bi.id) && (
  <div className="flex items-center gap-2">
    <button
      type="button"
      onClick={() => bumpRowQty(bi.id, -1)}
      disabled={(intendedQty.get(bi.id) ?? 0) <= 0}
      aria-label="Уменьшить количество"
      className="..."
    >
      −
    </button>
    <input
      type="number"
      value={intendedQty.get(bi.id) ?? 0}
      onChange={(e) => setRowQty(bi.id, Number(e.target.value))}
      min={0}
      max={bi.quantity}
      aria-label="Количество к выдаче"
      className="w-12 ..."
    />
    <button
      type="button"
      onClick={() => bumpRowQty(bi.id, +1)}
      disabled={(intendedQty.get(bi.id) ?? 0) >= bi.quantity}
      aria-label="Увеличить количество"
      className="..."
    >
      +
    </button>
    <span className="text-[12px] text-ink-3">/ {bi.quantity}</span>
    <button
      type="button"
      onClick={() => commitRow(bi.id)}
      className={`... ${(intendedQty.get(bi.id) ?? 0) === 0 ? "bg-rose text-white" : "bg-accent text-white"}`}
      aria-label={
        (intendedQty.get(bi.id) ?? 0) === 0
          ? `Не выдаём ${bi.equipment.name}`
          : `Выдать ${intendedQty.get(bi.id) ?? 0} шт ${bi.equipment.name}`
      }
    >
      {(intendedQty.get(bi.id) ?? 0) === 0 ? "Не выдаём" : `Выдать ${intendedQty.get(bi.id) ?? 0}`}
    </button>
  </div>
)}

{committedRows.has(bi.id) && (
  <div className="flex items-center gap-2">
    <span className={`pill ${(intendedQty.get(bi.id) ?? 0) === 0 ? "pill-rose" : "pill-emerald"}`}>
      {(intendedQty.get(bi.id) ?? 0) === 0
        ? "Не выдаём"
        : `Выдано ${intendedQty.get(bi.id)} / ${bi.quantity}`}
    </span>
    <button
      type="button"
      onClick={() => uncommitRow(bi.id)}
      aria-label="Изменить количество для выдачи"
      className="text-[11px] text-ink-3 underline hover:no-underline"
    >
      Изменить
    </button>
  </div>
)}
```

### 11.3: UNIT-mode `min = scannedCount`

- [ ] **Step 4: For UNIT-mode rows, clamp stepper min**

The stepper's min is `bi.equipment.stockTrackingMode === "UNIT" ? scannedCount(bi.id) : 0`.

Add helper that counts scanned units per bookingItem from existing state (the IssueChecklist already has `scannedUnits` or similar). If not, fall back to min=0 for UNIT-mode (acceptable since the backend will throw ADJUSTMENT_CONFLICTS_WITH_SCANS).

For TDD simplicity: keep min=0 in UI for v1; rely on backend 409 to surface error. Add a test that demonstrates the 409 surfacing:

```ts
it("on completeSession 409 ADJUSTMENT_CONFLICTS_WITH_SCANS, shows inline error", async () => {
  vi.mocked(scanApi.completeSession).mockRejectedValue({
    status: 409, code: "ADJUSTMENT_CONFLICTS_WITH_SCANS",
    message: "Нельзя снять 1 шт: 3 единицы уже отсканированы",
    details: { bookingItemId: "bi1", scannedCount: 3, requestedQuantity: 2 },
  });
  // ... commit row + click submit ...
  await waitFor(() => expect(screen.getByText(/3 единицы уже отсканированы/)).toBeInTheDocument());
});
```

### 11.4: Global «✓ Выдать всё разом»

- [ ] **Step 5: Update global button handler**

```ts
function commitAll() {
  setCommittedRows(new Set(state.bookingItems.map((bi) => bi.id)));
}
```

The global button reads:

```tsx
<button onClick={commitAll}>✓ Выдать всё разом</button>
```

Add test:

```ts
it("global «Выдать всё разом» commits all rows with their current intended qty", () => {
  render(<IssueChecklist {...defaultProps} />);
  const row = screen.getByRole("group", { name: /Astera/ });
  fireEvent.click(within(row).getByLabelText("Уменьшить количество")); // intended=2
  fireEvent.click(screen.getByRole("button", { name: /Выдать всё разом/ }));
  expect(within(row).getByText(/Выдано 2 \/ 3/)).toBeInTheDocument();
});
```

### 11.5: Commit step

- [ ] **Step 6: Verify all tests pass**

```bash
cd apps/web && npx vitest run src/components/warehouse/__tests__/IssueChecklist.test.tsx
```

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/warehouse/IssueChecklist.tsx apps/web/src/components/warehouse/__tests__/IssueChecklist.test.tsx
git commit -m "feat(web): IssueChecklist — per-row stepper + commit/uncommit state"
```

---

## Task 12: `IssueChecklist` — build `issuanceAdjustments` and send on complete

**Files:**
- Modify: `apps/web/src/components/warehouse/IssueChecklist.tsx`
- Modify: `apps/web/src/components/warehouse/__tests__/IssueChecklist.test.tsx`

- [ ] **Step 1: Write failing test**

```ts
it("sends only differences (actualQty !== originalQty) in issuanceAdjustments", async () => {
  vi.mocked(scanApi.completeSession).mockResolvedValue({ /* mock summary */ });
  render(<IssueChecklist {...defaultProps} />);

  // Row 1: keep N=3 (no change)
  // Row 2: bumpDown to 2 (1 dropped)
  // Row 3: bumpDown to 0 (full drop)
  // ... interactions ...
  fireEvent.click(screen.getByRole("button", { name: /Завершить выдачу/ }));

  await waitFor(() => expect(scanApi.completeSession).toHaveBeenCalledWith(
    "session-id",
    { issuanceAdjustments: [
      { bookingItemId: "bi2", actualQuantity: 2 },
      { bookingItemId: "bi3", actualQuantity: 0 },
    ]},
  ));
});

it("when no adjustments needed, sends empty array", async () => {
  // all rows at N=M
  // ... click commit all + submit ...
  await waitFor(() => expect(scanApi.completeSession).toHaveBeenCalledWith(
    "session-id",
    { issuanceAdjustments: [] },
  ));
});
```

- [ ] **Step 2: Update the submit handler**

In `IssueChecklist.tsx`, find where `scanApi.completeSession` is called (in the "Завершить выдачу" button onClick). Replace with:

```ts
async function handleSubmit() {
  const adjustments: IssuanceAdjustment[] = [];
  for (const bi of state.bookingItems) {
    const intended = intendedQty.get(bi.id) ?? bi.quantity;
    if (intended !== bi.quantity) {
      adjustments.push({ bookingItemId: bi.id, actualQuantity: intended });
    }
  }
  try {
    setSubmitting(true);
    const result = await scanApi.completeSession(sessionId, { issuanceAdjustments: adjustments });
    onDone(result);
  } catch (err: unknown) {
    // ... existing error handling, plus 409 ADJUSTMENT_CONFLICTS_WITH_SCANS surfacing ...
    if (isScanApiError(err) && err.status === 409 && err.code === "ADJUSTMENT_CONFLICTS_WITH_SCANS") {
      setError(err.message);
    } else {
      setError(isScanApiError(err) ? err.message : "Не удалось завершить выдачу");
    }
  } finally {
    setSubmitting(false);
  }
}
```

- [ ] **Step 3: Verify tests pass**

```bash
cd apps/web && npx vitest run src/components/warehouse/__tests__/IssueChecklist.test.tsx
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/warehouse/IssueChecklist.tsx apps/web/src/components/warehouse/__tests__/IssueChecklist.test.tsx
git commit -m "feat(web): IssueChecklist — build issuanceAdjustments and send only differences"
```

---

## Task 13: `IssueResultView` — finance block with «исходно / фактически» and OVERPAID

**Files:**
- Modify: `apps/web/src/components/warehouse/IssueResultView.tsx`
- Modify: `apps/web/src/components/warehouse/__tests__/IssueResultView.test.tsx`

- [ ] **Step 1: Write failing test**

```ts
it("shows «Согласовано (исходно)» line only when mainAfterDiscount < mainOriginalAfterDiscount", () => {
  render(<IssueResultView result={{
    ...baseResult,
    mainAfterDiscount: "3500",
    mainOriginalAfterDiscount: "5000",
    addonAfterDiscount: "0",
    finalAmount: "3500",
  }} bookingId="b1" onClose={() => {}} />);
  expect(screen.getByText(/Согласовано \(исходно\)/)).toBeInTheDocument();
  expect(screen.getByText(/5 000/)).toBeInTheDocument();
  expect(screen.getByText(/Снято на выдаче/)).toBeInTheDocument();
});

it("hides «исходно» line when no adjustments (mainAfterDiscount === mainOriginalAfterDiscount)", () => {
  render(<IssueResultView result={{
    ...baseResult,
    mainAfterDiscount: "5000",
    mainOriginalAfterDiscount: "5000",
  }} bookingId="b1" onClose={() => {}} />);
  expect(screen.queryByText(/Согласовано \(исходно\)/)).not.toBeInTheDocument();
});

it("shows OVERPAID styling and «К возврату» line", () => {
  render(<IssueResultView result={{
    ...baseResult,
    paymentStatus: "OVERPAID",
    finalAmount: "3500",
    amountPaid: "5000",
  }} bookingId="b1" onClose={() => {}} />);
  expect(screen.getByText(/Переплата/)).toBeInTheDocument();
  expect(screen.getByText(/К возврату/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Update the finance block in `IssueResultView.tsx`**

```tsx
const hasMainReduction = Number(result.mainAfterDiscount) < Number(result.mainOriginalAfterDiscount);
const isOverpaid = result.paymentStatus === "OVERPAID";

<div className="finance-block">
  {hasMainReduction && (
    <>
      <Row label="Согласовано (исходно)" value={formatRub(result.mainOriginalAfterDiscount)} />
      <Row label="Снято на выдаче" value={`−${formatRub(Number(result.mainOriginalAfterDiscount) - Number(result.mainAfterDiscount))}`} negative />
      <Row label="Согласовано (фактически)" value={formatRub(result.mainAfterDiscount)} bold />
    </>
  )}
  {!hasMainReduction && (
    <Row label="Согласовано" value={formatRub(result.mainAfterDiscount)} bold />
  )}
  {Number(result.addonAfterDiscount) > 0 && (
    <Row label="+ Доб-смета" value={formatRub(result.addonAfterDiscount)} />
  )}
  <Row label="К оплате" value={formatRub(result.finalAmount)} emphasized />
  {isOverpaid && (
    <div className="rounded border border-rose-border bg-rose-soft px-3 py-2 text-rose mt-2">
      <p className="font-semibold">Переплата: {formatRub(Math.abs(Number(result.finalAmount) - Number(result.amountPaid ?? "0")))}</p>
      <p className="text-[11px]">К возврату клиенту</p>
    </div>
  )}
</div>
```

- [ ] **Step 3: Verify tests pass**

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/warehouse/IssueResultView.tsx apps/web/src/components/warehouse/__tests__/IssueResultView.test.tsx
git commit -m "feat(web): IssueResultView — «исходно / фактически» + OVERPAID display"
```

---

## Task 14: Integration test — full flow

**Files:**
- Create: `apps/api/src/__tests__/issueAdjustmentFlow.test.ts`

- [ ] **Step 1: Write integration test**

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import path from "path";
import { execSync } from "child_process";
import request from "supertest";
import { app } from "../app";
import { hashPassword } from "../utils/passwords";
import { signSession } from "../utils/sessionToken";

const TEST_DB = path.resolve(__dirname, "../../prisma/test-issue-adjust.db");
process.env.DATABASE_URL = `file:${TEST_DB}`;
process.env.RATE_LIMIT_DISABLED = "true";

let prisma: PrismaClient;
let auth: string;

describe("issue-time adjustment full flow", () => {
  beforeEach(async () => {
    execSync(`rm -f ${TEST_DB}`);
    execSync("npx prisma migrate deploy", { cwd: path.resolve(__dirname, "../../") });
    prisma = new PrismaClient();
    const admin = await prisma.adminUser.create({
      data: { username: "admin", passwordHash: await hashPassword("p"), role: "SUPER_ADMIN" },
    });
    auth = `Bearer ${signSession({ userId: admin.id, username: "admin", role: "SUPER_ADMIN" })}`;
  });
  afterEach(async () => { await prisma.$disconnect(); });

  it("CONFIRMED → +Добор → adjustments → /complete → MAIN reduced, OVERPAID, audit", async () => {
    // 1. Seed CONFIRMED booking with 1 item (qty=3), MAIN snapshot=3×1000=3000, no discount
    // 2. Create ISSUE session, scan no units (COUNT-mode)
    // 3. POST /complete with adjustment: actualQuantity=2
    //    → expect 200, MAIN.totalAfterDiscount=2000, paymentStatus stays PAID/NOT_PAID etc
    // 4. Repeat with paid=3000 → adjustment to 2 → OVERPAID, outstanding=-1000
    // 5. Verify audit entries BOOKING_ITEM_QUANTITY_REDUCED + BOOKING_OVERPAID_DETECTED exist
  });

  it("+Добор limit enforced — second add fails with ADDON_OVER_STOCK", async () => {
    // 1. Equipment totalQty=5, this booking has 3, other booking has 1, addCap=1
    // 2. POST /items with quantity=2 → 409 ADDON_OVER_STOCK
    // 3. POST /items with quantity=1 → success
    // 4. POST /items with quantity=1 again → 409 ADDON_OVER_STOCK (now addCap=0)
  });
});
```

(Fill in concrete seed values matching the existing `addonFinanceFlow.test.ts` pattern.)

- [ ] **Step 2: Run and ensure passes**

```bash
cd apps/api && npx vitest run src/__tests__/issueAdjustmentFlow.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/issueAdjustmentFlow.test.ts
git commit -m "test(api): integration — issue-time adjustments + addCap full flow"
```

---

## Task 15: Sweep + PR + deploy + verify

- [ ] **Step 1: Full backend test sweep**

```bash
cd /Users/sechenov/Documents/light-rental-system && npm test -w apps/api 2>&1 | tail -8
```

Expected: 1000+ pass, 0 fail.

- [ ] **Step 2: Full frontend test sweep**

```bash
npm test -w apps/web 2>&1 | tail -8
```

Expected: 400+ pass, 0 fail.

- [ ] **Step 3: Typechecks**

```bash
cd apps/api && npx tsc -p tsconfig.json --noEmit
cd ../web && npx tsc -p tsconfig.json --noEmit
```

Expected: no errors.

- [ ] **Step 4: Push and create PR**

```bash
cd /Users/sechenov/Documents/light-rental-system
GH_TOKEN=$(gh auth token) git -c credential.helper="!f() { echo username=sechenoff; echo password=$GH_TOKEN; }; f" push -u origin feat/issue-stock-cap-and-removal

gh pr create --title "feat(warehouse): добор stock cap + per-row снятие позиций" --body "$(cat <<'EOF'
## Summary

Два изменения в ISSUE-флоу:

1. **Bug fix — hard cap на «+Добор»:** Backend больше не разрешает превышать totalQuantity − occupied. UI заранее показывает реальный максимум через addCap. Race-protection через SQLite serialize-mode.

2. **Feature — частичное снятие позиций на выдаче:** Каждый ряд чек-листа стал степпером 0…M с кнопкой «Выдать N» (или «Не выдаём» при N=0). Адjustments применяются батч-транзакцией в /complete: BookingItem.quantity обрезается, MAIN-смета пересоздаётся, финансы пересчитываются. Новый статус OVERPAID когда paid > finalAmount.

## Spec / Plan
- Spec: docs/superpowers/specs/2026-05-21-issue-stock-cap-and-unit-removal-design.md
- Plan: docs/superpowers/plans/2026-05-21-issue-stock-cap-and-unit-removal.md

## Test plan
- [ ] Backend все тесты pass
- [ ] Frontend все тесты pass
- [ ] Live smoke: +Добор сверх лимита → 409
- [ ] Live smoke: степпер 0…M на каждом ряду
- [ ] Live smoke: «Выдать 2 из 3» → MAIN.smета пересчиталась
- [ ] Live smoke: N=0 → «Не выдаём», позиция исчезает из MAIN
- [ ] Live smoke: paid > new finalAmount → OVERPAID + «К возврату»
EOF
)"
```

- [ ] **Step 5: Squash-merge**

```bash
GH_TOKEN=$(gh auth token) gh pr merge --squash --subject "feat(warehouse): добор stock cap + per-row снятие позиций (#PR)" --body "..."
```

- [ ] **Step 6: Watch deploy**

```bash
RUN_ID=$(gh run list --branch main --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch $RUN_ID --interval 10 --exit-status
```

Expected: success.

- [ ] **Step 7: Cleanup**

```bash
git checkout main && GH_TOKEN=$(gh auth token) git -c credential.helper="!f() { echo username=sechenoff; echo password=$GH_TOKEN; }; f" pull --ff-only origin main
git branch -d feat/issue-stock-cap-and-removal
gh api -X DELETE repos/sechenoff/Light/git/refs/heads/feat/issue-stock-cap-and-removal
```

- [ ] **Step 8: HTTP-level prod smoke**

```bash
curl -s -o /dev/null -w "HTTP %{http_code}\n" https://svetobazarent.ru/api/auth/me
# ожидается 401 (без auth)
```

---

## Self-review checklist

- [x] All 7 spec sections covered:
  - §3.1 Bug-fix lookahead/hard cap → Tasks 5, 6
  - §3.2 New feature state/contract → Tasks 3, 7, 8, 9, 11, 12
  - §4 API contracts → Tasks 6, 8
  - §5 Schema migration → Task 1
  - §6 Audit trail → Task 7
  - §7 Edge cases (addon-row adjustment, UNIT-scans, N=0, cancel, race) → Tasks 4, 7
  - §8 Testing strategy → all task-level tests + Task 14
- [x] No placeholders ("TBD", "TODO", "fill in") in any code block.
- [x] Function names consistent: `addExtraItem`, `recreateMainEstimate`, `recomputeAddonEstimate`, `recomputeBookingFinance`, `calcBookingPaymentStatus` — same in tasks and references.
- [x] Type names consistent: `IssuanceAdjustment`, `AddonResult`, `SummaryResult`, `ReconciliationSummary`.
- [x] Audit action codes consistent: `BOOKING_ITEM_QUANTITY_REDUCED`, `BOOKING_ITEM_UNIT_RELEASED`, `BOOKING_OVERPAID_DETECTED`.
- [x] Each task has TDD red→green→commit cycle.
