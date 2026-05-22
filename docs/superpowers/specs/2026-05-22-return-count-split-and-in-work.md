# Return COUNT-split + «В работе» — design spec

**Date:** 2026-05-22
**Status:** Approved (brainstorming complete, ready for implementation plan)
**Scope:** Return-checklist + new «В работе» tab in /warehouse/scan

---

## Problem statement

Three issues surfaced on the warehouse return (приёмка) page after PR #170 deploy:

1. **«Принято» нельзя отжать.** Для COUNT-позиций (например «Зарядки астера ×2») клик на «Принято» добавляет в `Set<bookingItemId>`, повторный клик игнорируется. Если кладовщик нажал ошибочно — отменить нельзя.

2. **«Ремонт» и «Проблема» — visual-only для COUNT.** UnitRow вызывает `onChange("REPAIR")`/`onChange("PROBLEM")`, но `setCountLine` принимает только bool (accepted/not), так что для COUNT-rows эти кнопки игнорируются. Backend инфраструктура `repairUnits[]`/`problemUnits[]` готова, frontend для COUNT не подключён.

3. **Нет раздела «В работе».** После выдачи бронь со статусом `ISSUED` пропадает из «Выдача», доступна только через «Возврат» как кандидат на приёмку. Нет read-only списка «что сейчас у клиентов на руках».

---

## Decisions log (брейнсторминг)

| Решение | Выбрано |
|---|---|
| COUNT-row UX | Три кнопки + счётчик «осталось пометить» + три цветные пилюли распределения. |
| Inline-панели | Repair/Problem-панель раскрывается под рядом когда `repair ≥ 1` / `problem ≥ 1` (один комментарий на весь bucket). |
| Отжать «Принято» | Клик на цветную пилюлю (например «✓ 2») → −1 единица в pending. |
| Сплит по количеству | `accepted + repair + problem ≤ totalQty`, остаток = pending. |
| Backend форма payload | Discriminated union: `equipmentUnitId` (UNIT) ИЛИ `bookingItemId + quantity` (COUNT). |
| «В работе» — где | Третья операция в `/warehouse/scan` рядом с «Выдача» и «Возврат». |
| «В работе» — карточки | Компактные: проект · клиент · дата дедлайна (overdue в красном). Клик → детали. |
| Auth | Тот же `warehouseAuth` (PIN). Никаких новых ролей. |

---

## Architecture

### Data flow (COUNT-split)

```text
ReturnChecklist (frontend)
  ├─ outcomes: Map<unitId, OutcomeDraft>                  ← существующее, UNIT-режим
  └─ countSplits: Map<bookingItemId, CountSplit>          ← NEW
        plus countRepairComments: Map<bookingItemId, string>
        plus countProblems: Map<bookingItemId, ProblemDraft>

CountSplit = { accepted: int, repair: int, problem: int }
pending = totalQty − accepted − repair − problem  ≥ 0
```

«Завершить приёмку» собирает payload:

```ts
const repairUnits: RepairUnitInput[] = [];
const problemUnits: ProblemUnitInput[] = [];

// UNIT-режим — как сейчас (по equipmentUnitId per юнит).
// ...

// COUNT-режим — по bookingItemId + quantity.
for (const [biId, split] of countSplits) {
  if (split.repair > 0) repairUnits.push({
    bookingItemId: biId,
    quantity: split.repair,
    comment: countRepairComments.get(biId) ?? "",
  });
  if (split.problem > 0) {
    const p = countProblems.get(biId)!;
    problemUnits.push({
      bookingItemId: biId,
      quantity: split.problem,
      reason: p.reason!,
      comment: p.comment,
      expectedBackDate: p.expectedBackDate,
    });
  }
}

POST /api/warehouse/sessions/:id/complete
  body: { repairUnits, problemUnits, ... }
```

### Data flow («В работе»)

```text
GET /api/warehouse/in-work
  → Booking.findMany({ status: "ISSUED", orderBy: endDate asc })
  → projection: { bookingId, displayNo, projectName, clientName, issuedAt,
                  expectedReturnAt, itemsCount, finalAmount, isOverdue, overdueDays }
  → response: { bookings: [...] }

Frontend: InWorkList (cards) → InWorkDetails (read-only items + finance)
         → optional «← Принять обратно» button → reuses RETURN session flow
```

