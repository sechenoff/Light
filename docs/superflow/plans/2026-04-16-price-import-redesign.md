# Price Import Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign price import with AI-powered hybrid pipeline: LLM analyzes file structure and generates descriptions, deterministic chain matches items (SlangAlias → CompetitorAlias → exact → fuzzy → Gemini), card-based review UI replaces table wizard.

**Architecture:** Backend adds `importAnalyzer.ts` for LLM calls, integrates SlangAlias into matching chain, exposes 2 new endpoints (analyze, rebind). Frontend replaces 500-line wizard with 10 focused components: upload → progress → grouped card review (own catalog) or comparison table (competitor).

**Tech Stack:** Gemini 2.5 Flash Lite (JSON mode), Prisma 6 + SQLite, Next.js 14 + React 18 + Tailwind, existing IBM Plex design canon tokens.

**Spec:** `docs/superflow/specs/2026-04-16-price-import-redesign.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `apps/api/prisma/schema.prisma` | Modify | Add 3 fields: aiDescription, matchSource, aiSummary |
| `apps/api/src/services/importAnalyzer.ts` | Create | LLM calls: file structure, unmatched matching, descriptions |
| `apps/api/src/services/importSession.ts` | Modify | Add analyzeWithAI(), integrate SlangAlias in matchRow |
| `apps/api/src/services/competitorMatcher.ts` | Modify | Add SlangAlias save on rebind correction |
| `apps/api/src/routes/importSessions.ts` | Modify | Add POST /:id/analyze, PATCH /:id/rows/:rowId/rebind |
| `apps/web/src/components/admin/imports/types.ts` | Create | Shared TypeScript types |
| `apps/web/src/components/admin/imports/UploadStep.tsx` | Create | Drag-drop upload + type + competitor name |
| `apps/web/src/components/admin/imports/AnalysisProgress.tsx` | Create | Progress bar during AI analysis |
| `apps/web/src/components/admin/imports/ChangeCard.tsx` | Create | Single change card with actions |
| `apps/web/src/components/admin/imports/OwnCatalogReview.tsx` | Create | AI summary + chips + grouped cards |
| `apps/web/src/components/admin/imports/CompetitorReview.tsx` | Create | KPIs + filters + comparison table |
| `apps/web/src/components/admin/imports/UnmatchedSection.tsx` | Create | Amber block for unbound items |
| `apps/web/src/components/admin/imports/RebindModal.tsx` | Create | Equipment search modal (pattern from slang) |
| `apps/web/src/components/admin/imports/SessionHistory.tsx` | Create | Past import sessions list |
| `apps/web/app/admin/imports/page.tsx` | Rewrite | Page shell: mode selection, orchestration |
| `apps/web/app/admin/page.tsx` | Modify | Replace PricesTab with Link card |

---

### Task 1: Schema Changes

**Files:**
- Modify: `apps/api/prisma/schema.prisma`

- [ ] **Step 1: Add fields to ImportSessionRow model**

In `apps/api/prisma/schema.prisma`, find the `ImportSessionRow` model and add two fields after the `priceDelta` field:

```prisma
  priceDelta    Decimal?
  aiDescription String?     // AI-generated card text
  matchSource   String?     // "slang" | "competitor_alias" | "exact" | "fuzzy" | "gemini"
  status        DiffRowStatus  @default(PENDING)
```

- [ ] **Step 2: Add field to ImportSession model**

In the same file, find the `ImportSession` model and add one field after the `appliedCount` field:

```prisma
  appliedCount    Int      @default(0)
  aiSummary       String?  // AI-generated text summary
  createdAt  DateTime @default(now())
```

- [ ] **Step 3: Push schema changes**

Run from `apps/api/`:

```bash
cd apps/api && npx prisma db push
```

Expected: "Your database is now in sync with your Prisma schema."

- [ ] **Step 4: Regenerate Prisma client**

```bash
cd apps/api && npx prisma generate
```

Expected: "Generated Prisma Client"

- [ ] **Step 5: Commit**

```bash
git add apps/api/prisma/schema.prisma
git commit -m "schema: add aiDescription, matchSource, aiSummary fields for import redesign"
```

---

### Task 2: Import Analyzer Service (LLM)

**Files:**
- Create: `apps/api/src/services/importAnalyzer.ts`
- Read reference: `apps/api/src/services/competitorMatcher.ts` (Gemini call pattern)

- [ ] **Step 1: Create importAnalyzer.ts with analyzeFileStructure**

```typescript
import { GoogleGenerativeAI } from "@google/generative-ai";

export interface ColumnMapping {
  category?: string;
  name?: string;
  brand?: string;
  model?: string;
  quantity?: string;
  rentalRatePerShift?: string;
  rentalRateTwoShifts?: string;
  rentalRatePerProject?: string;
}

export interface ChangeDescription {
  rowId: string;
  text: string;
}

export interface DescriptionResult {
  summary: string;
  descriptions: ChangeDescription[];
}

function getModel() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
  const client = new GoogleGenerativeAI(apiKey);
  return client.getGenerativeModel({
    model: "gemini-2.5-flash-lite",
    generationConfig: {
      maxOutputTokens: 4096,
      responseMimeType: "application/json",
    },
  });
}

function tryParseJSON(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      return JSON.parse(match[1].trim());
    }
    throw new Error("Failed to parse LLM JSON response");
  }
}

export async function analyzeFileStructure(
  headers: string[],
  sampleRows: Record<string, unknown>[],
): Promise<ColumnMapping> {
  const model = getModel();

  const prompt = `Ты анализируешь Excel-файл с оборудованием для киносъёмок (аренда осветительного оборудования).
Вот заголовки колонок: ${JSON.stringify(headers)}
Вот первые строки данных: ${JSON.stringify(sampleRows.slice(0, 5))}

Определи, какая колонка соответствует каждому полю. Верни JSON:
{
  "name": "точное название колонки с именем оборудования или null",
  "category": "точное название колонки с категорией или null",
  "brand": "точное название колонки с брендом или null",
  "model": "точное название колонки с моделью или null",
  "quantity": "точное название колонки с количеством или null",
  "rentalRatePerShift": "точное название колонки с ценой за смену или null",
  "rentalRateTwoShifts": "точное название колонки с ценой за 2 смены или null",
  "rentalRatePerProject": "точное название колонки с проектной ценой или null"
}

Названия колонок могут быть на русском или английском. Верни ТОЧНЫЕ названия из заголовков, не переводи их.
Если колонка не найдена, верни null для этого поля.`;

  const result = await model.generateContent(prompt);
  const parsed = tryParseJSON(result.response.text()) as Record<string, string | null>;

  const mapping: ColumnMapping = {};
  if (parsed.name) mapping.name = parsed.name;
  if (parsed.category) mapping.category = parsed.category;
  if (parsed.brand) mapping.brand = parsed.brand;
  if (parsed.model) mapping.model = parsed.model;
  if (parsed.quantity) mapping.quantity = parsed.quantity;
  if (parsed.rentalRatePerShift) mapping.rentalRatePerShift = parsed.rentalRatePerShift;
  if (parsed.rentalRateTwoShifts) mapping.rentalRateTwoShifts = parsed.rentalRateTwoShifts;
  if (parsed.rentalRatePerProject) mapping.rentalRatePerProject = parsed.rentalRatePerProject;

  return mapping;
}
```

- [ ] **Step 2: Add generateDescriptions function**

Append to the same file:

```typescript
interface ChangeInput {
  rowId: string;
  equipmentName: string;
  action: string;
  oldPrice?: number | null;
  newPrice?: number | null;
  oldQty?: number | null;
  newQty?: number | null;
  priceDelta?: number | null;
  category?: string | null;
}

