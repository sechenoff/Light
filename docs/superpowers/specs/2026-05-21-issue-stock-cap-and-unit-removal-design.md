# Issue-time stock cap and unit removal — design spec

**Date:** 2026-05-21
**Status:** Approved (brainstorming complete, ready for implementation plan)
**Scope:** Bug fix + new feature on the warehouse `IssueChecklist` page

---

## Problem statement

Two related issues surfaced on the warehouse issue (выдача) page on production:

1. **Bug — unbounded добор.** Кладовщик может бесконечно добавлять единицы через «+Добор», даже когда физический склад исчерпан. Текущая проверка валидирует только конфликт по датам с другими бронями; собственная бронь исключается из расчёта (`excludeBookingId` в `getAvailability`), и `addExtraItem` на бэкенде вообще не сверяется с верхним лимитом. В итоге система допускает фантомные обязательства.

2. **Missing feature — частичное снятие позиций на выдаче.** Сейчас в чек-листе только бинарно: «✓ выдано» или «✕ не выдаём» — для всей позиции целиком. Если в брони ×3 прибора и один сломан / отсутствует / на ремонте — нет способа сказать «выдаю 2 из 3, один снимаем» с автоматическим пересчётом MAIN-сметы. Клиент платит за фактический комплект.

---

## Decisions log (брейнсторминг)

| Решение | Выбрано |
|---|---|
| Bug: лимит добора | Жёсткий стоп — backend не даёт превысить `totalQuantity − occupied_other_bookings`; UI заранее показывает максимум. |
| Снятие: семантика | Уменьшает `BookingItem.quantity` и пересчитывает MAIN-смету. Клиент платит меньше. |
| Когда снимать | Только во время ISSUE-сессии (в `IssueChecklist`). |
| UI ряда | Степпер 0…M + кнопка «Выдать N» / «Не выдаём» (когда N=0). Старая ✕ «не выдаём» исчезает — её роль играет N=0. |
| UNIT-режим | Авто-выбор юнита для освобождения (любой не отсканированный). |
| Переплата | Новый `OVERPAID` статус, `outstanding` может быть отрицательным. |
| Архитектура | Batched — все adjustments применяются одной транзакцией в `/complete`, локальный state до этого. |

---

## Architecture

### Data flow (bug fix)

```text
AddonSearch picker max
        ↑
       addCap (NEW field)
        ↑
  /sessions/:id/addon/search
        ↑
  addCap = totalQuantity − occupied_in_other_bookings − alreadyInThisBooking
                                                       ↑
                                              BookingItem.quantity где
                                              bookingId = current
```

Backend hard guard:

```text
addExtraItem(eqId, qty) → внутри транзакции:
  • recompute addCap (читаем equipment + BookingItem + occupied_other_bookings под SQLite serialize-семантикой)
  • if qty > addCap → throw HttpError(409, ADDON_OVER_STOCK, { addCap, requested, alreadyInBooking })
  • else upsert BookingItem.quantity += qty
```

Race protection: SQLite serialize-mode даёт нам сериализацию параллельных транзакций без явного locking. Если в практике гонки всплывут (что маловероятно для одного склада с одним кладовщиком) — добавим version-column на Booking. **YAGNI пока.**

### Data flow (new feature)

