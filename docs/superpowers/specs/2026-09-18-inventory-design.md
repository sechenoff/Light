# Инвентаризация склада — спецификация

Дата: 2026-09-18. Статус: **утверждено владельцем** (финальный мокап
`docs/mockups/problem-items-v2/final-inventory.html`, README там же).

## 0. Зачем

На приёмке пропажи никто не видит: из 435 возвращённых броней с пересчётом в киоске
приняты 4. Узнать, что пропало, можно только пересчётом полки. Инвентаризация — сессия
полного пересчёта: считаем → видим расхождения → решаем по каждому → записываем одной
операцией → получаем акт. «Как пропало» — брони с позицией в окне между пересчётами и то,
как их принимали.

Решения владельца (2026-09-18):
1. «Ошибку учёта» (поправку количества) может делать **и кладовщик**, с обязательной причиной.
2. Завершать инвентаризацию **можно с непосчитанными** позициями — они остаются «не сверены».
3. «Стоимость замены» / компенсация клиенту — **не в этом релизе**.

Вне релиза также: объявление в поиск, подсказки «пора пересчитать», штучный пересчёт.

## 1. Словарь (UI — только эти слова)

| Код | Подпись в UI |
|---|---|
| StockCount | Инвентаризация № N |
| OPEN / CLOSED / CANCELLED | идёт / завершена / отменена |
| expected | на полке должно быть |
| counted | посчитано |
| diff < 0 / > 0 / = 0 | недостача / излишек / сошлось |
| LOST | Пропало → потеряшки |
| ADJUST | Ошибка учёта |
| FOUND | Нашлось |
| reset | Пересчитать |
| NOT_ON_SHELF | Не нашли на складе |
| source RETURN / STOCK_COUNT / MANUAL | приёмка / инвентаризация № N / вручную |

Никаких штрихкодов в UI и в ответах API.

## 2. Модель данных (Prisma, SQLite)

Все изменения **аддитивные** — деплой делает `prisma db push --accept-data-loss` после бэкапа.
Ничего не переименовываем и не удаляем.

```prisma
enum StockCountStatus   { OPEN CLOSED CANCELLED }
enum StockCountDecision { LOST ADJUST FOUND }
enum ProblemSource      { RETURN STOCK_COUNT MANUAL }
enum ProblemReason      { LEFT_ON_SITE LOST DESTROYED STOLEN NOT_ON_SHELF }  // + NOT_ON_SHELF

/// Инвентаризация — сессия пересчёта склада.
model StockCount {
  id            String           @id @default(cuid())
  number        Int              @unique          // № по порядку, max+1
  status        StockCountStatus @default(OPEN)
  categories    String?                           // JSON string[] охвата; null — весь склад
  createdById   String                            // AdminUser.id (без FK, как Repair.createdBy)
  createdByName String
  startedAt     DateTime         @default(now())
  closedAt      DateTime?
  closedById    String?
  closedByName  String?
  cancelledAt   DateTime?
  lines         StockCountLine[]
  problemItems  ProblemItem[]
  @@index([status])
}

/// Строка инвентаризации — одна позиция каталога (только учёт количеством).
model StockCountLine {
  id               String              @id @default(cuid())
  stockCountId     String
  stockCount       StockCount          @relation(fields: [stockCountId], references: [id], onDelete: Cascade)
  equipmentId      String?
  equipment        Equipment?          @relation(fields: [equipmentId], references: [id], onDelete: SetNull)
  nameSnapshot     String
  categorySnapshot String
  rateSnapshot     Decimal             // rentalRatePerShift на старте — для «₽/смена»
  position         Int                 // порядок: категория (порядок каталога), затем позиция
  // Снапшот ожидания: при ПЕРВОМ счёте строки / «Пересчитать» / «Обновить ожидание» (null — не посчитано)
  totalAtCount     Int?
  issuedAtCount    Int?
  calendarAtCount  Int?
  repairAtCount    Int?
  lostAtCount      Int?
  expectedQty      Int?
  countedQty       Int?
  countedBy        String?             // имя: WarehousePin.name или AdminUser.username
  countedAt        DateTime?
  decision         StockCountDecision?
  decisionNote     String?
  decidedBy        String?
  decidedById      String?             // AdminUser.id решившего (без FK) — для журнала
  decidedAt        DateTime?
  sourceBookingId  String?             // только для LOST: вероятная бронь
  decisionBasis    String?             // JSON живой разбивки, подтверждённой «оставить как посчитано»
  @@unique([stockCountId, equipmentId])
  @@index([stockCountId, categorySnapshot])
}
```

