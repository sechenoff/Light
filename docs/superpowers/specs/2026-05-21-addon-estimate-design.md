# Дизайн: доб-смета — отдельный документ для клиента

- Дата: 2026-05-21
- Статус: на ревью пользователя
- Контекст: фича для warehouse-flow «ISSUE → добор → доб-смета»
- Утверждено пользователем по секциям брейншторма

## 1. Цель

Сейчас, когда кладовщик делает добор во время выдачи (`addExtraItem`), позиция вливается в основную бронь через `BookingItem.upsert` с инкрементом quantity. Клиент не видит отдельного документа «вот что добрали поверх согласованного» — а для transparency хочется именно его, со своей суммой и приложением к основной смете.

Цель: каждый добор автоматически обновляет отдельный **доб-смета документ** (snapshot цен/наименований/qty), доступный клиенту в виде PDF/XLSX. Финансы брони пересчитываются с учётом добора (текущая дыра — добор не отражается в `Booking.finalAmount`).

## 2. Утверждённые решения брейншторма

| Решение | Значение |
|---|---|
| Аудитория доб-сметы | Клиент (transparency-документ) |
| Момент фиксации | Live: сразу после каждого `addExtraItem` ADDON Estimate пересоздаётся |
| Скидка на добор | Та же, что у основной сметы (та же `discountPercent`) |
| Формат | Оба: отдельный PDF доб-сметы + объединённый PDF main+addon |
| Storage | Approach A: `Estimate.kind` enum, multiple Estimates на бронь (1 MAIN + 1 ADDON max) |

## 3. Data model

### 3.1 Schema изменения (`apps/api/prisma/schema.prisma`)

```prisma
enum EstimateKind {
  MAIN   // снапшот на confirmBooking — основной согласованный пакет
  ADDON  // снапшот на каждый успешный addExtraItem — что добрали при выдаче
}

model Estimate {
  id              String       @id @default(cuid())
  bookingId       String                                     // ← убираем @unique
  kind            EstimateKind @default(MAIN)                // ← новое
  // ...остальные поля без изменений: shifts, subtotal, discountPercent,
  //    discountAmount, totalAfterDiscount, commentSnapshot, optionalNote,
  //    includeOptionalInExport, hoursSummaryText, createdAt, lines.

  @@unique([bookingId, kind])  // ← вместо одиночного unique
}

/// Запись о доборе во время ISSUE-сессии. Source of truth для
/// recomputeAddonEstimate. ADDON Estimate агрегирует AddonRecord'ы по
/// equipmentId, суммируя quantity.
///
/// Зачем отдельная таблица:
///   addExtraItem делает upsert {quantity: increment: N} → BookingItem
///   теряет след дельты («1 было изначально, 10 — добор»). AddonRecord
///   фиксирует именно ДОБАВЛЕННОЕ qty.
model AddonRecord {
  id                   String   @id @default(cuid())
  bookingId            String
  sessionId            String?  // ScanSession.id; null зарезервирован для будущих use-cases
  bookingItemId        String
  equipmentId          String?  // snapshot на момент добора
  quantity             Int      // именно добавленное qty (НЕ total в BookingItem)
  acknowledgedConflict Boolean  @default(false)
  createdBy            String
  createdAt            DateTime @default(now())

  booking     Booking      @relation(fields: [bookingId], references: [id], onDelete: Cascade)
  session     ScanSession? @relation(fields: [sessionId], references: [id])
  bookingItem BookingItem  @relation(fields: [bookingItemId], references: [id], onDelete: Cascade)
  equipment   Equipment?   @relation(fields: [equipmentId], references: [id])

  @@index([bookingId])
  @@index([sessionId])
}

model Booking {
  // ...все существующие поля...
  addonAmount Decimal @default(0)  // ← новое: денормализованная сумма ADDON Estimate
}
```

### 3.2 Жизненный цикл

