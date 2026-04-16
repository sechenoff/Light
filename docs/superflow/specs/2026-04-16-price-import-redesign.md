# Импорт цен — Redesign Spec

> **Reference mockups:** `.superpowers/brainstorm/5593-1776332984/content/review-ui.html`, `competitor-ui.html`
> **Goal:** Redesign price import: AI-powered file analysis, hybrid matching pipeline (deterministic + LLM), human-readable card-based review UI, competitor price comparison with SlangAlias integration.
> **Scope:** Frontend rewrite + 1 new service + 2 new API endpoints + 3 Prisma field additions. Existing import endpoints reused.

## Current State

`apps/web/app/admin/imports/page.tsx` — 500-line wizard with 4 steps (upload → column mapping → table review → apply). Working but non-native: manual column mapping is technical, review is a raw table with accept/reject toggles, no AI explanations, SlangAlias not integrated into matching chain.

Backend: `importSession.ts` (986 lines) handles 4-tier matching (exact importKey → CompetitorAlias → fuzzy Dice ≥0.7 → Gemini AI). `competitorMatcher.ts` calls Gemini 2.5 Flash Lite for unmatched items.

## Target State

### Two Modes

**Mode 1: Обновление своего каталога** — user uploads arbitrary Excel from supplier (different column names, different structure). AI analyzes file structure, matches items to catalog, determines change types, presents grouped cards with human-readable descriptions. User confirms/rejects/corrects per card or per group. Corrections saved to aliases.

**Mode 2: Сравнение с конкурентом** — user uploads competitor pricelist + selects competitor name. AI matches items using enhanced chain (SlangAlias → CompetitorAlias → exact → fuzzy → Gemini). Read-only comparison table: our price vs competitor, delta in % and ₽, filter by cheaper/expensive/parity. No pricing recommendations — user decides. Unmatched items can be manually bound. Corrections saved to CompetitorAlias + SlangAlias.

### Hybrid Pipeline (both modes)

```
Upload file
  ↓
Step 1: AI analyzes file structure
  → sends headers + 3-5 sample rows to LLM
  → returns JSON column mapping (name, price, qty, category)
  ↓
Step 2: Deterministic matching chain
  1. SlangAlias (normalized phrase → equipmentId)
  2. CompetitorAlias (competitorName + item → equipmentId)
  3. Exact importKey (category+name+brand+model)
  4. Fuzzy (Dice coefficient ≥ 0.7)
  ↓
Step 3: AI matching for remaining unmatched
  → batch unmatched items to Gemini
  → returns equipmentId + confidence
  ↓
Step 4: Diff computation
  → compare matched items to catalog (price, qty, existence)
  → classify: PRICE_CHANGE, QTY_CHANGE, NEW_ITEM, REMOVED_ITEM, NO_CHANGE
  ↓
Step 5: AI generates descriptions
  → grouped changes sent to LLM
  → returns human-readable card text + overall summary
  ↓
Step 6: Review UI
  → cards grouped by change type (own catalog)
  → comparison table with filters (competitor)
  ↓
Step 7: Apply (own catalog only)
  → accepted changes written to Equipment table
  → corrections saved to aliases
```

### Entry Point

Separate page at `/admin/imports`. Two buttons on start:
- **«Обновить каталог»** → own catalog flow
- **«Сравнить с конкурентом»** → competitor flow

**Session history** below — list of past imports with date, type, status, change counts. Click opens past result in read-only.

Current PricesTab in `/admin` replaced with Link card to `/admin/imports`.

## UI: Own Catalog Review

Reference mockup: `review-ui.html`

### Layout (top to bottom)

1. **Page header** — title «Импорт цен — Свой каталог», filename, item count, upload date.

2. **AI summary** — text block: «Файл содержит 47 позиций. Обнаружено 12 ценовых изменений (средний рост +18%), 3 новых позиции из категории LED-панели, 2 изменения количества. 30 позиций без изменений.»

3. **Summary chips** — clickable counters by change type: 💰 Цена (12), ✨ Новые (3), 📦 Количество (2), 🗑 Удалённые (0), Без изменений (30).

4. **Action bar** — counters (принято/отклонено/ожидает) + bulk buttons: «Принять все», «Отклонить все», «Экспорт XLSX».

5. **Change groups** — collapsible sections per change type:
   - Group header: icon + title + count badge + group-level accept/reject buttons.
   - Cards inside: each card shows:
     - Equipment name (mono font)
     - Price delta chip: `1 500₽ → 2 000₽ (+33%)` — amber for increase, blue for decrease
     - Match method indicator: green dot = exact, blue = slang, amber = fuzzy, purple = AI
     - AI-generated description: «Цена аренды за смену выросла на 500₽»
     - Action buttons: ✓ accept, ✕ reject, ✎ rebind (opens search modal)
   - Accepted cards: green background. Rejected: red, dimmed.
   - Anomaly detection: price changes >100% auto-flagged, auto-rejected with warning text.

6. **Footer bar** — accepted/total counters + «Применить N изменений →» primary button.

### Rebind (correction)

