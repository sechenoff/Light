# Cosmetic Polish (Subproject D) Implementation Plan

> **For agentic workers:** This plan is implemented by a single `standard-implementer` subagent (sonnet, medium effort) running tasks in order. Steps use checkbox (`- [ ]`) syntax for tracking. No new dependencies, no API/schema changes. All work is mechanical UI cleanup + one new presentational component.

**Goal:** Bring 6 still-leaking pages to the IBM Plex design canon, add an `ApprovalTimeline` component to `/bookings/[id]` that surfaces the booking-approval audit history (SUPER_ADMIN only), and patch the icon-only-button accessibility deficit (`aria-label`).

**Architecture:** Pure frontend changes inside `apps/web/`. No new routes, no API changes, no schema changes. Reuse the existing `GET /api/audit?entityType=Booking&entityId=<id>` endpoint (Sprint 2). All replacements use already-defined Tailwind tokens from `docs/design-system.md`. Status badges are unified through the existing `<StatusPill>` primitive.

**Tech Stack:** Next.js 14 + React 18 + Tailwind CSS 3, Vitest for unit tests, plain `fetch` for API calls.

---

## Canonical Token Mapping (apply across all repaint tasks)

The implementer applies these rules whenever a forbidden class appears. Memorize them — they're the bulk of the work.

### Background

| Forbidden | Replacement | When |
|---|---|---|
| `bg-slate-50`, `bg-slate-100` | `bg-surface` | Inert page/card backdrops |
| `bg-slate-200` | `bg-surface-muted` | Skeleton loaders, hover row |
| `bg-slate-700`, `bg-slate-800`, `bg-slate-900` | `bg-accent` | Dark headers, dark primary buttons (paired with `text-white`) |
| `bg-blue-50`, `bg-sky-50` | `bg-accent-soft` | Info-tinted backgrounds |
| `bg-blue-100` | `bg-accent-soft` | Light info badges |
| `bg-blue-500`, `bg-blue-600`, `bg-blue-700`, `bg-sky-500`, `bg-sky-600` | `bg-accent-bright` | Primary action buttons / status dots |
| `bg-emerald-50`, `bg-emerald-100` | `bg-emerald-soft` | Success badges |
| `bg-emerald-500`, `bg-emerald-600`, `bg-emerald-700` | `bg-emerald` | Solid success buttons |
| `bg-amber-50`, `bg-amber-100`, `bg-yellow-50` | `bg-amber-soft` | Warning badges |
| `bg-amber-500`, `bg-amber-600`, `bg-yellow-500` | `bg-amber` | Solid warning indicator dot |
| `bg-rose-50`, `bg-rose-100`, `bg-red-50` | `bg-rose-soft` | Error/destructive badges |
| `bg-rose-500`, `bg-rose-600`, `bg-rose-700`, `bg-red-500`, `bg-red-600` | `bg-rose` | Solid destructive button |
| `bg-teal-50`, `bg-teal-100` | `bg-teal-soft` | Edit / warehouse-tinted |
| `bg-indigo-50`, `bg-indigo-100` | `bg-indigo-soft` | Manager/own-tinted |
| `bg-gray-*`, `bg-zinc-*`, `bg-neutral-*` (any number) | Same rule as `bg-slate-*` of the same number | All neutral palettes collapse to the canon |

### Text

| Forbidden | Replacement | When |
|---|---|---|
| `text-slate-900`, `text-slate-800`, `text-slate-700`, `text-gray-900`, `text-gray-800` | `text-ink` | Primary text |
| `text-slate-600`, `text-slate-500`, `text-gray-600`, `text-gray-500` | `text-ink-2` | Secondary text |
| `text-slate-400`, `text-slate-300`, `text-gray-400`, `text-gray-300` | `text-ink-3` | Muted / placeholder |
| `text-blue-600`, `text-blue-700`, `text-sky-600`, `text-sky-700` | `text-accent-bright` | Links, accent text |
| `text-blue-500`, `text-blue-800`, `text-blue-900` | `text-accent` | Headings on light blue |
| `text-emerald-600`, `text-emerald-700`, `text-emerald-800`, `text-green-600`, `text-green-700` | `text-emerald` | Success copy |
| `text-amber-600`, `text-amber-700`, `text-amber-800`, `text-yellow-700` | `text-amber` | Warning copy |
| `text-rose-500`, `text-rose-600`, `text-rose-700`, `text-rose-800`, `text-red-600`, `text-red-700` | `text-rose` | Error copy |
| `text-teal-600`, `text-teal-700` | `text-teal` | Edit/warehouse copy |
| `text-indigo-600`, `text-indigo-700` | `text-indigo` | Manager/own copy |

### Borders

| Forbidden | Replacement |
|---|---|
| `border-slate-200`, `border-slate-300`, `border-gray-200`, `border-gray-300` | `border-border` |
| `border-blue-200`, `border-blue-300`, `border-sky-200`, `border-sky-300` | `border-accent-border` |
| `border-rose-200`, `border-rose-300`, `border-red-200`, `border-red-300` | `border-rose-border` |
| `border-amber-200`, `border-amber-300`, `border-yellow-200` | `border-amber-border` |
| `border-emerald-200`, `border-emerald-300`, `border-green-200` | `border-emerald-border` |
| `border-teal-200`, `border-teal-300` | `border-teal-border` |
| `border-indigo-200`, `border-indigo-300` | `border-indigo-border` |

### Hover states

`hover:bg-slate-50` → `hover:bg-surface-muted`
`hover:bg-slate-100` → `hover:bg-surface-muted`
`hover:bg-blue-50` → `hover:bg-accent-soft`
`hover:text-slate-900` → `hover:text-ink`

