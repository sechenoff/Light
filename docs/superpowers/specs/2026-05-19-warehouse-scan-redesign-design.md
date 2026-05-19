# Дизайн: перестройка раздела «Склад → Выдача / Приёмка»

- Дата: 2026-05-19
- Статус: на ревью пользователя
- Маршрут: `apps/web/app/warehouse/scan` (мобильный + desktop)
- Эталонные макеты: `docs/mockups/warehouse-scan/01-return-checklist.html`, `02-problem-reasons.html`, `03-issue-and-desktop.html` (утверждены пользователем через visual-companion)

## 1. Цель и контекст

Раздел `/warehouse/scan` (вход по PIN → операция → бронь → чек-лист → сверка) сейчас mobile-only,
без desktop-вёрстки, UX медленный, доборы добавляются без проверки занятости, нет фотофиксации
поломок. Бэкенд (чек-лист, доборы, поломки→ремонт, потери, сверка, аудит) уже работает и покрыт
тестами.

Решение по объёму (утверждено): **эволюция** — рабочий бэкенд сохраняем, переписываем UX под
адаптив desktop+mobile, закрываем 4 пробела:

1. Адаптивная вёрстка (mobile + desktop, одна кодовая база, breakpoint-driven).
2. Добор с проверкой доступности по БД на даты брони + мягкое предупреждение о конфликте.
3. Фотомодуль поломки (системная камера телефона) с привязкой к карточке ремонта.
4. Быстрый UX приёмки: «Принять всё» по умолчанию, 3 кнопки исхода на единицу.

Плюс новая поверхность: реестр **«Потеряшки»** (заявки на поиск проблемных единиц) с жизненным
циклом и документированным хуком на будущий «долг гафера».

## 2. Инварианты и ограничения

- **Без штрихкодов в UX.** Нигде не показываем `LR-XXX-NNN` и сканер. Единицы обозначаем
  «прибор N из M» (порядковый в рамках позиции). Код штрихкодов в бэкенде не трогаем.
- **Русский интерфейс** везде: подписи, статусы, тосты, ошибки.
- **Дизайн-канон IBM Plex** + спокойная семантическая палитра (`ink/surface/border/accent/
  emerald/amber/rose/slate`, классы `StatusPill`, `.eyebrow`, `.mono-num`). Никаких editorial-стилей.
- **Бизнес-логика в сервисах**, роуты тонкие; Zod на входах; `HttpError`; аудит в той же
  транзакции, что и мутация.
- **warehouseAuth** (Bearer из PIN-логина) — отдельно от apiKeyAuth; новые scan-эндпоинты под ним.
- SQLite/Prisma: **скалярные списки не поддерживаются** → коллекции только отдельными таблицами.

## 3. Карта потоков (UX)

### 3.1 Вход (без изменений)
Экран PIN-логина (`/api/warehouse/auth`) сохраняется как есть. Адаптируется только под канон.

### 3.2 Список броней — без фильтров
Эталон: `03-issue-and-desktop.html`, блок 1.

- Один экран, **никаких вкладок/поиска/фильтров**.
- Все релевантные брони сразу: для выдачи — статус `CONFIRMED`; для приёмки — `ISSUED`
  (как сейчас в `GET /api/warehouse/bookings?operation=`).
- Сортировка: дата начала ↑, затем номер брони ↑.
- Визуальная группировка по дате: «Сегодня», «Завтра», «Позже» (цветная левая полоса по
  срочности). Группировка — на клиенте по `startDate` в МСК (`apps/web/src/lib/moscowDate.ts`).
- Карточка: дата · № · название проекта · клиент · кол-во единиц. Тап → создаёт сессию и
  открывает чек-лист.
- Идентификатор брони для показа: использовать существующее человекочитаемое поле номера
  `Booking`, если оно есть в схеме; иначе короткий префикс `id`. (Проверяется на реализации
  по `apps/api/prisma/schema.prisma`; это деталь отображения, не влияет на логику.)

### 3.3 Выдача — чек-лист
Эталон: `03-issue-and-desktop.html`, блок 2.

- Кнопка **«Выдать всё разом»** — отмечает все строки «выдано».
- Группировка строк по категории оборудования.
- На строке 2 кнопки: **✓ выдано** / **✗ не выдаём**. По умолчанию ничего не выбрано;
  «Выдать всё» = массовая ✓.
- COUNT-позиции: одна строка-чекбокс на позицию (всё/ничего) с подписью «×N»
  (поведение COUNT уже client-managed в `checklistService`).
