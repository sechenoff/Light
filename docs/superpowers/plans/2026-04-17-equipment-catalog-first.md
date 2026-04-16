# Equipment Catalog-First Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two-mode pill-switcher on `/bookings/new` with a unified catalog view where the full equipment catalog is visible immediately and AI parsing pre-selects items directly in the catalog.

**Architecture:** 4 new components (`SmartInput`, `CatalogList`, `CatalogRow`, `AiResultBanner`) replace 10 old ones. State in `page.tsx` migrates from `EquipmentTableItem[]` with match-discriminated-union to simpler `Map<equipmentId, ...>` + `offCatalogItems[]` + `catalog[]`. No API changes. TDD with Vitest + @testing-library/react.

**Tech Stack:** Next.js 14, React 18, TypeScript strict, Tailwind CSS 3 (IBM Plex canon), Vitest 4 + jsdom 29 + @testing-library/react 16.

**Spec:** `docs/superpowers/specs/2026-04-17-equipment-catalog-first-design.md`
**Mockup:** `docs/mockups/equipment-input-v5.html`

---

## Task 1: Create isolated git worktree

**Files:**
- No files modified. Creates a worktree for isolated development.

- [ ] **Step 1: Verify `.worktrees/` is in `.gitignore`**

Run: `git check-ignore -q .worktrees && echo IGNORED || echo NOT_IGNORED`
Expected: `IGNORED`

If `NOT_IGNORED`, add `.worktrees/` to `.gitignore`, commit, then continue.

- [ ] **Step 2: Create worktree on new branch**

Run:
```bash
cd /Users/sechenov/Documents/light-rental-system
git worktree add .worktrees/catalog-first feat/equipment-catalog-first
```
Expected: `Preparing worktree ... HEAD is now at <sha>`

- [ ] **Step 3: Verify worktree exists**

Run: `git worktree list`
Expected: output shows `.worktrees/catalog-first  <sha> [feat/equipment-catalog-first]`

All subsequent tasks run inside `.worktrees/catalog-first/`.

---

## Task 2: Add new state types to `types.ts`

**Files:**
- Modify: `apps/web/src/components/bookings/create/types.ts` (append types; do not remove anything yet)

- [ ] **Step 1: Add new types after existing ones**

Append to end of `types.ts`:

```ts
/** Catalog-first selection state (in catalog) */
export type CatalogSelectedItem = {
  equipmentId: string;
  name: string;
  category: string;
  quantity: number;
  dailyPrice: string;       // Decimal string from API
  availableQuantity: number; // latest availability from catalog fetch
};

/** Off-catalog item (AI-unmatched that user kept, or free-text add) */
export type OffCatalogItem = {
  tempId: string;  // client-generated uuid
  name: string;
  quantity: number;
};

/** Ephemeral flags for catalog rows after date change */
export type CatalogRowAdjustment =
  | { kind: "ok" }
  | { kind: "clampedDown"; previousQty: number; newQty: number }
  | { kind: "unavailable" };
```

- [ ] **Step 2: Commit**

```bash
cd apps/web && npx tsc --noEmit
cd ../..
git add apps/web/src/components/bookings/create/types.ts
git commit -m "feat(web): add catalog-first state types"
```
Expected: tsc exits 0, commit succeeds.

---

## Task 3: Create `CatalogRow` with tests

**Files:**
- Create: `apps/web/src/components/bookings/create/CatalogRow.tsx`
- Create: `apps/web/src/components/bookings/create/__tests__/CatalogRow.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/components/bookings/create/__tests__/CatalogRow.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { CatalogRow } from "../CatalogRow";
import type { AvailabilityRow } from "../types";

const row: AvailabilityRow = {
  equipmentId: "eq1",
  category: "Свет",
  name: "ARRI SkyPanel S60-C",
  brand: "ARRI",
  model: "S60-C",
  stockTrackingMode: "COUNT",
  totalQuantity: 3,
  rentalRatePerShift: "4000",
  occupiedQuantity: 0,
  availableQuantity: 3,
  availability: "AVAILABLE",
  comment: null,
};

describe("CatalogRow", () => {
  it("renders default state with '+ Добавить' button", () => {
    render(
      <CatalogRow row={row} selectedQty={0} onAdd={vi.fn()} onChangeQty={vi.fn()} onRemove={vi.fn()} />,
    );
    expect(screen.getByText("ARRI SkyPanel S60-C")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /добавить/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^−$|^-$/ })).toBeNull();
  });

  it("calls onAdd when '+ Добавить' is clicked", () => {
    const onAdd = vi.fn();
    render(<CatalogRow row={row} selectedQty={0} onAdd={onAdd} onChangeQty={vi.fn()} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /добавить/i }));
    expect(onAdd).toHaveBeenCalledWith(row);
  });

  it("renders stepper when selected (qty > 0)", () => {
    render(<CatalogRow row={row} selectedQty={2} onAdd={vi.fn()} onChangeQty={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /уменьшить/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /увеличить/i })).toBeInTheDocument();
  });

  it("plus button disabled when selectedQty === availableQuantity", () => {
    render(<CatalogRow row={row} selectedQty={3} onAdd={vi.fn()} onChangeQty={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByRole("button", { name: /увеличить/i })).toBeDisabled();
  });

  it("minus button calls onChangeQty with qty-1; onRemove when qty goes to 0", () => {
    const onChangeQty = vi.fn();
    const onRemove = vi.fn();
    const { rerender } = render(
      <CatalogRow row={row} selectedQty={2} onAdd={vi.fn()} onChangeQty={onChangeQty} onRemove={onRemove} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /уменьшить/i }));
    expect(onChangeQty).toHaveBeenCalledWith("eq1", 1);
    expect(onRemove).not.toHaveBeenCalled();

    rerender(<CatalogRow row={row} selectedQty={1} onAdd={vi.fn()} onChangeQty={onChangeQty} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole("button", { name: /уменьшить/i }));
    expect(onRemove).toHaveBeenCalledWith("eq1");
  });

  it("dims row and hides actions when availableQuantity === 0 and not selected", () => {
    const unavail = { ...row, availableQuantity: 0, availability: "UNAVAILABLE" as const };
    render(<CatalogRow row={unavail} selectedQty={0} onAdd={vi.fn()} onChangeQty={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText(/нет в наличии/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /добавить/i })).toBeNull();
  });

  it("shows amber adjustment badge when adjustment.kind === 'clampedDown'", () => {
    render(
      <CatalogRow
        row={row}
        selectedQty={2}
        adjustment={{ kind: "clampedDown", previousQty: 4, newQty: 2 }}
        onAdd={vi.fn()}
        onChangeQty={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByText(/скорректировано/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests, expect them to fail**

Run: `npm --workspace=apps/web run test -- src/components/bookings/create/__tests__/CatalogRow.test.tsx`
Expected: FAIL with `Cannot find module '../CatalogRow'`.

- [ ] **Step 3: Implement `CatalogRow.tsx`**

Create `apps/web/src/components/bookings/create/CatalogRow.tsx`:

```tsx
"use client";

import type { AvailabilityRow, CatalogRowAdjustment } from "./types";
import { formatMoneyRub } from "../../../lib/format";

type Props = {
  row: AvailabilityRow;
  selectedQty: number;
  adjustment?: CatalogRowAdjustment;
  onAdd: (row: AvailabilityRow) => void;
  onChangeQty: (equipmentId: string, newQty: number) => void;
  onRemove: (equipmentId: string) => void;
};