```
DRAFT booking → BookingItem'ы добавлены вручную
    ↓
confirmBooking → создаётся Estimate { kind: MAIN, lines: snapshot текущих items }
    ↓ (бронь = CONFIRMED)
warehouse-scan ISSUE сессия открыта
    ↓
addExtraItem (Vmount +10):
  1. BookingItem upsert: quantity += 10
  2. AddonRecord create: { quantity: 10, sessionId, bookingItemId, ... }
  3. recomputeAddonEstimate(bookingId):
     - агрегирует AddonRecord'ы по equipmentId
     - delete старый ADDON Estimate (если был)
     - create новый ADDON Estimate с lines + та же скидка %, что у MAIN
  4. recomputeBookingFinance(bookingId):
     - finalAmount = MAIN.totalAfterDiscount + ADDON.totalAfterDiscount + transport
     - addonAmount = ADDON.totalAfterDiscount
     - amountOutstanding/paymentStatus пересчитаны
    ↓ (live PDF доб-сметы готов)
addExtraItem (ещё одно добавление):
  → повторение цикла: AddonRecord +1, ADDON Estimate переснимается
    ↓
completeSession(ISSUE) → ничего нового в финансах (ADDON Estimate уже актуален)
```

## 4. Backend изменения

### 4.1 `services/checklistService.ts → addExtraItem`

После существующего BookingItem upsert внутри транзакции — добавить запись AddonRecord:

```ts
const result = await prisma.$transaction(async (tx) => {
  // ...существующие проверки сессии/брони/конфликта...
  // ...существующий upsert BookingItem с {quantity: { increment: N }}...

  // НОВОЕ: дельта-запись для построения ADDON Estimate
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

  return { bookingItemId: item.id };
});

// НОВОЕ: пересоздать ADDON Estimate (вне tx, best-effort)
await recomputeAddonEstimate(bookingId).catch((err) => {
  console.error("[addExtraItem] recomputeAddonEstimate failed:", err);
});

// Существующий пересчёт финансов теперь учтёт addon
await recomputeBookingFinance(bookingId).catch(...);

return result;
```

### 4.2 Новый сервис: `services/addonEstimate.ts`

```ts
/**
 * Полная пересборка ADDON Estimate для брони из AddonRecord'ов.
 * Идемпотентна: delete старый ADDON (если есть) + create новый.
 *
 * Алгоритм:
 *  1. Загружает MAIN Estimate брони (для shifts + discountPercent).
 *     Без MAIN бронь не CONFIRMED → доборов быть не должно → no-op.
 *  2. Фильтрует AddonRecord'ы: только из сессий в статусе ACTIVE/COMPLETED
 *     (CANCELLED-сессии игнорируем — оператор отменил, оплачивать не надо).
 *  3. Сворачивает по equipmentId, суммирует quantity.
 *  4. Считает lineSum = unitPrice × totalQty × main.shifts.
 *  5. Применяет MAIN.discountPercent к subtotal.
 *  6. Delete-then-create по [bookingId, kind: ADDON].
 *     Если lines пустой — ADDON Estimate не создаётся вовсе (старый удаляется).
 */
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

  // Свернуть по equipmentId
  const byEq = new Map<string, { eq: Equipment; totalQty: number }>();
  for (const r of records) {
    if (!r.equipmentId || !r.equipment) continue;
    const cur = byEq.get(r.equipmentId);
    if (cur) cur.totalQty += r.quantity;
    else byEq.set(r.equipmentId, { eq: r.equipment, totalQty: r.quantity });
  }

  const shifts = main.shifts;
  const discountPct = main.discountPercent ?? new Decimal(0);

  const lines = [...byEq.values()].map(({ eq, totalQty }) => {
    const unitPrice = eq.rentalRatePerShift;
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

### 4.3 `services/finance.ts → recomputeBookingFinance`

Загружает обе Estimate'ы и складывает:

```ts
const main = await prisma.estimate.findFirst({ where: { bookingId, kind: "MAIN" } });
const addon = await prisma.estimate.findFirst({ where: { bookingId, kind: "ADDON" } });

const mainAfterDiscount  = main  ? new Decimal(main.totalAfterDiscount)  : new Decimal(0);
const addonAfterDiscount = addon ? new Decimal(addon.totalAfterDiscount) : new Decimal(0);