- UNIT-позиции: строка на каждый юнит, подпись «прибор N из M».
- Кнопка **«＋ Добор»** внизу.
- Оптимистичные мутации через `/check`,`/uncheck` (как сейчас), снапшот→apply→reconcile.

### 3.4 Добор с проверкой доступности (мягкое предупреждение)
Эталон: `03-issue-and-desktop.html`, блок 3.

- Поиск по каталогу внутри сессии. Каждый результат показывает доступность **на даты текущей
  брони** (`booking.startDate`–`booking.endDate`): «свободно ×K» (emerald) или «занято» (rose).
- При добавлении занятого артикула: **не блокируем**. Показываем крупное красное
  предупреждение: номер конфликтующей брони, её даты, период конфликта, дата «свободно с».
  Кнопки «Отмена» / «Выдать под ответственность».
- Подтверждение → позиция добавляется (`addExtraItem`), и пишется аудит-запись
  `BOOKING_ITEM_ADDED_WITH_CONFLICT` с деталями конфликта. Без конфликта — обычный
  `BOOKING_ITEM_ADDED_ON_SITE` (как сейчас).
- Доступность считается переиспользованием `getAvailability()` из
  `apps/api/src/services/availability.ts` (`BLOCKING_STATUSES = [CONFIRMED, ISSUED]`,
  DRAFT исключены), но через warehouse-scoped эндпоинт (см. §5.2).

### 3.5 Приёмка — чек-лист, 3 кнопки исхода
Эталон: `01-return-checklist.html`.

- Кнопка **«Принять всё разом»** — все единицы → «Принято».
- На строке **3 кнопки**:
  - **✓ Принято** (emerald) — единица возвращена исправной.
  - **🔧 Ремонт** (amber) — раскрывает inline-панель: обязательный комментарий + кнопка
    «📷 Фото» (системная камера, несколько кадров) + превью миниатюр.
    **Срочность ремонта в быстрой панели НЕ запрашивается** (приоритет — скорость; на
    макете её нет): `Repair.urgency` создаётся как `NORMAL`, руководитель уточняет позже
    в `/repair/[id]`.
  - **✗ Проблема** (rose) — раскрывает inline-панель красного фона: 4 чипа-причины +
    обязательный комментарий + (для «Остался на площадке») опц. поле «ожидается к дате».
- Скрытые штрихкоды; подпись «прибор N из M».
- Цвет «Ремонт» — **янтарный** (канон; зелёный зарезервирован за «Принято»).
- desktop: панели раскрываются inline в строке (не модалки).

### 3.6 Причины «✗ Проблема» и поведение
Эталон: `02-problem-reasons.html`.

| Причина (enum) | Подпись | Поведение | Статус юнита |
|---|---|---|---|
| `LEFT_ON_SITE` | 📍 Остался на площадке | Восстановимо: заявка «ожидается» (опц. дата), можно до-принять позже второй приёмкой | `MISSING` |
| `LOST` | 🤷 Потерян | Расследование: заявка на поиск; «не найдено» → (будущее) долг гафера | `MISSING` |
| `DESTROYED` | 💥 Уничтожен | Списание: единица выбывает | `RETIRED` |
| `STOLEN` | 🚨 Украден | Расследование: заявка на поиск + флаг «кража» (будущее: полиция/страховая) | `MISSING` |

- Комментарий обязателен для всех 4.
- Все 4 создают запись в реестре «Потеряшки» (см. §3.8). `DESTROYED` создаётся сразу
  закрытой как списанная.
- Это **заменяет** прежний путь `lostUnits` (мгновенное `RETIRED` + `WROTE_OFF` Repair +
  опц. счёт клиенту). Старое API-поле `lostUnits` в `complete` упраздняется/мигрируется
  на новый `problemUnits` (см. §5.3, §8 миграция).

### 3.7 Сводка и завершение
- Перед завершением — экран сверки (переиспользуем `getReconciliationPreview`):
  отсканировано/ожидается, не сдано, замены.
- «Завершить приёмку» → `POST /sessions/:id/complete` с новым payload (§5.3).
- После завершения показываем результат: создано карточек ремонта, заведено в «Потеряшки»,
  списано, флаг `invoiceNeedsReissue` (как сейчас).

### 3.8 Реестр «Потеряшки» (заявки на поиск)
Новая страница для руководителя/склада (роль `SUPER_ADMIN` + `WAREHOUSE`):
маршрут `apps/web/app/warehouse/problems` (ссылка из `/admin` и/или `/day`).

- Список `ProblemItem` с фильтром по статусу.
- Колонки: единица (название, без штрихкода), бронь-источник, причина, комментарий,
  ожидается к дате, статус, кто создал, когда.
