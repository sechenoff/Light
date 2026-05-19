# Warehouse Scan Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `/warehouse/scan` as an adaptive desktop+mobile flow with availability-checked add-ons, native-camera repair photos, a fast 3-outcome return checklist, and a "Потеряшки" problem-item registry — reusing the existing scan backend.

**Architecture:** Evolution, not rewrite. Existing services (`warehouseScan`, `checklistService`, `repairService`, `availability`, `audit`) and scan endpoints stay. We add Prisma models (`ProblemItem`, `RepairPhoto`), 5 backend endpoints, replace the `lostUnits` completion path with `problemUnits`, and decompose the 1930-line `page.tsx` into focused components under `apps/web/src/components/warehouse/`.

**Tech Stack:** Express 4 + Prisma 6 (SQLite) + Zod + multer; Next.js 14 + React 18 + Tailwind 3 (IBM Plex canon); vitest (API integration, harness = dedicated SQLite per file).

**Spec:** `docs/superpowers/specs/2026-05-19-warehouse-scan-redesign-design.md`
**Visual source of truth (fidelity gate):** `docs/mockups/warehouse-scan/01-return-checklist.html`, `02-problem-reasons.html`, `03-issue-and-desktop.html`

**Hard constraints (verify every task):**
- No barcodes/scanner anywhere in UX. Units shown as «прибор N из M».
- All UI text Russian. IBM Plex canon tokens (`ink/surface/border/accent/emerald/amber/rose/slate`, `StatusPill`, `.eyebrow`, `.mono-num`). No hex, no `slate-/blue-` literals outside finance.
- Business logic in services; routes thin; Zod on inputs; `HttpError`; audit in same `$transaction` as mutation.
- Booking has **no numeric field** → display id = `#` + last 6 chars of `booking.id` upper-cased; list sort = `startDate` asc, then `createdAt` asc.
- SQLite: no scalar lists → collections are separate tables.

---

## Phase 0 — Prisma schema & audit type

### Task 0.1: Add `ProblemItem` + `RepairPhoto` models and enums

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (append models; add `problemItems`/`photos` back-relations)
- Modify: `apps/api/src/services/audit.ts:9-24` (extend `AuditEntityType`)

- [ ] **Step 1: Add enums + models to schema.prisma**

Append at end of `apps/api/prisma/schema.prisma`:

```prisma
enum ProblemReason {
  LEFT_ON_SITE
  LOST
  DESTROYED
  STOLEN
}

enum ProblemStatus {
  EXPECTED
  SEARCHING
  FOUND
  NOT_FOUND
  WROTE_OFF
}

/// Реестр «Потеряшки» — проблемная единица с приёмки (заявка на поиск/разбор)
model ProblemItem {
  id               String        @id @default(cuid())
  equipmentUnitId  String
  equipmentUnit    EquipmentUnit @relation(fields: [equipmentUnitId], references: [id])
  sourceBookingId  String?
  reason           ProblemReason
  comment          String
  expectedBackDate DateTime?
  status           ProblemStatus @default(SEARCHING)
  createdBy        String
  createdAt        DateTime      @default(now())
  resolvedAt       DateTime?
  resolvedBy       String?
  resolutionNote   String?

  @@index([status])
  @@index([equipmentUnitId])
  @@index([sourceBookingId])
}

/// Фото поломки, привязанное к карточке ремонта
model RepairPhoto {
  id        String   @id @default(cuid())
  repairId  String
  repair    Repair   @relation(fields: [repairId], references: [id], onDelete: Cascade)
  filePath  String   // относительный путь от apps/api/uploads/
  createdBy String
  createdAt DateTime @default(now())

  @@index([repairId])
}
```

In `model EquipmentUnit` add to the relation block (after `repairs Repair[]`):
```prisma
  problemItems ProblemItem[]
```

In `model Repair` add (after `expenses Expense[]`):
```prisma
  photos RepairPhoto[]
```

- [ ] **Step 2: Extend AuditEntityType**

In `apps/api/src/services/audit.ts`, change the union (currently ends `| "OrgSettings";`) to add `"ProblemItem"`:

```ts
  | "OrgSettings"
  | "ProblemItem";
```

- [ ] **Step 3: Generate client + push dev DB**

Run: `npm run prisma:generate`
Then: `cd apps/api && DATABASE_URL="file:./prisma/dev.db" npx prisma db push --skip-generate --accept-data-loss && cd ../..`
Expected: "Your database is now in sync with your Prisma schema." and client regenerated with `ProblemItem`, `RepairPhoto` delegates.

- [ ] **Step 4: Typecheck**

Run: `npm run build -w apps/api`
Expected: PASS (no TS errors; new Prisma types available).