const equipmentAfterDiscount = mainAfterDiscount.add(addonAfterDiscount);
const transportSubtotal      = sumDec(booking.vehicles.map(v => v.subtotal));
const finalAmount            = equipmentAfterDiscount.add(transportSubtotal);

const amountPaid       = sumDec(booking.payments.map(p => p.amount));
const amountOutstanding = Decimal.max(finalAmount.sub(amountPaid), new Decimal(0));

const paymentStatus =
  amountOutstanding.isZero()      ? "FULLY_PAID"
  : amountPaid.isZero()           ? "NOT_PAID"
                                  : "PARTIALLY_PAID";

await prisma.booking.update({
  where: { id: bookingId },
  data: {
    /* …existing fields… */
    finalAmount: finalAmount.toString(),
    addonAmount: addonAfterDiscount.toString(),  // ← новое
    amountPaid: amountPaid.toString(),
    amountOutstanding: amountOutstanding.toString(),
    paymentStatus,
    isFullyPaid: amountOutstanding.isZero(),
  },
});
```

### 4.6 `services/warehouseScan.ts → completeSession` — расширение `ReconciliationSummary`

Чтобы фронту не нужен был отдельный round-trip для финансовой разбивки на result-screen, расширяем тип ответа на `POST /complete`:

```ts
export interface ReconciliationSummary {
  // ...все существующие поля (scanned, expected, missing, substituted,
  //    reservedButUnavailable, createdRepairIds, …)

  // НОВЫЕ финансовые поля (только для ISSUE-операции, всегда заполнены):
  mainAfterDiscount: string;    // serialized Decimal — сумма основной сметы после скидки
  addonAfterDiscount: string;   // сумма доб-сметы после скидки (0 если addon отсутствует)
  finalAmount: string;          // итого к оплате (= main + addon + transport)
}
```

В `completeSession` после `recomputeBookingFinance` загружается обновлённая бронь и финансовые поля копируются в summary. Для RETURN-операции заполняются нулями (или не показываются на FE-стороне).

### 4.4 Новый файл: `routes/addonEstimates.ts`

```ts
const router = express.Router();

/** GET /api/addon-estimates/:bookingId — JSON метаданных доб-сметы (или null). */
router.get("/:bookingId", async (req, res, next) => {
  try {
    const addon = await prisma.estimate.findFirst({
      where: { bookingId: req.params.bookingId, kind: "ADDON" },
      include: { booking: { include: { client: true } }, lines: true },
    });
    if (!addon) {
      res.json({ addon: null });
      return;
    }
    res.json({ addon: serializeEstimateForJson(addon) });
  } catch (err) { next(err); }
});

/** GET /api/addon-estimates/:bookingId/export/pdf */
router.get("/:bookingId/export/pdf", async (req, res, next) => {
  try {
    const addon = await prisma.estimate.findFirst({
      where: { bookingId: req.params.bookingId, kind: "ADDON" },
      include: { booking: { include: { client: true } }, lines: true },
    });
    if (!addon) throw new HttpError(404, "Доб-сметы нет — доборы не делали", "ADDON_ESTIMATE_NOT_FOUND");
    const doc = buildSmetaFromPersistedEstimate({ booking: addon.booking, estimate: addon });
    const human = buildBookingHumanName({ /* …same as main… */ });
    writeSmetaPdf(res, doc, `${safeFileName(human)}-добор.pdf`);
  } catch (err) { next(err); }
});

/** GET /api/addon-estimates/:bookingId/export/xlsx — аналогично */

export { router as addonEstimatesRouter };
```

И в `routes/bookings.ts`:

```ts
/** GET /api/bookings/:id/full-estimate/export/pdf — main + addon (если есть). */
router.get("/:id/full-estimate/export/pdf", async (req, res, next) => {
  // загрузить main + addon
  // doc = buildFullSmeta({ booking, main, addon })
  // writeSmetaPdf(res, doc, `${human}-смета.pdf`)
});
/** аналогично для xlsx */
```

### 4.5 `services/smetaExport.ts`

```ts
/** Существующая функция — генерализуется на любой kind. */
export function buildSmetaFromPersistedEstimate({ booking, estimate }) {
  const title = estimate.kind === "ADDON" ? "Смета-добор" : "Смета";
  const subtitle = estimate.kind === "ADDON"
    ? `Доборы при выдаче · ${humanDateRange(booking)}`
    : humanDateRange(booking);
  // ...rest unchanged...
}