Изменения существующих моделей:
- `Equipment`: `lastCountedAt DateTime?` (когда позиция последний раз сверена),
  `stockCountLines StockCountLine[]`, `problemItems ProblemItem[] @relation("ProblemItemEquipment")`.
- `ProblemItem`: `equipmentId String?` + relation `equipment Equipment? @relation("ProblemItemEquipment", …, onDelete: SetNull)`,
  `source ProblemSource @default(RETURN)`, `stockCountId String?` + relation `stockCount StockCount? (onDelete: SetNull)`,
  `@@index([equipmentId])`, `@@index([source])`.
- `AuditEntityType` (+ `"StockCount"`, `"Equipment"`).

Позиции со штучным учётом (`stockTrackingMode = UNIT`, на проде 1 из 295) **в инвентаризацию не
входят**: их пересчёт — по единицам в карточке оборудования. UI честно пишет «1 позиция со штучным
учётом сверяется в карточке единиц».

## 3. «На полке должно быть»

Одна формула на всю систему — та же, что у календаря и проверки доступности.

```
expected = max(0, total − issued − calendar − repair − lost)
```

| Слагаемое | Источник |
|---|---|
| total | `Equipment.totalQuantity` |
| issued | Σ `BookingItem.quantity` броней `status = ISSUED`, `deletedAt = null` (независимо от дат) |
| calendar | Σ `BookingItem.quantity` броней `status = CONFIRMED`, `deletedAt = null`, `startDate ≤ at ≤ endDate` — по календарю на съёмке, но не отмечены выданными |
| repair | `getRepairCountByEquipmentMap` (безъюнитные активные ремонты) |
| lost | `getLostCountByEquipmentMap` (все не-`FOUND` безъюнитные потеряшки) |

**Доработка `getLostCountByEquipmentMap`** (обязательна, иначе ручные потеряшки и потеряшки из
инвентаризации не уменьшат доступность): учитывать строки с `equipmentUnitId = null`,
`status != FOUND` и `(equipmentId IN ids OR bookingItem.equipmentId IN ids)`; позиция строки —
`equipmentId ?? bookingItem.equipmentId`. Одна строка считается один раз. Эта функция питает
календарь, дашборд, чек-листы, добор, мастерскую — все они автоматически начнут видеть новые
потеряшки.

Ожидание **снапшотится при первом счёте строки** (или после «Пересчитать»): выдачи и возвраты во
время инвентаризации итог не сбивают. Для непосчитанных строк ожидание показывается живым (на
момент запроса). У посчитанной строки идущей инвентаризации рядом со снапшотом отдаётся и живая
разбивка (`live`, `booksChangedSinceCount`): снапшот остаётся по умолчанию, но то, что учёт
изменился после счёта, видно, и «Пропало» / «Ошибка учёта» на такой строке — явный выбор (§4.3).

Списание безъюнитного ремонта COUNT-позиции (`writeOffRepair`) уменьшает `totalQuantity` на его
количество (аудит `STOCK_ADJUST`, «Списано в мастерской»): иначе списанное возвращалось бы и в
доступность, и в «на полке должно быть». Починенное за 7 суток (`CLOSED`) в формулу не входит, но
отдаётся строке пояснением (`readyForPickupQty`: «N починено за неделю — может лежать на верстаке»).

## 4. Жизненный цикл

1. **Старт** (SA + WH): `POST /api/stock-counts` `{ categories?: string[] }`. Одна открытая
   инвентаризация на систему (409 `STOCK_COUNT_ALREADY_OPEN`). Строки создаются сразу для всех
   COUNT-позиций охвата, упорядоченные как каталог (`getMergedCategoryOrder` +
   `compareEquipmentTransportLast`). Пустой охват → 400 `EMPTY_SCOPE`. Аудит `STOCK_COUNT_START`.
