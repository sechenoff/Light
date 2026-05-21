# Addon Estimate (доб-смета) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Каждый добор во время выдачи создаёт/обновляет отдельный **ADDON Estimate** (snapshot с lines, скидкой как у MAIN), доступный клиенту как PDF/XLSX. `Booking.finalAmount` корректно учитывает доборы. Существующая дыра «добор не виден в финансах» закрывается.

**Architecture:** Multiple Estimates на бронь (`Estimate.kind ∈ {MAIN, ADDON}`, compound unique `[bookingId, kind]`). Source-of-truth для ADDON Estimate — новая таблица `AddonRecord` (per-добор дельта). Live: каждый успешный `addExtraItem` → `AddonRecord.create` → `recomputeAddonEstimate` → `recomputeBookingFinance`. Существующая smeta-machinery (Estimate / lines / PDF / XLSX) переиспользуется без дублирования.

**Tech Stack:** Express + Prisma 6 (SQLite) + Zod (`apps/api`); Next.js 14 + React 18 + Tailwind 3 + Vitest + RTL (`apps/web`); PDFKit + ExcelJS для экспорта.

**Spec:** `docs/superpowers/specs/2026-05-21-addon-estimate-design.md`
**Branch:** `feat/addon-estimate` (уже создан, спека закоммичена)
**Working repo:** `/Users/sechenov/Documents/light-rental-system`

---

## Repo conventions reminder

- **Russian labels** в UI; **semantic tokens only** (`text-ink|ink-2|ink-3`, `bg-emerald-soft|amber-soft|rose-soft`, etc.).
- Test runner: backend `npm run test --workspace=apps/api -- <pattern>`, frontend `npm run test --workspace=apps/web -- <pattern>`.
- **Never** `git commit --no-verify` / `--no-gpg-sign` / `-c commit.gpgsign=false`.
- **Don't** `git add -A` — локальный tree имеет sync-conflict-файлы. Только explicit paths.
- `BookingPaymentStatus` enum использует `"PAID"` (не `"FULLY_PAID"` — это была неточность в спеке; в коде используем настоящий enum value).
- `prisma db push --accept-data-loss` для применения schema-изменений (используется в существующем deploy.sh).

---

## File Structure

### Schema changes