### Status badges — replace with `<StatusPill>`

Whenever you see this pattern (or any close variation), delete it and use `<StatusPill>`:

```tsx
<span className="inline-flex items-center rounded border px-2 py-0.5 text-xs font-semibold bg-XXX-100 text-XXX-700 border-XXX-200">{label}</span>
```

The variant mapping:

| Semantic | StatusPill variant |
|---|---|
| Success / OK / AVAILABLE / Active | `"ok"` |
| Warning / Pending / ISSUED / In progress | `"warn"` |
| Info / DRAFT / informational | `"info"` |
| Edit-mode / WAREHOUSE-role | `"edit"` |
| View-only / muted | `"view"` |
| Manager / "own" / SUPER_ADMIN-role | `"own"` |
| Limited / partial access | `"limited"` |
| Unavailable / RETIRED / inert | `"none"` |
| "Full access" green | `"full"` |

`<StatusPill>` is imported from `../../../src/components/StatusPill` (relative path depends on the consuming file). Variants and hex are owned by the component — never duplicate them.

### What NOT to touch

- Anything inside `apps/web/app/finance/` — finance SVG bars and category-color dots are out of scope (Sprint 5 audit confirmed they need their own treatment).
- Inline `style={{}}` for legitimate dynamic values (positioning, computed colors from API data). The brief excludes finance-style escapes — leave them alone.
- The `RejectBookingModal` — already canonized in Subproject B.
- `AppShell.tsx` and other components NOT named in the per-task lists. The brief is "6 pages + ApprovalTimeline + aria-labels". Stay in scope.

---

## Verification Commands (used at end of every repaint task)

After each repaint task, run this from the worktree root and confirm it returns **0**:

```bash
grep -REn 'bg-(slate|blue|sky|gray|emerald|amber|rose|teal|indigo|red|green|yellow|zinc|neutral)-[0-9]|text-(slate|blue|sky|gray|emerald|amber|rose|teal|indigo|red|green|yellow|zinc|neutral)-[0-9]|border-(slate|blue|sky|gray|emerald|amber|rose|teal|indigo|red|green|yellow|zinc|neutral)-[0-9]' <FILE_PATH> | wc -l
```

Expected after fix: **0**.

If a number appears in a non-class context (e.g. inside a template literal that is later sanitized) and grep flags a false positive, leave it AND note it in the commit message. False positives must be human-justified, not silently ignored.

---

## Task 1: Baseline — confirm green tests + tsc

**Files:** none (read-only verification)

- [ ] **Step 1:** From worktree root, generate Prisma client (lazy — only api needs it but our dev infra runs it on all installs):

```bash
cd /Users/sechenov/Documents/light-rental-system/.worktrees/cosmetic-polish && npm run prisma:generate 2>&1 | tail -10
```

Expected: `✔ Generated Prisma Client (...)` with no errors.

- [ ] **Step 2:** Type-check web (this is the strictest gate for the bulk of our work):

```bash
cd apps/web && timeout 90 npx tsc --noEmit 2>&1 | tail -20
```

Expected: empty output (exit 0).

- [ ] **Step 3:** Type-check api (we don't change api code but ApprovalTimeline reads /api/audit shape — make sure baseline matches):

```bash
cd ../../apps/api && timeout 90 npx tsc --noEmit 2>&1 | tail -20
```

Expected: exit 0.

- [ ] **Step 4:** Run full test suite to confirm green starting point:

```bash
cd ../.. && timeout 300 npm test 2>&1 | tail -25
```

Expected: all suites pass, ≥414 tests (the post-Subproject-B baseline). Do not proceed if anything fails — investigate first.

---

## Task 2: ApprovalTimeline component (TDD)

**Why first:** This is the only task with new logic. Doing it before the bulk repaint means it's testable in isolation and we don't conflate styling regressions with logic regressions.

**Files:**
- Create: `apps/web/src/components/bookings/ApprovalTimeline.tsx`
- Create: `apps/web/src/components/bookings/__tests__/ApprovalTimeline.test.tsx`
- Modify: `apps/web/app/bookings/[id]/page.tsx` (insertion point: after PENDING_APPROVAL amber alert at line 282, before the action-buttons row at line 284)

### Endpoint contract (from Sprint 2)

`GET /api/audit?entityType=Booking&entityId=<id>&limit=200`

Response shape:
```ts
{
  items: Array<{
    id: string;
    userId: string;
    action: string;          // "BOOKING_SUBMITTED" | "BOOKING_APPROVED" | "BOOKING_REJECTED" | other Booking-scoped actions
    entityType: "Booking";
    entityId: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    createdAt: string;       // ISO
    user?: { username: string } | null;  // optional join
  }>;
  nextCursor: string | null;
}
```

The endpoint is `SUPER_ADMIN`-only (returns 403 otherwise). The component must therefore only render for SUPER_ADMIN.

### Component contract

```tsx
// ApprovalTimeline.tsx
type Props = { bookingId: string };
// Renders: <details> wrapper (default-collapsed) with eyebrow heading,
// list of approval-related events in reverse chronological order.
// On mount: GET /api/audit?entityType=Booking&entityId=<id>&limit=200
// Filter client-side to only ["BOOKING_SUBMITTED","BOOKING_APPROVED","BOOKING_REJECTED"]
// (the endpoint returns ALL Booking actions; we narrow to approval-flow events).
// If 403 → render nothing (defensive — caller already gates by role).
// If empty after filter → render nothing.
// If API error (other than 403) → render small muted error line inside the <details>.
```

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/bookings/__tests__/ApprovalTimeline.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApprovalTimeline } from "../ApprovalTimeline";

const ORIGINAL_FETCH = global.fetch;