- Действия по элементу (просто, сейчас):
  - **«Найдено»** → `ProblemItem.status=FOUND`, `resolvedAt/By/Note`; единица
    `MISSING→AVAILABLE`; аудит `PROBLEM_ITEM_RESOLVE`.
  - **«Не найдено»** → `status=NOT_FOUND` + заметка; единица остаётся `MISSING`;
    аудит. **Хук на будущее:** здесь позже навешивается «долг гафера» (НЕ строим сейчас,
    помечаем `// FUTURE:` точкой расширения в сервисе).
- **Авто-резолв при позднем возврате:** в `completeSession` (RETURN) для каждого принятого
  юнита проверяется наличие открытого `ProblemItem` (`EXPECTED`/`SEARCHING`) по этому
  `equipmentUnitId`; если есть — он закрывается `status=FOUND`, `resolvedAt/By`,
  `resolutionNote="возвращён повторной приёмкой"`, аудит `PROBLEM_ITEM_RESOLVE`, юнит
  `MISSING→AVAILABLE` отрабатывает штатной логикой возврата. Так `LEFT_ON_SITE` (ожидается)
  до-принимается второй приёмкой без ручных действий.

### 3.9 Адаптив desktop
Эталон: `03-issue-and-desktop.html`, блок 4.

- Одна кодовая база, Tailwind breakpoints. Mobile: одно-колоночный мастер.
- Desktop (≥ lg): две панели — список броней слева, чек-лист/сводка справа; добор и панели
  ремонта/проблемы — встроенные блоки, не модалки; крупнее цели, видно больше строк.
- Та же бизнес-логика и те же компоненты, отличается только композиция/раскладка.

## 4. Модель данных (Prisma)

### 4.1 Новая модель `ProblemItem`
```
model ProblemItem {
  id              String   @id @default(cuid())
  equipmentUnitId String
  equipmentUnit   EquipmentUnit @relation(fields: [equipmentUnitId], references: [id])
  sourceBookingId String?
  reason          ProblemReason
  comment         String
  expectedBackDate DateTime?       // только для LEFT_ON_SITE
  status          ProblemStatus   @default(SEARCHING)
  createdBy       String
  createdAt       DateTime @default(now())
  resolvedAt      DateTime?
  resolvedBy      String?
  resolutionNote  String?
}

enum ProblemReason { LEFT_ON_SITE  LOST  DESTROYED  STOLEN }
enum ProblemStatus { EXPECTED  SEARCHING  FOUND  NOT_FOUND  WROTE_OFF }
```
- `LEFT_ON_SITE` → `status=EXPECTED`; `LOST`/`STOLEN` → `SEARCHING`; `DESTROYED` →
  `WROTE_OFF` (создаётся закрытой).
- `EquipmentUnit` получает обратную связь `problemItems ProblemItem[]`.

### 4.2 Новая модель `RepairPhoto`
```
model RepairPhoto {
  id        String  @id @default(cuid())
  repairId  String
  repair    Repair  @relation(fields: [repairId], references: [id], onDelete: Cascade)
  filePath  String  // относительный путь от apps/api/uploads/, напр. repairs/{repairId}/{ts}_{name}
  createdBy String
  createdAt DateTime @default(now())
}
```
- `Repair` получает `photos RepairPhoto[]`. Скалярный список нельзя (SQLite).

### 4.3 Аудит
- `AuditEntityType` += `"ProblemItem"`.
- Новые actions: `PROBLEM_ITEM_CREATE`, `PROBLEM_ITEM_RESOLVE`,
  `BOOKING_ITEM_ADDED_WITH_CONFLICT`.

### 4.4 Миграция
- `deploy.sh` использует `prisma db push --accept-data-loss` с авто-бэкапом БД — новые
  таблицы/enum добавляются аддитивно, данные не теряются.
- Старый путь `lostUnits` упраздняется в API: существующих записей нет (фича в рамках этой
  ветки), регрессионные тесты на `lostUnits` переписываются на `problemUnits`.

## 5. Изменения API

Все — под `warehouseAuth` (кроме реестра «Потеряшки», см. ниже).

### 5.1 Без изменений (переиспользуются)
`/auth`, `/bookings`, `POST /sessions`, `GET /sessions/:id`, `/state`, `/check`,
`/uncheck`, `/items`, `/summary`, `/cancel`.

### 5.2 Новое: поиск добора с доступностью
`GET /api/warehouse/sessions/:id/addon-search?q=<строка>`
→ `{ results: [{ equipmentId, name, category, trackingMode, availableQuantity,
   availability: "AVAILABLE"|"PARTIAL"|"UNAVAILABLE", conflict?: { bookingId, bookingNo,
   from, to, freeFrom } }] }`