| File | Изменение |
|---|---|
| `apps/api/prisma/schema.prisma` | + `enum EstimateKind { MAIN, ADDON }` (рядом с другими enum'ами, например после `enum BookingStatus`); `Estimate.bookingId @unique` → `@@unique([bookingId, kind])`; добавить `Estimate.kind EstimateKind @default(MAIN)`; в `model Booking`: `estimate Estimate?` → `estimates Estimate[]`; + `Booking.addonAmount Decimal @default(0)`; + `model AddonRecord { … }`. Existing `Equipment` (~line 226), `Booking` (~283), `BookingItem` (~476), `ScanSession` (~556), `Estimate` (~512). |

### Create

| File | Purpose |
|---|---|
| `apps/api/src/services/addonEstimate.ts` | `recomputeAddonEstimate(bookingId)`: агрегирует AddonRecord'ы и пересоздаёт ADDON Estimate. |
| `apps/api/src/routes/addonEstimates.ts` | `GET /api/addon-estimates/:bookingId` (JSON), `/export/pdf`, `/export/xlsx`. |
| `apps/api/src/services/smetaExport/buildFullDocument.ts` | `buildFullSmeta({ booking, main, addon })` — возвращает `SmetaFullExportDocument` (main + addon секции). |
| `apps/api/src/services/smetaExport/renderFullPdf.ts` | `writeFullSmetaPdf(res, fullDoc, filename)` — main page + (опционально) addon page. |
| `apps/api/src/services/smetaExport/renderFullXlsx.ts` | `writeFullSmetaXlsx(res, fullDoc, filename)` — two-sheet workbook. |
| `apps/api/src/__tests__/addonEstimate.test.ts` | unit для `recomputeAddonEstimate`. |
| `apps/api/src/__tests__/addonFinanceFlow.test.ts` | integration: confirm → addExtraItem → addon + finance. |
| `apps/api/src/__tests__/addonEstimateRoutes.test.ts` | supertest для `/api/addon-estimates/...`. |
| `apps/api/src/__tests__/fullEstimateRoutes.test.ts` | supertest для `/api/bookings/:id/full-estimate/export/...`. |
| `apps/web/src/components/bookings/AddonEstimateSection.tsx` | UI-блок «Доб-смета» на странице брони (out-of-warehouse). |
| `apps/web/src/components/bookings/__tests__/AddonEstimateSection.test.tsx` | tests для секции. |

### Modify

| File | Изменение |
|---|---|
| `apps/api/src/services/checklistService.ts` | `addExtraItem`: внутри tx — `tx.addonRecord.create(...)`; вне tx — `recomputeAddonEstimate(bookingId).catch(...)` перед `recomputeBookingFinance`. |
| `apps/api/src/services/finance.ts` | `recomputeBookingFinance`: вместо `booking.estimate` загружать `main = findFirst({where:{bookingId, kind:"MAIN"}})` + `addon = findFirst({...kind:"ADDON"})`; складывать; писать `addonAmount`. |
| `apps/api/src/services/bookings.ts` | `confirmBooking` использует `tx.estimate.deleteMany({where:{bookingId, kind:"MAIN"}})` + create с `kind:"MAIN"`; submit-for-approval estimate creation — то же. Все `if (booking.estimate)` → `if (booking.estimates.find(e=>e.kind==="MAIN"))`. |
| `apps/api/src/services/warehouseScan.ts` | `ReconciliationSummary` interface + `completeSession`: после `recomputeBookingFinance` загрузить обновлённый booking и заполнить `mainAfterDiscount/addonAfterDiscount/finalAmount` в summary. |
| `apps/api/src/services/smetaExport/buildDocument.ts` | `buildSmetaFromPersistedEstimate`: принимать `estimate.kind`, менять `documentTitleRu` ("Смета-добор" если ADDON). |
| `apps/api/src/services/smetaExport/index.ts` | + экспорт `buildFullSmeta`, `writeFullSmetaPdf`, `writeFullSmetaXlsx`, type `SmetaFullExportDocument`. |
| `apps/api/src/services/smetaExport/types.ts` | + `SmetaFullExportDocument = { main: SmetaExportDocument; addon: SmetaExportDocument \| null }`. |
| `apps/api/src/routes/estimates.ts` | Заменить `findUnique({where:{id}})` для нашего URL pattern? Нет — URL уже `/:estimateId`, не меняем. Но конкретно `routes/bookings.ts:1610, 1697, 281` (`booking.estimate.*` обращения) — заменить на `booking.estimates.find(e=>e.kind==="MAIN")` либо отдельный запрос. |
| `apps/api/src/routes/invoices.ts` | `:267-280` — `booking.estimate.*` → `booking.estimates.find(e=>e.kind==="MAIN")?.*`. |
| `apps/api/src/routes/bookings.ts` | + 2 новых route: `GET /api/bookings/:id/full-estimate/export/pdf` и `/xlsx`. |
| `apps/api/src/utils/serializeDecimal.ts` | `:80` `b.estimate` → `b.estimates.find(e=>e.kind==="MAIN")`. |
| `apps/api/src/__tests__/customBookingItem.test.ts` | `:309` `prisma.estimate.findUnique({where:{bookingId}})` → `findFirst({where:{bookingId, kind:"MAIN"}})`. + Дополнительная проверка: AddonRecord создан после `addExtraItem`. |
| `apps/api/src/__tests__/multiVehicle.test.ts` | `:377, 435` `res.body.booking.estimate` → серверная сериализация теперь отдаёт `estimates`-массив или `mainEstimate` поле — посмотреть как именно изменили `serializeDecimal`, обновить ассерт соответствующе. |
| `apps/api/src/__tests__/approval.test.ts` | `:400-401` `fresh!.estimate` → `fresh!.estimates.find(...)`. |
| `apps/api/src/index.ts` | Подключить `addonEstimatesRouter` в `app.use("/api/addon-estimates", addonEstimatesRouter)`. |
| `apps/web/src/components/warehouse/api.ts` | + `getAddonEstimate(bookingId)` метод; mirror методы для PDF URL helper. |
| `apps/web/src/components/warehouse/types.ts` | + `AddonEstimateLine`, `AddonEstimateView`; расширить `CompleteResult` тремя финансовыми полями. |
| `apps/web/src/components/warehouse/AddonSearch.tsx` | + `bookingId` prop; success-line с PDF-ссылкой «Открыть PDF →» через `<a href={`/api/addon-estimates/{bookingId}/export/pdf`} target="_blank">`. |
| `apps/web/src/components/warehouse/IssueChecklist.tsx` | Передаёт `bookingId={state.bookingId}` в AddonSearch; в summary phase — useEffect загружает `getAddonEstimate(state.bookingId)`, рендерит блок «Доб-смета». |
| `apps/web/src/components/warehouse/IssueResultView.tsx` | Новый блок «Финансы»: рендерится если `Number(result.addonAfterDiscount) > 0`; показывает «Согласовано / Доб-смета / К оплате» + 2 кнопки PDF. |
| `apps/web/src/components/warehouse/__tests__/AddonSearch.test.tsx` | + тест на PDF-ссылку в success-line. |
| `apps/web/src/components/warehouse/__tests__/IssueChecklist.test.tsx` | + тест: `bookingId` пробрасывается в AddonSearch. |
| `apps/web/src/components/warehouse/__tests__/IssueSummary.test.tsx` | + тест: блок «Доб-смета» рендерится если addon существует; не рендерится если null. |
| `apps/web/src/components/warehouse/__tests__/IssueResultView.test.tsx` | + тест: блок «Финансы» рендерится только если `addonAfterDiscount > 0`. |

---

## Task 0: Branch sanity check

- [ ] **Step 1: Verify branch + tree state**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  git status -sb | head -1 && \
  git log --oneline -3
```

Expected: branch `feat/addon-estimate`, последний коммит — спека (commit message starts with `docs: addon-estimate design spec`).

- [ ] **Step 2: Baseline tests on `apps/api` should be roughly green (except the 10 known pre-existing failures from `problemItemService` / `repairPhotos` stale-prisma drift — those aren't introduced by this work)**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  npm run test --workspace=apps/api -- \
    src/__tests__/customBookingItem.test.ts \
    src/__tests__/multiVehicle.test.ts \
    src/__tests__/approval.test.ts 2>&1 | tail -10
```

Expected: all three test files pass (используем их как baseline до того, как ломать `booking.estimate`).

---

## Task 1: Schema — add EstimateKind + AddonRecord + Booking.addonAmount + relation change

**Files:**
- Modify: `apps/api/prisma/schema.prisma`

This task changes the schema only. Tests will fail after this — Task 2 fixes them.

- [ ] **Step 1: Add `EstimateKind` enum**

In `apps/api/prisma/schema.prisma`, after the existing `enum ScanSessionStatus { ... }` block (~line 128, near other enums), add:

```prisma
enum EstimateKind {
  MAIN
  ADDON
}
```

- [ ] **Step 2: Modify `Estimate` model — replace `@unique` on bookingId with compound, add `kind`**

Find the existing `Estimate` model (~line 512). Replace:

```prisma
model Estimate {
  id              String   @id @default(cuid())
  bookingId       String   @unique
  booking         Booking  @relation(fields: [bookingId], references: [id], onDelete: Cascade)
  ...
}
```

with:

```prisma
model Estimate {
  id              String       @id @default(cuid())
  bookingId       String
  kind            EstimateKind @default(MAIN)
  booking         Booking      @relation(fields: [bookingId], references: [id], onDelete: Cascade)

  currency        String   @default("RUB")
  shifts          Int

  subtotal        Decimal
  discountPercent Decimal?
  discountAmount  Decimal
  totalAfterDiscount Decimal

  commentSnapshot String?
  optionalNote            String?
  includeOptionalInExport Boolean @default(false)
  hoursSummaryText      String?

  createdAt DateTime @default(now())

  lines EstimateLine[]

  @@unique([bookingId, kind])
}
```

- [ ] **Step 3: Modify `Booking` model — relation field, addonAmount**

In `model Booking { ... }` (~line 283), find the line:

```prisma
estimate Estimate?
```

Replace with:

```prisma
estimates Estimate[]
```

Then add (next to other Decimal fields like `amountOutstanding`):

```prisma
addonAmount Decimal @default(0)
```

- [ ] **Step 4: Add `AddonRecord` model**

After `model EstimateLine { ... }` (find by `grep -n "^model EstimateLine" apps/api/prisma/schema.prisma`), add:

```prisma
/// Запись о доборе во время ISSUE-сессии (дельта-источник для ADDON Estimate).
/// addExtraItem upsert'ит BookingItem с {quantity: increment: N} — теряется
/// след дельты («1 было изначально, 10 — добор»). AddonRecord фиксирует
/// именно ДОБАВЛЕННОЕ qty.
model AddonRecord {
  id                   String   @id @default(cuid())
  bookingId            String
  sessionId            String?
  bookingItemId        String
  equipmentId          String?
  quantity             Int
  acknowledgedConflict Boolean  @default(false)
  createdBy            String
  createdAt            DateTime @default(now())

  booking     Booking      @relation(fields: [bookingId], references: [id], onDelete: Cascade)
  session     ScanSession? @relation(fields: [sessionId], references: [id], onDelete: SetNull)
  bookingItem BookingItem  @relation(fields: [bookingItemId], references: [id], onDelete: Cascade)
  equipment   Equipment?   @relation(fields: [equipmentId], references: [id], onDelete: SetNull)

  @@index([bookingId])
  @@index([sessionId])
}
```

Also add the back-relations in three existing models:

In `model Booking` — add:
```prisma
addonRecords AddonRecord[]
```

In `model BookingItem` — add:
```prisma
addonRecords AddonRecord[]
```

In `model Equipment` — add:
```prisma
addonRecords AddonRecord[]
```

In `model ScanSession` — add:
```prisma
addonRecords AddonRecord[]
```

- [ ] **Step 5: Apply schema to local dev DB + regenerate Prisma client**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  DATABASE_URL="file:/Users/sechenov/Documents/light-rental-system/apps/api/dev.db" \
  npx prisma db push --schema=apps/api/prisma/schema.prisma --accept-data-loss 2>&1 | tail -10
```

Expected: «Your database is now in sync with your Prisma schema». Prisma client auto-regenerated. Existing rows preserved (Estimate's `kind` defaults to `MAIN`).

- [ ] **Step 6: Commit schema migration**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  git add apps/api/prisma/schema.prisma && \
  git commit -m "feat(api): schema — EstimateKind, AddonRecord, Booking.addonAmount

- Estimate.kind (MAIN|ADDON) + compound @@unique([bookingId, kind])
- Booking.estimate Estimate? → estimates Estimate[]
- AddonRecord (per-добор дельта, source for ADDON Estimate)
- Booking.addonAmount денормализованная сумма

Tests will fail after this commit — Task 2 fixes the callsites
that used booking.estimate as 1:1."
```

Expected: commit lands. Backend tests will be red until Task 2.

---

## Task 2: Refactor callsites — `booking.estimate` → `booking.estimates.find(...)` / explicit findFirst

**Files:**
- Modify: `apps/api/src/services/finance.ts`
- Modify: `apps/api/src/services/bookings.ts`
- Modify: `apps/api/src/routes/bookings.ts`
- Modify: `apps/api/src/routes/invoices.ts`
- Modify: `apps/api/src/utils/serializeDecimal.ts`
- Modify: `apps/api/src/__tests__/customBookingItem.test.ts`
- Modify: `apps/api/src/__tests__/multiVehicle.test.ts`
- Modify: `apps/api/src/__tests__/approval.test.ts`

Approach: keep callsites idiomatic by introducing a small helper for «main estimate of a booking», then refactor each callsite minimally.

- [ ] **Step 1: Add helper in `finance.ts`**

In `apps/api/src/services/finance.ts`, near the top after imports, add:

```ts
/** Returns the MAIN estimate of a booking or null. Used everywhere callsites
 *  previously read `booking.estimate` (1:1). With compound unique on
 *  [bookingId, kind], the relation is 1:N — this helper centralizes the
 *  filter so callsites stay readable. */
export async function getMainEstimate(bookingId: string) {
  return prisma.estimate.findFirst({
    where: { bookingId, kind: "MAIN" },
    include: { lines: true },
  });
}
```

- [ ] **Step 2: Refactor `recomputeBookingFinance`**

In `apps/api/src/services/finance.ts:81-153`, replace the entire `recomputeBookingFinance` function body (keeping the export signature) with:

```ts
export async function recomputeBookingFinance(bookingId: string, txArg?: TxLike) {
  const tx = txArg ?? prisma;
  const booking = await tx.booking.findUnique({
    where: { id: bookingId },
    include: {
      estimates: true, // ← changed: was `estimate: true` (1:1)
      payments: {
        where: {
          direction: "INCOME",
          voidedAt: null,
          OR: [{ status: "RECEIVED" }, { receivedAt: { not: null } }],
        },
        select: { amount: true, paymentDate: true, createdAt: true },
      },
    },
  });
  if (!booking) return null;

  const previousStatus = booking.paymentStatus;
  const main  = booking.estimates.find((e) => e.kind === "MAIN")  ?? null;
  const addon = booking.estimates.find((e) => e.kind === "ADDON") ?? null;

  const totalEstimateAmount = main
    ? new Decimal(main.subtotal.toString())
    : new Decimal(booking.totalEstimateAmount.toString());
  const discountAmount = main
    ? new Decimal(main.discountAmount.toString())
    : new Decimal(booking.discountAmount.toString());

  const mainAfterDiscount  = main  ? new Decimal(main.totalAfterDiscount.toString())  : new Decimal(0);
  const addonAfterDiscount = addon ? new Decimal(addon.totalAfterDiscount.toString()) : new Decimal(0);
  // Equipment after discount = MAIN + ADDON (both already include their own discount).
  // For bookings without ANY estimate (DRAFT pre-confirm), fall back to legacy stored value.
  const equipmentAfterDiscount = main
    ? mainAfterDiscount.add(addonAfterDiscount)
    : new Decimal(booking.finalAmount.toString());

  const transportSubtotal = booking.transportSubtotalRub
    ? new Decimal(booking.transportSubtotalRub.toString())
    : new Decimal(0);
  const finalAmount = equipmentAfterDiscount.add(transportSubtotal);
  const amountPaid  = sumDec(booking.payments.map((p) => p.amount.toString()));
  const amountOutstanding = Decimal.max(finalAmount.sub(amountPaid), new Decimal(0));
  const status = calcBookingPaymentStatus({
    finalAmount,
    amountPaid,
    expectedPaymentDate: booking.expectedPaymentDate,
  });
  const isFullyPaid = status === "PAID";
  const actualPaymentDate = isFullyPaid
    ? booking.payments
        .map((p) => p.paymentDate ?? p.createdAt)
        .sort((a, b) => b.getTime() - a.getTime())[0] ?? null
    : null;

  const updated = await tx.booking.update({
    where: { id: bookingId },
    data: {
      totalEstimateAmount: totalEstimateAmount.toDecimalPlaces(2).toString(),
      discountAmount: discountAmount.toDecimalPlaces(2).toString(),
      finalAmount: finalAmount.toDecimalPlaces(2).toString(),
      addonAmount: addonAfterDiscount.toDecimalPlaces(2).toString(),
      amountPaid: amountPaid.toDecimalPlaces(2).toString(),
      amountOutstanding: amountOutstanding.toDecimalPlaces(2).toString(),
      paymentStatus: status,
      isFullyPaid,
      actualPaymentDate,
    },
  });

  if (previousStatus !== status) {
    await tx.bookingFinanceEvent.create({
      data: {
        bookingId,
        eventType: "PAYMENT_STATUS_CHANGED",
        statusFrom: previousStatus,
        statusTo: status,
        amountDelta: amountPaid.toDecimalPlaces(2).toString(),
      },
    });
  }

  return updated;
}
```

- [ ] **Step 3: Refactor `services/bookings.ts` — estimate creation/delete**

In `apps/api/src/services/bookings.ts`, find the block ~line 462 (inside `submitForApproval` or similar):

```ts
if (booking.estimate) {
  await tx.estimate.delete({ where: { id: booking.estimate.id } });
}

await tx.estimate.create({
  data: {
    ...estimateData,
    bookingId,
    lines: { create: linesData },
  },
});
```

Replace with:

```ts
// Удаляем существующий MAIN Estimate (если есть) — ADDON оставляем нетронутым.
const existingMain = booking.estimates.find((e) => e.kind === "MAIN");
if (existingMain) {
  await tx.estimate.delete({ where: { id: existingMain.id } });
}

await tx.estimate.create({
  data: {
    ...estimateData,
    bookingId,
    kind: "MAIN",
    lines: { create: linesData },
  },
});
```

And the `booking` load earlier in this function — change `include: { estimate: true }` to `include: { estimates: true }`.

- [ ] **Step 4: Refactor `services/bookings.ts:710` — the `deleteMany` in `confirmBooking`**

Find:

```ts
await tx.estimate.deleteMany({ where: { bookingId } });
```

Replace with:

```ts
// Удаляем только MAIN — ADDON Estimate (если когда-то будет создан) живёт
// отдельным жизненным циклом через addExtraItem → recomputeAddonEstimate.
await tx.estimate.deleteMany({ where: { bookingId, kind: "MAIN" } });
```

Then below, the existing `await tx.estimate.create({ data: {...} })` — add `kind: "MAIN"` to the data block.

- [ ] **Step 5: Refactor `routes/bookings.ts` — 3 call sites**

The references are at lines 281, 1610, 1697 per the spec. In each location:

Pattern 1 (`:281`):

```ts
totalAfterDiscount: booking.estimate?.totalAfterDiscount?.toString() ?? "0",
```

becomes:

```ts
totalAfterDiscount: booking.estimates?.find((e) => e.kind === "MAIN")?.totalAfterDiscount?.toString() ?? "0",
```

Pattern 2 (`:1610-1623`):

```ts
if (booking.estimate) {
  lines = booking.estimate.lines.map(...);
  subtotal = booking.estimate.subtotal.toString();
  ...
}
```

becomes:

```ts
const mainEstimate = booking.estimates?.find((e) => e.kind === "MAIN");
if (mainEstimate) {
  lines = mainEstimate.lines.map(...);
  subtotal = mainEstimate.subtotal.toString();
  ...
}
```

Pattern 3 (`:1697-1705`): same as Pattern 2, replace `booking.estimate` with `mainEstimate` derived inline.

For the `include: { estimate: ... }` clauses in the corresponding `prisma.booking.findUnique` calls, change to `include: { estimates: { include: { lines: true } } }`.

- [ ] **Step 6: Refactor `routes/invoices.ts:267-280`**

Same pattern: introduce `const mainEstimate = booking.estimates?.find((e) => e.kind === "MAIN");` after the booking load, then change every `booking.estimate.X` to `mainEstimate.X`. Update the `include` to `estimates: { include: { lines: true } }`.

- [ ] **Step 7: Refactor `utils/serializeDecimal.ts:80`**

Find:

```ts
estimate: b.estimate ? serializeEstimateForJson(b.estimate) : null,
```

Replace with:

```ts
// Преобразуем массив estimates в backward-compatible JSON: top-level `estimate`
// = MAIN (для существующих клиентов), `addonEstimate` = ADDON (новое поле).
estimate: (() => {
  const main = b.estimates?.find((e: any) => e.kind === "MAIN");
  return main ? serializeEstimateForJson(main) : null;
})(),
addonEstimate: (() => {
  const addon = b.estimates?.find((e: any) => e.kind === "ADDON");
  return addon ? serializeEstimateForJson(addon) : null;
})(),
```

Adjust the surrounding type signature if needed: if `serializeBookingForJson` accepts a `BookingWithRelations` type that previously had `estimate: …`, change it to `estimates: Estimate[]`.

- [ ] **Step 8: Update existing tests that read `booking.estimate`**

In `apps/api/src/__tests__/customBookingItem.test.ts:309`:

```ts
const estimate = await prisma.estimate.findUnique({ where: { bookingId } });
```

becomes:

```ts
const estimate = await prisma.estimate.findFirst({
  where: { bookingId, kind: "MAIN" },
});
```

In `apps/api/src/__tests__/multiVehicle.test.ts:377` and `:435`:

```ts
const est = res.body.booking.estimate;
```

stays the same — the response shape is backward-compatible thanks to Step 7's serializer change.

In `apps/api/src/__tests__/approval.test.ts:400-401`:

```ts
expect(fresh!.estimate).not.toBeNull();
expect(fresh!.estimate!.lines.length).toBeGreaterThan(0);
```

becomes (after updating the `include` in the prior query from `estimate: true` to `estimates: { include: { lines: true } }`):

```ts
const mainEst = fresh!.estimates.find((e) => e.kind === "MAIN");
expect(mainEst).toBeTruthy();
expect(mainEst!.lines.length).toBeGreaterThan(0);
```

- [ ] **Step 9: Run all in-scope backend tests + verify green**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  npm run test --workspace=apps/api -- \
    src/__tests__/customBookingItem.test.ts \
    src/__tests__/multiVehicle.test.ts \
    src/__tests__/approval.test.ts \
    src/__tests__/api.test.ts \
    src/__tests__/paymentService.test.ts \
    src/__tests__/payments.routes.test.ts \
    src/__tests__/pdfEndpoints.test.ts \
    src/__tests__/legacyBookingImport.test.ts 2>&1 | tail -10
```

Expected: все тесты зелёные. Если в каком-то месте упало с «Cannot read property 'lines' of undefined» — значит остался необновлённый callsite, найти через `grep -rn "booking\.estimate" apps/api/src`.

- [ ] **Step 10: Commit**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  git add apps/api/src/services/finance.ts \
          apps/api/src/services/bookings.ts \
          apps/api/src/routes/bookings.ts \
          apps/api/src/routes/invoices.ts \
          apps/api/src/utils/serializeDecimal.ts \
          apps/api/src/__tests__/customBookingItem.test.ts \
          apps/api/src/__tests__/multiVehicle.test.ts \
          apps/api/src/__tests__/approval.test.ts && \
  git commit -m "refactor(api): callsites use estimates[].find(kind==='MAIN') instead of booking.estimate

Following the schema change (Estimate.bookingId is now part of compound
unique with kind), Booking.estimate → Booking.estimates[]. All callsites
refactored to filter by kind explicitly. Backward-compatible JSON
serialization: response.booking.estimate still maps to MAIN; new
response.booking.addonEstimate exposes ADDON (always null until feature
ships)."
```

---

## Task 3: `services/addonEstimate.ts` — new service

**Files:**
- Create: `apps/api/src/services/addonEstimate.ts`
- Create: `apps/api/src/__tests__/addonEstimate.test.ts`

- [ ] **Step 1: Create the failing test file**

Create `apps/api/src/__tests__/addonEstimate.test.ts`:

```ts
/**
 * Интеграционный тест: recomputeAddonEstimate.
 *  - пустой набор → удаляет ADDON Estimate
 *  - 3 records по 2 equipment → ADDON с 2 lines, корректные totals
 *  - та же скидка %, что у MAIN
 *  - идемпотентность повторного вызова
 *  - нет MAIN → no-op
 */

import path from "path";
import { execSync } from "child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-addon-est.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-addon-est";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-addon-est";
process.env.WAREHOUSE_SECRET = "test-warehouse-addon-est-min16ch";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-addon-est-min16chars0";

let prisma: any;
let clientId: string;
let equipmentAId: string;
let equipmentBId: string;
let bookingId: string;
let sessionId: string;
let bookingItemAId: string;

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

  const client = await prisma.client.create({
    data: { name: "Addon est test", phone: "+70000000999" },
  });
  clientId = client.id;

  const eqA = await prisma.equipment.create({
    data: {
      importKey: "addon-est-A",
      name: "Vmount Battery",
      category: "Электрика",
      rentalRatePerShift: "1000",
      stockTrackingMode: "COUNT",
    },
  });
  equipmentAId = eqA.id;

  const eqB = await prisma.equipment.create({
    data: {
      importKey: "addon-est-B",
      name: "Adapter Vmount",
      category: "Электрика",
      rentalRatePerShift: "500",
      stockTrackingMode: "COUNT",
    },
  });
  equipmentBId = eqB.id;

  const booking = await prisma.booking.create({
    data: {
      clientId,
      projectName: "Addon test booking",
      startDate: new Date(),
      endDate: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
      status: "CONFIRMED",
    },
  });
  bookingId = booking.id;

  // MAIN Estimate с скидкой 50% и shifts=2
  await prisma.estimate.create({
    data: {
      bookingId,
      kind: "MAIN",
      shifts: 2,
      subtotal: "10000",
      discountPercent: "50",
      discountAmount: "5000",
      totalAfterDiscount: "5000",
    },
  });

  const bi = await prisma.bookingItem.create({
    data: { bookingId, equipmentId: equipmentAId, quantity: 1 },
  });
  bookingItemAId = bi.id;

  const session = await prisma.scanSession.create({
    data: {
      bookingId,
      workerName: "test",
      operation: "ISSUE",
      status: "ACTIVE",
    },
  });
  sessionId = session.id;
});

afterAll(async () => {
  await prisma?.$disconnect?.();
});

describe("recomputeAddonEstimate", () => {
  it("no AddonRecord → ADDON Estimate is deleted (or not created)", async () => {
    const svc = await import("../services/addonEstimate");
    await svc.recomputeAddonEstimate(bookingId);
    const addon = await prisma.estimate.findFirst({ where: { bookingId, kind: "ADDON" } });
    expect(addon).toBeNull();
  });

  it("aggregates 3 records over 2 equipment into 2 lines with same discount % as MAIN", async () => {
    // 2× Vmount + 5× Vmount + 1× Adapter Vmount
    await prisma.addonRecord.createMany({
      data: [
        { bookingId, sessionId, bookingItemId: bookingItemAId, equipmentId: equipmentAId, quantity: 2, createdBy: "test" },
        { bookingId, sessionId, bookingItemId: bookingItemAId, equipmentId: equipmentAId, quantity: 5, createdBy: "test" },
      ],
    });
    // Adapter — separate BookingItem (test multiline aggregation)
    const biB = await prisma.bookingItem.create({
      data: { bookingId, equipmentId: equipmentBId, quantity: 1 },
    });
    await prisma.addonRecord.create({
      data: { bookingId, sessionId, bookingItemId: biB.id, equipmentId: equipmentBId, quantity: 1, createdBy: "test" },
    });

    const svc = await import("../services/addonEstimate");
    await svc.recomputeAddonEstimate(bookingId);

    const addon = await prisma.estimate.findFirst({
      where: { bookingId, kind: "ADDON" },
      include: { lines: true },
    });
    expect(addon).toBeTruthy();
    expect(addon.shifts).toBe(2);
    expect(addon.discountPercent?.toString()).toBe("50");
    expect(addon.lines).toHaveLength(2);

    // Vmount: 7 шт × 1000 ₽/смена × 2 смены = 14 000 ₽
    const vmount = addon.lines.find((l: any) => l.equipmentId === equipmentAId);
    expect(vmount).toBeTruthy();
    expect(vmount.quantity).toBe(7);
    expect(vmount.lineSum.toString()).toBe("14000");

    // Adapter: 1 шт × 500 × 2 = 1 000 ₽
    const adapter = addon.lines.find((l: any) => l.equipmentId === equipmentBId);
    expect(adapter.quantity).toBe(1);
    expect(adapter.lineSum.toString()).toBe("1000");

    // Subtotal = 14 000 + 1 000 = 15 000. Скидка 50% = 7 500. После скидки = 7 500.
    expect(addon.subtotal.toString()).toBe("15000");
    expect(addon.discountAmount.toString()).toBe("7500");
    expect(addon.totalAfterDiscount.toString()).toBe("7500");
  });

  it("idempotent re-run produces the same snapshot", async () => {
    const svc = await import("../services/addonEstimate");
    const before = await prisma.estimate.findFirst({
      where: { bookingId, kind: "ADDON" },
    });
    await svc.recomputeAddonEstimate(bookingId);
    const after = await prisma.estimate.findFirst({
      where: { bookingId, kind: "ADDON" },
    });
    expect(after.subtotal.toString()).toBe(before.subtotal.toString());
    expect(after.totalAfterDiscount.toString()).toBe(before.totalAfterDiscount.toString());
    // delete-then-create → new ID expected (snapshot replaced atomically)
    expect(after.id).not.toBe(before.id);
  });

  it("no-op when booking has no MAIN Estimate", async () => {
    const orphan = await prisma.booking.create({
      data: {
        clientId,
        projectName: "DRAFT booking",
        startDate: new Date(),
        endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
        status: "DRAFT",
      },
    });
    const svc = await import("../services/addonEstimate");
    await expect(svc.recomputeAddonEstimate(orphan.id)).resolves.toBeUndefined();
    const addon = await prisma.estimate.findFirst({
      where: { bookingId: orphan.id, kind: "ADDON" },
    });
    expect(addon).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test — expect failure (service does not exist)**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  npm run test --workspace=apps/api -- src/__tests__/addonEstimate.test.ts 2>&1 | tail -10
```

Expected: «Cannot find module '../services/addonEstimate'».

- [ ] **Step 3: Create `apps/api/src/services/addonEstimate.ts`**

```ts
/**
 * Полная пересборка ADDON Estimate брони из AddonRecord'ов.
 * Идемпотентна: delete старый ADDON + create новый (или просто delete если
 * AddonRecord'ов больше нет).
 *
 * Алгоритм:
 *  1. Загружает MAIN Estimate (для shifts + discountPercent).
 *     Без MAIN бронь не CONFIRMED → доборов быть не должно → no-op.
 *  2. Фильтрует AddonRecord'ы: только из сессий в статусе ACTIVE/COMPLETED
 *     (CANCELLED сессии исключены — оператор отменил, оплачивать не надо).
 *  3. Сворачивает по equipmentId, суммирует quantity.
 *  4. Считает lineSum = unitPrice × totalQty × main.shifts.
 *  5. Применяет MAIN.discountPercent к subtotal.
 *  6. Delete-then-create по [bookingId, kind: ADDON].
 *     Если lines пустой — ADDON Estimate не создаётся вовсе (старый удаляется).
 */
import Decimal from "decimal.js";

import { prisma } from "../prisma";

export async function recomputeAddonEstimate(bookingId: string): Promise<void> {
  const main = await prisma.estimate.findFirst({
    where: { bookingId, kind: "MAIN" },
  });
  if (!main) return;

  const records = await prisma.addonRecord.findMany({
    where: {
      bookingId,
      OR: [
        { sessionId: null },
        { session: { status: { in: ["ACTIVE", "COMPLETED"] } } },
      ],
    },
    include: { equipment: true },
  });

  type Group = { eq: NonNullable<(typeof records)[number]["equipment"]>; totalQty: number };
  const byEq = new Map<string, Group>();
  for (const r of records) {
    if (!r.equipmentId || !r.equipment) continue;
    const cur = byEq.get(r.equipmentId);
    if (cur) cur.totalQty += r.quantity;
    else byEq.set(r.equipmentId, { eq: r.equipment, totalQty: r.quantity });
  }

  const shifts = main.shifts;
  const discountPct = main.discountPercent
    ? new Decimal(main.discountPercent.toString())
    : new Decimal(0);

  const lines = Array.from(byEq.values()).map(({ eq, totalQty }) => {
    const unitPrice = new Decimal(eq.rentalRatePerShift.toString());
    const lineSum = unitPrice.mul(totalQty).mul(shifts);
    return {
      equipmentId: eq.id,
      categorySnapshot: eq.category,
      nameSnapshot: eq.name,
      brandSnapshot: eq.brand ?? null,
      modelSnapshot: eq.model ?? null,
      quantity: totalQty,
      unitPrice: unitPrice.toDecimalPlaces(2).toString(),
      lineSum: lineSum.toDecimalPlaces(2).toString(),
    };
  });

  const subtotal = lines.reduce(
    (s, l) => s.add(new Decimal(l.lineSum)),
    new Decimal(0),
  );
  const discountAmount = subtotal.mul(discountPct).div(100);
  const totalAfterDiscount = subtotal.sub(discountAmount);

  await prisma.$transaction(async (tx) => {
    await tx.estimate.deleteMany({ where: { bookingId, kind: "ADDON" } });
    if (lines.length === 0) return;
    await tx.estimate.create({
      data: {
        bookingId,
        kind: "ADDON",
        shifts,
        subtotal: subtotal.toDecimalPlaces(2).toString(),
        discountPercent: discountPct.isZero() ? null : discountPct.toString(),
        discountAmount: discountAmount.toDecimalPlaces(2).toString(),
        totalAfterDiscount: totalAfterDiscount.toDecimalPlaces(2).toString(),
        commentSnapshot: null,
        optionalNote: null,
        includeOptionalInExport: false,
        hoursSummaryText: main.hoursSummaryText,
        lines: { create: lines },
      },
    });
  });
}
```

- [ ] **Step 4: Re-run the test — expect green**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  npm run test --workspace=apps/api -- src/__tests__/addonEstimate.test.ts 2>&1 | tail -10
```

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  git add apps/api/src/services/addonEstimate.ts \
          apps/api/src/__tests__/addonEstimate.test.ts && \
  git commit -m "feat(api): recomputeAddonEstimate service + tests

Aggregates AddonRecord'ы по equipmentId, применяет ту же скидку % что у
MAIN Estimate, delete-then-create snapshot ADDON Estimate. Idempotent.
No-op если booking не CONFIRMED (нет MAIN)."
```

---

## Task 4: `addExtraItem` — write AddonRecord + trigger recompute

**Files:**
- Modify: `apps/api/src/services/checklistService.ts`
- Modify: `apps/api/src/__tests__/customBookingItem.test.ts`

- [ ] **Step 1: Add failing test asserting AddonRecord is created**

In `apps/api/src/__tests__/customBookingItem.test.ts`, find the test that exercises `addExtraItem` (the one near line 309 with `prisma.estimate.findFirst`). Add a new `it(...)` block in the same `describe` immediately after it:

```ts
  it("addExtraItem creates an AddonRecord with delta quantity + triggers ADDON Estimate recompute", async () => {
    // Сценарий: бронь CONFIRMED с MAIN Estimate, в ISSUE сессии добавляем +3 Vmount.
    // Ожидаем: AddonRecord(quantity=3, sessionId, bookingItemId) + ADDON Estimate.
    const { addExtraItem } = await import("../services/checklistService");

    const initialRecords = await prisma.addonRecord.count({
      where: { bookingId },
    });

    await addExtraItem(sessionId, equipmentId, 3, "test-operator");

    const finalRecords = await prisma.addonRecord.findMany({
      where: { bookingId },
      orderBy: { createdAt: "desc" },
    });
    expect(finalRecords.length).toBe(initialRecords + 1);
    expect(finalRecords[0].quantity).toBe(3);
    expect(finalRecords[0].sessionId).toBe(sessionId);
    expect(finalRecords[0].equipmentId).toBe(equipmentId);
    expect(finalRecords[0].createdBy).toBe("test-operator");

    // ADDON Estimate должен существовать с totalQty >= 3
    const addon = await prisma.estimate.findFirst({
      where: { bookingId, kind: "ADDON" },
      include: { lines: true },
    });
    expect(addon).toBeTruthy();
    const line = addon!.lines.find((l: any) => l.equipmentId === equipmentId);
    expect(line).toBeTruthy();
    expect(line!.quantity).toBeGreaterThanOrEqual(3);
  });
```

(Identifiers `bookingId`, `sessionId`, `equipmentId` come from the existing test's `beforeAll`. If the existing test setup uses different names, adapt accordingly.)

- [ ] **Step 2: Run the test — expect failure («AddonRecord not created»)**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  npm run test --workspace=apps/api -- src/__tests__/customBookingItem.test.ts 2>&1 | tail -15
```

Expected: новый test FAILS — `finalRecords.length === initialRecords` (текущий `addExtraItem` AddonRecord не создаёт).

- [ ] **Step 3: Modify `addExtraItem`**

In `apps/api/src/services/checklistService.ts`, add import at top (after existing imports):

```ts
import { recomputeAddonEstimate } from "./addonEstimate";
```

Find the existing transaction inside `addExtraItem` (~line 396):

```ts
const bookingItemId = await prisma.$transaction(async (tx: TxClient) => {
  const booking = await tx.booking.findUnique({ ... });
  ...
  const item = await tx.bookingItem.upsert({ ... });
  return item.id;
});
```

Replace the `return item.id;` line with:

```ts
    // НОВОЕ: дельта-запись для построения ADDON Estimate.
    // Source of truth для агрегации, потому что upsert выше потерял дельту
    // (BookingItem.quantity содержит TOTAL, а не «сколько добавили сейчас»).
    await tx.addonRecord.create({
      data: {
        bookingId,
        sessionId,
        bookingItemId: item.id,
        equipmentId,
        quantity,
        acknowledgedConflict,
        createdBy,
      },
    });

    return item.id;
```

Also change the outer assignment to capture the returned value properly. The current pattern:

```ts
const bookingItemId = await prisma.$transaction(...);
```

stays unchanged.

After the transaction, BEFORE the existing `recomputeBookingFinance` call, add:

```ts
  // НОВОЕ: пересоздать ADDON Estimate. Best-effort: если падает, финансовый
  // recompute всё равно пройдёт со старым ADDON, следующий успешный вызов
  // восстановит инвариант.
  await recomputeAddonEstimate(bookingId).catch((err: unknown) => {
    console.error("[addExtraItem] recomputeAddonEstimate failed:", err);
  });
```

- [ ] **Step 4: Re-run tests — expect green**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  npm run test --workspace=apps/api -- src/__tests__/customBookingItem.test.ts 2>&1 | tail -10
```

Expected: новый test passes; существующие тесты остаются зелёными.

- [ ] **Step 5: Commit**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  git add apps/api/src/services/checklistService.ts \
          apps/api/src/__tests__/customBookingItem.test.ts && \
  git commit -m "feat(api): addExtraItem писeт AddonRecord + триггерит recomputeAddonEstimate

Каждый успешный addExtraItem теперь оставляет дельта-запись AddonRecord
(внутри той же транзакции, что и BookingItem upsert). После транзакции
best-effort пересоздаётся ADDON Estimate. Следующая фаза (recomputeBookingFinance)
автоматически учтёт addon в finalAmount/outstanding."
```

---

## Task 5: `recomputeBookingFinance` — integration test for full flow

**Files:**
- Create: `apps/api/src/__tests__/addonFinanceFlow.test.ts`

Note: `recomputeBookingFinance` was already updated in Task 2 to read both estimates and write `addonAmount`. This task pins the FULL FLOW behaviour via an integration test.

- [ ] **Step 1: Create the test**

```ts
/**
 * Integration: добор → ADDON Estimate → recomputeBookingFinance →
 * booking.finalAmount + outstanding + paymentStatus.
 *
 * Сценарии:
 *  - confirm → MAIN Estimate, addonAmount=0, outstanding=main.afterDiscount
 *  - addExtraItem → ADDON Estimate создан, addonAmount > 0, outstanding растёт
 *  - доплата = outstanding → paymentStatus → "PAID"
 *  - повторный addExtraItem на PAID-брони → outstanding > 0, paymentStatus → "PARTIALLY_PAID"
 */

import path from "path";
import { execSync } from "child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-addon-finance.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-addon-finance";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-addon-finance";
process.env.WAREHOUSE_SECRET = "test-warehouse-addon-fin-min16c";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-addon-finance-min16ch";

let prisma: any;
let clientId: string;
let equipmentId: string;
let bookingId: string;
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

  const client = await prisma.client.create({
    data: { name: "Finance flow", phone: "+70000000888" },
  });
  clientId = client.id;

  const eq = await prisma.equipment.create({
    data: {
      importKey: "finance-flow-eq",
      name: "Vmount Battery",
      category: "Электрика",
      rentalRatePerShift: "1000",
      stockTrackingMode: "COUNT",
    },
  });
  equipmentId = eq.id;

  // CONFIRMED booking + MAIN Estimate с suma 5000 (после 50% скидки от 10000)
  const booking = await prisma.booking.create({
    data: {
      clientId,
      projectName: "Finance test",
      startDate: new Date(),
      endDate: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
      status: "CONFIRMED",
      totalEstimateAmount: "10000",
      discountAmount: "5000",
      finalAmount: "5000",
      amountOutstanding: "5000",
    },
  });
  bookingId = booking.id;

  await prisma.estimate.create({
    data: {
      bookingId,
      kind: "MAIN",
      shifts: 2,
      subtotal: "10000",
      discountPercent: "50",
      discountAmount: "5000",
      totalAfterDiscount: "5000",
    },
  });

  await prisma.bookingItem.create({
    data: { bookingId, equipmentId, quantity: 1 },
  });

  const session = await prisma.scanSession.create({
    data: { bookingId, workerName: "test", operation: "ISSUE", status: "ACTIVE" },
  });
  sessionId = session.id;
});