export async function generateDescriptions(
  changes: ChangeInput[],
  mode: "OWN_PRICE_UPDATE" | "COMPETITOR_IMPORT",
): Promise<DescriptionResult> {
  if (changes.length === 0) {
    return { summary: "Изменений не обнаружено.", descriptions: [] };
  }

  const model = getModel();

  const groupedSummary = {
    priceChanges: changes.filter((c) => c.action === "PRICE_CHANGE").length,
    newItems: changes.filter((c) => c.action === "NEW_ITEM").length,
    removedItems: changes.filter((c) => c.action === "REMOVED_ITEM").length,
    qtyChanges: changes.filter((c) => c.action === "QTY_CHANGE").length,
    total: changes.length,
  };

  const changesForPrompt = changes.slice(0, 100).map((c) => ({
    id: c.rowId,
    name: c.equipmentName,
    action: c.action,
    oldPrice: c.oldPrice,
    newPrice: c.newPrice,
    oldQty: c.oldQty,
    newQty: c.newQty,
    delta: c.priceDelta,
    category: c.category,
  }));

  const prompt = `Ты помощник администратора склада осветительного оборудования для кино.
Режим: ${mode === "OWN_PRICE_UPDATE" ? "обновление собственного каталога" : "сравнение с конкурентом"}.

Сводка: ${JSON.stringify(groupedSummary)}
Изменения: ${JSON.stringify(changesForPrompt)}

Сгенерируй JSON:
{
  "summary": "Общая текстовая сводка на русском, 1-2 предложения. Упомяни количество изменений по типам, средний процент изменения цен если есть.",
  "descriptions": [
    { "rowId": "id строки", "text": "Краткое описание на русском, 1 предложение. Для цен: старая → новая, процент. Для новых: категория, цена. Для количества: было → стало." }
  ]
}

Пиши кратко и по делу. Не используй эмодзи. Описания должны быть информативными для человека, принимающего решение.`;

  const result = await model.generateContent(prompt);
  const parsed = tryParseJSON(result.response.text()) as DescriptionResult;

  if (!parsed.summary || !Array.isArray(parsed.descriptions)) {
    return {
      summary: `Обнаружено ${groupedSummary.total} изменений: ${groupedSummary.priceChanges} ценовых, ${groupedSummary.newItems} новых, ${groupedSummary.qtyChanges} по количеству.`,
      descriptions: [],
    };
  }

  return parsed;
}
```

- [ ] **Step 3: Verify the file compiles**

```bash
cd apps/api && npx tsc --noEmit src/services/importAnalyzer.ts
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/importAnalyzer.ts
git commit -m "feat: add importAnalyzer service for LLM-powered file analysis and descriptions"
```

---

### Task 3: SlangAlias Integration in Matching Chain

**Files:**
- Modify: `apps/api/src/services/importSession.ts`

- [ ] **Step 1: Add SlangAlias lookup to matchRow function**

In `apps/api/src/services/importSession.ts`, find the `matchRow` function (around line 272). Add a SlangAlias lookup as the FIRST tier, before the exact match. The function currently starts with exact importKey matching. Add this block before line 278 (the existing exact match block):

```typescript
// Tier 0: SlangAlias lookup (cross-feature learning)
const normalizedName = row.sourceName.toLowerCase().trim();
if (normalizedName) {
  const slangAlias = await prisma.slangAlias.findFirst({
    where: { phraseNormalized: normalizedName },
    orderBy: { confidence: "desc" },
  });
  if (slangAlias) {
    return {
      equipmentId: slangAlias.equipmentId,
      matchConfidence: slangAlias.confidence,
      matchMethod: "slang",
    };
  }
}
```

Note: `matchRow` is currently sync for tiers 1-3 and only calls Gemini externally. This change makes it async (it already returns Promise). Add `import { prisma } from "../app";` if not already imported — check the file's existing imports. The prisma import likely comes from a different location in this project; check the top of the file for the existing Prisma import pattern.

- [ ] **Step 2: Add matchSource field population**

In the same file, find where `ImportSessionRow` records are created in `mapAndMatch` (around line 510). After the `matchMethod` field, add:

```typescript
  matchMethod: matchResult.matchMethod,
  matchSource: matchResult.matchMethod?.replace(":FLAGGED", "") ?? null,
```

This ensures `matchSource` gets a clean value without the FLAGGED suffix.

- [ ] **Step 3: Verify compilation**

```bash
cd apps/api && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/importSession.ts
git commit -m "feat: integrate SlangAlias as first tier in import matching chain"
```

---

### Task 4: analyzeWithAI Orchestration Function

**Files:**
- Modify: `apps/api/src/services/importSession.ts`
- Read: `apps/api/src/services/importAnalyzer.ts`

- [ ] **Step 1: Add analyzeWithAI function**

At the end of `apps/api/src/services/importSession.ts`, add:

```typescript
import { analyzeFileStructure, generateDescriptions } from "./importAnalyzer";

interface AnalyzeResult {
  summary: string;
  groups?: {
    type: string;
    count: number;
    rows: Array<{
      id: string;
      sourceName: string;
      sourceCategory: string | null;
      sourcePrice: string | null;
      sourceQty: number | null;
      equipmentId: string | null;
      equipmentName: string | null;
      equipmentCategory: string | null;
      oldPrice: string | null;
      oldQty: number | null;
      priceDelta: string | null;
      matchMethod: string | null;
      matchSource: string | null;
      matchConfidence: number | null;
      action: string;
      status: string;
      aiDescription: string | null;
    }>;
  }[];
  comparison?: {
    matched: Array<{
      id: string;
      sourceName: string;
      sourcePrice: string | null;
      equipmentId: string;
      equipmentName: string;
      equipmentCategory: string;
      ourPrice: string;
      competitorPrice: string;
      deltaPercent: number;
      matchSource: string | null;
      matchConfidence: number | null;
    }>;
    unmatched: Array<{
      id: string;
      sourceName: string;
      sourcePrice: string | null;
    }>;
    kpis: {
      matchedCount: number;
      totalCount: number;
      cheaperCount: number;
      expensiveCount: number;
      parityCount: number;
      avgDeltaPercent: number;
    };
  };
  noChangeCount?: number;
}

export async function analyzeWithAI(sessionId: string): Promise<AnalyzeResult> {
  const session = await prisma.importSession.findUniqueOrThrow({
    where: { id: sessionId },
  });

  if (session.status !== "PARSING") {
    throw new Error(`Session ${sessionId} is in status ${session.status}, expected PARSING`);
  }

  // Step 1: Get file preview for AI column mapping
  const preview = JSON.parse(session.columnMapping || "{}");
  let headers: string[] = [];
  let sampleRows: Record<string, unknown>[] = [];

  if (session.fileBuffer) {
    const XLSX = await import("xlsx");
    const wb = XLSX.read(session.fileBuffer, { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const allRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: null });
    headers = Object.keys(allRows[0] || {});
    sampleRows = allRows.slice(0, 5);
  }

  // Step 2: AI analyzes file structure
  let mapping: import("./importAnalyzer").ColumnMapping;
  try {
    mapping = await analyzeFileStructure(headers, sampleRows);
  } catch (err) {
    // Fallback: use suggested mapping from createSession
    mapping = preview.suggestedMapping || {};
  }

  // Step 3: Run deterministic matching + Gemini for unmatched
  await mapAndMatch(
    sessionId,
    session.type as "OWN_PRICE_UPDATE" | "COMPETITOR_IMPORT",
    mapping,
    session.competitorName || undefined,
  );

  // Step 4: Load all rows with equipment
  const rows = await prisma.importSessionRow.findMany({
    where: { sessionId },
    include: { equipment: { select: { id: true, name: true, category: true, rentalRatePerShift: true } } },
    orderBy: { sourceIndex: "asc" },
  });

  // Step 5: Generate AI descriptions for changed rows
  const changedRows = rows.filter((r) => r.action !== "NO_CHANGE");
  let summary = "";
  const descMap = new Map<string, string>();

  if (changedRows.length > 0) {
    try {
      const descResult = await generateDescriptions(
        changedRows.map((r) => ({
          rowId: r.id,
          equipmentName: r.equipment?.name || r.sourceName,
          action: r.action,
          oldPrice: r.oldPrice ? Number(r.oldPrice) : null,
          newPrice: r.sourcePrice ? Number(r.sourcePrice) : null,
          oldQty: r.oldQty,
          newQty: r.sourceQty,
          priceDelta: r.priceDelta ? Number(r.priceDelta) : null,
          category: r.equipment?.category || r.sourceCategory,
        })),
        session.type as "OWN_PRICE_UPDATE" | "COMPETITOR_IMPORT",
      );
      summary = descResult.summary;
      for (const d of descResult.descriptions) {
        descMap.set(d.rowId, d.text);
      }
    } catch {
      summary = `Обнаружено ${changedRows.length} изменений.`;
    }
  } else {
    summary = "Изменений не обнаружено. Все позиции совпадают с текущим каталогом.";
  }

  // Step 6: Save descriptions to DB
  for (const [rowId, text] of descMap) {
    await prisma.importSessionRow.update({
      where: { id: rowId },
      data: { aiDescription: text },
    });
  }
  await prisma.importSession.update({
    where: { id: sessionId },
    data: { aiSummary: summary },
  });

  // Step 7: Build response based on mode
  if (session.type === "OWN_PRICE_UPDATE") {
    const actionTypes = ["PRICE_CHANGE", "QTY_CHANGE", "NEW_ITEM", "REMOVED_ITEM"] as const;
    const groups = actionTypes
      .map((type) => {
        const typeRows = rows.filter((r) => r.action === type);
        return {
          type,
          count: typeRows.length,
          rows: typeRows.map((r) => ({
            id: r.id,
            sourceName: r.sourceName,
            sourceCategory: r.sourceCategory,
            sourcePrice: r.sourcePrice?.toString() ?? null,
            sourceQty: r.sourceQty,
            equipmentId: r.equipmentId,
            equipmentName: r.equipment?.name ?? null,
            equipmentCategory: r.equipment?.category ?? null,
            oldPrice: r.oldPrice?.toString() ?? null,
            oldQty: r.oldQty,
            priceDelta: r.priceDelta?.toString() ?? null,
            matchMethod: r.matchMethod,
            matchSource: r.matchSource,
            matchConfidence: r.matchConfidence,
            action: r.action,
            status: r.status,
            aiDescription: descMap.get(r.id) ?? r.aiDescription,
          })),
        };
      })
      .filter((g) => g.count > 0);

    return {
      summary,
      groups,
      noChangeCount: rows.filter((r) => r.action === "NO_CHANGE").length,
    };
  }

  // COMPETITOR_IMPORT mode
  const matched = rows.filter((r) => r.equipmentId !== null);
  const unmatched = rows.filter((r) => r.equipmentId === null);

  const PARITY_THRESHOLD = 5;
  let cheaperCount = 0;
  let expensiveCount = 0;
  let parityCount = 0;
  let totalDelta = 0;

  const matchedForResponse = matched.map((r) => {
    const ourPrice = r.equipment?.rentalRatePerShift ? Number(r.equipment.rentalRatePerShift) : 0;
    const competitorPrice = r.sourcePrice ? Number(r.sourcePrice) : 0;
    const deltaPercent = ourPrice > 0 ? Math.round(((ourPrice - competitorPrice) / competitorPrice) * 100) : 0;

    if (Math.abs(deltaPercent) <= PARITY_THRESHOLD) parityCount++;
    else if (deltaPercent > 0) expensiveCount++;
    else cheaperCount++;
    totalDelta += deltaPercent;

    return {
      id: r.id,
      sourceName: r.sourceName,
      sourcePrice: r.sourcePrice?.toString() ?? null,
      equipmentId: r.equipmentId!,
      equipmentName: r.equipment?.name ?? r.sourceName,
      equipmentCategory: r.equipment?.category ?? "",
      ourPrice: ourPrice.toString(),
      competitorPrice: competitorPrice.toString(),
      deltaPercent,
      matchSource: r.matchSource,
      matchConfidence: r.matchConfidence,
    };
  });

  return {
    summary,
    comparison: {
      matched: matchedForResponse,
      unmatched: unmatched.map((r) => ({
        id: r.id,
        sourceName: r.sourceName,
        sourcePrice: r.sourcePrice?.toString() ?? null,
      })),
      kpis: {
        matchedCount: matched.length,
        totalCount: rows.length,
        cheaperCount,
        expensiveCount,
        parityCount,
        avgDeltaPercent: matched.length > 0 ? Math.round(totalDelta / matched.length) : 0,
      },
    },
  };
}
```

- [ ] **Step 2: Export the function**

Make sure `analyzeWithAI` is exported. Check the file exports — if there's an explicit export list at the bottom, add `analyzeWithAI` to it.

- [ ] **Step 3: Verify compilation**

```bash
cd apps/api && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/importSession.ts
git commit -m "feat: add analyzeWithAI orchestration for hybrid import pipeline"
```

---

### Task 5: API Routes — analyze and rebind

**Files:**
- Modify: `apps/api/src/routes/importSessions.ts`

- [ ] **Step 1: Add POST /:id/analyze route**

In `apps/api/src/routes/importSessions.ts`, add this route BEFORE the existing `POST /:id/map` route (so Express doesn't treat "analyze" as `:id`):

```typescript
import { analyzeWithAI } from "../services/importSession";

