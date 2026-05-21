# Дизайн: финал выдачи (Сверка → Подтвердить → Результат)

- Дата: 2026-05-20
- Статус: на ревью пользователя
- Контекст: `/warehouse/scan`, шаг `summary` для операции `ISSUE`
- Эталон макета: `docs/mockups/warehouse-scan/04-issue-summary-and-result.html` (будет сохранён вместе с этой спекой при коммите)
- Утверждено пользователем через visual-companion: вариант **A** (3-шаг: Сверка → Подтвердить → Результат), `untouched-but-reserved` → soft-warn без блокировки.

## 1. Цель

Заменить плейсхолдер `SummaryStep` («Сверка и завершение · В разработке») на рабочий финал выдачи и закрыть пробел в бэкенде, из-за которого бронь после «выдачи» не уходит в статус `ISSUED` — то есть не появляется в списке броней для приёмки. После этой задачи кладовщик пройдёт полный цикл: PIN-логин → выбор брони → чек-лист → **Сверка → Подтвердить → Результат** → бронь в `ISSUED` → доступна для приёмки.

## 2. Что уже есть (НЕ строим)

- `IssueChecklist` (чек-лист выдачи: «Выдать всё разом», ✓/✗ по строке, ＋ Добор с soft-warn доступности) — оставляем, добавляем внутрь крошечный state-machine: фаза `checklist | summary | submitting | result`.
- `api.complete(sessionId, payload)` — клиент уже есть; для ISSUE тело — пустое (`{}`); ответ — `CompleteResult` (то же `ReconciliationSummary`, что и у RETURN, поля `scanned/expected/missing/substituted/...`).
- `api.getSummary(sessionId)` (= backend `getReconciliationPreview`) — возвращает `scanned/expected/missing[]/substituted[]/reservedButUnavailable[]` без коммита. Это источник данных для **расхождений** на экране сверки.
- `ReturnResultView` (RETURN-результат) — канонический паттерн (emerald/amber хедер, счётчики, alert-блок, «Готово»); **зеркалим** для ISSUE-результата.
- Бэкенд `completeSession(ISSUE)` уже физически переводит юниты `AVAILABLE → ISSUED`, создаёт `BookingItemUnit` для замен, удаляет резервации не-отсканированных юнитов (=`missing`). **Эту физическую логику не трогаем.**

## 3. Поведение (по утверждённому макету)

### 3.1 Шаг **Сверка** (новая фаза в `IssueChecklist`)

Открывается, когда кладовщик жмёт «Завершить выдачу →» в чек-листе. Контент:

- **Большой emerald-бейдж сверху**: «Готово к выдаче: **N**», подпись «из M в брони + K доборов».
  - `N` = число UNIT-юнитов с `checked=true` плюс COUNT-линий, отмеченных ✓ локально.
  - `M` = `state.items.length` (BookingItem-ов БЕЗ `isExtra`).
  - `K` = `state.items.filter(i => i.isExtra).length`.