```text
IssueChecklist (frontend)
  • Map<bookingItemId, intendedQty> в локальном state. Default = bi.quantity.
  • Степпер [0, bi.quantity] на каждом ряду. UNIT-режим: min = scannedCount.
  • Per-row "Выдать N" / "Не выдаём" → ряд переходит в committed-state.
  • «Завершить выдачу» строит body для /complete:
       adjustments = committed.filter(actualQty !== originalQty)
                              .map({ bookingItemId, actualQuantity })

POST /api/warehouse/sessions/:id/complete
  body: { issuanceAdjustments?: Array<{ bookingItemId, actualQuantity }> }

completeSession (внутри одной транзакции):
  1. Snapshot: mainOriginalAfterDiscount = текущий MAIN.totalAfterDiscount (для UI «было/стало»)
  2. Валидация adjustments (принадлежность booking'у, actualQuantity ∈ [0, bi.quantity])
  3. UNIT-режим: проверка actualQuantity ≥ scannedUnitsForItem.length
                 иначе throw ADJUSTMENT_CONFLICTS_WITH_SCANS
  4. Для каждого adjustment:
     a. tx.bookingItem.update({ quantity: actualQty })
     b. UNIT: удалить (M − N) BookingItemUnit для не-отсканированных юнитов
     c. Audit: BOOKING_ITEM_QUANTITY_REDUCED { before, after, sessionId }
  5. recreateMainEstimate(bookingId)  ← новый helper
  6. Существующая ISSUE-логика (юниты → ISSUED, booking → ISSUED, audit)
  7. После транзакции (existing): recomputeAddonEstimate + recomputeBookingFinance
                                  → если paymentStatus впервые стал OVERPAID — audit BOOKING_OVERPAID_DETECTED
  8. Read fresh: mainAfterDiscount, addonAfterDiscount, finalAmount, paymentStatus →
                 кладём в ReconciliationSummary (с mainOriginalAfterDiscount из шага 1)
```

### Components and boundaries

**Backend services:**
- `services/checklistService.ts → addExtraItem` — добавляется hard cap (existing function, surgical change).
- `services/warehouseScan.ts → completeSession` — обогащается обработкой `issuanceAdjustments` (existing, surgical change).
- `services/mainEstimate.ts → recreateMainEstimate(bookingId)` — **NEW helper**, зеркало `recomputeAddonEstimate`. Удаляет старую MAIN-смету и создаёт новую из текущих BookingItem'ов, сохраняя discountPercent.
- `services/addonEstimate.ts → recomputeAddonEstimate` — меняет формулу: вместо агрегации AddonRecord использует `addonQty = max(0, BookingItem.quantity − MAIN.line.qty)` для каждого equipmentId.
- `services/finance.ts → recomputeBookingFinance` — добавляется ветка `outstanding.isNegative() ⇒ OVERPAID`.

**Backend routes:**
- `routes/warehouse.ts`:
  - `/sessions/:id/addon/search` — обогащается полем `addCap` в каждом результате.
  - `/sessions/:id/complete` — body расширяется опциональным `issuanceAdjustments` (Zod-validated).

**Backend schema:**
- `enum BookingPaymentStatus` — добавляется variant `OVERPAID`.
- `BookingItem.quantity` остаётся `Int @default(1)`, допустимо 0 (новая семантика «снято полностью, в брони с qty=0 для аудита»).

**Frontend components:**
- `components/warehouse/IssueChecklist.tsx` — степпер + commit-state per row, глобальная «Выдать всё разом» учитывает intendedQty.
- `components/warehouse/AddonSearch.tsx` — использует `r.addCap` вместо `r.availableQuantity` для picker `max`; disabled-row если `addCap=0`.
- `components/warehouse/IssueResultView.tsx` — блок «Согласовано (исходно/фактически)», OVERPAID статус и «К возврату».
- `components/warehouse/types.ts` — `AddonResult.addCap: number`, `SummaryResult.mainOriginalAfterDiscount: string`.

### State machine (IssueChecklist row)

```
[editable]  default N = M, степпер активен
    │
    │ click "Выдать N" (N >= 0)
    ▼
[committed (issued / not-issued)]  степпер скрыт, показана плашка
    │
    │ click "Изменить"
    ▼
[editable]  (откат на редактирование)

При "Завершить выдачу":
  • committed rows со значением ≠ M → попадают в issuanceAdjustments
  • committed rows со значением = M → нормальная выдача (без adjustment)
  • не committed rows → glob-commit с текущим N, далее как выше
```

---

## API contracts

### `POST /api/warehouse/sessions/:id/items`

Existing. **Изменение:** возвращает 409 `ADDON_OVER_STOCK` с `details: { addCap, requested, alreadyInBooking }` при превышении лимита.