afterAll(async () => {
  await prisma?.$disconnect?.();
});

describe("addExtraItem → finance flow", () => {
  it("addExtraItem ×3 Vmount → finalAmount растёт на (3×1000×2×(1−0.5))=3000 → outstanding обновлён", async () => {
    const { addExtraItem } = await import("../services/checklistService");
    const { recomputeBookingFinance } = await import("../services/finance");

    await addExtraItem(sessionId, equipmentId, 3, "test");
    await recomputeBookingFinance(bookingId); // ensure synced

    const fresh = await prisma.booking.findUnique({ where: { id: bookingId } });
    // main.afterDiscount = 5000, addon.afterDiscount = 3000, total = 8000
    expect(fresh.finalAmount.toString()).toBe("8000");
    expect(fresh.addonAmount.toString()).toBe("3000");
    expect(fresh.amountOutstanding.toString()).toBe("8000");
    expect(fresh.paymentStatus).toBe("NOT_PAID");
  });

  it("оплата полная → paymentStatus = PAID; затем addExtraItem ещё ×2 → status → PARTIALLY_PAID", async () => {
    // Pay 8000 (purpose: bring outstanding to 0)
    await prisma.payment.create({
      data: {
        bookingId,
        direction: "INCOME",
        amount: "8000",
        status: "RECEIVED",
        paymentMethod: "CASH",
        receivedAt: new Date(),
      },
    });
    const { recomputeBookingFinance } = await import("../services/finance");
    await recomputeBookingFinance(bookingId);

    let fresh = await prisma.booking.findUnique({ where: { id: bookingId } });
    expect(fresh.paymentStatus).toBe("PAID");
    expect(fresh.amountOutstanding.toString()).toBe("0");

    // Add ещё ×2 Vmount → addon растёт на 2×1000×2×0.5 = 2000 → outstanding = 2000 → PARTIALLY_PAID
    const { addExtraItem } = await import("../services/checklistService");
    await addExtraItem(sessionId, equipmentId, 2, "test");
    await recomputeBookingFinance(bookingId);

    fresh = await prisma.booking.findUnique({ where: { id: bookingId } });
    expect(fresh.addonAmount.toString()).toBe("5000"); // 3000 + 2000
    expect(fresh.finalAmount.toString()).toBe("10000"); // 5000 + 5000
    expect(fresh.amountOutstanding.toString()).toBe("2000");
    expect(fresh.paymentStatus).toBe("PARTIALLY_PAID");
  });
});
```

- [ ] **Step 2: Run the test — expect green (Task 2 + 4 already in place)**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  npm run test --workspace=apps/api -- src/__tests__/addonFinanceFlow.test.ts 2>&1 | tail -10
```

