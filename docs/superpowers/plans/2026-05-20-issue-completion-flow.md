# ISSUE Completion Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `SummaryStep` placeholder with a working three-phase «Сверка → Подтвердить → Результат» finale for the ISSUE flow, and close the backend gap where `completeSession(ISSUE)` never transitions `booking.status` from `CONFIRMED` to `ISSUED`.

**Architecture:** The phase machine lives **inside** `IssueChecklist` (`checklist | summary | submitting | result`). No new outer step. `SummaryStep` is deleted along with the page-level `summary` step. The result view is a new presentational component `IssueResultView` mirroring `ReturnResultView`. Backend `completeSession(ISSUE)` gains a one-line `tx.booking.update({status:"ISSUED"})` inside the existing transaction, plus a best-effort `BOOKING_STATUS_CHANGED` audit outside it. `getReconciliationPreview` (the source for the сверка) is extended to return enriched `reservedButUnavailable` items (id + name + ordinal + status) so the operator sees «SkyPanel S60 · прибор 2 из 2 → ремонт».

**Tech Stack:** Express + Prisma 6 (SQLite) + Zod (`apps/api`); Next.js 14 + React 18 + Tailwind 3 + Vitest + RTL (`apps/web`); IBM Plex canon (`emerald/amber/rose/slate/accent`); `pluralize` from `src/lib/format`.

**Spec:** `docs/superpowers/specs/2026-05-20-issue-completion-flow-design.md`
**Mockup (visual source of truth):** `docs/mockups/warehouse-scan/04-issue-summary-and-result.html`
**Branch:** `feat/issue-completion` (already created)
**Working repo:** `/Users/sechenov/Documents/light-rental-system`

---

## Repo conventions reminder

- **Russian labels** everywhere; **no barcodes** in UX (use «прибор N из M»).
- **Semantic tokens only**: `text-ink|ink-2|ink-3`, `bg-surface|surface-muted|surface-subtle`, `border-border|border-strong`, `bg-emerald|emerald-soft|border-emerald-border` etc. Never raw `slate-500`/`#…`.
- **Run from repo root** unless stated otherwise. Working dir for all `npm run …` commands: `/Users/sechenov/Documents/light-rental-system`.
- Tests are run via the workspace root: backend tests run inside `apps/api` (`npm run test --workspace=apps/api -- <pattern>`), frontend tests inside `apps/web` (`npm run test --workspace=apps/web -- <pattern>`).
- **Never use** `git commit --no-verify`, `--no-gpg-sign`, or `-c commit.gpgsign=false`. Pre-commit hooks (lint + typecheck) must pass.
- **Don't `git add -A`** — the local clone has many sync-conflict files (e.g. `"AliasRow 2.tsx"`). Always add explicit paths.

---

## File Structure

### Create

| Path | Responsibility |
|---|---|
| `apps/web/src/components/warehouse/IssueResultView.tsx` | Pure presentational «Выдача оформлена[ с замечаниями]» — emerald/amber header, counts, info-block, sticky «Готово». |
| `apps/web/src/components/warehouse/__tests__/IssueResultView.test.tsx` | Counts, emerald/amber switch, onDone, no barcode. |
| `apps/web/src/components/warehouse/__tests__/IssueSummary.test.tsx` | New tests for the сверка phase inside `IssueChecklist`: badge N, stat rows, expansion lists, «Подтвердить» wiring, «← К чек-листу» round-trip, soft-warn does not block submit. |
| `apps/api/src/__tests__/warehouseScanIssueComplete.test.ts` | Backend integration: `CONFIRMED → ISSUED` + idempotent re-call. |

### Modify