2. **Счёт** (киоск по PIN, десктоп SA + WH): `count {qty}` — целое 0…100000. Снапшот снимается
   при первом счёте строки (или после «Пересчитать») вместе с `countedQty/By/At`; то же число ещё
   раз ничего не меняет (ни снапшот, ни решение, ни `countedAt`). Правка посчитанной строки
   сравнивается с тем же снапшотом, а если «должно быть» с тех пор изменилось — 409
   `EXPECTATION_CHANGED` `{ snapshotExpected, liveExpected }`, нужно «Пересчитать». Любое изменение
   счёта **сбрасывает решение** строки. «Пересчитать» (`reset`) обнуляет счёт, снапшот и решение.
   «Обновить ожидание» (`refresh-expected`, только десктоп) снимает снапшот заново по живому учёту,
   оставляя счёт и `countedAt` (полку посчитали тогда же); изменилось «должно быть» — решение
   сбрасывается; непосчитанная строка → 409 `LINE_NOT_COUNTED`. Это верно, когда учёт лишь догнал
   полку (возврат отметили после разгрузки), поэтому только явным действием. Счёт в
   закрытой/отменённой → 409 `STOCK_COUNT_NOT_OPEN`. Аудит на каждый счёт не пишется
   (высокочастотно, как галочки чек-листа).
3. **Решения** (SA + WH) — только для посчитанных строк с `diff ≠ 0` (иначе 409
   `LINE_NOT_DISCREPANT`):
   - Любое решение, кроме снятия, несёт то, что руководитель видел: `seenCountedQty` и
     `seenExpectedQty` (снапшот). Не совпали со строкой (её пересчитали в киоске или другой
     вкладке) — 409 `LINE_CHANGED` `{ countedQty, expectedQty, diff }`; решение не записывается.
     Сравниваются счёт и ожидание, как в правиле сброса решения при счёте.
   - `LOST` — только недостача (`diff < 0`). Необязательные `note` и `sourceBookingId`
     (бронь должна существовать, 404 иначе).
   - `ADJUST` — любой знак. `note` обязательна, ≥ 3 символов после trim (400 `REASON_REQUIRED`).
     Пишется аудит `STOCK_COUNT_DECISION` (`userId` — решивший, `entityType: "StockCount"`).
   - `LOST` и `ADJUST` на строке, чей учёт изменился после счёта (живая разбивка ≠ снапшоту хоть
     в одном слагаемом total/issued/calendar/repair/lost), — только с `acknowledgeBooksChanged:
     true` («оставить как посчитано»), иначе 409 `LINE_BOOKS_CHANGED` `{ snapshot, live }`.
     Подтверждённая живая разбивка сохраняется в `decisionBasis`.
   - `FOUND` — только излишек (`diff > 0`) и только если по позиции есть открытые (`EXPECTED` /
     `SEARCHING`) безъюнитные потеряшки, заведённые не позже счёта строки (`createdAt ≤
     countedAt`); заведённые позже остаются открытыми (400 `DECISION_NOT_APPLICABLE`).
   - `decision: null` — снять решение.
   - Решение, чей знак больше не подходит расхождению, считается отсутствующим (фильтр
     `undecided`, `totals.undecided`, план и 409 `UNDECIDED_LINES` согласованы). Так же у идущей
     инвентаризации — `FOUND`, которому больше нечего закрывать (потеряшки разобрали другим путём).

   **Позицию перевели на штучный учёт посреди инвентаризации** (SA может сделать это через
   `PATCH /api/equipment/:id`): счёт и новое решение по строке → 409 `LINE_NOT_COUNT_MODE`
   («её сверяют по единицам в карточке оборудования»); снять решение и «Пересчитать» можно.
   Такая строка не предлагает решений (`allowedDecisions: []`), не ждёт решения и на завершении
   эффектов не даёт (ни поправки, ни потеряшки, ни `lastCountedAt`): `totalQuantity` штучной
   позиции выводится из единиц. В `unitModeExcluded` она второй раз не считается.
