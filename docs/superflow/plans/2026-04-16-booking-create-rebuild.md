# /bookings/new Rebuild — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the 1,600-line booking creation monolith into 11 focused components matching the approved mockup (two-column layout, inline AI paste zone, 3-tier equipment table, sticky summary panel).

**Architecture:** Extract state management and API calls into the page shell (~200 lines). Each visual section becomes a self-contained component receiving props/callbacks. GafferReviewApiItem[] is the single source of truth for the equipment table. Quote is debounced 500ms on any change.

**Tech Stack:** React 18, Next.js 14 (app router), Tailwind CSS 3 (IBM Plex Canon tokens), TypeScript strict mode.

**Spec:** `docs/superflow/specs/2026-04-16-booking-create-rebuild-design.md`
**Mockup:** `docs/mockups/booking-create.html`
**Current monolith:** `apps/web/app/bookings/new/page.tsx` (1,600 lines)

---

## File Structure

| File | Responsibility | ~Lines |
|------|---------------|--------|
| `apps/web/src/components/bookings/create/types.ts` | Shared types: GafferReviewApiItem, QuoteResponse, EquipmentTableItem, PageState callbacks | ~60 |
| `apps/web/src/components/bookings/create/CommentCard.tsx` | "Для руководителя" textarea card | ~40 |
| `apps/web/src/components/bookings/create/ClientProjectCard.tsx` | Client text input with pill styling + project name | ~100 |
| `apps/web/src/components/bookings/create/DatesCard.tsx` | Two datetime-local inputs with arrow separator + duration hint tag | ~90 |
| `apps/web/src/components/bookings/create/PasteZone.tsx` | Dashed-border AI textarea + "Распознать позиции" button + result indicator (5 точно / 1 уточнить / 1 не найдено) | ~110 |
| `apps/web/src/components/bookings/create/NeedsReviewRow.tsx` | Expandable amber row with candidate option pills + "Пропустить" | ~90 |
| `apps/web/src/components/bookings/create/UnmatchedRow.tsx` | Expandable red row with inline catalog search box, keyboard nav, save-alias checkbox | ~130 |
| `apps/web/src/components/bookings/create/EquipmentTable.tsx` | Table shell: header + resolved/needsReview/unmatched rows with color stripes | ~180 |
| `apps/web/src/components/bookings/create/EquipmentCard.tsx` | Card wrapper: paste zone + table + footer links + legend | ~80 |
| `apps/web/src/components/bookings/create/SummaryPanel.tsx` | Sticky right panel: big total (32px mono), breakdown, action buttons, validation checks | ~160 |
| `apps/web/app/bookings/new/page.tsx` | Page shell: top bar, hero, 2-col grid, state orchestration, API calls | ~220 |

**Total: ~1,260 lines across 11 files** (down from 1,600 in one file).

---

## Task 1: Shared Types

**Files:**
- Create: `apps/web/src/components/bookings/create/types.ts`

- [ ] **Step 1: Create the types file**

```typescript
// apps/web/src/components/bookings/create/types.ts

/** Candidate match from AI parse response */
export type GafferCandidate = {
  equipmentId: string;
  catalogName: string;
  category: string;
  availableQuantity: number;
  rentalRatePerShift: string;
  confidence: number;
};

/** 3-tier match discriminated union */
export type GafferOrderedMatch =
  | {
      kind: "resolved";
      equipmentId: string;
      catalogName: string;
      category: string;
      availableQuantity: number;
      rentalRatePerShift: string;
      confidence: number;
    }
  | { kind: "needsReview"; candidates: GafferCandidate[] }
  | { kind: "unmatched" };

/** Single item from POST /api/bookings/parse-gaffer-review */
export type GafferReviewApiItem = {
  id: string;
  gafferPhrase: string;
  interpretedName: string;
  quantity: number;
  match: GafferOrderedMatch;
};

/** Response from POST /api/bookings/parse-gaffer-review */
export type GafferReviewApiResponse = {
  items: GafferReviewApiItem[];
  message?: string;
};

/** Equipment table row — unified across all 3 tiers + manual additions */
export type EquipmentTableItem = {
  id: string;
  gafferPhrase: string;
  interpretedName: string;
  quantity: number;
  /** Current match state */
  match: GafferOrderedMatch;
  /** Override price (when resolved or manually selected) */
  unitPrice: string | null;
  /** Override total (computed: qty * unitPrice * shifts) */
  lineTotal: string | null;
};

/** Response from POST /api/bookings/quote */
export type QuoteResponse = {
  shifts: number;
  totalHours?: number;
  durationLabel?: string;
  subtotal: string;
  discountPercent: string;
  discountAmount: string;
  totalAfterDiscount: string;
  lines: Array<{
    equipmentId: string;
    categorySnapshot: string;
    nameSnapshot: string;
    brandSnapshot: string | null;
    modelSnapshot: string | null;
    quantity: number;
    pricingMode: string;
    unitPrice: string;
    lineSum: string;
  }>;
};

/** Availability row from GET /api/availability */
export type AvailabilityRow = {
  equipmentId: string;
  category: string;
  name: string;
  brand: string | null;
  model: string | null;
  stockTrackingMode: "COUNT" | "UNIT";
  totalQuantity: number;
  rentalRatePerShift: string;
  occupiedQuantity: number;
  availableQuantity: number;
  availability: "UNAVAILABLE" | "PARTIAL" | "AVAILABLE";
  comment: string | null;
};

/** Validation check item shown in SummaryPanel */
export type ValidationCheck = {
  type: "ok" | "warn" | "tip";
  label: string;
  detail: string;
  actionLabel?: string;
  actionHref?: string;
};

/** Parse result counts for PasteZone indicator */
export type ParseResultCounts = {
  resolved: number;
  needsReview: number;
  unmatched: number;
};
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /Users/sechenov/Documents/light-rental-system/.worktrees/booking-create && npx tsc --noEmit --pretty 2>&1 | head -20`

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/bookings/create/types.ts
git commit -m "feat(booking-create): add shared types for booking create flow"
```

---

## Task 2: CommentCard (simplest component)

**Files:**
- Create: `apps/web/src/components/bookings/create/CommentCard.tsx`

- [ ] **Step 1: Create CommentCard component**

```tsx
// apps/web/src/components/bookings/create/CommentCard.tsx
"use client";