| Path | Change |
|---|---|
| `apps/api/src/services/warehouseScan.ts` | (a) extend `ReconciliationSummary` shape: `reservedButUnavailable: Array<{equipmentUnitId,equipmentName,ordinalLabel,status}>`; (b) enrich it in `getReconciliationPreview`; (c) inside `completeSession` ISSUE branch — `tx.booking.update({status:"ISSUED"})` plus best-effort `BOOKING_STATUS_CHANGED` audit after tx. |
| `apps/web/src/components/warehouse/types.ts` | Add `ReservedButUnavailableUnit` interface + `SummaryResult.reservedButUnavailable` field. |
| `apps/web/src/components/warehouse/AddonSearch.tsx` | Widen `onAdded` signature to `(bookingItemId: string, hadConflict: boolean) => void`. Pass them from `doAdd` (it already knows `ack: boolean` and gets `bookingItemId` back from `addItem`'s result). |
| `apps/web/src/components/warehouse/__tests__/AddonSearch.test.tsx` | Update existing tests for the new `onAdded` arity (assert it's called with `(bookingItemId, hadConflict)`). |
| `apps/web/src/components/warehouse/IssueChecklist.tsx` | (a) phase machine `IssuePhase`; (b) new state: `countWithheld`, `withheldUnits`, `conflictAddons`, `summary`, `submitError`, `result`; (c) `handleUnitChange` distinguishes `WITHHELD` from `null`; (d) `setCount` 3-state; (e) summary phase JSX + sticky footer; (f) `submitToComplete()`; (g) result phase via `IssueResultView`; (h) wire `AddonSearch.onAdded(bookingItemId, hadConflict)` into `conflictAddons`. Remove TODO comment in footer. |
| `apps/web/src/components/warehouse/__tests__/IssueChecklist.test.tsx` | Update «Завершить выдачу» test: now switches to the in-component summary phase (badge visible), no longer calls `onComplete`. Add a test that AddonSearch.onAdded(`bi-x`, `true`) tracks `bi-x` as a conflict добор. |
| `apps/web/app/warehouse/scan/page.tsx` | Remove the `summary` step block + SummaryStep import. `IssueChecklist.onComplete` is no longer used to navigate; its result-screen «Готово» calls `onDone` → `backToBooking`. Pass `onDone={backToBooking}` to `IssueChecklist`, drop `onComplete`. |
| `apps/web/src/components/warehouse/SummaryStep.tsx` | **Delete file.** |

### Read-only references (no changes)

- `apps/web/src/components/warehouse/ReturnResultView.tsx` — canonical pattern for the result view.
- `apps/web/src/components/warehouse/ReturnChecklist.tsx` — canonical pattern for in-component phase machine.
- `apps/web/src/components/warehouse/__tests__/ReturnResultView.test.tsx` — canonical test pattern for the result view.

---

## Task 0: Branch sanity check

- [ ] **Step 1: Verify branch + clean state**

```bash
git -C /Users/sechenov/Documents/light-rental-system status -sb
```

Expected: header line `## feat/issue-completion` with no staged changes (untracked sync-conflict files like `"AliasRow 2.tsx"` are pre-existing local noise — ignore, don't `git add -A`).

- [ ] **Step 2: Verify spec + mockup are committed**

```bash
git -C /Users/sechenov/Documents/light-rental-system log --oneline -5
```

Expected: a recent commit `82d3048` (or similar) titled around «design spec: ISSUE completion flow». Spec and mockup files exist:

```bash
ls /Users/sechenov/Documents/light-rental-system/docs/superpowers/specs/2026-05-20-issue-completion-flow-design.md \
   /Users/sechenov/Documents/light-rental-system/docs/mockups/warehouse-scan/04-issue-summary-and-result.html
```

- [ ] **Step 3: Confirm baseline tests are green**

```bash
cd /Users/sechenov/Documents/light-rental-system && npm run test --workspace=apps/web -- src/components/warehouse 2>&1 | tail -20
```

Expected: all warehouse component tests pass. (Baseline — do NOT proceed if something is already red. Triage first.)

---

## Task 1: Backend — enrich `reservedButUnavailable` in `getReconciliationPreview`

**Files:**
- Modify: `apps/api/src/services/warehouseScan.ts` (lines ~39–48 type, ~441–498 preview function)
- Test: `apps/api/src/__tests__/warehouseScanIssueComplete.test.ts` (new file — also covers Task 2)

### Why first

`IssueChecklist.summary` reads `api.getSummary()` to render the «⛔ Резерв недоступен» list with name + ordinal. Without a richer shape we can't render the list. This task adds the data; Task 3 mirrors the type on the frontend.

- [ ] **Step 1: Stub the new test file (boilerplate copied from `warehouseScan.brokenUnits.test.ts`)**

Create `apps/api/src/__tests__/warehouseScanIssueComplete.test.ts`:

```ts
/**
 * Интеграционный тест: ISSUE-завершение
 *  · Task 1: getReconciliationPreview обогащает reservedButUnavailable name+ordinal+status.
 *  · Task 2: completeSession(ISSUE) переводит booking.status CONFIRMED → ISSUED + идемпотентно.
 */

import path from "path";
import { execSync } from "child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-scan-issue.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-scan-issue";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-scan-issue";
process.env.WAREHOUSE_SECRET = "test-warehouse-scan-issue";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-scan-issue-min16chars";

let prisma: any;
let superAdminId: string;
let clientId: string;
let equipmentId: string;
let availableUnitId: string;
let maintenanceUnitId: string;
let bookingId: string;
let bookingItemId: string;
let sessionId: string;

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

  const pmod = await import("../prisma");
  prisma = pmod.prisma;

  const { hashPassword } = await import("../services/auth");
  const hash = await hashPassword("scan-issue-pass");

  const su = await prisma.adminUser.create({
    data: { username: "scan_issue_super", passwordHash: hash, role: "SUPER_ADMIN" },
  });
  superAdminId = su.id;

  const client = await prisma.client.create({
    data: { name: "Тест ISSUE", phone: "+70000000111" },
  });
  clientId = client.id;

  const equipment = await prisma.equipment.create({
    data: {
      importKey: "scan-issue-eq-001",
      name: "SkyPanel S60",
      category: "Свет",
      rentalRatePerShift: 1000,
      stockTrackingMode: "UNIT",
    },
  });
  equipmentId = equipment.id;

  const u1 = await prisma.equipmentUnit.create({
    data: { equipmentId, barcode: "SKY-001", status: "AVAILABLE" },
  });
  availableUnitId = u1.id;

  const u2 = await prisma.equipmentUnit.create({
    data: { equipmentId, barcode: "SKY-002", status: "MAINTENANCE" },
  });
  maintenanceUnitId = u2.id;

  const booking = await prisma.booking.create({
    data: {
      clientId,
      projectName: "Реклама «Орбита»",
      startDate: new Date("2026-06-01"),
      endDate: new Date("2026-06-03"),
      status: "CONFIRMED",
      amountPaid: 0,
      amountOutstanding: 0,
    },
  });
  bookingId = booking.id;

  const bi = await prisma.bookingItem.create({
    data: { bookingId, equipmentId, quantity: 2 },
  });
  bookingItemId = bi.id;

  // Two reservations: one AVAILABLE, one MAINTENANCE → "прибор 2 из 2" unavailable.
  await prisma.bookingItemUnit.create({
    data: { bookingItemId, equipmentUnitId: availableUnitId },
  });
  await prisma.bookingItemUnit.create({
    data: { bookingItemId, equipmentUnitId: maintenanceUnitId },
  });

  const session = await prisma.scanSession.create({
    data: { bookingId, workerName: "Тест склад", operation: "ISSUE", status: "ACTIVE" },
  });
  sessionId = session.id;

  // The worker scans only the available unit.
  await prisma.scanRecord.create({
    data: { sessionId, equipmentUnitId: availableUnitId, hmacVerified: false },
  });
});

afterAll(async () => {
  await prisma?.$disconnect?.();
});

describe("warehouseScan — ISSUE completion", () => {
  // Task 1 test goes here (Step 2).
  // Task 2 tests go after (subsequent steps in Task 2).
});
```

- [ ] **Step 2: Write the failing test for Task 1 (enriched reservedButUnavailable)**

Inside `describe("warehouseScan — ISSUE completion", () => { … })`, add:

```ts
  it("getReconciliationPreview enriches reservedButUnavailable with name + ordinal + status", async () => {
    const svc = await import("../services/warehouseScan");
    const preview = await svc.getReconciliationPreview(sessionId);

    expect(preview.reservedButUnavailable).toBeDefined();
    expect(preview.reservedButUnavailable).toHaveLength(1);
    expect(preview.reservedButUnavailable[0]).toEqual({
      equipmentUnitId: maintenanceUnitId,
      equipmentName: "SkyPanel S60",
      ordinalLabel: "прибор 2 из 2",
      status: "MAINTENANCE",
    });
  });
```

- [ ] **Step 3: Run the test — expect it to fail**

```bash
cd /Users/sechenov/Documents/light-rental-system && npm run test --workspace=apps/api -- src/__tests__/warehouseScanIssueComplete.test.ts 2>&1 | tail -30
```

Expected: FAIL — either `preview.reservedButUnavailable` is `undefined`, or it does not contain the enriched object.

- [ ] **Step 4: Extend the `ReconciliationSummary` type**

In `apps/api/src/services/warehouseScan.ts`, replace the existing `ReconciliationSummary` interface (lines ~39–48):

```ts
export interface ReservedButUnavailableUnit {
  equipmentUnitId: string;
  equipmentName: string;
  /** «прибор N из M» — порядок среди ВСЕХ резерваций этой позиции (стабильный). */
  ordinalLabel: string;
  /** Статус юнита, который мешает выдаче: MAINTENANCE | MISSING | RETIRED | ISSUED | …. */
  status: string;
}

export interface ReconciliationSummary {
  scanned: number;
  expected: number;
  missing: string[];    // equipmentUnitId[] не отсканированных
  substituted: string[]; // equipmentUnitId[] замен (отсканирован другой юнит вместо зарезервированного)
  /**
   * Зарезервированные юниты, недоступные для выдачи (статус ≠ AVAILABLE).
   * Только для ISSUE-сессий; для RETURN пустой массив. Обогащён name+ordinal+status
   * чтобы фронт мог отрисовать список без второго запроса.
   */
  reservedButUnavailable: ReservedButUnavailableUnit[];
  createdRepairIds: string[];
  failedBrokenUnits: Array<{ unitId: string; reason: string; error: string }>;
  createdProblemItemIds: string[];
  failedProblemUnits: Array<{ equipmentUnitId: string; reason: string }>;
}
```

- [ ] **Step 5: Initialise `reservedButUnavailable: []` in the two existing summary builders**

Find the two `ReconciliationSummary` literal constructions in `apps/api/src/services/warehouseScan.ts`:

1. Inside `completeSession` (~line 204) — `const summary: ReconciliationSummary = { … }`. Add `reservedButUnavailable: [],` after `substituted: []`.
2. Inside `getReconciliationPreview` return (~line 488) — the literal `return { scanned, expected, missing, substituted, createdRepairIds: [], … }`. Add `reservedButUnavailable: [],` before `createdRepairIds`.

(These keep both literals type-correct; the next step actually populates the preview's array.)

- [ ] **Step 6: Enrich the preview**

Inside `getReconciliationPreview`, after the existing `const allReservations = await prisma.bookingItemUnit.findMany({…});` call (~line 462), add the orderBy so ordinals are stable, then build the enriched array. Replace this whole block:

```ts
  const allReservations = await prisma.bookingItemUnit.findMany({
    where: {
      bookingItemId: { in: bookingItemIds },
      ...(session.operation === "RETURN" ? { returnedAt: null } : {}),
    },
  });

  const reservedUnitIds = new Set(allReservations.map((r) => r.equipmentUnitId));
```

with:

```ts
  const allReservations = await prisma.bookingItemUnit.findMany({
    where: {
      bookingItemId: { in: bookingItemIds },
      ...(session.operation === "RETURN" ? { returnedAt: null } : {}),
    },
    include: {
      equipmentUnit: { select: { id: true, status: true } },
      bookingItem: { include: { equipment: { select: { name: true } } } },
    },
    orderBy: { id: "asc" }, // stable ordinal across calls
  });

  const reservedUnitIds = new Set(allReservations.map((r) => r.equipmentUnitId));

  // ── Enriched «зарезервирован, но недоступен» (только для ISSUE) ─────────────
  // Группируем по bookingItemId и нумеруем единицы внутри группы — это даёт
  // стабильный ordinal вида «прибор N из M», совпадающий с тем, что увидит
  // оператор в чек-листе для AVAILABLE-единиц (см. checklistService.ts).
  const reservedButUnavailable: ReservedButUnavailableUnit[] = [];
  if (session.operation === "ISSUE") {
    const byBookingItem = new Map<string, typeof allReservations>();
    for (const r of allReservations) {
      const arr = byBookingItem.get(r.bookingItemId) ?? [];
      arr.push(r);
      byBookingItem.set(r.bookingItemId, arr);
    }
    for (const [, group] of byBookingItem) {
      group.forEach((r, idx) => {
        const unitStatus = r.equipmentUnit?.status;
        if (unitStatus && unitStatus !== "AVAILABLE") {
          reservedButUnavailable.push({
            equipmentUnitId: r.equipmentUnitId,
            equipmentName: r.bookingItem?.equipment?.name ?? "—",
            ordinalLabel: `прибор ${idx + 1} из ${group.length}`,
            status: unitStatus,
          });
        }
      });
    }
  }
```

Then in the same function's `return` literal, replace `reservedButUnavailable: [],` (added in Step 5) with `reservedButUnavailable,`.

- [ ] **Step 7: Re-run the test — expect it to pass**

```bash
cd /Users/sechenov/Documents/light-rental-system && npm run test --workspace=apps/api -- src/__tests__/warehouseScanIssueComplete.test.ts 2>&1 | tail -15
```

Expected: 1 test passes («getReconciliationPreview enriches …»).

- [ ] **Step 8: Run the full backend service test for warehouseScan (no regressions)**

```bash
cd /Users/sechenov/Documents/light-rental-system && npm run test --workspace=apps/api -- src/services/__tests__/warehouseScan.test.ts 2>&1 | tail -15
```

Expected: all pass — existing tests don't read `reservedButUnavailable` so adding it is non-breaking.

- [ ] **Step 9: Commit**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  git add apps/api/src/services/warehouseScan.ts apps/api/src/__tests__/warehouseScanIssueComplete.test.ts && \
  git commit -m "feat(api): enrich reservedButUnavailable in reconciliation preview

ISSUE-flow Сверка needs name+ordinal+status to render «SkyPanel S60 ·
прибор 2 из 2 → ремонт». Compute it server-side from the existing
reservations query (single round-trip)."
```

---

## Task 2: Backend — `completeSession(ISSUE)` transitions booking to `ISSUED` (+ audit)

**Files:**
- Modify: `apps/api/src/services/warehouseScan.ts` (inside `completeSession`, ISSUE branch)
- Test: same `apps/api/src/__tests__/warehouseScanIssueComplete.test.ts`

- [ ] **Step 1: Add failing test for the booking transition**

Append to the `describe("warehouseScan — ISSUE completion", () => { … })` block in `apps/api/src/__tests__/warehouseScanIssueComplete.test.ts`:

```ts
  it("completeSession(ISSUE) transitions booking CONFIRMED → ISSUED", async () => {
    const svc = await import("../services/warehouseScan");
    const result = await svc.completeSession(sessionId, { createdBy: superAdminId });

    // Physical changes already covered by other tests — we assert ONLY the
    // booking transition here.
    const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
    expect(booking?.status).toBe("ISSUED");
    // Session marked COMPLETED in the same transaction.
    const session = await prisma.scanSession.findUnique({ where: { id: sessionId } });
    expect(session?.status).toBe("COMPLETED");
    // Sanity: returned shape includes scanned/expected.
    expect(result.scanned).toBe(1);
    expect(result.expected).toBe(2);
  });
```

- [ ] **Step 2: Add failing test for idempotency on re-call**

```ts
  it("re-running completeSession on the now-ISSUED booking does not crash and keeps booking ISSUED", async () => {
    const svc = await import("../services/warehouseScan");
    // Session is already COMPLETED → completeSession refuses (existing guard).
    await expect(
      svc.completeSession(sessionId, { createdBy: superAdminId }),
    ).rejects.toThrow(/должна быть активной/i);

    // Booking still ISSUED — no rollback.
    const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
    expect(booking?.status).toBe("ISSUED");
  });
```

- [ ] **Step 3: Run these two tests — expect them to fail**

```bash
cd /Users/sechenov/Documents/light-rental-system && npm run test --workspace=apps/api -- src/__tests__/warehouseScanIssueComplete.test.ts 2>&1 | tail -25
```

Expected: «transitions booking CONFIRMED → ISSUED» FAILS (`booking?.status` is `"CONFIRMED"`, not `"ISSUED"`); the idempotency test currently PASSES (the "session must be ACTIVE" guard already exists) — that's fine, it pins the existing guarantee.

- [ ] **Step 4: Implement the booking transition inside the existing `$transaction`**

In `apps/api/src/services/warehouseScan.ts`, find the ISSUE branch inside `completeSession`'s `$transaction` block. After the existing `for (const reservation of allReservations) { if (!scannedUnitIds.has(reservation.equipmentUnitId)) { … await tx.bookingItemUnit.delete({…}); } }` loop and **before** the closing brace of the `if (session.operation === "ISSUE")` block, add:

```ts
      // Перевод брони в статус ISSUED — финальный физический эффект выдачи.
      // Идемпотентно при повторном вызове на ACTIVE-сессии: Prisma update
      // просто запишет ту же строку. Гонка с другой сессией исключена
      // ACTIVE-сессион-гардом из createSession.
      await tx.booking.update({
        where: { id: session.bookingId },
        data: { status: "ISSUED" },
      });
```

- [ ] **Step 5: Add the best-effort audit AFTER the transaction, BEFORE the existing post-tx repair loop**

In the same file, immediately after `const createdBy = options?.createdBy ?? session.workerName;` (~line 287), add:

```ts
  // BOOKING_STATUS_CHANGED — best-effort, ВНЕ транзакции.
  // AuditEntry.userId — FK на AdminUser, а workerName из WarehousePin не
  // соответствует AdminUser.id → P2003 ожидаем и логируем. Аудит здесь —
  // observability, не бизнес-инвариант: физический переход уже зафиксирован.
  if (session.operation === "ISSUE") {
    await writeAuditEntry({
      userId: createdBy,
      action: "BOOKING_STATUS_CHANGED",
      entityType: "Booking",
      entityId: session.bookingId,
      before: { status: "CONFIRMED" },
      after: { status: "ISSUED", source: "warehouse-scan-issue", sessionId },
    }).catch((err) =>
      console.warn("[completeSession ISSUE] booking-status audit failed:", err),
    );
  }
```

- [ ] **Step 6: Re-run the integration test — expect both to pass**

```bash
cd /Users/sechenov/Documents/light-rental-system && npm run test --workspace=apps/api -- src/__tests__/warehouseScanIssueComplete.test.ts 2>&1 | tail -25
```

Expected: 3 tests pass (Task 1's enrichment + 2 Task 2 tests).

- [ ] **Step 7: Run RETURN-side tests to confirm zero regression**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  npm run test --workspace=apps/api -- src/__tests__/warehouseScan.brokenUnits.test.ts \
                                       src/services/__tests__/warehouseScan.test.ts 2>&1 | tail -20
```

Expected: all pass. The RETURN branch is untouched (spec §5.3 — explicit out-of-scope).

- [ ] **Step 8: Commit**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  git add apps/api/src/services/warehouseScan.ts apps/api/src/__tests__/warehouseScanIssueComplete.test.ts && \
  git commit -m "feat(api): completeSession(ISSUE) transitions booking to ISSUED

Without this, a 'completed' issue session left the booking in CONFIRMED
and the booking never appeared in the RETURN list — broken workflow loop.
Booking update is inside the same \$transaction as unit-status changes;
audit entry is best-effort (workerName FK gotcha) outside the tx."
```

---

## Task 3: Frontend types — mirror backend `SummaryResult`

**Files:**
- Modify: `apps/web/src/components/warehouse/types.ts`

- [ ] **Step 1: Extend `SummaryResult`**

In `apps/web/src/components/warehouse/types.ts`, right above the existing `SummaryResult` interface (around line 178), insert the new interface and add the field to `SummaryResult`:

```ts
/**
 * Зарезервированный юнит, который не может быть выдан (статус ≠ AVAILABLE).
 * Источник — `GET /sessions/:id/summary`. Поля повторяют серверный
 * `ReservedButUnavailableUnit` byte-for-byte (см. apps/api warehouseScan.ts).
 */
export interface ReservedButUnavailableUnit {
  equipmentUnitId: string;
  equipmentName: string;
  /** «прибор N из M» — позиция среди резерваций этой позиции брони. */
  ordinalLabel: string;
  /** Сырое значение `EquipmentUnit.status`: MAINTENANCE | MISSING | RETIRED | ISSUED. */
  status: string;
}

export interface SummaryResult {
  sessionId: string;
  operation: ScanOperation;
  scannedCount: number;
  expectedCount: number;
  missingItems: ReconciliationUnitRef[];
  substitutedItems: ReconciliationUnitRef[];
  /**
   * Только для ISSUE; для RETURN пустой массив. Берётся из
   * `getReconciliationPreview` (apps/api). НЕ полагаемся на `[]`-default,
   * а делаем поле обязательным — клиент может рассчитывать на наличие.
   */
  reservedButUnavailable: ReservedButUnavailableUnit[];
}
```

(Note: replace the existing `SummaryResult` block with this one — the only change is the added field; the rest is unchanged.)

- [ ] **Step 2: Verify the type compiles**

```bash
cd /Users/sechenov/Documents/light-rental-system && npm run --workspace=apps/web typecheck 2>&1 | tail -20
```

Expected: no errors. `CompleteResult extends SummaryResult` so the backend-side complete response payload also gains the field; no other call site reads `reservedButUnavailable` yet.

- [ ] **Step 3: Commit**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  git add apps/web/src/components/warehouse/types.ts && \
  git commit -m "feat(web): mirror enriched reservedButUnavailable in SummaryResult type"
```

---

## Task 4: `AddonSearch` — widen `onAdded` signature

**Files:**
- Modify: `apps/web/src/components/warehouse/AddonSearch.tsx`
- Modify: `apps/web/src/components/warehouse/__tests__/AddonSearch.test.tsx`
- Read-only: `apps/web/src/components/warehouse/IssueChecklist.tsx` (only call site — updated in Task 7)

### Why now

The сверка highlights «доборы с предупреждением» — добор units added with `acknowledgedConflict=true`. The id list lives in `IssueChecklist` state, so `AddonSearch` must report both the new `bookingItemId` and whether the operator confirmed a conflict. Doing this in its own commit keeps the change reviewable.

- [ ] **Step 1: Update the failing tests (red-first via signature mismatch)**

Open `apps/web/src/components/warehouse/__tests__/AddonSearch.test.tsx` and find every `onAdded={...}` use plus the `await scanApi.addItem.mockResolvedValueOnce(...)` setups. The current contract calls `onAdded()` with no args. Update each `onAdded` mock to `vi.fn()` and add expectations.

Find and replace each `expect(onAdded).toHaveBeenCalledTimes(1)` (there are typically 2–3) with `expect(onAdded).toHaveBeenCalledWith(<bookingItemId>, <hadConflict>)`. Specifically:

- The «happy path» test ("adds the article on tap when it's free" or similar): the test should already mock `scanApi.addItem` to resolve with `{ bookingItemId: "bi-new" }`. Change the assertion to:

  ```ts
  expect(onAdded).toHaveBeenCalledWith("bi-new", false);
  ```

- The «force-add под ответственность» test (after the ConflictWarning «Выдать под ответственность» is pressed): change to:

  ```ts
  expect(onAdded).toHaveBeenCalledWith("bi-new", true);
  ```

If the existing tests don't mock `addItem` to return a `bookingItemId`, add it. Example mock:

```ts
vi.spyOn(scanApi, "addItem").mockResolvedValueOnce({ bookingItemId: "bi-new" });
```

- [ ] **Step 2: Run the AddonSearch test — expect failures**

```bash
cd /Users/sechenov/Documents/light-rental-system && npm run test --workspace=apps/web -- src/components/warehouse/__tests__/AddonSearch.test.tsx 2>&1 | tail -30
```

Expected: tests that assert `toHaveBeenCalledWith(…, true|false)` FAIL because `onAdded` is currently called with zero args.

- [ ] **Step 3: Widen the type**

In `apps/web/src/components/warehouse/AddonSearch.tsx`, replace the `onAdded` prop declaration:

```ts
  /** Called after an article is added so the checklist can refresh. */
  onAdded: () => void;
```

with:

```ts
  /**
   * Called after an article is added so the checklist can refresh.
   * `hadConflict=true` ⇔ the operator pressed «Выдать под ответственность» —
   * IssueChecklist marks the new bookingItemId as a conflict добор so the
   * сверка can list it under «＋ Доборы с предупреждением».
   */
  onAdded: (bookingItemId: string, hadConflict: boolean) => void;
```

- [ ] **Step 4: Wire the args through `doAdd`**

Inside `doAdd` in `apps/web/src/components/warehouse/AddonSearch.tsx`, the current call is:

```ts
        await scanApi.addItem(sessionId, r.equipmentId, 1, ack ? true : undefined);
        setActive(null);
        setAddedName(r.name);
        onAdded();
```

Replace with:

```ts
        const added = await scanApi.addItem(
          sessionId,
          r.equipmentId,
          1,
          ack ? true : undefined,
        );
        setActive(null);
        setAddedName(r.name);
        onAdded(added.bookingItemId, ack);
```

- [ ] **Step 5: Update the AddonSearch stub in `IssueChecklist.test.tsx`**

In `apps/web/src/components/warehouse/__tests__/IssueChecklist.test.tsx`, the inline stub `vi.mock("../AddonSearch", () => …)` types `onAdded` as `() => void` and its stub button calls `onAdded()`. Update both:

```ts
vi.mock("../AddonSearch", () => ({
  AddonSearch: ({
    sessionId,
    bookingNo,
    onAdded,
    onClose,
  }: {
    sessionId: string;
    bookingNo?: string;
    onAdded: (bookingItemId: string, hadConflict: boolean) => void;
    onClose: () => void;
  }) => (
    <div data-testid="addon-search">
      <span>addon:{sessionId}</span>
      <span>no:{bookingNo}</span>
      <button type="button" onClick={() => onAdded("bi-added", false)}>
        stub-add
      </button>
      <button type="button" onClick={() => onAdded("bi-conflict", true)}>
        stub-add-conflict
      </button>
      <button type="button" onClick={onClose}>
        stub-close
      </button>
    </div>
  ),
}));
```

(The second stub button «stub-add-conflict» feeds Task 6's new test.)

- [ ] **Step 6: Update `IssueChecklist.tsx` `handleAddonAdded` to the new signature (interim adapter; full state wiring in Task 7)**

In `apps/web/src/components/warehouse/IssueChecklist.tsx`, change:

```ts
  function handleAddonAdded() {
    // Re-fetch checklist state so the freshly added добор shows up in the
    // list (the hook's per-id guard / refreshBlocked keeps this safe vs any
    // in-flight check/uncheck).
    void refresh();
  }
```

to:

```ts
  function handleAddonAdded(_bookingItemId: string, _hadConflict: boolean) {
    // Re-fetch checklist state so the freshly added добор shows up in the
    // list (the hook's per-id guard / refreshBlocked keeps this safe vs any
    // in-flight check/uncheck). Conflict-id tracking is wired in Task 7.
    void refresh();
  }
```

(We accept the args here so the prop matches; Task 7 replaces the underscore params with actual state writes.)

- [ ] **Step 7: Run all changed tests — expect pass**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  npm run test --workspace=apps/web -- \
    src/components/warehouse/__tests__/AddonSearch.test.tsx \
    src/components/warehouse/__tests__/IssueChecklist.test.tsx 2>&1 | tail -20
```

Expected: both files green. AddonSearch's new `toHaveBeenCalledWith(…, true|false)` now passes; IssueChecklist's existing «AddonSearch onAdded triggers refresh» test still passes (the stub button calls `onAdded("bi-added", false)` which still triggers `refresh`).

- [ ] **Step 8: Commit**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  git add apps/web/src/components/warehouse/AddonSearch.tsx \
          apps/web/src/components/warehouse/IssueChecklist.tsx \
          apps/web/src/components/warehouse/__tests__/AddonSearch.test.tsx \
          apps/web/src/components/warehouse/__tests__/IssueChecklist.test.tsx && \
  git commit -m "refactor(web): widen AddonSearch.onAdded to (bookingItemId, hadConflict)

Сверка needs to surface добор units added 'под ответственность' under
'＋ Доборы с предупреждением'. AddonSearch already knows both values —
just thread them through to the consumer."
```

---

## Task 5: New component — `IssueResultView`

**Files:**
- Create: `apps/web/src/components/warehouse/IssueResultView.tsx`
- Create: `apps/web/src/components/warehouse/__tests__/IssueResultView.test.tsx`

### Pattern

Mirrors `ReturnResultView` (same file structure: header + dl rows + info-block + sticky footer; emerald header on zero failures, amber on any). Counts are FE-authoritative props (the same pattern that fixed the "Принято" scanned-minus-others bug).

- [ ] **Step 1: Create the failing test file**

Create `apps/web/src/components/warehouse/__tests__/IssueResultView.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import type { CompleteResult } from "../types";
import { IssueResultView } from "../IssueResultView";

function okResult(over: Partial<CompleteResult> = {}): CompleteResult {
  return {
    sessionId: "s1",
    operation: "ISSUE",
    scannedCount: 24,
    expectedCount: 26,
    missingItems: [],
    substitutedItems: [],
    reservedButUnavailable: [],
    createdRepairIds: [],
    failedBrokenUnits: [],
    createdProblemItemIds: [],
    failedProblemUnits: [],
    ...over,
  };
}

describe("IssueResultView", () => {
  function valueFor(labelRe: RegExp): HTMLElement {
    const dt = screen.getByText(labelRe);
    const row = dt.parentElement as HTMLElement;
    const dd = row.querySelector("dd");
    if (!dd) throw new Error(`no <dd> for ${labelRe}`);
    return dd as HTMLElement;
  }

  it("renders the emerald header «Выдача оформлена» on zero failures", () => {
    render(
      <IssueResultView
        result={okResult()}
        projectName="Орбита"
        issuedCount={24}
        addonsCount={2}
        substitutedCount={1}
        onDone={() => {}}
      />,
    );
    expect(screen.getByText("Выдача оформлена")).toBeInTheDocument();
    expect(
      screen.queryByText("Выдача оформлена с замечаниями"),
    ).not.toBeInTheDocument();
  });

  it("renders «Выдано» / «Добавлено доборов» / «Замены» from props, not from scannedCount", () => {
    // The OLD ReturnResultView shipped with `scannedCount − repair − problem`
    // bug; we pin issuedCount as a prop so it's not silently re-derived later.
    render(
      <IssueResultView
        result={okResult({ scannedCount: 999 })}
        projectName="P"
        issuedCount={24}
        addonsCount={2}
        substitutedCount={1}
        onDone={() => {}}
      />,
    );
    expect(valueFor(/^Выдано$/)).toHaveTextContent("24");
    expect(valueFor(/Добавлено доборов/)).toHaveTextContent("2");
    expect(valueFor(/Замены/)).toHaveTextContent("1");
    // 999 must NOT leak through — counts are from props.
    expect(valueFor(/^Выдано$/)).not.toHaveTextContent("999");
  });

  it("clamps issuedCount ≥ 0 (defensive)", () => {
    render(
      <IssueResultView
        result={okResult()}
        projectName="P"
        issuedCount={-3}
        addonsCount={0}
        substitutedCount={0}
        onDone={() => {}}
      />,
    );
    expect(valueFor(/^Выдано$/)).toHaveTextContent("0");
  });

  it("shows the info-block «Бронь переведена в «Выдана»»", () => {
    render(
      <IssueResultView
        result={okResult()}
        projectName="P"
        issuedCount={1}
        addonsCount={0}
        substitutedCount={0}
        onDone={() => {}}
      />,
    );
    expect(
      screen.getByText(/Бронь переведена в «Выдана»/),
    ).toBeInTheDocument();
  });

  it("demotes to amber header on any failedBrokenUnits / failedProblemUnits (edge-case)", () => {
    render(
      <IssueResultView
        result={okResult({
          failedProblemUnits: [
            { equipmentUnitId: "u9", reason: "race-condition" },
          ],
        })}
        projectName="P"
        issuedCount={22}
        addonsCount={2}
        substitutedCount={0}
        onDone={() => {}}
      />,
    );
    expect(
      screen.getByText("Выдача оформлена с замечаниями"),
    ).toBeInTheDocument();
  });

  it("never renders a barcode", () => {
    const { container } = render(
      <IssueResultView
        result={okResult()}
        projectName="P"
        issuedCount={1}
        addonsCount={0}
        substitutedCount={0}
        onDone={() => {}}
      />,
    );
    expect(container.textContent || "").not.toMatch(/LR-[A-Z0-9]+-\d+/);
  });

  it("invokes onDone when «Готово» is pressed", () => {
    const onDone = vi.fn();
    render(
      <IssueResultView
        result={okResult()}
        projectName="P"
        issuedCount={3}
        addonsCount={0}
        substitutedCount={0}
        onDone={onDone}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Готово/ }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test — expect import error (component doesn't exist)**

```bash
cd /Users/sechenov/Documents/light-rental-system && npm run test --workspace=apps/web -- src/components/warehouse/__tests__/IssueResultView.test.tsx 2>&1 | tail -10
```

Expected: «Cannot find module '../IssueResultView'» or similar.

- [ ] **Step 3: Create `IssueResultView.tsx`**

Create `apps/web/src/components/warehouse/IssueResultView.tsx`:

```tsx
"use client";

/**
 * ISSUE result view — финальный экран после успешного `POST /complete`.
 *
 * Pure presentational: takes the `/complete` response + FE-authoritative
 * counts and renders the outcome (counts + info-block + optional failure
 * alert + «Готово»). NO checklist state, NO network — `IssueChecklist` owns
 * the POST and passes the result down.
 *
 * Mirrors `ReturnResultView`:
 *  - emerald header «Выдача оформлена» on zero failures;
 *  - amber «Выдача оформлена с замечаниями» on ANY failure (defensive — for
 *    ISSUE the backend doesn't produce failedBroken/failedProblem today, but
 *    the contract is shared with RETURN and we render it correctly if it
 *    ever does).
 *
 * Counts come from PROPS, not from `result.scannedCount`. Rationale: COUNT
 * lines never produce ScanRecords (no server-side unit ids), so
 * `scannedCount` counts only UNIT units — it would under-report «Выдано».
 * `IssueChecklist` computes the authoritative `|issuedUnits|+|issuedCountLines|`
 * and passes it as `issuedCount`.
 *
 * NEVER renders a barcode.
 */

import type { CompleteResult } from "./types";
import { pluralize } from "../../lib/format";

export function IssueResultView({
  result,
  projectName,
  issuedCount,
  addonsCount,
  substitutedCount,
  onDone,
}: {
  result: CompleteResult;
  projectName: string;
  /** UNIT units marked ✓ + COUNT lines marked ✓ — FE truth from IssueChecklist. */
  issuedCount: number;
  /** Number of bookingItems with `isExtra=true`. */
  addonsCount: number;
  /** `result.substitutedItems.length`, lifted into a prop for symmetry. */
  substitutedCount: number;
  /** Back to the bookings list. */
  onDone: () => void;
}) {
  const safeIssued = Math.max(
    0,
    Number.isFinite(issuedCount) ? issuedCount : 0,
  );

  const failedBroken = result.failedBrokenUnits ?? [];
  const failedProblem = result.failedProblemUnits ?? [];
  const failedTotal = failedBroken.length + failedProblem.length;
  const hasFailures = failedTotal > 0;

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <div className="flex-1 px-3 pb-6 pt-5 lg:px-5">
        <div className="mx-auto w-full max-w-[460px]">
          {hasFailures ? (
            <div className="rounded-lg border border-amber-border bg-amber-soft px-4 py-4 text-center">
              <p className="text-3xl leading-none" aria-hidden="true">
                ⚠
              </p>
              <h2 className="mt-2 text-[17px] font-semibold text-ink">
                Выдача оформлена с замечаниями
              </h2>
              <p className="mt-1 text-[13px] text-ink-2">
                {projectName || "Бронь"}
              </p>
            </div>
          ) : (
            <div className="rounded-lg border border-emerald-border bg-emerald-soft px-4 py-4 text-center">
              <p className="text-3xl leading-none" aria-hidden="true">
                ✓
              </p>
              <h2 className="mt-2 text-[17px] font-semibold text-ink">
                Выдача оформлена
              </h2>
              <p className="mt-1 text-[13px] text-ink-2">
                {projectName || "Бронь"}
              </p>
            </div>
          )}

          <dl className="mt-3 space-y-1.5">
            <div className="flex items-center justify-between rounded-lg border border-border bg-surface px-3 py-2.5">
              <dt className="text-[13px] text-ink-2">Выдано</dt>
              <dd className="mono-num text-[15px] font-semibold text-emerald">
                {safeIssued}
              </dd>
            </div>
            <div className="flex items-center justify-between rounded-lg border border-border bg-surface px-3 py-2.5">
              <dt className="text-[13px] text-ink-2">
                Добавлено доборов
              </dt>
              <dd className="mono-num text-[15px] font-semibold text-ink">
                {addonsCount}
              </dd>
            </div>
            <div className="flex items-center justify-between rounded-lg border border-border bg-surface px-3 py-2.5">
              <dt className="text-[13px] text-ink-2">
                Замены (другая единица)
              </dt>
              <dd className="mono-num text-[15px] font-semibold text-ink">
                {substitutedCount}
              </dd>
            </div>
          </dl>

          <div className="mt-3 rounded-lg border border-accent-soft bg-accent-soft/50 px-3 py-2.5 text-[12px] leading-snug text-ink-2">
            Бронь переведена в «Выдана» — появится в списке для приёмки.
          </div>

          {hasFailures && (
            <div
              role="alert"
              className="mt-3 rounded-lg border border-rose-border bg-rose-soft px-3 py-3"
            >
              <p className="text-[13px] font-semibold text-rose">
                Не удалось обработать {failedTotal}{" "}
                {pluralize(failedTotal, "единицу", "единицы", "единиц")} —
                проверьте вручную, ничего не потеряно
              </p>

              {failedBroken.length > 0 && (
                <>
                  <p className="mt-2 text-[12px] font-medium text-rose">
                    Не удалось обработать ремонт:
                  </p>
                  <ul className="mt-1 space-y-1">
                    {failedBroken.map((f) => (
                      <li
                        key={f.unitId}
                        className="text-[12px] leading-snug text-rose"
                      >
                        • {f.reason}: {f.error}
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {failedProblem.length > 0 && (
                <>
                  <p className="mt-2 text-[12px] font-medium text-rose">
                    Не удалось завести в «Потеряшки»:
                  </p>
                  <ul className="mt-1 space-y-1">
                    {failedProblem.map((f) => (
                      <li
                        key={f.equipmentUnitId}
                        className="text-[12px] leading-snug text-rose"
                      >
                        • {f.equipmentUnitId}: {f.reason}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="sticky bottom-0 border-t border-border bg-surface px-3 py-3 lg:px-5">
        <button
          type="button"
          onClick={onDone}
          aria-label="Готово — вернуться к списку броней"
          className="block w-full rounded-lg bg-accent px-4 py-3 text-center text-sm font-semibold text-white transition-colors hover:opacity-95"
        >
          Готово
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Re-run the test — expect pass**

```bash
cd /Users/sechenov/Documents/light-rental-system && npm run test --workspace=apps/web -- src/components/warehouse/__tests__/IssueResultView.test.tsx 2>&1 | tail -15
```

Expected: all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  git add apps/web/src/components/warehouse/IssueResultView.tsx \
          apps/web/src/components/warehouse/__tests__/IssueResultView.test.tsx && \
  git commit -m "feat(web): add IssueResultView — emerald/amber finale for ISSUE

Pure presentational. Mirrors ReturnResultView contract: counts come from
FE props (not result.scannedCount which under-reports COUNT lines),
header switches emerald↔amber on hasFailures, sticky «Готово» calls onDone."
```

---

## Task 6: `IssueChecklist` — phase machine + summary phase state (no UI yet)

**Files:**
- Modify: `apps/web/src/components/warehouse/IssueChecklist.tsx`

### Why incremental

Splitting the IssueChecklist work into three commits (state → withheld semantics → summary JSX → submit/result) keeps each diff reviewable and lets tests fail at predictable boundaries. After this task the existing tests still pass and the visible behaviour is unchanged.

- [ ] **Step 1: Add types and imports**

In `apps/web/src/components/warehouse/IssueChecklist.tsx`, just after the existing imports add the imports for the new components/types:

```ts
import { scanApi } from "./api";
import type { CompleteResult, SummaryResult } from "./types";
import { IssueResultView } from "./IssueResultView";
```

Add the phase type below the existing `interface CategoryGroup` block (around line 46):

```ts
type IssuePhase = "checklist" | "summary" | "submitting" | "result";
```

- [ ] **Step 2: Add state fields**

After the existing `const [bulkBusy, setBulkBusy] = useState(false);` line (~line 105), add:

```ts
  // ── Outcome state for the сверка (Phase 2 wires the UI / Phase 3 the submit). ──
  // COUNT lines explicitly marked ✗ (different from "untouched"); mirrors
  // countIssued.
  const [countWithheld, setCountWithheld] = useState<Set<string>>(new Set());
  // UNIT units explicitly marked ✗ (WITHHELD).
  const [withheldUnits, setWithheldUnits] = useState<Set<string>>(new Set());
  // bookingItemIds of доборы added with acknowledgedConflict=true.
  const [conflictAddons, setConflictAddons] = useState<Set<string>>(new Set());

  // ── Phase machine (lives inside this component — no outer step). ─────────────
  const [phase, setPhase] = useState<IssuePhase>("checklist");
  const [summary, setSummary] = useState<SummaryResult | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<CompleteResult | null>(null);
```

- [ ] **Step 3: Verify the file still compiles**

```bash
cd /Users/sechenov/Documents/light-rental-system && npm run --workspace=apps/web typecheck 2>&1 | tail -10
```

Expected: no errors. Unused-variable warnings on the new state setters are fine (Task 7 + 8 use them).

- [ ] **Step 4: Run the existing IssueChecklist tests — expect no regression**

```bash
cd /Users/sechenov/Documents/light-rental-system && npm run test --workspace=apps/web -- src/components/warehouse/__tests__/IssueChecklist.test.tsx 2>&1 | tail -15
```

Expected: existing tests still pass (we added state, no UI changes).

- [ ] **Step 5: Commit**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  git add apps/web/src/components/warehouse/IssueChecklist.tsx && \
  git commit -m "feat(web): introduce IssuePhase state machine in IssueChecklist

Adds phase + outcome state (countWithheld, withheldUnits, conflictAddons,
summary, submitError, result) without changing UI. Subsequent commits
wire the segments and the сверка/result phases."
```

---

## Task 7: `IssueChecklist` — WITHHELD outcome + conflictAddons tracking

**Files:**
- Modify: `apps/web/src/components/warehouse/IssueChecklist.tsx`
- Modify: `apps/web/src/components/warehouse/__tests__/IssueChecklist.test.tsx`

- [ ] **Step 1: Write failing test for WITHHELD tracking + conflict добор tracking**

Add to `apps/web/src/components/warehouse/__tests__/IssueChecklist.test.tsx` (inside the existing `describe("IssueChecklist", () => { … })` block, just before the closing brace):

```ts
  it("tapping ✗ on a UNIT row tracks the unit as WITHHELD (visible later in сверка)", async () => {
    render(
      <IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    const withhold = await screen.findByRole("button", {
      name: /Aputure 600D \(прибор 1 из 2\) — отметить «не выдаём»/,
    });
    withhold.click();

    // No outward signal yet (UI for the сверка lands in Task 8), but the
    // segment becomes aria-pressed and remains so on re-render.
    await waitFor(() => expect(withhold).toHaveAttribute("aria-pressed", "true"));
  });

  it("tapping ✗ then ✓ on the same UNIT row clears the WITHHELD and issues it", async () => {
    render(
      <IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    const withhold = await screen.findByRole("button", {
      name: /Aputure 600D \(прибор 1 из 2\) — отметить «не выдаём»/,
    });
    const issued = await screen.findByRole("button", {
      name: /Aputure 600D \(прибор 1 из 2\) — отметить выданным/,
    });
    withhold.click();
    await waitFor(() =>
      expect(withhold).toHaveAttribute("aria-pressed", "true"),
    );
    issued.click();
    await waitFor(() => {
      expect(issued).toHaveAttribute("aria-pressed", "true");
      expect(withhold).toHaveAttribute("aria-pressed", "false");
    });
    expect(checkSpy).toHaveBeenCalledWith("u1");
  });

  it("AddonSearch onAdded(bi, hadConflict=true) tracks the bookingItemId for the сверка", async () => {
    render(
      <IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />,
    );

    (await screen.findAllByRole("button", { name: /Добор/ }))[0].click();
    await screen.findByTestId("addon-search");
    screen.getByRole("button", { name: "stub-add-conflict" }).click();

    // No outward signal yet (UI in Task 8), but the session refresh must
    // still fire — keeps the existing «refresh» test green and proves the
    // handler signature is correct.
    await waitFor(() => expect(refreshSpy).toHaveBeenCalledTimes(1));
  });
```

- [ ] **Step 2: Run — expect the first two to fail (WITHHELD currently routes to `uncheck` and the segment doesn't show aria-pressed)**

```bash
cd /Users/sechenov/Documents/light-rental-system && npm run test --workspace=apps/web -- src/components/warehouse/__tests__/IssueChecklist.test.tsx 2>&1 | tail -25
```

Expected: at least the two WITHHELD tests FAIL. The «stub-add-conflict» test should pass already since Task 4's stub forwards through `handleAddonAdded` which calls `refresh()` unconditionally — confirm in the output that it is indeed passing.

- [ ] **Step 3: Distinguish WITHHELD from null in `handleUnitChange`**

In `apps/web/src/components/warehouse/IssueChecklist.tsx`, replace the existing `handleUnitChange`:

```ts
  function handleUnitChange(unitId: string, next: IssueValue) {
    // ISSUED → persist via hook; WITHHELD / neutral → ensure not checked.
    if (next === "ISSUED") {
      void check(unitId).catch(() => undefined);
    } else {
      void uncheck(unitId).catch(() => undefined);
    }
  }
```

with:

```ts
  function handleUnitChange(unitId: string, next: IssueValue) {
    // Three-way: ISSUED ⇒ persist via hook, WITHHELD ⇒ ✗-set,
    // null ⇒ clear both (server-side uncheck + local ✗-set delete).
    if (next === "ISSUED") {
      setWithheldUnits((prev) => {
        if (!prev.has(unitId)) return prev;
        const n = new Set(prev);
        n.delete(unitId);
        return n;
      });
      void check(unitId).catch(() => undefined);
      return;
    }
    if (next === "WITHHELD") {
      // Make sure it's NOT checked server-side either.
      void uncheck(unitId).catch(() => undefined);
      setWithheldUnits((prev) => {
        if (prev.has(unitId)) return prev;
        const n = new Set(prev);
        n.add(unitId);
        return n;
      });
      return;
    }
    // null — neutral.
    setWithheldUnits((prev) => {
      if (!prev.has(unitId)) return prev;
      const n = new Set(prev);
      n.delete(unitId);
      return n;
    });
    void uncheck(unitId).catch(() => undefined);
  }
```

- [ ] **Step 4: Reflect WITHHELD in the unit row's `value` prop**

Find the UNIT row rendering inside the `.map(...)` block (`<UnitRow … value={u.checked ? "ISSUED" : null} … />`). Replace with:

```tsx
                  return item.units.map((u, idx) => {
                    const value: IssueValue = u.checked
                      ? "ISSUED"
                      : withheldUnits.has(u.unitId)
                        ? "WITHHELD"
                        : null;
                    return (
                      <UnitRow
                        key={u.unitId}
                        name={item.equipmentName}
                        ordinalLabel={`прибор ${idx + 1} из ${total}`}
                        mode="ISSUE"
                        value={value}
                        onChange={(next) => handleUnitChange(u.unitId, next)}
                        disabled={bulkBusy}
                      />
                    );
                  });
```

- [ ] **Step 5: Make `setCount` three-state for COUNT lines**

Replace the existing `setCount` helper:

```ts
  function setCount(bookingItemId: string, issued: boolean) {
    setCountIssued((prev) => {
      const next = new Set(prev);
      if (issued) next.add(bookingItemId);
      else next.delete(bookingItemId);
      return next;
    });
  }
```

with:

```ts
  function setCount(bookingItemId: string, next: IssueValue) {
    setCountIssued((prev) => {
      const n = new Set(prev);
      if (next === "ISSUED") n.add(bookingItemId);
      else n.delete(bookingItemId);
      return n;
    });
    setCountWithheld((prev) => {
      const n = new Set(prev);
      if (next === "WITHHELD") n.add(bookingItemId);
      else n.delete(bookingItemId);
      return n;
    });
  }
```

And update the COUNT row render — find the `<UnitRow … value={issued ? "ISSUED" : null} onChange={(next) => setCount(item.bookingItemId, next === "ISSUED")} />` and replace with:

```tsx
                const value: IssueValue = countIssued.has(item.bookingItemId)
                  ? "ISSUED"
                  : countWithheld.has(item.bookingItemId)
                    ? "WITHHELD"
                    : null;
                return (
                  <UnitRow
                    key={item.bookingItemId}
                    name={item.equipmentName}
                    ordinalLabel={`×${item.quantity}`}
                    mode="ISSUE"
                    value={value}
                    onChange={(next) => setCount(item.bookingItemId, next)}
                    disabled={bulkBusy}
                  />
                );
```

- [ ] **Step 6: Wire conflict добор tracking in `handleAddonAdded`**

Replace the placeholder from Task 4:

```ts
  function handleAddonAdded(_bookingItemId: string, _hadConflict: boolean) {
    void refresh();
  }
```

with:

```ts
  function handleAddonAdded(bookingItemId: string, hadConflict: boolean) {
    if (hadConflict) {
      setConflictAddons((prev) => {
        if (prev.has(bookingItemId)) return prev;
        const n = new Set(prev);
        n.add(bookingItemId);
        return n;
      });
    }
    // Re-fetch checklist state so the freshly added добор shows up in the
    // list (the hook's per-id guard / refreshBlocked keeps this safe vs any
    // in-flight check/uncheck).
    void refresh();
  }
```

- [ ] **Step 7: Also clear `withheldUnits` and `countWithheld` inside `issueAll` (bulk issuance is decisive)**

In `issueAll`, after the existing `setCountIssued(new Set(allCountIds));` line, add:

```ts
      setCountWithheld(new Set());
      setWithheldUnits(new Set());
```

- [ ] **Step 8: Re-run the tests — expect pass**

```bash
cd /Users/sechenov/Documents/light-rental-system && npm run test --workspace=apps/web -- src/components/warehouse/__tests__/IssueChecklist.test.tsx 2>&1 | tail -25
```

Expected: all tests pass — old «click ✓» behaviour unchanged, new «click ✗» tests pass, conflict добор tracking test passes via the «stub-add-conflict» button.

- [ ] **Step 9: Commit**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  git add apps/web/src/components/warehouse/IssueChecklist.tsx \
          apps/web/src/components/warehouse/__tests__/IssueChecklist.test.tsx && \
  git commit -m "feat(web): three-state outcomes + conflict-добор tracking in IssueChecklist

Tapping ✗ on a UNIT row now records WITHHELD locally (not just 'not
checked') so the сверка can split «✗ Не выдаём» from «⚠ Без отметки».
COUNT lines get the same three-state treatment. Доборы added 'под
ответственность' (hadConflict=true) are tracked for «＋ Доборы с
предупреждением» on the сверка."
```

---

## Task 8: `IssueChecklist` — render the «Сверка» phase

**Files:**
- Modify: `apps/web/src/components/warehouse/IssueChecklist.tsx`
- Create: `apps/web/src/components/warehouse/__tests__/IssueSummary.test.tsx`

### Visual reference

`docs/mockups/warehouse-scan/04-issue-summary-and-result.html` — block «Экран 1 · Сверка». Emerald badge at top with N, four stat rows (✓ Выдаём, ＋ Доборы, ✗ Не выдаём, ⚠ Без отметки) + optional rose «⛔ Резерв недоступен» + optional «＋ Доборы с предупреждением». Sticky footer with «← К чек-листу» + «Подтвердить выдачу →».

- [ ] **Step 1: Create the failing test file `IssueSummary.test.tsx`**

Create `apps/web/src/components/warehouse/__tests__/IssueSummary.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChecklistState, SummaryResult } from "../types";
import type { UseScanSessionResult } from "../useScanSession";

const checkSpy = vi.fn(async () => {});
const uncheckSpy = vi.fn(async () => {});
const openSessionSpy = vi.fn(async () => {});
const refreshSpy = vi.fn(async () => {});

let mockState: ChecklistState | null = null;

vi.mock("../useScanSession", () => ({
  useScanSession: (): Partial<UseScanSessionResult> => ({
    state: mockState,
    loading: false,
    error: null,
    openSession: openSessionSpy,
    check: checkSpy,
    uncheck: uncheckSpy,
    refresh: refreshSpy,
  }),
}));

// Stub AddonSearch — not exercised in these tests.
vi.mock("../AddonSearch", () => ({
  AddonSearch: () => null,
}));

// Spy on the api client used for getSummary.
const summarySpy = vi.fn<[], Promise<SummaryResult>>();
vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    scanApi: {
      ...actual.scanApi,
      getSummary: (sessionId: string) => summarySpy(sessionId),
    },
  };
});

import { IssueChecklist } from "../IssueChecklist";

function state(): ChecklistState {
  return {
    sessionId: "s1",
    bookingId: "b1",
    operation: "ISSUE",
    items: [
      {
        bookingItemId: "bi-1",
        equipmentId: "eq1",
        equipmentName: "Aputure 600D",
        category: "Свет",
        quantity: 3,
        checkedQty: 0,
        trackingMode: "UNIT",
        isExtra: false,
        units: [
          { unitId: "u1", barcode: null, checked: true, problemType: null },
          { unitId: "u2", barcode: null, checked: true, problemType: null },
          { unitId: "u3", barcode: null, checked: false, problemType: null },
        ],
      },
      {
        bookingItemId: "bi-2",
        equipmentId: "eq2",
        equipmentName: "Manfrotto 1004",
        category: "Стойки",
        quantity: 4,
        checkedQty: 0,
        trackingMode: "UNIT",
        isExtra: false,
        units: [
          { unitId: "u4", barcode: null, checked: true, problemType: null },
          { unitId: "u5", barcode: null, checked: true, problemType: null },
          { unitId: "u6", barcode: null, checked: false, problemType: null },
          { unitId: "u7", barcode: null, checked: false, problemType: null },
        ],
      },
      {
        bookingItemId: "bi-3",
        equipmentId: "eq3",
        equipmentName: "Astera Titan Tube",
        category: "Свет",
        quantity: 1,
        checkedQty: 0,
        trackingMode: "UNIT",
        isExtra: true, // ← добор
        units: [
          { unitId: "u8", barcode: null, checked: true, problemType: null },
        ],
      },
    ],
    progress: { checkedItems: 5, totalItems: 8 },
  };
}

function defaultSummary(over: Partial<SummaryResult> = {}): SummaryResult {
  return {
    sessionId: "s1",
    operation: "ISSUE",
    scannedCount: 5,
    expectedCount: 7,
    missingItems: [],
    substitutedItems: [],
    reservedButUnavailable: [
      {
        equipmentUnitId: "u9",
        equipmentName: "SkyPanel S60",
        ordinalLabel: "прибор 2 из 2",
        status: "MAINTENANCE",
      },
    ],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockState = state();
  summarySpy.mockResolvedValue(defaultSummary());
});

describe("IssueChecklist · Сверка phase", () => {
  it("opens the сверка screen when «Завершить выдачу» is pressed, fetching getSummary", async () => {
    render(<IssueChecklist sessionId="s1" projectName="Орбита" onBack={() => {}} />);

    const finish = await screen.findByRole("button", { name: /Завершить выдачу/ });
    finish.click();

    // The сверка header / badge becomes visible; checklist disappears.
    expect(
      await screen.findByText(/Готово к выдаче/),
    ).toBeInTheDocument();
    expect(summarySpy).toHaveBeenCalledWith("s1");
  });

  it("computes the emerald «Готово к выдаче» count from issued units + count lines", async () => {
    render(<IssueChecklist sessionId="s1" projectName="Орбита" onBack={() => {}} />);
    (await screen.findByRole("button", { name: /Завершить выдачу/ })).click();

    // 5 issued units (u1,u2,u4,u5,u8) + 0 count lines = 5.
    const badge = await screen.findByText(/Готово к выдаче/);
    const badgeBlock = badge.parentElement as HTMLElement;
    expect(badgeBlock.textContent || "").toMatch(/\b5\b/);
  });

  it("expands the «⚠ Без отметки» row with the first matching units", async () => {
    render(<IssueChecklist sessionId="s1" projectName="Орбита" onBack={() => {}} />);
    (await screen.findByRole("button", { name: /Завершить выдачу/ })).click();

    // u3 (Aputure 600D · прибор 3 из 3), u6 (Manfrotto · прибор 3 из 4),
    // u7 (Manfrotto · прибор 4 из 4) — 3 untouched.
    await screen.findByText(/Без отметки/);
    expect(
      screen.getByText(/Aputure 600D · прибор 3 из 3/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Manfrotto 1004 · прибор 3 из 4/),
    ).toBeInTheDocument();
  });

  it("expands «⛔ Резерв недоступен» with the SkyPanel S60 line and a status suffix", async () => {
    render(<IssueChecklist sessionId="s1" projectName="Орбита" onBack={() => {}} />);
    (await screen.findByRole("button", { name: /Завершить выдачу/ })).click();

    await screen.findByText(/Резерв недоступен/);
    expect(
      screen.getByText(/SkyPanel S60 · прибор 2 из 2/),
    ).toBeInTheDocument();
    // MAINTENANCE → human suffix «в ремонте».
    expect(screen.getByText(/в ремонте/)).toBeInTheDocument();
  });

  it("«← К чек-листу» returns to the checklist phase with state preserved", async () => {
    render(<IssueChecklist sessionId="s1" projectName="Орбита" onBack={() => {}} />);
    (await screen.findByRole("button", { name: /Завершить выдачу/ })).click();
    await screen.findByText(/Готово к выдаче/);

    const back = screen.getByRole("button", { name: /К чек-листу/ });
    back.click();

    // Сверка hidden, checklist visible again — and the u1 segment is still ✓
    // (state preserved across the round-trip).
    await waitFor(() =>
      expect(screen.queryByText(/Готово к выдаче/)).not.toBeInTheDocument(),
    );
    const issued = screen.getByRole("button", {
      name: /Aputure 600D \(прибор 1 из 3\) — отметить выданным/,
    });
    expect(issued).toHaveAttribute("aria-pressed", "true");
  });

  it("soft-warn: «Без отметки»/«Резерв недоступен» do NOT disable «Подтвердить выдачу»", async () => {
    render(<IssueChecklist sessionId="s1" projectName="Орбита" onBack={() => {}} />);
    (await screen.findByRole("button", { name: /Завершить выдачу/ })).click();
    await screen.findByText(/Готово к выдаче/);

    const confirm = screen.getByRole("button", {
      name: /Подтвердить выдачу/,
    });
    expect(confirm).not.toBeDisabled();
  });
});
```

- [ ] **Step 2: Run the test — expect failures (file doesn't exist, then phase JSX doesn't exist)**

```bash
cd /Users/sechenov/Documents/light-rental-system && npm run test --workspace=apps/web -- src/components/warehouse/__tests__/IssueSummary.test.tsx 2>&1 | tail -25
```

Expected: tests fail with «Завершить выдачу» pressed → still in checklist phase (badge not rendered).

- [ ] **Step 3: Add a status-label helper at the top of `IssueChecklist.tsx` (after `displayNo`)**

Insert after `function displayNo(...)`:

```ts
/** Human label for the unit status that blocks issuance. */
function statusLabel(status: string): string {
  switch (status) {
    case "MAINTENANCE":
      return "в ремонте";
    case "MISSING":
      return "в Потеряшках";
    case "RETIRED":
      return "списан";
    case "ISSUED":
      return "уже выдан";
    default:
      return status.toLowerCase();
  }
}
```

- [ ] **Step 4: Add a small `<DetailList>` helper component inside the same file**

After `function statusLabel` (still outside `IssueChecklist`), add:

```tsx
/** Compact «первые 5 + ... и ещё K» list under a stat row. */
function DetailList({
  variant,
  items,
}: {
  variant: "neutral" | "warn" | "bad";
  items: string[];
}) {
  if (items.length === 0) return null;
  const head = items.slice(0, 5);
  const rest = items.length - head.length;
  const cls =
    variant === "bad"
      ? "border-rose-border text-rose"
      : variant === "warn"
        ? "border-amber-border text-amber"
        : "border-border text-ink-2";
  return (
    <div
      className={`mx-3 mt-1 rounded-lg border border-dashed bg-surface px-2.5 py-2 text-[11px] leading-snug ${cls}`}
    >
      {head.map((line, i) => (
        <p key={i}>{line}</p>
      ))}
      {rest > 0 && (
        <p className="mt-1 opacity-80">
          …и ещё {rest}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Compute `issuedCountUnits` + `issuedCountLines` + counts via `useMemo`**

Replace the existing `const progress = useMemo(...)` block with two memos (keep `progress` for the checklist heading, add the сверка counts):

```ts
  const progress = useMemo(
    () => (state ? computeProgress(state, countIssued) : { done: 0, total: 0 }),
    [state, countIssued],
  );

  const counts = useMemo(() => {
    if (!state) {
      return {
        issuedUnits: 0,
        issuedLines: 0,
        withheld: 0,
        addons: 0,
        addonsWithConflict: 0,
        untouchedUnitLines: [] as string[],
        untouchedCountLines: [] as string[],
        addonConflictLines: [] as string[],
      };
    }
    let issuedUnits = 0;
    let issuedLines = 0;
    let withheld = 0;
    let addons = 0;
    let addonsWithConflict = 0;
    const untouchedUnitLines: string[] = [];
    const untouchedCountLines: string[] = [];
    const addonConflictLines: string[] = [];

    for (const item of state.items) {
      if (item.isExtra) {
        addons += 1;
        if (conflictAddons.has(item.bookingItemId)) {
          addonsWithConflict += 1;
          addonConflictLines.push(
            `${item.equipmentName} — выдан под ответственность`,
          );
        }
      }
      if (item.trackingMode === "UNIT" && item.units && item.units.length > 0) {
        const total = item.units.length;
        item.units.forEach((u, idx) => {
          if (u.checked) {
            issuedUnits += 1;
            return;
          }
          if (withheldUnits.has(u.unitId)) {
            withheld += 1;
            return;
          }
          // Untouched UNIT.
          untouchedUnitLines.push(
            `${item.equipmentName} · прибор ${idx + 1} из ${total}`,
          );
        });
      } else {
        if (countIssued.has(item.bookingItemId)) {
          issuedLines += 1;
        } else if (countWithheld.has(item.bookingItemId)) {
          withheld += 1;
        } else {
          untouchedCountLines.push(`${item.equipmentName} · ×${item.quantity}`);
        }
      }
    }

    return {
      issuedUnits,
      issuedLines,
      withheld,
      addons,
      addonsWithConflict,
      untouchedUnitLines,
      untouchedCountLines,
      addonConflictLines,
    };
  }, [state, countIssued, countWithheld, withheldUnits, conflictAddons]);
```

- [ ] **Step 6: Replace the «Завершить выдачу» onClick to enter `summary` phase**

Find the sticky-footer button:

```tsx
        <button
          type="button"
          onClick={() => onComplete?.()}
          disabled={bulkBusy}
          aria-label={`Завершить выдачу — ${projectName || "бронь"}`}
          className="block w-full rounded-lg bg-accent px-4 py-3 text-center text-sm font-semibold text-white transition-colors hover:opacity-95 disabled:opacity-60"
        >
          Завершить выдачу →
        </button>
        {/* TODO(Task 7/8): wire issue completion (POST /complete) — this only
            advances the flow; completion semantics live in the summary task. */}
```

Replace with:

```tsx
        <button
          type="button"
          onClick={() => setPhase("summary")}
          disabled={bulkBusy}
          aria-label={`Завершить выдачу — ${projectName || "бронь"}`}
          className="block w-full rounded-lg bg-accent px-4 py-3 text-center text-sm font-semibold text-white transition-colors hover:opacity-95 disabled:opacity-60"
        >
          Завершить выдачу →
        </button>
```

- [ ] **Step 7: Effect — fetch the summary when entering `summary`**

After all the existing `useEffect` blocks and `useMemo`s, add (importing `useRef` if not already imported — add to `import { useEffect, useMemo, useRef, useState } from "react";` at top of file):

```ts
  useEffect(() => {
    if (phase !== "summary") return;
    let cancelled = false;
    setSummaryError(null);
    scanApi
      .getSummary(sessionId)
      .then((s) => {
        if (cancelled) return;
        setSummary(s);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg =
          err && typeof err === "object" && "message" in err
            ? String((err as { message: unknown }).message)
            : "Не удалось загрузить сверку";
        setSummaryError(msg);
      });
    return () => {
      cancelled = true;
    };
  }, [phase, sessionId]);
```

(`useRef` actually isn't needed by this effect, but stays useful for Task 9. If your linter complains it's unused, defer the import until Task 9.)

- [ ] **Step 8: Render the summary phase**

Just above the existing `return (` for the main JSX (the `<div className="flex min-h-full flex-1 flex-col">…`), add an early return for the summary phase:

```tsx
  // ── Phase: summary («Сверка») ───────────────────────────────────────────────
  if (phase === "summary") {
    const issuedTotal = counts.issuedUnits + counts.issuedLines;
    const readyTotal = issuedTotal + counts.addons; // emerald badge: «N из M в брони + K доборов»
    const expectedM =
      state.items.filter((i) => !i.isExtra).length || progress.total;
    const reserved = summary?.reservedButUnavailable ?? [];

    return (
      <div className="flex min-h-full flex-1 flex-col">
        <div className="flex-1 px-3 pb-4 pt-3 lg:px-5">
          <div className="mx-auto w-full max-w-[460px]">
            {/* Emerald badge ─ «Готово к выдаче» */}
            <div className="rounded-lg border border-emerald-border bg-emerald-soft px-4 py-4 text-center">
              <p className="eyebrow text-emerald">Готово к выдаче</p>
              <p className="mono-num mt-1 text-[34px] font-semibold leading-none text-emerald">
                {readyTotal}
              </p>
              <p className="mt-1 text-[12px] text-emerald">
                из {expectedM} в брони
                {counts.addons > 0 ? ` + ${counts.addons} доборов` : ""}
              </p>
            </div>

            {summaryError && (
              <div
                role="alert"
                className="mt-3 rounded-lg border border-rose-border bg-rose-soft px-3 py-2 text-[12px] text-rose"
              >
                {summaryError}
              </div>
            )}

            {/* Stat rows */}
            <div className="mt-3 space-y-1.5">
              <StatRow variant="ok" label="✓ Выдаём" value={issuedTotal} />
              {counts.addons > 0 && (
                <StatRow variant="ok" label="＋ Доборы" value={counts.addons} />
              )}
              {counts.withheld > 0 && (
                <StatRow
                  variant="neutral"
                  label="✗ Не выдаём"
                  value={counts.withheld}
                />
              )}
              {counts.untouchedUnitLines.length +
                counts.untouchedCountLines.length >
                0 && (
                <>
                  <StatRow
                    variant="warn"
                    label="⚠ Без отметки — пропустим"
                    value={
                      counts.untouchedUnitLines.length +
                      counts.untouchedCountLines.length
                    }
                  />
                  <DetailList
                    variant="warn"
                    items={[
                      ...counts.untouchedUnitLines,
                      ...counts.untouchedCountLines,
                    ]}
                  />
                </>
              )}
              {reserved.length > 0 && (
                <>
                  <StatRow
                    variant="bad"
                    label="⛔ Резерв недоступен"
                    value={reserved.length}
                  />
                  <DetailList
                    variant="bad"
                    items={reserved.map(
                      (r) =>
                        `${r.equipmentName} · ${r.ordinalLabel} → ${statusLabel(r.status)}`,
                    )}
                  />
                </>
              )}
              {counts.addonsWithConflict > 0 && (
                <>
                  <StatRow
                    variant="neutral"
                    label="＋ Доборы с предупреждением"
                    value={counts.addonsWithConflict}
                  />
                  <DetailList
                    variant="warn"
                    items={counts.addonConflictLines}
                  />
                </>
              )}
            </div>

            {submitError && (
              <div
                role="alert"
                className="mt-3 rounded-lg border border-rose-border bg-rose-soft px-3 py-2 text-[12px] text-rose"
              >
                Не получилось завершить выдачу: {submitError}
              </div>
            )}
          </div>
        </div>

        {/* Sticky footer */}
        <div className="sticky bottom-0 flex gap-2 border-t border-border bg-surface px-3 py-3 lg:px-5">
          <button
            type="button"
            onClick={() => setPhase("checklist")}
            aria-label="Вернуться к чек-листу"
            className="shrink-0 rounded-lg border border-border bg-surface px-3 py-3 text-[13px] font-medium text-ink-2 transition-colors hover:bg-surface-muted"
          >
            ← К чек-листу
          </button>
          <button
            type="button"
            onClick={() => {
              // Wired in Task 9.
              setPhase("submitting");
            }}
            disabled={phase !== "summary"}
            aria-label="Подтвердить выдачу"
            className="flex-1 rounded-lg bg-accent px-4 py-3 text-center text-[13px] font-semibold text-white transition-colors hover:opacity-95 disabled:opacity-60"
          >
            Подтвердить выдачу →
          </button>
        </div>
      </div>
    );
  }
```

- [ ] **Step 9: Add the `StatRow` helper above `DetailList`**

Insert before `DetailList`:

```tsx
function StatRow({
  variant,
  label,
  value,
}: {
  variant: "ok" | "neutral" | "warn" | "bad";
  label: string;
  value: number;
}) {
  const cls =
    variant === "ok"
      ? "border-emerald-border bg-emerald-soft text-emerald"
      : variant === "warn"
        ? "border-amber-border bg-amber-soft text-amber"
        : variant === "bad"
          ? "border-rose-border bg-rose-soft text-rose"
          : "border-border bg-surface text-ink";
  return (
    <div
      className={`mx-3 flex items-center justify-between rounded-lg border px-3 py-2 text-[13px] ${cls}`}
    >
      <span>{label}</span>
      <span className="mono-num font-semibold">{value}</span>
    </div>
  );
}
```

- [ ] **Step 10: Re-run the new tests**

```bash
cd /Users/sechenov/Documents/light-rental-system && npm run test --workspace=apps/web -- src/components/warehouse/__tests__/IssueSummary.test.tsx 2>&1 | tail -25
```

Expected: all six tests pass.

- [ ] **Step 11: Run the full warehouse test suite — no regressions**

```bash
cd /Users/sechenov/Documents/light-rental-system && npm run test --workspace=apps/web -- src/components/warehouse 2>&1 | tail -25
```

Expected: all pass. ⚠️ The existing test «renders «＋ Добор» and a sticky «Завершить выдачу» that calls onComplete» (from `IssueChecklist.test.tsx`) will now fail because pressing «Завершить выдачу» enters the сверка phase instead of calling `onComplete`. Update that test:

In `apps/web/src/components/warehouse/__tests__/IssueChecklist.test.tsx`, replace the body of that `it("renders «＋ Добор» and a sticky «Завершить выдачу» …")` test with:

```ts
  it("renders «＋ Добор» and a sticky «Завершить выдачу» that enters the сверка phase", async () => {
    render(
      <IssueChecklist
        sessionId="s1"
        projectName="Орбита"
        onBack={() => {}}
      />,
    );

    expect(
      (await screen.findAllByRole("button", { name: /Добор/ })).length,
    ).toBeGreaterThanOrEqual(1);

    const finish = screen.getByRole("button", { name: /Завершить выдачу/ });
    finish.click();

    // Phase entered, badge visible.
    expect(await screen.findByText(/Готово к выдаче/)).toBeInTheDocument();
  });
```

Re-run:

```bash
cd /Users/sechenov/Documents/light-rental-system && npm run test --workspace=apps/web -- src/components/warehouse 2>&1 | tail -20
```

Expected: all pass.

- [ ] **Step 12: Commit**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  git add apps/web/src/components/warehouse/IssueChecklist.tsx \
          apps/web/src/components/warehouse/__tests__/IssueChecklist.test.tsx \
          apps/web/src/components/warehouse/__tests__/IssueSummary.test.tsx && \
  git commit -m "feat(web): сверка phase inside IssueChecklist (mockup 04)

«Завершить выдачу» now enters an in-component summary phase: emerald
'Готово к выдаче' badge, stat rows for выдаём/доборы/не выдаём/без
отметки, expanded lists with name + ordinal for warn/bad rows.
Reserved-but-unavailable is read from getSummary (Task 1 backend).
«← К чек-листу» round-trips with preserved state. Soft-warn — no row
disables «Подтвердить выдачу»."
```

---

## Task 9: `IssueChecklist` — submit and render result

**Files:**
- Modify: `apps/web/src/components/warehouse/IssueChecklist.tsx`
- Modify: `apps/web/src/components/warehouse/__tests__/IssueSummary.test.tsx` (add submit test)

- [ ] **Step 1: Write failing test for the happy-path submit + result render**

Append to `apps/web/src/components/warehouse/__tests__/IssueSummary.test.tsx`, inside the same `describe`:

```ts
  it("«Подтвердить выдачу» POSTs /complete and renders the emerald result on success", async () => {
    const completeSpy = vi.fn().mockResolvedValue({
      sessionId: "s1",
      operation: "ISSUE",
      scannedCount: 5,
      expectedCount: 7,
      missingItems: [],
      substitutedItems: [{ id: "u8", name: "Astera Titan Tube", barcode: "X" }],
      reservedButUnavailable: [],
      createdRepairIds: [],
      failedBrokenUnits: [],
      createdProblemItemIds: [],
      failedProblemUnits: [],
    });
    const apiMod = await import("../api");
    // @ts-expect-error — override the read-only `as const` object for the test.
    apiMod.scanApi.complete = completeSpy;

    render(<IssueChecklist sessionId="s1" projectName="Орбита" onBack={() => {}} />);
    (await screen.findByRole("button", { name: /Завершить выдачу/ })).click();
    await screen.findByText(/Готово к выдаче/);
    (
      await screen.findByRole("button", { name: /Подтвердить выдачу/ })
    ).click();

    // POST happened with empty body.
    await waitFor(() => expect(completeSpy).toHaveBeenCalledWith("s1", {}));
    // Emerald result header.
    expect(await screen.findByText("Выдача оформлена")).toBeInTheDocument();
    // info-block visible.
    expect(
      screen.getByText(/Бронь переведена в «Выдана»/),
    ).toBeInTheDocument();
  });

  it("network failure on submit keeps the сверка visible with a rose alert + retry", async () => {
    const apiMod = await import("../api");
    // @ts-expect-error — see above
    apiMod.scanApi.complete = vi.fn().mockRejectedValue({
      status: 500,
      message: "boom",
      code: null,
      details: null,
    });

    render(<IssueChecklist sessionId="s1" projectName="Орбита" onBack={() => {}} />);
    (await screen.findByRole("button", { name: /Завершить выдачу/ })).click();
    await screen.findByText(/Готово к выдаче/);
    (
      await screen.findByRole("button", { name: /Подтвердить выдачу/ })
    ).click();

    expect(
      await screen.findByText(/Не получилось завершить выдачу: boom/),
    ).toBeInTheDocument();
    // Сверка is still visible and «Подтвердить» is re-enabled.
    expect(screen.getByText(/Готово к выдаче/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Подтвердить выдачу/ }),
    ).not.toBeDisabled();
  });
```

- [ ] **Step 2: Run — expect failure (submit currently just sets `phase="submitting"` without a POST)**

```bash
cd /Users/sechenov/Documents/light-rental-system && npm run test --workspace=apps/web -- src/components/warehouse/__tests__/IssueSummary.test.tsx 2>&1 | tail -25
```

Expected: the two new tests fail; older ones still pass.

- [ ] **Step 3: Replace the placeholder submit onClick with a real handler**

In `apps/web/src/components/warehouse/IssueChecklist.tsx`, add a `submitToComplete` function just above the `// ── Phase: summary («Сверка») …` block (so it's in scope for the JSX):

```ts
  async function submitToComplete() {
    if (phase !== "summary") return;
    setSubmitError(null);
    setPhase("submitting");
    try {
      const res = await scanApi.complete(sessionId, {});
      setResult(res);
      setPhase("result");
    } catch (err: unknown) {
      const msg =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : "Сеть недоступна";
      setSubmitError(msg);
      setPhase("summary");
    }
  }
```

Replace the «Подтвердить выдачу» button's onClick and disabled prop:

```tsx
          <button
            type="button"
            onClick={() => {
              // Wired in Task 9.
              setPhase("submitting");
            }}
            disabled={phase !== "summary"}
            ...
```

with:

```tsx
          <button
            type="button"
            onClick={() => void submitToComplete()}
            disabled={phase === "submitting"}
            ...
```

- [ ] **Step 4: Render the result phase**

Just above the `// ── Phase: summary …` block, add another early return:

```tsx
  // ── Phase: result («Выдача оформлена[ с замечаниями]») ───────────────────────
  if (phase === "result" && result) {
    return (
      <IssueResultView
        result={result}
        projectName={projectName}
        issuedCount={counts.issuedUnits + counts.issuedLines}
        addonsCount={counts.addons}
        substitutedCount={result.substitutedItems?.length ?? 0}
        onDone={() => onComplete?.()}
      />
    );
  }
```

(Reusing the existing `onComplete?.()` as the «Готово» callback — Task 10 wires the page to pass `backToBooking` there.)

- [ ] **Step 5: Re-run new tests — expect pass**

```bash
cd /Users/sechenov/Documents/light-rental-system && npm run test --workspace=apps/web -- src/components/warehouse/__tests__/IssueSummary.test.tsx 2>&1 | tail -20
```

Expected: both new tests pass; older «summary phase» tests still green.

- [ ] **Step 6: Full warehouse-component test sweep — no regressions**

```bash
cd /Users/sechenov/Documents/light-rental-system && npm run test --workspace=apps/web -- src/components/warehouse 2>&1 | tail -25
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  git add apps/web/src/components/warehouse/IssueChecklist.tsx \
          apps/web/src/components/warehouse/__tests__/IssueSummary.test.tsx && \
  git commit -m "feat(web): wire POST /complete and emerald/amber result phase

«Подтвердить выдачу» now POSTs an empty body to api.complete; on
success the IssueResultView replaces the сверка in-place. Network
errors stay on the сверка with a rose alert — backend transition is
idempotent (Task 2), so retry is safe."
```

---

## Task 10: Page-level cleanup — delete `SummaryStep`, drop `summary` step

**Files:**
- Modify: `apps/web/app/warehouse/scan/page.tsx`
- Modify: `apps/web/src/components/warehouse/types.ts` (drop `"summary"` from `ScanStep`)
- Delete: `apps/web/src/components/warehouse/SummaryStep.tsx`

- [ ] **Step 1: Read the current page step machine to confirm the right block to remove**

```bash
grep -n 'summary\|SummaryStep' /Users/sechenov/Documents/light-rental-system/apps/web/app/warehouse/scan/page.tsx
```

Expected: hits include the `import { SummaryStep }`, the `step === "summary"` block, and the `onComplete={() => goStep("summary")}` line.

- [ ] **Step 2: Update the page**

Open `apps/web/app/warehouse/scan/page.tsx`. Make four edits:

1. Remove the `SummaryStep` import.
2. Update the file header comment removing the `summary →` line.
3. Change the `IssueChecklist` props in the `step === "checklist" && sessionId` branch:

   ```tsx
   <IssueChecklist
     sessionId={sessionId}
     projectName={projectName}
     onBack={backToBooking}
     onComplete={backToBooking}
   />
   ```

   (`onComplete` is now wired by `IssueChecklist` to the result-screen «Готово».)

4. **Delete** the entire `if (step === "summary" && sessionId) { … }` block.

After these edits, the page no longer references `summary` anywhere.

- [ ] **Step 3: Drop `"summary"` from `ScanStep`**

In `apps/web/src/components/warehouse/types.ts`, change:

```ts
export type ScanStep = "login" | "operation" | "booking" | "checklist" | "summary";
```

to:

```ts
export type ScanStep = "login" | "operation" | "booking" | "checklist";
```

- [ ] **Step 4: Delete the placeholder file**

```bash
rm /Users/sechenov/Documents/light-rental-system/apps/web/src/components/warehouse/SummaryStep.tsx
```

- [ ] **Step 5: Typecheck**

```bash
cd /Users/sechenov/Documents/light-rental-system && npm run --workspace=apps/web typecheck 2>&1 | tail -15
```

Expected: zero errors. If anything references `"summary"` or `SummaryStep`, surface it and fix:

```bash
grep -rn 'summary\|SummaryStep' /Users/sechenov/Documents/light-rental-system/apps/web/src/components/warehouse /Users/sechenov/Documents/light-rental-system/apps/web/app/warehouse 2>/dev/null
```

(The string `"summary"` may still appear in the `useScanSession` hook's `goStep` argument validation if it uses the type-narrow — if so, the narrow tightens automatically; no runtime work.)

- [ ] **Step 6: Re-run all warehouse tests**

```bash
cd /Users/sechenov/Documents/light-rental-system && npm run test --workspace=apps/web -- src/components/warehouse 2>&1 | tail -25
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  git add apps/web/app/warehouse/scan/page.tsx \
          apps/web/src/components/warehouse/types.ts && \
  git rm apps/web/src/components/warehouse/SummaryStep.tsx && \
  git commit -m "refactor(web): drop SummaryStep placeholder and 'summary' page step

The ISSUE-flow finale now lives entirely inside IssueChecklist's phase
machine. The 'summary' step in page.tsx + the SummaryStep placeholder
are dead — remove both, and tighten ScanStep accordingly."
```

---

## Task 11: Full backend + frontend test sweep + smoke + design-fidelity screenshots

**Files:** none modified by default; `docs/superpowers/specs/.../FIDELITY-CHECK.md` updated if you have one for this redesign.

- [ ] **Step 1: Run all backend tests**

```bash
cd /Users/sechenov/Documents/light-rental-system && npm run test --workspace=apps/api 2>&1 | tail -25
```

Expected: all green. If anything else broke (unlikely — only `getReconciliationPreview` shape changed, with `reservedButUnavailable: []` default for RETURN), surface and fix.

- [ ] **Step 2: Run all frontend tests**

```bash
cd /Users/sechenov/Documents/light-rental-system && npm run test --workspace=apps/web 2>&1 | tail -25
```

Expected: all green.

- [ ] **Step 3: Manual smoke — full kiosk flow**

Spin up backend + frontend:

```bash
cd /Users/sechenov/Documents/light-rental-system && npm run dev
```

Open `http://localhost:3000/warehouse/scan` in a private window. With a known CONFIRMED booking that has 2+ items including one with a MAINTENANCE-status reserved unit:

1. PIN-login as the warehouse worker.
2. Choose «Выдача».
3. Pick the test booking.
4. Mark a couple of items ✓, a couple ✗, leave a couple untouched.
5. Add a добор «под ответственность» (a busy article).
6. Press «Завершить выдачу» — verify:
   - emerald badge with `N` matches your manual count;
   - «✗ Не выдаём» shows the right number;
   - «⚠ Без отметки» lists your untouched units by name + «прибор N из M»;
   - «⛔ Резерв недоступен» shows the MAINTENANCE unit;
   - «＋ Доборы с предупреждением» shows the conflicted добор;
   - «Подтвердить выдачу» is NOT disabled.
7. Press «Подтвердить выдачу». Expect emerald «Выдача оформлена» + the info-block, then press «Готово».
8. Verify in the booking list that the booking now appears under RETURN.

Capture screenshots at 375 + 1440 widths for: сверка, result-success, and (a separate fake-failure run if you have one) result-warnings — saving under `docs/mockups/warehouse-scan/screenshots/` per the existing convention.

- [ ] **Step 4: Compare screenshots against the mockup**

Visual diff your `12-issue-summary-*.png`, `13-issue-result-success-*.png`, `14-issue-result-warnings-*.png` against `docs/mockups/warehouse-scan/04-issue-summary-and-result.html`. Flag any visual regression vs the approved mockup and fix.

- [ ] **Step 5: Commit screenshots (if you take them on disk)**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  git add docs/mockups/warehouse-scan/screenshots/12-issue-summary-*.png \
          docs/mockups/warehouse-scan/screenshots/13-issue-result-success-*.png \
          docs/mockups/warehouse-scan/screenshots/14-issue-result-warnings-*.png && \
  git commit -m "docs(mockups): design-fidelity screenshots for ISSUE сверка + result"
```

(Skip if you don't ship screenshots in-repo — your team may use a different fidelity workflow.)

---

## Task 12: PR + auto-deploy + prod verify

**Files:** none — workflow only.

- [ ] **Step 1: Confirm the branch is fully up to date and tests pass at HEAD**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  git log --oneline origin/main..HEAD && \
  git status -sb
```

Expected: a clean list of your `feat:` / `refactor:` commits from Tasks 1–11, no staged/unstaged changes left over.

- [ ] **Step 2: Push the branch**

```bash
cd /Users/sechenov/Documents/light-rental-system && git push -u origin feat/issue-completion
```

- [ ] **Step 3: Open the PR**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  gh pr create --title "feat(warehouse): ISSUE-completion flow (сверка → подтвердить → результат)" --body "$(cat <<'EOF'
## Summary

- Replace the «Сверка и завершение · В разработке» placeholder with a real in-component three-phase finale for the ISSUE flow: emerald «Готово к выдаче» badge, stat rows for выдаём/доборы/не выдаём/без отметки, expanded lists with name + ordinal for warn/bad rows, soft-warn (no row blocks confirm), emerald/amber result screen.
- Close a backend gap where `completeSession(ISSUE)` never transitioned `booking.status` from `CONFIRMED` to `ISSUED`. Without this fix, completed-issue bookings were invisible to RETURN — broken workflow loop.
- Enrich `getReconciliationPreview` (`GET /summary`) with `reservedButUnavailable` items containing name + ordinal + status so the frontend can render «SkyPanel S60 · прибор 2 из 2 → ремонт» without a second round-trip.

Spec: `docs/superpowers/specs/2026-05-20-issue-completion-flow-design.md`
Mockup: `docs/mockups/warehouse-scan/04-issue-summary-and-result.html`

## Out of scope

- Symmetric `RETURNED` transition for `completeSession(RETURN)` — flagged for a follow-up PR (spec §5.3).
- Warehouse-audit FK refactor — best-effort `.catch()` retained (spec §5.2).

## Test plan

- [ ] All backend tests pass (`npm run test --workspace=apps/api`).
- [ ] All frontend tests pass (`npm run test --workspace=apps/web`).
- [ ] Manual smoke: PIN-login → выдача → mixed ✓/✗/untouched/добор «под ответственность» → сверка numbers correct → подтвердить → emerald result → booking appears under RETURN.
- [ ] Design-fidelity: сверка + emerald result + amber result match `docs/mockups/warehouse-scan/04-issue-summary-and-result.html`.
- [ ] Auto-deploy (`deploy-rsync.yml`) green; health gate passes; live `/warehouse/scan` exercises the same flow end-to-end.
EOF
)"
```

Capture the PR URL — share it with the user.

- [ ] **Step 4: Watch the auto-deploy**

The `deploy-rsync.yml` workflow auto-fires on push to `main`. After merging the PR, wait for it to complete and verify the health-gate step passes:

```bash
gh run list --workflow=deploy-rsync.yml --limit 1
gh run view <run-id>
```

- [ ] **Step 5: Live verification**

On `https://svetobazarent.ru/warehouse/scan` (or your prod URL), repeat the smoke flow from Task 11 step 3 with a real or QA booking. Confirm:

- Bookings transition CONFIRMED → ISSUED (visible in the RETURN list).
- No P2003 audit errors crash anything (audit `.catch()` may log warnings — that's expected).

- [ ] **Step 6: Hand off via finishing-a-development-branch**

Per the superpowers workflow, invoke `superpowers:finishing-a-development-branch` once the PR is merged and prod is verified — it cleans up the worktree / branch / tasks.

---

## Self-Review

**Spec coverage:**
- §3.1 Сверка screen (badge, stat rows, expansion lists, soft-warn) → Task 8.
- §3.2 Подтверждение (POST, network error path, idempotent retry) → Task 9.
- §3.3 Результат (emerald / amber, counts, info-block) → Task 5 + Task 9.
- §4 Client state (countWithheld, withheldUnits, conflictAddons, phase, summary, submitError, result) → Tasks 6 + 7.
- §4.1 Formal counts → Task 8 (counts memo).
- §5.1 Booking transition inside `$transaction` → Task 2.
- §5.2 Best-effort `BOOKING_STATUS_CHANGED` audit → Task 2.
- §5.3 RETURN out-of-scope → reflected in PR description.
- §6 File list → mirrored in this plan's file table.
- §7 Tests → IssueResultView (Task 5), IssueSummary (Tasks 8 + 9), IssueChecklist additions (Task 7), backend integration (Tasks 1 + 2).
- §9 Risks → mitigations baked in (idempotent backend, soft-warn UI, FE-truth counts, best-effort audit).
- §10 Acceptance → Task 11 manual smoke + Task 12 prod verify.

**Placeholder scan:** no "TBD", "TODO", "implement later", or "similar to Task N" left in the plan. Every step shows the actual code, the actual file, and the actual command. The only `// TODO` was the existing comment in the IssueChecklist footer, explicitly removed in Task 8 step 6.

**Type consistency:**
- Backend `ReservedButUnavailableUnit` ↔ frontend `ReservedButUnavailableUnit` — identical field shape (Task 1 vs Task 3).
- Backend `ReconciliationSummary.reservedButUnavailable` ↔ frontend `SummaryResult.reservedButUnavailable` — same array type, frontend type re-uses the mirrored interface.
- `AddonSearch.onAdded(bookingItemId: string, hadConflict: boolean)` ↔ `IssueChecklist.handleAddonAdded(bookingItemId, hadConflict)` — identical signature (Task 4 + Task 7).
- `IssueResultView` props `(result, projectName, issuedCount, addonsCount, substitutedCount, onDone)` — same in Task 5 component, Task 5 test, and Task 9 IssueChecklist render.
- `IssuePhase` is defined once at top of IssueChecklist; every state-update site uses one of `"checklist" | "summary" | "submitting" | "result"` — no other strings.

Reviewed: no inconsistencies found.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-20-issue-completion-flow.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