Expected: 2 tests pass.

- [ ] **Step 3: Commit**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  git add apps/api/src/__tests__/addonFinanceFlow.test.ts && \
  git commit -m "test(api): integration — добор → ADDON Estimate → finance recompute → status

Закрепляет полный flow: confirm → addExtraItem → finalAmount растёт →
оплата → PAID → ещё добор → PARTIALLY_PAID. Документирует ожидаемое
поведение для будущих изменений."
```

---

## Task 6: `completeSession` → расширение `ReconciliationSummary` финансовыми полями

**Files:**
- Modify: `apps/api/src/services/warehouseScan.ts`
- Modify: `apps/api/src/__tests__/warehouseScanIssueComplete.test.ts`

- [ ] **Step 1: Extend the `ReconciliationSummary` interface**

In `apps/api/src/services/warehouseScan.ts`, find the existing `export interface ReconciliationSummary {...}` (top of file, ~lines 39-65 depending on prior changes). Add three new fields at the bottom of the interface before the closing `}`:

```ts
  /** MAIN Estimate.totalAfterDiscount (0 если бронь не CONFIRMED). */
  mainAfterDiscount: string;
  /** ADDON Estimate.totalAfterDiscount (0 если доборов нет). */
  addonAfterDiscount: string;
  /** Booking.finalAmount (= main + addon + transport). */
  finalAmount: string;
```

- [ ] **Step 2: Modify all summary literals in the file to include these fields with `"0"` defaults**

Find every `const summary: ReconciliationSummary = { ... }` literal (there are ≥2 sites — inside `completeSession` and inside `getReconciliationPreview`). For each, append the three new fields with `"0"` defaults so the literal type-checks. Example:

```ts
const summary: ReconciliationSummary = {
  scanned: ...,
  expected: ...,
  ...
  reservedButUnavailable: [],
  createdRepairIds: [],
  failedBrokenUnits: [],
  createdProblemItemIds: [],
  failedProblemUnits: [],
  // NEW:
  mainAfterDiscount: "0",
  addonAfterDiscount: "0",
  finalAmount: "0",
};
```

- [ ] **Step 3: After the existing best-effort audit block in `completeSession`, populate the new fields**

Locate the section where `completeSession`'s post-transaction logic ends (after the booking-status audit `.catch(...)` block, before the `return summary;`). Add:

```ts
  // НОВОЕ: финансовая разбивка для result-screen фронта.
  // recomputeBookingFinance уже учёл ADDON Estimate в выше вызванной цепочке,
  // здесь только читаем актуальные значения.
  try {
    const fresh = await prisma.booking.findUnique({
      where: { id: session.bookingId },
      include: { estimates: true },
    });
    if (fresh) {
      const main = fresh.estimates.find((e) => e.kind === "MAIN");
      const addon = fresh.estimates.find((e) => e.kind === "ADDON");
      summary.mainAfterDiscount = main ? main.totalAfterDiscount.toString() : "0";
      summary.addonAfterDiscount = addon ? addon.totalAfterDiscount.toString() : "0";
      summary.finalAmount = fresh.finalAmount.toString();
    }
  } catch (err) {
    console.warn("[completeSession] finance snapshot read failed:", err);
  }
```

(Note: `completeSession` doesn't itself call `recomputeBookingFinance` — that happens via addExtraItem during the session. By the time we reach completeSession, finance is already current. We just need to read.)

- [ ] **Step 4: Add a test asserting the finance fields**

In `apps/api/src/__tests__/warehouseScanIssueComplete.test.ts`, find the existing setup (booking CONFIRMED + MAIN Estimate via direct prisma.estimate.create). After Task 1, the existing seed will need:
- The MAIN Estimate has `kind: "MAIN"` explicitly. If the seed creates it without `kind`, the default `MAIN` applies — still fine.

Add a new test inside the existing `describe`:

```ts
  it("completeSession returns finance breakdown (main/addon/final) in ReconciliationSummary", async () => {
    const { completeSession } = await import("../services/warehouseScan");
    const res = await completeSession(sessionId, { createdBy: "test" });
    expect(res).toHaveProperty("mainAfterDiscount");
    expect(res).toHaveProperty("addonAfterDiscount");
    expect(res).toHaveProperty("finalAmount");
    // Если бронь имела MAIN с totalAfterDiscount, поле > 0
    // (точное значение зависит от seed'а — проверяем тип + ненулевую финал. сумму)
    expect(Number(res.finalAmount)).toBeGreaterThan(0);
  });
```

- [ ] **Step 5: Run the test — expect green**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  npm run test --workspace=apps/api -- src/__tests__/warehouseScanIssueComplete.test.ts 2>&1 | tail -10
```

Expected: тест passes; существующие тесты в файле остаются зелёными.

- [ ] **Step 6: Commit**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  git add apps/api/src/services/warehouseScan.ts \
          apps/api/src/__tests__/warehouseScanIssueComplete.test.ts && \
  git commit -m "feat(api): completeSession returns finance breakdown (main/addon/final)