✎ button opens equipment search modal (reuse RebindModal pattern from slang dictionary). On confirm:
- Row's matched equipmentId updated
- New alias saved to CompetitorAlias (if competitor mode)
- New alias saved to SlangAlias (always, for cross-feature learning)

## UI: Competitor Comparison

Reference mockup: `competitor-ui.html`

### Layout (top to bottom)

1. **Page header** — title «Сравнение с конкурентом — {name}», filename, item count, date.

2. **AI summary** — «Сопоставлено 71 из 83 позиций (86%). У 23 мы дешевле, у 31 дороже, 17 в паритете (±5%). Средняя разница: мы дороже на 8%.»

3. **KPI cards** (4):
   - Сопоставлено: 71/83 (86%)
   - Мы дешевле: 23 (средний -12%)
   - Мы дороже: 31 (средний +15%)
   - Паритет (±5%): 17

4. **Filter bar** — pills: Все / Мы дешевле / Мы дороже / Паритет + search input + export XLSX.

5. **Comparison table** — columns:
   - Наше оборудование (name + category)
   - У конкурента (original name, italic)
   - Наша цена (mono)
   - Конкурент (mono)
   - Разница (delta chip: green = cheaper, red = expensive, gray = parity)
   - Матчинг (tag: exact/сленг/fuzzy/AI)
   - ✎ rebind button

6. **Unmatched section** — amber block at bottom:
   - Header: «Не сопоставлено (12)»
   - Each item: name from competitor file + their price + «Привязать к каталогу →» link button
   - On bind: saves to CompetitorAlias + SlangAlias

7. **Footer bar** — matched/total count + average delta.

### Key difference from own catalog

Competitor mode is **read-only analytics**. No accept/reject, no apply. The purpose is price intelligence, not catalog mutation. User makes pricing decisions separately.

## API Changes

### New endpoint: `POST /api/import-sessions/:id/analyze`

Triggers the hybrid AI pipeline. Replaces manual column mapping step.

```typescript
// Request: empty body (session ID in URL)
// Response (OWN_PRICE_UPDATE mode):
{
  summary: string;              // AI-generated text summary
  groups: {
    type: "PRICE_CHANGE" | "QTY_CHANGE" | "NEW_ITEM" | "REMOVED_ITEM";
    count: number;
    rows: ImportRowWithDescription[];
  }[];
  noChangeCount: number;
}

// Response (COMPETITOR_IMPORT mode):
{
  summary: string;
  comparison: {
    matched: ComparisonRow[];
    unmatched: UnmatchedRow[];
    kpis: {
      matchedCount: number;
      totalCount: number;
      cheaperCount: number;
      expensiveCount: number;
      parityCount: number;
      avgDeltaPercent: number;
    };
  };
}
```

The response shape depends on `session.type`. Frontend checks `session.type` and renders OwnCatalogReview or CompetitorReview accordingly.

### New endpoint: `PATCH /api/import-sessions/:id/rows/:rowId/rebind`

Corrects a wrong match and saves aliases for future learning.

```typescript
// Request:
{
  equipmentId: string;          // correct equipment ID
}
// Response:
{
  ok: true;
  savedAliases: {
    slangAlias: boolean;        // true if SlangAlias created/updated
    competitorAlias: boolean;   // true if CompetitorAlias created/updated (competitor mode only)
  };
}
```

### Existing endpoints reused

- `POST /api/import-sessions/upload` — file upload, session creation
- `GET /api/import-sessions` — list sessions
- `GET /api/import-sessions/:id` — session metadata
- `GET /api/import-sessions/:id/rows` — paginated rows with filters
- `PATCH /api/import-sessions/:id/rows/:rowId` — accept/reject individual row
- `POST /api/import-sessions/:id/bulk-action` — mass accept/reject
- `POST /api/import-sessions/:id/apply` — commit accepted changes (own catalog only)
- `GET /api/import-sessions/:id/export` — XLSX export
- `DELETE /api/import-sessions/:id` — cleanup

## LLM Integration

### Provider: Gemini 2.5 Flash

Already connected in project (`competitorMatcher.ts`, `bookingRequestParser.ts`). Three calls per import:

1. **File structure analysis** (~100 input tokens, ~50 output):
   ```
   Input: column headers + 3-5 sample rows as JSON
   Output: { nameColumn, priceColumn, qtyColumn, categoryColumn, brandColumn?, modelColumn? }
   ```

2. **Unmatched item matching** (~500 tokens, existing pattern from competitorMatcher):
   ```
   Input: unmatched items + catalog subset (same category)
   Output: [{ sourceItem, catalogId, confidence, reason }]
   ```

3. **Description generation** (~300 tokens):
   ```
   Input: grouped changes with old/new values
   Output: { summary: string, descriptions: [{ rowId, text }] }
   ```

Total: ~1000 tokens per import. Cost negligible.

### New service: `importAnalyzer.ts`

```typescript
// Three focused functions:
analyzeFileStructure(headers: string[], sampleRows: any[]): Promise<ColumnMapping>
matchUnmatchedItems(items: UnmatchedItem[], catalog: Equipment[]): Promise<MatchResult[]>
generateDescriptions(groups: ChangeGroup[]): Promise<{ summary: string; descriptions: Map<string, string> }>
```