- **Цветные строки-итоги** (свёрнутые, с раскрытием конкретных единиц для проблемных категорий):
  - emerald «✓ Выдаём» — счётчик отмеченных.
  - emerald «＋ Доборы» — счётчик `isExtra`.
  - нейтральная «✗ Не выдаём» — счётчик явно отмеченных ✗.
  - **amber «⚠ Без отметки — пропустим»** — счётчик незаятронутых резерваций; раскрывается под строкой кратким списком единиц («Aputure 600D · прибор 3 из 3»). Это и есть `soft-warn` для untouched-but-reserved.
  - **rose «⛔ Резерв недоступен»** — `reservedButUnavailable.length`; раскрывается со списком и подписью «Эта единица не может быть выдана. Считать её пропущенной?».
  - нейтральная «＋ Доборы с предупреждением» — счётчик доборов, добавленных с `acknowledgedConflict=true`; раскрывается списком («Astera Titan Tube · выдан под ответственность, конфликт с бронью #1039»).
- **Sticky-футер**: `← К чек-листу` (secondary, возврат в фазу `checklist` без потери состояния) и `Подтвердить выдачу →` (primary).
- Soft-warn (по утверждению): **никакая строка НЕ блокирует** «Подтвердить»; кладовщик видит и решает сам.

### 3.2 Подтверждение

`Подтвердить выдачу →` фазу переключает в `submitting`; POST `api.complete(sessionId, {})`. На ответе:
- Если без `failedBrokenUnits/failedProblemUnits` (для ISSUE их по факту не бывает, но контракт общий) и ответ 2xx → фаза `result`, вариант emerald.
- Если ответ 2xx, но в payload есть «не получилось» (теоретически — race с другими ремонтами/потерями, edge-case) → фаза `result`, вариант amber.
- Сетевая ошибка или 5xx → остаёмся в фазе `summary`, показываем компактный rose-alert «Не получилось завершить выдачу: …» с кнопкой «Повторить»; коммит идемпотентен на стороне сервера в смысле «вторая попытка не сломает» (см. §5).

### 3.3 Шаг **Результат** (новый компонент `IssueResultView`)

Тот же канон, что `ReturnResultView`:
- Хедер emerald «**Выдача оформлена**» (icon ✓) — если zero failures.
- Хедер amber «**Выдача оформлена с замечаниями**» (icon ⚠) — если что-то не получилось.
- Счётчики (`dl` rows):
  - «Выдано» — `result.scannedCount` (= число BookingItemUnit, которые оказались выданными).
  - «Добавлено доборов» — `K` (передаётся как prop из IssueChecklist).
  - «Замены (другая единица)» — `result.substitutedItems.length`.
- Информационный синий блок: «Бронь переведена в «Выдана» — появится в списке для приёмки.»
- Если есть `failedX` (edge-case): rose-alert с детализацией.
- Sticky-футер: «Готово» → возврат к шагу выбора брони (`goStep("booking")`).

## 4. Состояние клиента

Лифтим внутрь `IssueChecklist` (тот же компонент владеет всеми фазами, как `ReturnChecklist`):

```ts
type IssuePhase = "checklist" | "summary" | "submitting" | "result";

// Local outcome state (already exists in part):
const [countIssued, setCountIssued]   = useState<Set<string>>(new Set()); // COUNT bookingItemId ✓
const [countWithheld, setCountWithheld] = useState<Set<string>>(new Set()); // COUNT bookingItemId ✗  (NEW)
const [withheldUnits, setWithheldUnits] = useState<Set<string>>(new Set()); // UNIT unitId ✗  (NEW)
const [conflictAddons, setConflictAddons] = useState<Set<string>>(new Set()); // bookingItemId of добор added with acknowledgedConflict (NEW)

const [phase, setPhase] = useState<IssuePhase>("checklist");
const [submitError, setSubmitError] = useState<string | null>(null);
const [result, setResult] = useState<CompleteResult | null>(null);
```

- `handleUnitChange(unitId, next)` уже вызывает `check`/`uncheck`. **Добавляем**: если `next === "WITHHELD"` → `setWithheldUnits(add unitId)`, иначе delete. Сейчас `WITHHELD` и `null` одинаково ведут к `uncheck` — нужно различать (для счётчиков сверки).
- `setCount(bookingItemId, next)` (был `setCount(id, issued: boolean)`): расширяем на трёхзначное состояние («issued» | «withheld» | «none») — реализуется через два set'а.
- `AddonSearch.onAdded` сейчас вызывает `refresh()`. Дополнительно нужно знать: был ли добавлен добор `acknowledgedConflict=true`? Самый простой путь — `AddonSearch` передаёт `(bookingItemId, hadConflict)` в `onAdded`, а `IssueChecklist` сохраняет id в `conflictAddons`. Если из ответа `addItem` доступен только `bookingItemId`, то `AddonSearch` уже знает свой `acknowledgedConflict` (он его и слал) — пробрасываем второй аргумент.

### 4.1 Формальные определения счётчиков сверки

Чтобы реализатор не интерпретировал «без отметки» по-своему — определения однозначные:

```text
issuedUnits   = { u.unitId : u ∈ item.units, item ∈ state.items where trackingMode="UNIT", u.checked = true }
withheldUnits = withheldUnits set (явный ✗-тап)
untouchedUnits = { u.unitId : u ∈ item.units, item ∈ state.items where trackingMode="UNIT",
                   u.checked = false AND u.unitId ∉ withheldUnits }

issuedCountLines   = countIssued  (Set<bookingItemId>)
withheldCountLines = countWithheld
untouchedCountLines = { i.bookingItemId : i ∈ state.items where trackingMode≠"UNIT" OR units missing,
                        i.bookingItemId ∉ issuedCountLines AND ∉ withheldCountLines }

addons          = { i : i ∈ state.items, i.isExtra = true }
addonsWithConflict = { i : i ∈ addons, i.bookingItemId ∈ conflictAddons }
reservedButUnavailable = из api.getSummary().reservedButUnavailable (массив equipmentUnitId)
```

Числа на экране:
- «Готово к выдаче» = `|issuedUnits| + |issuedCountLines|`.
- «✓ Выдаём»       = `|issuedUnits| + |issuedCountLines|` (тот же счётчик, что в бейдже сверху, продублирован в строке).
- «＋ Доборы»       = `|addons|` (а в подвыборке amber/details — `addonsWithConflict`).
- «✗ Не выдаём»    = `|withheldUnits| + |withheldCountLines|`.
- «⚠ Без отметки»  = `|untouchedUnits| + |untouchedCountLines|`. Список под строкой = первые 5 элементов в каноничном порядке (категория → название → ordinal); если больше — «… и ещё K».
- «⛔ Резерв недоступен» = `|reservedButUnavailable|`. Список под строкой — те же первые 5.

`getSummary()` запрашивается один раз при входе в фазу `summary` (effect с cancellation-флагом, как везде в `apps/web/src/components/warehouse`); во время фазы `submitting` повторно не дёргаем.

## 5. Изменение бэкенда

Файл `apps/api/src/services/warehouseScan.ts`, функция `completeSession`.

### 5.1 Транзитировать бронь
Внутри основной `prisma.$transaction(...)`, в ветке `session.operation === "ISSUE"`, **после** обновления статусов юнитов / `BookingItemUnit` и **до** `scanSession.update({status:"COMPLETED"})`:

```ts
await tx.booking.update({
  where: { id: session.bookingId },
  data:  { status: "ISSUED" },
});
```

Перевод идемпотентен на повторе: если бронь уже `ISSUED`, второй `update` ничего не ломает (Prisma update просто запишет ту же строку). Race с другим параллельным `completeSession` той же брони уже исключён существующей проверкой «нет двух одновременных ACTIVE-сессий для одной брони/операции».

### 5.2 Аудит (best-effort, ВНЕ транзакции)

`AuditEntry.userId` — обязательный FK на `AdminUser`, а `completeSession` из warehouse-пути получает `createdBy = req.warehouseWorker?.name` (имя из `WarehousePin`, не `AdminUser.id`) → P2003 при попытке записи аудита. Это **известная** для проекта особенность (см. лог `[addExtraItem] audit failed P2003 AuditEntry`); подход — best-effort, в `.catch()`, вне основной транзакции:

```ts
// После закрытия $transaction (там, где сейчас пишутся другие best-effort аудиты)
await writeAuditEntry({
  userId: options?.createdBy ?? session.workerName,
  action: "BOOKING_STATUS_CHANGED",
  entityType: "Booking",
  entityId: session.bookingId,
  before: { status: "CONFIRMED" },
  after:  { status: "ISSUED", source: "warehouse-scan-issue", sessionId },
}).catch(err => console.warn("[completeSession ISSUE] booking-status audit failed:", err));
```

Аудит может FK-фейлиться при имени-кладовщика — это нормально и логируется, физический переход брони уже зафиксирован транзакцией. (Долгосрочное решение «warehouse-аудит без FK на AdminUser» — отдельный refactor вне этой задачи.)

### 5.3 Заметка про RETURN (вне scope)

`completeSession(RETURN)` сейчас аналогично НЕ переводит бронь в `RETURNED`. Это симметричный пробел, но НЕ часть этой задачи (явный out-of-scope; флагаем для будущего PR).

## 6. Файлы

### Создаём
- `apps/web/src/components/warehouse/IssueResultView.tsx` — чистый презентационный компонент, props `{ result: CompleteResult; projectName: string; issuedCount: number; addonsCount: number; substitutedCount: number; onDone: () => void }`. Зеркалит структуру `ReturnResultView`.
- `apps/web/src/components/warehouse/__tests__/IssueResultView.test.tsx` — counts; emerald/amber хедер по флагу; «Готово» → onDone; нет barcode'ов.
- `apps/web/src/components/warehouse/__tests__/IssueSummary.test.tsx` — рендер сверки: emerald-бейдж с N; стат-строки; раскрытие списка для warn/bad; «Подтвердить» → `api.complete` (мок); «← К чек-листу» возвращает в `checklist`-фазу; soft-warn не блокирует submit.
- `apps/api/src/__tests__/warehouseScanIssueComplete.test.ts` — интеграционный тест: создать бронь в `CONFIRMED`, ACTIVE ISSUE-сессию с парой `ScanRecord`-ов, вызвать `completeSession(sessionId, { createdBy: adminUserId })`; ассерт: `prisma.booking.findUnique({where:{id}})` → `status === "ISSUED"`; идемпотентность на повторе.

### Модифицируем
- `apps/web/src/components/warehouse/IssueChecklist.tsx` — добавить state (см. §4), внутренняя phase-машина (`checklist | summary | submitting | result`), рендер фазы `summary` (новый JSX-блок «Сверка» с emerald-badge + цветными строками + раскрытиями), `submitToComplete()`, рендер фазы `result` через `IssueResultView`, проброс `acknowledgedConflict` из `AddonSearch.onAdded`. Удалить TODO-коммент в футере.
- `apps/web/src/components/warehouse/UnitRow.tsx` — без изменений API; уже поддерживает `value: "ISSUED" | "WITHHELD" | null`.
- `apps/web/src/components/warehouse/AddonSearch.tsx` — `onAdded(bookingItemId, hadConflict: boolean)` (расширение сигнатуры; одна точка вызова — `IssueChecklist`).
- `apps/web/app/warehouse/scan/page.tsx` — удалить шаг `summary` из step-machine (фаза теперь живёт внутри `IssueChecklist`); если шаг `summary` использовался ещё для какого-то экрана — оставить, но `IssueChecklist.onComplete` больше не должен туда уходить (вернёт к списку броней по `onDone` из result-view).
- `apps/web/src/components/warehouse/SummaryStep.tsx` — **удалить** (плейсхолдер больше не нужен).
- `apps/api/src/services/warehouseScan.ts` — §5.1 (внутри tx) и §5.2 (best-effort после tx).

### Эталон макета (коммит вместе со спекой)
- `docs/mockups/warehouse-scan/04-issue-summary-and-result.html` — реалистичный mobile-макет сверки + результата (success/warnings) + desktop-вариант; именно по нему сверяемся при дизайн-fidelity QA.

## 7. Тесты

- Backend: новый интеграционный (см. §6) — переход `CONFIRMED → ISSUED` + идемпотентность. Существующий `warehouseScan.brokenUnits.test.ts` остаётся зелёным (он на RETURN-ветке).
- Frontend: `IssueSummary.test.tsx`, `IssueResultView.test.tsx`, дополнения в существующем `IssueChecklist.test.tsx` (фаза-машина, проброс `acknowledgedConflict`).
- Дизайн-fidelity: при `gh workflow run fidelity-walkthrough` (или ad-hoc) — три новых скриншота (375 + 1440): `12-issue-summary-*.png`, `13-issue-result-success-*.png`, `14-issue-result-warnings-*.png`. Сверка глазами с `04-issue-summary-and-result.html`. Обновить `FIDELITY-CHECK.md`.

## 8. Out-of-scope (явно НЕ строим)

- Переход `RETURNED` на бронь после `completeSession(RETURN)` — симметричный, но отдельный PR.
- Refactor аудита «warehouse-пользователь без FK на AdminUser» — best-effort с `.catch()` остаётся.
- Изменение поведения списка броней или операции добор — не трогаем.
- Возможность редактировать чек-лист «через бронь» вне ACTIVE-сессии — не строим.

## 9. Риски / митигации

- **Stale state при возврате `← К чек-листу`**: фаза-машина внутри одного компонента, локальный state сохраняется → возврат бесплатный (`setPhase("checklist")`).
- **Race на повторный submit**: фаза `submitting` блокирует кнопку «Подтвердить»; сетевая ошибка возвращает на `summary` с тем же state — повтор безопасен (бэкенд идемпотентен по §5.1 + ACTIVE-session guard).
- **Audit FK-фейл**: ожидаемо, best-effort, не валит коммит — см. §5.2.
- **Симметричная регрессия для RETURN-флоу**: явно OUT-of-scope, и тесты RETURN-флоу не зависят от ISSUE-перехода → не сломаются.

## 10. Критерии готовности

- Запуск `npm run dev`, прохождение полного цикла кладовщика: чек-лист → Сверка с правильными счётчиками → Подтвердить → emerald-result → бронь видна в списке RETURN. Скриншоты приложены.
- Бэкенд: `prisma.booking.findUnique` после `completeSession(ISSUE)` → `status: "ISSUED"`. Аудит-запись `BOOKING_STATUS_CHANGED` либо успешна, либо ожидаемо `.catch()`-нута (лог).
- Все существующие тесты зелёные; новые тесты по §7 зелёные.
- Дизайн-fidelity: новые скриншоты совпадают с макетом `04-issue-summary-and-result.html` без визуальных регрессий.
- Авто-деплой на push в `main` через `deploy-rsync.yml` зелёный (health-gate в нём же).