### Components and boundaries

**Backend services:**
- `services/warehouseScan.ts → completeSession` — расширяется обработкой COUNT-формы `repairUnits[]`/`problemUnits[]` (validation + persistence to existing report tables).
- `routes/warehouse.ts → /sessions/:id/complete` — Zod-схема для discriminated union (UNIT vs COUNT) форм.
- `routes/warehouse.ts → /in-work` (NEW endpoint) — list ISSUED-броней.
- `routes/warehouse.ts → /in-work/:bookingId/details` (NEW endpoint) — read-only детали брони для «В работе» view.

**Frontend components:**
- `components/warehouse/CountSplitRow.tsx` (NEW) — 3-bucket контрол для COUNT-позиций при приёмке.
- `components/warehouse/ReturnChecklist.tsx` (modified) — state расширяется `countSplits` + render-ветка для COUNT-rows подменяется с UnitRow на CountSplitRow.
- `components/warehouse/InWorkList.tsx` (NEW) — компактные карточки активных выдач.
- `components/warehouse/InWorkDetails.tsx` (NEW) — read-only детали выдачи + кнопка «← Принять обратно».
- `app/warehouse/scan/page.tsx` — расширяется operation state: `"ISSUE" | "RETURN" | "IN_WORK"`.

**Backend types:**

```ts
export interface RepairUnitInput {
  // discriminated union — exactly one of these two paths is populated:
  equipmentUnitId?: string;            // UNIT-mode
  bookingItemId?: string;              // COUNT-mode
  quantity?: number;                   // COUNT-mode only (UNIT implies 1)
  comment: string;
}

export interface ProblemUnitInput {
  equipmentUnitId?: string;            // UNIT-mode
  bookingItemId?: string;              // COUNT-mode
  quantity?: number;                   // COUNT-mode only
  reason: ProblemReason;
  comment: string;
  expectedBackDate?: string;
}
```

Zod validation: `z.union([UnitFormSchema, CountFormSchema])` per array element.

---

## UI specification

### `CountSplitRow` (новый компонент)

```
┌─────────────────────────────────────────────────────────────────┐
│  Штатив Avenger A100                                             │
│  осталось пометить ×1 из 3                                       │
│                                                                  │
│  pills:                  action buttons:                         │
│  [✓ 2] [🔧 0] [✗ 0]      [✓ Принять 1] [🔧 Ремонт 1] [✗ Проблема]│
│                                                                  │
│  ── inline repair panel (если split.repair ≥ 1) ──               │
│  Комментарий: [_________________________________________]        │
│                                                                  │
│  ── inline problem panel (если split.problem ≥ 1) ──             │
│  Причина: [Сломан ▼]  Дата возврата: [__/__/____]                │
│  Комментарий: [_________________________________________]        │
└─────────────────────────────────────────────────────────────────┘
```

**Visual states:**
- `accepted = totalQty` → row tint `bg-emerald-soft/30`, left rail `border-l-4 border-emerald`.
- `repair ≥ 1 && problem == 0` → amber rail.
- `problem ≥ 1` → rose rail (priority over amber).
- `pending > 0` → neutral.

**Behavior:**
- «✓ Принять 1» / «🔧 Ремонт 1» / «✗ Проблема 1» — disabled когда `pending = 0`.
- Цветные пилюли — clickable когда соответствующий bucket ≥ 1; клик → −1 в pending.
- Shortcut: если `pending == totalQty` (ничего ещё не помечено), клик «✓ Принять 1» → `accepted = totalQty` (одним кликом всё в Принято).
- Inline-панели рендерятся декларативно по N≥1; исчезают когда декремент возвращает N=0.

### `ReturnChecklist` изменения

1. State модель:
   - Было: `countAccepted: Set<bookingItemId>` (бинарно).
   - Стало: `countSplits: Map<bookingItemId, CountSplit>` (по умолчанию `{accepted:0, repair:0, problem:0}`).
   - Дополнительно: `countRepairComments: Map<string, string>`, `countProblems: Map<string, ProblemDraft>`.