export function CatalogRow({ row, selectedQty, adjustment, onAdd, onChangeQty, onRemove }: Props) {
  const isSelected = selectedQty > 0;
  const isUnavailable = row.availableQuantity === 0;
  const isAtMax = selectedQty >= row.availableQuantity;
  const isClampedDown = adjustment?.kind === "clampedDown";
  const isHardUnavail = adjustment?.kind === "unavailable";

  const containerCls = isHardUnavail
    ? "border-l-[3px] border-l-rose bg-rose-soft"
    : isSelected
      ? "border-l-[3px] border-l-emerald bg-emerald-soft/40"
      : isUnavailable
        ? "opacity-40"
        : "bg-surface";

  return (
    <div
      className={`flex items-center gap-3 px-5 py-2.5 transition-colors ${containerCls} hover:bg-surface-muted`}
      data-testid={`catalog-row-${row.equipmentId}`}
    >
      <div className="min-w-0 flex-1">
        <div className={`text-[13px] font-medium ${isSelected ? "text-emerald" : "text-ink"}`}>
          {row.name}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-[11.5px] text-ink-3">
          <span className="font-mono">{formatMoneyRub(Number(row.rentalRatePerShift))} ₽/день</span>
          {isUnavailable ? (
            <span className="text-rose">нет в наличии</span>
          ) : (
            <span className={row.availableQuantity <= 1 ? "text-amber" : "text-emerald"}>
              {row.availableQuantity} доступно
            </span>
          )}
          {isClampedDown && (
            <span className="text-amber">скорректировано до {adjustment.newQty} из {adjustment.previousQty}</span>
          )}
          {isHardUnavail && <span className="text-rose">недоступно на новые даты</span>}
        </div>
      </div>

      <div className="flex-shrink-0">
        {isSelected ? (
          isHardUnavail ? (
            <button
              type="button"
              aria-label="Удалить позицию"
              onClick={() => onRemove(row.equipmentId)}
              className="rounded border border-rose-border bg-surface px-3 py-1 text-[12px] text-rose hover:bg-rose-soft"
            >
              Убрать
            </button>
          ) : (
            <div className="inline-flex items-center overflow-hidden rounded border border-emerald-border bg-surface">
              <button
                type="button"
                aria-label="Уменьшить количество"
                onClick={() =>
                  selectedQty - 1 <= 0 ? onRemove(row.equipmentId) : onChangeQty(row.equipmentId, selectedQty - 1)
                }
                className="flex h-7 w-7 items-center justify-center text-ink-2 hover:bg-emerald-soft"
              >
                −
              </button>
              <div className="flex h-7 w-8 items-center justify-center border-x border-emerald-border bg-emerald-soft/30 font-mono text-[12px] font-semibold text-emerald">
                {selectedQty}
              </div>
              <button
                type="button"
                aria-label="Увеличить количество"
                disabled={isAtMax}
                onClick={() => onChangeQty(row.equipmentId, selectedQty + 1)}
                className="flex h-7 w-7 items-center justify-center text-ink-2 hover:bg-emerald-soft disabled:cursor-not-allowed disabled:opacity-40"
              >
                +
              </button>
            </div>
          )
        ) : !isUnavailable ? (
          <button
            type="button"
            onClick={() => onAdd(row)}
            className="rounded border border-accent-border bg-surface px-3 py-1 text-[12px] font-medium text-accent-bright hover:bg-accent-soft"
          >
            + Добавить
          </button>
        ) : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests, expect them to pass**

Run: `npm --workspace=apps/web run test -- src/components/bookings/create/__tests__/CatalogRow.test.tsx`
Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/bookings/create/CatalogRow.tsx apps/web/src/components/bookings/create/__tests__/CatalogRow.test.tsx
git commit -m "feat(web): add CatalogRow component with stepper states"
```

---

## Task 4: Create `SmartInput` with tests

**Files:**
- Create: `apps/web/src/components/bookings/create/SmartInput.tsx`
- Create: `apps/web/src/components/bookings/create/__tests__/SmartInput.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/components/bookings/create/__tests__/SmartInput.test.tsx`:

```tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { SmartInput } from "../SmartInput";

describe("SmartInput", () => {
  it("shows placeholder and AI hint badge by default", () => {
    render(<SmartInput value="" onValueChange={vi.fn()} onParse={vi.fn()} parsing={false} />);
    expect(screen.getByPlaceholderText(/поиск.*список от гафера/i)).toBeInTheDocument();
    expect(screen.getByText(/AI/i)).toBeInTheDocument();
  });

  it("calls onValueChange for single-line input", () => {
    const onValueChange = vi.fn();
    render(<SmartInput value="" onValueChange={onValueChange} onParse={vi.fn()} parsing={false} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "arri" } });
    expect(onValueChange).toHaveBeenCalledWith("arri");
  });

  it("does NOT show parse button for short single-line text", () => {
    render(<SmartInput value="arri" onValueChange={vi.fn()} onParse={vi.fn()} parsing={false} />);
    expect(screen.queryByRole("button", { name: /распознать/i })).toBeNull();
  });

  it("shows parse button when text contains newline", () => {
    render(
      <SmartInput value={"2x ARRI SkyPanel\n1x Kino Flo"} onValueChange={vi.fn()} onParse={vi.fn()} parsing={false} />,
    );
    expect(screen.getByRole("button", { name: /распознать/i })).toBeInTheDocument();
  });

  it("shows parse button when text length > 40 chars", () => {
    render(<SmartInput value={"a".repeat(41)} onValueChange={vi.fn()} onParse={vi.fn()} parsing={false} />);
    expect(screen.getByRole("button", { name: /распознать/i })).toBeInTheDocument();
  });

  it("calls onParse when parse button is clicked", () => {
    const onParse = vi.fn();
    render(<SmartInput value={"a".repeat(41)} onValueChange={vi.fn()} onParse={onParse} parsing={false} />);
    fireEvent.click(screen.getByRole("button", { name: /распознать/i }));
    expect(onParse).toHaveBeenCalled();
  });

  it("disables parse button and shows 'Распознаю...' when parsing=true", () => {
    render(<SmartInput value={"a".repeat(41)} onValueChange={vi.fn()} onParse={vi.fn()} parsing={true} />);
    const btn = screen.getByRole("button", { name: /распозна/i });
    expect(btn).toBeDisabled();
    expect(btn.textContent).toMatch(/распознаю/i);
  });

  it("shows 'Очистить' button and disabled textarea after parse (parsed=true)", () => {
    const onClear = vi.fn();
    render(
      <SmartInput
        value="2x ARRI\n1x Kino"
        onValueChange={vi.fn()}
        onParse={vi.fn()}
        onClear={onClear}
        parsing={false}
        parsed={true}
      />,
    );
    expect(screen.getByRole("textbox")).toBeDisabled();
    const clearBtn = screen.getByRole("button", { name: /очистить/i });
    fireEvent.click(clearBtn);
    expect(onClear).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests, expect them to fail**

Run: `npm --workspace=apps/web run test -- src/components/bookings/create/__tests__/SmartInput.test.tsx`
Expected: FAIL with `Cannot find module '../SmartInput'`.

- [ ] **Step 3: Implement `SmartInput.tsx`**

Create `apps/web/src/components/bookings/create/SmartInput.tsx`:

```tsx
"use client";

type Props = {
  value: string;
  onValueChange: (v: string) => void;
  onParse: () => void;
  onClear?: () => void;
  parsing: boolean;
  parsed?: boolean;
};

const AI_TRIGGER_THRESHOLD = 40;

function shouldShowParseButton(v: string): boolean {
  return v.includes("\n") || v.length > AI_TRIGGER_THRESHOLD;
}

export function SmartInput({ value, onValueChange, onParse, onClear, parsing, parsed = false }: Props) {
  const showParse = shouldShowParseButton(value) && !parsed;
  const isMulti = value.includes("\n") && !parsed;

  return (
    <div className="relative">
      <textarea
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        placeholder="Поиск оборудования или вставьте список от гафера..."
        rows={isMulti ? 3 : 1}
        disabled={parsed}
        className={`w-full resize-y rounded border px-3 py-2 pr-28 text-[13px] outline-none transition-colors ${
          parsed
            ? "border-border bg-surface-muted text-ink-3"
            : "border-border bg-surface focus:border-accent-bright focus:shadow-[0_0_0_3px_rgba(29,78,216,0.08)]"
        } min-h-[40px] max-h-[140px]`}
      />

      <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1.5">
        {parsed ? (
          <button
            type="button"
            onClick={() => onClear && onClear()}
            className="rounded border border-border bg-surface px-3 py-1 text-[12px] text-ink-2 hover:bg-surface-muted"
          >
            Очистить
          </button>
        ) : showParse ? (
          <button
            type="button"
            onClick={onParse}
            disabled={parsing}
            className="rounded bg-accent-bright px-3 py-1 text-[12px] font-semibold text-white hover:bg-accent disabled:opacity-60"
          >
            {parsing ? "Распознаю..." : "Распознать"}
          </button>
        ) : (
          <div className="pointer-events-none flex items-center gap-1 rounded bg-surface-subtle px-2 py-1 text-[11px] text-ink-3">
            <span>AI</span>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests, expect them to pass**

Run: `npm --workspace=apps/web run test -- src/components/bookings/create/__tests__/SmartInput.test.tsx`
Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/bookings/create/SmartInput.tsx apps/web/src/components/bookings/create/__tests__/SmartInput.test.tsx
git commit -m "feat(web): add SmartInput with search/AI-paste auto-detection"
```

---

## Task 5: Create `AiResultBanner` with tests

**Files:**
- Create: `apps/web/src/components/bookings/create/AiResultBanner.tsx`
- Create: `apps/web/src/components/bookings/create/__tests__/AiResultBanner.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/components/bookings/create/__tests__/AiResultBanner.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { AiResultBanner } from "../AiResultBanner";

describe("AiResultBanner", () => {
  it("renders success banner with counts", () => {
    render(<AiResultBanner resolved={4} total={5} unmatched={[]} onDismissSuccess={vi.fn()} onAddOffCatalog={vi.fn()} onIgnoreUnmatched={vi.fn()} />);
    expect(screen.getByText(/распознано 4 из 5/i)).toBeInTheDocument();
  });

  it("calls onDismissSuccess when close button clicked", () => {
    const onDismiss = vi.fn();
    render(<AiResultBanner resolved={3} total={3} unmatched={[]} onDismissSuccess={onDismiss} onAddOffCatalog={vi.fn()} onIgnoreUnmatched={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /закрыть/i }));
    expect(onDismiss).toHaveBeenCalled();
  });

  it("renders unmatched list with 'Добавить вручную' action per item", () => {
    const onAddOffCatalog = vi.fn();
    render(
      <AiResultBanner
        resolved={2}
        total={3}
        unmatched={["Генератор 6кВт"]}
        onDismissSuccess={vi.fn()}
        onAddOffCatalog={onAddOffCatalog}
        onIgnoreUnmatched={vi.fn()}
      />,
    );
    expect(screen.getByText(/генератор 6квт/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /добавить вручную/i }));
    expect(onAddOffCatalog).toHaveBeenCalledWith("Генератор 6кВт");
  });

  it("renders nothing when resolved=0 and unmatched=[]", () => {
    const { container } = render(
      <AiResultBanner resolved={0} total={0} unmatched={[]} onDismissSuccess={vi.fn()} onAddOffCatalog={vi.fn()} onIgnoreUnmatched={vi.fn()} />,
    );
    expect(container.textContent).toBe("");
  });

  it("can hide success banner independently (successDismissed=true)", () => {
    render(
      <AiResultBanner
        resolved={3}
        total={4}
        unmatched={["xxx"]}
        successDismissed={true}
        onDismissSuccess={vi.fn()}
        onAddOffCatalog={vi.fn()}
        onIgnoreUnmatched={vi.fn()}
      />,
    );
    expect(screen.queryByText(/распознано/i)).toBeNull();
    expect(screen.getByText(/xxx/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests, expect them to fail**

Run: `npm --workspace=apps/web run test -- src/components/bookings/create/__tests__/AiResultBanner.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement `AiResultBanner.tsx`**

Create `apps/web/src/components/bookings/create/AiResultBanner.tsx`:

```tsx
"use client";

type Props = {
  resolved: number;
  total: number;
  unmatched: string[];
  successDismissed?: boolean;
  onDismissSuccess: () => void;
  onAddOffCatalog: (phrase: string) => void;
  onIgnoreUnmatched: () => void;
};

export function AiResultBanner({
  resolved,
  total,
  unmatched,
  successDismissed = false,
  onDismissSuccess,
  onAddOffCatalog,
  onIgnoreUnmatched,
}: Props) {
  const hasSuccess = !successDismissed && total > 0;
  const hasUnmatched = unmatched.length > 0;

  if (!hasSuccess && !hasUnmatched) return null;

  return (
    <div className="flex flex-col gap-2 px-5 pb-3 pt-0">
      {hasSuccess && (
        <div className="flex items-start gap-2.5 rounded border border-emerald-border bg-emerald-soft px-3 py-2 text-[12.5px]">
          <span className="mt-0.5 text-[14px]">✓</span>
          <div className="flex-1">
            <div className="font-semibold text-emerald">Распознано {resolved} из {total}</div>
            <div className="mt-0.5 text-[12px] text-ink-2">Проверьте количества и скорректируйте при необходимости</div>
          </div>
          <button
            type="button"
            aria-label="Закрыть"
            onClick={onDismissSuccess}
            className="text-ink-3 hover:text-ink-2"
          >
            ×
          </button>
        </div>
      )}

      {hasUnmatched && (
        <div className="rounded border border-rose-border bg-rose-soft px-3 py-2 text-[12.5px]">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-rose">Не найдено в каталоге ({unmatched.length})</span>
            <button
              type="button"
              onClick={onIgnoreUnmatched}
              className="text-[11px] text-ink-3 hover:text-ink-2"
            >
              Игнорировать
            </button>
          </div>
          <ul className="mt-1.5 flex flex-col gap-1">
            {unmatched.map((phrase) => (
              <li key={phrase} className="flex items-center justify-between text-[12px]">
                <span className="text-ink-2">«{phrase}»</span>
                <button
                  type="button"
                  onClick={() => onAddOffCatalog(phrase)}
                  className="text-[11px] font-medium text-accent-bright hover:underline"
                >
                  Добавить вручную
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests, expect them to pass**

Run: `npm --workspace=apps/web run test -- src/components/bookings/create/__tests__/AiResultBanner.test.tsx`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/bookings/create/AiResultBanner.tsx apps/web/src/components/bookings/create/__tests__/AiResultBanner.test.tsx
git commit -m "feat(web): add AiResultBanner with success + unmatched sections"
```

---

## Task 6: Create `CatalogList` with tests

**Files:**
- Create: `apps/web/src/components/bookings/create/CatalogList.tsx`
- Create: `apps/web/src/components/bookings/create/__tests__/CatalogList.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/components/bookings/create/__tests__/CatalogList.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { CatalogList } from "../CatalogList";
import type { AvailabilityRow, CatalogSelectedItem, OffCatalogItem } from "../types";

function mkRow(overrides: Partial<AvailabilityRow>): AvailabilityRow {
  return {
    equipmentId: "eq1",
    category: "Свет",
    name: "ARRI SkyPanel S60-C",
    brand: null,
    model: null,
    stockTrackingMode: "COUNT",
    totalQuantity: 3,
    rentalRatePerShift: "4000",
    occupiedQuantity: 0,
    availableQuantity: 3,
    availability: "AVAILABLE",
    comment: null,
    ...overrides,
  };
}

describe("CatalogList", () => {
  it("renders category headers and rows for all categories when activeTab='all'", () => {
    const rows: AvailabilityRow[] = [
      mkRow({ equipmentId: "a", name: "ARRI S60", category: "Свет" }),
      mkRow({ equipmentId: "b", name: "Alexa", category: "Камеры" }),
    ];
    render(
      <CatalogList
        rows={rows}
        selected={new Map()}
        offCatalogItems={[]}
        activeTab="all"
        searchQuery=""
        onAdd={vi.fn()}
        onChangeQty={vi.fn()}
        onRemove={vi.fn()}
        onChangeOffCatalogQty={vi.fn()}
        onRemoveOffCatalog={vi.fn()}
      />,
    );
    expect(screen.getByText("Свет")).toBeInTheDocument();
    expect(screen.getByText("Камеры")).toBeInTheDocument();
    expect(screen.getByText("ARRI S60")).toBeInTheDocument();
    expect(screen.getByText("Alexa")).toBeInTheDocument();
  });

  it("filters by activeTab", () => {
    const rows = [
      mkRow({ equipmentId: "a", name: "ARRI S60", category: "Свет" }),
      mkRow({ equipmentId: "b", name: "Alexa", category: "Камеры" }),
    ];
    render(
      <CatalogList
        rows={rows}
        selected={new Map()}
        offCatalogItems={[]}
        activeTab="Свет"
        searchQuery=""
        onAdd={vi.fn()}
        onChangeQty={vi.fn()}
        onRemove={vi.fn()}
        onChangeOffCatalogQty={vi.fn()}
        onRemoveOffCatalog={vi.fn()}
      />,
    );
    expect(screen.getByText("ARRI S60")).toBeInTheDocument();
    expect(screen.queryByText("Alexa")).toBeNull();
  });

  it("filters by case-insensitive search query", () => {
    const rows = [
      mkRow({ equipmentId: "a", name: "ARRI SkyPanel S60" }),
      mkRow({ equipmentId: "b", name: "Kino Flo" }),
    ];
    render(
      <CatalogList
        rows={rows}
        selected={new Map()}
        offCatalogItems={[]}
        activeTab="all"
        searchQuery="kino"
        onAdd={vi.fn()}
        onChangeQty={vi.fn()}
        onRemove={vi.fn()}
        onChangeOffCatalogQty={vi.fn()}
        onRemoveOffCatalog={vi.fn()}
      />,
    );
    expect(screen.getByText("Kino Flo")).toBeInTheDocument();
    expect(screen.queryByText("ARRI SkyPanel S60")).toBeNull();
  });

  it("shows empty state when no rows match", () => {
    render(
      <CatalogList
        rows={[mkRow({ equipmentId: "a" })]}
        selected={new Map()}
        offCatalogItems={[]}
        activeTab="all"
        searchQuery="zzzzzz"
        onAdd={vi.fn()}
        onChangeQty={vi.fn()}
        onRemove={vi.fn()}
        onChangeOffCatalogQty={vi.fn()}
        onRemoveOffCatalog={vi.fn()}
      />,
    );
    expect(screen.getByText(/ничего не найдено/i)).toBeInTheDocument();
  });

  it("renders off-catalog section when offCatalogItems present", () => {
    const off: OffCatalogItem[] = [{ tempId: "t1", name: "Генератор 6кВт", quantity: 1 }];
    render(
      <CatalogList
        rows={[mkRow({ equipmentId: "a" })]}
        selected={new Map()}
        offCatalogItems={off}
        activeTab="all"
        searchQuery=""
        onAdd={vi.fn()}
        onChangeQty={vi.fn()}
        onRemove={vi.fn()}
        onChangeOffCatalogQty={vi.fn()}
        onRemoveOffCatalog={vi.fn()}
      />,
    );
    expect(screen.getByText(/дополнительные позиции/i)).toBeInTheDocument();
    expect(screen.getByText("Генератор 6кВт")).toBeInTheDocument();
  });

  it("shows selected quantity count in category header", () => {
    const rows = [mkRow({ equipmentId: "a", name: "ARRI", category: "Свет" })];
    const selected = new Map<string, CatalogSelectedItem>();
    selected.set("a", { equipmentId: "a", name: "ARRI", category: "Свет", quantity: 2, dailyPrice: "4000", availableQuantity: 3 });
    render(
      <CatalogList
        rows={rows}
        selected={selected}
        offCatalogItems={[]}
        activeTab="all"
        searchQuery=""
        onAdd={vi.fn()}
        onChangeQty={vi.fn()}
        onRemove={vi.fn()}
        onChangeOffCatalogQty={vi.fn()}
        onRemoveOffCatalog={vi.fn()}
      />,
    );
    expect(screen.getByText(/1 выбрано/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests, expect them to fail**

Run: `npm --workspace=apps/web run test -- src/components/bookings/create/__tests__/CatalogList.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement `CatalogList.tsx`**

Create `apps/web/src/components/bookings/create/CatalogList.tsx`:

```tsx
"use client";

import { useMemo } from "react";
import { CatalogRow } from "./CatalogRow";
import type { AvailabilityRow, CatalogSelectedItem, OffCatalogItem } from "./types";

type Props = {
  rows: AvailabilityRow[];
  selected: Map<string, CatalogSelectedItem>;
  offCatalogItems: OffCatalogItem[];
  activeTab: string; // "all" or category name
  searchQuery: string;
  onAdd: (row: AvailabilityRow) => void;
  onChangeQty: (equipmentId: string, newQty: number) => void;
  onRemove: (equipmentId: string) => void;
  onChangeOffCatalogQty: (tempId: string, newQty: number) => void;
  onRemoveOffCatalog: (tempId: string) => void;
};

export function CatalogList({
  rows,
  selected,
  offCatalogItems,
  activeTab,
  searchQuery,
  onAdd,
  onChangeQty,
  onRemove,
  onChangeOffCatalogQty,
  onRemoveOffCatalog,
}: Props) {
  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return rows.filter((r) => {
      if (activeTab !== "all" && r.category !== activeTab) return false;
      if (q && !r.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, activeTab, searchQuery]);

  const grouped = useMemo(() => {
    const map = new Map<string, AvailabilityRow[]>();
    for (const r of filtered) {
      if (!map.has(r.category)) map.set(r.category, []);
      map.get(r.category)!.push(r);
    }
    return Array.from(map.entries());
  }, [filtered]);

  const selectedByCat = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of selected.values()) {
      map.set(item.category, (map.get(item.category) ?? 0) + 1);
    }
    return map;
  }, [selected]);

  const hasOff = offCatalogItems.length > 0;
  const isEmpty = filtered.length === 0 && !hasOff;

  if (isEmpty) {
    return (
      <div className="px-5 py-12 text-center text-[13px] text-ink-3">Ничего не найдено</div>
    );
  }

  return (
    <div>
      {hasOff && (
        <div>
          <div className="flex items-center justify-between border-b border-t border-border bg-surface-subtle px-5 py-1.5 font-cond text-[10px] font-semibold uppercase tracking-wider text-ink-3">
            <span>Дополнительные позиции</span>
            <span className="font-mono text-emerald">{offCatalogItems.length} вне каталога</span>
          </div>
          {offCatalogItems.map((item) => (
            <div
              key={item.tempId}
              className="flex items-center gap-3 border-l-[3px] border-l-emerald bg-emerald-soft/40 px-5 py-2.5 hover:bg-emerald-soft/60"
            >
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-emerald">{item.name}</div>
                <div className="mt-0.5 text-[11.5px] text-ink-3">вне каталога</div>
              </div>
              <div className="inline-flex items-center overflow-hidden rounded border border-emerald-border bg-surface">
                <button
                  type="button"
                  aria-label="Уменьшить количество"
                  onClick={() =>
                    item.quantity - 1 <= 0 ? onRemoveOffCatalog(item.tempId) : onChangeOffCatalogQty(item.tempId, item.quantity - 1)
                  }
                  className="flex h-7 w-7 items-center justify-center text-ink-2 hover:bg-emerald-soft"
                >
                  −
                </button>
                <div className="flex h-7 w-8 items-center justify-center border-x border-emerald-border bg-emerald-soft/30 font-mono text-[12px] font-semibold text-emerald">
                  {item.quantity}
                </div>
                <button
                  type="button"
                  aria-label="Увеличить количество"
                  onClick={() => onChangeOffCatalogQty(item.tempId, item.quantity + 1)}
                  className="flex h-7 w-7 items-center justify-center text-ink-2 hover:bg-emerald-soft"
                >
                  +
                </button>
                <button
                  type="button"
                  aria-label="Удалить позицию"
                  onClick={() => onRemoveOffCatalog(item.tempId)}
                  className="flex h-7 w-7 items-center justify-center border-l border-emerald-border text-rose hover:bg-rose-soft"
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {grouped.map(([category, catRows]) => {
        const selCount = selectedByCat.get(category) ?? 0;
        return (
          <div key={category}>
            <div className="flex items-center justify-between border-b border-t border-border bg-surface-subtle px-5 py-1.5 font-cond text-[10px] font-semibold uppercase tracking-wider text-ink-3">
              <span>{category}</span>
              {selCount > 0 && <span className="font-mono text-emerald">{selCount} выбрано</span>}
            </div>
            {catRows.map((row) => {
              const sel = selected.get(row.equipmentId);
              return (
                <CatalogRow
                  key={row.equipmentId}
                  row={row}
                  selectedQty={sel?.quantity ?? 0}
                  onAdd={onAdd}
                  onChangeQty={onChangeQty}
                  onRemove={onRemove}
                />
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run tests, expect them to pass**

Run: `npm --workspace=apps/web run test -- src/components/bookings/create/__tests__/CatalogList.test.tsx`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/bookings/create/CatalogList.tsx apps/web/src/components/bookings/create/__tests__/CatalogList.test.tsx
git commit -m "feat(web): add CatalogList with category grouping and off-catalog section"
```

---

## Task 7: Rewrite `EquipmentCard` as unified shell

**Files:**
- Modify (rewrite): `apps/web/src/components/bookings/create/EquipmentCard.tsx`

- [ ] **Step 1: Replace `EquipmentCard.tsx` content**

Overwrite `apps/web/src/components/bookings/create/EquipmentCard.tsx` with:

```tsx
"use client";

import { useMemo } from "react";
import { SmartInput } from "./SmartInput";
import { AiResultBanner } from "./AiResultBanner";
import { CatalogList } from "./CatalogList";
import type { AvailabilityRow, CatalogSelectedItem, OffCatalogItem } from "./types";
import { formatMoneyRub, pluralize } from "../../../lib/format";

type Props = {
  catalog: AvailabilityRow[];
  catalogLoading: boolean;
  selected: Map<string, CatalogSelectedItem>;
  offCatalogItems: OffCatalogItem[];

  // Smart input / AI
  gafferText: string;
  onGafferTextChange: (v: string) => void;
  parsing: boolean;
  parsed: boolean;
  parseResolved: number;
  parseTotal: number;
  unmatchedFromAi: string[];
  successBannerDismissed: boolean;
  onParse: () => void;
  onClear: () => void;
  onDismissSuccess: () => void;
  onIgnoreUnmatched: () => void;
  onAddOffCatalog: (phrase: string) => void;

  // Catalog callbacks
  onAdd: (row: AvailabilityRow) => void;
  onChangeQty: (equipmentId: string, newQty: number) => void;
  onRemove: (equipmentId: string) => void;
  onChangeOffCatalogQty: (tempId: string, newQty: number) => void;
  onRemoveOffCatalog: (tempId: string) => void;

  // Search + tab state (controlled)
  searchQuery: string;
  onSearchQueryChange: (q: string) => void;
  activeTab: string;
  onActiveTabChange: (t: string) => void;

  shifts: number;
};

export function EquipmentCard({
  catalog,
  catalogLoading,
  selected,
  offCatalogItems,
  gafferText,
  onGafferTextChange,
  parsing,
  parsed,
  parseResolved,
  parseTotal,
  unmatchedFromAi,
  successBannerDismissed,
  onParse,
  onClear,
  onDismissSuccess,
  onIgnoreUnmatched,
  onAddOffCatalog,
  onAdd,
  onChangeQty,
  onRemove,
  onChangeOffCatalogQty,
  onRemoveOffCatalog,
  searchQuery,
  onSearchQueryChange,
  activeTab,
  onActiveTabChange,
  shifts,
}: Props) {
  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const r of catalog) set.add(r.category);
    return Array.from(set);
  }, [catalog]);

  const selectedByCat = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of selected.values()) map.set(item.category, (map.get(item.category) ?? 0) + 1);
    return map;
  }, [selected]);

  const totalPositions = selected.size + offCatalogItems.length;
  const totalUnits =
    Array.from(selected.values()).reduce((acc, it) => acc + it.quantity, 0) +
    offCatalogItems.reduce((acc, it) => acc + it.quantity, 0);

  const totalPrice = useMemo(() => {
    let sum = 0;
    for (const item of selected.values()) {
      sum += Number(item.dailyPrice) * item.quantity * shifts;
    }
    return sum;
  }, [selected, shifts]);

  const isAi = gafferText.includes("\n") || gafferText.length > 40;

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-xs">
      {/* Sticky header */}
      <div className="sticky top-0 z-10 bg-surface">
        <div className="flex items-center justify-between px-5 pb-3 pt-4">
          <h2 className="text-[15px] font-semibold">Оборудование</h2>
          <div className="font-mono text-[12px] text-ink-2">
            {totalPositions} {pluralize(totalPositions, "позиция", "позиции", "позиций")} · {formatMoneyRub(totalPrice)} ₽
          </div>
        </div>

        {/* Smart input */}
        <div className="px-5 pb-2">
          <SmartInput
            value={gafferText}
            onValueChange={(v) => {
              onGafferTextChange(v);
              if (!isAi) onSearchQueryChange(v);
            }}
            onParse={onParse}
            onClear={onClear}
            parsing={parsing}
            parsed={parsed}
          />
        </div>

        {/* Tabs */}
        <div className="flex gap-0 border-b border-border px-5 pt-1">
          <TabButton label="Все" value="all" active={activeTab === "all"} onClick={() => onActiveTabChange("all")} count={null} />
          {categories.map((cat) => (
            <TabButton
              key={cat}
              label={cat}
              value={cat}
              active={activeTab === cat}
              onClick={() => onActiveTabChange(cat)}
              count={selectedByCat.get(cat) ?? null}
            />
          ))}
        </div>
      </div>

      {/* AI banner */}
      <AiResultBanner
        resolved={parseResolved}
        total={parseTotal}
        unmatched={unmatchedFromAi}
        successDismissed={successBannerDismissed}
        onDismissSuccess={onDismissSuccess}
        onAddOffCatalog={onAddOffCatalog}
        onIgnoreUnmatched={onIgnoreUnmatched}
      />

      {/* Catalog */}
      {catalogLoading ? (
        <div className="px-5 py-12 text-center text-[13px] text-ink-3">Загружаю каталог...</div>
      ) : (
        <CatalogList
          rows={catalog}
          selected={selected}
          offCatalogItems={offCatalogItems}
          activeTab={activeTab}
          searchQuery={isAi ? "" : searchQuery}
          onAdd={onAdd}
          onChangeQty={onChangeQty}
          onRemove={onRemove}
          onChangeOffCatalogQty={onChangeOffCatalogQty}
          onRemoveOffCatalog={onRemoveOffCatalog}
        />
      )}

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-border bg-surface-muted px-5 py-3">
        <div className="text-[12.5px] text-ink-2">
          {totalPositions === 0 ? (
            <span>Ничего не выбрано</span>
          ) : (
            <>
              <strong className="text-ink">{totalPositions} {pluralize(totalPositions, "позиция", "позиции", "позиций")}</strong>
              <span> · {totalUnits} {pluralize(totalUnits, "единица", "единицы", "единиц")}</span>
            </>
          )}
        </div>
        <div className="font-mono text-[14px] font-semibold">{formatMoneyRub(totalPrice)} ₽</div>
      </div>
    </div>
  );
}

function TabButton({
  label,
  value: _value,
  active,
  onClick,
  count,
}: {
  label: string;
  value: string;
  active: boolean;
  onClick: () => void;
  count: number | null;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`-mb-px whitespace-nowrap px-3.5 py-2 text-[12.5px] font-medium transition-colors ${
        active
          ? "border-b-2 border-accent-bright font-semibold text-accent-bright"
          : "border-b-2 border-transparent text-ink-3 hover:text-ink-2"
      }`}
    >
      {label}
      {count !== null && count > 0 && <span className="ml-1 font-mono text-[10px] text-emerald">{count}</span>}
    </button>
  );
}
```

- [ ] **Step 2: Typecheck**

Run:
```bash
cd apps/web && npx tsc --noEmit 2>&1 | head -50
cd ../..
```

Expected: zero errors from `EquipmentCard.tsx`. Errors from `page.tsx` are expected (fixed in Task 8).

- [ ] **Step 3: Commit (skip, will commit together with page.tsx in Task 8)**

Do NOT commit yet — app is broken until `page.tsx` is updated. Move to Task 8.

---

## Task 8: Rewrite `page.tsx` state model

**Files:**
- Modify (rewrite significant portions): `apps/web/app/bookings/new/page.tsx`

- [ ] **Step 1: Replace state + effects + handlers**

Replace the content of `/apps/web/app/bookings/new/page.tsx` starting from `function BookingNewPage()` through the end of the callbacks section, keeping `Suspense`, imports, and JSX structure intact. Full new content:

```tsx
"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

import { apiFetch } from "../../../src/lib/api";
import { formatMoneyRub, pluralize } from "../../../src/lib/format";
import { toast } from "../../../src/components/ToastProvider";
import {
  addHoursToDatetimeLocal,
  datetimeLocalToISO,
  defaultPickupDatetimeLocal,
  formatRentalDurationDetails,
  pickupFromSearchParam,
  returnFromSearchParam,
} from "../../../src/lib/rentalTime";

import { ClientProjectCard } from "../../../src/components/bookings/create/ClientProjectCard";
import { DatesCard } from "../../../src/components/bookings/create/DatesCard";
import { EquipmentCard } from "../../../src/components/bookings/create/EquipmentCard";
import { CommentCard } from "../../../src/components/bookings/create/CommentCard";
import { SummaryPanel } from "../../../src/components/bookings/create/SummaryPanel";
import type {
  AvailabilityRow,
  CatalogSelectedItem,
  OffCatalogItem,
  GafferReviewApiResponse,
  QuoteResponse,
  ValidationCheck,
} from "../../../src/components/bookings/create/types";

function BookingNewPage() {
  const router = useRouter();
  const sp = useSearchParams();

  const startParam = sp.get("start");
  const endParam = sp.get("end");

  const [clientName, setClientName] = useState("");
  const [projectName, setProjectName] = useState("");
  const [bookingComment, setBookingComment] = useState("");
  const [discountPercent, setDiscountPercent] = useState(0);

  const [pickupLocal, setPickupLocal] = useState(() =>
    pickupFromSearchParam(startParam, defaultPickupDatetimeLocal()),
  );
  const [returnLocal, setReturnLocal] = useState(() =>
    returnFromSearchParam(endParam, pickupFromSearchParam(startParam, defaultPickupDatetimeLocal())),
  );

  const pickupISO = useMemo(() => datetimeLocalToISO(pickupLocal), [pickupLocal]);
  const returnISO = useMemo(() => datetimeLocalToISO(returnLocal), [returnLocal]);

  const rentalDuration = useMemo(() => {
    if (!pickupISO || !returnISO) return null;
    const s = new Date(pickupISO);
    const e = new Date(returnISO);
    if (e.getTime() <= s.getTime()) return null;
    return formatRentalDurationDetails(s, e);
  }, [pickupISO, returnISO]);

  const shifts = rentalDuration?.shifts ?? 1;
  const durationTag = rentalDuration ? `${shifts} ${pluralize(shifts, "день", "дня", "дней")}` : null;
  const durationDetail = rentalDuration?.labelShort ?? null;

  // ── Catalog-first state ──
  const [catalog, setCatalog] = useState<AvailabilityRow[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [selected, setSelected] = useState<Map<string, CatalogSelectedItem>>(new Map());
  const [offCatalogItems, setOffCatalogItems] = useState<OffCatalogItem[]>([]);

  // Search + tabs (catalog browse)
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTab, setActiveTab] = useState<string>("all");

  // AI flow
  const [gafferText, setGafferText] = useState("");
  const [parsing, setParsing] = useState(false);
  const [parsed, setParsed] = useState(false);
  const [parseResolved, setParseResolved] = useState(0);
  const [parseTotal, setParseTotal] = useState(0);
  const [unmatchedFromAi, setUnmatchedFromAi] = useState<string[]>([]);
  const [successBannerDismissed, setSuccessBannerDismissed] = useState(false);

  // Quote
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [loadingQuote, setLoadingQuote] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // ── Catalog fetch (on dates change) ──
  useEffect(() => {
    if (!pickupISO || !returnISO) return;
    let cancelled = false;
    setCatalogLoading(true);
    const params = new URLSearchParams({ start: pickupISO, end: returnISO });
    apiFetch<{ rows: AvailabilityRow[] }>(`/api/availability?${params}`)
      .then((res) => {
        if (cancelled) return;
        setCatalog(res.rows);
        // Reconcile selected with new availability
        setSelected((prev) => {
          const next = new Map(prev);
          for (const [id, sel] of prev) {
            const latest = res.rows.find((r) => r.equipmentId === id);
            if (!latest) {
              next.delete(id);
              continue;
            }
            const clamped = Math.min(sel.quantity, Math.max(0, latest.availableQuantity));
            next.set(id, { ...sel, quantity: clamped === 0 ? sel.quantity : clamped, availableQuantity: latest.availableQuantity, dailyPrice: latest.rentalRatePerShift });
          }
          return next;
        });
      })
      .catch(() => {
        if (!cancelled) setCatalog([]);
      })
      .finally(() => {
        if (!cancelled) setCatalogLoading(false);
      });
    return () => { cancelled = true; };
  }, [pickupISO, returnISO]);

  // ── Items array for API (from selected + offCatalogItems) ──
  const apiItems = useMemo(() => {
    const cat = Array.from(selected.values()).map((s) => ({ equipmentId: s.equipmentId, quantity: s.quantity }));
    const off = offCatalogItems.map((o) => ({ name: o.name, quantity: o.quantity }));
    return [...cat, ...off];
  }, [selected, offCatalogItems]);

  const resolvedItemsForQuote = useMemo(
    () => Array.from(selected.values()).map((s) => ({ equipmentId: s.equipmentId, quantity: s.quantity })),
    [selected],
  );

  // ── Local price (preview) ──
  const localSubtotal = useMemo(() => {
    let sum = 0;
    for (const s of selected.values()) sum += Number(s.dailyPrice) * s.quantity * shifts;
    return sum;
  }, [selected, shifts]);

  const clampedDiscount = Math.max(0, Math.min(100, discountPercent || 0));
  const localDiscount = (localSubtotal * clampedDiscount) / 100;
  const localTotal = localSubtotal - localDiscount;

  // ── Validation checks ──
  const checks = useMemo<ValidationCheck[]>(() => {
    const list: ValidationCheck[] = [];
    if (selected.size > 0 && offCatalogItems.length === 0 && unmatchedFromAi.length === 0) {
      list.push({ type: "ok", label: "Все позиции распознаны", detail: "" });
    }
    if (unmatchedFromAi.length > 0) {
      list.push({ type: "warn", label: `${unmatchedFromAi.length} не распознано`, detail: "добавьте вручную или проигнорируйте" });
    }
    if (offCatalogItems.length > 0) {
      list.push({ type: "tip", label: `${offCatalogItems.length} вне каталога`, detail: "позиции сохранятся с ручным описанием" });
    }
    return list;
  }, [selected, offCatalogItems, unmatchedFromAi]);

  const canSubmit = Boolean(
    clientName.trim() && (selected.size > 0 || offCatalogItems.length > 0) && pickupISO && returnISO && !submitting,
  );

  // ── Debounced quote ──
  useEffect(() => {
    if (!clientName.trim() || resolvedItemsForQuote.length === 0 || !pickupISO || !returnISO) {
      setQuote(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoadingQuote(true);
      try {
        const body = {
          client: { name: clientName.trim() },
          projectName: projectName.trim() || "Проект",
          startDate: pickupISO,
          endDate: returnISO,
          discountPercent: discountPercent || 0,
          items: resolvedItemsForQuote,
        };
        const data = await apiFetch<QuoteResponse>("/api/bookings/quote", { method: "POST", body: JSON.stringify(body) });
        if (!cancelled) setQuote(data);
      } catch {
        if (!cancelled) setQuote(null);
      } finally {
        if (!cancelled) setLoadingQuote(false);
      }
    }, 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [clientName, projectName, pickupISO, returnISO, discountPercent, resolvedItemsForQuote]);

  // ── Handlers: dates ──
  function handlePickupChange(v: string) {
    setPickupLocal(v);
    setReturnLocal((prev) => {
      const pu = new Date(v);
      const re = new Date(prev);
      if (Number.isNaN(pu.getTime())) return prev;
      if (re.getTime() <= pu.getTime()) return addHoursToDatetimeLocal(v, 24);
      return prev;
    });
  }

  function handleReturnChange(v: string) {
    setReturnLocal(v);
  }

  // ── Handlers: catalog selection ──
  function handleAdd(row: AvailabilityRow) {
    if (row.availableQuantity <= 0) return;
    setSelected((prev) => {
      const next = new Map(prev);
      const existing = next.get(row.equipmentId);
      if (existing) {
        if (existing.quantity >= existing.availableQuantity) return prev;
        next.set(row.equipmentId, { ...existing, quantity: existing.quantity + 1 });
      } else {
        next.set(row.equipmentId, {
          equipmentId: row.equipmentId,
          name: row.name,
          category: row.category,
          quantity: 1,
          dailyPrice: row.rentalRatePerShift,
          availableQuantity: row.availableQuantity,
        });
      }
      return next;
    });
  }

  function handleChangeQty(equipmentId: string, newQty: number) {
    setSelected((prev) => {
      const next = new Map(prev);
      const existing = next.get(equipmentId);
      if (!existing) return prev;
      const clamped = Math.max(0, Math.min(newQty, existing.availableQuantity));
      if (clamped === 0) {
        next.delete(equipmentId);
      } else {
        next.set(equipmentId, { ...existing, quantity: clamped });
      }
      return next;
    });
  }

  function handleRemove(equipmentId: string) {
    setSelected((prev) => {
      const next = new Map(prev);
      next.delete(equipmentId);
      return next;
    });
  }

  function handleChangeOffCatalogQty(tempId: string, newQty: number) {
    setOffCatalogItems((prev) =>
      prev.map((it) => (it.tempId === tempId ? { ...it, quantity: Math.max(1, newQty) } : it)),
    );
  }

  function handleRemoveOffCatalog(tempId: string) {
    setOffCatalogItems((prev) => prev.filter((it) => it.tempId !== tempId));
  }

  // ── Handlers: AI ──
  async function handleParse() {
    if (!pickupISO || !returnISO) return;
    setParsing(true);
    try {
      const res = await apiFetch<GafferReviewApiResponse>("/api/bookings/parse-gaffer-review", {
        method: "POST",
        body: JSON.stringify({ requestText: gafferText.trim(), startDate: pickupISO, endDate: returnISO }),
      });

      const resolvedItems: Array<{ equipmentId: string; name: string; category: string; quantity: number; dailyPrice: string; availableQuantity: number }> = [];
      const unmatched: string[] = [];

      for (const item of res.items) {
        if (item.match.kind === "resolved") {
          resolvedItems.push({
            equipmentId: item.match.equipmentId,
            name: item.match.catalogName,
            category: item.match.category,
            quantity: item.quantity,
            dailyPrice: item.match.rentalRatePerShift,
            availableQuantity: item.match.availableQuantity,
          });
        } else if (item.match.kind === "needsReview" && item.match.candidates.length > 0) {
          const top = item.match.candidates[0];
          resolvedItems.push({
            equipmentId: top.equipmentId,
            name: top.catalogName,
            category: top.category,
            quantity: item.quantity,
            dailyPrice: top.rentalRatePerShift,
            availableQuantity: top.availableQuantity,
          });
        } else {
          unmatched.push(item.gafferPhrase || item.interpretedName);
        }
      }

      // Merge into selected (AI overwrites quantity for existing ids)
      setSelected((prev) => {
        const next = new Map(prev);
        for (const r of resolvedItems) {
          next.set(r.equipmentId, {
            equipmentId: r.equipmentId,
            name: r.name,
            category: r.category,
            quantity: Math.min(r.quantity, r.availableQuantity),
            dailyPrice: r.dailyPrice,
            availableQuantity: r.availableQuantity,
          });
        }
        return next;
      });

      setUnmatchedFromAi(unmatched);
      setParseResolved(resolvedItems.length);
      setParseTotal(res.items.length);
      setSuccessBannerDismissed(false);
      setParsed(true);
    } catch (err: any) {
      toast.error(err?.message ?? "Ошибка AI");
    } finally {
      setParsing(false);
    }
  }

  function handleClear() {
    setGafferText("");
    setParsed(false);
    setUnmatchedFromAi([]);
    setParseResolved(0);
    setParseTotal(0);
    setSuccessBannerDismissed(false);
  }

  function handleDismissSuccess() {
    setSuccessBannerDismissed(true);
  }

  function handleIgnoreUnmatched() {
    setUnmatchedFromAi([]);
  }

  function handleAddOffCatalog(phrase: string) {
    const tempId = `off-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setOffCatalogItems((prev) => [...prev, { tempId, name: phrase, quantity: 1 }]);
    setUnmatchedFromAi((prev) => prev.filter((p) => p !== phrase));
  }

  // ── Save / submit ──
  async function saveDraft(): Promise<string | null> {
    setSubmitting(true);
    try {
      const body = {
        client: { name: clientName.trim() },
        projectName: projectName.trim() || "Проект",
        startDate: pickupISO,
        endDate: returnISO,
        discountPercent: discountPercent || 0,
        comment: bookingComment.trim() || undefined,
        items: apiItems,
      };
      const res = await apiFetch<{ id: string }>("/api/bookings/draft", { method: "POST", body: JSON.stringify(body) });
      toast.success("Черновик сохранён");
      return res.id;
    } catch (err: any) {
      toast.error(err?.message ?? "Ошибка сохранения");
      return null;
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSaveDraftClick() {
    const id = await saveDraft();
    if (id) router.push(`/bookings/${id}`);
  }

  async function handleSubmitForApproval() {
    const id = await saveDraft();
    if (!id) return;
    try {
      await apiFetch(`/api/bookings/${id}/submit-for-approval`, { method: "POST" });
      toast.success("Отправлено на согласование");
      router.push(`/bookings/${id}`);
    } catch (err: any) {
      toast.error(err?.message ?? "Ошибка отправки");
    }
  }

  // ── Render ──
  return (
    <div>
      <header className="sticky top-0 z-20 flex items-center justify-between border-b border-border bg-surface px-8 py-3 shadow-xs">
        <div className="flex items-center gap-3 text-[13px]">
          <Link href="/bookings" className="text-accent-bright hover:underline">← Брони</Link>
          <span className="text-ink-3">/ Новая бронь</span>
          <span className="rounded-full border border-border bg-surface-muted px-2 py-0.5 text-[10px] text-ink-3">Черновик</span>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1280px] grid-cols-[minmax(0,1fr)_320px] items-start gap-5 px-8 py-7">
        <div className="flex flex-col gap-3.5">
          <ClientProjectCard
            clientName={clientName}
            projectName={projectName}
            onClientNameChange={setClientName}
            onProjectNameChange={setProjectName}
          />
          <DatesCard
            pickupLocal={pickupLocal}
            returnLocal={returnLocal}
            onPickupChange={handlePickupChange}
            onReturnChange={handleReturnChange}
            durationTag={durationTag}
            durationDetail={durationDetail}
          />

          <EquipmentCard
            catalog={catalog}
            catalogLoading={catalogLoading}
            selected={selected}
            offCatalogItems={offCatalogItems}
            gafferText={gafferText}
            onGafferTextChange={setGafferText}
            parsing={parsing}
            parsed={parsed}
            parseResolved={parseResolved}
            parseTotal={parseTotal}
            unmatchedFromAi={unmatchedFromAi}
            successBannerDismissed={successBannerDismissed}
            onParse={handleParse}
            onClear={handleClear}
            onDismissSuccess={handleDismissSuccess}
            onIgnoreUnmatched={handleIgnoreUnmatched}
            onAddOffCatalog={handleAddOffCatalog}
            onAdd={handleAdd}
            onChangeQty={handleChangeQty}
            onRemove={handleRemove}
            onChangeOffCatalogQty={handleChangeOffCatalogQty}
            onRemoveOffCatalog={handleRemoveOffCatalog}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            activeTab={activeTab}
            onActiveTabChange={setActiveTab}
            shifts={shifts}
          />

          <div className="flex items-center justify-between rounded-md border border-border bg-surface px-5 py-3 shadow-xs">
            <label className="text-[13px] text-ink-2">Скидка, %</label>
            <input
              type="number"
              min="0"
              max="100"
              value={discountPercent}
              onChange={(e) => setDiscountPercent(Number(e.target.value))}
              className="w-20 rounded border border-border px-2 py-1 text-right font-mono"
            />
          </div>

          <CommentCard value={bookingComment} onChange={setBookingComment} />
        </div>

        <SummaryPanel
          quote={quote}
          localSubtotal={localSubtotal}
          localDiscount={localDiscount}
          localTotal={localTotal}
          discountPercent={discountPercent}
          itemCount={selected.size + offCatalogItems.length}
          shifts={shifts}
          isLoadingQuote={loadingQuote}
          checks={checks}
          onSubmitForApproval={handleSubmitForApproval}
          onSaveDraft={handleSaveDraftClick}
          canSubmit={canSubmit}
        />
      </div>
    </div>
  );
}

export default function BookingNewPageWrapper() {
  return (
    <Suspense fallback={<div>Загрузка...</div>}>
      <BookingNewPage />
    </Suspense>
  );
}
```

- [ ] **Step 2: Typecheck**

Run:
```bash
cd apps/web && npx tsc --noEmit 2>&1 | head -30
cd ../..
```
Expected: zero errors in `page.tsx` and `EquipmentCard.tsx`. If old components (ModeSwitcher, PasteZone, etc.) still import `InputMode` / `EquipmentTableItem` from unrelated places, errors will appear — ignored for now, fixed in Task 10.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/bookings/new/page.tsx apps/web/src/components/bookings/create/EquipmentCard.tsx
git commit -m "feat(web): rewrite EquipmentCard + page.tsx state for catalog-first"
```

---

## Task 9: Add mini-list to `SummaryPanel`

**Files:**
- Modify: `apps/web/src/components/bookings/create/SummaryPanel.tsx`

- [ ] **Step 1: Extend `SummaryPanelProps` and render mini-list**

Replace the `SummaryPanelProps` type and body with:

```tsx
"use client";

import { formatMoneyRub, pluralize } from "../../../lib/format";
import type { CatalogSelectedItem, OffCatalogItem, QuoteResponse, ValidationCheck } from "./types";

type SummaryPanelProps = {
  quote: QuoteResponse | null;
  localSubtotal: number;
  localDiscount: number;
  localTotal: number;
  discountPercent: number;
  itemCount: number;
  shifts: number;
  isLoadingQuote: boolean;
  checks: ValidationCheck[];
  onSubmitForApproval: () => void;
  onSaveDraft: () => void;
  canSubmit: boolean;
  selectedItems?: Map<string, CatalogSelectedItem>;
  offCatalogItems?: OffCatalogItem[];
};

const CHECK_BADGE: Record<ValidationCheck["type"], { symbol: string; colorClass: string }> = {
  ok: { symbol: "✓", colorClass: "text-emerald" },
  warn: { symbol: "!", colorClass: "text-amber" },
  tip: { symbol: "i", colorClass: "text-accent" },
};

export function SummaryPanel({
  quote,
  localSubtotal,
  localDiscount,
  localTotal,
  discountPercent,
  itemCount,
  shifts,
  isLoadingQuote,
  checks,
  onSubmitForApproval,
  onSaveDraft,
  canSubmit,
  selectedItems,
  offCatalogItems,
}: SummaryPanelProps) {
  const subtotal = quote ? Number(quote.subtotal) : localSubtotal;
  const discount = quote ? Number(quote.discountAmount) : localDiscount;
  const total = quote ? Number(quote.totalAfterDiscount) : localTotal;
  const discPct = quote ? Number(quote.discountPercent) : discountPercent;
  const effectiveShifts = quote ? quote.shifts : shifts;

  const bigTotalFormatted = Math.round(total).toLocaleString("ru-RU");

  const miniList: Array<{ key: string; name: string; qty: number }> = [];
  if (selectedItems) for (const s of selectedItems.values()) miniList.push({ key: s.equipmentId, name: s.name, qty: s.quantity });
  if (offCatalogItems) for (const o of offCatalogItems) miniList.push({ key: o.tempId, name: o.name, qty: o.quantity });

  return (
    <aside className="sticky top-20 flex flex-col gap-4 rounded-lg border border-border bg-surface p-4 shadow-xs">
      <div className="flex items-baseline justify-between">
        <p className="eyebrow">Расчёт</p>
        <span className="text-xs text-ink-3">{isLoadingQuote ? "считаю..." : "обновлено сейчас"}</span>
      </div>

      <div>
        <div className="flex items-baseline gap-1">
          <span className="font-mono text-[32px] font-semibold leading-none text-ink">{bigTotalFormatted}</span>
          <span className="text-[18px] text-ink-3">₽</span>
        </div>
        <p className="mt-1 text-xs text-ink-3">
          {effectiveShifts} {pluralize(effectiveShifts, "день", "дня", "дней")} · {itemCount} {pluralize(itemCount, "позиция", "позиции", "позиций")}
        </p>
      </div>

      <div className="flex flex-col gap-1 text-sm">
        <div className="flex justify-between"><span className="text-ink-2">Аренда</span><span className="mono-num text-ink">{formatMoneyRub(subtotal)} ₽</span></div>
        {discPct > 0 && (
          <div className="flex justify-between"><span className="text-ink-2">Скидка {discPct}%</span><span className="mono-num text-rose">−{formatMoneyRub(discount)} ₽</span></div>
        )}
        <div className="flex justify-between border-t border-border pt-1 font-semibold"><span className="text-ink">Итого</span><span className="mono-num text-ink">{formatMoneyRub(total)} ₽</span></div>
      </div>

      {miniList.length > 0 && (
        <div className="flex flex-col gap-1 border-t border-border pt-3">
          {miniList.map((it) => (
            <div key={it.key} className="flex items-center justify-between text-[11.5px]">
              <span className="min-w-0 flex-1 truncate text-ink">{it.name}</span>
              <span className="ml-2 font-mono text-[11px] text-ink-3">×{it.qty}</span>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <button
          type="button"
          disabled={!canSubmit}
          onClick={onSubmitForApproval}
          className="w-full rounded bg-ink px-4 py-2.5 text-sm font-medium text-white hover:bg-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          Отправить на согласование →
        </button>
        <button
          type="button"
          onClick={onSaveDraft}
          className="w-full rounded border border-border bg-surface px-4 py-2.5 text-sm font-medium text-ink-2 hover:bg-surface-muted"
        >
          Сохранить черновик
        </button>
      </div>

      {checks.length > 0 && (
        <ul className="flex flex-col gap-2">
          {checks.map((check, i) => {
            const badge = CHECK_BADGE[check.type];
            return (
              <li key={i} className="flex items-start gap-2">
                <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[10px] font-bold ${badge.colorClass}`}>{badge.symbol}</span>
                <div className="min-w-0">
                  <p className="text-xs font-medium text-ink">{check.label}</p>
                  {check.detail && <p className="text-xs text-ink-3">{check.detail}</p>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
```

- [ ] **Step 2: Pass new props from `page.tsx`**

In `apps/web/app/bookings/new/page.tsx`, find the `<SummaryPanel ... />` invocation and add two props at the end:

```tsx
selectedItems={selected}
offCatalogItems={offCatalogItems}
```

- [ ] **Step 3: Typecheck and run all tests**

Run:
```bash
cd apps/web && npx tsc --noEmit && npm run test -- src/components/bookings/create
cd ../..
```
Expected: tsc exits 0, all new tests pass (26+ tests for CatalogRow, SmartInput, AiResultBanner, CatalogList).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/bookings/create/SummaryPanel.tsx apps/web/app/bookings/new/page.tsx
git commit -m "feat(web): add selected-items mini-list to SummaryPanel"
```

---

## Task 10: Delete old components + clean types

**Files:**
- Delete:
  - `apps/web/src/components/bookings/create/ModeSwitcher.tsx`
  - `apps/web/src/components/bookings/create/PasteZone.tsx`
  - `apps/web/src/components/bookings/create/ResizableContainer.tsx`
  - `apps/web/src/components/bookings/create/EquipmentTable.tsx`
  - `apps/web/src/components/bookings/create/NeedsReviewRow.tsx`
  - `apps/web/src/components/bookings/create/UnmatchedRow.tsx`
  - `apps/web/src/components/bookings/create/CatalogBrowser.tsx`
  - `apps/web/src/components/bookings/create/CategoryAccordion.tsx`
  - `apps/web/src/components/bookings/create/QuickSearchBar.tsx`
  - `apps/web/src/components/bookings/create/CatalogItemCard.tsx`
  - `apps/web/src/components/bookings/create/__tests__/NeedsReviewRow.test.tsx`
  - `apps/web/src/components/bookings/create/__tests__/UnmatchedRow.test.tsx`
- Modify: `apps/web/src/components/bookings/create/types.ts` (remove `InputMode`, `ParseResultCounts`, `EquipmentTableItem`)

- [ ] **Step 1: Delete the old component files**

Run:
```bash
cd apps/web/src/components/bookings/create
rm -f ModeSwitcher.tsx PasteZone.tsx ResizableContainer.tsx EquipmentTable.tsx NeedsReviewRow.tsx UnmatchedRow.tsx CatalogBrowser.tsx CategoryAccordion.tsx QuickSearchBar.tsx CatalogItemCard.tsx
rm -f __tests__/NeedsReviewRow.test.tsx __tests__/UnmatchedRow.test.tsx
cd -
```

- [ ] **Step 2: Remove unused types from `types.ts`**

Edit `apps/web/src/components/bookings/create/types.ts` — remove these blocks:

```ts
/** Equipment table row — unified across all 3 tiers + manual additions */
export type EquipmentTableItem = { ... };

/** Parse result counts for PasteZone indicator */
export type ParseResultCounts = { ... };

/** Equipment input mode switcher */
export type InputMode = "ai" | "catalog";
```

Keep: `GafferCandidate`, `GafferOrderedMatch`, `GafferReviewApiItem`, `GafferReviewApiResponse`, `QuoteResponse`, `AvailabilityRow`, `ValidationCheck`, `CatalogSelectedItem`, `OffCatalogItem`, `CatalogRowAdjustment`.

- [ ] **Step 3: Fix any lingering imports**

Run:
```bash
cd apps/web && npx tsc --noEmit 2>&1 | head -30
cd ../..
```

If errors appear (e.g., `InputMode` still imported somewhere), grep and remove:

```bash
grep -rn "InputMode\|EquipmentTableItem\|ParseResultCounts\|ModeSwitcher\|PasteZone\|ResizableContainer\|EquipmentTable\|NeedsReviewRow\|UnmatchedRow\|CatalogBrowser\|CategoryAccordion\|QuickSearchBar\|CatalogItemCard" apps/web/src apps/web/app
```

Expected output: no matches (only residual matches inside deleted tests/components are fine — they should be gone).

- [ ] **Step 4: Run the full web test suite**

Run:
```bash
npm --workspace=apps/web run test 2>&1 | tail -20
```
Expected: all tests pass (existing + new ones).

- [ ] **Step 5: Commit**

```bash
git add -A apps/web/src/components/bookings/create apps/web/src/components/bookings/__tests__
git commit -m "refactor(web): remove legacy two-mode equipment components"
```

---

## Task 11: Manual smoke test on dev server

**Files:**
- No file changes. Verification only.

- [ ] **Step 1: Start dev servers**

In one terminal (from worktree root):
```bash
npm run dev:no-bot
```
Expected: API on `http://localhost:4000`, web on `http://localhost:3000`.

- [ ] **Step 2: Login and navigate**

Open `http://localhost:3000/login`, login with WAREHOUSE or SUPER_ADMIN credentials.
Navigate to `/bookings/new`.

- [ ] **Step 3: Verify catalog loads**

Expected:
- Catalog appears under «Оборудование» with category headers (Свет, Камеры, Звук, и т.д.).
- Each row shows name, price/day, availability.
- No pill-switcher «AI ввод | Каталог» visible.

- [ ] **Step 4: Verify manual add flow**

- Type «arri» in Smart Input → catalog filters to rows containing «arri».
- Click «+ Добавить» on one row → row turns emerald, stepper appears, footer counter updates.
- Click «+» in stepper → qty increases. Click «−» until qty=0 → row deselects.

- [ ] **Step 5: Verify tab filter**

- Click tab «Свет» → only light items visible.
- Selected count badge appears next to tab «Свет» if items selected.
- Click tab «Все» → full catalog returns.

- [ ] **Step 6: Verify AI flow**

- Paste multi-line text in Smart Input:
  ```
  2x ARRI SkyPanel S60
  1x Kino Flo 4Bank
  3x Нечто несуществующее
  ```
- Kbd «Распознать» button appears → click it.
- Expected:
  - Success banner «Распознано 2 из 3».
  - Warning banner «Не найдено» with «Нечто несуществующее» and «Добавить вручную» link.
  - Matched rows in catalog turn emerald with proper quantities.
  - Click «Добавить вручную» → new «Дополнительные позиции» section appears at top of catalog with the phrase, qty=1, stepper + delete.
  - Smart Input disabled, «Очистить» button visible → click → input editable again, selections stay.

- [ ] **Step 7: Verify date change reconciliation**

- Select 2x of an item with availableQuantity=3.
- Change dates so new `availableQuantity` for the same item drops (e.g., to 1).
- Expected: catalog re-fetches, row still selected, qty clamped from 2 → 1 (amber hint in future iteration — MVP just clamps).

- [ ] **Step 8: Verify draft save**

- Fill client name + project.
- Click «Сохранить черновик».
- Expected: redirect to `/bookings/<id>`, booking exists with correct items.

- [ ] **Step 9: Run full build to catch any production-only errors**

Run:
```bash
npm --workspace=apps/web run build 2>&1 | tail -20
```
Expected: build succeeds without errors.

- [ ] **Step 10: Commit verification evidence**

No code to commit. Record verification in PR description.

---

## Task 12: Open PR

**Files:**
- No file changes. PR creation only.

- [ ] **Step 1: Push branch**

```bash
git push -u origin feat/equipment-catalog-first
```

- [ ] **Step 2: Create PR**

```bash
gh pr create --title "feat(web): catalog-first equipment input on /bookings/new" --body "$(cat <<'EOF'
## Summary
- Replaces two-mode pill-switcher (AI | Каталог) with a unified catalog view.
- AI parsing pre-selects items directly in the catalog instead of rendering a parallel table.
- Full catalog visible immediately — no accordions, no mode switching.
- Adds SmartInput, CatalogList, CatalogRow, AiResultBanner. Removes 10 legacy components.

## Test plan
- [x] 26+ unit tests for new components (CatalogRow, SmartInput, AiResultBanner, CatalogList).
- [x] Manual smoke test: catalog loads, manual add/remove, tab filter, AI flow, unmatched → off-catalog, date change reconciliation, draft save.
- [x] `npm run test` passes.
- [x] `tsc --noEmit` passes.
- [x] `npm run build` succeeds.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed.

---

## Self-Review Notes

### Spec coverage

| Spec section | Task |
|---|---|
| Удаление 10 компонентов | 10 |
| Создание SmartInput | 4 |
| Создание CatalogList | 6 |
| Создание CatalogRow | 3 |
| Создание AiResultBanner | 5 |
| Переписывание EquipmentCard | 7 |
| Упрощение state в page.tsx | 8 |
| Off-catalog секция | 6 (в CatalogList) |
| Загрузка каталога один раз | 8 (useEffect на dates) |
| Смена дат + reconciliation | 8 |
| AI needsReview → top-1 | 8 (handleParse) |
| Мини-список в SummaryPanel | 9 |
| Unit + integration тесты | 3, 4, 5, 6 |
| Ручная проверка | 11 |

### Placeholders
None. Every step has actual code or verifiable commands.

### Type consistency
- `CatalogSelectedItem` / `OffCatalogItem` / `CatalogRowAdjustment` — defined once in Task 2, imported consistently in Tasks 3, 6, 7, 8, 9.
- Handler names: `handleAdd`, `handleChangeQty`, `handleRemove`, `handleChangeOffCatalogQty`, `handleRemoveOffCatalog` — consistent across `page.tsx` (Task 8) and prop names in `EquipmentCard` (Task 7) and `CatalogList` (Task 6).
- `parsed: boolean` in SmartInput (Task 4) wired as prop from `EquipmentCard` (Task 7) ↔ `page.tsx` state (Task 8).

All OK.