- Внутри: `getAvailability({ startDate: booking.startDate, endDate: booking.endDate,
  search: q })`, `excludeBookingId = session.bookingId`.

`POST /api/warehouse/sessions/:id/items` (расширяется): тело
`{ equipmentId, quantity, acknowledgedConflict?: boolean }`.
- Если артикул недоступен на даты брони и `acknowledgedConflict` ≠ true →
  `409 { code: "ADDON_CONFLICT", details: { bookingNo, from, to, freeFrom } }`.
- Если `acknowledgedConflict === true` → добавляем + аудит `BOOKING_ITEM_ADDED_WITH_CONFLICT`.
- Без конфликта — поведение как сейчас.

### 5.3 Изменено: завершение сессии
`POST /api/warehouse/sessions/:id/complete` тело:
```
{
  repairUnits?:  [{ equipmentUnitId, comment, urgency? }],   // urgency опц., default NORMAL
  problemUnits?: [{ equipmentUnitId, reason: ProblemReason, comment,
                    expectedBackDate? }]
}
```
- `repairUnits` ≈ прежние `brokenUnits` (создаёт `Repair` через `createRepair`; `reason` =
  `comment`). К созданному Repair привязываются фото из стейджинга сессии (§6).
- `problemUnits` — новый путь (§3.6). На каждый элемент: создать `ProblemItem`, перевести
  статус юнита (`MISSING`/`RETIRED`), аудит `PROBLEM_ITEM_CREATE` в той же транзакции.
- Поле `lostUnits` удаляется из контракта.

### 5.4 Новое: фото ремонта (стейджинг по сессии)
- `POST /api/warehouse/sessions/:id/units/:unitId/photos` — multipart, поле `photo`
  (можно несколько запросов/файлов). Хранение: `uploads/scan-sessions/{sessionId}/{unitId}/`.
- `GET  /api/warehouse/sessions/:id/units/:unitId/photos` — список превью (для UI).
- `DELETE /api/warehouse/sessions/:id/units/:unitId/photos/:photoId` — убрать кадр до завершения.
- На `complete`: для юнитов из `repairUnits` стейдж-фото переносятся в
  `uploads/repairs/{repairId}/` и создаются `RepairPhoto`. Не привязанные к ремонту
  стейдж-папки чистятся.
- Ограничения мультера зеркалят expenses (`apps/api/src/routes/expenses.ts`): ≤ 5 MB,
  только `image/jpeg|image/png` (PDF не нужен), magic-bytes валидация, санитизация имени,
  защита от path traversal (`resolve` внутри `UPLOAD_ROOT`).

### 5.5 Новое: реестр «Потеряшки» (admin-scoped)
Под `apiKeyAuth` + `rolesGuard(["SUPER_ADMIN","WAREHOUSE"])` (как админ-данные, не kiosk):
- `GET    /api/problem-items?status=&limit=&cursor=` — список (keyset-пагинация, как audit).
- `POST   /api/problem-items/:id/resolve` `{ outcome: "FOUND"|"NOT_FOUND", note }`
  → меняет статус, обновляет статус юнита для `FOUND`, аудит. `// FUTURE:` точка для долга
  гафера при `NOT_FOUND`.

### 5.6 Фото видны руководителю
`GET /api/repairs/:id` (существующий) расширяется полем `photos: [{ id, url }]`; страница
`/repair/[id]` показывает галерею. `GET` файла — стрим с диска с защитой пути (как expenses).

## 6. Захват и хранение фото

- Клиент: `<input type="file" accept="image/*" capture="environment" multiple>` — открывает
  системную камеру; выбранные кадры грузятся в стейджинг сессии (§5.4), показываются
  миниатюрами с возможностью удалить до завершения.
- На `complete` стейдж-фото ремонтных юнитов привязываются к `Repair` (`RepairPhoto`),
  путь — относительный от `apps/api/uploads/` (паттерн expenses).
- Фото только для исхода **Ремонт** (как решено). Фото для «Уничтожен/Проблема» — явный
  будущий extension, сейчас НЕ строим.

## 7. Архитектура фронтенда

Текущий `apps/web/app/warehouse/scan/page.tsx` (~1930 строк, mobile-only) разбивается по
фиче (канон many-small-files, < 800 строк/файл):