2. Render-ветка COUNT-rows подменяется с `UnitRow` на `CountSplitRow`.

3. `acceptAll()` для COUNT: `split = { accepted: bi.quantity, repair: 0, problem: 0 }`.

4. `computeAcceptedCount` обновляется: `accepted += split.accepted`.

5. Валидация в `handleComplete`:
   - `pending > 0` → ошибка «Ряд X: осталось пометить N».
   - `repair ≥ 1 && !comment.trim()` → ошибка «Введите комментарий ремонта».
   - `problem ≥ 1 && (!reason || !comment.trim())` → ошибка.

### Three-tab operation control (`/warehouse/scan`)

```
┌─────────────────────────────────────────────────────────┐
│  Выдача (3)    Возврат (5)    В работе (5)              │
└─────────────────────────────────────────────────────────┘
```

Третий tab «В работе (N)» рендерит `InWorkList`. Click на карточку → `InWorkDetails`.

### `InWorkList` карточка

```tsx
<button type="button" onClick={() => onSelect(b.bookingId)}
  className={`w-full text-left rounded-lg border px-4 py-3 ${isOverdue ? "border-rose-border bg-rose-soft/30" : "border-border bg-surface"}`}>
  <div className="flex justify-between items-start gap-2">
    <div className="min-w-0 flex-1">
      <p className="text-[11px] text-ink-3 uppercase">
        {b.displayNo} · взято {fmtDate(b.issuedAt)}
      </p>
      <p className="mt-1 text-sm font-semibold">{b.projectName}</p>
      <p className="text-[12px] text-ink-2">{b.clientName}</p>
    </div>
    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${isOverdue ? "bg-rose text-white" : "bg-amber-soft text-amber"}`}>
      {isOverdue ? `просрочка ${overdueDays} ${plural(overdueDays, "день","дня","дней")}` : `до ${fmtDate(b.expectedReturnAt)}`}
    </span>
  </div>
  <p className="mt-2 text-[12px] text-ink-3">{b.itemsCount} позиций</p>
</button>
```

Сортировка: по `endDate asc` (ближайший дедлайн первым).

### `InWorkDetails` (read-only)

- Header: проект, клиент, displayNo, issuedAt, expectedReturnAt (overdue в красном).
- Полный список оборудования (категории + name + qty).
- Финансы: согласовано / фактически / оплачено / остаток.
- Кнопки:
  - **«← Принять обратно»** — переключает operation в `RETURN`, открывает ReturnChecklist для этой брони (reuse существующего create-or-resume session flow).
  - **«Открыть в /bookings/[id]»** — навигация (только если роль SUPER_ADMIN).

---

## API contracts

### Existing: `POST /api/warehouse/sessions/:id/complete`

Body shape extends (backwards-compatible):

```ts
{
  repairUnits?: Array<
    | { equipmentUnitId: string; comment: string }                          // UNIT
    | { bookingItemId: string; quantity: number; comment: string }          // COUNT
  >;
  problemUnits?: Array<
    | { equipmentUnitId: string; reason: ProblemReason; comment: string; expectedBackDate?: string }
    | { bookingItemId: string; quantity: number; reason: ProblemReason; comment: string; expectedBackDate?: string }
  >;
  // existing fields preserved
}
```

Errors:
- `400 INVALID_SPLIT { bookingItemId, accepted, repair, problem, totalQty }` — when `accepted + repair + problem > totalQty`.

### New: `GET /api/warehouse/in-work`

Response:
```ts
{
  bookings: Array<{
    bookingId: string;
    displayNo: string;
    projectName: string;
    clientName: string;
    issuedAt: string | null;            // ISO
    expectedReturnAt: string;           // ISO (Booking.endDate)
    itemsCount: number;                 // BookingItem rows with quantity > 0
    finalAmount: string;
    isOverdue: boolean;
    overdueDays: number;                // 0 if not overdue
  }>
}
```

### New: `GET /api/warehouse/in-work/:bookingId/details`

Response: read-only mirror of `getChecklistState` shape **without** session-specific fields, plus финансы. Returns 404 if booking is not in `ISSUED` status.

```ts
{
  bookingId: string;
  projectName: string;
  clientName: string;
  issuedAt: string | null;
  expectedReturnAt: string;
  items: Array<ChecklistItem>;          // reuse type
  finance: {
    mainAfterDiscount: string;
    addonAfterDiscount: string;
    finalAmount: string;
    amountPaid: string;
    outstanding: string;
    paymentStatus: BookingPaymentStatus;
  };
}
```

---

## Schema migration

Existing report tables (verified by inspection of `prisma/schema.prisma`):

- **`Repair`** (line 801): `unitId String` (NOT NULL) → `EquipmentUnit`. UNIT-only.
- **`ProblemItem`** (line 1181): `equipmentUnitId String` (NOT NULL) → `EquipmentUnit`. UNIT-only.

For COUNT-mode reports we need to relax these constraints. Required migration:

```prisma
model Repair {
  id              String   @id @default(cuid())
  unitId          String?         // CHANGED: now nullable (was NOT NULL)
  unit            EquipmentUnit?  @relation(fields: [unitId], references: [id])
  // NEW for COUNT-mode reports:
  bookingItemId   String?
  bookingItem     BookingItem?    @relation(fields: [bookingItemId], references: [id], onDelete: SetNull)
  quantity        Int             @default(1)
  // ...existing fields preserved
}