- [ ] **Step 5: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/src/services/audit.ts
git commit -m "feat(warehouse): ProblemItem + RepairPhoto models, ProblemItem audit type"
```

---

## Phase 1 — Backend: add-on availability conflict

Add-on add must reuse `getAvailability` for the badge and a precise conflict lookup for the warning. Soft-warn: never block; on acknowledged conflict, write audit.

### Task 1.1: `findAddonConflict` service helper

**Files:**
- Create: `apps/api/src/services/addonAvailability.ts`
- Test: `apps/api/src/__tests__/addonAvailability.test.ts`

- [ ] **Step 1: Write failing test**

Create `apps/api/src/__tests__/addonAvailability.test.ts`. Copy the env-var header + `beforeAll`/`afterAll` harness verbatim from `apps/api/src/__tests__/warehouseScan.brokenUnits.test.ts:1-136`, but change `TEST_DB_PATH` to `../../prisma/test-addon-avail.db` and all unique env suffixes to `addon-avail`. Then:

```ts
describe("findAddonConflict", () => {
  it("returns conflict when COUNT equipment fully booked in window by another CONFIRMED booking", async () => {
    const eq = await prisma.equipment.create({
      data: { importKey: "addon-eq-1", name: "Astera Titan", category: "Свет",
        rentalRatePerShift: 1000, stockTrackingMode: "COUNT", totalQuantity: 1 },
    });
    const client = await prisma.client.create({ data: { name: "К1" } });
    const other = await prisma.booking.create({
      data: { clientId: client.id, projectName: "Конфликт", status: "CONFIRMED",
        startDate: new Date("2026-06-10"), endDate: new Date("2026-06-12") },
    });
    await prisma.bookingItem.create({ data: { bookingId: other.id, equipmentId: eq.id, quantity: 1 } });
    const target = await prisma.booking.create({
      data: { clientId: client.id, projectName: "Целевая", status: "CONFIRMED",
        startDate: new Date("2026-06-11"), endDate: new Date("2026-06-13") },
    });

    const { findAddonConflict } = await import("../services/addonAvailability");
    const c = await findAddonConflict(eq.id, target.startDate, target.endDate, target.id);
    expect(c).not.toBeNull();
    expect(c!.bookingId).toBe(other.id);
    expect(new Date(c!.freeFrom).getTime()).toBe(new Date("2026-06-12").getTime());
  });

  it("returns null when free", async () => {
    const eq = await prisma.equipment.create({
      data: { importKey: "addon-eq-2", name: "Свободный", category: "Свет",
        rentalRatePerShift: 1, stockTrackingMode: "COUNT", totalQuantity: 2 },
    });
    const client = await prisma.client.create({ data: { name: "К2" } });
    const target = await prisma.booking.create({
      data: { clientId: client.id, projectName: "Ц2", status: "CONFIRMED",
        startDate: new Date("2026-07-01"), endDate: new Date("2026-07-02") },
    });
    const { findAddonConflict } = await import("../services/addonAvailability");
    expect(await findAddonConflict(eq.id, target.startDate, target.endDate, target.id)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm run test -w apps/api -- addonAvailability`
Expected: FAIL — `Cannot find module '../services/addonAvailability'`.

- [ ] **Step 3: Implement `addonAvailability.ts`**

Create `apps/api/src/services/addonAvailability.ts`:

```ts
import { prisma } from "../prisma";

const BLOCKING_STATUSES = ["CONFIRMED", "ISSUED"] as const;

export interface AddonConflict {
  bookingId: string;
  bookingNo: string;          // "#A1B2C3"
  projectName: string;
  from: string;               // ISO
  to: string;                 // ISO
  freeFrom: string;           // ISO — nearest conflicting booking endDate
}

function bookingNo(id: string): string {
  return "#" + id.slice(-6).toUpperCase();
}

/**
 * Находит ближайшую конфликтующую бронь (CONFIRMED/ISSUED), которая делает
 * equipment недоступным в окне [start,end], исключая текущую бронь.
 * Возвращает null если конфликта нет (с учётом totalQuantity для COUNT и
 * числа свободных юнитов для UNIT — упрощённо: пересечение по датам).
 */
export async function findAddonConflict(
  equipmentId: string,
  start: Date,
  end: Date,
  excludeBookingId: string,
): Promise<AddonConflict | null> {
  const eq = await prisma.equipment.findUnique({
    where: { id: equipmentId },
    select: { totalQuantity: true, stockTrackingMode: true },
  });
  if (!eq) return null;

  const overlapping = await prisma.booking.findMany({
    where: {
      id: { not: excludeBookingId },
      status: { in: [...BLOCKING_STATUSES] },
      startDate: { lte: end },
      endDate: { gte: start },
      items: { some: { equipmentId } },
    },
    select: {
      id: true, projectName: true, startDate: true, endDate: true,
      items: { where: { equipmentId }, select: { quantity: true } },
    },
    orderBy: { startDate: "asc" },
  });

  if (overlapping.length === 0) return null;

  const reservedQty = overlapping.reduce(
    (s, b) => s + b.items.reduce((q, i) => q + i.quantity, 0), 0,
  );
  const capacity = eq.totalQuantity || 1;
  if (reservedQty + 1 <= capacity) return null; // ещё есть свободный экземпляр

  const nearest = overlapping[0];
  return {
    bookingId: nearest.id,
    bookingNo: bookingNo(nearest.id),
    projectName: nearest.projectName,
    from: nearest.startDate.toISOString(),
    to: nearest.endDate.toISOString(),
    freeFrom: nearest.endDate.toISOString(),
  };
}
```

- [ ] **Step 4: Run test, verify PASS**

Run: `npm run test -w apps/api -- addonAvailability`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/addonAvailability.ts apps/api/src/__tests__/addonAvailability.test.ts
git commit -m "feat(warehouse): addon conflict detection service"
```

### Task 1.2: `addExtraItem` accepts `acknowledgedConflict`; warehouse addon-search + items endpoints

**Files:**
- Modify: `apps/api/src/services/checklistService.ts:339-403` (`addExtraItem` signature + conflict audit)
- Modify: `apps/api/src/routes/warehouse.ts:381-428` (addItemBodySchema, new `/addon-search`, `/items` conflict)
- Test: `apps/api/src/__tests__/addonItems.test.ts`

- [ ] **Step 1: Write failing test**

Create `apps/api/src/__tests__/addonItems.test.ts`. Reuse the harness header from `warehouseScan.brokenUnits.test.ts:1-136` (db `test-addon-items.db`, suffix `addon-items`). Build: client, COUNT equipment `eqBusy` (totalQuantity 1) reserved by a CONFIRMED booking 2026-06-10..12; target CONFIRMED booking `tgt` 2026-06-11..13 with an ACTIVE ISSUE `ScanSession`. Then:

```ts
describe("addExtraItem conflict handling", () => {
  it("throws ADDON_CONFLICT when conflicting and not acknowledged", async () => {
    const { addExtraItem } = await import("../services/checklistService");
    await expect(
      addExtraItem(sessionId, eqBusyId, 1, "tester", false),
    ).rejects.toMatchObject({ status: 409, code: "ADDON_CONFLICT" });
  });

  it("adds + writes BOOKING_ITEM_ADDED_WITH_CONFLICT when acknowledged", async () => {
    const { addExtraItem } = await import("../services/checklistService");
    const r = await addExtraItem(sessionId, eqBusyId, 1, "tester", true);
    expect(r.bookingItemId).toBeTruthy();
    const audit = await prisma.auditEntry.findFirst({
      where: { action: "BOOKING_ITEM_ADDED_WITH_CONFLICT" },
    });
    expect(audit).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm run test -w apps/api -- addonItems`
Expected: FAIL — `addExtraItem` takes 4 args / no conflict logic.

- [ ] **Step 3: Update `addExtraItem`**

In `apps/api/src/services/checklistService.ts`, add import at top:
```ts
import { findAddonConflict } from "./addonAvailability";
```
Change signature and add conflict logic. Replace the function header and the part before the `$transaction`:

```ts
export async function addExtraItem(
  sessionId: string,
  equipmentId: string,
  quantity: number,
  createdBy: string,
  acknowledgedConflict = false,
): Promise<{ bookingItemId: string }> {
  const session = await prisma.scanSession.findUnique({
    where: { id: sessionId },
    select: { id: true, status: true, bookingId: true },
  });
  if (!session || session.status !== "ACTIVE") {
    throw new HttpError(409, "Сессия не активна", "SESSION_NOT_FOUND");
  }

  const equipment = await prisma.equipment.findUnique({ where: { id: equipmentId } });
  if (!equipment) throw new HttpError(404, "Оборудование не найдено", "EQUIPMENT_NOT_FOUND");

  const bookingId = session.bookingId;
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { startDate: true, endDate: true },
  });
  if (!booking) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");

  const conflict = await findAddonConflict(
    equipmentId, booking.startDate, booking.endDate, bookingId,
  );
  if (conflict && !acknowledgedConflict) {
    throw new HttpError(409, "Артикул занят на даты брони", "ADDON_CONFLICT", {
      bookingNo: conflict.bookingNo,
      projectName: conflict.projectName,
      from: conflict.from,
      to: conflict.to,
      freeFrom: conflict.freeFrom,
    });
  }
```

Keep the existing `$transaction` upsert block unchanged. Then replace the audit call so the action reflects conflict:

```ts
  await writeAuditEntry({
    userId: createdBy,
    action: conflict ? "BOOKING_ITEM_ADDED_WITH_CONFLICT" : "BOOKING_ITEM_ADDED_ON_SITE",
    entityType: "Booking",
    entityId: bookingId,
    before: null,
    after: {
      equipmentId, equipmentName: equipment.name, quantity, bookingItemId,
      ...(conflict ? { conflict } : {}),
    },
  }).catch((err: unknown) => {
    console.warn("[addExtraItem] audit failed:", err);
  });
```

Verify `HttpError` supports a 4th `details` arg: check `apps/api/src/utils/errors.ts`. If `HttpError(status, message, code, details?)` exists (it does — used in `expenses.ts`), pass `details` as shown. The centralized handler in `app.ts` mirrors `code` + `details` into the response body.

- [ ] **Step 4: Add warehouse endpoints**

In `apps/api/src/routes/warehouse.ts`:

Add import near top (after existing service imports):
```ts
import { findAddonConflict } from "../services/addonAvailability";
import { getAvailability } from "../services/availability";
```

Change `addItemBodySchema` (line ~381):
```ts
const addItemBodySchema = z.object({
  equipmentId: z.string().min(1),
  quantity: z.number().int().positive(),
  acknowledgedConflict: z.boolean().optional(),
});
```

Add new route before the existing `/items` route:
```ts
/** GET /api/warehouse/sessions/:id/addon-search?q= — каталог + доступность на даты брони */
warehouseScanRouter.get("/sessions/:id/addon-search", warehouseAuth, async (req, res, next) => {
  try {
    const q = z.string().min(1).max(100).parse(req.query.q);
    const session = await prisma.scanSession.findUnique({
      where: { id: req.params.id },
      select: { bookingId: true },
    });
    if (!session) { res.status(404).json({ message: "Сессия не найдена" }); return; }
    const booking = await prisma.booking.findUnique({
      where: { id: session.bookingId },
      select: { startDate: true, endDate: true },
    });
    if (!booking) { res.status(404).json({ message: "Бронь не найдена" }); return; }

    const rows = await getAvailability({
      startDate: booking.startDate,
      endDate: booking.endDate,
      search: q,
      excludeBookingId: session.bookingId,
    });
    const results = await Promise.all(
      rows.slice(0, 30).map(async (r: any) => ({
        equipmentId: r.equipmentId,
        name: r.name,
        category: r.category,
        availableQuantity: r.availableQuantity,
        availability: r.availability,
        conflict:
          r.availability === "UNAVAILABLE"
            ? await findAddonConflict(r.equipmentId, booking.startDate, booking.endDate, session.bookingId)
            : null,
      })),
    );
    res.json({ results });
  } catch (err) { next(err); }
});
```

Update the existing `/items` handler body to pass the flag:
```ts
warehouseScanRouter.post("/sessions/:id/items", warehouseAuth, async (req, res, next) => {
  try {
    const { equipmentId, quantity, acknowledgedConflict } = addItemBodySchema.parse(req.body);
    const createdBy = req.warehouseWorker?.name ?? "warehouse";
    const result = await addExtraItem(req.params.id, equipmentId, quantity, createdBy, acknowledgedConflict ?? false);
    res.status(201).json(result);
  } catch (err) { next(err); }
});
```

- [ ] **Step 5: Run test, verify PASS**

Run: `npm run test -w apps/api -- addonItems`
Expected: PASS (2 tests).

- [ ] **Step 6: Regression — checklist tests still green**

Run: `npm run test -w apps/api -- checklist`
Expected: PASS. If `addExtraItem` callers in `checklistService.test.ts`/`checklistRoutes.test.ts` break on arity, the 5th arg is optional (default false) — no change needed; confirm green.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/checklistService.ts apps/api/src/routes/warehouse.ts apps/api/src/__tests__/addonItems.test.ts
git commit -m "feat(warehouse): addon-search endpoint + soft-warn conflict on add-on"
```

---

## Phase 2 — Backend: `problemUnits` completion + ProblemItem lifecycle

Replace `lostUnits` with `problemUnits`. Add `createProblemItem`, status mapping, and late-return auto-resolve.

### Task 2.1: `problemItemService` (create + resolve + auto-resolve)

**Files:**
- Create: `apps/api/src/services/problemItemService.ts`
- Test: `apps/api/src/__tests__/problemItemService.test.ts`

- [ ] **Step 1: Write failing test**

Create `apps/api/src/__tests__/problemItemService.test.ts` (harness header from `warehouseScan.brokenUnits.test.ts:1-136`, db `test-problem-svc.db`, suffix `problem-svc`). Tests:

```ts
describe("createProblemItem", () => {
  it("LEFT_ON_SITE → status EXPECTED, unit MISSING, audit PROBLEM_ITEM_CREATE", async () => {
    const eq = await prisma.equipment.create({ data: { importKey: "ps1", name: "X", category: "C", rentalRatePerShift: 1, stockTrackingMode: "UNIT" } });
    const unit = await prisma.equipmentUnit.create({ data: { equipmentId: eq.id, status: "ISSUED" } });
    const { createProblemItem } = await import("../services/problemItemService");
    const pi = await createProblemItem({
      equipmentUnitId: unit.id, reason: "LEFT_ON_SITE", comment: "ночная смена",
      expectedBackDate: new Date("2026-06-20"), sourceBookingId: null, createdBy: "tester",
    });
    expect(pi.status).toBe("EXPECTED");
    const u = await prisma.equipmentUnit.findUnique({ where: { id: unit.id } });
    expect(u!.status).toBe("MISSING");
    const a = await prisma.auditEntry.findFirst({ where: { action: "PROBLEM_ITEM_CREATE", entityId: unit.id } });
    expect(a).not.toBeNull();
  });

  it("DESTROYED → status WROTE_OFF (closed), unit RETIRED", async () => {
    const eq = await prisma.equipment.create({ data: { importKey: "ps2", name: "Y", category: "C", rentalRatePerShift: 1, stockTrackingMode: "UNIT" } });
    const unit = await prisma.equipmentUnit.create({ data: { equipmentId: eq.id, status: "ISSUED" } });
    const { createProblemItem } = await import("../services/problemItemService");
    const pi = await createProblemItem({ equipmentUnitId: unit.id, reason: "DESTROYED", comment: "разбит", sourceBookingId: null, createdBy: "t" });
    expect(pi.status).toBe("WROTE_OFF");
    expect(pi.resolvedAt).not.toBeNull();
    const u = await prisma.equipmentUnit.findUnique({ where: { id: unit.id } });
    expect(u!.status).toBe("RETIRED");
  });

  it("resolveProblemItem FOUND → unit AVAILABLE, status FOUND, audit", async () => {
    const eq = await prisma.equipment.create({ data: { importKey: "ps3", name: "Z", category: "C", rentalRatePerShift: 1, stockTrackingMode: "UNIT" } });
    const unit = await prisma.equipmentUnit.create({ data: { equipmentId: eq.id, status: "ISSUED" } });
    const { createProblemItem, resolveProblemItem } = await import("../services/problemItemService");
    const pi = await createProblemItem({ equipmentUnitId: unit.id, reason: "LOST", comment: "пропал", sourceBookingId: null, createdBy: "t" });
    const r = await resolveProblemItem(pi.id, "FOUND", "нашёлся на складе", "mgr");
    expect(r.status).toBe("FOUND");
    const u = await prisma.equipmentUnit.findUnique({ where: { id: unit.id } });
    expect(u!.status).toBe("AVAILABLE");
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm run test -w apps/api -- problemItemService`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement service**

Create `apps/api/src/services/problemItemService.ts`:

```ts
import { Prisma } from "@prisma/client";
import type { ProblemReason } from "@prisma/client";
import { prisma } from "../prisma";
import { writeAuditEntry } from "./audit";
import { HttpError } from "../utils/errors";

type TxClient = Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">;

export interface CreateProblemArgs {
  equipmentUnitId: string;
  reason: ProblemReason;
  comment: string;
  expectedBackDate?: Date | null;
  sourceBookingId?: string | null;
  createdBy: string;
}

function plannedStatus(reason: ProblemReason): "EXPECTED" | "SEARCHING" | "WROTE_OFF" {
  if (reason === "LEFT_ON_SITE") return "EXPECTED";
  if (reason === "DESTROYED") return "WROTE_OFF";
  return "SEARCHING"; // LOST, STOLEN
}
function unitStatusFor(reason: ProblemReason): "MISSING" | "RETIRED" {
  return reason === "DESTROYED" ? "RETIRED" : "MISSING";
}

export async function createProblemItem(args: CreateProblemArgs, tx?: TxClient) {
  const run = async (db: TxClient) => {
    const unit = await db.equipmentUnit.findUnique({ where: { id: args.equipmentUnitId } });
    if (!unit) throw new HttpError(404, "Единица не найдена", "UNIT_NOT_FOUND");

    const status = plannedStatus(args.reason);
    const newUnitStatus = unitStatusFor(args.reason);
    const pi = await db.problemItem.create({
      data: {
        equipmentUnitId: args.equipmentUnitId,
        sourceBookingId: args.sourceBookingId ?? null,
        reason: args.reason,
        comment: args.comment,
        expectedBackDate: args.expectedBackDate ?? null,
        status,
        createdBy: args.createdBy,
        resolvedAt: status === "WROTE_OFF" ? new Date() : null,
        resolvedBy: status === "WROTE_OFF" ? args.createdBy : null,
        resolutionNote: status === "WROTE_OFF" ? "Списано при приёмке (уничтожено)" : null,
      },
    });
    await db.equipmentUnit.update({
      where: { id: args.equipmentUnitId },
      data: { status: newUnitStatus },
    });
    await writeAuditEntry({
      tx: db, userId: args.createdBy, action: "PROBLEM_ITEM_CREATE",
      entityType: "ProblemItem", entityId: args.equipmentUnitId,
      before: { status: unit.status },
      after: { reason: args.reason, problemStatus: status, unitStatus: newUnitStatus, problemItemId: pi.id },
    });
    return pi;
  };
  return tx ? run(tx) : prisma.$transaction(run);
}

export async function resolveProblemItem(
  id: string,
  outcome: "FOUND" | "NOT_FOUND",
  note: string,
  resolvedBy: string,
) {
  return prisma.$transaction(async (tx: TxClient) => {
    const pi = await tx.problemItem.findUnique({ where: { id } });
    if (!pi) throw new HttpError(404, "Запись не найдена", "PROBLEM_ITEM_NOT_FOUND");
    if (pi.status === "FOUND" || pi.status === "NOT_FOUND" || pi.status === "WROTE_OFF") {
      throw new HttpError(409, "Запись уже закрыта", "PROBLEM_ITEM_CLOSED");
    }
    const updated = await tx.problemItem.update({
      where: { id },
      data: { status: outcome, resolutionNote: note, resolvedAt: new Date(), resolvedBy },
    });
    if (outcome === "FOUND") {
      await tx.equipmentUnit.update({
        where: { id: pi.equipmentUnitId },
        data: { status: "AVAILABLE" },
      });
    }
    // FUTURE: outcome === "NOT_FOUND" → создать «долг гафера» (раздел долгов). Не реализуем сейчас.
    await writeAuditEntry({
      tx, userId: resolvedBy, action: "PROBLEM_ITEM_RESOLVE",
      entityType: "ProblemItem", entityId: pi.equipmentUnitId,
      before: { status: pi.status },
      after: { status: outcome, note },
    });
    return updated;
  });
}

/** Авто-резолв при позднем возврате: вызывается из completeSession (RETURN). */
export async function autoResolveOnReturn(
  tx: TxClient,
  equipmentUnitId: string,
  resolvedBy: string,
): Promise<void> {
  const open = await tx.problemItem.findFirst({
    where: { equipmentUnitId, status: { in: ["EXPECTED", "SEARCHING"] } },
    orderBy: { createdAt: "desc" },
  });
  if (!open) return;
  await tx.problemItem.update({
    where: { id: open.id },
    data: { status: "FOUND", resolvedAt: new Date(), resolvedBy,
             resolutionNote: "возвращён повторной приёмкой" },
  });
  await writeAuditEntry({
    tx, userId: resolvedBy, action: "PROBLEM_ITEM_RESOLVE",
    entityType: "ProblemItem", entityId: equipmentUnitId,
    before: { status: open.status }, after: { status: "FOUND", note: "возвращён повторной приёмкой" },
  });
}
```

- [ ] **Step 4: Run test, verify PASS**

Run: `npm run test -w apps/api -- problemItemService`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/problemItemService.ts apps/api/src/__tests__/problemItemService.test.ts
git commit -m "feat(warehouse): problem-item service (create/resolve/auto-resolve)"
```

### Task 2.2: `completeSession` — `repairUnits`/`problemUnits`, drop `lostUnits`; auto-resolve

**Files:**
- Modify: `apps/api/src/services/warehouseScan.ts:27-57` (types), `:166-534` (completeSession)
- Modify: `apps/api/src/routes/warehouse.ts:291-369` (Zod schemas + handler)
- Rewrite: `apps/api/src/__tests__/warehouseLostUnit.test.ts` → `apps/api/src/__tests__/warehouseProblemUnit.test.ts`
- Modify: `apps/api/src/__tests__/warehouseScan.brokenUnits.test.ts` (rename payload key)

- [ ] **Step 1: Write failing test (problemUnits)**

Create `apps/api/src/__tests__/warehouseProblemUnit.test.ts` reusing the `setupReturnSession` helper + harness from `warehouseLostUnit.test.ts:1-123` (db `test-problem-unit.db`, suffix `problem-unit`). Tests:

```ts
describe("completeSession problemUnits", () => {
  it("LOST → ProblemItem SEARCHING, unit MISSING (not RETIRED)", async () => {
    const { unit, booking, session } = await setupReturnSession("PU-LOST-1");
    const { completeSession } = await import("../services/warehouseScan");
    await completeSession(session.id, {
      problemUnits: [{ equipmentUnitId: unit.id, reason: "LOST", comment: "не вернули со смены" }],
      createdBy: adminUserId,
    });
    const u = await prisma.equipmentUnit.findUnique({ where: { id: unit.id } });
    expect(u!.status).toBe("MISSING");
    const pi = await prisma.problemItem.findFirst({ where: { equipmentUnitId: unit.id } });
    expect(pi!.reason).toBe("LOST");
    expect(pi!.status).toBe("SEARCHING");
    expect(pi!.sourceBookingId).toBe(booking.id);
  });

  it("DESTROYED → unit RETIRED, ProblemItem WROTE_OFF", async () => {
    const { unit, session } = await setupReturnSession("PU-DESTR-1");
    const { completeSession } = await import("../services/warehouseScan");
    await completeSession(session.id, {
      problemUnits: [{ equipmentUnitId: unit.id, reason: "DESTROYED", comment: "раздавлен" }],
      createdBy: adminUserId,
    });
    const u = await prisma.equipmentUnit.findUnique({ where: { id: unit.id } });
    expect(u!.status).toBe("RETIRED");
  });

  it("repairUnits still creates Repair (renamed from brokenUnits)", async () => {
    const { unit, session } = await setupReturnSession("PU-REPAIR-1");
    const { completeSession } = await import("../services/warehouseScan");
    const s = await completeSession(session.id, {
      repairUnits: [{ equipmentUnitId: unit.id, comment: "трещина" }],
      createdBy: adminUserId,
    });
    expect(s.createdRepairIds).toHaveLength(1);
    const rep = await prisma.repair.findUnique({ where: { id: s.createdRepairIds[0] } });
    expect(rep!.urgency).toBe("NORMAL"); // default, not collected in fast panel
    expect(rep!.reason).toBe("трещина");
  });

  it("late return auto-resolves an open EXPECTED ProblemItem", async () => {
    const { createProblemItem } = await import("../services/problemItemService");
    const { unit, session } = await setupReturnSession("PU-LATE-1");
    await createProblemItem({ equipmentUnitId: unit.id, reason: "LEFT_ON_SITE",
      comment: "осталось", sourceBookingId: null, createdBy: adminUserId });
    const { completeSession } = await import("../services/warehouseScan");
    await completeSession(session.id, { createdBy: adminUserId });
    const pi = await prisma.problemItem.findFirst({ where: { equipmentUnitId: unit.id } });
    expect(pi!.status).toBe("FOUND");
    const u = await prisma.equipmentUnit.findUnique({ where: { id: unit.id } });
    expect(u!.status).toBe("AVAILABLE");
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm run test -w apps/api -- warehouseProblemUnit`
Expected: FAIL — `problemUnits`/`repairUnits` not handled.

- [ ] **Step 3: Update `warehouseScan.ts` types**

In `apps/api/src/services/warehouseScan.ts`:
- Add import: `import { createProblemItem, autoResolveOnReturn } from "./problemItemService";`
- Add import: `import type { ProblemReason } from "@prisma/client";`
- Replace `BrokenUnit` interface with:
```ts
export interface RepairUnit {
  equipmentUnitId: string;
  comment: string;
  urgency?: RepairUrgency;
}
export interface ProblemUnit {
  equipmentUnitId: string;
  reason: ProblemReason;        // LEFT_ON_SITE | LOST | DESTROYED | STOLEN
  comment: string;
  expectedBackDate?: string;    // ISO, только LEFT_ON_SITE
}
```
- Delete the `LostLocation` type and `LostUnit` interface.
- In `ReconciliationSummary`, replace `failedBrokenUnits`/`failedLostUnits` semantics-preserving: rename `failedBrokenUnits`→ keep, drop `failedLostUnits`, add `createdProblemItemIds: string[]` and `failedProblemUnits: Array<{ equipmentUnitId: string; reason: string }>`.

- [ ] **Step 4: Update `completeSession`**

Change the signature options:
```ts
options?: { repairUnits?: RepairUnit[]; problemUnits?: ProblemUnit[]; createdBy?: string },
```
Inside the main `$transaction`, in the RETURN branch, after a unit is scanned & set AVAILABLE, call auto-resolve:
```ts
await autoResolveOnReturn(tx, unit.id, options?.createdBy ?? session.workerName);
```
After the transaction: keep the existing broken→repair loop but rename source to `options?.repairUnits ?? []`, map `{ unitId: b.equipmentUnitId, reason: b.comment, urgency: b.urgency ?? "NORMAL" }` into `createRepair`. Replace the entire `lostUnits` block (the `~lostUnits = options?.lostUnits ?? []` section through its `invoiceNeedsReissue` logic) with a `problemUnits` loop:
```ts
const problemUnits = options?.problemUnits ?? [];
if (problemUnits.length > 0 && session.operation === "RETURN") {
  const createdBy = options?.createdBy ?? session.workerName;
  for (const p of problemUnits) {
    try {
      const pi = await createProblemItem({
        equipmentUnitId: p.equipmentUnitId,
        reason: p.reason,
        comment: p.comment,
        expectedBackDate: p.expectedBackDate ? new Date(p.expectedBackDate) : null,
        sourceBookingId: session.bookingId,
        createdBy,
      });
      summary.createdProblemItemIds.push(pi.id);
    } catch (err: unknown) {
      summary.failedProblemUnits.push({
        equipmentUnitId: p.equipmentUnitId,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
```
Initialize `createdProblemItemIds: []`, `failedProblemUnits: []` in the `summary` object literal; remove `failedLostUnits` and `invoiceNeedsReissue` fields and their logic (compensation/invoice-resync removed with `lostUnits`). Update `getReconciliationPreview` return to drop removed fields and add the two new empty arrays.

- [ ] **Step 5: Update route schemas/handler**

In `apps/api/src/routes/warehouse.ts` replace `brokenUnitSchema`/`lostUnitSchema`/`completeSessionBodySchema` with:
```ts
const repairUnitSchema = z.object({
  equipmentUnitId: z.string().min(1),
  comment: z.string().min(1),
  urgency: z.enum(["NOT_URGENT", "NORMAL", "URGENT"]).optional(),
});
const problemUnitSchema = z.object({
  equipmentUnitId: z.string().min(1),
  reason: z.enum(["LEFT_ON_SITE", "LOST", "DESTROYED", "STOLEN"]),
  comment: z.string().min(1),
  expectedBackDate: z.string().datetime().optional(),
});
const completeSessionBodySchema = z.object({
  repairUnits: z.array(repairUnitSchema).optional(),
  problemUnits: z.array(problemUnitSchema).optional(),
}).optional();
```
In the `/complete` handler, replace `brokenUnits`/`lostUnits` extraction with `repairUnits`/`problemUnits`, drop the enrich/`invoiceNeedsReissue` field from the response, and return `createdProblemItemIds`, `failedProblemUnits` alongside `createdRepairIds`, `failedBrokenUnits`.

- [ ] **Step 6: Update brokenUnits regression test key**

In `apps/api/src/__tests__/warehouseScan.brokenUnits.test.ts`, replace every `brokenUnits: [{ equipmentUnitId, reason, urgency }]` with `repairUnits: [{ equipmentUnitId, comment: reason, urgency }]` and adjust assertions (`repair.reason` now equals the comment string). Delete `warehouseLostUnit.test.ts` (`git rm`) — superseded by `warehouseProblemUnit.test.ts`.

- [ ] **Step 7: Run targeted tests, verify PASS**

Run: `npm run test -w apps/api -- warehouseProblemUnit warehouseScan`
Expected: PASS.

- [ ] **Step 8: Full API suite green**

Run: `npm test -w apps/api`
Expected: PASS. Fix any remaining `lostUnits`/`brokenUnits` references the compiler/tests flag (grep `lostUnits` under `apps/api/src` — expect zero).

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/services/warehouseScan.ts apps/api/src/routes/warehouse.ts apps/api/src/__tests__/warehouseProblemUnit.test.ts apps/api/src/__tests__/warehouseScan.brokenUnits.test.ts
git rm apps/api/src/__tests__/warehouseLostUnit.test.ts
git commit -m "feat(warehouse): replace lostUnits with problemUnits + ProblemItem lifecycle"
```

---

## Phase 3 — Backend: repair photos (session staging → Repair)

### Task 3.1: Photo upload util + warehouse staging endpoints

**Files:**
- Create: `apps/api/src/services/repairPhotoStorage.ts`
- Modify: `apps/api/src/routes/warehouse.ts` (3 photo routes)
- Test: `apps/api/src/__tests__/repairPhotos.test.ts`

- [ ] **Step 1: Implement storage util (mirror expenses pattern)**

Create `apps/api/src/services/repairPhotoStorage.ts`. Copy the constants/helpers from `apps/api/src/routes/expenses.ts:14-83` (`UPLOAD_ROOT`, `MAGIC_BYTES` minus PDF, `validateMagicBytes`, `sanitizeFilename`, `resolveDocumentPath` → rename `resolveUploadPath`) but restrict `ALLOWED_MIME_TYPES` to `image/jpeg`,`image/png` and export them. Add:
```ts
import path from "path";
import fs from "fs";
import crypto from "crypto";
export const UPLOAD_ROOT = path.resolve(__dirname, "../../uploads");
export function stageDir(sessionId: string, unitId: string) {
  return path.join("scan-sessions", sessionId, unitId);
}
export function writeStagedPhoto(sessionId: string, unitId: string, buf: Buffer, original: string) {
  const rel = path.join(stageDir(sessionId, unitId),
    `${crypto.randomBytes(4).toString("hex")}_${sanitizeFilename(original)}`);
  const abs = path.join(UPLOAD_ROOT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
  return rel;
}
export function listStaged(sessionId: string, unitId: string): string[] {
  const abs = path.join(UPLOAD_ROOT, stageDir(sessionId, unitId));
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs).map((f) => path.join(stageDir(sessionId, unitId), f));
}
/** Перенести стейдж-фото юнита в uploads/repairs/{repairId}/ и вернуть rel-пути. */
export function moveStagedToRepair(sessionId: string, unitId: string, repairId: string): string[] {
  const out: string[] = [];
  for (const rel of listStaged(sessionId, unitId)) {
    const destRel = path.join("repairs", repairId, path.basename(rel));
    const destAbs = path.join(UPLOAD_ROOT, destRel);
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    fs.renameSync(path.join(UPLOAD_ROOT, rel), destAbs);
    out.push(destRel);
  }
  return out;
}
```

- [ ] **Step 2: Write failing test**

Create `apps/api/src/__tests__/repairPhotos.test.ts` (harness from `warehouseLostUnit.test.ts:1-123`, db `test-repair-photos.db`, suffix `repair-photos`, reuse `setupReturnSession`). A 1×1 PNG buffer:
```ts
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=", "base64");
```
Test that `moveStagedToRepair` links files and `completeSession` with `repairUnits` produces `RepairPhoto` rows:
```ts
it("staged photos become RepairPhoto on complete", async () => {
  const { unit, session } = await setupReturnSession("RP-1");
  const { writeStagedPhoto } = await import("../services/repairPhotoStorage");
  writeStagedPhoto(session.id, unit.id, PNG, "broke.png");
  const { completeSession } = await import("../services/warehouseScan");
  const s = await completeSession(session.id, {
    repairUnits: [{ equipmentUnitId: unit.id, comment: "скол" }], createdBy: adminUserId,
  });
  const photos = await prisma.repairPhoto.findMany({ where: { repairId: s.createdRepairIds[0] } });
  expect(photos).toHaveLength(1);
  expect(photos[0].filePath.startsWith("repairs/")).toBe(true);
});
```

- [ ] **Step 3: Run test, verify it fails**

Run: `npm run test -w apps/api -- repairPhotos`
Expected: FAIL — no `RepairPhoto` created on complete.

- [ ] **Step 4: Link photos in completeSession**

In `warehouseScan.ts`, in the `repairUnits` loop, right after a `Repair` is created successfully (`summary.createdRepairIds.push(repair.id);`), add:
```ts
const moved = moveStagedToRepair(sessionId, broken.equipmentUnitId, repair.id);
if (moved.length > 0) {
  await prisma.repairPhoto.createMany({
    data: moved.map((fp) => ({ repairId: repair.id, filePath: fp, createdBy })),
  });
}
```
Add import: `import { moveStagedToRepair } from "./repairPhotoStorage";`

- [ ] **Step 5: Add warehouse photo endpoints**

In `apps/api/src/routes/warehouse.ts` add a multer instance mirroring `expenses.ts:73-83` (memoryStorage, 5 MB, jpeg/png only) and routes on `warehouseScanRouter`:
- `POST /sessions/:id/units/:unitId/photos` (field `photo`, validate magic bytes via `validateMagicBytes`, `writeStagedPhoto`, return `{ photos: listStaged(...) }`).
- `GET /sessions/:id/units/:unitId/photos` → `{ photos: listStaged(...) }`.
- `DELETE /sessions/:id/units/:unitId/photos/:name` → unlink one staged file (resolve safely under `UPLOAD_ROOT`, 404 if escapes).
Each returns relative paths; the UI renders via a streamed GET (Task 3.2).

- [ ] **Step 6: Run test + commit**

Run: `npm run test -w apps/api -- repairPhotos`
Expected: PASS.
```bash
git add apps/api/src/services/repairPhotoStorage.ts apps/api/src/routes/warehouse.ts apps/api/src/services/warehouseScan.ts apps/api/src/__tests__/repairPhotos.test.ts
git commit -m "feat(warehouse): repair photo staging + link to Repair on complete"
```

### Task 3.2: Expose photos on `GET /api/repairs/:id` + stream endpoint

**Files:**
- Modify: `apps/api/src/routes/repairs.ts` (include photos in detail; add `GET /:id/photos/:photoId`)
- Test: `apps/api/src/__tests__/repairs.routes.test.ts` (extend)

- [ ] **Step 1: Write failing assertion** — in `repairs.routes.test.ts`, add a test: create a Repair + `RepairPhoto`, `GET /api/repairs/:id` (signSession SUPER_ADMIN per existing pattern in that file) → body has `photos: [{ id, url }]` where url = `/api/repairs/{id}/photos/{photoId}`.
- [ ] **Step 2: Run, verify fail.** Run: `npm run test -w apps/api -- repairs.routes` → FAIL.
- [ ] **Step 3: Implement.** In `repairs.ts` `GET /:id`, add `photos: { select: { id: true, filePath: true } }` to the Prisma `include`, map to `{ id, url: \`/api/repairs/${id}/photos/${p.id}\` }`. Add `GET /:id/photos/:photoId` (rolesGuard SA+WAREHOUSE+TECHNICIAN) that loads `RepairPhoto`, resolves `path.resolve(UPLOAD_ROOT, filePath)` with traversal guard (reuse `resolveUploadPath` from `repairPhotoStorage`), sets image content-type, streams via `fs.createReadStream`.
- [ ] **Step 4: Run, verify PASS.** Run: `npm run test -w apps/api -- repairs.routes` → PASS.
- [ ] **Step 5: Commit.**
```bash
git add apps/api/src/routes/repairs.ts apps/api/src/__tests__/repairs.routes.test.ts
git commit -m "feat(repairs): expose repair photos in detail + stream endpoint"
```

---

## Phase 4 — Backend: «Потеряшки» registry API

### Task 4.1: `problem-items` router (list + resolve)

**Files:**
- Create: `apps/api/src/routes/problemItems.ts`
- Modify: `apps/api/src/routes/index.ts` (mount with rolesGuard SA+WAREHOUSE)
- Test: `apps/api/src/__tests__/problemItems.routes.test.ts`

- [ ] **Step 1: Write failing test** — harness with `signSession` (copy header+helpers from `apps/api/src/__tests__/repairs.routes.test.ts`, db `test-problem-routes.db`). Tests: `GET /api/problem-items?status=SEARCHING` returns created items; `POST /api/problem-items/:id/resolve {outcome:"FOUND",note}` flips status + unit AVAILABLE; TECHNICIAN → 403.
- [ ] **Step 2: Run, verify fail.** `npm run test -w apps/api -- problemItems.routes` → FAIL.
- [ ] **Step 3: Implement router** — `problemItems.ts`: `GET /` (Zod query `status?`, `limit` 1–200 default 50, `cursor?`; keyset by `createdAt,id` like `audit.ts`; include `equipmentUnit: { select: { equipment: { select: { name: true, category: true } } } }`); `POST /:id/resolve` (Zod `{ outcome: z.enum(["FOUND","NOT_FOUND"]), note: z.string().min(3) }`, call `resolveProblemItem`, `req.adminUser!.userId`). Export `problemItemsRouter`.
- [ ] **Step 4: Mount** — in `routes/index.ts` add import and `router.use("/api/problem-items", rolesGuard(["SUPER_ADMIN","WAREHOUSE"]), problemItemsRouter);` near the repairs mount.
- [ ] **Step 5: Run, verify PASS.** `npm run test -w apps/api -- problemItems.routes` → PASS.
- [ ] **Step 6: Full API suite.** Run: `npm test -w apps/api` → PASS.
- [ ] **Step 7: Commit.**
```bash
git add apps/api/src/routes/problemItems.ts apps/api/src/routes/index.ts apps/api/src/__tests__/problemItems.routes.test.ts
git commit -m "feat(warehouse): Потеряшки registry API (list + resolve)"
```

---

## Phase 5 — Frontend: decomposition + adaptive shell + booking list

> All components: IBM Plex canon, Russian, no barcodes. Mockup fidelity gate in Phase 9. Reuse existing API/sessionStorage token logic from current `apps/web/app/warehouse/scan/page.tsx` (read it first; preserve auth/session contracts).

### Task 5.1: Extract types + API client + session hook

**Files:**
- Create: `apps/web/src/components/warehouse/types.ts`, `api.ts`, `useScanSession.ts`
- Modify: `apps/web/app/warehouse/scan/page.tsx` (becomes thin shell — later tasks)

- [ ] **Step 1:** Read `apps/web/app/warehouse/scan/page.tsx` fully. Inventory: token storage key, fetch wrapper, step state machine, checklist types. Note exact request headers used today.
- [ ] **Step 2:** Create `types.ts` with `ScanStep`, `ChecklistItem`, `ChecklistUnit` (`problemType` etc. mirroring `checklistService` `ChecklistState`), `Outcome = "ACCEPTED"|"REPAIR"|"PROBLEM"`, `ProblemReason`, `AddonResult`.
- [ ] **Step 3:** Create `api.ts` — typed wrappers (`authWorker`, `listBookings`, `createSession`, `getState`, `check`, `uncheck`, `addonSearch`, `addItem`, `uploadPhoto`, `listPhotos`, `deletePhoto`, `summary`, `complete`, `cancel`) using the existing token header convention. Each returns parsed JSON, throws `{ code, message, details }` on non-2xx.
- [ ] **Step 4:** Create `useScanSession.ts` — holds state machine + optimistic check/uncheck (snapshot→apply→reconcile, per-id in-flight `useRef<Set<string>>`), mirroring the Tasks optimistic pattern referenced in CLAUDE.md (`useTasksQuery`).
- [ ] **Step 5:** `npm run build -w apps/web` → PASS. Commit:
```bash
git add apps/web/src/components/warehouse/
git commit -m "feat(web/warehouse): scan types, api client, session hook"
```

### Task 5.2: Adaptive shell + LoginStep + BookingList (no filters)

**Files:**
- Create: `apps/web/src/components/warehouse/LoginStep.tsx`, `BookingList.tsx`, `ScanShell.tsx`
- Modify: `apps/web/app/warehouse/scan/page.tsx`

- [ ] **Step 1:** `ScanShell.tsx` — responsive frame: mobile single column; `lg:` two-pane grid (`lg:grid lg:grid-cols-[minmax(280px,360px)_1fr]`). Dark header band (`bg-accent`/canon), step children slot. No AppShell.
- [ ] **Step 2:** `LoginStep.tsx` — port existing PIN login UI to canon tokens (worker name select + PIN, calls `api.authWorker`, stores token as today). No behavior change.
- [ ] **Step 3:** `BookingList.tsx` — fetch `listBookings(operation)`; **no tabs/search/filter**; client-group by Moscow date into «Сегодня»/«Завтра»/«Позже» using `apps/web/src/lib/moscowDate.ts`; sort `startDate` asc then `createdAt` asc; card = colored left border by bucket, `#`+last6(id).toUpperCase(), projectName, client, «N ед.»; tap → `createSession` → checklist. Match `docs/mockups/warehouse-scan/03-issue-and-desktop.html` block 1.
- [ ] **Step 4:** Rewire `page.tsx` to a thin shell rendering `LoginStep`/`BookingList` via the step machine; keep `IssueChecklist`/`ReturnChecklist` as TODO placeholders rendering `null` (filled next phase) so build passes.
- [ ] **Step 5:** `npm run build -w apps/web` → PASS. Commit:
```bash
git add apps/web/src/components/warehouse/ apps/web/app/warehouse/scan/page.tsx
git commit -m "feat(web/warehouse): adaptive shell, login, filter-less booking list"
```

---

## Phase 6 — Frontend: issue checklist + add-on availability

### Task 6.1: `UnitRow` + `IssueChecklist`

**Files:** Create `apps/web/src/components/warehouse/UnitRow.tsx`, `IssueChecklist.tsx`.

- [ ] **Step 1:** `UnitRow.tsx` — props `{ mode: "ISSUE"|"RETURN", name, ordinalLabel, value, onChange, ... }`. ISSUE: 2 segment buttons (✓ выдано emerald / ✗ не выдаём slate). RETURN: 3 buttons (✓ emerald / 🔧 amber / ✗ rose) — used in Phase 7. Touch target ≥ 40px, canon tokens, `aria-label` Russian. No barcode; show `ordinalLabel` («прибор N из M»).
- [ ] **Step 2:** `IssueChecklist.tsx` — load `getState`; group by category; «Выдать всё разом» (mass ✓ via optimistic check on all UNIT ids / COUNT lines); per-row `UnitRow mode=ISSUE` calling `check`/`uncheck`; sticky «＋ Добор» button opening `AddonSearch` (Task 6.2); footer «Завершить выдачу» → summary→complete. Match `03-issue-and-desktop.html` block 2.
- [ ] **Step 3:** `npm run build -w apps/web` → PASS. Commit `feat(web/warehouse): issue checklist + unit row`.

### Task 6.2: `AddonSearch` with availability soft-warning

**Files:** Create `apps/web/src/components/warehouse/AddonSearch.tsx`.

- [ ] **Step 1:** Debounced search → `api.addonSearch(sessionId, q)`; render rows with availability pill (`свободно ×K` emerald / `занято` rose). On pick of an available item → `api.addItem` (no flag). On pick of a conflicted item → red warning card (conflict.bookingNo, projectName, from–to, «свободно с» = freeFrom) with «Отмена» / «Выдать под ответственность»; the latter calls `api.addItem({ acknowledgedConflict: true })`. On 409 `ADDON_CONFLICT` from a race, surface the same warning from `err.details`. Mobile = bottom sheet; `lg:` = inline panel (not modal). Match `03-issue-and-desktop.html` block 3.
- [ ] **Step 2:** `npm run build -w apps/web` → PASS. Commit `feat(web/warehouse): add-on search with availability soft-warning`.

---

## Phase 7 — Frontend: return checklist (3 outcomes) + panels + camera

### Task 7.1: `RepairPanel` (camera) + `ProblemPanel` (4 reasons)

**Files:** Create `apps/web/src/components/warehouse/RepairPanel.tsx`, `ProblemPanel.tsx`.

- [ ] **Step 1:** `RepairPanel.tsx` — inline amber panel: required comment textarea + `<input type="file" accept="image/*" capture="environment" multiple>` styled as «📷 Фото»; on change upload each via `api.uploadPhoto(sessionId, unitId, file)`, render thumbnails from `api.listPhotos`, delete via `api.deletePhoto`. Validation: comment non-empty before the row counts as resolved. Match `01-return-checklist.html` (amber expanded row).
- [ ] **Step 2:** `ProblemPanel.tsx` — inline rose panel: 4 reason chips `LEFT_ON_SITE/LOST/DESTROYED/STOLEN` (labels 📍 Остался на площадке / 🤷 Потерян / 💥 Уничтожен / 🚨 Украден), required comment, and an «ожидается к дате» date input shown only when `LEFT_ON_SITE`. Match `02-problem-reasons.html`.
- [ ] **Step 3:** `npm run build -w apps/web` → PASS. Commit `feat(web/warehouse): repair & problem inline panels with camera`.

### Task 7.2: `ReturnChecklist`

**Files:** Create `apps/web/src/components/warehouse/ReturnChecklist.tsx`.

- [ ] **Step 1:** Load `getState` (RETURN); «Принять всё разом» = mark all units ACCEPTED (optimistic `check`). Per unit `UnitRow mode=RETURN` (✓/🔧/✗). Selecting 🔧 expands `RepairPanel`; ✗ expands `ProblemPanel`. Maintain local outcome map; «Завершить приёмку» builds payload: ACCEPTED→checked units; 🔧→`repairUnits:[{equipmentUnitId,comment}]`; ✗→`problemUnits:[{equipmentUnitId,reason,comment,expectedBackDate?}]`; POST `complete`. Block submit if any 🔧/✗ row missing required comment (inline error, Russian). Result screen: created repairs, «Потеряшки» count. Match `01-return-checklist.html`.
- [ ] **Step 2:** Wire into `page.tsx` step machine; remove placeholder.
- [ ] **Step 3:** `npm run build -w apps/web` → PASS. Commit `feat(web/warehouse): 3-outcome adaptive return checklist`.

---

## Phase 8 — Frontend: «Потеряшки» registry page

### Task 8.1: `ProblemItemsPage`

**Files:** Create `apps/web/src/components/warehouse/ProblemItemsPage.tsx`, `apps/web/app/warehouse/problems/page.tsx`; add nav link.

- [ ] **Step 1:** `apps/web/app/warehouse/problems/page.tsx` — `useRequireRole(["SUPER_ADMIN","WAREHOUSE"])` + Suspense wrapper (mirror `apps/web/app/tasks/page.tsx`).
- [ ] **Step 2:** `ProblemItemsPage.tsx` — status pills filter (EXPECTED/SEARCHING/FOUND/NOT_FOUND/WROTE_OFF), list rows: equipment name (no barcode), bookingNo, reason label, comment, expectedBackDate, status `StatusPill`, createdAt. Actions for open items: «Найдено» / «Не найдено» (modal: required note ≥ 3 chars) → `POST /api/problem-items/:id/resolve`; optimistic refresh. «Загрузить ещё» cursor pagination.
- [ ] **Step 3:** Add link card to `/admin` page and a `DayWarehouse`/`DaySuperAdmin` entry point (mirror existing patterns in `apps/web/src/lib/roleMatrix.ts` / day components).
- [ ] **Step 4:** `npm run build -w apps/web` → PASS. Commit `feat(web/warehouse): Потеряшки registry page`.

---

## Phase 9 — Verification: design fidelity (mandatory) + full suite

> User requirement: implementation must reproduce the approved mockups with no degradation; no "done" claims without screenshots + comparison.

### Task 9.1: Live walkthrough + screenshots vs mockups

- [ ] **Step 1:** Seed DB: `npm run seed`. Start dev: `npm run dev:no-bot`.
- [ ] **Step 2:** Using preview tools, log in (PIN), and for **each** screen capture screenshots at width **375** and **1440**:
  booking list, issue checklist, add-on search (available + conflict warning), return checklist (collapsed), repair panel (expanded, with a photo thumbnail), problem panel (each of 4 reasons, LEFT_ON_SITE showing date field), summary/result, Потеряшки registry + resolve modal.
- [ ] **Step 3:** Open each `docs/mockups/warehouse-scan/*.html` side-by-side. For every screen, write a one-line PASS/diff note vs the mockup (layout, colors per canon, 3-button semantics, «Принять всё», no barcodes, Russian text, desktop two-pane). Fix any diff in the relevant component, rebuild, re-screenshot until PASS.
- [ ] **Step 4:** Negative checks: grep the new web components for hardcoded hex / `slate-`/`blue-` literals (expect none outside finance), and for any barcode/`LR-` string or scanner import (expect none). Confirm console/network clean during walkthrough.
- [ ] **Step 5:** Commit screenshots note: create `docs/mockups/warehouse-scan/FIDELITY-CHECK.md` (per-screen PASS list + screenshot file references) and commit.

### Task 9.2: Full test + lint + build gate

- [ ] **Step 1:** `npm test` → all suites PASS (shared + bot + api incl. new warehouse tests).
- [ ] **Step 2:** `npm run build` → all workspaces build.
- [ ] **Step 3:** `npm run lint` — note: pre-existing ESLint v9 config issue (Known Issue #6) may fail repo-wide; only assert no **new** lint errors in changed files (run `npx eslint` scoped to new files if global lint is broken). Document outcome.
- [ ] **Step 4:** Update `CLAUDE.md` Key Files + Conventions: new components, `ProblemItem`/`RepairPhoto`, `/api/problem-items`, `/warehouse/problems`, addon-search, `problemUnits` (replaces `lostUnits`), repair photos. Commit `docs: CLAUDE.md — warehouse scan redesign`.
- [ ] **Step 5:** Final commit if anything staged; report screenshots + test output to the user (no "done" without this evidence).

---

## Self-Review (completed by plan author)

- **Spec coverage:** booking list no-filters (5.2) ✓; issue + Выдать всё (6.1) ✓; add-on availability soft-warn (1.1/1.2/6.2) ✓; return 3-outcome (7.2) ✓; repair panel + native camera (3.1/7.1) ✓; 4 problem reasons + mapping (2.1/2.2/7.1) ✓; Потеряшки registry + resolve + FUTURE gaffer-debt hook (4.1/8.1, `// FUTURE:` in `resolveProblemItem`) ✓; auto-resolve late return (2.1/2.2) ✓; photos→Repair, visible to manager (3.1/3.2) ✓; desktop adaptive (5.2 shell, per-screen) ✓; no barcodes / Russian / canon (constraints + 9.1) ✓; urgency default NORMAL (2.2) ✓; lostUnits replaced + tests rewritten (2.2) ✓; Prisma SQLite separate tables (0.1) ✓; fidelity QA with screenshots (9.1) ✓.
- **Placeholder scan:** the only `// FUTURE:` is the deliberately-deferred gaffer-debt hook (spec §8); no TBD/implement-later in executable steps.
- **Type consistency:** `RepairUnit`/`ProblemUnit` (warehouseScan.ts) match route Zod schemas and `completeSession` payload and frontend `api.complete`; `ProblemReason`/`ProblemStatus` Prisma enums match service `plannedStatus`/`unitStatusFor` and `ProblemPanel` chips; `createProblemItem`/`resolveProblemItem`/`autoResolveOnReturn` signatures consistent across Tasks 2.1/2.2/4.1; `moveStagedToRepair`/`writeStagedPhoto`/`listStaged` consistent across 3.1/3.2.