beforeEach(() => {
  global.fetch = vi.fn();
});
afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

function mockAuditResponse(items: Array<Partial<{ id: string; action: string; userId: string; createdAt: string; before: any; after: any; user: { username: string } }>>) {
  (global.fetch as any).mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ items, nextCursor: null }),
  });
}

describe("ApprovalTimeline", () => {
  it("renders nothing when no approval events", async () => {
    mockAuditResponse([]);
    const { container } = render(<ApprovalTimeline bookingId="b1" />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(container.querySelector("details")).toBeNull();
  });

  it("renders nothing on 403 (non-SUPER_ADMIN viewer)", async () => {
    (global.fetch as any).mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({}) });
    const { container } = render(<ApprovalTimeline bookingId="b1" />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(container.querySelector("details")).toBeNull();
  });

  it("filters to approval-flow actions and shows them in reverse chrono order", async () => {
    mockAuditResponse([
      { id: "a3", action: "BOOKING_APPROVED", userId: "u1", createdAt: "2026-04-15T12:00:00Z", before: { status: "PENDING_APPROVAL" }, after: { status: "CONFIRMED" }, user: { username: "boss" } },
      { id: "a2", action: "BOOKING_SUBMITTED", userId: "u2", createdAt: "2026-04-15T10:00:00Z", before: { status: "DRAFT" }, after: { status: "PENDING_APPROVAL" }, user: { username: "wh" } },
      { id: "a-other", action: "BOOKING_DELETED", userId: "u1", createdAt: "2026-04-15T11:00:00Z", before: null, after: null },
      { id: "a1", action: "BOOKING_REJECTED", userId: "u1", createdAt: "2026-04-14T15:00:00Z", before: { status: "PENDING_APPROVAL" }, after: { status: "DRAFT", rejectionReason: "не та смета" }, user: { username: "boss" } },
    ]);
    render(<ApprovalTimeline bookingId="b1" />);
    // Events appear (default-collapsed but children rendered for query)
    await waitFor(() => expect(screen.getByText(/одобрено/i)).toBeInTheDocument());
    expect(screen.getByText(/одобрено/i)).toBeInTheDocument();
    expect(screen.getByText(/отправлено на согласование/i)).toBeInTheDocument();
    expect(screen.getByText(/отклонено/i)).toBeInTheDocument();
    // Rejection reason surfaced
    expect(screen.getByText(/не та смета/)).toBeInTheDocument();
    // Other action filtered out
    expect(screen.queryByText(/BOOKING_DELETED/i)).toBeNull();
  });

  it("shows a friendly error if fetch throws", async () => {
    (global.fetch as any).mockRejectedValueOnce(new Error("network"));
    render(<ApprovalTimeline bookingId="b1" />);
    await waitFor(() => expect(screen.getByText(/не удалось загрузить/i)).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run the test, confirm failure**

```bash
cd /Users/sechenov/Documents/light-rental-system/.worktrees/cosmetic-polish/apps/web && timeout 60 npx vitest run src/components/bookings/__tests__/ApprovalTimeline.test.tsx 2>&1 | tail -25
```

Expected: FAIL with `Cannot find module '../ApprovalTimeline'` or similar.

- [ ] **Step 3: Implement the component**

Create `apps/web/src/components/bookings/ApprovalTimeline.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";

type AuditItem = {
  id: string;
  userId: string;
  action: string;
  entityType: string;
  entityId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  createdAt: string;
  user?: { username: string } | null;
};

const APPROVAL_ACTIONS = new Set([
  "BOOKING_SUBMITTED",
  "BOOKING_APPROVED",
  "BOOKING_REJECTED",
]);

function actionLabel(action: string): string {
  switch (action) {
    case "BOOKING_SUBMITTED":
      return "Отправлено на согласование";
    case "BOOKING_APPROVED":
      return "Одобрено";
    case "BOOKING_REJECTED":
      return "Отклонено";
    default:
      return action;
  }
}

function actionDotClass(action: string): string {
  switch (action) {
    case "BOOKING_APPROVED":
      return "bg-emerald";
    case "BOOKING_REJECTED":
      return "bg-rose";
    case "BOOKING_SUBMITTED":
    default:
      return "bg-amber";
  }
}

function formatTs(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function ApprovalTimeline({ bookingId }: { bookingId: string }) {
  const [items, setItems] = useState<AuditItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setItems(null);
    fetch(
      `/api/audit?entityType=Booking&entityId=${encodeURIComponent(bookingId)}&limit=200`,
      { credentials: "include" },
    )
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 403) {
          setHidden(true);
          return;
        }
        if (!res.ok) {
          setError("Не удалось загрузить историю согласования");
          return;
        }
        const data = (await res.json()) as { items: AuditItem[] };
        const filtered = (data.items ?? [])
          .filter((it) => APPROVAL_ACTIONS.has(it.action))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        setItems(filtered);
      })
      .catch(() => {
        if (cancelled) return;
        setError("Не удалось загрузить историю согласования");
      });
    return () => {
      cancelled = true;
    };
  }, [bookingId]);

  if (hidden) return null;
  if (error) {
    return (
      <details className="mt-3 rounded-lg border border-border bg-surface text-sm">
        <summary className="cursor-pointer px-3 py-2 text-ink-2">
          <span className="eyebrow">История согласования</span>
        </summary>
        <div className="px-3 pb-3 text-ink-3">{error}</div>
      </details>
    );
  }
  if (!items || items.length === 0) return null;

  return (
    <details className="mt-3 rounded-lg border border-border bg-surface text-sm">
      <summary className="cursor-pointer select-none px-3 py-2 text-ink-2">
        <span className="eyebrow">История согласования</span>
        <span className="ml-2 text-ink-3">({items.length})</span>
      </summary>
      <ol className="divide-y divide-border px-3 pb-3 pt-1">
        {items.map((it) => {
          const reason =
            it.action === "BOOKING_REJECTED" && it.after && typeof (it.after as any).rejectionReason === "string"
              ? ((it.after as any).rejectionReason as string)
              : null;
          const username = it.user?.username ?? it.userId;
          return (
            <li key={it.id} className="flex items-start gap-3 py-2">
              <span
                aria-hidden="true"
                className={`mt-1 inline-block h-2 w-2 shrink-0 rounded-full ${actionDotClass(it.action)}`}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-semibold text-ink">{actionLabel(it.action)}</span>
                  <span className="text-xs text-ink-3">{formatTs(it.createdAt)}</span>
                </div>
                <div className="text-xs text-ink-2">{username}</div>
                {reason && (
                  <div className="mt-1 whitespace-pre-wrap rounded bg-rose-soft px-2 py-1 text-xs text-rose">
                    {reason}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </details>
  );
}
```

- [ ] **Step 4: Run the test, confirm pass**

```bash
cd /Users/sechenov/Documents/light-rental-system/.worktrees/cosmetic-polish/apps/web && timeout 60 npx vitest run src/components/bookings/__tests__/ApprovalTimeline.test.tsx 2>&1 | tail -20
```

Expected: all 4 tests PASS.

If any test fails, adjust the component logic — do NOT relax the test assertions.

- [ ] **Step 5: Wire ApprovalTimeline into the booking detail page**

Open `apps/web/app/bookings/[id]/page.tsx`. Add the import (alongside the existing RejectBookingModal import at line 13):

```tsx
import { ApprovalTimeline } from "../../../src/components/bookings/ApprovalTimeline";
```

Then locate this block (around lines 278-282):

```tsx
          {booking.status === "PENDING_APPROVAL" && (
            <div className="mb-4 rounded border border-amber bg-amber-soft px-4 py-2 text-sm text-ink-1">
              Бронь на согласовании у руководителя — редактирование временно заблокировано.
            </div>
          )}
```

Insert the ApprovalTimeline immediately AFTER it (and before the action-buttons row at line 284), gated on SUPER_ADMIN:

```tsx
          {user?.role === "SUPER_ADMIN" && (
            <ApprovalTimeline bookingId={booking.id} />
          )}
```

- [ ] **Step 6: Type-check + tests**

```bash
cd /Users/sechenov/Documents/light-rental-system/.worktrees/cosmetic-polish/apps/web && timeout 90 npx tsc --noEmit 2>&1 | tail -10 && timeout 60 npx vitest run 2>&1 | tail -15
```

Expected: tsc exit 0, all vitest suites pass.

- [ ] **Step 7: Commit**

```bash
cd /Users/sechenov/Documents/light-rental-system/.worktrees/cosmetic-polish && git add apps/web/src/components/bookings/ApprovalTimeline.tsx apps/web/src/components/bookings/__tests__/ApprovalTimeline.test.tsx apps/web/app/bookings/[id]/page.tsx && git commit -m "feat(web): ApprovalTimeline on /bookings/[id] (SUPER_ADMIN)"
```

---

## Task 3: Repaint /calendar (35 violations)

**Files:**
- Modify: `apps/web/app/calendar/page.tsx`

This page is mostly canon-clean inside the cell-color logic but leaks in skeletons, period toggle, inputs, and mobile status dots.

- [ ] **Step 1:** Open `apps/web/app/calendar/page.tsx` and apply the canonical mapping table to every flagged class. Specific known hotspots from the survey:

  - Lines 79, 81, 91 (skeleton): `bg-slate-200` → `bg-surface-muted`; `bg-slate-100` → `bg-surface`.
  - Line 282 (page title): `text-slate-800` → `text-ink`.
  - Lines 301-365 (period toggle, filters): `bg-slate-800` → `bg-accent`; `text-slate-700` → `text-ink-2`; `bg-slate-50` → `bg-surface`; `border-slate-200/300` → `border-border`.
  - Lines 391, 594 (empty state): `text-slate-400` → `text-ink-3`.
  - Line 619 (mobile card border): `border-slate-200` → `border-border`.
  - Lines 650-653 (mobile status dots): `bg-blue-500` → `bg-accent-bright`; `bg-amber-500` → `bg-amber`; `bg-slate-400` → `bg-ink-3`.

  Also verify and replace any `text-slate-*`, `bg-slate-*`, `border-slate-*`, `text-blue-*`, `bg-blue-*` per the canonical mapping table — there may be more than the survey enumerated.

- [ ] **Step 2:** Verify zero violations remain in this file:

```bash
cd /Users/sechenov/Documents/light-rental-system/.worktrees/cosmetic-polish && grep -REn 'bg-(slate|blue|sky|gray|emerald|amber|rose|teal|indigo|red|green|yellow|zinc|neutral)-[0-9]|text-(slate|blue|sky|gray|emerald|amber|rose|teal|indigo|red|green|yellow|zinc|neutral)-[0-9]|border-(slate|blue|sky|gray|emerald|amber|rose|teal|indigo|red|green|yellow|zinc|neutral)-[0-9]' apps/web/app/calendar/page.tsx | wc -l
```

Expected: `0`.

- [ ] **Step 3:** Type-check:

```bash
cd apps/web && timeout 90 npx tsc --noEmit 2>&1 | tail -10
```

Expected: exit 0.

- [ ] **Step 4:** Commit:

```bash
cd /Users/sechenov/Documents/light-rental-system/.worktrees/cosmetic-polish && git add apps/web/app/calendar/page.tsx && git commit -m "style(calendar): tokenize remaining slate/blue palette to design canon"
```

---

## Task 4: Repaint /repair (6 violations)

**Files:**
- Modify: `apps/web/app/repair/page.tsx`

Smallest of the six — knock it out next to keep momentum.

- [ ] **Step 1:** Open `apps/web/app/repair/page.tsx`.

  - Lines 49-51 (urgency badges): switch the inline `<span className="...bg-rose-100 text-rose-700 border-rose-200...">` (and the amber + slate variants) to `<StatusPill variant="warn" label="Срочно" />` style. Mapping:
    - URGENT (rose) → `<StatusPill variant="warn" label="..." />` is wrong (warn=amber). Use `bg-rose-soft text-rose border border-rose-border` directly with the existing pill markup, OR add a custom inline pill — but prefer canon tokens for consistency.
    - More precise: keep the `<span>` shape but replace classes:
      - URGENT: `bg-rose-soft text-rose border border-rose-border`
      - NORMAL: `bg-amber-soft text-amber border border-amber-border`
      - NOT_URGENT: `bg-slate-soft text-slate border border-slate-border`
  - Line 197 (error alert, already mostly canon): swap `bg-rose-50` → `bg-rose-soft`, `border-rose-200` → `border-rose-border`, `text-rose-700` → `text-rose` (verify exact form).
  - Lines 207, 209 (skeleton): `bg-slate-100` → `bg-surface-muted`.

- [ ] **Step 2:** Verify zero violations:

```bash
cd /Users/sechenov/Documents/light-rental-system/.worktrees/cosmetic-polish && grep -REn 'bg-(slate|blue|sky|gray|emerald|amber|rose|teal|indigo|red|green|yellow|zinc|neutral)-[0-9]|text-(slate|blue|sky|gray|emerald|amber|rose|teal|indigo|red|green|yellow|zinc|neutral)-[0-9]|border-(slate|blue|sky|gray|emerald|amber|rose|teal|indigo|red|green|yellow|zinc|neutral)-[0-9]' apps/web/app/repair/page.tsx | wc -l
```

Expected: `0`.

- [ ] **Step 3:** Type-check:

```bash
cd apps/web && timeout 90 npx tsc --noEmit 2>&1 | tail -10
```

Expected: exit 0.

- [ ] **Step 4:** Commit:

```bash
cd /Users/sechenov/Documents/light-rental-system/.worktrees/cosmetic-polish && git add apps/web/app/repair/page.tsx && git commit -m "style(repair): tokenize urgency badges + skeleton to design canon"
```

---

## Task 5: Repaint /admin/scanner (44 violations)

**Files:**
- Modify: `apps/web/app/admin/scanner/page.tsx`

- [ ] **Step 1:** Open `apps/web/app/admin/scanner/page.tsx`. Apply the canonical mapping table. Specific patterns from the survey:

  - Lines 67-70 (status color constants): the inline mapping is best replaced with `<StatusPill>`:
    - AVAILABLE → `<StatusPill variant="ok" label="..." />`
    - ISSUED → `<StatusPill variant="warn" label="..." />`
    - MAINTENANCE → `<StatusPill variant="warn" label="..." />` (keep amber)
    - RETIRED → `<StatusPill variant="none" label="..." />`
    
    If the existing code uses class strings inside a `<span>` rather than rendering a component, refactor to `<StatusPill>` — that's the design canon for status badges.
  - Lines 112, 164, 207, 648 (skeletons / result boxes): `bg-slate-100` → `bg-surface-muted`.
  - Lines 495, 539, 580, 587, 641, 699, 717 (dark headers/buttons): `bg-slate-900 text-white` → `bg-accent text-white` (or `bg-accent-bright text-white` for primary CTAs — choose by visual role; primary = bright).
  - Lines 554-555 (mode toggle): active = `bg-accent-bright text-white`; inactive = `bg-surface border border-border text-ink-2`.

- [ ] **Step 2:** Verify zero violations:

```bash
cd /Users/sechenov/Documents/light-rental-system/.worktrees/cosmetic-polish && grep -REn 'bg-(slate|blue|sky|gray|emerald|amber|rose|teal|indigo|red|green|yellow|zinc|neutral)-[0-9]|text-(slate|blue|sky|gray|emerald|amber|rose|teal|indigo|red|green|yellow|zinc|neutral)-[0-9]|border-(slate|blue|sky|gray|emerald|amber|rose|teal|indigo|red|green|yellow|zinc|neutral)-[0-9]' apps/web/app/admin/scanner/page.tsx | wc -l
```

Expected: `0`.

- [ ] **Step 3:** Type-check:

```bash
cd apps/web && timeout 90 npx tsc --noEmit 2>&1 | tail -10
```

Expected: exit 0.

- [ ] **Step 4:** Commit:

```bash
cd /Users/sechenov/Documents/light-rental-system/.worktrees/cosmetic-polish && git add apps/web/app/admin/scanner/page.tsx && git commit -m "style(admin/scanner): tokenize colors + use StatusPill for unit status"
```

---

## Task 6: Repaint /bookings/[id]/edit (72 violations)

**Files:**
- Modify: `apps/web/app/bookings/[id]/edit/page.tsx`

Mid-sized cleanup. Apply the canonical mapping uniformly. Common patterns expected: form input borders, label text colors, scrollable card containers.

- [ ] **Step 1:** Open the file. Walk through every flagged class and apply the canonical mapping. Pay attention to:
  - Form input wrappers: `border-slate-200/300` → `border-border`; `bg-slate-50` → `bg-surface`.
  - Input focus rings: leave `focus:ring-*` and `focus:outline-*` if they already use accent tokens; if they use slate/blue numerics, switch to `focus:ring-accent-bright`.
  - Label / helper text: `text-slate-500/600/700` → `text-ink-2`; `text-slate-400` → `text-ink-3`.
  - Section dividers: `border-slate-200` → `border-border`.
  - Any inline status spans → `<StatusPill>` per the variant table.

- [ ] **Step 2:** Verify zero violations:

```bash
cd /Users/sechenov/Documents/light-rental-system/.worktrees/cosmetic-polish && grep -REn 'bg-(slate|blue|sky|gray|emerald|amber|rose|teal|indigo|red|green|yellow|zinc|neutral)-[0-9]|text-(slate|blue|sky|gray|emerald|amber|rose|teal|indigo|red|green|yellow|zinc|neutral)-[0-9]|border-(slate|blue|sky|gray|emerald|amber|rose|teal|indigo|red|green|yellow|zinc|neutral)-[0-9]' apps/web/app/bookings/\[id\]/edit/page.tsx | wc -l
```

Expected: `0`.

- [ ] **Step 3:** Type-check:

```bash
cd apps/web && timeout 90 npx tsc --noEmit 2>&1 | tail -10
```

Expected: exit 0.

- [ ] **Step 4:** Commit:

```bash
cd /Users/sechenov/Documents/light-rental-system/.worktrees/cosmetic-polish && git add 'apps/web/app/bookings/[id]/edit/page.tsx' && git commit -m "style(bookings/edit): tokenize form palette to design canon"
```

---

## Task 7: Repaint /bookings/new (162 violations)

**Files:**
- Modify: `apps/web/app/bookings/new/page.tsx`

Largest non-admin file. Two kinds of work here:

1. **Category pastel palette constants** at lines 146-156 — replace `bg-rose-50`, `bg-amber-50`, `bg-emerald-50`, `bg-teal-50`, `bg-sky-50`, `bg-blue-50`, `bg-indigo-50` with the `*-soft` tokens. For sky/blue (no exact equivalent in canon), use `bg-accent-soft`.
2. **Form-wide slate sweep** at lines 699-828 — same playbook as Task 6.

- [ ] **Step 1:** Replace the category-color map. Find the mapping object (around line 146) and rewrite. Example: if the original is:

```ts
const CATEGORY_COLORS: Record<string, string> = {
  Свет: "bg-amber-50 text-amber-700 border-amber-200",
  Камеры: "bg-rose-50 text-rose-700 border-rose-200",
  // ...
};
```

It becomes:

```ts
const CATEGORY_COLORS: Record<string, string> = {
  Свет: "bg-amber-soft text-amber border-amber-border",
  Камеры: "bg-rose-soft text-rose border-rose-border",
  // ...
};
```

(Map sky/blue keys to `bg-accent-soft text-accent border-accent-border`.)

- [ ] **Step 2:** Apply the canonical mapping to the form-input slate sweep (lines 699-828 and any other flagged lines).

- [ ] **Step 3:** Replace the availability-color map (lines 569-571) similarly: `bg-emerald-50` → `bg-emerald-soft`, etc.

- [ ] **Step 4:** Verify zero violations:

```bash
cd /Users/sechenov/Documents/light-rental-system/.worktrees/cosmetic-polish && grep -REn 'bg-(slate|blue|sky|gray|emerald|amber|rose|teal|indigo|red|green|yellow|zinc|neutral)-[0-9]|text-(slate|blue|sky|gray|emerald|amber|rose|teal|indigo|red|green|yellow|zinc|neutral)-[0-9]|border-(slate|blue|sky|gray|emerald|amber|rose|teal|indigo|red|green|yellow|zinc|neutral)-[0-9]' apps/web/app/bookings/new/page.tsx | wc -l
```

Expected: `0`.

- [ ] **Step 5:** Type-check:

```bash
cd apps/web && timeout 90 npx tsc --noEmit 2>&1 | tail -10
```

Expected: exit 0.

- [ ] **Step 6:** Commit:

```bash
cd /Users/sechenov/Documents/light-rental-system/.worktrees/cosmetic-polish && git add apps/web/app/bookings/new/page.tsx && git commit -m "style(bookings/new): tokenize category palette + form fields to design canon"
```

---

## Task 8: Repaint /admin (307 violations — the biggest)

**Files:**
- Modify: `apps/web/app/admin/page.tsx`

This is the largest single file (2974 lines, 307 violations). Work systematically — go top-to-bottom, applying the canonical mapping.

- [ ] **Step 1:** Open the file. Apply the canonical mapping uniformly. Key patterns to expect (from the survey):

  - Tab containers (lines ~164-211): `bg-slate-50` → `bg-surface`; `border-slate-200` → `border-border`.
  - Match badges: any `bg-emerald-50 text-emerald-700 border-emerald-200` style → `<StatusPill variant="ok" label="..." />`.
  - Dark CTA buttons (lines ~283-469): `bg-slate-900 text-white hover:bg-slate-700` → `bg-accent text-white hover:bg-accent-bright`. Primary action buttons go to `bg-accent-bright text-white hover:bg-accent`.
  - Modal headers (`bg-slate-800`): → `bg-accent`.
  - Table headers and rows (lines ~510-620): `bg-slate-100` → `bg-surface-muted`; `border-slate-200` → `border-border`; `text-slate-600` → `text-ink-2`; `text-slate-500` → `text-ink-2`.
  - Blue tints: `bg-blue-50/100` → `bg-accent-soft`; `text-blue-600/700` → `text-accent-bright`.
  - Amber tints (info banners): `bg-amber-50 border-amber-200 text-amber-800` → `bg-amber-soft border-amber-border text-amber`.

  Where you find a status indicator constructed inline as `<span>` with class strings, prefer replacing it with `<StatusPill variant="..." label="..." />` (import is already used in this file or the standard pattern).

- [ ] **Step 2:** Verify zero violations:

```bash
cd /Users/sechenov/Documents/light-rental-system/.worktrees/cosmetic-polish && grep -REn 'bg-(slate|blue|sky|gray|emerald|amber|rose|teal|indigo|red|green|yellow|zinc|neutral)-[0-9]|text-(slate|blue|sky|gray|emerald|amber|rose|teal|indigo|red|green|yellow|zinc|neutral)-[0-9]|border-(slate|blue|sky|gray|emerald|amber|rose|teal|indigo|red|green|yellow|zinc|neutral)-[0-9]' apps/web/app/admin/page.tsx | wc -l
```

Expected: `0`.

- [ ] **Step 3:** Type-check:

```bash
cd apps/web && timeout 90 npx tsc --noEmit 2>&1 | tail -10
```

Expected: exit 0.

- [ ] **Step 4:** Commit:

```bash
cd /Users/sechenov/Documents/light-rental-system/.worktrees/cosmetic-polish && git add apps/web/app/admin/page.tsx && git commit -m "style(admin): tokenize tabs/tables/modals/buttons to design canon"
```

---

## Task 9: Repaint /bookings/[id] residual (3 violations)

**Files:**
- Modify: `apps/web/app/bookings/[id]/page.tsx`

Only 3 leftover violations after Task 2. Likely `text-slate-500` on line 263 ("Загрузка...") and possibly a couple others — hunt them down.

- [ ] **Step 1:** Locate and replace per canonical mapping:

```bash
cd /Users/sechenov/Documents/light-rental-system/.worktrees/cosmetic-polish && grep -En 'bg-(slate|blue|sky|gray|emerald|amber|rose|teal|indigo|red|green|yellow|zinc|neutral)-[0-9]|text-(slate|blue|sky|gray|emerald|amber|rose|teal|indigo|red|green|yellow|zinc|neutral)-[0-9]|border-(slate|blue|sky|gray|emerald|amber|rose|teal|indigo|red|green|yellow|zinc|neutral)-[0-9]' 'apps/web/app/bookings/[id]/page.tsx'
```

Apply the canonical mapping. Most likely: `text-slate-500` → `text-ink-2`.

- [ ] **Step 2:** Verify zero:

```bash
cd /Users/sechenov/Documents/light-rental-system/.worktrees/cosmetic-polish && grep -REn 'bg-(slate|blue|sky|gray|emerald|amber|rose|teal|indigo|red|green|yellow|zinc|neutral)-[0-9]|text-(slate|blue|sky|gray|emerald|amber|rose|teal|indigo|red|green|yellow|zinc|neutral)-[0-9]|border-(slate|blue|sky|gray|emerald|amber|rose|teal|indigo|red|green|yellow|zinc|neutral)-[0-9]' 'apps/web/app/bookings/[id]/page.tsx' | wc -l
```

Expected: `0`.

- [ ] **Step 3:** Type-check + tests:

```bash
cd apps/web && timeout 90 npx tsc --noEmit 2>&1 | tail -10 && timeout 60 npx vitest run 2>&1 | tail -10
```

Expected: tsc exit 0, all vitest pass.

- [ ] **Step 4:** Commit:

```bash
cd /Users/sechenov/Documents/light-rental-system/.worktrees/cosmetic-polish && git add 'apps/web/app/bookings/[id]/page.tsx' && git commit -m "style(bookings/detail): mop up residual slate classes"
```

---

## Task 10: aria-label sweep on icon-only buttons

**Files:** all under `apps/web/app/` and `apps/web/src/components/` that contain icon-only buttons.

The brief: `aria-label` count today is 10 across 6 files — sparse. We focus on icon-only buttons (no visible text content) and modal close buttons.

- [ ] **Step 1:** Find candidates — buttons whose only child is an icon character (✕, ×, ☰, ⋯, →, ←, etc.) or an `<svg>`:

```bash
cd /Users/sechenov/Documents/light-rental-system/.worktrees/cosmetic-polish && grep -REn '<button[^>]*>(\s*[×✕☰⋯→←✓✔︎\?]\s*|\s*<svg)' apps/web/app apps/web/src/components 2>/dev/null | grep -v 'aria-label' | head -40
```

This produces a list. Treat each match as a candidate. For each, add `aria-label="<short Russian description of action>"`. Examples of common cases:

  - Close-modal `×` button → `aria-label="Закрыть"`.
  - Burger menu `☰` → `aria-label="Открыть меню"`.
  - Delete trash icon → `aria-label="Удалить"`.
  - Edit pencil → `aria-label="Редактировать"`.
  - Approval check ✓ → `aria-label="Одобрить"`.
  - Reject ✕ inside a row (NOT a modal close) → `aria-label="Отклонить"`.
  - Pagination arrows → `aria-label="Предыдущая страница"` / `aria-label="Следующая страница"`.

  Skip buttons that already render visible text alongside the icon (`<button>✕ Закрыть</button>`) — sighted+screen-reader users both get the label.

- [ ] **Step 2:** Specifically check known hotspots:

  - `apps/web/src/components/AppShell.tsx` — burger menu / close mobile menu.
  - `apps/web/src/components/bookings/RejectBookingModal.tsx` — modal close button (already has one if Subproject B did it; verify).
  - `apps/web/app/admin/page.tsx` — edit/delete row icon buttons.
  - `apps/web/app/equipment/manage/page.tsx` — edit/delete.
  - `apps/web/app/admin/scanner/page.tsx` — close/reset.
  - `apps/web/app/bookings/new/page.tsx` — quantity ± buttons, remove-item ✕.

  Add `aria-label` to each that lacks one.

- [ ] **Step 3:** After all additions, recount:

```bash
cd /Users/sechenov/Documents/light-rental-system/.worktrees/cosmetic-polish && grep -REc 'aria-label' apps/web/app apps/web/src/components | grep -v ':0$' | sort
```

Expected: a meaningfully larger count than the baseline 10. Document the new total in the commit message.

- [ ] **Step 4:** Type-check:

```bash
cd apps/web && timeout 90 npx tsc --noEmit 2>&1 | tail -10
```

Expected: exit 0 (aria-label is a string prop, no type concerns).

- [ ] **Step 5:** Commit:

```bash
cd /Users/sechenov/Documents/light-rental-system/.worktrees/cosmetic-polish && git add -A apps/web && git commit -m "a11y(web): aria-label on icon-only buttons across pages and components"
```

---

## Task 11: Final validation

**Files:** none (verification-only)

- [ ] **Step 1:** Confirm the 6 in-scope pages + booking detail are all clean:

```bash
cd /Users/sechenov/Documents/light-rental-system/.worktrees/cosmetic-polish && for f in apps/web/app/calendar/page.tsx apps/web/app/bookings/new/page.tsx 'apps/web/app/bookings/[id]/edit/page.tsx' 'apps/web/app/bookings/[id]/page.tsx' apps/web/app/repair/page.tsx apps/web/app/admin/page.tsx apps/web/app/admin/scanner/page.tsx; do
  count=$(grep -En 'bg-(slate|blue|sky|gray|emerald|amber|rose|teal|indigo|red|green|yellow|zinc|neutral)-[0-9]|text-(slate|blue|sky|gray|emerald|amber|rose|teal|indigo|red|green|yellow|zinc|neutral)-[0-9]|border-(slate|blue|sky|gray|emerald|amber|rose|teal|indigo|red|green|yellow|zinc|neutral)-[0-9]' "$f" | wc -l)
  echo "$count  $f"
done
```

Expected: every line shows `0`.

- [ ] **Step 2:** Type-check both apps:

```bash
cd apps/web && timeout 90 npx tsc --noEmit 2>&1 | tail -5 && cd ../api && timeout 90 npx tsc --noEmit 2>&1 | tail -5
```

Expected: both exit 0.

- [ ] **Step 3:** Full test suite:

```bash
cd /Users/sechenov/Documents/light-rental-system/.worktrees/cosmetic-polish && timeout 300 npm test 2>&1 | tail -20
```

Expected: ≥414 + 4 (new ApprovalTimeline tests) = ≥418 tests pass.

- [ ] **Step 4:** Build the web app to catch any production-only breakage:

```bash
cd apps/web && timeout 180 npx next build 2>&1 | tail -25
```

Expected: build succeeds. (Pre-existing warnings about ESLint v9 config are acceptable per Known Issues #6.)

- [ ] **Step 5:** Print git log to verify clean history:

```bash
cd /Users/sechenov/Documents/light-rental-system/.worktrees/cosmetic-polish && git log --oneline main..HEAD
```

Expected: one commit per task (≈9 commits), all with imperative-mood messages.

---

## Out of scope (deferred — flag in PR description)

These were noted during the survey but are NOT in this plan:

- `apps/web/app/crew-calculator/page.tsx` (79 violations) — not in the brief.
- `apps/web/app/equipment/manage/page.tsx` (51 violations) — not in the brief.
- `apps/web/app/equipment/[id]/units/page.tsx` (45 violations) — not in the brief, partially canonized in Sprint 5.
- `apps/web/app/warehouse/scan/page.tsx` (40 violations) — already canonized in Sprint 5; the residual count needs separate verification.
- `apps/web/app/dashboard/page.tsx` (17 violations) — not in the brief.
- `apps/web/app/equipment/page.tsx` (12 violations) — not in the brief.
- `apps/web/app/repair/[id]/page.tsx` (7 violations) — not in the brief.
- All `src/components/*` files (~50 violations across 8 components) — not in the brief.
- Inline `style={{}}` in finance/ — explicitly out of scope per Sprint 5 audit.
- Bulk approve/reject UI, notifications, mobile-redesign, loading-skeleton overhaul — flagged in Brief as out of scope.

These can be addressed in a follow-up "Cosmetic Polish — wave 2" if the user prioritizes them.

---

## Notes for the implementer

- **Don't use `replace_all`** when the same offending substring appears in legitimate non-className contexts (rare, but possible — e.g., a comment referencing a forbidden class). Always read the line first.
- **Don't introduce new utility classes** that aren't already in `tailwind.config.js`. If `bg-surface-muted` or any other token doesn't exist, fall back to the closest existing one (`bg-surface`) rather than minting a new token.
- **Visual sanity check**: after each repaint commit, mentally walk through how the page would render. If you replaced `bg-slate-900 text-white` (dark CTA) with `bg-accent-soft text-ink` (light pastel), you've broken contrast — go back and choose `bg-accent text-white` or `bg-accent-bright text-white` instead. Contrast preservation matters.
- **One commit per task**. No squashing inside the worktree — the PAR reviewers want to see the granular history.

---

## After Task 11 — handoff back to the orchestrator

When this plan completes, signal back. The orchestrator will then:

1. Dispatch standard-product-reviewer + standard-code-reviewer (split-focus, both Claude opus, in parallel, background).
2. Wait for both reviews.
3. Fix any NEEDS_FIXES / REQUEST_CHANGES findings.
4. Re-review only the flagging reviewer.
5. Write `.par-evidence.json` with both verdicts.
6. Push the branch and open the PR.
7. Wait for user "мёрдж" → Phase 3 merge protocol.

Do NOT push or open PRs from inside the implementer subagent.