// AI-powered analysis: structure detection + matching + descriptions
router.post("/:id/analyze", async (req, res, next) => {
  try {
    const result = await analyzeWithAI(req.params.id);
    res.json(result);
  } catch (err: any) {
    if (err.message?.includes("expected PARSING")) {
      return res.status(409).json({ error: "SESSION_ALREADY_ANALYZED", message: err.message });
    }
    next(err);
  }
});
```

- [ ] **Step 2: Add PATCH /:id/rows/:rowId/rebind route**

Add this route after the existing `PATCH /:id/rows/:rowId` route:

```typescript
// Rebind: correct a wrong match and save aliases for learning
router.patch("/:id/rows/:rowId/rebind", async (req, res, next) => {
  try {
    const { equipmentId } = req.body;
    if (!equipmentId || typeof equipmentId !== "string") {
      return res.status(400).json({ error: "equipmentId is required" });
    }

    // Update the row's matched equipment
    const row = await prisma.importSessionRow.findUniqueOrThrow({
      where: { id: req.params.rowId },
      include: { session: { select: { type: true, competitorName: true } } },
    });

    await prisma.importSessionRow.update({
      where: { id: req.params.rowId },
      data: {
        equipmentId,
        matchMethod: "manual_rebind",
        matchSource: "manual_rebind",
        matchConfidence: 1.0,
      },
    });

    // Save SlangAlias (always)
    const normalizedPhrase = row.sourceName.toLowerCase().trim();
    let slangSaved = false;
    if (normalizedPhrase) {
      await prisma.slangAlias.upsert({
        where: {
          phraseNormalized_equipmentId: {
            phraseNormalized: normalizedPhrase,
            equipmentId,
          },
        },
        create: {
          phraseNormalized: normalizedPhrase,
          phraseOriginal: row.sourceName,
          equipmentId,
          source: "MANUAL_ADMIN",
          confidence: 1.0,
        },
        update: {
          confidence: 1.0,
          source: "MANUAL_ADMIN",
          phraseOriginal: row.sourceName,
        },
      });
      slangSaved = true;
    }

    // Save CompetitorAlias (competitor mode only)
    let competitorSaved = false;
    if (row.session.type === "COMPETITOR_IMPORT" && row.session.competitorName) {
      await prisma.competitorAlias.upsert({
        where: {
          competitorName_competitorItem: {
            competitorName: row.session.competitorName,
            competitorItem: row.sourceName,
          },
        },
        create: {
          competitorName: row.session.competitorName,
          competitorItem: row.sourceName,
          equipmentId,
        },
        update: {
          equipmentId,
        },
      });
      competitorSaved = true;
    }

    res.json({
      ok: true,
      savedAliases: {
        slangAlias: slangSaved,
        competitorAlias: competitorSaved,
      },
    });
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 3: Verify compilation**

```bash
cd apps/api && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/importSessions.ts
git commit -m "feat: add analyze and rebind API endpoints for import redesign"
```

---

### Task 6: Frontend Types

**Files:**
- Create: `apps/web/src/components/admin/imports/types.ts`

- [ ] **Step 1: Create shared types file**

```typescript
export interface ImportSession {
  id: string;
  type: "OWN_PRICE_UPDATE" | "COMPETITOR_IMPORT";
  status: string;
  competitorName: string | null;
  fileName: string;
  fileSize: number;
  totalRows: number;
  matchedRows: number;
  unmatchedRows: number;
  acceptedCount: number;
  rejectedCount: number;
  appliedCount: number;
  aiSummary: string | null;
  createdAt: string;
}

export interface ImportRow {
  id: string;
  sourceName: string;
  sourceCategory: string | null;
  sourcePrice: string | null;
  sourceQty: number | null;
  equipmentId: string | null;
  equipmentName: string | null;
  equipmentCategory: string | null;
  oldPrice: string | null;
  oldQty: number | null;
  priceDelta: string | null;
  matchMethod: string | null;
  matchSource: string | null;
  matchConfidence: number | null;
  action: string;
  status: string;
  aiDescription: string | null;
}

export interface ChangeGroup {
  type: "PRICE_CHANGE" | "QTY_CHANGE" | "NEW_ITEM" | "REMOVED_ITEM";
  count: number;
  rows: ImportRow[];
}

export interface ComparisonRow {
  id: string;
  sourceName: string;
  sourcePrice: string | null;
  equipmentId: string;
  equipmentName: string;
  equipmentCategory: string;
  ourPrice: string;
  competitorPrice: string;
  deltaPercent: number;
  matchSource: string | null;
  matchConfidence: number | null;
}

export interface UnmatchedRow {
  id: string;
  sourceName: string;
  sourcePrice: string | null;
}

export interface ComparisonKpis {
  matchedCount: number;
  totalCount: number;
  cheaperCount: number;
  expensiveCount: number;
  parityCount: number;
  avgDeltaPercent: number;
}

export interface AnalyzeResultOwn {
  summary: string;
  groups: ChangeGroup[];
  noChangeCount: number;
}

export interface AnalyzeResultCompetitor {
  summary: string;
  comparison: {
    matched: ComparisonRow[];
    unmatched: UnmatchedRow[];
    kpis: ComparisonKpis;
  };
}

export type DeltaDirection = "cheaper" | "expensive" | "parity";

export interface EquipmentSearchResult {
  id: string;
  name: string;
  category: string;
  brand: string | null;
  rentalRatePerShift: string;
}
```

- [ ] **Step 2: Commit**

```bash
mkdir -p apps/web/src/components/admin/imports
git add apps/web/src/components/admin/imports/types.ts
git commit -m "feat: add shared TypeScript types for import redesign"
```

---

### Task 7: UploadStep + AnalysisProgress Components

**Files:**
- Create: `apps/web/src/components/admin/imports/UploadStep.tsx`
- Create: `apps/web/src/components/admin/imports/AnalysisProgress.tsx`

- [ ] **Step 1: Create UploadStep component**

```typescript
"use client";

import { useRef, useState } from "react";

type Props = {
  onUpload: (file: File, type: "OWN_PRICE_UPDATE" | "COMPETITOR_IMPORT", competitorName?: string) => void;
  loading: boolean;
};

export function UploadStep({ onUpload, loading }: Props) {
  const [type, setType] = useState<"OWN_PRICE_UPDATE" | "COMPETITOR_IMPORT">("OWN_PRICE_UPDATE");
  const [competitorName, setCompetitorName] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleFile(file: File) {
    if (type === "COMPETITOR_IMPORT" && !competitorName.trim()) return;
    onUpload(file, type, type === "COMPETITOR_IMPORT" ? competitorName.trim() : undefined);
  }

  return (
    <div className="max-w-xl mx-auto">
      <h2 className="text-[15px] font-semibold text-ink mb-6">Новый импорт</h2>

      {/* Mode selection */}
      <div className="flex gap-3 mb-6">
        <button
          onClick={() => setType("OWN_PRICE_UPDATE")}
          className={[
            "flex-1 p-4 rounded-lg border text-left transition-colors",
            type === "OWN_PRICE_UPDATE"
              ? "border-accent bg-accent-soft"
              : "border-border bg-surface hover:border-ink-3",
          ].join(" ")}
        >
          <p className="font-medium text-sm text-ink">📦 Обновить каталог</p>
          <p className="text-xs text-ink-3 mt-1">Загрузить файл с новыми ценами, позициями или количеством</p>
        </button>
        <button
          onClick={() => setType("COMPETITOR_IMPORT")}
          className={[
            "flex-1 p-4 rounded-lg border text-left transition-colors",
            type === "COMPETITOR_IMPORT"
              ? "border-accent bg-accent-soft"
              : "border-border bg-surface hover:border-ink-3",
          ].join(" ")}
        >
          <p className="font-medium text-sm text-ink">📊 Сравнить с конкурентом</p>
          <p className="text-xs text-ink-3 mt-1">Загрузить прайс конкурента для ценового анализа</p>
        </button>
      </div>

      {/* Competitor name */}
      {type === "COMPETITOR_IMPORT" && (
        <div className="mb-6">
          <label className="block text-xs font-medium text-ink-2 mb-1.5">Название конкурента</label>
          <input
            type="text"
            value={competitorName}
            onChange={(e) => setCompetitorName(e.target.value)}
            placeholder="Например: CineRent Moscow"
            className="w-full border border-border rounded-lg px-3 py-2 text-sm text-ink bg-surface placeholder-ink-3 focus:outline-none focus:border-accent-bright"
          />
        </div>
      )}

      {/* Drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const file = e.dataTransfer.files[0];
          if (file) handleFile(file);
        }}
        onClick={() => inputRef.current?.click()}
        className={[
          "border-2 border-dashed rounded-lg p-10 text-center cursor-pointer transition-colors",
          dragOver ? "border-accent bg-accent-soft" : "border-border hover:border-ink-3",
          loading ? "opacity-50 pointer-events-none" : "",
        ].join(" ")}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,.xls"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
          }}
        />
        <p className="text-sm text-ink-2 mb-1">
          {loading ? "Загрузка..." : "Перетащите файл сюда или нажмите для выбора"}
        </p>
        <p className="text-xs text-ink-3">XLSX или XLS, до 5 МБ</p>
      </div>

      {type === "COMPETITOR_IMPORT" && !competitorName.trim() && (
        <p className="text-xs text-amber mt-2">Укажите название конкурента перед загрузкой</p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create AnalysisProgress component**

```typescript
"use client";

type Props = {
  fileName: string;
};

export function AnalysisProgress({ fileName }: Props) {
  return (
    <div className="max-w-md mx-auto text-center py-16">
      <div className="w-10 h-10 border-3 border-accent border-t-transparent rounded-full animate-spin mx-auto mb-4" />
      <p className="text-sm font-medium text-ink mb-1">Анализируем файл...</p>
      <p className="text-xs text-ink-3 mb-4">{fileName}</p>
      <div className="space-y-2 text-xs text-ink-3">
        <p>🔍 AI определяет структуру колонок</p>
        <p>📖 Сопоставляем позиции через словарь и каталог</p>
        <p>🤖 Генерируем описания изменений</p>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/admin/imports/UploadStep.tsx apps/web/src/components/admin/imports/AnalysisProgress.tsx
git commit -m "feat: add UploadStep and AnalysisProgress components"
```

---

### Task 8: ChangeCard + OwnCatalogReview Components

**Files:**
- Create: `apps/web/src/components/admin/imports/ChangeCard.tsx`
- Create: `apps/web/src/components/admin/imports/OwnCatalogReview.tsx`

- [ ] **Step 1: Create ChangeCard component**

```typescript
"use client";

import type { ImportRow } from "./types";

type Props = {
  row: ImportRow;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onRebind: (id: string) => void;
};

function matchTag(source: string | null) {
  const map: Record<string, { cls: string; label: string }> = {
    exact: { cls: "bg-ok-soft text-ok", label: "✓ exact" },
    slang: { cls: "bg-accent-soft text-accent", label: "📖 сленг" },
    alias: { cls: "bg-accent-soft text-accent", label: "📖 алиас" },
    competitor_alias: { cls: "bg-accent-soft text-accent", label: "📖 алиас" },
    dice: { cls: "bg-amber-soft text-amber", label: "≈ fuzzy" },
    fuzzy: { cls: "bg-amber-soft text-amber", label: "≈ fuzzy" },
    gemini: { cls: "bg-indigo-soft text-indigo", label: "🤖 AI" },
    manual_rebind: { cls: "bg-ok-soft text-ok", label: "✋ вручную" },
  };
  const m = map[source ?? ""] ?? { cls: "bg-surface-2 text-ink-3", label: source ?? "—" };
  return <span className={`text-[10px] px-1.5 py-0.5 rounded ${m.cls}`}>{m.label}</span>;
}

function deltaChip(row: ImportRow) {
  if (row.action === "NEW_ITEM") {
    return <span className="font-mono text-[11px] px-2 py-0.5 rounded bg-amber-soft text-amber">новая</span>;
  }
  if (row.action === "REMOVED_ITEM") {
    return <span className="font-mono text-[11px] px-2 py-0.5 rounded bg-rose-soft text-rose">удалена</span>;
  }
  if (row.action === "QTY_CHANGE") {
    return (
      <span className="font-mono text-[11px] px-2 py-0.5 rounded bg-teal-soft text-teal">
        {row.oldQty} → {row.sourceQty} шт.
      </span>
    );
  }
  // PRICE_CHANGE
  const delta = row.priceDelta ? Number(row.priceDelta) : 0;
  const cls = delta > 0 ? "bg-amber-soft text-amber" : "bg-accent-soft text-accent";
  const sign = delta > 0 ? "+" : "";
  return (
    <span className={`font-mono text-[11px] px-2 py-0.5 rounded ${cls}`}>
      {row.oldPrice}₽ → {row.sourcePrice}₽ ({sign}{delta}%)
    </span>
  );
}

export function ChangeCard({ row, onAccept, onReject, onRebind }: Props) {
  const isAccepted = row.status === "ACCEPTED";
  const isRejected = row.status === "REJECTED";

  return (
    <div
      className={[
        "grid grid-cols-[1fr_auto] gap-3 px-4 py-3 border-b border-border/50 items-center",
        isAccepted ? "bg-ok-soft/30" : isRejected ? "bg-rose-soft/30 opacity-60" : "bg-surface",
      ].join(" ")}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap mb-1">
          <span className="font-mono text-[12.5px] text-ink font-medium truncate">
            {row.equipmentName || row.sourceName}
          </span>
          {deltaChip(row)}
          {matchTag(row.matchSource)}
        </div>
        {row.aiDescription && (
          <p className="text-[12px] text-ink-2 leading-relaxed">{row.aiDescription}</p>
        )}
      </div>
      <div className="flex gap-1.5">
        <button
          onClick={() => onAccept(row.id)}
          title="Принять"
          className={[
            "w-8 h-8 rounded-lg border flex items-center justify-center text-sm transition-colors",
            isAccepted
              ? "bg-ok-soft border-ok text-ok"
              : "border-border text-ok hover:bg-ok-soft",
          ].join(" ")}
        >
          ✓
        </button>
        <button
          onClick={() => onReject(row.id)}
          title="Отклонить"
          className={[
            "w-8 h-8 rounded-lg border flex items-center justify-center text-sm transition-colors",
            isRejected
              ? "bg-rose-soft border-rose text-rose"
              : "border-border text-rose hover:bg-rose-soft",
          ].join(" ")}
        >
          ✕
        </button>
        <button
          onClick={() => onRebind(row.id)}
          title="Исправить связь"
          className="w-8 h-8 rounded-lg border border-border text-ink-3 hover:text-ink hover:bg-surface-2 flex items-center justify-center text-sm transition-colors"
        >
          ✎
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create OwnCatalogReview component**

```typescript
"use client";

import { useState } from "react";
import type { AnalyzeResultOwn, ImportRow } from "./types";
import { ChangeCard } from "./ChangeCard";

type Props = {
  result: AnalyzeResultOwn;
  fileName: string;
  onAccept: (rowId: string) => void;
  onReject: (rowId: string) => void;
  onRebind: (rowId: string) => void;
  onBulkAccept: (action?: string) => void;
  onBulkReject: (action?: string) => void;
  onApply: () => void;
  onExport: () => void;
  applying: boolean;
};

const GROUP_META: Record<string, { icon: string; label: string; chipCls: string }> = {
  PRICE_CHANGE: { icon: "💰", label: "Ценовые изменения", chipCls: "bg-accent-soft text-accent" },
  QTY_CHANGE: { icon: "📦", label: "Изменения количества", chipCls: "bg-teal-soft text-teal" },
  NEW_ITEM: { icon: "✨", label: "Новые позиции", chipCls: "bg-amber-soft text-amber" },
  REMOVED_ITEM: { icon: "🗑", label: "Удалённые позиции", chipCls: "bg-rose-soft text-rose" },
};

export function OwnCatalogReview({
  result,
  fileName,
  onAccept,
  onReject,
  onRebind,
  onBulkAccept,
  onBulkReject,
  onApply,
  onExport,
  applying,
}: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const allRows = result.groups.flatMap((g) => g.rows);
  const acceptedCount = allRows.filter((r) => r.status === "ACCEPTED").length;
  const rejectedCount = allRows.filter((r) => r.status === "REJECTED").length;
  const pendingCount = allRows.filter((r) => r.status === "PENDING").length;

  return (
    <div>
      {/* AI Summary */}
      <div className="p-3.5 bg-surface border border-border rounded-lg mb-5 text-[13px] text-ink-2 leading-relaxed">
        <span className="mr-1.5">🤖</span>
        {result.summary}
      </div>

      {/* Summary chips */}
      <div className="flex gap-2 mb-5 flex-wrap">
        {result.groups.map((g) => {
          const meta = GROUP_META[g.type];
          return (
            <div key={g.type} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium border ${meta.chipCls} border-current/20`}>
              {meta.icon} {meta.label} <span className="font-mono font-semibold">{g.count}</span>
            </div>
          );
        })}
        {result.noChangeCount > 0 && (
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] text-ink-3 bg-surface border border-border">
            Без изменений <span className="font-mono font-semibold">{result.noChangeCount}</span>
          </div>
        )}
      </div>

      {/* Action bar */}
      <div className="flex items-center justify-between p-3 bg-surface border border-border rounded-lg mb-5">
        <div className="text-[13px] text-ink-2">
          Принято: <strong className="text-ok">{acceptedCount}</strong> ·
          Отклонено: <strong className="text-rose">{rejectedCount}</strong> ·
          Ожидает: <strong>{pendingCount}</strong>
        </div>
        <div className="flex gap-2">
          <button onClick={() => onBulkAccept()} className="px-3 py-1.5 text-xs font-medium rounded-lg border border-ok/30 text-ok hover:bg-ok-soft transition-colors">
            ✓ Принять все
          </button>
          <button onClick={() => onBulkReject()} className="px-3 py-1.5 text-xs font-medium rounded-lg border border-rose/30 text-rose hover:bg-rose-soft transition-colors">
            ✕ Отклонить все
          </button>
          <button onClick={onExport} className="px-3 py-1.5 text-xs font-medium rounded-lg border border-border text-ink-2 hover:text-ink transition-colors">
            ↓ Экспорт
          </button>
        </div>
      </div>

      {/* Groups */}
      {result.groups.map((group) => {
        const meta = GROUP_META[group.type];
        const isCollapsed = collapsed[group.type] ?? false;

        return (
          <div key={group.type} className="mb-5">
            <div
              onClick={() => setCollapsed((p) => ({ ...p, [group.type]: !isCollapsed }))}
              className="flex items-center justify-between px-4 py-2.5 bg-surface border border-border rounded-t-lg cursor-pointer"
            >
              <h3 className="text-[13px] font-semibold text-ink flex items-center gap-2">
                {meta.icon} {meta.label}
                <span className={`font-mono text-[11px] px-2 py-0.5 rounded-full ${meta.chipCls}`}>
                  {group.count}
                </span>
              </h3>
              <div className="flex gap-1.5">
                <button
                  onClick={(e) => { e.stopPropagation(); onBulkAccept(group.type); }}
                  className="px-2.5 py-1 text-[11px] font-medium rounded border border-border text-ink-3 hover:text-ok hover:border-ok/30 transition-colors"
                >
                  ✓ Принять группу
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onBulkReject(group.type); }}
                  className="px-2.5 py-1 text-[11px] font-medium rounded border border-border text-ink-3 hover:text-rose hover:border-rose/30 transition-colors"
                >
                  ✕ Отклонить группу
                </button>
                <span className="text-ink-3 text-xs ml-1">{isCollapsed ? "▸" : "▾"}</span>
              </div>
            </div>
            {!isCollapsed && (
              <div className="border border-t-0 border-border rounded-b-lg overflow-hidden">
                {group.rows.map((row) => (
                  <ChangeCard
                    key={row.id}
                    row={row}
                    onAccept={onAccept}
                    onReject={onReject}
                    onRebind={onRebind}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}

      {/* Footer */}
      <div className="flex items-center justify-between p-4 bg-surface border border-border rounded-lg">
        <div className="text-[13px] text-ink-2">
          Принято <strong className="text-ink">{acceptedCount}</strong> из <strong className="text-ink">{allRows.length}</strong> изменений
        </div>
        <button
          onClick={onApply}
          disabled={acceptedCount === 0 || applying}
          className="px-4 py-2 text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent-bright disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {applying ? "Применяем..." : `Применить ${acceptedCount} изменений →`}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/admin/imports/ChangeCard.tsx apps/web/src/components/admin/imports/OwnCatalogReview.tsx
git commit -m "feat: add ChangeCard and OwnCatalogReview components"
```

---

### Task 9: CompetitorReview + UnmatchedSection

**Files:**
- Create: `apps/web/src/components/admin/imports/UnmatchedSection.tsx`
- Create: `apps/web/src/components/admin/imports/CompetitorReview.tsx`

- [ ] **Step 1: Create UnmatchedSection component**

```typescript
"use client";

import type { UnmatchedRow } from "./types";

type Props = {
  rows: UnmatchedRow[];
  onRebind: (rowId: string) => void;
};

export function UnmatchedSection({ rows, onRebind }: Props) {
  if (rows.length === 0) return null;

  return (
    <div className="mt-6 p-4 bg-amber-soft/30 border border-amber/30 rounded-lg">
      <h3 className="text-[14px] font-semibold text-amber mb-3 flex items-center gap-2">
        ⚠️ Не сопоставлено <span className="font-mono">{rows.length}</span>
      </h3>
      <div className="space-y-2">
        {rows.map((row) => (
          <div key={row.id} className="flex items-center justify-between px-3 py-2.5 bg-surface border border-amber/20 rounded-lg">
            <div>
              <span className="text-[13px] font-medium text-ink">{row.sourceName}</span>
              <span className="text-[11px] text-ink-3 ml-2">из файла конкурента</span>
            </div>
            <div className="flex items-center gap-3">
              {row.sourcePrice && (
                <span className="font-mono text-[13px] text-ink-2">{row.sourcePrice}₽</span>
              )}
              <button
                onClick={() => onRebind(row.id)}
                className="text-[12px] text-accent hover:text-accent-bright underline transition-colors"
              >
                Привязать к каталогу →
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create CompetitorReview component**

```typescript
"use client";

import { useState } from "react";
import type { AnalyzeResultCompetitor, DeltaDirection } from "./types";
import { UnmatchedSection } from "./UnmatchedSection";

type Props = {
  result: AnalyzeResultCompetitor;
  competitorName: string;
  fileName: string;
  onRebind: (rowId: string) => void;
  onExport: () => void;
};

type FilterKey = "all" | "cheaper" | "expensive" | "parity";

function deltaDirection(percent: number): DeltaDirection {
  if (Math.abs(percent) <= 5) return "parity";
  return percent > 0 ? "expensive" : "cheaper";
}

function deltaChipCls(dir: DeltaDirection) {
  if (dir === "cheaper") return "bg-ok-soft text-ok";
  if (dir === "expensive") return "bg-rose-soft text-rose";
  return "bg-surface-2 text-ink-3";
}

function matchTag(source: string | null) {
  const map: Record<string, { cls: string; label: string }> = {
    exact: { cls: "bg-ok-soft text-ok", label: "✓ exact" },
    slang: { cls: "bg-accent-soft text-accent", label: "📖 сленг" },
    competitor_alias: { cls: "bg-accent-soft text-accent", label: "📖 алиас" },
    alias: { cls: "bg-accent-soft text-accent", label: "📖 алиас" },
    dice: { cls: "bg-amber-soft text-amber", label: "≈ fuzzy" },
    fuzzy: { cls: "bg-amber-soft text-amber", label: "≈ fuzzy" },
    gemini: { cls: "bg-indigo-soft text-indigo", label: "🤖 AI" },
    manual_rebind: { cls: "bg-ok-soft text-ok", label: "✋ вручную" },
  };
  const m = map[source ?? ""] ?? { cls: "bg-surface-2 text-ink-3", label: source ?? "—" };
  return <span className={`text-[10px] px-1.5 py-0.5 rounded ${m.cls}`}>{m.label}</span>;
}

export function CompetitorReview({ result, competitorName, fileName, onRebind, onExport }: Props) {
  const [filter, setFilter] = useState<FilterKey>("all");
  const [search, setSearch] = useState("");
  const { matched, unmatched, kpis } = result.comparison;

  const filtered = matched.filter((r) => {
    if (filter !== "all") {
      const dir = deltaDirection(r.deltaPercent);
      if (filter !== dir) return false;
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      if (!r.equipmentName.toLowerCase().includes(q) && !r.sourceName.toLowerCase().includes(q)) {
        return false;
      }
    }
    return true;
  });

  const FILTERS: { key: FilterKey; label: string; count: number }[] = [
    { key: "all", label: "Все", count: kpis.matchedCount },
    { key: "cheaper", label: "Мы дешевле", count: kpis.cheaperCount },
    { key: "expensive", label: "Мы дороже", count: kpis.expensiveCount },
    { key: "parity", label: "Паритет", count: kpis.parityCount },
  ];

  return (
    <div>
      {/* AI Summary */}
      <div className="p-3.5 bg-surface border border-border rounded-lg mb-5 text-[13px] text-ink-2 leading-relaxed">
        <span className="mr-1.5">🤖</span>
        {result.summary}
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-4 gap-3 mb-5">
        <div className="p-3.5 bg-surface border border-border rounded-lg">
          <div className="text-[10.5px] text-ink-3 uppercase tracking-wider mb-1">Сопоставлено</div>
          <div className="font-mono text-xl font-semibold text-accent">
            {kpis.matchedCount}<span className="text-sm text-ink-3 font-normal"> / {kpis.totalCount}</span>
          </div>
          <div className="text-[11px] text-ink-3">{Math.round((kpis.matchedCount / kpis.totalCount) * 100)}% позиций</div>
        </div>
        <div className="p-3.5 bg-surface border border-border rounded-lg">
          <div className="text-[10.5px] text-ink-3 uppercase tracking-wider mb-1">Мы дешевле</div>
          <div className="font-mono text-xl font-semibold text-ok">{kpis.cheaperCount}</div>
        </div>
        <div className="p-3.5 bg-surface border border-border rounded-lg">
          <div className="text-[10.5px] text-ink-3 uppercase tracking-wider mb-1">Мы дороже</div>
          <div className="font-mono text-xl font-semibold text-rose">{kpis.expensiveCount}</div>
        </div>
        <div className="p-3.5 bg-surface border border-border rounded-lg">
          <div className="text-[10.5px] text-ink-3 uppercase tracking-wider mb-1">Паритет (±5%)</div>
          <div className="font-mono text-xl font-semibold text-ink-2">{kpis.parityCount}</div>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex gap-1 p-1 bg-surface border border-border rounded-lg">
          {FILTERS.map(({ key, label, count }) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={[
                "px-3 py-1.5 text-xs rounded flex items-center gap-1.5 transition-colors",
                filter === key
                  ? "bg-surface-2 text-ink font-medium shadow-xs"
                  : "text-ink-2 hover:text-ink",
              ].join(" ")}
            >
              {label}
              <span className={`mono-num text-[10px] px-1.5 py-0.5 rounded-full ${filter === key ? "bg-accent-soft text-accent" : "bg-surface-2 text-ink-3"}`}>
                {count}
              </span>
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Поиск по названию..."
            className="border border-border rounded-lg px-3 py-1.5 text-sm text-ink bg-surface placeholder-ink-3 focus:outline-none focus:border-accent-bright w-56"
          />
          <button onClick={onExport} className="px-3 py-1.5 text-xs font-medium border border-border rounded-lg text-ink-2 hover:text-ink transition-colors">
            ↓ Экспорт
          </button>
        </div>
      </div>

      {/* Comparison table */}
      <div className="bg-surface border border-border rounded-lg overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3 font-semibold">
              <th className="text-left px-4 py-2.5">Наше оборудование</th>
              <th className="text-left px-4 py-2.5">У конкурента</th>
              <th className="text-right px-4 py-2.5">Наша цена</th>
              <th className="text-right px-4 py-2.5">Конкурент</th>
              <th className="text-right px-4 py-2.5">Разница</th>
              <th className="text-left px-4 py-2.5">Матчинг</th>
              <th className="px-4 py-2.5 w-10"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => {
              const dir = deltaDirection(row.deltaPercent);
              const sign = row.deltaPercent > 0 ? "+" : "";
              return (
                <tr key={row.id} className="border-t border-border/50 hover:bg-surface-2/50">
                  <td className="px-4 py-3">
                    <div className="text-[13px] font-medium text-ink">{row.equipmentName}</div>
                    <div className="text-[11px] text-ink-3">{row.equipmentCategory}</div>
                  </td>
                  <td className="px-4 py-3 text-[12px] text-ink-2 italic">{row.sourceName}</td>
                  <td className="px-4 py-3 text-right font-mono text-[13px] font-medium text-ink">{row.ourPrice}₽</td>
                  <td className="px-4 py-3 text-right font-mono text-[13px] text-ink-2">{row.competitorPrice}₽</td>
                  <td className="px-4 py-3 text-right">
                    <span className={`font-mono text-[11px] font-medium px-2 py-0.5 rounded ${deltaChipCls(dir)}`}>
                      {sign}{row.deltaPercent}%
                    </span>
                  </td>
                  <td className="px-4 py-3">{matchTag(row.matchSource)}</td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => onRebind(row.id)}
                      title="Исправить связь"
                      className="w-7 h-7 rounded border border-border text-ink-3 hover:text-ink hover:bg-surface-2 flex items-center justify-center text-sm transition-colors"
                    >
                      ✎
                    </button>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="py-10 text-center text-sm text-ink-3">
                  {search ? "Ничего не найдено" : "Нет сопоставленных позиций"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Unmatched */}
      <UnmatchedSection rows={unmatched} onRebind={onRebind} />

      {/* Footer */}
      <div className="flex items-center justify-between p-4 bg-surface border border-border rounded-lg mt-5">
        <div className="text-[13px] text-ink-2">
          Сопоставлено <strong className="text-ink">{kpis.matchedCount}</strong> из <strong className="text-ink">{kpis.totalCount}</strong> ·
          Средняя разница: <strong className={kpis.avgDeltaPercent > 0 ? "text-rose" : kpis.avgDeltaPercent < 0 ? "text-ok" : "text-ink"}>
            {kpis.avgDeltaPercent > 0 ? "+" : ""}{kpis.avgDeltaPercent}%
          </strong>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/admin/imports/UnmatchedSection.tsx apps/web/src/components/admin/imports/CompetitorReview.tsx
git commit -m "feat: add CompetitorReview and UnmatchedSection components"
```

---

### Task 10: RebindModal for Imports

**Files:**
- Create: `apps/web/src/components/admin/imports/RebindModal.tsx`
- Read reference: `apps/web/src/components/admin/slang/RebindModal.tsx`

- [ ] **Step 1: Create RebindModal (adapted from slang pattern)**

```typescript
"use client";

import { useState, useRef, useEffect } from "react";
import type { EquipmentSearchResult } from "./types";

type Props = {
  sourceName: string;
  currentEquipmentId: string | null;
  onRebind: (equipmentId: string, equipmentName: string) => void;
  onClose: () => void;
};

export function RebindModal({ sourceName, currentEquipmentId, onRebind, onClose }: Props) {
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<EquipmentSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const searchCounterRef = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!search.trim()) {
      setResults([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      const requestId = ++searchCounterRef.current;
      try {
        const res = await fetch(`/api/equipment?search=${encodeURIComponent(search.trim())}`);
        if (!res.ok) throw new Error("search failed");
        const data = await res.json();
        if (requestId !== searchCounterRef.current) return;
        const items: EquipmentSearchResult[] = (data.items || data || []).map((e: any) => ({
          id: e.id,
          name: e.name,
          category: e.category,
          brand: e.brand ?? null,
          rentalRatePerShift: e.rentalRatePerShift?.toString() ?? "0",
        }));
        setResults(items);
      } catch {
        if (requestId === searchCounterRef.current) setResults([]);
      } finally {
        if (requestId === searchCounterRef.current) setLoading(false);
      }
    }, 300);
  }, [search]);

  function handleSave() {
    if (!selectedId) return;
    const item = results.find((r) => r.id === selectedId);
    if (!item) return;
    setSaving(true);
    onRebind(item.id, item.name);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-surface border border-border rounded-xl shadow-lg w-full max-w-lg max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div>
            <h3 className="text-[15px] font-semibold text-ink">Привязать к каталогу</h3>
            <p className="text-[12px] text-ink-3 mt-0.5">Файл: «{sourceName}»</p>
          </div>
          <button onClick={onClose} className="text-ink-3 hover:text-ink text-lg" aria-label="Закрыть">✕</button>
        </div>

        {/* Search */}
        <div className="px-5 py-3 border-b border-border">
          <input
            ref={inputRef}
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Поиск по каталогу оборудования..."
            className="w-full border border-border rounded-lg px-3 py-2 text-sm text-ink bg-surface placeholder-ink-3 focus:outline-none focus:border-accent-bright"
          />
        </div>

        {/* Results */}
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {loading && <p className="text-center text-sm text-ink-3 py-4">Поиск...</p>}
          {!loading && search.trim() && results.length === 0 && (
            <p className="text-center text-sm text-ink-3 py-4">Ничего не найдено</p>
          )}
          {results.map((item) => {
            const isCurrent = item.id === currentEquipmentId;
            const isSelected = item.id === selectedId;
            return (
              <button
                key={item.id}
                onClick={() => setSelectedId(item.id)}
                className={[
                  "w-full text-left px-3 py-2.5 rounded-lg mb-1 transition-colors flex items-center gap-3",
                  isSelected ? "bg-accent-soft border border-accent" : "hover:bg-surface-2 border border-transparent",
                ].join(" ")}
              >
                <div className={`w-4 h-4 rounded-full border-2 flex-shrink-0 ${isSelected ? "border-accent bg-accent" : "border-ink-3"}`} />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium text-ink truncate">{item.name}</p>
                  <p className="text-[11px] text-ink-3">{item.category} · {item.rentalRatePerShift}₽/смена</p>
                </div>
                {isCurrent && (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-ok-soft text-ok flex-shrink-0">
                    Текущая связь
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Footer */}
        {selectedId && selectedId !== currentEquipmentId && (
          <div className="px-5 py-3 border-t border-border">
            <button
              onClick={handleSave}
              disabled={saving}
              className="w-full py-2 text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent-bright disabled:opacity-50 transition-colors"
            >
              {saving ? "Сохраняем..." : "Привязать и запомнить"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/admin/imports/RebindModal.tsx
git commit -m "feat: add RebindModal for import corrections with alias learning"
```

---

### Task 11: SessionHistory Component

**Files:**
- Create: `apps/web/src/components/admin/imports/SessionHistory.tsx`

- [ ] **Step 1: Create SessionHistory component**

```typescript
"use client";

import type { ImportSession } from "./types";

type Props = {
  sessions: ImportSession[];
  onSelect: (session: ImportSession) => void;
};

function formatDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" });
}

function statusLabel(status: string) {
  const map: Record<string, { cls: string; label: string }> = {
    PARSING: { cls: "bg-amber-soft text-amber", label: "Загружен" },
    MATCHING: { cls: "bg-accent-soft text-accent", label: "Анализ" },
    REVIEW: { cls: "bg-accent-soft text-accent", label: "На проверке" },
    APPLYING: { cls: "bg-amber-soft text-amber", label: "Применяется" },
    COMPLETED: { cls: "bg-ok-soft text-ok", label: "Завершён" },
    EXPIRED: { cls: "bg-surface-2 text-ink-3", label: "Истёк" },
  };
  const m = map[status] ?? { cls: "bg-surface-2 text-ink-3", label: status };
  return <span className={`text-[10px] px-2 py-0.5 rounded-full ${m.cls}`}>{m.label}</span>;
}

function typeLabel(type: string) {
  return type === "OWN_PRICE_UPDATE" ? "📦 Каталог" : "📊 Конкурент";
}

export function SessionHistory({ sessions, onSelect }: Props) {
  if (sessions.length === 0) return null;

  return (
    <div className="mt-8">
      <h3 className="text-[13px] font-semibold text-ink mb-3">История импортов</h3>
      <div className="bg-surface border border-border rounded-lg overflow-hidden">
        {sessions.map((s) => (
          <div
            key={s.id}
            onClick={() => onSelect(s)}
            className="flex items-center justify-between px-4 py-3 border-b border-border/50 last:border-b-0 hover:bg-surface-2/50 cursor-pointer transition-colors"
          >
            <div className="flex items-center gap-3">
              <span className="text-[13px]">{typeLabel(s.type)}</span>
              <div>
                <p className="text-[13px] text-ink font-medium">{s.fileName}</p>
                <p className="text-[11px] text-ink-3">
                  {formatDate(s.createdAt)}
                  {s.competitorName && ` · ${s.competitorName}`}
                  {` · ${s.totalRows} позиций`}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              {s.appliedCount > 0 && (
                <span className="text-[11px] text-ink-3 font-mono">применено {s.appliedCount}</span>
              )}
              {statusLabel(s.status)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/admin/imports/SessionHistory.tsx
git commit -m "feat: add SessionHistory component for past imports list"
```

---

### Task 12: Page Shell + Remove Old PricesTab

**Files:**
- Rewrite: `apps/web/app/admin/imports/page.tsx`
- Modify: `apps/web/app/admin/page.tsx`

- [ ] **Step 1: Create the new imports page**

```typescript
"use client";

import { useState, useEffect, useCallback } from "react";
import type { ImportSession, AnalyzeResultOwn, AnalyzeResultCompetitor } from "@/components/admin/imports/types";
import { UploadStep } from "@/components/admin/imports/UploadStep";
import { AnalysisProgress } from "@/components/admin/imports/AnalysisProgress";
import { OwnCatalogReview } from "@/components/admin/imports/OwnCatalogReview";
import { CompetitorReview } from "@/components/admin/imports/CompetitorReview";
import { RebindModal } from "@/components/admin/imports/RebindModal";
import { SessionHistory } from "@/components/admin/imports/SessionHistory";

type Step = "upload" | "analyzing" | "review";

export default function ImportsPage() {
  const [step, setStep] = useState<Step>("upload");
  const [session, setSession] = useState<ImportSession | null>(null);
  const [ownResult, setOwnResult] = useState<AnalyzeResultOwn | null>(null);
  const [competitorResult, setCompetitorResult] = useState<AnalyzeResultCompetitor | null>(null);
  const [sessions, setSessions] = useState<ImportSession[]>([]);
  const [uploading, setUploading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [rebindRowId, setRebindRowId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load session history
  useEffect(() => {
    let cancelled = false;
    fetch("/api/import-sessions")
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setSessions(Array.isArray(data) ? data : data.items || []);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [step]);

  // Upload file
  async function handleUpload(file: File, type: "OWN_PRICE_UPDATE" | "COMPETITOR_IMPORT", competitorName?: string) {
    setUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const uploadRes = await fetch("/api/import-sessions/upload", { method: "POST", body: formData });
      if (!uploadRes.ok) throw new Error("Ошибка загрузки файла");
      const uploadData = await uploadRes.json();

      const newSession: ImportSession = {
        ...uploadData.session,
        type,
        competitorName: competitorName ?? null,
        aiSummary: null,
      };
      setSession(newSession);
      setStep("analyzing");

      // Update session type + competitor name on server
      // (the upload endpoint creates with defaults, analyze uses session.type)
      // We pass type via the existing map endpoint compatibility — but analyze reads session directly
      // For now, update the session type via map endpoint's first call

      // Trigger AI analysis
      const analyzeRes = await fetch(`/api/import-sessions/${uploadData.session.id}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!analyzeRes.ok) {
        const err = await analyzeRes.json().catch(() => ({}));
        throw new Error(err.message || "Ошибка анализа");
      }
      const analyzeData = await analyzeRes.json();

      if (type === "OWN_PRICE_UPDATE") {
        setOwnResult(analyzeData as AnalyzeResultOwn);
      } else {
        setCompetitorResult(analyzeData as AnalyzeResultCompetitor);
      }
      setStep("review");
    } catch (err: any) {
      setError(err.message || "Произошла ошибка");
      setStep("upload");
    } finally {
      setUploading(false);
    }
  }

  // Row actions (own catalog)
  async function handleRowAction(rowId: string, action: "ACCEPTED" | "REJECTED") {
    if (!session) return;
    await fetch(`/api/import-sessions/${session.id}/rows/${rowId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: action }),
    });
    // Update local state
    if (ownResult) {
      setOwnResult({
        ...ownResult,
        groups: ownResult.groups.map((g) => ({
          ...g,
          rows: g.rows.map((r) => (r.id === rowId ? { ...r, status: action } : r)),
        })),
      });
    }
  }

  async function handleBulkAction(action: "ACCEPTED" | "REJECTED", groupType?: string) {
    if (!session) return;
    const body: Record<string, unknown> = { status: action };
    if (groupType) body.action = groupType;
    await fetch(`/api/import-sessions/${session.id}/bulk-action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    // Update local state
    if (ownResult) {
      setOwnResult({
        ...ownResult,
        groups: ownResult.groups.map((g) => ({
          ...g,
          rows: g.rows.map((r) => {
            if (groupType && g.type !== groupType) return r;
            return { ...r, status: action };
          }),
        })),
      });
    }
  }

  // Apply changes
  async function handleApply() {
    if (!session) return;
    setApplying(true);
    try {
      const res = await fetch(`/api/import-sessions/${session.id}/apply`, { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "Ошибка применения");
      }
      setStep("upload");
      setSession(null);
      setOwnResult(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setApplying(false);
    }
  }

  // Export
  async function handleExport() {
    if (!session) return;
    const res = await fetch(`/api/import-sessions/${session.id}/export`);
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `comparison-${session.id}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Rebind
  async function handleRebind(equipmentId: string, equipmentName: string) {
    if (!session || !rebindRowId) return;
    const res = await fetch(`/api/import-sessions/${session.id}/rows/${rebindRowId}/rebind`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ equipmentId }),
    });
    if (!res.ok) return;

    // Update local state
    if (ownResult) {
      setOwnResult({
        ...ownResult,
        groups: ownResult.groups.map((g) => ({
          ...g,
          rows: g.rows.map((r) =>
            r.id === rebindRowId
              ? { ...r, equipmentId, equipmentName, matchSource: "manual_rebind", matchConfidence: 1.0 }
              : r,
          ),
        })),
      });
    }
    if (competitorResult) {
      setCompetitorResult({
        ...competitorResult,
        comparison: {
          ...competitorResult.comparison,
          matched: competitorResult.comparison.matched.map((r) =>
            r.id === rebindRowId
              ? { ...r, equipmentId, equipmentName, matchSource: "manual_rebind", matchConfidence: 1.0 }
              : r,
          ),
          unmatched: competitorResult.comparison.unmatched.filter((r) => r.id !== rebindRowId),
        },
      });
    }
    setRebindRowId(null);
  }

  // Find row info for rebind modal
  const rebindRow = rebindRowId
    ? ownResult?.groups.flatMap((g) => g.rows).find((r) => r.id === rebindRowId) ??
      competitorResult?.comparison.matched.find((r) => r.id === rebindRowId) ??
      competitorResult?.comparison.unmatched.find((r) => r.id === rebindRowId)
    : null;

  function handleSelectSession(s: ImportSession) {
    // For now, just re-analyze (could cache in future)
    setSession(s);
    if (s.status === "REVIEW" || s.status === "COMPLETED") {
      // Load existing analysis
      setStep("analyzing");
      fetch(`/api/import-sessions/${s.id}/analyze`, { method: "POST" })
        .then((r) => r.json())
        .then((data) => {
          if (s.type === "OWN_PRICE_UPDATE") setOwnResult(data);
          else setCompetitorResult(data);
          setStep("review");
        })
        .catch(() => setStep("upload"));
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-lg font-semibold text-ink">Импорт цен</h1>
        {step !== "upload" && (
          <button
            onClick={() => { setStep("upload"); setSession(null); setOwnResult(null); setCompetitorResult(null); setError(null); }}
            className="text-xs text-ink-3 hover:text-ink transition-colors"
          >
            ← Новый импорт
          </button>
        )}
      </div>

      {error && (
        <div className="p-3 mb-5 bg-rose-soft border border-rose/30 rounded-lg text-sm text-rose">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">Закрыть</button>
        </div>
      )}

      {step === "upload" && (
        <>
          <UploadStep onUpload={handleUpload} loading={uploading} />
          <SessionHistory sessions={sessions} onSelect={handleSelectSession} />
        </>
      )}

      {step === "analyzing" && session && (
        <AnalysisProgress fileName={session.fileName} />
      )}

      {step === "review" && session?.type === "OWN_PRICE_UPDATE" && ownResult && (
        <OwnCatalogReview
          result={ownResult}
          fileName={session.fileName}
          onAccept={(id) => handleRowAction(id, "ACCEPTED")}
          onReject={(id) => handleRowAction(id, "REJECTED")}
          onRebind={(id) => setRebindRowId(id)}
          onBulkAccept={(action) => handleBulkAction("ACCEPTED", action)}
          onBulkReject={(action) => handleBulkAction("REJECTED", action)}
          onApply={handleApply}
          onExport={handleExport}
          applying={applying}
        />
      )}

      {step === "review" && session?.type === "COMPETITOR_IMPORT" && competitorResult && (
        <CompetitorReview
          result={competitorResult}
          competitorName={session.competitorName || ""}
          fileName={session.fileName}
          onRebind={(id) => setRebindRowId(id)}
          onExport={handleExport}
        />
      )}

      {/* Rebind modal */}
      {rebindRowId && rebindRow && (
        <RebindModal
          sourceName={rebindRow.sourceName}
          currentEquipmentId={"equipmentId" in rebindRow ? (rebindRow.equipmentId as string | null) : null}
          onRebind={handleRebind}
          onClose={() => setRebindRowId(null)}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Update /admin page — replace PricesTab with Link card**

In `apps/web/app/admin/page.tsx`, find the PricesTab import and the tab that renders it. Replace the PricesTab tab content with a Link card to `/admin/imports`. The exact edit depends on the current tab structure, but the intent is:

Remove the `PricesTab` component import and its tab panel content. Add a simple Link card in its place:

```tsx
import Link from "next/link";

// In the tab content for "Цены" / "Импорт":
<Link
  href="/admin/imports"
  className="block p-6 bg-surface border border-border rounded-lg hover:border-accent transition-colors"
>
  <h3 className="text-[15px] font-semibold text-ink mb-1">📊 Импорт цен</h3>
  <p className="text-sm text-ink-3">Обновление каталога и сравнение с конкурентами</p>
</Link>
```

If PricesTab is the only content of that tab, the entire tab entry can be simplified to this Link card. If there are other elements in the same tab, keep them and just replace the PricesTab section.

- [ ] **Step 3: Verify Next.js builds**

```bash
cd apps/web && npx next build
```

Expected: build succeeds. Fix any TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/admin/imports/page.tsx apps/web/app/admin/page.tsx
git commit -m "feat: add imports page shell, replace PricesTab with link card"
```

---

## Self-Review

### Spec Coverage Check

| Spec Section | Task |
|-------------|------|
| Hybrid pipeline (7 steps) | Tasks 2-5 (analyzer + matching + orchestration + routes) |
| AI column mapping | Task 2 (analyzeFileStructure) |
| SlangAlias as first tier | Task 3 |
| Deterministic matching chain | Task 4 (analyzeWithAI calls mapAndMatch) |
| AI descriptions | Task 2 (generateDescriptions) |
| Own catalog review UI | Task 8 (ChangeCard + OwnCatalogReview) |
| Competitor comparison UI | Task 9 (CompetitorReview + UnmatchedSection) |
| KPI cards (competitor) | Task 9 (in CompetitorReview) |
| Rebind with dual alias save | Task 5 (rebind route) + Task 10 (RebindModal) |
| Session history | Task 11 (SessionHistory) |
| Entry point /admin/imports | Task 12 (page.tsx) |
| PricesTab → Link card | Task 12 |
| Schema changes (3 fields) | Task 1 |
| New endpoint: analyze | Task 5 |
| New endpoint: rebind | Task 5 |
| Summary chips | Task 8 (OwnCatalogReview) |
| Group-level accept/reject | Task 8 (OwnCatalogReview) |
| Anomaly flagging | Preserved from existing computeDiffForSession |
| Filter pills (competitor) | Task 9 (CompetitorReview) |
| Export XLSX | Task 12 (handleExport, reuses existing endpoint) |

### Placeholder Scan

No TBD, TODO, or "implement later" found. All steps have code blocks.

### Type Consistency

- `ColumnMapping` defined in both importAnalyzer.ts (Task 2) and importSession.ts (existing). The new one in importAnalyzer.ts is self-contained; the existing one in importSession.ts is used by mapAndMatch. Both have the same fields. The analyzeWithAI function bridges them.
- `ImportRow` type in frontend types.ts matches the row shape returned by analyzeWithAI.
- `AnalyzeResultOwn` and `AnalyzeResultCompetitor` match the response shapes from analyzeWithAI.
- `matchSource` values consistent: "slang", "competitor_alias", "exact", "fuzzy", "gemini", "manual_rebind" used in both backend and frontend matchTag().