/**
 * Новая функция — main + (опционально) addon в одном PDF.
 * Если addon === null → документ идентичен текущему main PDF.
 */
export function buildFullSmeta({ booking, main, addon }: {
  booking: BookingForExport;
  main: EstimateWithLines;
  addon: EstimateWithLines | null;
}): SmetaDoc {
  // Section 1: main lines + main totals
  // If addon: addPage() + addon lines + addon totals
  // Footer: "Согласовано / Доб-смета / ИТОГО к оплате"
}
```

## 5. Frontend изменения

### 5.1 `AddonSearch.tsx`

После успешного `addItem`:
- Текущая success-line «✓ Vmount ×10 добавлен в выдачу» расширяется ссылкой:
  ```
  ✓ Vmount ×10 добавлен в выдачу
  Доб-смета обновлена · Открыть PDF →
  ```
- Ссылка: `/api/addon-estimates/{bookingId}/export/pdf` в новой вкладке.
- Новый prop: `bookingId: string` (берётся из `state.bookingId` в IssueChecklist).

### 5.2 `IssueChecklist.tsx` — summary-фаза

Под существующими стат-строками добавляется блок «Доб-смета» (только если ADDON Estimate существует):

```
─── Доб-смета ────────────────────
Vmount               ×10    10 000 ₽
Адаптер Vmount Nova  ×1      1 200 ₽
                  Итого:  11 200 ₽
                  Скидка 50% (как в основной)
                  К доплате: 5 600 ₽
[ Открыть PDF доб-сметы → ]
```

Источник данных: новый useEffect загружает `GET /api/addon-estimates/:bookingId` при входе в summary phase.

### 5.3 `IssueResultView.tsx`

Под существующими счётчиками (Выдано / Доборы / Замены) — финансовый блок (только если есть addon):

```
─── Финансы ──────────────────
Согласовано:        53 000 ₽
Доб-смета:        + 5 600 ₽
К оплате:           58 600 ₽

[ Скачать смету (общая) PDF ]
[ Скачать доб-смета PDF ]
```

Источник данных — расширенный `CompleteResult` от `POST /complete` (см. §4.6). Тип:

```ts
interface CompleteResult extends SummaryResult {
  // ...существующие поля...
  mainAfterDiscount: string;    // serialized Decimal — основная смета после скидки
  addonAfterDiscount: string;   // доб-смета после скидки (0 если addon отсутствует)
  finalAmount: string;          // итого к оплате (= main + addon + transport)
}
```

Блок «Финансы» рендерится только если `Number(addonAfterDiscount) > 0`.

### 5.4 `api.ts` + `types.ts`

```ts
// api.ts
export function getAddonEstimate(bookingId: string): Promise<{ addon: AddonEstimateView | null }> {
  return request(`/api/addon-estimates/${bookingId}`);
}

// types.ts — мирророр серверного AddonRecord-агрегированного view
export interface AddonEstimateLine {
  equipmentId: string | null;
  name: string;          // nameSnapshot
  quantity: number;
  unitPrice: string;
  lineSum: string;
}