4. **Завершение** (SA + WH): 409 `UNDECIDED_LINES` `{ details: { count } }`, если есть посчитанные
   строки с расхождением без решения. Непосчитанные не мешают. 409 `LINE_BOOKS_CHANGED`
   `{ details: { count, lineIds } }`, если у строки с `LOST` / `ADJUST` учёт изменился после счёта
   и живая разбивка не равна подтверждённой (`decisionBasis`); ничего не применяется. Всё — **в
   одной `$transaction`**:
   - `diff = 0` → `Equipment.lastCountedAt = countedAt` строки.
   - `LOST` → `ProblemItem { equipmentId, quantity: −diff, reason: NOT_ON_SHELF, status: SEARCHING,
     source: STOCK_COUNT, stockCountId, sourceBookingId, comment: note ?? "Не нашли при
     инвентаризации № N", createdBy: username }`.
   - `ADJUST` → `totalQuantity = max(0, текущий totalQuantity + diff)` (дельта к ТЕКУЩЕМУ значению,
     не к снапшоту); аудит `STOCK_ADJUST` (`entityType: "Equipment"`, before/after + причина + № +
     кто решил: `decidedBy` / `decidedById` / `decidedAt` в `after`; `userId` — завершивший).
   - `FOUND` → закрыть открытые безъюнитные потеряшки позиции, заведённые не позже счёта строки,
     от старых к новым на `min(diff, lostAtCount)` штук:
     строка целиком помещается → `status FOUND`, `resolvedAt/By`, `resolutionNote "Найдено при
     инвентаризации № N"`; не помещается → у открытой уменьшить `quantity`, создать копию
     `status FOUND` на найденное количество. Если `diff` больше открытых потеряшек — закрываем все,
     остаток «лишнее без объяснения» попадает в акт, учёт не меняется.
   - Все посчитанные строки со ссылкой на позицию → `lastCountedAt = countedAt` строки (когда полку
     посчитали, а не когда нажали «Завершить»).
   - `status CLOSED`, `closedAt/By`. Аудит `STOCK_COUNT_CLOSE` со сводкой.
   - Строки, чья позиция удалена из каталога (`equipmentId = null`), эффектов не дают; посчитанные
     строки позиций, ушедших на штучный учёт, — тоже (счётчик `unitModeSkipped`).
   - Одна открытая инвентаризация и однократное применение решений держатся проверками ВНУТРИ
     транзакции (частичный уникальный индекс на `status = OPEN` в Prisma для SQLite не объявить);
     двойной клик «Начать» / «Завершить» даёт 409, а не вторую инвентаризацию или двойные эффекты.
5. **Отмена** (SA + WH): `POST /:id/cancel` → `CANCELLED`, ничего не применяется, аудит
   `STOCK_COUNT_CANCEL`.

## 5. «Как пропало»

`getEquipmentTrail(equipmentId, { since?, at? })`:
- момент `at`: для посчитанной строки инвентаризации — её `countedAt` (тогда «ещё у клиента»
  совпадает со снапшотом), иначе сейчас (у идущей) или момент закрытия/отмены;
- окно: `since ?? equipment.lastCountedAt ?? at − 60 дней`; для строки инвентаризации `since` —
  `countedAt` строки этой позиции в прошлой ЗАВЕРШЁННОЙ инвентаризации; `windowIsDefault = true`,
  если прошлой сверки не было;
- брони с этой позицией: `BookingItem.equipmentId = X`, `deletedAt = null`, статус
  `ISSUED | RETURNED | CONFIRMED`, `startDate ≤ at`, и одно из: `endDate ≥ окно`, ISSUED
  независимо от дат, или фактически принятые в окне (ScanSession RETURN `completedAt` / аудит
  `BOOKING_RETURNED` ≥ окно — просроченная бронь, которую вернули после прошлой сверки). RETURNED
  без единого следа возврата (путь бот-ключа, легаси-импорт) и `endDate < окно` датировать нечем —
  они в след не попадают; по `startDate desc`, не больше 50;
- как принимали (`returnMode`):
  - `KIOSK` — есть завершённая `ScanSession` RETURN; `returnedBy = workerName`; замечания —
    потеряшки/ремонты по этой позиции этой брони;
  - `AUTO` — аудит `BOOKING_RETURNED` от пользователя, чьё имя начинается с `system` или `_system`;
  - `MANUAL` — любой другой аудит `BOOKING_RETURNED` или его отсутствие у RETURNED, или CONFIRMED,
    чей срок уже прошёл (ни выдача, ни возврат не отмечены; по формуле §3 уже на полке),
    `returnedBy = null`, статус в строке остаётся CONFIRMED;
  - `OUT` — бронь была у клиента на `at`: ISSUED, CONFIRMED с `startDate ≤ at ≤ endDate` (ровно те,
    что формула §3 вычитает из полки) или RETURNED, чей фактический возврат (max сессии киоска /
    аудита) позже `at` (UI: «вернули после счёта»);