### `GET /api/warehouse/sessions/:id/addon/search?q=...`

Existing. **Изменение:** каждый row теперь включает `addCap: number` (≥ 0). UI использует `addCap` как `picker.availableMax`.

```ts
interface AddonResult {
  equipmentId: string;
  name: string;
  category: string;
  availableQuantity: number;  // existing — для отображения "свободно ×K"
  addCap: number;             // NEW — верхняя граница для picker'а
  availability: "AVAILABLE" | "UNAVAILABLE";
  conflict: AddonConflict | null;
}
```

### `POST /api/warehouse/sessions/:id/complete`

Existing route, **расширение body**:

```ts
{
  issuanceAdjustments?: Array<{
    bookingItemId: string;
    actualQuantity: number;  // 0..bi.quantity
  }>
}
```

Existing response (`ReconciliationSummary`) обогащается полем:

```ts
mainOriginalAfterDiscount: string;  // snapshot до adjustments
```

Все существующие поля остаются (backwards compatible).

### Errors

- `409 ADDON_OVER_STOCK { addCap, requested, alreadyInBooking }` — добор превысил склад (existing endpoint).
- `409 ADJUSTMENT_CONFLICTS_WITH_SCANS { bookingItemId, scannedCount, requestedQuantity }` — adjustment противоречит уже отсканированным юнитам (новый, в `/complete`).

---

## Schema migration

Одна Prisma миграция:

```prisma
enum BookingPaymentStatus {
  UNPAID
  PARTIALLY_PAID
  PAID
  OVERPAID
}
```

`AddonRecord` остаётся. Существующие записи игнорируются новой `recomputeAddonEstimate`-формулой (она читает только `BookingItem.quantity − MAIN.line.qty`). Old `AddonRecord` rows становятся чисто аудитной таблицей.

---

## Audit trail

Новые `AuditEntry.action` codes:

| Action | Когда | `after`-payload |
|---|---|---|
| `BOOKING_ITEM_QUANTITY_REDUCED` | adjustment в `completeSession` уменьшает quantity | `{ before, after, sessionId, equipmentId, equipmentName }` |
| `BOOKING_ITEM_UNIT_RELEASED` | UNIT-режим: BookingItemUnit удалён при adjustment | `{ bookingItemUnitId, equipmentUnitId, sessionId }` |
| `BOOKING_OVERPAID_DETECTED` | paymentStatus впервые → OVERPAID | `{ paid, finalAmount, overpayment }` |

---

## Edge cases

### Снятие у добор-позиции

`recomputeAddonEstimate` переходит на формулу «ADDON = BookingItem.quantity − MAIN.line.qty». Поэтому снятие у добор-позиции работает автоматически: меняется `BookingItem.quantity`, ADDON-смета пересчитывается. `AddonRecord` становится только аудитной таблицей.

### UNIT-режим vs scanRecords

В `completeSession` для UNIT-adjustment:
- `scannedUnitsForItem = scanRecords ∩ reservedUnitsForItem` (equipmentUnitIds).
- `toRelease = reservedUnitsForItem \ scannedUnitsForItem`.
- Если `toRelease.length < (M − N)` → `409 ADJUSTMENT_CONFLICTS_WITH_SCANS`.

UI **предотвращает** этот случай: степпер `min = scannedCount` для UNIT-режима (фронт знает что отсканировано из preview).

### N=0

`BookingItem.quantity = 0` — строка остаётся в БД для аудита. MAIN-смета строится из `quantity > 0`, поэтому в смете её нет. UI на `/bookings/[id]` (вне scope этого PR) при желании может скрывать или показывать ghosted.

### Отмена сессии (`cancelSession`)

Adjustments — только в state UI до `/complete`. `cancelSession` ничего не применяет — ни adjustments, ни ISSUE-логики. ✓

### Race: параллельный добор