export interface AddonEstimateView {
  bookingId: string;
  shifts: number;
  subtotal: string;
  discountPercent: string | null;
  discountAmount: string;
  totalAfterDiscount: string;
  lines: AddonEstimateLine[];
}
```

### 5.5 Booking detail (вне warehouse/scan)

На странице брони (если бронь = ISSUED + есть ADDON Estimate) — добавить секцию «Доб-смета»:
- Таблица lines
- Сумма
- Ссылки: «PDF доб-сметы», «PDF общая смета», XLSX-аналоги

Этот шаг точечно дополняет UX, но критичен для post-выдача обзора финансов.

## 6. Граничные случаи

| Сценарий | Поведение |
|---|---|
| Бронь FULLY_PAID + добор | finalAmount растёт, outstanding > 0, paymentStatus → PARTIALLY_PAID. Бронь снова в debt-tracker (правильно — клиент должен доплатить). |
| Бронь CANCELLED после добора | CANCELLED — поглощающее. AddonRecord'ы остаются как audit, но recompute не вызывается. |
| Сессия отменена → новая сессия | AddonRecord'ы CANCELLED-сессии фильтруются из `recomputeAddonEstimate`. Если оператор повторно добрал в новой сессии — она ACTIVE/COMPLETED, считается. |
| Добор → ADDON Estimate создан → ALL доборы потом возвращены/исключены | `recomputeAddonEstimate` с пустым набором lines удаляет ADDON Estimate (а не оставляет пустой). |
| `recomputeAddonEstimate` упал (e.g. db error) | Best-effort `.catch(console.error)`. Финансовый recompute всё равно проходит со старым ADDON. Следующий успешный recompute восстановит. |
| Equipment удалили после добора | AddonRecord имеет `equipmentId String?` (nullable on delete). При следующем `recomputeAddonEstimate` такие записи пропускаются (нет equipment → нет цены). |
| Бронь без MAIN Estimate (DRAFT, не CONFIRMED) | `recomputeAddonEstimate` no-op. Невозможно делать ISSUE-сессию для не-CONFIRMED брони, так что это защитный гард. |

## 7. Тесты

### Новые backend-тесты

| Файл | Покрытие |
|---|---|
| `__tests__/addonEstimate.test.ts` | unit для `recomputeAddonEstimate`: пустой набор → удаляет; 3 records по 2 equipment → 2 lines, корректные totals; та же скидка % что у MAIN; идемпотентность; нет MAIN → no-op. |
| `__tests__/addonFinanceFlow.test.ts` | integration: confirm → main → addExtraItem ×3 → addon estimate exists → booking.finalAmount = main+addon → paymentStatus пересчитан → FULLY_PAID→PARTIALLY_PAID transition после добора. |
| `__tests__/addonEstimateRoutes.test.ts` | supertest: `GET /api/addon-estimates/:bookingId` → JSON или null; `/export/pdf` → 200 + application/pdf; `/export/xlsx` → 200 + correct mime; нет ADDON → 404 на PDF, `null` на JSON. |
| `__tests__/fullEstimateRoutes.test.ts` | `GET /api/bookings/:id/full-estimate/export/pdf` для брони без добора — content идентичен main; для брони с добором — содержит обе секции (поиск по string contents). |

### Изменения существующих

| Файл | Изменение |
|---|---|
| `__tests__/customBookingItem.test.ts` (или `checklistService.test.ts`) | После `addExtraItem` — `AddonRecord` с правильным quantity/sessionId/createdBy создан. |
| `__tests__/api.test.ts` или finance-related | `booking.finalAmount` теперь учитывает addonAmount. |

### Новые frontend-тесты

| Файл | Покрытие |
|---|---|
| `AddonSearch.test.tsx` | Дополнительно: success-line содержит «Открыть PDF →» со ссылкой `/api/addon-estimates/{bookingId}/export/pdf`. |
| `IssueSummary.test.tsx` | Если ADDON Estimate существует — рендерится блок «Доб-смета» с lines + сумма + PDF-ссылка; пустой ADDON → блок не появляется. |
| `IssueResultView.test.tsx` | Если есть addon → блок «Финансы» с «Согласовано / Доб-смета / К оплате»; без addon — блок не рендерится. |
| `IssueChecklist.test.tsx` | `AddonSearch` получает `bookingId` prop. |

## 8. Миграция

Prisma `db push --accept-data-loss` справится со всем. SQL-эквивалент:

```sql
-- 1. Drop old unique
DROP INDEX IF EXISTS "Estimate_bookingId_key";
-- 2. Add kind column with safe default
ALTER TABLE "Estimate" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'MAIN';
-- 3. Compound unique
CREATE UNIQUE INDEX "Estimate_bookingId_kind_key" ON "Estimate"("bookingId", "kind");