После recomputeBookingFinance читаем актуальные totalAfterDiscount у обеих
Estimate'ов и Booking.finalAmount, кладём в ReconciliationSummary —
фронт показывает «Согласовано / Доб-смета / К оплате» на result-screen
без отдельного round-trip'а."
```

---

## Task 7: `services/smetaExport` — kind-aware title + `buildFullSmeta`

**Files:**
- Modify: `apps/api/src/services/smetaExport/buildDocument.ts`
- Modify: `apps/api/src/services/smetaExport/types.ts`
- Modify: `apps/api/src/services/smetaExport/index.ts`
- Create: `apps/api/src/services/smetaExport/buildFullDocument.ts`
- Create: `apps/api/src/services/smetaExport/renderFullPdf.ts`
- Create: `apps/api/src/services/smetaExport/renderFullXlsx.ts`

- [ ] **Step 1: Extend types**

In `apps/api/src/services/smetaExport/types.ts`, after the existing `SmetaExportDocument` type, add:

```ts
/** Полная смета: основная + (опционально) доб-смета. */
export type SmetaFullExportDocument = {
  main: SmetaExportDocument;
  addon: SmetaExportDocument | null;
  /** Финальная сумма к оплате = main + addon + transport (для итоговой строки). */
  grandTotal: string;
};
```

- [ ] **Step 2: Modify `buildSmetaFromPersistedEstimate` to accept `kind`**

In `apps/api/src/services/smetaExport/buildDocument.ts`, find the function signature:

```ts
export function buildSmetaFromPersistedEstimate(args: {
  booking: { ... };
  estimate: { ... };
}): SmetaExportDocument {
```

Replace the `estimate` parameter type to include `kind`:

```ts
  estimate: {
    kind?: "MAIN" | "ADDON"; // optional for backward-compat
    shifts: number;
    ...
```

At the end of the function body, after the `return buildSmetaExportDocument({...})` call returns, modify the call:

```ts
  const baseDoc = buildSmetaExportDocument({ ... existing fields ... });
  // Override title for ADDON kind
  if (args.estimate.kind === "ADDON") {
    return { ...baseDoc, documentTitleRu: "Смета-добор" };
  }
  return baseDoc;
}
```

- [ ] **Step 3: Create `buildFullDocument.ts`**

```ts
import Decimal from "decimal.js";

import { buildSmetaFromPersistedEstimate } from "./buildDocument";
import type { SmetaFullExportDocument } from "./types";

/** Полная смета: main + (опционально) addon. Если addon=null, addonDoc=null. */
export function buildFullSmeta(args: {
  booking: Parameters<typeof buildSmetaFromPersistedEstimate>[0]["booking"];
  main: Parameters<typeof buildSmetaFromPersistedEstimate>[0]["estimate"];
  addon: Parameters<typeof buildSmetaFromPersistedEstimate>[0]["estimate"] | null;
}): SmetaFullExportDocument {
  const mainDoc = buildSmetaFromPersistedEstimate({
    booking: args.booking,
    estimate: { ...args.main, kind: "MAIN" },
  });
  const addonDoc = args.addon
    ? buildSmetaFromPersistedEstimate({
        booking: args.booking,
        estimate: { ...args.addon, kind: "ADDON" },
      })
    : null;
  const mainTotal = new Decimal(mainDoc.totalAfterDiscount);
  const addonTotal = addonDoc ? new Decimal(addonDoc.totalAfterDiscount) : new Decimal(0);
  const grandTotal = mainTotal.add(addonTotal).toDecimalPlaces(2).toString();
  return { main: mainDoc, addon: addonDoc, grandTotal };
}
```

- [ ] **Step 4: Create `renderFullPdf.ts`**

```ts
import type { Response } from "express";

import { writeSmetaPdf } from "./renderPdf";
import type { SmetaFullExportDocument } from "./types";

/**
 * PDF: main page(s) + опционально addon page(s). Если addon = null,
 * результат идентичен одиночному main PDF.
 *
 * Реализация: писать стрим вручную здесь сложно (PDFKit doc abstraction),
 * проще делегировать writeSmetaPdf для каждой секции с явным разделителем.
 * Текущая реализация writeSmetaPdf принимает один документ → нам нужна
 * новая обёртка, которая принимает массив документов + сводный footer.
 *
 * MVP: используем writeSmetaPdf для main, если addon существует — приписываем
 * вторую секцию с собственным footer'ом. Если PDFKit doc нельзя продлить из
 * writeSmetaPdf, копируем тело функции и адаптируем (TODO: refactor шарят
 * draw helpers — out of scope этого PR).
 */
export function writeFullSmetaPdf(
  res: Response,
  doc: SmetaFullExportDocument,
  filename: string,
): void {
  // Если addon нет — поведение идентично writeSmetaPdf(main).
  if (!doc.addon) {
    writeSmetaPdf(res, doc.main, filename);
    return;
  }

  // С addon — комбинированный документ. Простейший вариант:
  // делаем PDF с обоими секциями (раньше writeSmetaPdf писал ровно одну),
  // тогда нам нужен новый «multi-doc» рендерер. Извлекаем общую draw-функцию.
  //
  // Pragmatic approach: writeSmetaPdf принимает doc — пишем main, затем
  // в том же стриме рендерим addon на новой странице. Для этого
  // writeSmetaPdf должен быть способен accept ARRAY или иметь "appendable"
  // вариант. Если такого API сейчас нет, добавляем небольшой helper в
  // renderPdf.ts экспортом отдельной функции `writeSmetaPdfMulti(res, [docs], filename)`.
  //
  // См. также реализационную заметку в Task 7 step 5.
  writeSmetaPdfMulti(res, [doc.main, doc.addon], filename, doc.grandTotal);
}

// Импортируем после декларации, чтобы избежать кругового ссылочного риска.
import { writeSmetaPdfMulti } from "./renderPdf";
```

- [ ] **Step 5: Add `writeSmetaPdfMulti` to `renderPdf.ts`**

Look at the existing `apps/api/src/services/smetaExport/renderPdf.ts` and locate `writeSmetaPdf`. Refactor so the core "draw one document into a doc object" logic is extracted into a helper, and add a public `writeSmetaPdfMulti`:

Read `apps/api/src/services/smetaExport/renderPdf.ts` to find the existing structure:

```bash
cat /Users/sechenov/Documents/light-rental-system/apps/api/src/services/smetaExport/renderPdf.ts | head -50
```

Locate `export function writeSmetaPdf(res, doc, filename)`. Inside, there should be a `const doc_pdf = new PDFDocument(...)` + `doc_pdf.pipe(res)` + drawing logic + `doc_pdf.end()`.

Extract the drawing into a helper:

```ts
function drawSmetaDocumentIntoPdf(pdf: PDFKit.PDFDocument, doc: SmetaExportDocument): void {
  // ...all the existing drawing logic, but applied to `pdf` rather than to a new instance...
}
```

Then refactor:

```ts
export function writeSmetaPdf(res: Response, doc: SmetaExportDocument, filename: string): void {
  const pdf = new PDFDocument({ size: "A4", margin: 40 });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  pdf.pipe(res);
  drawSmetaDocumentIntoPdf(pdf, doc);
  pdf.end();
}

/** Multi-section PDF: main + (опционально) addon на отдельной странице + grand total footer. */
export function writeSmetaPdfMulti(
  res: Response,
  sections: SmetaExportDocument[],
  filename: string,
  grandTotal: string,
): void {
  const pdf = new PDFDocument({ size: "A4", margin: 40 });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  pdf.pipe(res);

  sections.forEach((section, idx) => {
    if (idx > 0) pdf.addPage();
    drawSmetaDocumentIntoPdf(pdf, section);
  });

  // Grand total footer on the last page
  if (sections.length > 1) {
    pdf.moveDown(2);
    pdf.fontSize(11).text(`ИТОГО к оплате: ${grandTotal} ₽`, { align: "right" });
  }
  pdf.end();
}
```

- [ ] **Step 6: Create `renderFullXlsx.ts`**

```ts
import type { Response } from "express";
import ExcelJS from "exceljs";

import type { SmetaFullExportDocument } from "./types";
import { addSmetaSheetToWorkbook } from "./renderXlsx";

export async function writeFullSmetaXlsx(
  res: Response,
  doc: SmetaFullExportDocument,
  filename: string,
): Promise<void> {
  const wb = new ExcelJS.Workbook();
  addSmetaSheetToWorkbook(wb, doc.main, "Смета");
  if (doc.addon) {
    addSmetaSheetToWorkbook(wb, doc.addon, "Доб-смета");
  }
  // Grand total в отдельный «Итого» sheet или footer на основной — оставляем
  // простую реализацию: дополнительная подпись на доб-смета листе.
  if (doc.addon) {
    const ws = wb.getWorksheet("Доб-смета");
    if (ws) {
      ws.addRow([]);
      ws.addRow([`ИТОГО к оплате (Согласовано + Доб):`, doc.grandTotal]);
    }
  }
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  const buf = await wb.xlsx.writeBuffer();
  res.send(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
}
```

- [ ] **Step 7: Refactor `renderXlsx.ts` similarly — extract `addSmetaSheetToWorkbook`**

In `apps/api/src/services/smetaExport/renderXlsx.ts`, look for the existing `writeSmetaXlsx`. Extract the «add one sheet» logic into a helper:

```ts
export function addSmetaSheetToWorkbook(
  wb: ExcelJS.Workbook,
  doc: SmetaExportDocument,
  sheetName: string,
): void {
  const ws = wb.addWorksheet(sheetName);
  // ... existing logic of writeSmetaXlsx, but on `ws` instead of new workbook ...
}

export async function writeSmetaXlsx(
  res: Response,
  doc: SmetaExportDocument,
  filename: string,
): Promise<void> {
  const wb = new ExcelJS.Workbook();
  addSmetaSheetToWorkbook(wb, doc, "Смета");
  res.setHeader("Content-Type", ...);
  res.setHeader("Content-Disposition", ...);
  const buf = await wb.xlsx.writeBuffer();
  res.send(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
}
```

- [ ] **Step 8: Update `index.ts`**

In `apps/api/src/services/smetaExport/index.ts`:

```ts
export type {
  SmetaExportDocument,
  SmetaExportLine,
  SmetaFullExportDocument,
} from "./types";
export {
  buildSmetaExportDocument,
  buildSmetaFromPersistedEstimate,
} from "./buildDocument";
export { buildFullSmeta } from "./buildFullDocument";
export { writeSmetaPdf, writeSmetaPdfMulti } from "./renderPdf";
export { writeSmetaXlsx, addSmetaSheetToWorkbook } from "./renderXlsx";
export { writeFullSmetaPdf } from "./renderFullPdf";
export { writeFullSmetaXlsx } from "./renderFullXlsx";
```

- [ ] **Step 9: Run existing PDF tests — verify backward compat**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  npm run test --workspace=apps/api -- src/__tests__/pdfEndpoints.test.ts 2>&1 | tail -10
```

Expected: existing tests still pass — refactor is signature-preserving for `writeSmetaPdf` / `writeSmetaXlsx`.

- [ ] **Step 10: Commit**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  git add apps/api/src/services/smetaExport/ && \
  git commit -m "feat(api): smetaExport — kind-aware title + buildFullSmeta + multi-section PDF/XLSX

- buildSmetaFromPersistedEstimate теперь учитывает estimate.kind:
  для ADDON выставляет documentTitleRu = «Смета-добор»
- buildFullSmeta возвращает { main, addon, grandTotal }
- writeSmetaPdfMulti рендерит main + addon секции в одном PDF
- writeFullSmetaXlsx двухlistовый workbook (Смета / Доб-смета)
- Извлечены drawSmetaDocumentIntoPdf и addSmetaSheetToWorkbook
  для переиспользования"
```

---

## Task 8: `routes/addonEstimates.ts` — new routes (JSON / PDF / XLSX)

**Files:**
- Create: `apps/api/src/routes/addonEstimates.ts`
- Modify: `apps/api/src/index.ts` (mount the router)
- Create: `apps/api/src/__tests__/addonEstimateRoutes.test.ts`

- [ ] **Step 1: Create failing test**

```ts
import path from "path";
import { execSync } from "child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

const TEST_DB_PATH = path.resolve(__dirname, "../../prisma/test-addon-routes.db");
process.env.DATABASE_URL = `file:${TEST_DB_PATH}`;
process.env.RATE_LIMIT_DISABLED = "true";
process.env.API_KEYS = "test-key-addon-routes";
process.env.AUTH_MODE = "warn";
process.env.NODE_ENV = "test";
process.env.BARCODE_SECRET = "test-secret-addon-routes";
process.env.WAREHOUSE_SECRET = "test-warehouse-addon-routes-16";
process.env.VISION_PROVIDER = "mock";
process.env.JWT_SECRET = "test-jwt-addon-routes-min16chars";

let app: any;
let prisma: any;
let bookingWithAddonId: string;
let bookingWithoutAddonId: string;

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
  const { app: expressApp } = await import("../app");
  app = expressApp;

  const client = await prisma.client.create({
    data: { name: "Routes test", phone: "+70000000777" },
  });

  // Booking with both MAIN and ADDON estimates
  const b1 = await prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: "Has addon",
      startDate: new Date(),
      endDate: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
      status: "ISSUED",
    },
  });
  bookingWithAddonId = b1.id;
  await prisma.estimate.create({
    data: {
      bookingId: b1.id,
      kind: "MAIN",
      shifts: 2,
      subtotal: "10000",
      discountPercent: "50",
      discountAmount: "5000",
      totalAfterDiscount: "5000",
    },
  });
  await prisma.estimate.create({
    data: {
      bookingId: b1.id,
      kind: "ADDON",
      shifts: 2,
      subtotal: "2000",
      discountPercent: "50",
      discountAmount: "1000",
      totalAfterDiscount: "1000",
      lines: {
        create: [
          {
            equipmentId: null,
            categorySnapshot: "Электрика",
            nameSnapshot: "Vmount",
            quantity: 1,
            unitPrice: "1000",
            lineSum: "2000",
          },
        ],
      },
    },
  });

  // Booking without ADDON
  const b2 = await prisma.booking.create({
    data: {
      clientId: client.id,
      projectName: "No addon",
      startDate: new Date(),
      endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
      status: "ISSUED",
    },
  });
  bookingWithoutAddonId = b2.id;
  await prisma.estimate.create({
    data: {
      bookingId: b2.id,
      kind: "MAIN",
      shifts: 1,
      subtotal: "5000",
      discountPercent: null,
      discountAmount: "0",
      totalAfterDiscount: "5000",
    },
  });
});

afterAll(async () => {
  await prisma?.$disconnect?.();
});

describe("GET /api/addon-estimates/:bookingId", () => {
  it("returns ADDON estimate JSON if present", async () => {
    const res = await request(app).get(`/api/addon-estimates/${bookingWithAddonId}`);
    expect(res.status).toBe(200);
    expect(res.body.addon).toBeTruthy();
    expect(res.body.addon.kind).toBe("ADDON");
    expect(res.body.addon.totalAfterDiscount).toBe("1000");
    expect(res.body.addon.lines).toHaveLength(1);
  });

  it("returns null if no ADDON estimate", async () => {
    const res = await request(app).get(`/api/addon-estimates/${bookingWithoutAddonId}`);
    expect(res.status).toBe(200);
    expect(res.body.addon).toBeNull();
  });
});