- `verifiedReturns` — число `KIOSK`; кандидаты — брони в окне, принятые НЕ через киоск и не `OUT`;
  `suggestedBookingId` — если кандидат ровно один и в окне нет событий мастерской;
- `repairEvents` — безъюнитные ремонты позиции: `writtenOffQty` (WROTE_OFF, `closedAt` в окне до
  `at`) и `readyForPickupQty` (CLOSED за 7 суток до `at`). Любое из них объясняет недостачу не хуже
  брони — подсказки нет, вердикт говорит про мастерскую;
- `openProblems` — открытые потеряшки позиции;
- `onShelf` — разбивка формулы §3 на сейчас.

Приёмка в киоске подтверждает только свою бронь, а не склад, поэтому окно сужает только
инвентаризация.

«Итог» не строит полный след на каждую недостачу: подсказки всех недостач идущей инвентаризации
отдаёт `GET /:id/trail-suggestions` одним набором запросов — тем же загрузчиком и той же
классификацией, что полный след (подсказка видна, только если она среди первых 50 броней).
Полный след строка грузит по «Как пропало ▾». Выборка аудита возвратов сортируется сначала по
`entityId` — иначе SQLite берёт индекс `(entityType, createdAt)` и проходит всю историю аудита.

## 6. API

Десктоп — `router.use("/api/stock-counts", rolesGuard(["SUPER_ADMIN","WAREHOUSE"]), …)`
(COLLECTOR/TECHNICIAN → 403, без сессии → 401). Статичные пути объявлены ДО `/:id`.

| Метод, путь | Тело / query | Ответ |
|---|---|---|
| GET `/api/stock-counts` | — | `{ items: StockCountSummary[] }` новые сверху |
| GET `/api/stock-counts/active` | — | `{ stockCount: StockCountDetail \| null }` |
| GET `/api/stock-counts/scope` | — | `StockCountScope` (категории, `counts` — позиций количеством, `unitCounts` — штучных) |
| POST `/api/stock-counts` | `{ categories?: string[] }` | 201 `{ stockCount: StockCountDetail }` |
| GET `/api/stock-counts/:id` | — | `{ stockCount: StockCountDetail }` |
| GET `/api/stock-counts/:id/lines` | `category?`, `filter? = all\|uncounted\|discrepancy\|undecided` | `{ lines: StockCountLineView[] }` |
| POST `/api/stock-counts/:id/lines/:lineId/count` | `{ qty }` | `{ line }` |
| POST `/api/stock-counts/:id/lines/:lineId/reset` | — | `{ line }` |
| POST `/api/stock-counts/:id/lines/:lineId/refresh-expected` | — | `{ line }` («Обновить ожидание») |
| POST `/api/stock-counts/:id/lines/:lineId/decision` | `{ decision: LOST\|ADJUST\|FOUND\|null, note?, sourceBookingId?, seenCountedQty, seenExpectedQty, acknowledgeBooksChanged? }` (seen — обязательны, кроме `decision: null`) | `{ line }` |
| GET `/api/stock-counts/:id/lines/:lineId/trail` | — | `{ trail: EquipmentTrail }` |
| GET `/api/stock-counts/:id/trail-suggestions` | — | `{ suggestions: Record<lineId, TrailSuggestion \| null> }` (только у идущей) |
| POST `/api/stock-counts/:id/complete` | — | `{ stockCount, result: CompleteResult }` |
| POST `/api/stock-counts/:id/cancel` | — | `{ stockCount }` |
| GET `/api/stock-counts/:id/act.pdf` | — | PDF A4 альбомный (черновик, пока OPEN) |
| GET `/api/stock-counts/:id/act.xlsx` | — | XLSX |

Киоск — в `warehouseScanRouter` за `warehouseAuth` (PIN-токен или сессия SA/WH),
`countedBy = req.warehouseWorker.name`:

| GET `/api/warehouse/stock-count` | — | `{ stockCount: StockCountDetail \| null }` (открытая) |
| GET `/api/warehouse/stock-count/:id/lines` | `category?` | `{ lines }` |
| POST `/api/warehouse/stock-count/:id/lines/:lineId/count` | `{ qty }` | `{ line }` |
| POST `/api/warehouse/stock-count/:id/lines/:lineId/reset` | — | `{ line }` |

Потеряшки (`/api/problem-items`, SA + WH):

| POST `/api/problem-items` | `{ equipmentId, equipmentUnitId?, quantity?, reason, comment, expectedBackDate?, sourceBookingId? }` | 201 `{ item }` |
| GET `/api/problem-items/trail?equipmentId=` | — | `{ trail: EquipmentTrail }` |
| GET `/api/problem-items` | + `source?` фильтр; в элементах + `source`, `stockCount {id, number}`, `equipment {name, category}` | как было |

Ручное создание: COUNT-позиция — `quantity` 1…`onShelf.expected` (400 `QUANTITY_EXCEEDS_SHELF`);
UNIT-позиция — обязателен `equipmentUnitId` этой позиции, путь через существующий
`createProblemItem`. `reason = DESTROYED` для COUNT → `status WROTE_OFF`. `comment` ≥ 3 символов.
`LEFT_ON_SITE` → `EXPECTED`, остальное → `SEARCHING`. `source = MANUAL`, `createdBy = username`,
аудит `PROBLEM_ITEM_CREATE`.

Имена в выдачах потеряшек: `equipmentUnit.equipment ?? bookingItem.equipment ?? equipment`.
Новые потеряшки с приёмки (UNIT и COUNT) тоже пишут `equipmentId`.

Сторож двойного счёта: пока позиция посчитана в идущей инвентаризации, ручная потеряшка и ЛЮБОЙ
разбор (`FOUND` и `NOT_FOUND`) безъюнитной карточки позиции → 409 `STOCK_COUNT_LINE_COUNTED`
`{ stockCountId, stockCountNumber }`. «Не найдено» доступность не меняет, но выводит карточку из
того, что может закрыть «Нашлось» строки. Отмена или завершение инвентаризации сторож снимают.

### Типы ответов

```ts
type StockCountStatus = "OPEN" | "CLOSED" | "CANCELLED";
type Decision = "LOST" | "ADJUST" | "FOUND";

interface StockCountTotals {
  lines: number; counted: number; matched: number;
  shortagePositions: number; shortageQty: number;
  surplusPositions: number; surplusQty: number;
  undecided: number;                       // посчитанные расхождения без решения
  shortageRatePerShift: string;            // Σ rateSnapshot × |diff| по недостачам, Decimal-строка
}
interface StockCountSummary {
  id: string; number: number; status: StockCountStatus;
  categories: string[] | null; startedAt: string; closedAt: string | null; cancelledAt: string | null;
  createdByName: string; closedByName: string | null; counters: string[];   // кто считал
  totals: StockCountTotals;
}
interface StockCountCategory { category: string; lines: number; counted: number; discrepancies: number; counters: string[] }
interface StockCountDetail extends StockCountSummary {
  categoryProgress: StockCountCategory[];
  unitModeExcluded: number;               // позиций со штучным учётом вне охвата
  isFirst: boolean;                       // первая завершённая/идущая — для баннера «первая инвентаризация»
  decisionsPlan: { lostPositions: number; lostQty: number; adjustPositions: number;
                   adjustMinusQty: number; adjustPlusQty: number; foundPositions: number; foundQty: number };
}
interface Breakdown { total: number; issued: number; calendar: number; repair: number; lost: number; expected: number }
interface StockCountLineView {
  id: string; equipmentId: string | null; name: string; category: string;
  ratePerShift: string; position: number;
  expected: Breakdown;                    // снапшот, если посчитано; иначе живое
  expectedIsSnapshot: boolean;
  calendarBookings: { bookingId: string; projectName: string; clientName: string; quantity: number; endDate: string }[];
  countedQty: number | null; countedBy: string | null; countedAt: string | null;
  diff: number | null;                    // counted − expected
  decision: Decision | null; decisionNote: string | null; decidedBy: string | null; decidedAt: string | null;
  sourceBookingId: string | null; sourceBooking: { id: string; projectName: string; clientName: string } | null;
  openProblemQty: number;                 // для «Нашлось»: открытые, заведённые не позже счёта
  allowedDecisions: Decision[];           // вычисляется сервером
  isUnitMode: boolean;                    // позиция на штучном учёте — решения не ждёт
  live: Breakdown | null;                 // живая разбивка посчитанной строки идущей, иначе null
  booksChangedSinceCount: boolean;        // live ≠ снапшоту хоть в одном слагаемом
  booksAcknowledged: boolean;             // LOST/ADJUST подтверждено против этого live
  readyForPickupQty: number;              // починено за 7 суток — пояснение, не слагаемое
}
interface TrailBooking {
  bookingId: string; projectName: string; clientName: string;
  startDate: string; endDate: string; quantity: number; status: string;
  returnMode: "KIOSK" | "MANUAL" | "AUTO" | "OUT";
  returnedBy: string | null; remarks: { problemQty: number; repairQty: number } | null;
}
interface EquipmentTrail {
  equipmentId: string; name: string; category: string;
  windowFrom: string; windowIsDefault: boolean;
  totalBookings: number; verifiedReturns: number;
  bookings: TrailBooking[];               // ≤ 50
  suggestedBookingId: string | null;
  openProblems: { id: string; quantity: number; reason: string; status: string; createdAt: string; projectName: string | null }[];
  onShelf: Breakdown;
  repairEvents: { writtenOffQty: number; readyForPickupQty: number };
}
type TrailSuggestion = Pick<TrailBooking, "bookingId" | "projectName" | "clientName" | "quantity" | "startDate" | "endDate">;
interface StockCountScope { categories: string[]; counts: Record<string, number>; unitCounts: Record<string, number> }
interface CompleteResult {
  matched: number; lostPositions: number; lostQty: number; createdProblemItemIds: string[];
  adjustedPositions: number; foundPositions: number; foundQty: number; unexplainedSurplusQty: number;
  verifiedPositions: number; uncounted: number;
  unitModeSkipped: number;                // посчитанные строки позиций, ушедших на штучный учёт
}
```