-- 4. AddonRecord
CREATE TABLE "AddonRecord" (
  "id" TEXT PRIMARY KEY,
  "bookingId" TEXT NOT NULL,
  "sessionId" TEXT,
  "bookingItemId" TEXT NOT NULL,
  "equipmentId" TEXT,
  "quantity" INTEGER NOT NULL,
  "acknowledgedConflict" BOOLEAN NOT NULL DEFAULT false,
  "createdBy" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE,
  FOREIGN KEY ("sessionId") REFERENCES "ScanSession"("id") ON DELETE SET NULL,
  FOREIGN KEY ("bookingItemId") REFERENCES "BookingItem"("id") ON DELETE CASCADE,
  FOREIGN KEY ("equipmentId") REFERENCES "Equipment"("id") ON DELETE SET NULL
);
CREATE INDEX "AddonRecord_bookingId_idx" ON "AddonRecord"("bookingId");
CREATE INDEX "AddonRecord_sessionId_idx" ON "AddonRecord"("sessionId");

-- 5. Booking.addonAmount
ALTER TABLE "Booking" ADD COLUMN "addonAmount" DECIMAL NOT NULL DEFAULT 0;
```

### Backfill для существующих броней

- Все текущие Estimate'ы автоматически получают `kind = 'MAIN'` через DEFAULT. ✓
- Старые броони с уже-добавленными доборами (например, Ювелирка с +10 Vmount от вчерашнего теста) НЕ имеют AddonRecord'ов. Их ADDON Estimate будет пустой → finance recompute их не меняет.
- **Это интенсiонально**: легаси-доборы остаются «невидимыми» в новой модели. Если нужно вручную исправить конкретную бронь — отдельный seed-скрипт по требованию (вне scope этой задачи).

## 9. Out-of-scope (явно НЕ строим)

- Отдельная оплата под доб-смету. Payment остаётся одна на бронь.
- Backfill всех исторических доборов в AddonRecord. Per-case при необходимости.
- Editing/cancelling доборов в UI кладовщика. AddonRecord'ы только добавляются.
- Доборы при RETURN-операции. Скоп только ISSUE.
- Auto-отправка PDF клиенту (email/Telegram). Оператор скачивает и отправляет вручную.
- Multi-tenant / tax rates / отдельная скидка для доб-сметы.

## 10. Acceptance criteria

- ✅ Schema мигрирована: `Estimate.kind`, `Estimate.@@unique([bookingId, kind])`, `AddonRecord` table, `Booking.addonAmount`.
- ✅ `addExtraItem` создаёт `AddonRecord` и триггерит `recomputeAddonEstimate`.
- ✅ ADDON Estimate автоматически создаётся/обновляется/удаляется по наличию AddonRecord'ов.
- ✅ `recomputeBookingFinance` учитывает addonAmount в finalAmount + outstanding + paymentStatus.
- ✅ Endpoint `GET /api/addon-estimates/:bookingId` возвращает JSON или `null`.
- ✅ Endpoint `/api/addon-estimates/:bookingId/export/pdf|xlsx` отдаёт корректный документ.
- ✅ Endpoint `/api/bookings/:id/full-estimate/export/pdf|xlsx` отдаёт объединённый документ (или main-only, если addon отсутствует).
- ✅ В `AddonSearch` после успешного добора — ссылка «Открыть PDF доб-сметы →».
- ✅ В `IssueChecklist` summary-фаза показывает блок «Доб-смета» с lines + сумма + PDF-ссылка (если addon существует).
- ✅ В `IssueResultView` — блок «Финансы» с разбивкой Согласовано / Доб-смета / К оплате (если addon существует).
- ✅ Все тесты зелёные.
- ✅ Прод: Ювелирка → добор ×3 Vmount → видна доб-смета 3 позиции на 1 800 ₽ → PDF корректный → `Booking.addonAmount = 1 800`, outstanding обновлён.