В `addExtraItem` `addCap` пересчитывается **внутри транзакции** (под SQLite serialize-режимом). Один из конкурентных upsert упадёт на 409. При необходимости добавим version-column на Booking (YAGNI).

---

## Testing strategy (TDD)

### Backend unit tests

| Файл | Что покрывает |
|---|---|
| `services/__tests__/checklistService.test.ts` (extend) | hard cap, 409 ADDON_OVER_STOCK с правильными details |
| `services/__tests__/mainEstimateRecompute.test.ts` (new) | `recreateMainEstimate`: discountPercent сохраняется, lineSum, idempotent, MAIN без BookingItem'ов → null |
| `services/__tests__/addonEstimate.test.ts` (extend) | новая формула «ADDON = BookingItem.qty − MAIN.line.qty», случай N=0 в MAIN-позиции |
| `services/__tests__/completeSessionAdjustments.test.ts` (new) | COUNT update, UNIT release с правильным выбором юнитов, full-zero, ADJUSTMENT_CONFLICTS_WITH_SCANS, OVERPAID transition |
| `services/__tests__/paymentStatus.test.ts` (extend) | OVERPAID когда paid > finalAmount |
| `routes/__tests__/addonSearchRoute.test.ts` (extend) | `addCap` корректно вычисляется и возвращается |

### Frontend unit tests

| Файл | Что покрывает |
|---|---|
| `components/warehouse/__tests__/IssueChecklist.test.tsx` (extend) | степпер default N=M, plus/minus disabled на границах, commit-state + «Изменить», глобальный «Выдать всё разом», отправка только различий |
| `components/warehouse/__tests__/AddonSearch.test.tsx` (extend) | `addCap=0` disabled, picker `max=addCap`, 409 inline error |
| `components/warehouse/__tests__/IssueResultView.test.tsx` (extend) | OVERPAID highlighting, «К возврату X», блок «Снято на выдаче» только если уменьшение |

### Integration test

`__tests__/issueAdjustmentFlow.test.ts` (new): confirm → +Добор → adjustments на MAIN и ADDON позициях → /complete → проверка `BookingItem.quantity`, MAIN/ADDON snapshots, `finalAmount`, `paymentStatus`.

---

## Backwards compatibility

- **Existing бронирования:** не затронуты. Никаких backfill'ов.
- **Existing `/complete` вызовы:** body опционален. Старые клиенты (если есть) шлют пустой → работает как раньше.
- **`AddonRecord` table:** остаётся, теряет роль source-of-truth (становится аудитной).
- **`OVERPAID` enum variant:** новая, существующие записи не ломаются.

---

## Out of scope (explicit)

- Снятие на странице брони `/bookings/[id]` вне ISSUE-сессии.
- Снятие во время RETURN-сессии.
- Реверс после `booking.status = ISSUED` (только в рамках активной сессии).
- Auto-возврат денег при OVERPAID (только показываем «К возврату», без Payment refund flow).
- Замена позиции A на B одним действием.
- Изменение цен/discount у MAIN при adjustment (discountPercent наследуется, цены остаются как при initial confirm).
- Уведомления клиенту об изменении сметы (отдельный канал).

---

## Rollout

Один PR, как обычно. Auto-deploy через `deploy-rsync.yml`. После merge — live smoke на проде:

1. CONFIRMED-бронь с 3 позициями.
2. Попробовать «+Добор» сверх `addCap` → 409.
3. Открыть IssueChecklist → видеть степперы.
4. На одной позиции снизить N=2 (из 3), commit.
5. На второй — N=0 (Не выдаём), commit.
6. Третья — N=M, commit.
7. «Завершить выдачу» → видеть «Согласовано (исходно)», «Снято на выдаче», «Согласовано (фактически)».
8. Если клиент оплатил полностью — `paymentStatus = OVERPAID`, видим «К возврату».
9. На `/bookings/[id]` — MAIN-смета обновилась, audit-log пишет `BOOKING_ITEM_QUANTITY_REDUCED`.

---

## Open questions

(нет — все ключевые развилки разрешены в брейнсторминге)