model ProblemItem {
  id               String         @id @default(cuid())
  equipmentUnitId  String?        // CHANGED: now nullable
  equipmentUnit    EquipmentUnit? @relation(fields: [equipmentUnitId], references: [id])
  // NEW for COUNT-mode reports:
  bookingItemId    String?
  bookingItem      BookingItem?   @relation(fields: [bookingItemId], references: [id], onDelete: SetNull)
  quantity         Int            @default(1)
  // ...existing fields preserved
}
```

Invariant (enforced by service, not DB): exactly one of `unitId`/`equipmentUnitId` OR `bookingItemId` is populated per row. Default `quantity = 1` keeps existing UNIT-rows semantically correct (one unit reported = quantity 1).

No data backfill — все existing rows keep `unitId`/`equipmentUnitId` populated and get default `quantity = 1`.

`BookingItem` model gets reverse relations: `repairs Repair[]` and `problems ProblemItem[]` (additive, no breaking).

---

## Audit trail

For COUNT-mode splits, existing audit actions (the ones currently emitted on UNIT-mode repair/problem creation — exact codes confirmed during implementation by grep of `writeAuditEntry` calls in `warehouseScan.ts`) are reused with `bookingItemId`, `quantity`, `equipmentName` in `after`-payload. One non-zero bucket = one audit entry (not multiplied per единица).

«В работе» tab is read-only — no audit.

---

## Edge cases

### Сплит даёт sum > totalQty
- **UI prevention:** action buttons disabled when `pending = 0`.
- **Backend defence:** `completeSession` validates `accepted + repair + problem ≤ totalQty`. Excess → `400 INVALID_SPLIT`.

### Сплит даёт sum < totalQty (есть pending)
- «Завершить приёмку» блокируется с inline-ошибкой «Ряд X: осталось пометить N». Existing `validationSummary` инфра reused.

### Передумали — отжать «✓ Принято»
- Клик на пилюлю «✓ 2» → `split.accepted = 1`. Auto re-render row state.
- Если `accepted` была = `totalQty` (ряд был «весь Принято», зелёный) → ряд теряет зелёный rail.

### UNIT-row взаимодействие
- UNIT-режим (per-unit 3-segment) не меняется — reversibility уже есть (клик по той же segment-кнопке снимает).

### «В работе» — бронь только что выдали
- Появляется в `/in-work` сразу.
- Если параллельно открыт «Возврат» — она там тоже видна (это две разные операции с одной бронью, не дубль).

### Кликнул «← Принять обратно» из In-Work details
- Если ScanSession RETURN для этой брони уже active → reuse (createSession idempotent, см. PR #165).
- Иначе → create new RETURN session, navigate к ReturnChecklist.

### Concurrent-приёмка
- Двое кладовщиков открыли одну бронь: backend createSession dedup — оба получают одну сессию.

---

## Testing strategy (TDD)

### Backend unit tests

| Файл | Что покрывает |
|---|---|
| `services/__tests__/completeSessionCountSplit.test.ts` (new) | repairUnits COUNT-форма пишется в BrokenUnitReport с `bookingItemId` + `quantity` + null `equipmentUnitId`; same for problemUnits. |
| `services/__tests__/completeSessionCountSplit.test.ts` | INVALID_SPLIT когда sum > totalQty. |
| `routes/__tests__/inWorkRoute.test.ts` (new) | GET /api/warehouse/in-work возвращает ISSUED bookings sorted by endDate asc; isOverdue correct. |
| `routes/__tests__/inWorkDetails.test.ts` (new) | GET /api/warehouse/in-work/:id/details returns items + finance; 404 for non-ISSUED. |
| `services/__tests__/warehouseScan.brokenUnits.test.ts` (extend) | Zod discriminated union accepts both forms; rejects malformed. |

### Frontend unit tests

| Файл | Что покрывает |
|---|---|
| `components/warehouse/__tests__/CountSplitRow.test.tsx` (new) | Buttons disabled at pending=0; pill click decrements; shortcut «pending=totalQty + click ✓Принять 1 → all accepted»; repair/problem panels appear/disappear on bucket≥1; aria-pressed and aria-labels. |
| `components/warehouse/__tests__/ReturnChecklist.test.tsx` (extend) | COUNT-rows use CountSplitRow; build payload with `bookingItemId + quantity` for COUNT repair/problem; validation pending>0 surfaces row error. |
| `components/warehouse/__tests__/InWorkList.test.tsx` (new) | Cards render; overdue red; click sets selectedBookingId. |
| `components/warehouse/__tests__/InWorkDetails.test.tsx` (new) | Read-only items render; «← Принять обратно» calls scanApi createSession then navigates to RETURN. |

### Integration test

`apps/api/src/__tests__/returnCountSplitFlow.test.ts` (new): full HTTP flow — RETURN session → POST /complete with `{accepted:1, repair:1, problem:1}` for a COUNT-position → assert 3 report rows created with correct shape.

---

## Backwards compatibility

- **Existing UNIT-режим** — без изменений.
- **Existing /complete API** — `repairUnits[]`/`problemUnits[]` принимают оба варианта (UNIT через equipmentUnitId, COUNT через bookingItemId+quantity). Старые клиенты, шлющие UNIT-форму, работают.
- **БД** — миграция (если нужна) только optional поля + default. Без NOT NULL, без backfill.

---

## Out of scope (явно)

- Per-unit разбивка для COUNT при выдаче (IssueChecklist остаётся со степпером без bucket-сплита — это семантика возврата).
- Привязка repair/problem к конкретному физическому юниту для COUNT (нет инвентарных номеров — это и не нужно).
- Фото ремонта для COUNT-сплита (UNIT уже поддерживает; COUNT добавим позже).
- Звонок/SMS клиенту при просрочке из карточки «В работе».
- Bulk-actions на «В работе» (каждая бронь принимается отдельно).
- Calendar/list-view toggle на «В работе» (только list).

---

## Rollout

Один PR, как обычно. Auto-deploy через `deploy-rsync.yml`. После merge — live smoke:

1. COUNT-row сплит на приёмке:
   - Открыть ISSUED-бронь с COUNT-позицией ×3.
   - Видеть 3 кнопки + пилюли + «осталось пометить ×3».
   - «✓ Принять 1» → pending=2.
   - «🔧 В ремонт 1» → панель ремонта, ввести комментарий.
   - «✗ Проблема 1» → панель проблемы, заполнить.
   - Клик на пилюлю «✓ 1» → −1.
   - «Завершить приёмку» → бронь RETURNED, backend пишет 1 BrokenUnit + 1 ProblemUnit с правильными `bookingItemId`+`quantity`.

2. «В работе» tap:
   - Третий tap «В работе (N)» виден между «Выдача» и «Возврат».
   - Компактные карточки; overdue в красном.
   - Клик → детали с полным списком оборудования + финансы.
   - «← Принять обратно» открывает ReturnChecklist для брони.

---

## Open questions

(нет — все ключевые развилки разрешены в брейнсторминге)