### Future provider abstraction

Current `vision/provider.ts` pattern can be extended to `llm/provider.ts` if GPT or Claude integration needed later. For now, direct Gemini calls through existing infrastructure.

## Data Model Changes

No new tables. Three fields added to existing models:

```prisma
model ImportSessionRow {
  // ... existing fields ...
  aiDescription  String?    // AI-generated card text
  matchSource    String?    // "slang" | "competitor_alias" | "exact" | "fuzzy" | "gemini"
}

model ImportSession {
  // ... existing fields ...
  aiSummary      String?    // AI-generated text summary
}
```

`matchSource` replaces the current `matchMethod` field's dual role (it currently stores both method and flags like "FLAGGED"). Existing `matchMethod` kept for backward compatibility, `matchSource` is the clean version.

## SlangAlias Integration in Matching Chain

Current matching chain in `importSession.ts` does NOT check SlangAlias. New chain:

```
1. SlangAlias lookup:
   - Normalize source item name (lowercase, trim)
   - Query: SELECT equipmentId FROM SlangAlias WHERE phraseNormalized = ?
   - If found: matchSource = "slang", confidence = alias.confidence

2. CompetitorAlias lookup (competitor mode only):
   - Existing logic from competitorMatcher.ts
   - matchSource = "competitor_alias"

3. Exact importKey:
   - Existing logic
   - matchSource = "exact"

4. Fuzzy (Dice ≥ 0.7):
   - Existing logic
   - matchSource = "fuzzy"

5. Gemini AI (batch):
   - Existing competitorMatcher pattern
   - matchSource = "gemini"
```

On rebind correction:
- Always create SlangAlias: `{ phraseOriginal: sourceItemName, phraseNormalized: normalize(sourceItemName), equipmentId, source: "MANUAL_ADMIN", confidence: 1.0 }`
- If competitor mode: also create CompetitorAlias: `{ competitorName, competitorItem: sourceItemName, equipmentId }`

## File Decomposition

| File | Responsibility | Lines |
|------|---------------|-------|
| `app/admin/imports/page.tsx` | Page shell: mode selection, history, state orchestration | ~120 |
| `components/admin/imports/UploadStep.tsx` | Drag-drop upload + type selection + competitor name | ~80 |
| `components/admin/imports/AnalysisProgress.tsx` | Progress indicator during AI analysis | ~40 |
| `components/admin/imports/OwnCatalogReview.tsx` | AI summary + chips + grouped cards + apply footer | ~200 |
| `components/admin/imports/ChangeCard.tsx` | Single change card: name, delta, description, actions | ~60 |
| `components/admin/imports/CompetitorReview.tsx` | AI summary + KPIs + filters + comparison table | ~200 |
| `components/admin/imports/UnmatchedSection.tsx` | Amber block with unbound competitor items | ~60 |
| `components/admin/imports/RebindModal.tsx` | Equipment search modal (reuse pattern from slang) | ~120 |
| `components/admin/imports/SessionHistory.tsx` | List of past import sessions | ~80 |
| `components/admin/imports/types.ts` | Shared TypeScript types | ~50 |
| `services/importAnalyzer.ts` | LLM calls: structure, matching, descriptions | ~100 |
| `services/importSession.ts` | Add `analyzeWithAI()`, integrate SlangAlias in chain | +150 |
| `services/competitorMatcher.ts` | Add SlangAlias save on correction | +20 |
| `routes/importSessions.ts` | New routes: analyze, rebind | +50 |

**Total: ~1,040 lines new code across 14 files.**

## Key Design Decisions

1. **Hybrid over LLM-first** — deterministic matching runs before AI. Faster, cheaper, predictable. AI handles only structure analysis, unmatched items, and description generation.

2. **SlangAlias as first tier** — checked before CompetitorAlias and importKey. Cross-feature learning: corrections in import improve booking matching, and vice versa.

3. **No pricing recommendations** — competitor mode shows deltas, user decides. Avoids AI making business decisions it can't justify.

4. **Corrections save to both alias tables** — rebind in competitor mode writes CompetitorAlias (for future imports from same competitor) AND SlangAlias (for cross-feature learning in booking flow).

5. **Gemini 2.5 Flash reused** — already in project, cheap, fast. Provider abstraction deferred until actually needed (YAGNI).

6. **Competitor mode is read-only** — no accept/reject, no apply. Purpose is intelligence, not mutation. Keeps the two modes conceptually distinct.

7. **AI column mapping replaces manual step** — the biggest UX win. No more dragging column names around. AI figures it out from headers + sample data.

8. **Anomaly auto-flagging preserved** — price changes >100% or suspicious values (≤0, Excel date range) auto-flagged with warning text, same as current behavior.

## Out of Scope

- Multi-competitor consolidated view (each competitor compared separately)
- Historical price tracking over time (no price history table)
- Auto-apply without review (always requires user confirmation)
- Mobile-specific layout
- Provider abstraction for LLM (use Gemini directly for now)