## 7. Интерфейс

### Десктоп (AppShell, SA + WH) — мокап экраны 1–2
- Пункт меню «Инвентаризация» (`/warehouse/inventory`) в секции «Склад» у SA и WH.
- Подменю склада `WarehouseSubnav`: «Потеряшки» · «Инвентаризация» · «История инвентаризаций»
  (на `/warehouse/problems`, `/warehouse/inventory`, `/warehouse/inventory/history`).
- `/warehouse/inventory`: если есть открытая — переход в неё; иначе пустое состояние с
  объяснением и «Начать инвентаризацию» (охват: весь склад по умолчанию, по желанию — категории;
  счётчики — только позиции количеством, категорию только со штучным учётом выбрать нельзя:
  «только штучный учёт — сверяется в карточке единиц»).
- `/warehouse/inventory/[id]`: шапка (№, статус, кто, акт PDF/XLSX, «Отменить»); переключатель
  «Счёт / Итог».
  - **Счёт** — слева рейл категорий с прогрессом, кто считает, счётчик расхождений; справа строки
    выбранной категории: «на полке должно быть N» + пояснения (на съёмках / по календарю у «…» /
    в мастерской / в потеряшках), степпер, «= N» (всё на месте), результат (сошлось / −N ₽/смена /
    +N излишек / не посчитано). Строки с `total = 1` — кнопки «на месте / нет».
  - **Итог** — баннер «первая инвентаризация» (если `isFirst`), 5 плиток (посчитано, сошлось,
    недостача, излишек, под вопросом ₽/смена), список недостач и излишков с фильтром
    «без решения / все», решения сегментом, «Как пропало ▾» с таблицей броней, вердиктом,
    советом и выбором брони для LOST; ADJUST спрашивает причину и обещает поправку от текущего
    количества («поправится с X до Y»), а излишек при броне на съёмке предупреждает «может быть
    бронью, не отмеченной возвращённой». Учёт изменился после счёта — янтарная строка «учёт
    изменился после счёта: на съёмках 4 → 0 (ожидание 6 → 10)» и два выхода: «Обновить ожидание»
    и «Оставить как посчитано». Справа — «Завершить»:
    прогресс решений, что произойдёт (потеряшки / поправки / нашлось / сверено), деньги,
    кнопка заблокирована с текстом «осталось решить N».