- `apps/web/app/warehouse/scan/page.tsx` — тонкая оболочка-роутер шагов.
- `apps/web/src/components/warehouse/`:
  - `LoginStep.tsx`
  - `BookingList.tsx` (группировка/сортировка, без фильтров)
  - `IssueChecklist.tsx`, `ReturnChecklist.tsx`
  - `UnitRow.tsx` (сегмент-кнопки: 2 для выдачи, 3 для приёмки)
  - `RepairPanel.tsx` (inline: комментарий + камера + превью)
  - `ProblemPanel.tsx` (inline: 4 чипа + комментарий + опц. дата)
  - `AddonSearch.tsx` (поиск + бейдж доступности + предупреждение конфликта)
  - `SummaryStep.tsx`
  - `ProblemItemsPage.tsx` (реестр «Потеряшки»)
  - `useScanSession.ts` (сессия, оптимистичные мутации, in-flight guard — паттерн как
    `useTasksQuery`)
- Адаптив — Tailwind breakpoints; desktop ≥ lg — двухпанельная композиция в `page.tsx`.
- API-клиент — расширяем существующий `apps/web/src/lib` (тип-безопасные обёртки).

## 8. Вне scope (будущие хуки, НЕ строим)

- «Долг гафера» при `NOT_FOUND` и полноценный раздел долгов — только документированная
  точка расширения `// FUTURE:` в `resolveProblemItem`.
- Кража → интеграция с полицией/страховой.
- Причина «уехал с другим прокатом» (мультивендор) — не выбрана (вариант A = 4 причины).
- Фото для исходов «Уничтожен/Проблема».
- Офлайн-режим склада (плохой Wi-Fi) — не поднимался; вне scope.

## 9. Критерии приёмки (design fidelity — явное требование пользователя)

Реализация обязана **полностью** воспроизводить утверждённые макеты без ухудшений:

- [ ] Список броней: без фильтров/вкладок/поиска, группировка Сегодня/Завтра/Позже,
      сортировка дата+номер.
- [ ] Выдача: «Выдать всё», 2 кнопки на строке, «＋ Добор».
- [ ] Добор: бейдж доступности на даты брони; занятый → красное предупреждение с № брони,
      датами, «свободно с»; «Выдать под ответственность» → аудит.
- [ ] Приёмка: «Принять всё», 3 кнопки (✓ emerald / 🔧 amber / ✗ rose).
- [ ] Ремонт: inline-панель — обязательный комментарий + системная камера + превью.
- [ ] Проблема: красная inline-панель — 4 чипа (Остался/Потерян/Уничтожен/Украден) +
      обязательный комментарий + опц. «ожидается к дате» для «Остался».
- [ ] Маппинг причин → MISSING/RETIRED + запись в реестр «Потеряшки».
- [ ] Реестр «Потеряшки»: список + «Найдено»/«Не найдено».
- [ ] Нигде нет штрихкодов/сканера; «прибор N из M».
- [ ] Весь текст русский; канон IBM Plex + семантическая палитра.
- [ ] Desktop ≥ lg — двухпанельная адаптивная раскладка, та же логика.

### Верификация (обязательна перед заявлением о готовности)
1. Поднять dev-сервер, пройти выдачу и приёмку на реальных данных seed.
2. Скриншоты каждого экрана при ширинах **375** (mobile) и **1440** (desktop).
3. Сверить попиксельно-по-смыслу со `docs/mockups/warehouse-scan/*.html`; расхождения
   зафиксировать, исправить, переснять.
4. Проверить отсутствие штрихкодов и английских ENUM в UI.
5. Проверить консоль/сеть на ошибки.
Никаких заявлений «готово» без приложенных скриншотов и сверки.

## 10. Тестирование

- API-интеграция (паттерн `dashboard.test.ts`/`approval.test.ts`: изолированная SQLite,
  `signSession`): добор-конфликт (409 / acknowledged), `complete` с `repairUnits`/
  `problemUnits`, маппинг статусов юнита, создание/резолв `ProblemItem`, загрузка/привязка/
  очистка фото, path-traversal guard.
- Регресс: переписать существующие `lostUnits`-тесты на `problemUnits`; не сломать
  существующие scan/checklist/repair тесты.
- Web: компонентные тесты на сегмент-кнопки и панели (vitest+jsdom, как `ApprovalTimeline`).
- Цель покрытия 80% по новому коду; общий прогон `npm test` зелёный.

## 11. Риски

- **Стейджинг фото до создания Repair** — самая сложная часть. Митигировать чёткой
  привязкой session→unit→repair на `complete` и очисткой осиротевших папок.
- **Замена `lostUnits`** меняет контракт `complete` — все вызовы/тесты обновить синхронно.
- **getAvailability под warehouseAuth** — переиспользуем сервис, не дублируем; следим, что
  DRAFT исключены и `excludeBookingId` = текущая бронь.
- **Размер `page.tsx`** — обязательно декомпозировать, иначе деградация поддерживаемости.