describe("GET /api/addon-estimates/:bookingId/export/pdf", () => {
  it("returns PDF if ADDON exists", async () => {
    const res = await request(app).get(
      `/api/addon-estimates/${bookingWithAddonId}/export/pdf`,
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
  });

  it("404 if no ADDON", async () => {
    const res = await request(app).get(
      `/api/addon-estimates/${bookingWithoutAddonId}/export/pdf`,
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("ADDON_ESTIMATE_NOT_FOUND");
  });
});

describe("GET /api/addon-estimates/:bookingId/export/xlsx", () => {
  it("returns XLSX if ADDON exists", async () => {
    const res = await request(app).get(
      `/api/addon-estimates/${bookingWithAddonId}/export/xlsx`,
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("spreadsheetml");
  });
});
```

- [ ] **Step 2: Run — expect 404 (router not mounted)**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  npm run test --workspace=apps/api -- src/__tests__/addonEstimateRoutes.test.ts 2>&1 | tail -10
```

Expected: 5 fails — endpoint returns 404 not found by express router.

- [ ] **Step 3: Create `apps/api/src/routes/addonEstimates.ts`**

```ts
import express from "express";

import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";
import { serializeEstimateForJson } from "../utils/serializeDecimal";
import {
  buildSmetaFromPersistedEstimate,
  writeSmetaPdf,
  writeSmetaXlsx,
} from "../services/smetaExport";
import { buildBookingHumanName, safeFileName } from "../utils/bookingName";

const router = express.Router();

router.get("/:bookingId", async (req, res, next) => {
  try {
    const addon = await prisma.estimate.findFirst({
      where: { bookingId: req.params.bookingId, kind: "ADDON" },
      include: {
        booking: { include: { client: true } },
        lines: true,
      },
    });
    if (!addon) {
      res.json({ addon: null });
      return;
    }
    res.json({ addon: serializeEstimateForJson(addon) });
  } catch (err) {
    next(err);
  }
});

router.get("/:bookingId/export/pdf", async (req, res, next) => {
  try {
    const addon = await prisma.estimate.findFirst({
      where: { bookingId: req.params.bookingId, kind: "ADDON" },
      include: {
        booking: { include: { client: true } },
        lines: true,
      },
    });
    if (!addon) {
      throw new HttpError(404, "Доб-сметы нет — доборы не делали", "ADDON_ESTIMATE_NOT_FOUND");
    }
    const doc = buildSmetaFromPersistedEstimate({ booking: addon.booking, estimate: addon });
    const human = buildBookingHumanName({
      startDate: addon.booking.startDate,
      clientName: addon.booking.client.name,
      totalAfterDiscount: addon.totalAfterDiscount.toString(),
    });
    writeSmetaPdf(res, doc, `${safeFileName(human)}-добор.pdf`);
  } catch (err) {
    next(err);
  }
});

router.get("/:bookingId/export/xlsx", async (req, res, next) => {
  try {
    const addon = await prisma.estimate.findFirst({
      where: { bookingId: req.params.bookingId, kind: "ADDON" },
      include: {
        booking: { include: { client: true } },
        lines: true,
      },
    });
    if (!addon) {
      throw new HttpError(404, "Доб-сметы нет — доборы не делали", "ADDON_ESTIMATE_NOT_FOUND");
    }
    const doc = buildSmetaFromPersistedEstimate({ booking: addon.booking, estimate: addon });
    const human = buildBookingHumanName({
      startDate: addon.booking.startDate,
      clientName: addon.booking.client.name,
      totalAfterDiscount: addon.totalAfterDiscount.toString(),
    });
    await writeSmetaXlsx(res, doc, `${safeFileName(human)}-добор.xlsx`);
  } catch (err) {
    next(err);
  }
});

export { router as addonEstimatesRouter };
```

- [ ] **Step 4: Mount the router in `app.ts`**

Find `apps/api/src/app.ts`. After the existing `app.use("/api/estimates", estimatesRouter);` (or similar mount), add:

```ts
import { addonEstimatesRouter } from "./routes/addonEstimates";
// ...
app.use("/api/addon-estimates", addonEstimatesRouter);
```

- [ ] **Step 5: Run tests — expect green**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  npm run test --workspace=apps/api -- src/__tests__/addonEstimateRoutes.test.ts 2>&1 | tail -10
```

Expected: 5 tests pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  git add apps/api/src/routes/addonEstimates.ts \
          apps/api/src/app.ts \
          apps/api/src/__tests__/addonEstimateRoutes.test.ts && \
  git commit -m "feat(api): routes/addon-estimates — JSON, PDF, XLSX exports

GET /api/addon-estimates/:bookingId               → JSON или null
GET /api/addon-estimates/:bookingId/export/pdf    → application/pdf
GET /api/addon-estimates/:bookingId/export/xlsx   → spreadsheetml
404 c кодом ADDON_ESTIMATE_NOT_FOUND если ADDON отсутствует."
```

---

## Task 9: Full-estimate routes (main + addon)

**Files:**
- Modify: `apps/api/src/routes/bookings.ts`
- Create: `apps/api/src/__tests__/fullEstimateRoutes.test.ts`

- [ ] **Step 1: Create test**

```ts
// (Similar setup to addonEstimateRoutes.test.ts — seed bookingWithAddon + bookingWithoutAddon.)
// Tests:
//   GET /api/bookings/<with-addon>/full-estimate/export/pdf → 200 application/pdf
//   GET /api/bookings/<without-addon>/full-estimate/export/pdf → 200 application/pdf (= main only)
//   ... аналогично для xlsx
```

(Use the same db-bootstrap pattern as `addonEstimateRoutes.test.ts`. Verify content-type on both branches.)

- [ ] **Step 2: Add routes in `routes/bookings.ts`**

In `apps/api/src/routes/bookings.ts`, add (near the other export routes):

```ts
import { buildFullSmeta, writeFullSmetaPdf, writeFullSmetaXlsx } from "../services/smetaExport";

// ...

router.get("/:id/full-estimate/export/pdf", async (req, res, next) => {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      include: {
        client: true,
        estimates: { include: { lines: true } },
      },
    });
    if (!booking) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");

    const main = booking.estimates.find((e) => e.kind === "MAIN");
    if (!main) throw new HttpError(404, "Основная смета не создана", "MAIN_ESTIMATE_NOT_FOUND");
    const addon = booking.estimates.find((e) => e.kind === "ADDON") ?? null;

    const doc = buildFullSmeta({ booking, main, addon });
    const human = buildBookingHumanName({
      startDate: booking.startDate,
      clientName: booking.client.name,
      totalAfterDiscount: main.totalAfterDiscount.toString(),
    });
    writeFullSmetaPdf(res, doc, `${safeFileName(human)}-смета.pdf`);
  } catch (err) { next(err); }
});

router.get("/:id/full-estimate/export/xlsx", async (req, res, next) => {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      include: {
        client: true,
        estimates: { include: { lines: true } },
      },
    });
    if (!booking) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");

    const main = booking.estimates.find((e) => e.kind === "MAIN");
    if (!main) throw new HttpError(404, "Основная смета не создана", "MAIN_ESTIMATE_NOT_FOUND");
    const addon = booking.estimates.find((e) => e.kind === "ADDON") ?? null;

    const doc = buildFullSmeta({ booking, main, addon });
    const human = buildBookingHumanName({
      startDate: booking.startDate,
      clientName: booking.client.name,
      totalAfterDiscount: main.totalAfterDiscount.toString(),
    });
    await writeFullSmetaXlsx(res, doc, `${safeFileName(human)}-смета.xlsx`);
  } catch (err) { next(err); }
});
```

- [ ] **Step 3: Run tests — expect green**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  npm run test --workspace=apps/api -- src/__tests__/fullEstimateRoutes.test.ts 2>&1 | tail -10
```

Expected: tests pass.

- [ ] **Step 4: Commit**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  git add apps/api/src/routes/bookings.ts \
          apps/api/src/__tests__/fullEstimateRoutes.test.ts && \
  git commit -m "feat(api): routes/bookings — /full-estimate/export/pdf|xlsx (main + addon)

Объединённая смета: main + (опционально) addon секция в одном файле.
Если addon отсутствует — поведение идентично существующему main-only
экспорту. Используется как дефолт для отправки клиенту."
```

---

## Task 10: Frontend types

**Files:**
- Modify: `apps/web/src/components/warehouse/types.ts`
- Modify: `apps/web/src/components/warehouse/api.ts`

- [ ] **Step 1: Add types**

In `apps/web/src/components/warehouse/types.ts`, add at the end (before the existing `isScanApiError` function or wherever appropriate):

```ts
export interface AddonEstimateLine {
  equipmentId: string | null;
  name: string;            // nameSnapshot
  category: string;        // categorySnapshot
  quantity: number;
  unitPrice: string;       // serialized Decimal
  lineSum: string;
}

export interface AddonEstimateView {
  id: string;
  bookingId: string;
  shifts: number;
  subtotal: string;
  discountPercent: string | null;
  discountAmount: string;
  totalAfterDiscount: string;
  lines: AddonEstimateLine[];
}
```

Find `interface CompleteResult extends SummaryResult { ... }` (or wherever it lives — possibly types.ts mirrors ReconciliationSummary). Extend it:

```ts
export interface CompleteResult extends SummaryResult {
  // …existing fields…
  mainAfterDiscount: string;
  addonAfterDiscount: string;
  finalAmount: string;
}
```

- [ ] **Step 2: Add api method**

In `apps/web/src/components/warehouse/api.ts`, add:

```ts
export function getAddonEstimate(
  bookingId: string,
): Promise<{ addon: AddonEstimateView | null }> {
  return request<{ addon: AddonEstimateView | null }>(
    `/api/addon-estimates/${bookingId}`,
  );
}

/** URL для скачивания PDF доб-сметы (для прямых `<a href>` ссылок). */
export function addonEstimatePdfUrl(bookingId: string): string {
  return `/api/addon-estimates/${bookingId}/export/pdf`;
}

/** URL для скачивания общей PDF (main + addon). */
export function fullEstimatePdfUrl(bookingId: string): string {
  return `/api/bookings/${bookingId}/full-estimate/export/pdf`;
}
```

Add `getAddonEstimate`, `addonEstimatePdfUrl`, `fullEstimatePdfUrl` to the aggregate export at the bottom of the file:

```ts
export const scanApi = {
  // …existing…
  getAddonEstimate,
  addonEstimatePdfUrl,
  fullEstimatePdfUrl,
};
```

- [ ] **Step 3: Typecheck + commit**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  npx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | head -10 && \
  git add apps/web/src/components/warehouse/types.ts \
          apps/web/src/components/warehouse/api.ts && \
  git commit -m "feat(web): types/api для AddonEstimateView + extended CompleteResult"
```

Expected: no TS errors.

---

## Task 11: `AddonSearch` — bookingId prop + PDF link в success-line

**Files:**
- Modify: `apps/web/src/components/warehouse/AddonSearch.tsx`
- Modify: `apps/web/src/components/warehouse/IssueChecklist.tsx`
- Modify: `apps/web/src/components/warehouse/__tests__/AddonSearch.test.tsx`

- [ ] **Step 1: Failing test**

In `AddonSearch.test.tsx`, add a new test:

```ts
  it("success-line after add shows «Открыть PDF доб-сметы →» link with bookingId-based URL", async () => {
    vi.spyOn(scanApi, "addonSearch").mockResolvedValue([freeResult()]);
    vi.spyOn(scanApi, "addItem").mockResolvedValue({ bookingItemId: "bi-9" });

    render(
      <AddonSearch
        sessionId="s1"
        bookingId="b-test"
        onAdded={() => {}}
        onClose={() => {}}
      />,
    );
    await type("dedo");
    await settleSearch();

    // Open qty picker + confirm with qty=1
    await act(async () => {
      screen.getByRole("button", { name: /свободно, выбрать количество/ }).click();
      await Promise.resolve();
    });
    await act(async () => {
      screen.getByRole("button", { name: /Добавить 1 шт/ }).click();
      await Promise.resolve();
    });

    // PDF link visible
    const pdfLink = await screen.findByRole("link", { name: /Открыть PDF/ });
    expect(pdfLink).toBeInTheDocument();
    expect(pdfLink.getAttribute("href")).toBe("/api/addon-estimates/b-test/export/pdf");
    expect(pdfLink.getAttribute("target")).toBe("_blank");
  });
```

- [ ] **Step 2: Run — expect failure («AddonSearch doesn't accept bookingId» or «no link»)**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  npm run test --workspace=apps/web -- src/components/warehouse/__tests__/AddonSearch.test.tsx 2>&1 | tail -10
```

Expected: тест fails.

- [ ] **Step 3: Add `bookingId` prop + render PDF link**

In `apps/web/src/components/warehouse/AddonSearch.tsx`, find the `export function AddonSearch(...)` signature. Add `bookingId: string` to the props:

```ts
export function AddonSearch({
  sessionId,
  bookingId,                     // ← новое
  bookingNo,
  onAdded,
  onClose,
}: {
  sessionId: string;
  bookingId: string;             // ← новое
  bookingNo?: string;
  onAdded: (bookingItemId: string, hadConflict: boolean) => void;
  onClose: () => void;
}) {
```

Then find the success-line rendering (после `addItem` success — где сейчас «✓ {name} добавлен в выдачу»). It's the `{added && (...)}` block. Replace its inner content:

```tsx
{added && (
  <div className="mx-3 mb-2 rounded-lg border border-emerald-border bg-emerald-soft px-3 py-2 text-[12px] font-medium text-emerald">
    <span aria-hidden="true">✓ </span>
    {added.name}{added.qty > 1 ? ` ×${added.qty}` : ""} добавлен в выдачу
    <div className="mt-1 text-[11px] text-emerald/85">
      Доб-смета обновлена ·{" "}
      <a
        href={`/api/addon-estimates/${bookingId}/export/pdf`}
        target="_blank"
        rel="noreferrer"
        className="underline hover:no-underline"
      >
        Открыть PDF →
      </a>
    </div>
  </div>
)}
```

- [ ] **Step 4: Update IssueChecklist to pass `bookingId`**

In `apps/web/src/components/warehouse/IssueChecklist.tsx`, find where `<AddonSearch />` is rendered. Currently passes `sessionId` and `bookingNo`. Add `bookingId={state.bookingId}` (state comes from `useScanSession`, which loads ChecklistState including bookingId):

```tsx
<AddonSearch
  sessionId={sessionId}
  bookingId={state.bookingId}
  bookingNo={state.bookingId ? displayNo(state.bookingId) : undefined}
  onAdded={handleAddonAdded}
  onClose={() => setAddonOpen(false)}
/>
```

- [ ] **Step 5: Update inline AddonSearch mock in IssueChecklist.test.tsx**

```ts
vi.mock("../AddonSearch", () => ({
  AddonSearch: ({
    sessionId,
    bookingId,                  // ← добавить в деструктур
    bookingNo,
    onAdded,
    onClose,
  }: {
    sessionId: string;
    bookingId: string;          // ← добавить
    bookingNo?: string;
    onAdded: (bookingItemId: string, hadConflict: boolean) => void;
    onClose: () => void;
  }) => (
    <div data-testid="addon-search">
      <span>addon:{sessionId}</span>
      <span>bookingId:{bookingId}</span>
      <span>no:{bookingNo}</span>
      // ...existing stub buttons...
    </div>
  ),
}));
```

Add a test in `IssueChecklist.test.tsx`:

```ts
  it("passes bookingId to AddonSearch (for доб-смета PDF link)", async () => {
    render(<IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />);
    (await screen.findAllByRole("button", { name: /Добор/ }))[0].click();
    await screen.findByTestId("addon-search");
    expect(screen.getByText(/bookingId:b1/)).toBeInTheDocument();
  });
```

- [ ] **Step 6: Run tests — expect green**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  npm run test --workspace=apps/web -- \
    src/components/warehouse/__tests__/AddonSearch.test.tsx \
    src/components/warehouse/__tests__/IssueChecklist.test.tsx 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  git add apps/web/src/components/warehouse/AddonSearch.tsx \
          apps/web/src/components/warehouse/IssueChecklist.tsx \
          apps/web/src/components/warehouse/__tests__/AddonSearch.test.tsx \
          apps/web/src/components/warehouse/__tests__/IssueChecklist.test.tsx && \
  git commit -m "feat(web): AddonSearch принимает bookingId, success-line → PDF доб-сметы

После успешного добавления добор-позиции success-line предлагает
«Открыть PDF →» — переход на /api/addon-estimates/{bookingId}/export/pdf
в новой вкладке. Кладовщик может сразу показать клиенту актуальную
доб-смету."
```

---

## Task 12: `IssueChecklist` — блок «Доб-смета» в summary phase

**Files:**
- Modify: `apps/web/src/components/warehouse/IssueChecklist.tsx`
- Modify: `apps/web/src/components/warehouse/__tests__/IssueSummary.test.tsx`

- [ ] **Step 1: Failing test**

In `IssueSummary.test.tsx`, add:

```ts
  it("renders «Доб-смета» block in summary phase when addon estimate exists", async () => {
    // Mock getAddonEstimate to return a populated addon
    vi.spyOn(scanApi, "getAddonEstimate").mockResolvedValue({
      addon: {
        id: "ae1",
        bookingId: "b1",
        shifts: 2,
        subtotal: "10000",
        discountPercent: "50",
        discountAmount: "5000",
        totalAfterDiscount: "5000",
        lines: [
          {
            equipmentId: "eq-v",
            name: "Vmount",
            category: "Электрика",
            quantity: 10,
            unitPrice: "1000",
            lineSum: "10000",
          },
        ],
      },
    });

    render(<IssueChecklist sessionId="s1" projectName="Орбита" onBack={() => {}} />);
    (await screen.findByRole("button", { name: /Завершить выдачу/ })).click();

    expect(await screen.findByText(/Доб-смета/)).toBeInTheDocument();
    expect(screen.getByText(/Vmount/)).toBeInTheDocument();
    expect(screen.getByText(/×10/)).toBeInTheDocument();
    // К доплате после скидки = 5000
    expect(screen.getByText(/К доплате/)).toBeInTheDocument();
    expect(screen.getByText(/5\s?000/)).toBeInTheDocument();
    // PDF link присутствует
    const link = screen.getByRole("link", { name: /PDF доб-сметы/ });
    expect(link.getAttribute("href")).toBe("/api/addon-estimates/b1/export/pdf");
  });

  it("does NOT render «Доб-смета» block when addon is null", async () => {
    vi.spyOn(scanApi, "getAddonEstimate").mockResolvedValue({ addon: null });

    render(<IssueChecklist sessionId="s1" projectName="P" onBack={() => {}} />);
    (await screen.findByRole("button", { name: /Завершить выдачу/ })).click();
    // Wait for сверка badge first
    await screen.findByText(/Готово к выдаче/);
    expect(screen.queryByText(/Доб-смета/)).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run — expect failure**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  npm run test --workspace=apps/web -- src/components/warehouse/__tests__/IssueSummary.test.tsx 2>&1 | tail -10
```

- [ ] **Step 3: Add useEffect + block render in `IssueChecklist.tsx`**

In `IssueChecklist.tsx`, near the top of the component (after other useState's), add:

```ts
const [addonEstimate, setAddonEstimate] = useState<AddonEstimateView | null>(null);
```

Import the type at the top of file:

```ts
import type { AddonEstimateView } from "./types";
```

After the existing `useEffect` that loads `getSummary` on entering summary phase, add a parallel effect for addon:

```ts
useEffect(() => {
  if (phase !== "summary") return;
  let cancelled = false;
  scanApi.getAddonEstimate(state.bookingId)
    .then((r) => {
      if (cancelled) return;
      setAddonEstimate(r.addon);
    })
    .catch((err) => {
      if (cancelled) return;
      console.warn("getAddonEstimate failed:", err);
      setAddonEstimate(null);
    });
  return () => {
    cancelled = true;
  };
}, [phase, state.bookingId]);
```

In the summary-phase render block, after the existing stat rows, before the action buttons («← К чек-листу», «Подтвердить выдачу»), insert:

```tsx
{addonEstimate && addonEstimate.lines.length > 0 && (
  <div className="mt-4 rounded-lg border border-border bg-surface px-3 py-3">
    <div className="eyebrow mb-2">Доб-смета</div>
    <ul className="space-y-1">
      {addonEstimate.lines.map((l, i) => (
        <li key={i} className="flex justify-between text-[13px] text-ink">
          <span className="truncate">{l.name} <span className="text-ink-3">×{l.quantity}</span></span>
          <span className="mono-num">{formatRub(l.lineSum)}</span>
        </li>
      ))}
    </ul>
    <div className="mt-2 border-t border-border pt-2 text-[12px] text-ink-2">
      <div className="flex justify-between"><span>Итого:</span> <span className="mono-num">{formatRub(addonEstimate.subtotal)}</span></div>
      {addonEstimate.discountPercent && Number(addonEstimate.discountPercent) > 0 && (
        <div className="flex justify-between"><span>Скидка {addonEstimate.discountPercent}% (как в основной):</span> <span className="mono-num">−{formatRub(addonEstimate.discountAmount)}</span></div>
      )}
      <div className="flex justify-between font-semibold text-ink"><span>К доплате:</span> <span className="mono-num">{formatRub(addonEstimate.totalAfterDiscount)}</span></div>
    </div>
    <a
      href={`/api/addon-estimates/${state.bookingId}/export/pdf`}
      target="_blank"
      rel="noreferrer"
      className="mt-2 inline-block text-[12px] text-accent underline hover:no-underline"
      aria-label="Открыть PDF доб-сметы"
    >
      Открыть PDF доб-сметы →
    </a>
  </div>
)}
```

`formatRub` already exists in `src/lib/format`. Import it at the top of file if not already:

```ts
import { formatRub } from "../../lib/format";
```

- [ ] **Step 4: Re-run tests — expect green**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  npm run test --workspace=apps/web -- src/components/warehouse/__tests__/IssueSummary.test.tsx 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  git add apps/web/src/components/warehouse/IssueChecklist.tsx \
          apps/web/src/components/warehouse/__tests__/IssueSummary.test.tsx && \
  git commit -m "feat(web): IssueChecklist summary — блок «Доб-смета» с lines + PDF

Когда оператор открывает сверку (phase='summary'), параллельно загружается
ADDON Estimate через GET /api/addon-estimates/:bookingId. Если addon существует
и имеет lines — рендерим блок с разбивкой по позициям, итогом, скидкой и
ссылкой «Открыть PDF доб-сметы →»."
```

---

## Task 13: `IssueResultView` — блок «Финансы»

**Files:**
- Modify: `apps/web/src/components/warehouse/IssueResultView.tsx`
- Modify: `apps/web/src/components/warehouse/__tests__/IssueResultView.test.tsx`

- [ ] **Step 1: Failing test**

In `IssueResultView.test.tsx`, add:

```ts
  it("renders Финансы block with main/addon/final breakdown when addonAfterDiscount > 0", () => {
    render(
      <IssueResultView
        result={{
          ...defaultCompleteResult,
          mainAfterDiscount: "5000",
          addonAfterDiscount: "3000",
          finalAmount: "8000",
        }}
        issuedCount={3}
        addonsCount={1}
        substitutedCount={0}
        projectName="P"
        onDone={() => {}}
      />,
    );
    expect(screen.getByText(/Согласовано/)).toBeInTheDocument();
    expect(screen.getByText(/5\s?000/)).toBeInTheDocument();
    expect(screen.getByText(/Доб-смета/)).toBeInTheDocument();
    expect(screen.getByText(/3\s?000/)).toBeInTheDocument();
    expect(screen.getByText(/К оплате/)).toBeInTheDocument();
    expect(screen.getByText(/8\s?000/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Скачать смету.*общая.*PDF/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Скачать доб-смета.*PDF/ })).toBeInTheDocument();
  });

  it("does NOT render Финансы block when addonAfterDiscount === '0'", () => {
    render(
      <IssueResultView
        result={{
          ...defaultCompleteResult,
          mainAfterDiscount: "5000",
          addonAfterDiscount: "0",
          finalAmount: "5000",
        }}
        issuedCount={3}
        addonsCount={0}
        substitutedCount={0}
        projectName="P"
        onDone={() => {}}
      />,
    );
    expect(screen.queryByText(/Согласовано/)).not.toBeInTheDocument();
  });
```

(`defaultCompleteResult` is the existing fixture in this test file — if it lacks the new finance fields, add them as `"0"` so existing tests pass.)

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Add Финансы block in `IssueResultView.tsx`**

In `apps/web/src/components/warehouse/IssueResultView.tsx`, find the existing dl with «Выдано / Добавлено доборов / Замены». Below it (before the «Готово» action button), add:

```tsx
{Number(result.addonAfterDiscount) > 0 && (
  <div className="mt-4 rounded-lg border border-border bg-surface px-3 py-3">
    <div className="eyebrow mb-2">Финансы</div>
    <dl className="space-y-1 text-[13px] text-ink">
      <div className="flex justify-between">
        <dt className="text-ink-2">Согласовано:</dt>
        <dd className="mono-num">{formatRub(result.mainAfterDiscount)}</dd>
      </div>
      <div className="flex justify-between">
        <dt className="text-ink-2">Доб-смета:</dt>
        <dd className="mono-num">+ {formatRub(result.addonAfterDiscount)}</dd>
      </div>
      <div className="flex justify-between border-t border-border pt-1 font-semibold">
        <dt>К оплате:</dt>
        <dd className="mono-num">{formatRub(result.finalAmount)}</dd>
      </div>
    </dl>
    <div className="mt-3 flex gap-2">
      <a
        href={`/api/bookings/${result.sessionId}/full-estimate/export/pdf`}
        target="_blank"
        rel="noreferrer"
        className="flex-1 rounded border border-border bg-surface px-3 py-2 text-center text-[12px] font-medium text-ink-2 hover:bg-surface-muted"
      >
        Скачать смету (общая) PDF
      </a>
      <a
        href={`/api/addon-estimates/${result.sessionId}/export/pdf`}
        target="_blank"
        rel="noreferrer"
        className="flex-1 rounded border border-border bg-surface px-3 py-2 text-center text-[12px] font-medium text-ink-2 hover:bg-surface-muted"
      >
        Скачать доб-смета PDF
      </a>
    </div>
  </div>
)}
```

⚠️ Important: in the spec, the PDFs use `bookingId` not `sessionId`. The `IssueResultView` currently receives `result.sessionId` but needs `bookingId`. Two options:
1. Add `bookingId` prop to `IssueResultView` (cleaner but requires updating tests + caller).
2. Use `result.bookingId` if it's already in ReconciliationSummary. Check.

Looking at the current `ReconciliationSummary` — it doesn't have `bookingId`. So option 1: add `bookingId` to `IssueResultView` props:

```ts
export function IssueResultView({
  result,
  bookingId,    // ← new
  projectName,
  issuedCount,
  addonsCount,
  substitutedCount,
  onDone,
}: {
  result: CompleteResult;
  bookingId: string;
  projectName: string;
  issuedCount: number;
  addonsCount: number;
  substitutedCount: number;
  onDone: () => void;
}) {
```

And in `IssueChecklist.tsx`, when rendering `<IssueResultView />`, pass `bookingId={state.bookingId}`.

Update tests to pass `bookingId="b1"` in all calls.

In the new Финансы block, use `bookingId` instead of `result.sessionId` in the link hrefs.

- [ ] **Step 4: Re-run tests — expect green**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  npm run test --workspace=apps/web -- \
    src/components/warehouse/__tests__/IssueResultView.test.tsx \
    src/components/warehouse/__tests__/IssueSummary.test.tsx 2>&1 | tail -10
```

- [ ] **Step 5: Commit**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  git add apps/web/src/components/warehouse/IssueResultView.tsx \
          apps/web/src/components/warehouse/IssueChecklist.tsx \
          apps/web/src/components/warehouse/__tests__/IssueResultView.test.tsx && \
  git commit -m "feat(web): IssueResultView — блок «Финансы» (Согласовано / Доб-смета / К оплате)

Рендерится только если addonAfterDiscount > 0. Две PDF-ссылки: общая
смета (main+addon) и доб-смета отдельно. IssueResultView получает
новый prop bookingId для построения PDF URL'ов."
```

---

## Task 14: Booking detail — секция «Доб-смета» (out-of-warehouse)

**Files:**
- Create: `apps/web/src/components/bookings/AddonEstimateSection.tsx`
- Create: `apps/web/src/components/bookings/__tests__/AddonEstimateSection.test.tsx`
- Modify: `apps/web/app/bookings/[id]/page.tsx` (если такая страница есть) или соответствующий booking detail компонент.

This task lands a slim implementation per spec §5.5 ("Этот шаг точечно дополняет UX").

- [ ] **Step 1: Create the component**

```tsx
"use client";

import { useEffect, useState } from "react";
import { formatRub } from "../../lib/format";
import { scanApi } from "../warehouse/api";
import type { AddonEstimateView } from "../warehouse/types";

/**
 * Секция «Доб-смета» на странице брони. Грузит ADDON Estimate через
 * `GET /api/addon-estimates/:bookingId`. Не рендерится если addon null
 * (бронь без доборов).
 */
export function AddonEstimateSection({ bookingId }: { bookingId: string }) {
  const [addon, setAddon] = useState<AddonEstimateView | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    scanApi
      .getAddonEstimate(bookingId)
      .then((r) => {
        if (!cancelled) {
          setAddon(r.addon);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [bookingId]);

  if (!loaded || !addon || addon.lines.length === 0) return null;

  return (
    <section className="mt-6 rounded-lg border border-border bg-surface p-4">
      <h2 className="text-[14px] font-semibold text-ink">Доб-смета</h2>
      <p className="text-[12px] text-ink-3 mb-3">
        Позиции, добавленные при выдаче поверх согласованной сметы.
      </p>
      <table className="w-full text-[13px]">
        <thead className="text-[11px] uppercase tracking-wider text-ink-3">
          <tr className="border-b border-border">
            <th className="py-2 text-left">Позиция</th>
            <th className="py-2 text-right">Кол-во</th>
            <th className="py-2 text-right">Сумма</th>
          </tr>
        </thead>
        <tbody>
          {addon.lines.map((l, i) => (
            <tr key={i} className="border-b border-border last:border-0">
              <td className="py-1.5">{l.name}</td>
              <td className="py-1.5 text-right mono-num">×{l.quantity}</td>
              <td className="py-1.5 text-right mono-num">{formatRub(l.lineSum)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="text-[12px]">
          <tr><td colSpan={2} className="pt-2 text-right">Итого:</td><td className="pt-2 text-right mono-num">{formatRub(addon.subtotal)}</td></tr>
          {addon.discountPercent && Number(addon.discountPercent) > 0 && (
            <tr><td colSpan={2} className="text-right">Скидка {addon.discountPercent}%:</td><td className="text-right mono-num">−{formatRub(addon.discountAmount)}</td></tr>
          )}
          <tr className="font-semibold"><td colSpan={2} className="text-right">К доплате:</td><td className="text-right mono-num">{formatRub(addon.totalAfterDiscount)}</td></tr>
        </tfoot>
      </table>
      <div className="mt-3 flex gap-2 text-[12px]">
        <a
          href={`/api/addon-estimates/${bookingId}/export/pdf`}
          target="_blank"
          rel="noreferrer"
          className="rounded border border-border px-3 py-1.5 hover:bg-surface-muted"
        >
          PDF доб-сметы
        </a>
        <a
          href={`/api/bookings/${bookingId}/full-estimate/export/pdf`}
          target="_blank"
          rel="noreferrer"
          className="rounded border border-border px-3 py-1.5 hover:bg-surface-muted"
        >
          PDF общая смета
        </a>
        <a
          href={`/api/addon-estimates/${bookingId}/export/xlsx`}
          target="_blank"
          rel="noreferrer"
          className="rounded border border-border px-3 py-1.5 hover:bg-surface-muted"
        >
          XLSX доб-сметы
        </a>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Test**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AddonEstimateSection } from "../AddonEstimateSection";
import { scanApi } from "../../warehouse/api";

describe("AddonEstimateSection", () => {
  it("renders nothing if addon is null", async () => {
    vi.spyOn(scanApi, "getAddonEstimate").mockResolvedValue({ addon: null });
    const { container } = render(<AddonEstimateSection bookingId="b1" />);
    await waitFor(() => expect(container.querySelector("section")).toBeNull());
  });

  it("renders lines, totals, and 3 download links when addon exists", async () => {
    vi.spyOn(scanApi, "getAddonEstimate").mockResolvedValue({
      addon: {
        id: "ae1",
        bookingId: "b1",
        shifts: 2,
        subtotal: "10000",
        discountPercent: "50",
        discountAmount: "5000",
        totalAfterDiscount: "5000",
        lines: [
          { equipmentId: "v", name: "Vmount", category: "Электрика", quantity: 5, unitPrice: "1000", lineSum: "10000" },
        ],
      },
    });
    render(<AddonEstimateSection bookingId="b1" />);
    expect(await screen.findByText(/Доб-смета/)).toBeInTheDocument();
    expect(screen.getByText("Vmount")).toBeInTheDocument();
    expect(screen.getByText(/PDF доб-сметы/)).toBeInTheDocument();
    expect(screen.getByText(/PDF общая смета/)).toBeInTheDocument();
    expect(screen.getByText(/XLSX доб-сметы/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Mount the section on the booking detail page**

Find the booking detail page. Run:

```bash
ls /Users/sechenov/Documents/light-rental-system/apps/web/app/bookings/
```

If there's a `[id]/page.tsx` или similar — open it and add `<AddonEstimateSection bookingId={booking.id} />` рядом с другими секциями (например, под сметой / описанием).

If the booking detail page is not yet present (or shows estimate inline only), add a single import + render. The exact placement depends on the existing layout — the implementer should locate the appropriate slot and add one import + one JSX line.

- [ ] **Step 4: Run tests**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  npm run test --workspace=apps/web -- src/components/bookings/__tests__/AddonEstimateSection.test.tsx 2>&1 | tail -10
```

- [ ] **Step 5: Commit**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  git add apps/web/src/components/bookings/AddonEstimateSection.tsx \
          apps/web/src/components/bookings/__tests__/AddonEstimateSection.test.tsx \
          apps/web/app/bookings && \
  git commit -m "feat(web): AddonEstimateSection — секция «Доб-смета» на странице брони

Live-загрузка через getAddonEstimate; рендерит lines, totals со скидкой
и 3 download-ссылки (PDF доб-сметы, PDF общая смета, XLSX доб-сметы).
Если addon null — секция не рендерится."
```

---

## Task 15: Full test sweep + PR + deploy + verify

- [ ] **Step 1: Full backend + frontend test sweep**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  npm run test --workspace=apps/api -- \
    src/__tests__/addonEstimate.test.ts \
    src/__tests__/addonFinanceFlow.test.ts \
    src/__tests__/addonEstimateRoutes.test.ts \
    src/__tests__/fullEstimateRoutes.test.ts \
    src/__tests__/warehouseScanIssueComplete.test.ts \
    src/__tests__/customBookingItem.test.ts \
    src/__tests__/multiVehicle.test.ts \
    src/__tests__/approval.test.ts \
    src/__tests__/pdfEndpoints.test.ts \
    src/__tests__/payments.routes.test.ts 2>&1 | tail -10 && \
  npm run test --workspace=apps/web 2>&1 | tail -5
```

Expected: всё зелёное.

- [ ] **Step 2: Push + open PR**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  git -c "credential.helper=!gh auth git-credential" push -u origin feat/addon-estimate 2>&1 | tail -3 && \
  gh pr create --title "feat(warehouse): добор-смета как отдельный документ для клиента" --body "$(cat <<'EOF'
## Summary

Каждый добор во время выдачи теперь автоматически создаёт/обновляет отдельный **ADDON Estimate** snapshot (lines + цены + скидка как у MAIN). PDF/XLSX доступны клиенту через новые endpoint'ы. `Booking.finalAmount` корректно учитывает доборы (закрывает существующую дыру).

Spec: `docs/superpowers/specs/2026-05-21-addon-estimate-design.md`
Plan: `docs/superpowers/plans/2026-05-21-addon-estimate.md`

## Architecture

`Estimate.kind ∈ {MAIN, ADDON}`, compound unique `[bookingId, kind]`. Новая таблица `AddonRecord` — per-добор дельта (source of truth). Live: каждый `addExtraItem` → `AddonRecord.create` → `recomputeAddonEstimate` → `recomputeBookingFinance`. Существующая smeta-machinery переиспользуется.

## Endpoint'ы

- `GET /api/addon-estimates/:bookingId` — JSON метаданных доб-сметы (или null)
- `GET /api/addon-estimates/:bookingId/export/pdf|xlsx` — отдельный PDF/XLSX доб-сметы
- `GET /api/bookings/:id/full-estimate/export/pdf|xlsx` — main + addon в одном файле

## Out-of-scope

- Отдельные платежи под доб-смету (Payment остаётся одна на бронь)
- Backfill исторических доборов
- Editing/cancelling доборов в UI (AddonRecord только добавляются)
- Доборы при RETURN

## Test plan

- [ ] CI зелёный
- [ ] Auto-deploy через `deploy-rsync.yml`
- [ ] На прод: открыть тест-бронь → ISSUE → добор ×3 Vmount → проверить блок «Доб-смета» на сверке → подтвердить выдачу → result-screen «Финансы» → скачать обе PDF → бронь в RETURN-листе с корректным outstanding

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)" 2>&1 | tail -3
```

- [ ] **Step 3: Squash-merge**

```bash
gh pr merge <PR_NUMBER> --squash --subject "feat(warehouse): добор-смета как отдельный документ (#PR)" --body "See PR description for full details." 2>&1 | tail -3
```

- [ ] **Step 4: Watch deploy**

```bash
gh run list --workflow=deploy-rsync.yml --limit 1 && \
  gh run watch <RUN_ID> --exit-status --interval 30 2>&1 | tail -5
```

- [ ] **Step 5: Prod smoke**

На https://svetobazarent.ru/warehouse/scan:
1. Открыть тест-бронь, начать выдачу
2. Добавить ×3 Vmount через добор
3. Убедиться в success-line: «Доб-смета обновлена · Открыть PDF →»
4. Кликнуть PDF — должен открыться корректный документ
5. Нажать «Завершить выдачу» → на сверке должен быть блок «Доб-смета»
6. Подтвердить → на result-screen блок «Финансы» с правильными суммами
7. Открыть прод admin интерфейс брони → секция AddonEstimateSection видна
8. Скачать full-PDF и addon-PDF, оба корректны

- [ ] **Step 6: Cleanup branches**

```bash
cd /Users/sechenov/Documents/light-rental-system && \
  git checkout main && \
  git pull --ff-only origin main && \
  git branch -D feat/addon-estimate && \
  git -c "credential.helper=!gh auth git-credential" push origin --delete feat/addon-estimate
```

---

## Self-Review

**Spec coverage:**
- ✅ §3.1 Schema (EstimateKind, kind, compound unique, AddonRecord, addonAmount) → Task 1
- ✅ §3.2 Жизненный цикл — Task 4 (addExtraItem) + Task 5 (flow test)
- ✅ §4.1 addExtraItem → Task 4
- ✅ §4.2 recomputeAddonEstimate → Task 3
- ✅ §4.3 recomputeBookingFinance → Task 2 + verified in Task 5
- ✅ §4.4 routes/addonEstimates → Task 8; full estimate → Task 9
- ✅ §4.5 smetaExport — kind-aware + buildFullSmeta → Task 7
- ✅ §4.6 completeSession finance fields → Task 6
- ✅ §5.1 AddonSearch PDF link → Task 11
- ✅ §5.2 IssueChecklist Доб-смета block → Task 12
- ✅ §5.3 IssueResultView Финансы block → Task 13
- ✅ §5.4 frontend types/api → Task 10
- ✅ §5.5 Booking detail section → Task 14
- ✅ §6 граничные случаи → impliciated by tests in Task 3/4/5 (CANCELLED session filter, pустой addon → delete, FULLY_PAID → PARTIALLY_PAID transition)
- ✅ §7 тесты → каждый Task с corresponding test
- ✅ §8 миграция → Task 1 step 5 (`prisma db push`)
- ✅ §9 out-of-scope → reflected in PR description (Task 15 step 2)
- ✅ §10 acceptance → Task 15 step 5 prod smoke covers all bullets

**Placeholder scan:** Не найдено TBD/TODO/«implement later». Все steps содержат конкретный код, точные пути, ожидаемые команды. Один комментарий «(TODO: refactor шарят draw helpers — out of scope этого PR)» в Task 7 step 4 описывает понимание ограничения, не пропуск — план явно refактoрит `writeSmetaPdf` в Task 7 step 5.

**Type consistency:**
- `EstimateKind` enum используется одинаково в schema, services, routes, tests
- `AddonRecord` поля совпадают по name между schema (Task 1), service usage (Task 3), test asserts (Task 3, 4)
- `AddonEstimateView` (frontend Task 10) ↔ `serializeEstimateForJson(addon)` output (backend Task 8) — поля совпадают (id, bookingId, shifts, subtotal, discountPercent, discountAmount, totalAfterDiscount, lines)
- `CompleteResult` finance fields (Task 6 backend → Task 10 frontend) совпадают: `mainAfterDiscount`, `addonAfterDiscount`, `finalAmount` (все string Decimal serializations)
- `bookingId` prop name consistent across AddonSearch (Task 11), IssueResultView (Task 13), AddonEstimateSection (Task 14)

No inconsistencies found.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-21-addon-estimate.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — fresh subagent per task + two-stage review (spec compliance, then code quality) between tasks. Best for this plan because Task 1 + Task 2 are foundational refactor with high regression risk — review между ними важен.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints. Faster but more risk on the foundation tasks.

**Which approach?**