- `/warehouse/inventory/history` — список завершённых/отменённых со сводкой и ссылками на акт.

### Киоск (PIN) — мокап «Киоск · считаем полку»
- Не новая вкладка. На «Смене» — карточка «Идёт инвентаризация № N · посчитано X из Y →
  Считать», если есть открытая.
- Экран счёта (`?tab=count`): выбор категории (прогресс, кто считает) → строки: крупно «на полке
  должно быть N», пояснение по календарю, `total = 1` → «✓ На месте / Нет на полке», иначе степпер
  (цели ≥ 44 px) + «Всё на месте · N»; результат строки «−2 · решит руководитель после счёта»;
  подвал «расхождений · сошлось · Пауза». Счёт сохраняется сразу, ошибка сети — видимая.

### Акт — мокап «Акт инвентаризации»
PDF A4 **альбомный** (pdfkit, **нулевые поля + ручная пагинация**, DejaVu для кириллицы): шапка с
организацией, № и датой (или «ЧЕРНОВИК» пока OPEN), охват, кто считал, время; сводка; раздел 1 —
расхождения с решениями (колонка ожидания — «Должно быть» / «На полке должно быть»: «по учёту» в
акте — это `totalQuantity`, им говорит «ошибка учёта: 25 → 23»); раздел 2 — сверено без
расхождений; раздел 3 — не посчитано; подписи
«Пересчитали: …» и «Руководитель». XLSX: лист «Расхождения», лист «Все позиции». Имя файла —
через `buildAttachmentContentDisposition` (кириллица).

### Потеряшки — дополнения к реестру
- Подменю склада; колонка/метка «источник»; фильтр по источнику; причина «Не нашли на складе».
- Кнопка «Завести потеряшку» → модалка (мокап concept-a, врезка 1, БЕЗ полей «Ищет» и «Объявить
  в поиск»): поиск позиции, плитки наличия (всего / на съёмке / в мастерской / на полке), степпер
  до «на полке», причина-чипы, «где видели в последний раз» (след, радио-выбор брони или «не
  связано с бронью»), комментарий, «ожидается к» для «остался на площадке».

## 8. Права

| Действие | SA | WH | TECH | COLLECTOR | PIN-кладовщик |
|---|---|---|---|---|---|
| Смотреть, начать, отменить, решать, завершить, акт | ✓ | ✓ | ✗ | ✗ | ✗ |
| Считать (десктоп) | ✓ | ✓ | ✗ | ✗ | — |
| Считать (киоск) | ✓* | ✓* | ✗ | ✗ | ✓ |
| Завести потеряшку вручную | ✓ | ✓ | ✗ | ✗ | ✗ |

\* через fallback `warehouseAuth` на основную сессию.

## 9. Тесты

API (изолированная SQLite на файл, как `problemItems.routes.test.ts`; целостность решений —
`stockCountIntegrity.test.ts`): учёт изменился после счёта (EXPECTATION_CHANGED, LINE_BOOKS_CHANGED,
«Обновить ожидание»), seen-значения (LINE_CHANGED), отсечка «Нашлось» по счёту, «Нашлось» без
потеряшек ждёт решения, кто решил «Ошибку учёта», паритет подсказок следа с полным следом, охват
только COUNT; старт/одна открытая/охват/
UNIT исключены; формула (issued, calendar, repair, lost — включая новую ручную потеряшку);
снапшот при счёте; сброс решения при пересчёте; валидации решений; завершение — все эффекты,
частичное закрытие FOUND, дельта ADJUST к текущему значению, непосчитанные не трогаются,
409 UNDECIDED; отмена; права по ролям; киоск по PIN-токену; след (окно, режимы приёмки,
подсказка); ручная потеряшка (лимит по полке, UNIT-путь, DESTROYED); регрессия доступности
(ручная потеряшка уменьшает `/api/availability`); акт — 200, тип, непустой, кириллица в имени.
Сторож `anonymousSurface.test.ts` должен пройти без правок `PUBLIC_SURFACE`.

Web (vitest + RTL): решения и их доступность, блокировка «Завершить», строка киоска (total=1 и
степпер), модалка ручной потеряшки (лимит, обязательный комментарий).

Визуальная сверка: 1440 и 375 против мокапа.