type CommentCardProps = {
  value: string;
  onChange: (value: string) => void;
};

export function CommentCard({ value, onChange }: CommentCardProps) {
  return (
    <div className="bg-surface border border-border rounded-md shadow-xs overflow-hidden">
      <div className="px-5 py-3 border-b border-border bg-surface-muted flex items-center justify-between">
        <h3 className="eyebrow text-ink">4. Для руководителя</h3>
        <span className="text-[11px] text-ink-3 italic">опционально</span>
      </div>
      <div className="p-5">
        <label className="flex justify-between text-[11.5px] text-ink-2 mb-1.5">
          <span>Зачем эта бронь и что важно знать</span>
        </label>
        <textarea
          className="w-full min-h-[64px] resize-y rounded border border-border-strong px-3 py-2.5 text-[13.5px] text-ink bg-surface leading-relaxed focus:outline-none focus:border-accent-bright focus:ring-[3px] focus:ring-accent-soft"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Постоянный клиент, торгуется по свету..."
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/bookings/create/CommentCard.tsx
git commit -m "feat(booking-create): add CommentCard component"
```

---

## Task 3: ClientProjectCard

**Files:**
- Create: `apps/web/src/components/bookings/create/ClientProjectCard.tsx`

- [ ] **Step 1: Create ClientProjectCard component**

```tsx
// apps/web/src/components/bookings/create/ClientProjectCard.tsx
"use client";

type ClientProjectCardProps = {
  clientName: string;
  onClientNameChange: (v: string) => void;
  projectName: string;
  onProjectNameChange: (v: string) => void;
};

export function ClientProjectCard({
  clientName,
  onClientNameChange,
  projectName,
  onProjectNameChange,
}: ClientProjectCardProps) {
  const initials = clientName
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <div className="bg-surface border border-border rounded-md shadow-xs overflow-hidden mb-3.5">
      <div className="px-5 py-3 border-b border-border bg-surface-muted">
        <h3 className="eyebrow text-ink">1. Клиент и проект</h3>
      </div>
      <div className="p-5 space-y-3">
        {/* Client field */}
        <div>
          <label className="flex justify-between text-[11.5px] text-ink-2 mb-1.5">
            <span>Клиент</span>
          </label>
          {clientName.trim() ? (
            <div className="inline-flex items-center gap-2.5 px-1.5 py-1.5 pr-2.5 bg-surface-muted border border-border rounded">
              <span className="w-6 h-6 rounded-sm bg-ink text-white text-[11px] font-semibold font-mono flex items-center justify-center">
                {initials || "?"}
              </span>
              <span className="text-[13px] text-ink font-medium">{clientName.trim()}</span>
              <button
                type="button"
                className="text-ink-3 hover:text-ink text-sm leading-none px-1"
                onClick={() => onClientNameChange("")}
                aria-label="Очистить клиента"
              >
                x
              </button>
            </div>
          ) : null}
          <input
            className={`w-full rounded border border-border-strong px-3 py-2 text-[13.5px] text-ink bg-surface focus:outline-none focus:border-accent-bright focus:ring-[3px] focus:ring-accent-soft ${clientName.trim() ? "mt-2" : ""}`}
            value={clientName}
            onChange={(e) => onClientNameChange(e.target.value)}
            placeholder="Название компании / заказчика"
          />
        </div>

        {/* Project name field */}
        <div>
          <label className="flex justify-between text-[11.5px] text-ink-2 mb-1.5">
            <span>Название проекта</span>
            <span className="text-ink-3 italic text-[11px]">опционально</span>
          </label>
          <input
            className="w-full rounded border border-border-strong px-3 py-2 text-[13.5px] text-ink bg-surface focus:outline-none focus:border-accent-bright focus:ring-[3px] focus:ring-accent-soft"
            value={projectName}
            onChange={(e) => onProjectNameChange(e.target.value)}
            placeholder="Клип «Лето» · Артист Иванов"
          />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/bookings/create/ClientProjectCard.tsx
git commit -m "feat(booking-create): add ClientProjectCard with pill styling"
```

---

## Task 4: DatesCard

**Files:**
- Create: `apps/web/src/components/bookings/create/DatesCard.tsx`

- [ ] **Step 1: Create DatesCard component**

```tsx
// apps/web/src/components/bookings/create/DatesCard.tsx
"use client";

type DatesCardProps = {
  pickupLocal: string;
  returnLocal: string;
  onPickupChange: (v: string) => void;
  onReturnChange: (v: string) => void;
  /** Pre-formatted duration hint, e.g. "3 дня" */
  durationTag: string | null;
  /** Human-readable hint, e.g. "начало в понедельник 09:00, возврат в среду 21:00" */
  durationDetail: string | null;
};

export function DatesCard({
  pickupLocal,
  returnLocal,
  onPickupChange,
  onReturnChange,
  durationTag,
  durationDetail,
}: DatesCardProps) {
  return (
    <div className="bg-surface border border-border rounded-md shadow-xs overflow-hidden mb-3.5">
      <div className="px-5 py-3 border-b border-border bg-surface-muted">
        <h3 className="eyebrow text-ink">2. Когда</h3>
      </div>
      <div className="p-5">
        {/* Two inputs with arrow separator */}
        <div className="grid grid-cols-[1fr_16px_1fr] gap-2 items-center">
          <input
            type="datetime-local"
            className="w-full rounded border border-border-strong px-3 py-2 text-[13.5px] text-ink bg-surface focus:outline-none focus:border-accent-bright focus:ring-[3px] focus:ring-accent-soft"
            value={pickupLocal}
            onChange={(e) => onPickupChange(e.target.value)}
          />
          <div className="text-center text-ink-3 font-mono text-sm">→</div>
          <input
            type="datetime-local"
            className="w-full rounded border border-border-strong px-3 py-2 text-[13.5px] text-ink bg-surface focus:outline-none focus:border-accent-bright focus:ring-[3px] focus:ring-accent-soft"
            value={returnLocal}
            onChange={(e) => onReturnChange(e.target.value)}
          />
        </div>

        {/* Duration hint row */}
        {(durationTag || durationDetail) && (
          <div className="mt-2 flex items-center gap-2.5 text-[11.5px] text-ink-2">
            {durationTag && (
              <span className="px-2 py-0.5 bg-accent-soft text-accent rounded font-mono text-[11px]">
                {durationTag}
              </span>
            )}
            {durationDetail && <span>{durationDetail}</span>}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/bookings/create/DatesCard.tsx
git commit -m "feat(booking-create): add DatesCard with arrow separator and duration hint"
```

---

## Task 5: PasteZone

**Files:**
- Create: `apps/web/src/components/bookings/create/PasteZone.tsx`

- [ ] **Step 1: Create PasteZone component**

```tsx
// apps/web/src/components/bookings/create/PasteZone.tsx
"use client";

import type { ParseResultCounts } from "./types";

type PasteZoneProps = {
  text: string;
  onTextChange: (v: string) => void;
  onParse: () => void;
  onClear: () => void;
  isParsing: boolean;
  error: string | null;
  resultCounts: ParseResultCounts | null;
};

export function PasteZone({
  text,
  onTextChange,
  onParse,
  onClear,
  isParsing,
  error,
  resultCounts,
}: PasteZoneProps) {
  return (
    <div className="mx-5 my-4">
      <div
        className="border border-dashed border-border-strong rounded bg-surface-muted p-3.5 transition-colors focus-within:border-accent-bright focus-within:bg-accent-soft/30"
      >
        {/* Header */}
        <div className="flex justify-between items-center text-[11.5px] text-ink-2 mb-1.5">
          <span className="flex items-center gap-1.5">
            <span className="w-4 h-4 rounded-sm bg-ink text-white text-[10px] font-bold font-mono flex items-center justify-center">
              AI
            </span>
            Вставьте текст от гаффера или напечатайте список
          </span>
          <kbd className="font-mono text-[10.5px] px-1.5 py-px bg-surface border border-border rounded-sm text-ink-2">
            ⌘ V
          </kbd>
        </div>

        {/* Textarea */}
        <textarea
          className="w-full border-none bg-transparent outline-none resize-none font-mono text-xs leading-relaxed text-ink min-h-[66px] p-0"
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          maxLength={10000}
          placeholder="Например: 2 штуки 52xt, 3 nova p300, 4 c-stand, 1 чайнабол, 2 рамы 6x6, hazer hz350"
        />

        {/* Actions row */}
        <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
          <button
            type="button"
            className="rounded px-3 py-1.5 text-xs font-medium bg-ink text-white hover:bg-black disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            disabled={!text.trim() || isParsing}
            onClick={onParse}
          >
            {isParsing ? "Распознаю..." : "Распознать позиции"}
          </button>
          {text.trim() && (
            <button
              type="button"
              className="rounded px-2.5 py-1.5 text-xs text-ink-2 border border-border-strong bg-surface hover:bg-surface-muted transition-colors"
              onClick={onClear}
            >
              Очистить
            </button>
          )}

          {/* Result indicator */}
          {resultCounts && (
            <span className="ml-auto text-[11.5px] text-ink-2 flex items-center gap-2.5">
              Распознано:
              <b className="text-emerald font-medium">{resultCounts.resolved} точно</b>
              {resultCounts.needsReview > 0 && (
                <>
                  <span>·</span>
                  <b className="text-amber font-medium">{resultCounts.needsReview} уточнить</b>
                </>
              )}
              {resultCounts.unmatched > 0 && (
                <>
                  <span>·</span>
                  <b className="text-rose font-medium">{resultCounts.unmatched} не найдено</b>
                </>
              )}
            </span>
          )}
        </div>
      </div>

      {/* Error display */}
      {error && (
        <div className="mt-2 rounded border border-rose-border bg-rose-soft px-3 py-2 text-sm text-rose">
          {error}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/bookings/create/PasteZone.tsx
git commit -m "feat(booking-create): add PasteZone with AI indicator and result counts"
```

---

## Task 6: NeedsReviewRow + UnmatchedRow

**Files:**
- Create: `apps/web/src/components/bookings/create/NeedsReviewRow.tsx`
- Create: `apps/web/src/components/bookings/create/UnmatchedRow.tsx`

- [ ] **Step 1: Create NeedsReviewRow**

```tsx
// apps/web/src/components/bookings/create/NeedsReviewRow.tsx
"use client";

import type { GafferCandidate } from "./types";

type NeedsReviewRowProps = {
  itemId: string;
  gafferPhrase: string;
  interpretedName: string;
  quantity: number;
  candidates: GafferCandidate[];
  selectedEquipmentId: string | null;
  onSelectCandidate: (itemId: string, candidate: GafferCandidate) => void;
  onSkip: (itemId: string) => void;
  onQuantityChange: (itemId: string, qty: number) => void;
  onDelete: (itemId: string) => void;
  shifts: number;
};

export function NeedsReviewRow({
  itemId,
  gafferPhrase,
  interpretedName,
  quantity,
  candidates,
  selectedEquipmentId,
  onSelectCandidate,
  onSkip,
  onQuantityChange,
  onDelete,
  shifts,
}: NeedsReviewRowProps) {
  const selected = candidates.find((c) => c.equipmentId === selectedEquipmentId);

  return (
    <>
      {/* Main row */}
      <div className="grid grid-cols-[6px_1fr_72px_90px_104px_24px] gap-3.5 border-b border-border text-[13px] items-center">
        <div className="self-stretch bg-amber" />
        <div className="py-2.5 pr-3">
          <div className="font-medium text-ink">{interpretedName}</div>
          <div className="text-[11.5px] text-ink-3 font-mono mt-0.5">
            «{gafferPhrase}» · {candidates.length} варианта в каталоге
          </div>
        </div>
        <div className="py-2.5 text-right">
          <input
            type="number"
            min={1}
            className="w-[60px] px-2 py-0.5 border border-border-strong rounded-sm font-mono text-[13px] text-right bg-surface focus:outline-none focus:border-accent-bright"
            value={quantity}
            onChange={(e) => onQuantityChange(itemId, Math.max(1, Number(e.target.value) || 1))}
          />
        </div>
        <div className="py-2.5 font-mono text-[12.5px] text-ink-3 text-right">
          {selected ? `${Number(selected.rentalRatePerShift).toLocaleString("ru-RU")} ₽` : "— уточнить →"}
        </div>
        <div className="py-2.5 font-mono text-[13.5px] text-right font-semibold tabular-nums">
          {selected ? `${(Number(selected.rentalRatePerShift) * quantity * shifts).toLocaleString("ru-RU")} ₽` : "—"}
        </div>
        <div
          className="py-2.5 text-ink-3 text-center cursor-pointer hover:text-rose text-sm"
          onClick={() => onDelete(itemId)}
        >
          x
        </div>
      </div>

      {/* Expansion row with candidate pills */}
      <div className="grid grid-cols-[6px_1fr] border-b border-border bg-surface-muted">
        <div className="self-stretch bg-amber" />
        <div className="px-4 py-3">
          <h4 className="text-[11.5px] text-ink-2 font-medium mb-1.5">
            Какой именно? AI нашёл несколько вариантов:
          </h4>
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {candidates.map((c) => (
              <button
                key={c.equipmentId}
                type="button"
                className={`px-2.5 py-1 text-xs rounded border cursor-pointer transition-colors ${
                  selectedEquipmentId === c.equipmentId
                    ? "border-ink bg-ink text-white"
                    : "border-border-strong bg-surface text-ink hover:border-ink"
                }`}
                onClick={() => onSelectCandidate(itemId, c)}
              >
                {c.catalogName}
                <span className={`font-mono text-[11px] ml-1 ${
                  selectedEquipmentId === c.equipmentId ? "text-white/60" : "text-ink-3"
                }`}>
                  {Number(c.rentalRatePerShift).toLocaleString("ru-RU")} ₽/день
                </span>
              </button>
            ))}
            <button
              type="button"
              className="px-2.5 py-1 text-xs rounded border border-dashed border-border-strong bg-transparent text-ink-3 hover:text-ink cursor-pointer"
              onClick={() => onSkip(itemId)}
            >
              Пропустить позицию
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 2: Create UnmatchedRow**

```tsx
// apps/web/src/components/bookings/create/UnmatchedRow.tsx
"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { AvailabilityRow } from "./types";

type UnmatchedRowProps = {
  itemId: string;
  gafferPhrase: string;
  quantity: number;
  onSelectFromCatalog: (itemId: string, equipment: AvailabilityRow, saveAlias: boolean) => void;
  onQuantityChange: (itemId: string, qty: number) => void;
  onDelete: (itemId: string) => void;
  /** Search function — queries equipment catalog */
  searchCatalog: (query: string) => Promise<AvailabilityRow[]>;
};

export function UnmatchedRow({
  itemId,
  gafferPhrase,
  quantity,
  onSelectFromCatalog,
  onQuantityChange,
  onDelete,
  searchCatalog,
}: UnmatchedRowProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [results, setResults] = useState<AvailabilityRow[]>([]);
  const [focusIdx, setFocusIdx] = useState(0);
  const [saveAlias, setSaveAlias] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounced search
  useEffect(() => {
    if (!searchQuery.trim()) {
      setResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      const data = await searchCatalog(searchQuery.trim());
      setResults(data.slice(0, 8));
      setFocusIdx(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [searchQuery, searchCatalog]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusIdx((i) => Math.min(i + 1, results.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" && results[focusIdx]) {
        e.preventDefault();
        onSelectFromCatalog(itemId, results[focusIdx], saveAlias);
      } else if (e.key === "Escape") {
        setSearchQuery("");
        setResults([]);
      }
    },
    [results, focusIdx, itemId, saveAlias, onSelectFromCatalog],
  );

  return (
    <>
      {/* Main row */}
      <div className="grid grid-cols-[6px_1fr_72px_90px_104px_24px] gap-3.5 border-b border-border text-[13px] items-center">
        <div className="self-stretch bg-rose" />
        <div className="py-2.5 pr-3">
          <div className="font-medium text-ink">«{gafferPhrase}»</div>
          <div className="text-[11.5px] text-rose mt-0.5">
            не в каталоге · найдите правильное название ниже
          </div>
        </div>
        <div className="py-2.5 text-right">
          <input
            type="number"
            min={1}
            className="w-[60px] px-2 py-0.5 border border-border-strong rounded-sm font-mono text-[13px] text-right bg-surface focus:outline-none focus:border-accent-bright"
            value={quantity}
            onChange={(e) => onQuantityChange(itemId, Math.max(1, Number(e.target.value) || 1))}
          />
        </div>
        <div className="py-2.5 font-mono text-[12.5px] text-ink-3 text-right">—</div>
        <div className="py-2.5 font-mono text-[13.5px] text-ink-3 text-right">—</div>
        <div
          className="py-2.5 text-ink-3 text-center cursor-pointer hover:text-rose text-sm"
          onClick={() => onDelete(itemId)}
        >
          x
        </div>
      </div>

      {/* Expansion row with inline search */}
      <div className="grid grid-cols-[6px_1fr] border-b border-border bg-surface-muted">
        <div className="self-stretch bg-rose" />
        <div className="px-4 py-3">
          <h4 className="text-[11.5px] text-ink-2 font-medium mb-2">
            Найдите позицию в каталоге (обычно это сленг — кладовщик знает, как правильно):
          </h4>

          <div className="border border-border-strong rounded bg-surface overflow-hidden">
            {/* Search input */}
            <div className="flex items-center px-2.5 border-b border-border">
              <span className="text-ink-3 font-mono text-xs mr-1.5">⌕</span>
              <input
                ref={inputRef}
                type="text"
                className="flex-1 border-none outline-none bg-transparent text-[13.5px] py-2.5 text-ink"
                placeholder="начните печатать: держатель, magic arm, пружинный..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                autoFocus
              />
              {searchQuery && (
                <span
                  className="text-ink-3 cursor-pointer font-mono text-[11px] px-1.5"
                  onClick={() => {
                    setSearchQuery("");
                    setResults([]);
                  }}
                >
                  esc
                </span>
              )}
            </div>

            {/* Results */}
            {results.length > 0 && (
              <div className="max-h-[200px] overflow-y-auto">
                {results.map((r, idx) => (
                  <div
                    key={r.equipmentId}
                    className={`grid grid-cols-[1fr_auto_auto] gap-3 px-3.5 py-2.5 border-b border-border/30 cursor-pointer text-[13px] items-center transition-colors ${
                      idx === focusIdx ? "bg-accent-soft shadow-[inset_2px_0_0_var(--accent)]" : "hover:bg-accent-soft/50"
                    }`}
                    onClick={() => onSelectFromCatalog(itemId, r, saveAlias)}
                    onMouseEnter={() => setFocusIdx(idx)}
                  >
                    <span className="font-medium text-ink">{r.name}</span>
                    <span className="font-mono text-[11px] text-ink-3">
                      {r.category} · {r.totalQuantity} шт в парке
                    </span>
                    <span className="font-mono text-[11.5px] text-ink-2">
                      {Number(r.rentalRatePerShift).toLocaleString("ru-RU")} ₽/день
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Footer with save-alias + keyboard hints */}
            <div className="flex justify-between items-center px-3.5 py-2 bg-surface-muted text-[11.5px] text-ink-3">
              <label className="flex items-center gap-1.5 text-ink-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={saveAlias}
                  onChange={(e) => setSaveAlias(e.target.checked)}
                  className="m-0"
                />
                Запомнить: <b className="text-ink font-medium">«{gafferPhrase}» → ...</b>
              </label>
              <div className="flex items-center gap-2.5">
                <kbd className="font-mono text-[10.5px] px-1 py-px bg-surface border border-border rounded-sm">↑↓</kbd>
                <kbd className="font-mono text-[10.5px] px-1 py-px bg-surface border border-border rounded-sm">⏎ выбрать</kbd>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/bookings/create/NeedsReviewRow.tsx apps/web/src/components/bookings/create/UnmatchedRow.tsx
git commit -m "feat(booking-create): add NeedsReviewRow and UnmatchedRow with expansion panels"
```

---

## Task 7: EquipmentTable

**Files:**
- Create: `apps/web/src/components/bookings/create/EquipmentTable.tsx`

- [ ] **Step 1: Create EquipmentTable component**

```tsx
// apps/web/src/components/bookings/create/EquipmentTable.tsx
"use client";

import { formatMoneyRub } from "../../../../lib/format";
import type { EquipmentTableItem, GafferCandidate, AvailabilityRow } from "./types";
import { NeedsReviewRow } from "./NeedsReviewRow";
import { UnmatchedRow } from "./UnmatchedRow";

type EquipmentTableProps = {
  items: EquipmentTableItem[];
  shifts: number;
  onQuantityChange: (itemId: string, qty: number) => void;
  onDelete: (itemId: string) => void;
  onSelectCandidate: (itemId: string, candidate: GafferCandidate) => void;
  onSkipItem: (itemId: string) => void;
  onSelectFromCatalog: (itemId: string, equipment: AvailabilityRow, saveAlias: boolean) => void;
  searchCatalog: (query: string) => Promise<AvailabilityRow[]>;
};

export function EquipmentTable({
  items,
  shifts,
  onQuantityChange,
  onDelete,
  onSelectCandidate,
  onSkipItem,
  onSelectFromCatalog,
  searchCatalog,
}: EquipmentTableProps) {
  if (items.length === 0) {
    return (
      <div className="mx-5 mb-5 border border-border rounded bg-surface p-8 text-center text-sm text-ink-2">
        Нет позиций. Вставьте текст от гаффера выше или добавьте вручную.
      </div>
    );
  }

  return (
    <div className="mx-5 mb-5 border border-border rounded overflow-hidden bg-surface">
      {/* Header */}
      <div className="grid grid-cols-[6px_1fr_72px_90px_104px_24px] gap-3.5 bg-surface-muted text-[10.5px] uppercase tracking-[0.1em] text-ink-3 font-semibold cond">
        <div />
        <div className="py-2">Позиция</div>
        <div className="py-2 text-right">Кол-во</div>
        <div className="py-2 text-right">Цена/день</div>
        <div className="py-2 text-right">x {shifts} {shifts === 1 ? "день" : shifts < 5 ? "дня" : "дней"}</div>
        <div />
      </div>

      {/* Rows */}
      {items.map((item) => {
        if (item.match.kind === "needsReview") {
          const selectedId =
            item.match.candidates.length > 0 && item.unitPrice
              ? item.match.candidates.find(
                  (c) => c.rentalRatePerShift === item.unitPrice,
                )?.equipmentId ?? null
              : null;

          return (
            <NeedsReviewRow
              key={item.id}
              itemId={item.id}
              gafferPhrase={item.gafferPhrase}
              interpretedName={item.interpretedName}
              quantity={item.quantity}
              candidates={item.match.candidates}
              selectedEquipmentId={selectedId}
              onSelectCandidate={onSelectCandidate}
              onSkip={onSkipItem}
              onQuantityChange={onQuantityChange}
              onDelete={onDelete}
              shifts={shifts}
            />
          );
        }

        if (item.match.kind === "unmatched") {
          return (
            <UnmatchedRow
              key={item.id}
              itemId={item.id}
              gafferPhrase={item.gafferPhrase}
              quantity={item.quantity}
              onSelectFromCatalog={onSelectFromCatalog}
              onQuantityChange={onQuantityChange}
              onDelete={onDelete}
              searchCatalog={searchCatalog}
            />
          );
        }

        // Resolved row
        const m = item.match;
        const price = Number(m.rentalRatePerShift);
        const total = price * item.quantity * shifts;

        return (
          <div
            key={item.id}
            className="grid grid-cols-[6px_1fr_72px_90px_104px_24px] gap-3.5 border-b border-border text-[13px] items-center"
          >
            <div className="self-stretch bg-emerald" />
            <div className="py-2.5 pr-3">
              <div className="font-medium text-ink">{m.catalogName}</div>
              <div className="text-[11.5px] text-ink-3 font-mono mt-0.5">
                alias: «{item.gafferPhrase}»
              </div>
            </div>
            <div className="py-2.5 text-right">
              <input
                type="number"
                min={1}
                className="w-[60px] px-2 py-0.5 border border-border-strong rounded-sm font-mono text-[13px] text-right bg-surface focus:outline-none focus:border-accent-bright"
                value={item.quantity}
                onChange={(e) =>
                  onQuantityChange(item.id, Math.max(1, Number(e.target.value) || 1))
                }
              />
            </div>
            <div className="py-2.5 font-mono text-[12.5px] text-ink-2 text-right">
              {formatMoneyRub(price)}
            </div>
            <div className="py-2.5 font-mono text-[13.5px] text-right font-semibold tabular-nums tracking-tight">
              {formatMoneyRub(total)}
            </div>
            <div
              className="py-2.5 text-ink-3 text-center cursor-pointer hover:text-rose text-sm"
              onClick={() => onDelete(item.id)}
            >
              x
            </div>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/bookings/create/EquipmentTable.tsx
git commit -m "feat(booking-create): add EquipmentTable with 3-tier color-striped rows"
```

---

## Task 8: EquipmentCard (shell)

**Files:**
- Create: `apps/web/src/components/bookings/create/EquipmentCard.tsx`

- [ ] **Step 1: Create EquipmentCard component**

```tsx
// apps/web/src/components/bookings/create/EquipmentCard.tsx
"use client";

import { formatMoneyRub } from "../../../../lib/format";
import type { EquipmentTableItem, ParseResultCounts, GafferCandidate, AvailabilityRow } from "./types";
import { PasteZone } from "./PasteZone";
import { EquipmentTable } from "./EquipmentTable";

type EquipmentCardProps = {
  items: EquipmentTableItem[];
  shifts: number;
  totalAmount: number;
  // Paste zone props
  pasteText: string;
  onPasteTextChange: (v: string) => void;
  onParse: () => void;
  onPasteClear: () => void;
  isParsing: boolean;
  parseError: string | null;
  parseResultCounts: ParseResultCounts | null;
  // Table props
  onQuantityChange: (itemId: string, qty: number) => void;
  onDeleteItem: (itemId: string) => void;
  onSelectCandidate: (itemId: string, candidate: GafferCandidate) => void;
  onSkipItem: (itemId: string) => void;
  onSelectFromCatalog: (itemId: string, equipment: AvailabilityRow, saveAlias: boolean) => void;
  searchCatalog: (query: string) => Promise<AvailabilityRow[]>;
  // Footer actions
  onAddManual: () => void;
  onOpenCatalog: () => void;
};

export function EquipmentCard({
  items,
  shifts,
  totalAmount,
  pasteText,
  onPasteTextChange,
  onParse,
  onPasteClear,
  isParsing,
  parseError,
  parseResultCounts,
  onQuantityChange,
  onDeleteItem,
  onSelectCandidate,
  onSkipItem,
  onSelectFromCatalog,
  searchCatalog,
  onAddManual,
  onOpenCatalog,
}: EquipmentCardProps) {
  return (
    <div className="bg-surface border border-border rounded-md shadow-xs overflow-hidden mb-3.5">
      {/* Header */}
      <div className="px-5 py-3 border-b border-border bg-surface-muted flex items-center justify-between">
        <h3 className="eyebrow text-ink">3. Оборудование</h3>
        <span className="text-[11.5px] text-ink-3">
          {items.length} позиций · {formatMoneyRub(totalAmount)} / период
        </span>
      </div>

      {/* Paste zone */}
      <PasteZone
        text={pasteText}
        onTextChange={onPasteTextChange}
        onParse={onParse}
        onClear={onPasteClear}
        isParsing={isParsing}
        error={parseError}
        resultCounts={parseResultCounts}
      />

      {/* Equipment table */}
      <EquipmentTable
        items={items}
        shifts={shifts}
        onQuantityChange={onQuantityChange}
        onDelete={onDeleteItem}
        onSelectCandidate={onSelectCandidate}
        onSkipItem={onSkipItem}
        onSelectFromCatalog={onSelectFromCatalog}
        searchCatalog={searchCatalog}
      />

      {/* Footer links */}
      <div className="px-5 py-2.5 flex items-center gap-3.5 border-t border-border bg-surface-muted text-[12.5px]">
        <button type="button" className="text-accent-bright hover:underline cursor-pointer bg-transparent border-none" onClick={onAddManual}>
          + Добавить позицию вручную
        </button>
        <span className="text-ink-3">·</span>
        <button type="button" className="text-accent-bright hover:underline cursor-pointer bg-transparent border-none" onClick={onOpenCatalog}>
          Открыть каталог
        </button>
      </div>

      {/* Legend */}
      <div className="px-5 py-2.5 bg-surface-muted border-t border-border flex gap-5 text-[11px] text-ink-2 cond uppercase tracking-[0.06em]">
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-sm bg-emerald" />
          Точно
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-sm bg-amber" />
          Уточнить
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-sm bg-rose" />
          Не в каталоге
        </span>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/bookings/create/EquipmentCard.tsx
git commit -m "feat(booking-create): add EquipmentCard shell with paste zone, table, and legend"
```

---

## Task 9: SummaryPanel

**Files:**
- Create: `apps/web/src/components/bookings/create/SummaryPanel.tsx`

- [ ] **Step 1: Create SummaryPanel component**

```tsx
// apps/web/src/components/bookings/create/SummaryPanel.tsx
"use client";

import { formatMoneyRub } from "../../../../lib/format";
import type { QuoteResponse, ValidationCheck } from "./types";

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
}: SummaryPanelProps) {
  const total = quote ? Number(quote.totalAfterDiscount) : localTotal;
  const subtotal = quote ? Number(quote.subtotal) : localSubtotal;
  const discount = quote ? Number(quote.discountAmount) : localDiscount;
  const daysWord = shifts === 1 ? "день" : shifts < 5 ? "дня" : "дней";

  // Format big number with spaces
  const formatBig = (n: number) =>
    Math.round(n).toLocaleString("ru-RU");

  return (
    <aside className="sticky top-20 bg-surface border border-border rounded-md shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-4.5 py-3 bg-surface-muted border-b border-border flex items-center justify-between">
        <h3 className="eyebrow">Расчёт</h3>
        <span className="text-[11px] text-ink-3 font-mono">
          {isLoadingQuote ? "считаю..." : "обновлено сейчас"}
        </span>
      </div>

      {/* Big total */}
      <div className="px-4.5 py-5 border-b border-border">
        <span className="eyebrow block mb-1">К оплате</span>
        <div className="text-[32px] leading-tight font-mono font-medium tracking-tight text-ink">
          {formatBig(total)}
          <span className="text-lg text-ink-3 font-normal ml-0.5"> ₽</span>
        </div>
        <div className="text-[11.5px] text-ink-2 mt-1">
          за {shifts} {daysWord} · {itemCount} позиций
        </div>
      </div>

      {/* Breakdown */}
      <div className="px-4.5 py-3.5 text-[12.5px] border-b border-border">
        <div className="flex justify-between py-1 text-ink-2">
          <span>Аренда ({itemCount} позиций)</span>
          <span className="font-mono text-ink">{formatMoneyRub(subtotal)}</span>
        </div>
        {discount > 0 && (
          <div className="flex justify-between py-1 text-ink-2">
            <span>Скидка{discountPercent ? ` ${discountPercent}%` : ""}</span>
            <span className="font-mono text-rose">-{formatMoneyRub(discount)}</span>
          </div>
        )}
        <div className="flex justify-between py-2 mt-1.5 border-t border-border text-ink font-semibold">
          <span>Итого</span>
          <span className="font-mono text-sm">{formatMoneyRub(total)}</span>
        </div>
      </div>

      {/* Action buttons */}
      <div className="px-4.5 py-3.5 flex flex-col gap-1.5 border-b border-border">
        <button
          type="button"
          className="w-full rounded px-3.5 py-2.5 text-[13px] font-medium text-center bg-ink text-white border border-ink hover:bg-black transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={onSubmitForApproval}
          disabled={!canSubmit}
        >
          Отправить на согласование →
        </button>
        <button
          type="button"
          className="w-full rounded px-3.5 py-2.5 text-[13px] font-medium text-center bg-surface text-ink border border-border-strong hover:bg-surface-muted transition-colors"
          onClick={onSaveDraft}
        >
          Сохранить черновик
        </button>
      </div>

      {/* Validation checks */}
      {checks.length > 0 && (
        <div className="px-4.5 py-3.5 text-xs text-ink-2 leading-relaxed space-y-0.5">
          {checks.map((ch, i) => (
            <div key={i} className="flex gap-2 items-start py-0.5">
              <span
                className={`w-3.5 h-3.5 rounded-sm flex items-center justify-center text-[10px] font-bold font-mono shrink-0 mt-0.5 ${
                  ch.type === "ok"
                    ? "bg-emerald-soft text-emerald"
                    : ch.type === "warn"
                      ? "bg-amber-soft text-amber"
                      : "bg-accent-soft text-accent"
                }`}
              >
                {ch.type === "ok" ? "✓" : ch.type === "warn" ? "!" : "i"}
              </span>
              <span>
                <b className="text-ink font-medium">{ch.label}</b>
                {ch.detail ? ` — ${ch.detail}` : ""}
                {ch.actionLabel && ch.actionHref && (
                  <a href={ch.actionHref} className="text-accent-bright ml-1">
                    {ch.actionLabel}
                  </a>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/bookings/create/SummaryPanel.tsx
git commit -m "feat(booking-create): add SummaryPanel with big total, breakdown, checks"
```

---

## Task 10: Page Shell — Orchestrator

**Files:**
- Modify: `apps/web/app/bookings/new/page.tsx` (complete rewrite)

This is the largest task. The page shell orchestrates all state, API calls, and wires child components together.

- [ ] **Step 1: Rewrite page.tsx**

The new page.tsx should:
1. Keep all existing state variables (client, dates, items, quote, gaffer text)
2. Convert `selected` (Record<string,number>) + `rows` (AvailabilityRow[]) pattern into `EquipmentTableItem[]` as single source of truth
3. Keep existing API calls (parseGafferRequest, quote debounce, confirmBooking → now saveDraft + submitForApproval)
4. Keep existing utility imports (rentalTime helpers)
5. Render the 2-column layout with all child components
6. Add top bar with breadcrumbs + status chip + action buttons

Key structural changes:
- Replace `confirmBooking` (draft+confirm in one step) with `saveDraft` (just draft) and `submitForApproval` (draft then submit)
- Replace availability table browse+select UI with AI-first equipment flow
- Replace gaffer modal with inline PasteZone
- Equipment state changes from `selected: Record<string,number>` to `items: EquipmentTableItem[]`
- Keep backward compatibility: `onAddManual` opens catalog search to add items as resolved entries
- Keep export quote functionality (PDF/XLSX/XML) in a dropdown or summary panel

The file is too large to include inline — the implementing subagent should:
1. Read the current `page.tsx` in full
2. Read all new child components created in Tasks 1-9
3. Build the new shell preserving all existing API integration logic
4. Test by running `npm run dev -w apps/web` and navigating to `/bookings/new`

**Key state shape change:**

```typescript
// OLD: flat availability table + selection map
const [rows, setRows] = useState<AvailabilityRow[]>([]);
const [selected, setSelected] = useState<Record<string, number>>({});

// NEW: 3-tier item list as single source of truth
const [items, setItems] = useState<EquipmentTableItem[]>([]);
```

**Key layout:**

```tsx
return (
  <>
    {/* Top bar */}
    <div className="flex justify-between items-center px-8 py-3 bg-surface border-b border-border sticky top-0 z-10">
      <div className="flex items-center gap-2.5 text-[13px]">
        <Link href="/bookings" className="text-ink-2 hover:text-ink flex items-center gap-1">← Брони</Link>
        <span className="text-ink-3">/</span>
        <span className="text-ink font-medium">Новая бронь</span>
        <span className="font-mono text-[11.5px] text-ink-3 px-2 py-0.5 bg-surface-muted border border-border rounded ml-1">#—</span>
        <span className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-2 px-2.5 py-0.5 bg-surface-muted border border-border rounded-full ml-2">
          <span className="w-1.5 h-1.5 rounded-full bg-ink-3" />
          Черновик
        </span>
      </div>
      <div className="flex gap-1.5">
        <Link href="/bookings" className="rounded px-3.5 py-1.5 text-xs font-medium text-ink-2 hover:bg-surface-muted">Отмена</Link>
        <button className="rounded px-3.5 py-1.5 text-xs font-medium border border-border-strong bg-surface hover:bg-surface-muted" onClick={saveDraft}>Сохранить черновик</button>
        <button className="rounded px-3.5 py-1.5 text-xs font-medium bg-ink text-white hover:bg-black" onClick={submitForApproval}>Отправить на согласование →</button>
      </div>
    </div>

    {/* Page content */}
    <div className="max-w-[1280px] mx-auto px-8 py-7">
      {/* Hero */}
      <div className="flex justify-between items-end mb-6 gap-8">
        <div>
          <h1 className="text-[28px] font-semibold tracking-tight leading-tight">Новая бронь</h1>
          <p className="text-[13.5px] text-ink-2 max-w-[560px] mt-1">
            Клиент, даты, список оборудования. Можно вставить текст от гаффера — AI распознает позиции и подтянет цены.
          </p>
        </div>
      </div>

      {/* 2-column grid */}
      <div className="grid grid-cols-[minmax(0,1fr)_320px] gap-5 items-start">
        <div>
          <ClientProjectCard ... />
          <DatesCard ... />
          <EquipmentCard ... />
          <CommentCard ... />
        </div>
        <SummaryPanel ... />
      </div>
    </div>
  </>
);
```

- [ ] **Step 2: Run dev server and verify the page loads**

Run: `cd /Users/sechenov/Documents/light-rental-system/.worktrees/booking-create && timeout 30 npx next dev --port 3001 2>&1 | head -30`

Check for compilation errors. Kill server after verification.

- [ ] **Step 3: Test parse flow — verify AI paste zone works end-to-end**

1. Open `http://localhost:3001/bookings/new`
2. Enter client name
3. Paste gaffer text in paste zone
4. Click "Распознать позиции"
5. Verify 3-tier results appear in table with correct color stripes

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/bookings/new/page.tsx
git commit -m "feat(booking-create): rewrite page shell with 2-col layout and component composition"
```

---

## Task 11: Integration Verification & Cleanup

- [ ] **Step 1: Verify TypeScript compiles**

Run: `cd /Users/sechenov/Documents/light-rental-system/.worktrees/booking-create && npx tsc --noEmit --pretty 2>&1 | tail -20`
Expected: No errors

- [ ] **Step 2: Verify existing tests still pass**

Run: `cd /Users/sechenov/Documents/light-rental-system/.worktrees/booking-create && timeout 120 npm test 2>&1 | tail -20`
Expected: All tests pass (none should be affected — this is frontend-only)

- [ ] **Step 3: Verify build succeeds**

Run: `cd /Users/sechenov/Documents/light-rental-system/.worktrees/booking-create && timeout 120 npm run build 2>&1 | tail -30`
Expected: Build succeeds

- [ ] **Step 4: Remove old monolith artifacts (if any dead imports remain)**

Check for unused imports in the new page.tsx. Remove any leftover code from the old implementation that's no longer needed.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "chore(booking-create): cleanup dead code and verify build"
```

---

## Sprint Summary

After completing all 11 tasks:
- **11 files** created/modified
- **~1,260 lines** across focused components (down from 1,600 in one file)
- Layout matches mockup: 2-column grid, sticky summary, top bar with breadcrumbs
- AI paste zone is inline (no modal)
- Equipment table shows 3-tier results with color stripes (green/amber/red)
- NeedsReview rows have candidate option pills
- Unmatched rows have inline catalog search with keyboard navigation
- Summary panel has big total (32px mono), breakdown, action buttons, validation checks
- All existing API integrations preserved (parse-gaffer-review, quote, draft, availability)
