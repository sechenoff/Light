# CLAUDE.md — Light Rental System

## Project Overview

Film lighting equipment rental platform for a Russian cinematography rental house. Three apps in an npm workspaces monorepo:
- **API** (`apps/api`): Express 4 REST server with Prisma 6 (SQLite), BullMQ photo analysis queue, Gemini AI vision, warehouse barcode scanning
- **Web** (`apps/web`): Next.js 14 admin dashboard with Tailwind CSS 3, proxies API via catch-all route handler, mobile warehouse scan UI
- **Bot** (`apps/bot`): Telegram bot via Telegraf 4, hub-and-spoke booking flow with AI equipment matching via API

All UI text, comments, and business logic use Russian language.

## Key Rules

1. **TypeScript strict mode** everywhere. Target ES2022, CommonJS modules. See `tsconfig.base.json`.
2. **No ORM queries in routes** -- business logic lives in `apps/api/src/services/`, routes are thin controllers in `apps/api/src/routes/`.
3. **Zod for validation** -- request bodies validated with Zod schemas; errors caught by centralized handler in `app.ts`.
4. **Decimal.js for money** -- monetary values use Prisma `Decimal` type, serialized via `apps/api/src/utils/serializeDecimal.ts`.
5. **Vision provider is pluggable** -- interface at `apps/api/src/services/vision/provider.ts`, implementations: `gemini.ts` (production), `mock.ts` (dev). Selected by `VISION_PROVIDER` env var.
6. **Crew calculator is shared** -- logic lives in `packages/shared/` (`@light-rental/shared`). Both web and bot import from there. Do not add local copies.
7. **Web proxies API** -- `apps/web/app/api/[...path]/route.ts` forwards all `/api/*` requests to Express backend. In dev it targets `http://127.0.0.1:4000`. Do not duplicate API endpoints in Next.js.
8. **Prisma pinned** to `>=6.5.0 <7.0.0` -- v7 broke `url` in datasource, <6.5 lacks SQLite enum support.
9. **User-facing text in Russian** -- bot messages, web UI labels, error messages, PDF exports.
10. **deploy.sh uses `prisma db push --accept-data-loss`** -- do not make schema changes without a DB backup.
11. **API key auth** -- `apps/api/src/middleware/apiKeyAuth.ts` validates `X-API-Key` header. `AUTH_MODE=warn` logs violations; `AUTH_MODE=enforce` rejects them. Set `API_KEYS` env var (comma-separated). Health endpoint `/health` is exempt.

## Architecture

```
light-rental-system/
  apps/
    api/          Express 4 + Prisma 6 (SQLite) + BullMQ
      src/
        routes/       20 route files (equipment, bookings, warehouse, equipmentUnits, equipmentUnitsGlobal, importSessions, dashboard, calendar, etc.)
        services/     Business logic (bookings, analyses, barcode, scanSession, equipmentMatcher, gemini, smetaExport/, vision/)
        middleware/   apiKeyAuth, rateLimiter, warehouseAuth (PIN-based token auth)
        queue/        BullMQ connection, worker, queue definitions
        utils/        Helpers (dates, errors, decimal serialization)
      prisma/         schema.prisma (23 models), migrations, seed.ts
      scripts/        One-off import/sync scripts (SvetoBaza catalog), backfill-barcodes.ts
      assets/fonts/   DejaVu fonts for PDF Cyrillic support
    web/          Next.js 14 + React 18 + Tailwind CSS 3
      app/            Pages: dashboard (/), bookings, equipment, calendar, finance, admin, crew-calculator, settings, warehouse (scan UI)
      app/api/        Catch-all proxy to Express backend
      src/lib/        Shared logic: api client, formatting
      src/components/ AppShell, StatusPill, BarcodeScanner, DashboardOpsCard, QuickAvailabilityCheck, CalendarTooltip
    bot/          Telegraf 4 + AI booking (API-backed matching)
      src/scenes/     booking (hub-and-spoke), crewCalc, photoAnalysis wizard scenes
      src/services/   llm (equipment matching via API), api client, logger
  packages/
    shared/       @light-rental/shared — crewCalculator + crewRates (dual CJS/ESM via tsup)
```

**Request flow:** Browser -> Next.js `/api/[...path]` proxy -> Express :4000 -> Prisma/SQLite
**Bot flow:** Telegram -> Telegraf scenes (hub-and-spoke booking) -> Express API (parseGafferReview) + inline confirmations
**AI analysis flow:** Photo -> BullMQ queue -> Gemini 2.5 Flash vision -> equipmentMatcher -> catalog estimate
**Warehouse scan flow:** Mobile browser -> `/warehouse/scan` (standalone, no AppShell) -> PIN auth -> select booking -> camera barcode scan -> HMAC verify -> issue/return reconciliation

## Key Files

| File | Purpose |
|------|---------|
| `apps/api/src/app.ts` | Express app: middleware stack + centralized error handler |
| `apps/api/src/index.ts` | Server start, conditional Redis/BullMQ worker bootstrap |
| `apps/api/prisma/schema.prisma` | 23 models (incl. ScanSession, ScanRecord, WarehousePin, ImportSession, DiffRow, CompetitorAlias) -- source of truth for data layer |
| `apps/api/src/services/gemini.ts` | Gemini 2.5 Flash: photo analysis + diagram generation |
| `apps/api/src/services/equipmentMatcher.ts` | AI output to catalog matching (~530 lines, DB-driven aliases via SlangAlias) |
| `apps/api/scripts/migrate-aliases-to-db.ts` | One-time migration: TYPE_SYNONYMS → SlangAlias DB records |
| `apps/api/src/services/smetaExport/renderPdf.ts` | A4-PDF сметы (pdfkit): ручная пагинация (нулевые поля + bufferPages), реквизиты организации, группировка по категориям, повтор шапки/категории на переносе, футер «Стр. N из M», `renderSmetaPdfToBuffer` для ЛК |
| `apps/api/src/services/smetaExport/renderXlsx.ts` | XLSX сметы (exceljs) с печатью A4: `pageSetup` (paperSize 9, portrait, fitToWidth 1, printTitlesRow), колонтитул «Стр. N из M», freeze у шапки; `appendTransportAndGrandTotal` для полной сметы |
| `apps/api/src/services/smetaExport/buildFullDocument.ts` | Полная смета: main + addon + транспорт (`buildTransportSection` из BookingVehicle, блок скрыт при сумме 0), `grandTotal` = сумма всех блоков |
| `apps/api/src/routes/bookingRequestParser.ts` | AI-разбор заявки гаффера: `parse-gaffer-review` (текст) и `parse-gaffer-document` (PDF/фото, multipart) → `services/llm` → матчинг каталога (`matchLinesToItems`, общий); `match-equipment` — без LLM |
| `apps/api/src/services/llm/` | Слой LLM: `provider.ts` (контракт, промпты, нормализация), `anthropic.ts` (Claude Opus 5, structured output, документы), `gemini.ts` (JSON-режим + `inlineData`), `openai.ts` (только текст; `baseURL` всегда явный), `fallback.ts` (цепочка ног), `index.ts` (`getLlmProvider`, `buildLlmLeg`, `LLM_FALLBACK_CHAIN`) |
| `apps/api/src/services/gafferDocumentImport.ts` | Импорт заявки-документа: сигнатуры файлов, `findClientForGaffer` (телефон → почта → однозначное имя), `importGafferDocument` |
| `apps/bot/src/scenes/booking.ts` | Hub-and-spoke booking scene (~1000 LOC): hub step is central cart screen, spokes: catalog, inline needsReview confirmations |
| `apps/bot/src/services/api.ts` | Bot API client: gaffer review types (GafferReviewItem, GafferMatchCandidate), parseGafferReview() |
| `apps/bot/src/services/llm.ts` | Equipment matching via parseGafferReview API (3-tier: resolved/needsReview/unmatched); `parseDates` / `parseCatalogIntent` / `validateBookingSummary` до сих пор ходят в OpenAI напрямую по мёртвому ключу — см. Known Issues №8 |
| `apps/api/src/services/importSession.ts` | Import session service: XLSX/CSV parsing, 4-tier matching (exact→alias→fuzzy→AI), diff, bulk actions, apply with optimistic locking |
| `apps/api/src/routes/importSessions.ts` | Import session API: upload, map, match, rows (filter: changed/unmatched/action), bulk accept/reject, apply, rematch, XLSX export |
| `apps/api/src/services/barcode.ts` | Barcode generation (Code128 via bwip-js), HMAC-SHA256 verification, label rendering (PNG/PDF), dual resolution via `resolveBarcode()` |
| `apps/api/src/services/scanSession.ts` | Scan session service: issue/return/cancel logic, unit status transitions, reconciliation |
| `apps/api/src/routes/warehouse.ts` | Warehouse scan endpoints: auth, sessions, scan, summary, complete (7 scan routes + public auth) |
| `apps/api/src/routes/equipmentUnits.ts` | Equipment unit CRUD, barcode generation, label endpoints (PNG single, PDF batch), assign-barcode, batch-assign endpoints |
| `apps/api/src/middleware/apiKeyAuth.ts` | API key auth middleware (warn/enforce modes, X-API-Key header) |
| `apps/api/src/middleware/warehouseAuth.ts` | Warehouse PIN auth middleware: HMAC-signed token, per-route (not global) |
| `apps/api/src/middleware/rateLimiter.ts` | Rate limiter: 100 req/min per IP (express-rate-limit) |
| `apps/api/scripts/backfill-barcodes.ts` | Idempotent barcode generation for existing units without barcodes |
| `apps/web/app/warehouse/scan/page.tsx` | Рабочий стол кладовщика v2 — страница-оркестратор: `WorkstationShell` + постоянная навигация из 5 разделов (смена/выдача/приёмка/в работе/журнал + поломки), `?tab=` в URL. Без AppShell. |
| `apps/web/app/equipment/[id]/units/page.tsx` | Unit management: status badges, generate/edit/delete, label printing |
| `apps/web/src/components/equipment/` | Тулбар каталога `/equipment`: `CatalogToolbar` (липкая строка 40 px), `PeriodPopover` (черновик + «Применить»), `CategoryPopover` (категории со счётчиками), `catalogPeriod.ts` (чистая арифметика смен) |
| `packages/shared/src/crewCalculator.ts` | Shared crew cost calculator (imported by web + bot) |
| `apps/bot/src/scenes/booking-helpers.ts` | Extracted pure functions from booking scene |
| `apps/web/app/page.tsx` | Operations dashboard home page (was redirect) |
| `apps/web/src/components/DashboardOpsCard.tsx` | Booking operation card for dashboard sections |
| `apps/web/src/components/QuickAvailabilityCheck.tsx` | Equipment availability search widget (date range + category filter) |
| `apps/web/app/api/[...path]/route.ts` | Catch-all API proxy with connection error handling |
| `apps/web/app/admin/page.tsx` | Admin panel -- slang learning review + warehouse worker management + cross-catalog barcode management + price import (PricesTab: upload, column mapping, review with filters, bulk actions, apply, XLSX export). Сверху — Link-карточка на `/admin/roles`. |
| `apps/web/app/admin/roles/page.tsx` | Read-only справочник «Матрица прав» — `useRequireRole(["SUPER_ADMIN"])`. Рендерит `MATRIX_SECTIONS`, `LEGEND_ITEMS`, `EDGE_CASES`, `TECH_NOTES` из `rolesMatrix.ts` через `StatusPill`. Реплика мокапа `docs/mockups/roles-matrix.html`. |
| `apps/web/src/lib/rolesMatrix.ts` | Data-only: типы `Permission/PermissionCell/MatrixRow/MatrixSection/RoleDescription/EdgeCase/TechNote` + константы для страницы `/admin/roles`. Это документация-как-код, не runtime-конфиг. |
| `apps/api/src/routes/equipmentUnitsGlobal.ts` | Cross-catalog equipment units API: list, lookup, batch labels (mounted at `/api/equipment-units`) |
| `apps/web/app/admin/scanner/page.tsx` | Mobile-first barcode scanner page: lookup, assign, batch-assign modes |
| `apps/web/src/components/BarcodeScanner.tsx` | Shared barcode scanner component (html5-qrcode, Wake Lock, flash animation) |
| `ecosystem.config.js` | PM2 process definitions for api (:4000) + rental-bot |
| `deploy.sh` | Build + deploy script (builds shared first; supports --api, --web, --rental-bot flags) |
| `apps/api/src/routes/dashboard.ts` | GET /api/dashboard/today — daily ops; /pending-approvals (SUPER_ADMIN+WAREHOUSE, `finalAmount` included); /repair-stats (all 3 roles) |
| `apps/web/app/day/page.tsx` | Role-aware «Мой день»: 3 компонента (DaySuperAdmin/DayWarehouse/DayTechnician) — greeting + алерт ожидающих согласования + KPI/ops/repairs + footer metrics |
| `apps/api/src/services/fleetDashboard.ts` | Витрина автопарка: `computeFleetDashboard({period})` — пробег за период (baseline берётся из замера ДО окна), расход на ТО, выручка/загрузка (дни через Set — пересекающиеся брони не удваиваются), светофор `ServiceHealth`, полоса занятости на 14 дней. Все выборки батчами, без N+1 |
| `apps/api/src/routes/vehicles.ts` | `GET /fleet/dashboard?period=30\|90\|365` объявлен ДО `/fleet/:id` (иначе `:id` перехватит «dashboard»); денежные поля → `null` для не-SUPER_ADMIN |
| `apps/web/app/vehicles/[id]/page.tsx` | Карточка единицы техники: шапка, журнал счётчика, журнал ТО, формы записи. Все подписи счётчика (шапка, колонка таблицы, обе формы, текст ошибки «не может уменьшаться») берут единицу из `vehicle.usageUnit` — жёстких «км» в файле не осталось |
| `apps/web/src/components/vehicles/` | Дашборд автопарка: `VehiclesDashboard` (композиция), `VehicleCard` («техпаспорт», unit-aware), `FleetKpiRow`, `OccupancyStrip`, `FleetPeriodToggle`, `useFleetDashboard`, `types.ts` (`USAGE_UNIT_META` + `formatUsage` — единственное место, где км/часы превращаются в слова) |
| `docs/mockups/vehicles-dashboard/` | 3 концепта витрины автопарка (ops / econ / editorial) — выбран editorial судейской панелью 9/9/8 |
| `apps/web/src/components/day/DayHeader.tsx` | Тёмная шапка `/day`: приветствие + русская дата + role-specific summary справа |
| `apps/web/src/components/day/DayAlert.tsx` | Алерт с вариантами rose/amber, опциональным счётчиком и Link-кнопкой «Все →» |
| `apps/web/src/components/day/DayKpiCard.tsx` | KPI-карточка: eyebrow / value (ReactNode) / sub с `subTone: "muted" \| "rose"` |
| `apps/web/src/components/day/DayOperationsList.tsx` | Список операций: HH:MM · выдача/возврат · клиент · (сумма)? · N позиций. Использует shared `pluralize()` |
| `apps/web/src/components/day/DayFooterMetrics.tsx` | Обёртка для нижней строки-сводки с dashed-top-border |
| `apps/web/src/lib/format.ts` | formatRub + formatMoneyRub + `pluralize(n, one, few, many)` + `MONTHS_LOCATIVE` (в январе, в феврале, …) |
| `apps/api/src/routes/calendar.ts` | GET /api/calendar (resources + events) — единственный маршрут; occupancy-эндпоинта нет (его единственный потребитель MiniCalendar удалён 2026-08-05 как мёртвый код) |
| `apps/web/app/calendar/page.tsx` | Full calendar page: desktop availability grid (equipment rows × day columns, collapsible categories) + mobile day-by-day card view; URL params: date, period, category |
| `apps/web/src/components/CalendarTooltip.tsx` | Floating tooltip for calendar cells (via @floating-ui/react): shows booking details on hover |
| `apps/web/src/lib/calendarUtils.ts` | Pure utility: `buildOccupancyMap()` builds Map<`resourceId-date`, OccupancyEntry>; DRAFT bookings excluded from occupied counts |
| `apps/api/src/middleware/botScopeGuard.ts` | Bot scope enforcement: keys with `openclaw-` prefix are restricted to whitelist routes; DELETE globally blocked → 403 BOT_SCOPE_FORBIDDEN |
| `apps/api/src/__tests__/rolesGuardHolistic.test.ts` | 21 интеграционный тест: TECHNICIAN→403 / WAREHOUSE→2xx / SUPER_ADMIN→2xx на `/api/warehouse/workers/*` и `/api/equipment-units/*` + аудит-проверки на AdminUser CRUD |
| `docs/bot-api.md` | Bot API documentation (Russian): auth, scope, all endpoints, curl examples, error codes, 3 typical scenarios |
| `docs/bot-api-tools.json` | OpenAI function-calling schemas (12 tools): ready to paste into `client.chat.completions.create({ tools: [...] })` |
| `apps/api/src/services/bookingApproval.ts` | Booking approval workflow: `submitForApproval` (DRAFT → PENDING_APPROVAL, clears rejectionReason), `approveBooking` (delegates to `confirmBooking` + audit), `rejectBooking` (required reason, PENDING_APPROVAL → DRAFT + rejectionReason + audit) |
| `apps/api/src/__tests__/setup.ts` | Глобальный setup vitest: env-переменные ДО импорта приложения + патч `supertest.Test.prototype.serverAddress` (ходить на `[::1]`, см. конвенцию про флейк) |
| `apps/api/src/__tests__/supertestLoopback.test.ts` | Сторож этого патча: 3 детерминированных сценария с «чужим демоном» на занятом порту (посторонний 403 / ECONNRESET / посторонний 400). Скипается на ОС, где ядро само запрещает wildcard-бинд поверх занятого адреса |
| `apps/api/src/services/debtWriteOff.ts` | Списание хвоста долга: `writeOffBookingDebt` (накопительный `writeOffAmount`, остаток читается внутри tx, cap по остатку) + `cancelBookingDebtWriteOff` (возврат долга в дебиторку). Обе в `$transaction` вместе с `recomputeBookingFinance` + `writeAuditEntry` |
| `apps/api/src/__tests__/debtWriteOff.test.ts` | 11 интеграционных тестов списания: полное/частичное прощение, накопление, cap `WRITE_OFF_EXCEEDS_DEBT`, уход брони из `computeDebts`, выживание при пересчёте, аудит, отмена, роль-гарды (WAREHOUSE → 403) |
| `apps/web/src/components/finance/WriteOffDebtModal.tsx` | Модалка «Простить долг»: сумма предзаполнена полным остатком, парсит «1 200,50», подсказки для частичного/полного списания, опциональная причина |
| `apps/api/src/__tests__/approval.test.ts` | 22 интеграционных теста approval workflow: submit/approve/reject по всем ролям + full reject-resubmit-approve cycle + legacy confirm-bypass регрессия + ?status= Zod-валидация |
| `apps/web/src/components/bookings/RejectBookingModal.tsx` | Модалка обязательной причины отклонения (min 3 trimmed chars, счётчик, Esc-close, backdrop dismissal, auto-focus textarea) |
| `apps/web/src/components/bookings/QuickBookingModal.tsx` | Быстрая бронь: клиент (`ClientAutocomplete`) + произвольная сумма, без оборудования. Даты свёрнуты (сегодня→завтра), проект опционален. Сумма парсится с пробелами и запятой («40 000,50»). Кнопка «⚡ Быстрая бронь» на `/bookings` |
| `apps/api/src/services/bookingBulk.ts` | Групповые действия над бронями: побронная изоляция (одна негодная не роняет пачку), последовательная обработка под SQLite, `assertBulkActionAllowed`, `BULK_MAX_IDS` = 100 |
| `apps/api/src/services/bookingLifecycle.ts` | `cancelBooking` / `archiveBooking` — вынесены из routes и общие для одиночных маршрутов и `/bulk` |
| `apps/web/src/components/bookings/bulkActions.ts` | Чистые правила применимости групповых действий + подписи и тексты подтверждений (зеркало сервера) |
| `apps/web/src/components/bookings/useBookingSelection.ts` | Выбор строк: `Set` с подрезкой под текущий состав (фильтр выбрасывает, дозагрузка сохраняет) |
| `apps/web/src/components/bookings/useBulkBookingActions.ts` | Запрос `/api/bookings/bulk` + применение побронного результата к списку без сброса пагинации |
| `apps/web/src/components/bookings/BulkActionBar.tsx` | Липкая панель действий: применимость на кнопках, лимит пачки, отступ под FAB |
| `apps/web/src/components/bookings/BulkResultModal.tsx` | Отчёт о частичном успехе — только при `failed > 0`, с человеческими подписями броней |
| `apps/api/src/utils/moscowDate.ts` | Moscow TZ helpers: `toMoscowDateString()`, `fromMoscowDateString()`, `moscowTodayStart()`, `addDays()` — single source of truth for date-only task semantics on server |
| `apps/api/src/services/taskService.ts` | Task CRUD service: `createTask`, `updateTask`, `completeTask`, `reopenTask`, `deleteTask`, `listTasks` — all wrapped in `prisma.$transaction` + `writeAuditEntry` |
| `apps/api/src/routes/tasks.ts` | Task routes at `/api/tasks`: GET list, POST create, PATCH update, POST complete/reopen, DELETE; Zod validation; `serializeTask` serializer |
| `apps/web/src/lib/moscowDate.ts` | Client mirror of moscowDate helpers — `toMoscowDateString()`, `fromMoscowDateString()`, `moscowTodayStart()`, `addDays()` |
| `apps/web/src/components/tasks/useTasksQuery.ts` | Custom hook for main tasks list: fetch, optimistic mutate (create/update/complete/reopen/delete), snapshot rollback, per-id in-flight guard, fire-immediately undo-via-reopen |
| `apps/web/src/components/tasks/groupTasks.ts` | Pure utility: `bucketOf()` → 5 buckets (overdue/today/thisWeek/later/noDate), `groupTasks()` sorted. All date math in Moscow date-only domain. |
| `apps/web/src/components/tasks/TaskHistoryPage.tsx` | History page component: pills filter, DONE tasks list (strikethrough, assignee, completedBy, completedAt), "Вернуть" reopen action, id-based cursor pagination "Загрузить ещё" |
| `apps/web/src/components/day/DayTasksWidget.tsx` | Dashboard widget on `/day` for all 3 roles: fetches `/api/dashboard/today` `myTasks`, shows ≤5 tasks with day chip, optimistic complete, empty state, link to `/tasks?filter=my` |
| `apps/web/app/tasks/page.tsx` | Tasks main page shell: `useRequireRole` + Suspense wrapper for `<TasksPage />` |
| `apps/web/app/tasks/history/page.tsx` | Tasks history page shell: `useRequireRole` + Suspense wrapper for `<TaskHistoryPage />` |
| `apps/api/src/services/taskCollabService.ts` | Комментарии + чеклист CRUD: `$transaction` + `writeAuditEntry`; `enrichAuthors` join AdminUser (no FK) |
| `apps/web/src/components/tasks/useTaskDetail.ts` | Консолидированный `GET /api/tasks/:id` + 8 s polling панели + оптимистичные мутации comment/checklist, `pollBlocked`-guard |
| `apps/web/src/components/tasks/TaskDetailPanel.tsx` | Slide-over справа (`?task=` deep-link, focus-trap, Esc); композирует checklist + comments |
| `apps/web/src/components/tasks/TaskComments.tsx` | Лента обсуждения + composer (⌘/Ctrl+Enter) |
| `apps/web/src/components/tasks/TaskChecklist.tsx` | Упорядоченные пункты + прогресс-бар (compositor-friendly scaleX) |
| `apps/api/src/services/addonAvailability.ts` | `findAddonConflict()` — ближайшая конфликтующая бронь (CONFIRMED/ISSUED) для quick-add артикула с учётом `totalQuantity`; возвращает `AddonConflict \| null`. NB: barcode в выдачу не попадает |
| `apps/api/src/services/problemItemService.ts` | Реестр «Потеряшки»: `createProblemItem` (reason→status: LEFT_ON_SITE→EXPECTED, LOST/STOLEN→SEARCHING, DESTROYED→WROTE_OFF; unit→MISSING/RETIRED), `resolveProblemItem` (FOUND/NOT_FOUND), `autoResolveOnReturn` (поздний возврат). Все в `$transaction` + `writeAuditEntry`. FUTURE-хук: NOT_FOUND → «долг гафера» |
| `apps/api/src/services/repairPhotoStorage.ts` | Фото поломки: magic-byte валидация (JPEG/PNG, 5 MB, без PDF), `sanitizeFilename`, `resolveUploadPath` (traversal-guard), staging API (`writeStagedPhoto`/`listStaged`/`moveStagedToRepair`). Зеркалит `expenses.ts` security. `UPLOAD_ROOT` = `apps/api/uploads`; пути в БД относительные |
| `apps/api/src/routes/problemItems.ts` | `/api/problem-items`: GET список (keyset-пагинация по createdAt, фильтр `?status=`, без barcode в выдаче) + POST `/:id/resolve` (Zod: outcome FOUND/NOT_FOUND + note min 3). Router-level `rolesGuard(["SUPER_ADMIN","WAREHOUSE"])` в `routes/index.ts` |
| `apps/web/src/components/warehouse/` | Все компоненты редизайна kiosk: `WorkstationShell` (тёмная шапка + таб-бар рабочего стола v2), `LoginStep`, `BookingList` (без фильтров, группировка по дате), `UnitRow` (2-кн ВЫДАЧА / 3-кн ВОЗВРАТ), `IssueChecklist`, `AddonSearch` (bottom-sheet/inline + focus-trap/scroll-lock/slide-up), `RepairPanel` (нативная камера), `ProblemPanel` (4 причины), `ReturnChecklist`, `ReturnResultView`, `ProblemItemsPage`, `ResolveProblemModal`, `useScanSession`, `api.ts`, `types.ts` (вкл. shared `isScanApiError`) |
| `apps/web/app/warehouse/problems/page.tsx` | Manager-реестр «Потеряшки»: обычный AppShell + JWT (НЕ kiosk). `Suspense` → `<ProblemItemsPage />` |
| `apps/web/app/warehouse/layout.tsx` | Прозрачный passthrough (`<>{children}</>`). Kiosk-фрейм живёт в `WorkstationShell`, не в layout — иначе двойная шапка над редизайн-страницей |
| `docs/superpowers/specs/2026-05-19-warehouse-scan-redesign-design.md` | Утверждённая спецификация редизайна (adaptive UX, потеряшки, фото) |
| `docs/superpowers/plans/2026-05-19-warehouse-scan-redesign.md` | План реализации редизайна (по задачам) |
| `docs/mockups/warehouse-scan/` | Утверждённые мокапы (00–03 HTML) + `FIDELITY-CHECK.md` (375/1440 скриншоты `_fidelity/`) |

## Commands

```bash
# Development (all 3 apps concurrently)
npm run dev

# Development (API + Web only, no bot)
npm run dev:no-bot

# Individual app dev
npm run dev -w apps/api       # Express on :4000 (tsx watch)
npm run dev -w apps/web       # Next.js on :3000
npm run dev -w apps/bot       # Telegraf polling mode (tsx watch)

# Build all
npm run build

# Lint (API + Web only)
npm run lint

# Tests
npm test                          # run all (shared + bot + api) — 478 tests
npm run test -w apps/api          # API tests (smoke + barcode integration)
npm run test -w apps/bot          # bot booking-helpers tests only (31 tests)
npm run test -w packages/shared   # shared package tests only

# Database
npm run prisma:generate       # Generate Prisma client
npm run prisma:migrate        # Run migrations (dev)
npm run seed                  # Seed database
# Also: cd apps/api && npx prisma studio   (DB browser)

# Deploy (on VPS)
./deploy.sh                   # Full deploy (all apps)
./deploy.sh --api             # API only
./deploy.sh --web             # Web only
./deploy.sh --rental-bot      # Bot only
```

## Conventions

- **Module system**: API and Bot use CommonJS. Web uses Next.js ESM.
- **Error handling**: Custom `HttpError` class in `apps/api/src/utils/errors.ts`. All async route handlers use try/catch with `next(err)`.
- **Env config**: `dotenv/config` imported at app entrypoint. API env in `apps/api/.env`, Web env in `apps/web/.env.local`.
- **API prefix**: All routes under `/api/*` (e.g., `/api/bookings`, `/api/equipment`).
- **PDF fonts**: DejaVu Sans loaded from `apps/api/assets/fonts/` for Cyrillic support in PDF exports.
- **Redis optional**: API starts without Redis -- BullMQ worker simply does not initialize if Redis is unreachable.
- **API authentication**: `X-API-Key` header required on all routes except `/health`. Controlled by `AUTH_MODE=warn|enforce` and `API_KEYS` env var (comma-separated). In `warn` mode violations are logged but not blocked; in `enforce` mode they return 401.
- **Bot booking is hub-and-spoke**: Steps are client→project→dates→hub→confirm. Hub is the central cart screen; free text triggers AI matching (parseGafferReview API), ambiguous matches get inline keyboard confirmations (needsReview). Catalog is a spoke from hub. Items persist across all navigation.
- **Bot modes**: Polling (dev, default) or webhook (production, set `WEBHOOK_DOMAIN` in bot .env). Webhook listens on `WEBHOOK_PORT` (default 3001) at path `/telegram`.
- **Deploy backups**: `deploy.sh` auto-backs up SQLite DB before `prisma db push`. Backups in `backups/`, last 10 kept.
- **Warehouse auth is separate from API auth**: `warehouseAuth` middleware uses HMAC-signed tokens from PIN login. Applied per-route to scan endpoints only — `/api/warehouse/auth` and `/api/warehouse/workers/names` are public. Does NOT use apiKeyAuth.
- **Warehouse worker name (audit) — dual namespace.** `ScanSession.workerName` и `req.warehouseWorker.name` хранят `WarehousePin.name` (например, «Иван Кладовщик») когда вход через PIN, или `AdminUser.username` (например, `sechenoff`) когда главная сессия SA/WH прошла fallback в `warehouseAuth`. Это by design: kiosk-сценарий vs admin-сценарий распознаются по namespace.
- **Barcode payloads use HMAC-SHA256**: `BARCODE_SECRET` env var required. Payload format: `unitId:hmac12hex`. Labels encode `barcodePayload` (machine-scannable), display `barcode` (human-readable like `LR-SKY60-003`).
- **Equipment tracking modes**: `COUNT` (legacy, quantity-only) and `UNIT` (individual barcode tracking). Both coexist — COUNT items skip scan verification.
- **Unit status lifecycle**: AVAILABLE → ISSUED (on scan) → AVAILABLE (on return). MAINTENANCE and RETIRED units excluded from reservation and scanning.
- **Dual barcode resolution**: `resolveBarcode()` in `barcode.ts` resolves scanned values via HMAC-first, raw-barcode-fallback. All raw-resolved scans logged with `hmacVerified: false` on `ScanRecord`.
- **Global equipment-units routes**: `/api/equipment-units` routes are mounted BEFORE `/api/equipment` in `routes/index.ts` to prevent prefix collision. Same apiKeyAuth protection.
- **Scanner component is shared**: `BarcodeScanner.tsx` in `src/components/` is used by both `/warehouse/scan` and `/admin/scanner`. The warehouse re-export (`Html5QrcodePlugin.tsx`) is a thin wrapper.
- **Import session matching is 4-tier**: exact `importKey` match → `CompetitorAlias` lookup → `string-similarity` fuzzy match → Gemini AI. Confirmed matches are auto-saved as `CompetitorAlias` records for future imports.
- **Price comparison uses Decimal.equals()**: never use `===` to compare monetary values — `Decimal` instances are objects. Use `.equals()` from Decimal.js.
- **Import file formats**: `.xlsx`, `.csv`, `.xls` accepted (max 5 MB). Parsed via `xlsx` + `exceljs` libraries.
- **Import apply uses optimistic locking**: `version` field on `ImportSession` prevents double-apply. `applyChanges()` increments version atomically and rejects stale requests.
- **`/` redirects to `/day`** — операционный дашборд «Мой день» и есть домашняя страница; `/dashboard` — тоже редирект (осиротевший дубль). MiniCalendar удалён (мёртвый код: звал несуществующий `/api/calendar/occupancy` и нигде не монтировался).
- **Calendar BLOCKING_STATUSES** — `["PENDING_APPROVAL", "CONFIRMED", "ISSUED"]` used by `calendar.ts`, `availability.ts` and `addonAvailability.ts` (аудит 2026-07: бронь на согласовании резервирует оборудование; в календаре — amber «На согласовании»). DRAFT bookings excluded. Confirm/approve исключают саму бронь из проверки конфликтов (excludeBookingId).
- **Hourly precision** — Equipment page and QuickAvailabilityCheck use `datetime-local` inputs. Bookings resolved to exact hour, not just date.
- **New web dependencies**: `@floating-ui/react`, `date-fns` (web only). `react-day-picker` удалён вместе с MiniCalendar (2026-08-05).
- **Bot scope guard** — `botScopeGuard` middleware (mounted in `app.ts` after `apiKeyAuth`) enforces whitelist for API keys with prefix `openclaw-`. DELETE is globally blocked. Non-whitelisted routes return 403 `{ code: "BOT_SCOPE_FORBIDDEN" }`. Keys without this prefix pass through without restriction.
- **Finance debts endpoint** — `GET /api/finance/debts` aggregates `amountOutstanding > 0` bookings (excluding CANCELLED) by client. Supports `?overdueOnly=true` and `?minAmount=N` filters. Service function: `computeDebts()` in `apps/api/src/services/finance.ts`.
- **dryRun option** — `POST /api/bookings/draft` and `PATCH /api/bookings/:id` accept `dryRun: true` in the request body. When true, validates input, computes estimate via `quoteEstimate()`, and returns a preview without writing to DB. POST returns `{ id: null, status: "DRAFT_PREVIEW", ... }`. PATCH returns the existing booking's projected state.
- **legacyFinance=false для новых броней** — `createBookingDraft` явно ставит `legacyFinance: false`, invoice-слой (Finance Phase 2/3) доступен новым броням. Старые брони остаются legacy до ручного `backfill-finance-cutoff.ts`. (Фикс аудита 2026-07.)
- **Ручные issue/return реконсилируют юниты** — `POST /:id/status {action:"issue"|"return"}` в транзакции переводит зарезервированные `BookingItemUnit`/`EquipmentUnit` (issue: → ISSUED + issuedAt; return: → AVAILABLE + returnedAt), консистентно со сканером. `releaseBookingUnits` для manual return НЕ используется (удалял бы историю приёмки).
- **PATCH применяет body.transport** — полная замена `BookingVehicle[]` с переносом driverName/driverPhone по совпадению vehicleId; legacy-колонка `vehicleId` гасится. `transport` и `vehicleEdits` вместе не шлёт ни один UI-путь.
- **Purge заблокирован при финансовых документах** — 409 `PURGE_HAS_FINANCE`, проверка счетов/платежей внутри транзакции purge.
- **GET /api/payments → methodTotals** — серверные агрегаты по методам по всей отфильтрованной выборке (строки Decimal); чипы на /finance/payments читают их, не клиентскую страницу.
- **`/api/finance/dashboard?from&to`** — earned/spent/net считаются за диапазон; без параметров — текущий месяц.
- **`/api/lk/debt` считает долг по `Booking.amountOutstanding`** — единый источник с админским `/finance/debts` (computeDebts); `isOverdue` — общий хелпер `isBookingOverdue` (expectedPaymentDate/paymentStatus), НЕ endDate. Невоидный счёт — только детализация строки.
- **portal-invite/resend возвращают `emailSent` + `inviteUrl`** — провал SMTP не маскируется 200-успехом; карточка показывает предупреждение и кнопку «Скопировать ссылку».
- **Поиск каталога — регистронезависимый для кириллицы** — фильтр в приложении через `toLocaleLowerCase("ru-RU")` (SQLite LIKE регистронезависим только для ASCII). Паттерн как в `availability.ts`.
- **`GET /api/equipment/categories` отдаёт `counts`** — счётчики позиций по категориям для тулбара каталога (`getCategoryCounts` в `services/categoryOrder.ts`, один `groupBy` по `@@index([category])`). Ключ **сырой**, без `normalizeCategoryName`: счётчик обязан считаться тем же ключом, что и фильтр (`?category=` идёт в SQL точным равенством), иначе «Грип» и « грип » обещали бы 4 позиции там, где по клику придёт 3. Считать на клиенте нельзя — при активном `?category=` сервер уже отдаёт урезанную выборку.
- **Тулбар `/equipment` — липкая строка, а не карточка** — `sticky top-12 z-10 lg:top-0`: `top-12` — смещение под мобильную шапку `AppShell` (она сама `sticky top-0 z-20`, ≈46 px), то же значение, что у `CatalogBrowser`. `z-10`, чтобы не спорить с шапкой и не перекрывать скрим мобильного меню (`z-40`). Период — единственный постоянно обведённый контрол: он якорь колонок «Занято / Доступно / Статус», которые затонированы `accent-soft` и подписаны «За выбранный период». В `PeriodPopover` правки копятся в черновике и уходят по «Применить» — `datetime-local` шлёт `onChange` на каждое нажатие, и промежуточные кадры дёргали бы `/api/availability`; пресеты в самой строке применяются сразу.
- **Главный список задач** — грузит только OPEN + отдельный запрос DONE за 24ч (`completedAfter`, sort `completedAt desc`); для не-дефолтной сортировки cursor запрещён (400 `CURSOR_SORT_UNSUPPORTED`), кроме keyset для архива. `TaskEditModal` шлёт dueDate как `YYYY-MM-DD`.
- **MAIN Estimate создаётся при создании черновика** — `createBookingDraft` (не-dryRun) сразу пишет Estimate-снапшот; `confirmBooking` пересоздаёт его тем же upsert-путём. Экран согласования и экспорт PDF работают для свежих черновиков.
- **Экспорт сметы — A4 в обоих форматах, полная смета включает транспорт.** Все экспортные роуты (`/api/estimates/:id/export/*`, `/api/addon-estimates/:id/export/*`, `/api/bookings/:id/full-estimate/export/*`, `POST /quote/export`) кладут в шапку реквизиты организации через `smetaOrgFromSettings(getSettings())` — без фейковых плейсхолдеров: пустое поле не печатается. `full-estimate` дополнительно грузит `vehicles → vehicle` и отдаёт транспортный блок + `grandTotal` = main + addon + транспорт (раньше кнопка «с транспортом» врала — транспорт в файл не попадал). Кнопка «Печать» в `BookingEstimateSection` печатает сам A4-PDF через скрытый iframe (`printEstimatePdf` в bookings/[id]/page.tsx; Safari — новая вкладка + подсказка ⌘P), а НЕ `window.print()` страницы. `/api/lk/bookings/:id/estimate.pdf` отдаёт тот же смета-рендерер (`renderSmetaPdfToBuffer`), fallback на invoice-путь только для легаси-броней без MAIN-снапшота.
- **Ручные issue/return: аудит + гард дат** — `POST /:id/status` пишет `BOOKING_ISSUED`/`BOOKING_RETURNED` в транзакции; выдача раньше `startDate` > 24ч → 409 `ISSUE_TOO_EARLY`, повтор с `force: true` (UI ловит code, показывает подтверждение; задокументировано в docs/bot-api.md + bot-api-tools.json).
- **AdminUser.isActive** — деактивация вместо удаления: login отклоняет `isActive=false`; PATCH-гарды: нельзя менять свою роль, понижать/отключать последнего SUPER_ADMIN (409).
- **Сортировка списка броней** — актуальные (endDate ≥ МСК-сегодня) по startDate asc, затем прошедшие по startDate desc. Фильтры/страница /bookings в URL.
- **POST /draft принимает clientPhone** — новому клиенту записывается, существующему без телефона дозаполняется, существующий НЕ перезаписывается.
- **Быстрая бронь — `POST /api/bookings/quick`** (SA + WAREHOUSE): клиент + произвольная сумма, без позиций. Сумма живёт в `manualFinalAmount` (авторитетна для `recomputeBookingFinance`), бронь создаётся сразу `CONFIRMED` в обход `confirmBooking` (тот падает на пустых позициях) и без MAIN-сметы — снапшотить нечего. Даты по умолчанию сегодня 10:00 → +1 день, проект по умолчанию «Без описания». Аудит `BOOKING_QUICK_CREATE`. UI — `QuickBookingModal` на `/bookings`.
- **Списание («прощение») хвоста долга — `POST/DELETE /api/bookings/:id/write-off`** (SUPER_ADMIN). Смета округляется до удобной суммы, клиент платит ровно её, на броне повисает хвост в несколько сотен рублей — взыскивать его никто не будет, но бронь не уходит из дебиторки. `Booking.writeOffAmount/Reason/At/By` уменьшает сумму К ВЗЫСКАНИЮ и НЕ трогает ни `finalAmount`, ни `amountPaid`: видно три разных числа — выставили, получили, простили. Реализовано списанием, а не удалением счёта/платежа, по той же причине, по которой со страницы долгов убрали удаление брони (аудит 2026-07) — деструктив уничтожает финансовую историю. `recomputeBookingFinance` вычитает списание перед расчётом `amountOutstanding`/`paymentStatus`, поэтому эффект переживает любой пересчёт. `writeOffAmount` накопительный; простить больше текущего остатка нельзя (400 `WRITE_OFF_EXCEEDS_DEBT`), остаток читается ВНУТРИ транзакции. Разрешено только в `CONFIRMED/ISSUED/RETURNED`. Аудит `BOOKING_DEBT_WRITE_OFF` / `BOOKING_DEBT_WRITE_OFF_CANCELLED`. UI: пункт «✅ Простить долг» в меню строки `/finance/debts` (`WriteOffDebtModal`), на карточке брони — amber-баннер «Долг списан» с кнопкой «Вернуть долг» и подпись «прощено N ₽» в карточке «Остаток» (карточка «Оплачено» при списании пишет «закрыто с учётом списания», а не «100% оплачено»).
- **Брони без оборудования скрыты на складе** — `items: { some: {} }` в `GET /api/warehouse/bookings`, `/in-work` и в трёх выборках `computeShift` (константа `HAS_EQUIPMENT_FILTER` в `warehouseWorkstation.ts`). Выдавать и принимать в такой броне нечего; в списке броней, долгах и финансах она видна как обычно. В календаре не появляется закономерно — это сетка занятости оборудования.
- **GET /api/payments?includeVoided=true** — отдаёт аннулированные (voidedAt/voidReason); GET /api/invoices отдаёт `counts` по статусам по всей выборке.
- **BookingForm: автосейв черновика** — localStorage `lr:bookings:new:draft` (debounce 2с) + beforeunload + плашка восстановления; при URL-префилле из календаря (?start&end&equipmentId) чужой сохранённый черновик не восстанавливается и НЕ перезаписывается.
- **Ручной перевод юнита в MAINTENANCE** — создаёт Repair-карточку post-tx best-effort (дубль гасится `REPAIR_ACTIVE_EXISTS`); ручной ISSUED запрещён (`MANUAL_ISSUE_FORBIDDEN`); ручные смены статуса аудируются (`UNIT_STATUS_MANUAL_CHANGE`).
- **Парк не только автомобильный** — `Vehicle.usageUnit` (`KM` / `HOURS`) задаёт единицу счётчика: километры у машин, моточасы у генератора. Меняются ТОЛЬКО подписи в UI; вся арифметика (дельта за период, остаток до ТО, шкала ресурса) общая, потому что это просто монотонный счётчик. Исторические имена колонок (`currentMileage`, `serviceIntervalKm`, `lastServiceMileage`, `VehicleMileageLog.mileage`) означают «показание счётчика в единицах usageUnit» — переименовывать нельзя, `prisma db push` на SQLite сделает drop+add и потеряет данные.
- **`Vehicle.bookable`** — участвует ли единица в подборе транспорта для брони. `false` (генератор): убрана из `GET /api/vehicles`, в карточке нет зоны «Занятость» (её занятость живёт в позициях сметы, а не в `BookingVehicle`), пилюля «В парке» вместо «Свободна». В KPI: не входит в «свободны N / M» и в среднюю загрузку, но учитывается в «требуют внимания».
- **KPI «Пробег парка» суммирует только `usageUnit === "KM"`** — сложить километры с моточасами значило бы показать бессмысленное число.
- **`Vehicle.serviceIntervalKm` — nullable, и это состояние UI** — null означает «интервал не задан», и тогда прогноз ТО НЕ строится: карточка честно пишет об этом вместо выдуманного остатка. Задаётся на `/vehicles/[id]` в панели «Редактировать гос. номер / интервал ТО / заметки».
- **Выручка машины считается по тем же статусам, что и статистика техники** — `CONFIRMED / ISSUED / RETURNED` (константа `RENTAL_BOOKING_STATUSES` продублирована в `fleetDashboard.ts`). DRAFT и CANCELLED в деньги и загрузку не попадают — единая семантика выручки по системе.
- **Быстрые действия автопарка через `?action=`** — `/vehicles/[id]?action=mileage|service` сразу раскрывает нужную форму (проп `defaultOpen`). Страница обёрнута в `Suspense` — обязательно для `useSearchParams` в Next 14.
- **supertest в API-тестах ходит на `[::1]`, а не на `127.0.0.1`** (фикс флейка 2026-08-06, патч в `apps/api/src/__tests__/setup.ts`). Причина: supertest на КАЖДЫЙ `request()` делает `app.listen(0)` без хоста — это бинд на IPv6-wildcard `::`, — а URL строит с жёстко зашитым `127.0.0.1` (`lib/test.js:63` и `:69`). На macOS/BSD wildcard-бинд не конфликтует с чужим слушателем на конкретном `127.0.0.1:PORT`, поэтому ядро выдаёт уже занятый порт, а соединение достаётся более специфичному — ЧУЖОМУ — сокету (Electron/VS Code, language server и всё, что слушает в диапазоне 49152–65535). Запрос уходит в посторонний процесс, тест видит его ответ (401/403/404) или RST, а приложение запроса не видит вовсе. Так терялся примерно каждый третий-пятый полный прогон, всегда в случайном файле; `--pool=forks` и `--maxWorkers` не помогают — конфликт с процессами ВНЕ vitest. **Нельзя** «просто» заменить на `listen(0, "127.0.0.1")`: с явным хостом бинд асинхронный, `app.address()` сразу возвращает null и supertest падает на `lib/test.js:67`. Патч уважает отсутствие IPv6 (если `listen(0)` сел на `0.0.0.0`, URL не переписывается) и громко бросает, если `Test.prototype.serverAddress` пропал после апгрейда supertest. Сторож — `apps/api/src/__tests__/supertestLoopback.test.ts`: детерминированно поднимает «чужой демон» на занятом порту и падает, если патч убрали.
- **SQLite работает в WAL** (перф-аудит 2026-08-02) — `journal_mode=WAL` включается в `prisma.ts` при старте (кроме `NODE_ENV=test`). Следствия: (1) свежие транзакции живут в `prod.db-wal` до чекпойнта — бэкап ТОЛЬКО через `sqlite3 .backup` (CI и deploy.sh уже так делают), голый `cp prod.db` теряет хвост; (2) файлы `-wal`/`-shm` рядом с БД — не мусор, удалять нельзя.
- **Финсинк не в hot path** — `paymentStatusSyncForAllBookings` прогоняется фоновым интервалом в `index.ts` (полокна троттла = 30 c); вызовы в finance-роутах сохранены как контракт для тестов, но на проде всегда попадают в тёплое троттл-окно. `recomputeBookingFinance` пропускает UPDATE, если пересчёт ничего не изменил.
- **Rate limiter — на пользователя, не на IP** — ключ `lr_session` → `X-API-Key` → IP, лимит 300/мин; все браузеры ходят через Next-прокси с одного адреса, и по-IP лимит был общим на весь офис.
- **`/api/auth/me` дедуплицирован на клиенте** — модульный промис-кэш в `src/lib/auth.ts` (TTL 30 c) + `invalidateMeCache()` на login/logout. Новые места логина обязаны звать `invalidateMeCache()`.
- **nginx на проде сжимает проксированный JSON** — `gzip_proxied any` + `gzip_types application/json…` в `/etc/nginx/nginx.conf` (конфиг ВНЕ репо, правлен вручную 2026-08-02, бэкап nginx.conf.bak-2026-08-02). Без этого каталог летел 106 КБ вместо 12.6 КБ.
- **Никогда не импортируй значения из `html5-qrcode` в страницы** — value-импорт (даже enum) затягивает весь zxing (~300 КБ) в eager-бандл мимо `dynamic()`. Только `import type`; форматы сканера задаёт дефолт в `BarcodeScanner.tsx`.
- **Бэкап БД в деплое берёт путь из `DATABASE_URL`** — раньше был захардкожен `prisma/rental.db`, которого на проде нет (реальная база — `prod.db`), из-за чего бэкапы молча создавались пустыми. Теперь путь выводится из `.env` с учётом того, что относительный SQLite-путь Prisma резолвит от папки со схемой; отсутствие файла валит деплой, а не проходит тихо.
- **Task.dueDate — date-only semantics** — stored as Moscow-midnight UTC (`fromMoscowDateString()`), compared via `toMoscowDateString()`. Never compare raw Date objects — always compare the `YYYY-MM-DD` string in Moscow TZ.
- **Optimistic mutation pattern (Tasks)** — snapshot → apply → reconcile from server; per-id `useRef<Set<string>>` in-flight guard. `completeTask`: fire-immediately undo-via-reopen; toast action "Отменить" has 6 s window.
- **Task audit actions** — `TASK_CREATE / TASK_UPDATE / TASK_ASSIGN / TASK_COMPLETE / TASK_REOPEN / TASK_DELETE` written in same `$transaction` as mutation; `entityType: "Task"`. `TASK_ASSIGN` is a distinct action when `assignedTo` changes (for audit searchability).

## Групповые действия над бронями (мультивыбор на /bookings и /bookings/archive)

Чекбоксы в списке броней + липкая панель действий: `approve` (согласовать), `submit` (на согласование / «Подтвердить» при `APPROVAL_MODE=auto`), `cancel` (отменить), `archive` (в архив). В архиве (/bookings/archive) — свой мультивыбор с действиями `restore` (восстановить) и `purge` (удалить навсегда), оба только SUPER_ADMIN; для них «бронь не в архиве» — штатный побронный отказ 409 `BOOKING_NOT_ARCHIVED`, а не предусловие пачки. `purge` наследует финансовый гард (`PURGE_HAS_FINANCE`) побронно. Логика restore/purge вынесена в `services/bookingLifecycle.ts` (общая для одиночных `/:id/restore`, `/:id/purge` и bulk). Панель архива — отдельный `ArchiveBulkActionBar.tsx` (2 действия без правил применимости; вкручивать их в общий `BulkActionBar` значило бы тащить чужие действия в основной список). Групповой purge — typed-confirm «УДАЛИТЬ», как одиночный.

**`POST /api/bookings/bulk`** — объявлен **ДО** `/:id`-маршрутов (иначе express отдаст «bulk» в параметр `:id`, как и `/summary/counts`). Тело: `{ action, ids: string[] }` (1…`BULK_MAX_IDS` = 100). Ответ **всегда 200** с побронным результатом: `{ action, results: [{id, ok:true, status} | {id, ok:false, code, message}], counts: {total, ok, failed} }`. Ненулевой `failed` — штатный исход, а не ошибка запроса.

- **Каждая бронь обрабатывается изолированно**, общей транзакции нет: атомарность живёт внутри `approveBooking` / `submitForApproval` / `cancelBooking` / `archiveBooking`. Пачка из 30, где две конфликтуют по доступности, не должна откатывать остальные 28.
- **Обработка последовательная**, не `Promise.all`: SQLite пишет в один поток, параллельные транзакции дали бы `SQLITE_BUSY` вместо ускорения.
- **Гард двухслойный**: router-level `rolesGuard(["SUPER_ADMIN","WAREHOUSE"])` + `assertBulkActionAllowed(action, role)` в сервисе (`approve` и `archive` — только SUPER_ADMIN). Один router-guard этого не выразит, потому что действие лежит в теле запроса.
- **Оплаченную бронь пачкой не отменить** — 409 `BULK_CANCEL_PAID` даже для SUPER_ADMIN: депозит требует явного распоряжения (возврат / кредит-нота / удержание) через `CancelWithDepositModal` на карточке.
- **Выдача и возврат пачкой не даются вообще** — это физические операции, завязанные на сканирование, гард `ISSUE_TOO_EARLY` и приёмку с ремонтами.
- `submit` пачкой применим **только к DRAFT**: возврат `CONFIRMED → PENDING_APPROVAL` осмыслен поштучно, но пачкой это слишком лёгкий способ снять подтверждение с десятка активных броней.

**`services/bookingLifecycle.ts`** — `cancelBooking` и `archiveBooking` вынесены из `routes/bookings.ts` и теперь общие для одиночных маршрутов (`POST /:id/status {action:"cancel"}`, `DELETE /:id`) и bulk. Дублировать их транзакции ради bulk означало бы гарантированный дрейф освобождения юнитов и аудита между копиями.

**Фронтенд** (`src/components/bookings/`): `bulkActions.ts` — чистые правила применимости (зеркалят сервер; клиент не «решает» права, а лишь не предлагает заведомо невыполнимое); `useBookingSelection.ts` — `Set` выбора с подрезкой под текущий состав строк (смена фильтра выбрасывает пропавшие id, «Загрузить ещё» выбор сохраняет); `useBulkBookingActions.ts` — запрос и применение результата к отрисованному списку; `BulkActionBar.tsx`; `BulkResultModal.tsx` — отчёт показывается ТОЛЬКО при частичном успехе, полный успех — тост.

- Кнопка действия показывает **применимость** («Согласовать · 3 из 7») — честнее, чем прятать кнопку или молча пропускать неподходящие.
- После действия: успешные снимаются с выбора, **неуспешные остаются выбранными** — оператор видит, с чем разбираться. Строка убирается из списка, если `archive` ИЛИ активен фильтр по статусу и новый статус ему не соответствует.
- Панель — **`z-30`, не `z-40`**: на `z-40` живёт затемнение мобильного меню (`AppShell`), и панель как более поздний элемент в DOM торчала бы поверх скрима с кликабельными деструктивными кнопками. От плавающей кнопки «Сообщить» она разведена правым отступом (~148 px), а не слоем. На мобильном кнопки идут горизонтальной лентой со скроллом — перенос в столбик съедал пол-экрана.
- **Кнопка без подходящих броней остаётся кликабельной** и отвечает тостом с причиной: `title` на `disabled`-элементе браузеры не показывают, а на тач-устройствах его нет вовсе — молчаливая блокировка не объясняет ничего.
- **«Выбрать все» продублирован над карточками** (`md:hidden`): в таблице он живёт в шапке, скрытой на мобильном, и без дубля кладовщику пришлось бы делать 50 отдельных тапов.
- **Пустое состояние учитывает `nextCursor`** — групповое действие может вычистить всю загруженную страницу при живом курсоре; без этого список врал бы «Ничего не найдено», хотя под фильтр подпадают ещё десятки броней. Плюс `onRowsEmptied` догружает следующую страницу.
- `BULK_MAX_IDS` продублирован в `src/components/bookings/bulkLimits.ts` — клиент предупреждает о превышении ДО нажатия. При изменении править обе константы.

## Ночной режим (тема оформления)

Тема — это значения CSS-переменных, а не отдельный набор классов. Токены в `tailwind.config.js` объявлены как `rgb(var(--c-*) / <alpha-value>)`; значения живут в `apps/web/app/globals.css`: `:root` — светлая, `:root[data-theme="dark"]` — ночная. Переключение = смена `data-theme` на `<html>`, поэтому весь токенизированный UI меняет тему без правки компонентов.

- **Channel-формат обязателен** — `--c-ink: 9 9 11` (пробелы, без запятых). Только так работают opacity-модификаторы Tailwind (`bg-emerald-soft/30`). Запись через hex или `rgb(...)` их ломает.
- **Управление темой** — `apps/web/src/lib/theme.ts` (`useTheme`, состояния `light | dark | system`, ключ localStorage `lr:theme`, дефолт `light`) + `src/components/ThemeToggle.tsx` в сайдбаре `AppShell`. Анти-FOUC: инлайн-скрипт в `<head>` (`app/layout.tsx`) ставит `data-theme` до первого кадра; на `<html>` нужен `suppressHydrationWarning`.
- **Тёмная палитра — не инверсия**, а десатурированные тональные варианты: фон `--c-surface-muted: 15 19 27`, карточка `24 29 39`, `soft`-тинты становятся тёмными подложками, акценты осветляются.
- **Три токена НЕ инвертируются вместе с ink** — иначе намеренно тёмные элементы становятся белыми:
  - `inverse` / `on-inverse` — тёмная хромировка (шапка `/day`, активные пилюли, тёмные панели калькулятора, header `/repair/[id]`, `LkShell`);
  - `scrim` — подложка модалок (`bg-scrim/40…/85`), всегда тёмная;
  - `accent-chrome` — синяя брендовая шапка киоска склада (`WorkstationShell`), ночью уходит в глубокий синий, а не в яркий.
- **Белый текст на цветной заливке пишется как `text-surface`, не `text-white`** — в светлой теме `--c-surface` = белый (поведение прежнее), в ночной = почти чёрный, и надпись остаётся читаемой на осветлённой заливке (`bg-rose`, `bg-emerald`, `bg-accent-bright`…). `text-white` оставлен только там, где фон тёмный в обеих темах (сайдбар `bg-slate-900`, `bg-inverse`, `bg-accent-chrome`).
- **Числовые оттенки Tailwind (`bg-slate-900`, `text-slate-400`) темы не знают** — они остались только в намеренно тёмных сайдбаре/киоске. В остальном UI хардкод вычищен в токены; новые страницы обязаны использовать токены, иначе ночью останутся светлым пятном.
- **`color-scheme`** задан в обеих темах — от него зависит отрисовка нативных контролов (`<input type="date">`, скроллбары, `<select>`).

## UserRole и rolesGuard (Sprint 1)

### Система ролей

Три роли (enum `UserRole` в Prisma, был `AdminRole`):
- `SUPER_ADMIN` — полный доступ ко всем функциям (финансы, удаление, аудит, бэкдейт).
- `WAREHOUSE` — склад/кладовщик: брони (R/W), оборудование (создать, не менять цены), клиенты (R/W), сканирование.
- `TECHNICIAN` — техник: только чтение оборудования, мастерская (ремонты). Нет доступа к финансам и удалению.

Middleware `rolesGuard(allowed: UserRole[])` в `apps/api/src/middleware/rolesGuard.ts`:
- Если `req.botAccess === true` (бот-ключ openclaw-* прошёл botScopeGuard) → пропускает без проверки роли.
- Если `req.adminUser` отсутствует (валидный `X-API-Key` без JWT-сессии) → 401 `{ code: "UNAUTHENTICATED" }`.
- Если роль пользователя не в `allowed` → 403 `{ code: "FORBIDDEN_BY_ROLE" }`.

Все guarded-роуты требуют JWT-сессию (cookie `lr_session` или `Authorization: Bearer <token>`). API-ключ без сессии больше не проходит — тесты для guarded endpoints должны инжектить `signSession(...)` токен.

### Матрица прав (краткая)

| Маршрут | SUPER_ADMIN | WAREHOUSE | TECHNICIAN |
|---------|-------------|-----------|------------|
| GET /api/bookings | ✓ | ✓ | ✗ |
| POST/PATCH /api/bookings | ✓ | ✓ | ✗ |
| DELETE /api/bookings/:id | ✓ | ✗ | ✗ |
| PATCH /api/bookings/:id/backdate | ✓ | ✗ | ✗ |
| GET /api/equipment | ✓ | ✓ | ✓ |
| POST /api/equipment | ✓ | ✓ | ✗ |
| PATCH/DELETE /api/equipment | ✓ | ✗ | ✗ |
| GET /api/finance/* | ✓ | ✗ | ✗ |
| GET /api/dashboard | ✓ | ✓ | ✓ |
| GET /api/calendar | ✓ | ✓ | ✗ |
| /api/admin-users, /api/import-sessions, /api/pricelist | ✓ | ✗ | ✗ |
| GET /api/warehouse/workers | ✓ | ✓ | ✗ |
| POST/PATCH/DELETE /api/warehouse/workers | ✓ | ✓ | ✗ |
| GET /api/equipment/:id/units | ✓ | ✓ | ✓ |
| POST/PATCH/DELETE /api/equipment/:id/units | ✓ | ✓ | ✗ |
| GET /api/equipment-units, /api/equipment-units/lookup | ✓ | ✓ | ✓ |
| POST /api/equipment-units/labels | ✓ | ✓ | ✗ |
| POST /api/payments (с ограничениями) | ✓ | ✓* | ✗ |
| GET/PATCH/DELETE /api/payments | ✓ | ✗ | ✗ |
| GET /api/bookings/:id/invoice.pdf | ✓ | ✓ | ✗ |
| GET /api/bookings/:id/act.pdf | ✓ | ✓ | ✗ |

Примечание: `/api/warehouse/auth` и `/api/warehouse/workers/names` остаются публичными (без `rolesGuard`).

### WH-финансовые лимиты (Finance Phase 1)

*\* WAREHOUSE может создавать платежи только при соблюдении трёх условий (функция `validateWhLimits` в `paymentService.ts`):

| Условие | Ограничение |
|---------|-------------|
| Метод оплаты | Только `CASH` или `CARD` (не `BANK_TRANSFER`, не `OTHER`) |
| Сумма | ≤ 100 000 ₽ за один платёж |
| Статус брони | Только `ISSUED` или `RETURNED` |

Нарушение любого условия → `403 PAYMENT_LIMIT_EXCEEDED` с полем `details: { field, limit, actual }`.
SUPER_ADMIN обходит все лимиты.
Успешный WH-платёж записывает `PAYMENT_CREATE_BY_WH` в `AuditEntry` (вместо `PAYMENT_CREATE`).

### Аудит-сервис

`apps/api/src/services/audit.ts`:
- `writeAuditEntry(args)` — записывает событие в `AuditEntry`. Принимает `tx?` для транзакций.
- `diffFields(obj, maxBytes)` — очищает объект от вложенных relations (объекты с `id`), массивов. При > 10 KB усекает до примитивов.

`AuditEntityType` union включает: `"Booking"`, `"Payment"`, `"Expense"`, `"Unit"`, `"Client"`, `"Repair"`, `"AdminUser"`, `"EquipmentUnit"` (последнее добавлено для scan-session write-offs и статусных переходов unit).

Деструктивные операции с аудит-записью:
- `DELETE /api/bookings/:id` пишет `AuditEntry` внутри того же `prisma.$transaction`, что и сам delete.
- `POST/PATCH/DELETE /api/admin-users` — все три операции обёрнуты в `prisma.$transaction` вместе с `writeAuditEntry` для атомарного rollback.
- При удалении `AdminUser`, у которого есть связанные `AuditEntry` записи (Prisma FK Restrict), ловится `P2003` и возвращается `409 { code: "ADMIN_HAS_AUDIT_HISTORY" }` — не 500.

### Новые модели Prisma (Sprint 1)

- **`Repair`** — ремонтная карточка на `EquipmentUnit`. Поля: `unitId`, `status` (RepairStatus), `urgency` (RepairUrgency), `reason`, `sourceBookingId?`, `createdBy`, `assignedTo?`, `partsCost`, `totalTimeHours`, `closedAt?`.
- **`RepairWorkLog`** — запись работ по ремонту. Поля: `repairId`, `description`, `timeSpentHours`, `partCost`, `loggedBy`, `loggedAt`.
- **`AuditEntry`** — аудит-лог. Поля: `userId`, `action`, `entityType`, `entityId`, `before?` (JSON), `after?` (JSON).

Расширенные поля у существующих моделей:
- **`Payment`** — добавлены: `method?`, `receivedAt?`, `note?`, `createdBy?`.
- **`Expense`** — добавлены: `description?`, `documentUrl?`, `linkedRepairId?`, `approved` (boolean), `createdBy?`.

### Новые enum-значения

- **`BookingStatus.PENDING_APPROVAL`** — новый статус между DRAFT и CONFIRMED (для approval workflow Sprint 3+).
- **`ExpenseCategory`** — добавлены: `PAYROLL`, `PURCHASE`.
- **`RepairStatus`**: `WAITING_REPAIR`, `IN_REPAIR`, `WAITING_PARTS`, `CLOSED`, `WROTE_OFF`.
- **`RepairUrgency`**: `NOT_URGENT`, `NORMAL`, `URGENT`.

### Миграция AdminRole → UserRole

Скрипт: `apps/api/scripts/migrate-adminrole-to-userrole.ts`.
- Dry-run по умолчанию: `tsx scripts/migrate-adminrole-to-userrole.ts`.
- Реальная запись: `tsx scripts/migrate-adminrole-to-userrole.ts --execute`.
- Заменяет `RENTAL_ADMIN` → `WAREHOUSE`. `SUPER_ADMIN` остаётся.
- На prod перед deploy: `cp prod.db prod.db.$(date +%F).bak` затем запустить скрипт.

## Gaffer CRM вынесен из проекта (2026-08-19)

В репозитории жила вторая, заброшенная реализация Gaffer CRM: маршруты `/api/gaffer`,
страницы `/gaffer`, 6 моделей `Gaffer*` в общей схеме и свои токены оформления
`.gaffer-root`. Настоящий продукт всё это время работал отдельно — домен `gaffercrm.ru`,
приложение `/var/www/gaffer-crm`, своя база. Встроенная копия последний раз обновлялась
19.04.2026 и держала 6 таблиц в боевой базе проката.

Удалено полностью: код, модели, enum, стили, тесты, `GAFFER_SESSION_SECRET`, таблицы в
`prod.db`. Данные (2 пользователя, 7 проектов, 23 контакта, 25 участников, 11 платежей)
выгружены в `/root/gaffer-export-2026-08-19.json` на сервере — переносить их в живой
продукт владелец решил не нужным.

**Что НЕ является Gaffer CRM и трогать нельзя:** `parseGafferReview` в
`bookingRequestParser.ts`, слэнг гаффера в `equipmentMatcher.ts`, типы `GafferReview*`
в боте, роли `GAFFER`/`KEY_GRIP` в калькуляторе бригады. Здесь «гаффер» — профессия
(человек, который заказывает свет), а не удалённый суб-продукт.

## Закалка доступа (2026-09-01)

Три дыры, найденные аудитом «кто может зайти» (`docs/security/kto-mozhet-zaiti.md`).

- **Сид больше не заводит тривиальных паролей.** `deploy.sh` при каждом деплое запускал `scripts/seed-admin-users.ts`, а тот создавал `sechenoff/test`, `super/тест`, `admin/тест`. Скрипт идемпотентный, поэтому смену пароля он переживал — но не удаление: убранная учётка возвращалась с тем же паролем. Теперь автозапуска нет, пароль берётся из `ADMIN_USERNAME`/`ADMIN_PASSWORD` (не короче 12 символов), и скрипт работает только когда администраторов нет вовсе. `seed-system-user.ts` в деплое остался — `_system_` нужен для FK журнала аудита и войти под ним нельзя.
- **Киоск: PIN шестизначный, имя секретом не считается.** `warehousePublicRouter` перенесён за `apiKeyAuth` — это закрывает прямое обращение к Express на :4000, но НЕ защищает от интернета: `svetobazarent.ru/api/*` идёт через Next-прокси, а тот подставляет `X-API-Key` каждому запросу, включая анонимный. То есть ключ как гард для браузерных маршрутов не работает в принципе — это стоит помнить при любой похожей правке.
  Реальная защита — длина секрета. Имя сотрудника по смыслу показано на экране входа (иначе киоском нельзя пользоваться) и секретом не является. Секрет — PIN: было 4 цифры, 10 000 вариантов, при блокировке 5 попыток на 15 минут перебор занимал **21 день**. Стало 6 цифр, миллион вариантов — **около 6 лет** на сотрудника.
  Ужесточён ТОЛЬКО ввод нового PIN (`pinCreateSchema`), вход остался мягким (`pinLoginSchema`): иначе все, кому код выдали раньше, разом потеряли бы доступ к складу.
  Лимитер по IP сознательно НЕ добавлен: `trust proxy` не настроен и прокси не пробрасывает адрес, поэтому Express видит всех как `127.0.0.1`. Такой лимит был бы одним общим ведром и дал бы обратный эффект — один атакующий заблокировал бы вход всему складу.
- **Деактивация и смена роли действуют немедленно.** `sessionParser` доверял токену целиком, а тот живёт 7 дней: отключённый сотрудник дорабатывал неделю, а понижённый в роли всё это время оставался руководителем для API. Теперь `isActive` и `role` перечитываются из базы (кэш 30 c + явный сброс `invalidateAdminUserState` при PATCH/DELETE), и роль берётся из базы, а не из токена. Токен удалённого пользователя больше не значит ничего.

Побочно: тест `rolesGuardHolistic` использовал деактивированного SA с живым токеном как приём («единственный способ атаковать последнего активного SA») — этот путь закрыт, тесты переписаны на более строгую гарантию 401.

**Мины на жёстких датах.** Попутно протухли два теста с зашитыми датами: фикстура броней с `2026-09-01` (гард «выдача раньше срока» перестал срабатывать в этот день) и период каталога с `2026-08-20` (дата ушла в прошлое, попап признал период некорректным). Оба переведены на относительные даты. Правило: **в тестах не зашивать календарные даты** — считать от `Date.now()`.

## AI-разбор заявок: провайдеры LLM и импорт документа (2026-09-02)

Разбор заявки гаффера (`POST /api/bookings/parse-gaffer-review`) падал примерно в каждом
десятом запросе, а «страховочная» нога не сработала ни разу за всю историю логов. Три
причины, все разные:

- **ChatMock (подписка ChatGPT Plus через локальный прокси :8000)** — модель `gpt-5.4-mini`
  стала отвечать прозой («Сначала разберём…») вместо JSON; `response_format: json_object`
  прокси не соблюдает.
- **Нога `openai-api` никогда не доходила до api.openai.com.** `new OpenAI({ apiKey })` без
  `baseURL` — это не «прямой endpoint»: SDK сам читает `OPENAI_BASE_URL` из env, и обе ноги
  ходили в один и тот же ChatMock. Теперь `OpenAiLlmProvider` задаёт `baseURL` всегда
  (`OPENAI_DIRECT_BASE_URL` по умолчанию); регрессионный тест — в `llmFallback.test.ts`.
- **Оба sk-proj ключа (у API и у бота) мертвы** — api.openai.com отвечает 401. Даже с
  починенным baseURL нога не заработала бы.

Слой `apps/api/src/services/llm/`: ноги `anthropic` (Claude, основная), `gemini`, `openai`
(оно же историческое `chatmock` — через `OPENAI_BASE_URL`), `openai-api` (всегда прямой).
`LLM_PROVIDER=fallback` + `LLM_FALLBACK_CHAIN=anthropic,gemini` — боевая цепочка: следующая
нога берёт запрос, если предыдущая упала или не нашла ни одной позиции; не последние ноги
собираются с меньшим числом внутренних повторов (`failFast` в `buildLlmLeg`).

- **Claude отдаёт позиции structured output'ом** (`messages.parse` + `zodOutputFormat`; схемы
  на `zod/v4` — helper SDK не понимает v3-схемы, поэтому зависимость `zod` поднята до
  `^3.25`). Класс ошибок «проза вместо JSON» исчезает целиком. Модель `claude-opus-5`
  (`ANTHROPIC_MODEL`), `ANTHROPIC_EFFORT=low` — разбор списка приборов не требует
  рассуждений, `high` лишь дольше и дороже. `thinking` не задаём (на Opus 5 adaptive по
  умолчанию). Обрыв по `max_tokens` и `stop_reason=refusal` — исключение ноги, а не «пустая
  заявка». Server-side `fallbacks` Anthropic не включены осознанно: страховка живёт в
  `FallbackLlmProvider` (Gemini), а списку приборов классификатору отказывать не в чем.
- **Документы (PDF/JPEG/PNG/WEBP) читают только ноги со зрением** — `anthropic`
  (document/image-блоки) и `gemini` (`inlineData`); `openai` — только текст.
  `FallbackLlmProvider.extractGafferDocument` слепые ноги пропускает молча, а без единой
  зрячей отвечает ошибкой конфигурации.
- **Прод сейчас на `LLM_PROVIDER=gemini`** (временная заплатка 2026-09-02, бэкап
  `apps/api/.env.bak-2026-09-02-llm` на сервере): ключ Gemini живой, Anthropic-ключа на
  сервере нет. После добавления `ANTHROPIC_API_KEY` в `apps/api/.env` →
  `LLM_PROVIDER=fallback`, `LLM_FALLBACK_CHAIN=anthropic,gemini`, `pm2 restart api`.
  ChatMock (`go-chatmock serve`, вне pm2) после этого не нужен.

**Импорт заявки-документом** — `POST /api/bookings/parse-gaffer-document` (multipart, поле
`file`, ≤ 10 МБ, SA + WAREHOUSE): модель читает позиции и шапку (проект, имя / телефон /
почта / telegram гаффера, даты), позиции матчатся с каталогом тем же `matchLinesToItems`,
что и текст; ответ `{ items, document, client }`. Сервис — `services/gafferDocumentImport.ts`.

- **Сигнатуры файлов проверяются** (`%PDF`, `FF D8 FF`, `89 PNG`, `RIFF…WEBP`) — MIME из
  запроса подделать тривиально; тот же паттерн, что в `expenses.ts`.
- **Клиент подбирается по телефону (последние 10 цифр), потом по почте, потом по имени — и по
  имени только при единственном совпадении** («Белых Геннадий» ↔ «Гена Белых» — один человек;
  два «Иванова» — вопрос к менеджеру, `client: null`). Токены имени — от четырёх букв.
- **Имя файла из multipart** приходит через busboy как latin1 — `decodeOriginalName`
  перекодирует только если в строке нет символов выше U+00FF; настоящая кириллица не трогается.
- **UI** — вторая зона в `AiRequestModal` («Загрузить заявку файлом — PDF или фото», drag &
  drop). `BookingForm.handleImportDocument` → `applyImportedDocument`: клиент из базы или
  новый с телефоном из шапки (не в режиме правки), проект, даты (`T10:00`, как у быстрой
  брони; возврат — из `endDate` или авто +24 ч), позиции — в ту же панель подтверждения
  `ReviewPanel` (`showReviewItems`, общий с текстовым разбором). Пустое поле в документе
  ничего не перетирает.

## Known Issues

1. **~~No authentication~~** — RESOLVED: `apiKeyAuth` middleware enforces `X-API-Key` header (`AUTH_MODE=warn|enforce`).
2. **~~Crew calculator duplication~~** — RESOLVED: extracted to `packages/shared` (`@light-rental/shared`).
3. **~~Minimal test coverage~~** — RESOLVED: 478 tests across shared, bot (booking-helpers), API smoke, barcode integration, importSession, competitorMatcher, importSession routes, dashboard, calendar, calendarUtils, rolesGuard holistic, approval tests. Plus 4 web component tests (ApprovalTimeline) via vitest + jsdom.
4. **~~Hardcoded aliases~~** — RESOLVED: TYPE_SYNONYMS migrated to SlangAlias DB table, auto-learning enabled.
5. **Production `web` PM2 process unstable** — investigate 8646+ restarts, likely needs `npm run build` in deploy.
6. **`npm run lint` fails on main** — ESLint v9 expects `eslint.config.(js|mjs|cjs)` but the repo has `.eslintrc.json`. Pre-existing, unrelated to feature work. Fix before any lint-gated CI. **STILL OPEN** — not fixed by the Warehouse Scan Redesign. Working path для проверки фронта: `cd apps/web && npx next lint --dir <dir>` (Next бандлит ESLint 8, чтит repo-config). Для api eslint-пути нет из-за v9 — полагаемся на `tsc --noEmit` (clean).
7. **Old warehouse-scan UI assumptions superseded** — Key Files row для `apps/web/app/warehouse/scan/page.tsx` («5-step scan wizard») и раздел «Sprint 4 → Сканирование возврата с поломкой» (`brokenUnits`) устарели. См. раздел «Warehouse Scan Redesign» — kiosk перестроен в adaptive-shell, `complete` принимает `repairUnits` + `problemUnits` (не `brokenUnits`).
8. **Telegram-бот (`apps/bot`) фактически мёртв с июня 2026** — три независимые причины: (1) его `OPENAI_API_KEY` (sk-proj) отвергается api.openai.com (401) — падают `parseDates`, `parseCatalogIntent`, `validateBookingSummary` в `apps/bot/src/services/llm.ts`, которые ходят в OpenAI напрямую, минуя `services/llm` API; (2) `API_KEY` бота отсутствует в `API_KEYS` API (`AUTH_MODE=enforce` → 401 на любой запрос); (3) `/api/bookings/parse-gaffer-review` под `rolesGuard(SA, WAREHOUSE)` требует JWT-сессию, а ключ бота не с префиксом `openclaw-`, и `botScopeGuard` его не пропускает. Последний старт бота — 04.06.2026. Решение владельца: чинить (перевести дату/intent на API-эндпоинты, ключ `openclaw-*` + whitelist) или выключить процесс `rental-bot` в pm2.

## Sprint 2: Navigation, Design Canon & Audit UI

### Дизайн-система (Sprint 2)

IBM Plex Sans/Condensed/Mono шрифты через Google Fonts. Tailwind tokens: `ink`, `surface`, `border`, `accent`, `teal`, `amber`, `rose`, `indigo`, `slate`, `emerald`, `ok`, `warn`. Legacy `brand-*` palette удалена — используй `accent-*`. Документация: `docs/design-system.md`.

CSS-утилиты: `.eyebrow` (надстрочники), `.mono-num` (числа в таблицах).

### Роутинг и навигация (Sprint 2)

- **`/`** — редирект на `/day` (server component `redirect()`).
- **`/day`** — «Мой день», роль-зависимый контент (`DaySuperAdmin` / `DayWarehouse` / `DayTechnician`).
- **`/admin/audit`** — журнал аудита, только `SUPER_ADMIN`. Фильтры: entityType, userId, from/to. Курсорная пагинация. Expandable JSON diff (before/after).

### Компоненты (Sprint 2)

- **`src/components/RoleBadge.tsx`** — бейдж роли: `SUPER_ADMIN` = indigo («Руководитель»), `WAREHOUSE` = teal («Кладовщик»), `TECHNICIAN` = amber («Техник»).
- **`src/components/ToastProvider.tsx`** — in-house toast (без зависимостей). `toast.error/success/info(msg)`. Монтируется в `app/layout.tsx`.
- **`src/hooks/useRequireRole.ts`** — хук: редирект на `/login` (не авторизован) или `/day` (нет роли) + `toast.error`.
- **`src/hooks/useCurrentUser.ts`** — re-export из `src/lib/auth`.
- **`src/lib/roleMatrix.ts`** — `menuByRole: Record<UserRole, MenuItem[]>` с навигацией по ролям.
- **AppShell** — перестроен на `menuByRole[user.role]`. Loading skeleton при загрузке.

### API /api/audit (Sprint 2)

`GET /api/audit` — SUPER_ADMIN only. Query: `entityType`, `entityId`, `userId`, `from` (ISO), `to` (ISO), `limit` (1–200, default 50), `cursor` (keyset). Response: `{ items: AuditEntry[], nextCursor: string | null }`. Файл: `apps/api/src/routes/audit.ts`. `entityId` добавлен 2026-08-05: раньше параметр молча игнорировался, и `ApprovalTimeline` на карточке брони показывал историю согласования ВСЕХ броней.

## Мастерская v2 (раздел «Ремонты», 2026-08)

Раздел перестроен с плоского списка на экран, отвечающий на один вопрос: **что горит**.
Мокапы — `docs/mockups/repair-v2/` (`final-desktop`, `final-card`, `final-add-repair`, `final-mobile`),
они источник правды по вёрстке и формулировкам.

- **Сломанное больше не продаётся.** До этого в `availability.ts` слова `Repair` не было вообще: из наличия вычитались только «потеряшки», и календарь, проверка доступности, добор на складе и чек-лист выдачи продолжали предлагать то, что лежит в мастерской. Теперь `getRepairCountByEquipmentMap()` (там же, зеркалит `getLostCountByEquipmentMap`) вычитается во всех трёх расчётах. Считает **только ремонты без `unitId`**: штучные уже выпали через `EquipmentUnit.status = MAINTENANCE`, и учесть их здесь значило бы вычесть прибор дважды. Позиция берётся с `Repair.equipmentId`, а если пусто — через `bookingItem.equipmentId`. Активный ремонт — любой статус, кроме `CLOSED`/`WROTE_OFF`.
- **Риск — три состояния, а не флажок.** `BLOCKS` (подмены нет и к сроку брони не успеваем) / `TIGHT` (подмены нет, но успеваем — пишем запас в днях) / `COVERED` (остальных единиц хватает) / `NONE`. Экран, который кричит одинаково про то, что горит, и про то, что успевает, перестают читать через неделю. Блокирующие статусы броней — из общей `BLOCKING_STATUSES`, не хардкод; считается и для позиций без штучного учёта (раньше гард `r.unit` их пропускал).
- **Название в три ступени:** `unit.equipment.name` → `bookingItem.equipment.name` → `equipment.name` → «Позиция удалена из каталога», плюс `titleSource` для метки «название из каталога». До этого поломки на позициях без штучного учёта (кабели, зарядки) приезжали как «Без позиции», а на `/day` техника роняли весь первый экран: тип `unit` был объявлен non-nullable и разыменовывался напрямую.
- **`Repair.expectedReadyAt` / `partsNote`** — срок возврата и чего ждём. `null` — **валидное** состояние «срок не назначен», а не забытое поле: выдуманный прогноз хуже честного пробела, по нему начнут планировать съёмку (та же логика, что у `Vehicle.serviceIntervalKm`). В UI «Ждём» подставляет интерфейс — в `partsNote` пишется только предмет («разъём Neutrik NL4»).
- **Новые ручки:** `POST /api/repairs` (SA + WAREHOUSE + TECHNICIAN) — завести поломку прямо из раздела, когда сломанное нашли вне приёмки; занятая единица → 409 `REPAIR_ACTIVE_EXISTS`. Конфликт с бронью **не блокирует** создание — прибор сломан по факту, а не по учёту; сервер возвращает `risk`, UI предупреждает. `PATCH /api/repairs/:id/eta` — назначить/сдвинуть срок.
- **Первая запись работ в статусе «Ждёт ремонта» сама берёт ремонт в работу** — раньше фронт форму показывал, а сервер отвечал 400, и человек получал отказ на заполненную форму.
- **`GET /api/dashboard/repair-stats`** расширен: `atRiskCount`, `quietCount`, `noEtaCount`, `spentPrevMonth` (база сравнения — голое «потрачено 46 800 ₽» ни о чём не говорит), `pendingExpenses` (расход техника остаётся неутверждённым, а KPI считал только утверждённые — владелец видел заниженную сумму), `readyForPickup`. Денежные поля — только `SUPER_ADMIN`, остальным `null`.
- **«Вернулось из ремонта»** живёт на экране «Смена» рабочего стола кладовщика, а не в разделе «Ремонты»: закрытые за 7 дней ремонты физически лежат в мастерской, и раньше за прибором бежали в последний момент на выдаче.
- **`text-white` в `RepairPhotoStrip`** — задокументированное исключение: полноэкранный просмотр фото на `bg-scrim`, тёмном в обеих темах.

## Sprint 4: Repair Workflow

### Жизненный цикл ремонта

Статусы: `WAITING_REPAIR` → `IN_REPAIR` (после назначения) ↔ `WAITING_PARTS` → `CLOSED` (или `WROTE_OFF`).

Статус unit при ремонте:
- При создании Repair: unit.status → `MAINTENANCE`
- При closeRepair: unit.status → `AVAILABLE`
- При writeOffRepair: unit.status → `RETIRED`

### Маршруты /api/repairs

| Маршрут | Роли | Действие |
|---------|------|----------|
| GET /api/repairs | SA, WH, TECH | Список с фильтрами (status, unitId, assignedTo, urgency) |
| POST /api/repairs | SA, WH, TECH | Создать ремонт (unitId, reason, urgency, sourceBookingId?) |
| GET /api/repairs/:id | SA, WH, TECH | Детали + workLog |
| POST /api/repairs/:id/work-log | SA, TECH | Записать работы (только assignedTo или SA) |
| PATCH /api/repairs/:id/status | SA, TECH | Сменить статус (IN_REPAIR/WAITING_PARTS) |
| POST /api/repairs/:id/assign | SA, TECH | TECH только self-assign |
| POST /api/repairs/:id/close | SA, TECH | Закрыть ремонт |
| POST /api/repairs/:id/write-off | SA | Списать единицу |

Сервис: `apps/api/src/services/repairService.ts`. Все функции используют `prisma.$transaction` и `writeAuditEntry`.

### Сканирование возврата с поломкой

> **СУПЕРСЕДЕД разделом «Warehouse Scan Redesign» ниже.** Контракт `complete` изменён: `brokenUnits` УДАЛЁН, заменён на `repairUnits` + `problemUnits`. Описание ниже сохранено для истории.

`POST /api/warehouse/sessions/:id/complete` ранее принимал опциональный `brokenUnits: Array<{ equipmentUnitId, reason, urgency }>`. После завершения транзакции возврата для каждой broken unit вызывался `createRepair({ ..., sourceBookingId: session.bookingId })`.

### Frontend

- `/repair` — `apps/web/app/repair/page.tsx`. Kanban-board: 4 колонки (WAITING_REPAIR/IN_REPAIR/WAITING_PARTS/CLOSED). Фильтры: "Моя очередь" / urgency pills.
- `/repair/[id]` — `apps/web/app/repair/[id]/page.tsx`. Детали + журнал работ + кнопки по роли (взять, добавить работы, закрыть, списать). Модалка расхода при закрытии.
- `/warehouse/scan` (СУПЕРСЕДЕД редизайном — см. ниже): ранее на шаге итога возврата каждая единица имела кнопку "🔧 Поломка" → модалка reason+urgency → `brokenUnits` в payload. Теперь — `RepairPanel`/`ProblemPanel` per-unit, payload `repairUnits` + `problemUnits`.
- `/day` → `DayTechnician`: подгружает ремонты (`assignedTo=currentUser`), SLA просрочки (IN_REPAIR > 5 дней). `DayWarehouse`: показывает счётчик открытых ремонтов.

### CurrentUser + userId

`src/lib/auth.ts` — `CurrentUser.userId` (опциональное поле) теперь синхронизируется из `/api/auth/me`. Используется для фильтрации ремонтов по назначенному технику.

## Sprint 5: Design Canon Repaint

Рескин существующих страниц до IBM Plex Canon. Миграция завершена.

Канонический reference: `docs/design-system.md`.

### Новые общие компоненты

- **`src/components/StatusPill.tsx`** — универсальный статусный бейдж. Props: `{ variant: "full" | "edit" | "view" | "limited" | "own" | "none" | "ok" | "warn" | "info" | "alert", label: string, className?: string }`. Заменяет удалённый `StatusBadge.tsx`. Variant `alert` = `bg-rose-soft text-rose border-rose-border` (для MISSING unit status и деструктивных сигналов).
- **`src/components/SectionHeader.tsx`** — заголовок секции с eyebrow и optional actions. Props: `{ eyebrow?: string, title: string, actions?: ReactNode, className?: string }`.

### Страницы рескина

- `/bookings` — SectionHeader, StatusPill, mono-num для сумм, accent-bright на кнопку.
- `/bookings/[id]` — карточки-секции, StatusPill для статусов, token-цвета.
- `/equipment` — StatusPill для доступности, accent-bright, token-классы.
- `/equipment/[id]/units` — StatusPill для UnitStatus, барткод de-emphasize (`text-xs text-ink-3 font-mono`).
- `/calendar` — semantic token colors для ячеек (emerald/amber/rose-soft), accent-soft для today.
- `/login` — max-w-[360px], bg-accent, accent-bright primary button.
- `/admin` — eyebrow tabs, border-border, shadow-xs.
- `/warehouse/scan` — токенизация цветов, accent-bright для primary action.
- `DashboardOpsCard`, `QuickAvailabilityCheck`, `CalendarTooltip` — токенизация.

### Аудит (после Sprint 5)

- `style={{` в `apps/web/`: 5 штук — все в `finance/` (SVG-bars, dynamic category-color dots). Вне scope Sprint 5.
- Hex в `apps/web/app` и `apps/web/src`: 0 вне `finance/`.

## Финальный холистический фикс (после Sprint 5)

По итогам финального холистического ревью закрыто 2 CRITICAL + 12 HIGH + 4 MEDIUM нарушения.

**Privilege escalation (CRITICAL).** Маршруты `/api/warehouse/workers/*` не имели `rolesGuard` вообще — любой аутентифицированный пользователь мог создавать, изменять и удалять складских работников. Маршруты `/api/equipment/:id/units/*` защищал wrapper, который ошибочно пропускал TECHNICIAN на write-операции. Оба пробела закрыты добавлением `rolesGuard([SUPER_ADMIN, WAREHOUSE])` на соответствующие роуты.

**Хардкод ролей и seed (HIGH).** В `/admin` вкладка «Пользователи» отображала только `RENTAL_ADMIN` — устаревший enum. Заменено на helper `roleLabel()` со всеми тремя ролями (`SUPER_ADMIN` / `WAREHOUSE` / `TECHNICIAN`) и русскими подписями. Seed `admin/тест` теперь создаётся с ролью `WAREHOUSE` вместо несуществующего значения.

**TypeScript (HIGH).** Исправлены 3 ошибки `tsc --noEmit`: неверный тип `Prisma.TransactionClient` в `bookings.ts`, отсутствующее значение `"EquipmentUnit"` в union `AuditEntityType`, неполный тип возврата `getReconciliationPreview` (добавлены `createdRepairIds` и `failedBrokenUnits`).

**Навигация и аудит (HIGH/MEDIUM).** Страница `/clients` удалена из меню всех ролей (роут не существовал). В меню `SUPER_ADMIN` и `WAREHOUSE` добавлен `/calendar`; в меню `WAREHOUSE` добавлен `/repair`. Деструктивные операции `DELETE /api/bookings/:id` и весь CRUD `/api/admin-users` теперь пишут `AuditEntry` в той же транзакции (подробности — в разделе «Аудит-сервис» выше). Редирект после логина изменён с несуществующего `/dashboard` на `/day`.

## Day Enrichment (Subproject A)

«Мой день» `/day` доведён до уровня мокапа `docs/mockups/my-day-all-roles.html`: роль-специфичный первый экран, который пользователь видит после логина.

### Компоненты и композиция

Страница `apps/web/app/day/page.tsx` выбирает один из трёх роль-специфичных компонентов (`DaySuperAdmin` / `DayWarehouse` / `DayTechnician`). Общая структура у всех трёх:

1. `DayHeader` — тёмная шапка с приветствием (`доброе утро, Имя 👋`), русской датой и правым саммари (состав зависит от роли).
2. Опциональный `DayAlert` (rose или amber) — например, «N броней на согласовании» для SA/WAREHOUSE, «N новых поломок» для TECH.
3. KPI-сетка из `DayKpiCard` (для SA) или структурированные карточки (для WAREHOUSE/TECH).
4. `DayOperationsList` (в нём `formatHM` для HH:MM + shared `pluralize` для позиций) — общий для SA и WAREHOUSE.
5. `DayFooterMetrics` — нижняя строка-сводка с dashed-top-border.

### API endpoints

- `GET /api/dashboard/pending-approvals` — список броней в статусе `PENDING_APPROVAL` для алерта. **Inline `rolesGuard(["SUPER_ADMIN", "WAREHOUSE"])`** — router-level guard допускает все три роли (нужен для `/today` и `/repair-stats`), но `/pending-approvals` возвращает `finalAmount`, поэтому TECHNICIAN → 403. Интеграционный тест `apps/api/src/__tests__/dashboard.test.ts` это фиксирует.
- `GET /api/dashboard/repair-stats` — агрегаты мастерской: `openCount`, `newCount` (= WAITING_REPAIR), `closedThisMonth`, `writtenOffThisMonth`, `spentThisMonth` (сумма approved-расходов с `linkedRepairId` за текущий месяц).
- `GET /api/dashboard/today` — теперь возвращает `finalAmount` на каждой брони (было только `itemCount`).

### Роли — что в шапке и футере

| Роль | Шапка (summary справа) | Алерт | KPI/контент | Footer |
|------|------------------------|-------|-------------|--------|
| SUPER_ADMIN | `Сегодня N операций · в апреле X ₽` | amber «N броней на согласовании» (linkHref=`/bookings?status=PENDING_APPROVAL`) | 3 KPI: Сегодня (revenue), Долги, Ремонт | Месячная выручка + Δ% к прошлому месяцу |
| WAREHOUSE | `N выдач · M возвратов` | amber «N броней ждут у руководителя» | 2 карточки: 📤 Выдачи + 📥 Возвраты | Счётчик ожидающих согласования (`N броней ждут`) |
| TECHNICIAN | `N новых поломок · M в работе` | rose «Новые поломки — требуют оценки» с кнопками «Взять» / «Списать» | Карточка «🛠 В работе» со SLA-подписями (`просрочено SLA` ≥ 5 дней в IN_REPAIR) | Месячные агрегаты: починено, списано, в работе, потрачено ≈ |

### Shared helpers в `format.ts`

- `pluralize(n, one, few, many)` — русская плюрализация (1 → one, 2-4 → few, 5+/11-14 → many). Используется везде: позиции, выдачи, возвраты, брони, поломки.
- `MONTHS_LOCATIVE[0..11]` — русские названия месяцев в предложном падеже (`январе`, `феврале`, …), индекс совместим с `Date#getMonth()`. Используется в `в апреле`.

### Технические нюансы

- Все три `useEffect` в `/day` используют паттерн `let cancelled = false; ... return () => { cancelled = true; }` — защита от state-updates после unmount.
- `DayTechnician` гейтит вызов `/api/repairs?assignedTo=<userId>`: если `userId` пустой (старые сессии без связки на AdminUser), сразу показывается «Свободная очередь».
- Шапка `DayTechnician.summary` гейтится на `newRepairs !== null && myRepairs !== null`, а не на `stats` — чтобы не показать ложный «0 новых», пока списки ремонтов ещё загружаются.

## Booking Approval Workflow (Subproject B)

Двухэтапный процесс согласования броней: `WAREHOUSE` создаёт DRAFT и отправляет на согласование → `SUPER_ADMIN` одобряет или отклоняет с обязательной причиной. Редактирование брони заблокировано в `PENDING_APPROVAL`. Все переходы пишутся в `AuditEntry`. Реализовано в PR #51.

### Жизненный цикл

```
DRAFT ──submit-for-approval──▶ PENDING_APPROVAL ──approve──▶ CONFIRMED
  ▲                                    │
  │                                    └────reject──▶ DRAFT (+ rejectionReason)
  │                                                        │
  └──── возврат после правок, цикл повторяется ◀──────────┘
```

### Маршруты /api/bookings (новые, Sprint B)

| Маршрут | Роли | Переход | Поведение |
|---------|------|---------|-----------|
| POST `/:id/submit-for-approval` | SA + WH | DRAFT → PENDING_APPROVAL | Очищает предыдущий `rejectionReason`; аудит `BOOKING_SUBMITTED` внутри транзакции |
| POST `/:id/approve` | SA only | PENDING_APPROVAL → CONFIRMED | Делегирует в `confirmBooking()` — восстанавливает проверку доступности, резервирование юнитов, снапшот сметы; затем `recomputeBookingFinance` + `createFinanceEvent({eventType:"BOOKING_CONFIRMED", via:"approve"})`; аудит `BOOKING_APPROVED` (вне tx confirmBooking, осознанный trade-off) |
| POST `/:id/reject` | SA only | PENDING_APPROVAL → DRAFT | Требует `reason` (Zod `min(3)` после trim); сохраняет `rejectionReason`; аудит `BOOKING_REJECTED` с причиной в `after` |

Поведенческие изменения на существующих маршрутах:
- `allowedActionsByStatus.DRAFT` больше **не включает** `"confirm"` — закрыт легаси-bypass, когда WAREHOUSE мог флипнуть DRAFT→CONFIRMED через `POST /:id/status {action:"confirm"}`, полностью обходя согласование. Добавлена запись `PENDING_APPROVAL: ["cancel"]` (отмена разрешена из любого не-терминального статуса).
- `PATCH /:id` возвращает 409 `BOOKING_EDIT_FORBIDDEN` при `status === "PENDING_APPROVAL"` — защищает submitted-состояние от мутаций.
- `GET /api/bookings` валидирует `?status=` через Zod-enum (`bookingStatusEnum`). Мусорное значение → 400 `INVALID_STATUS_FILTER`.

### Prisma schema

`Booking.rejectionReason String?` — хранит последнюю причину отклонения. Очищается на новом `submit-for-approval`. Не очищается на `approve`/`cancel` (осознанный trade-off: UI показывает `rejectionReason` только когда `status === "DRAFT"`, поэтому stale-значение в БД не видно пользователю).

### Frontend

- `/bookings` — фильтр `PENDING_APPROVAL` в dropdown, `statusFilter` инициализируется из `?status=` URL-параметра (`useSearchParams` + обязательный Suspense boundary для Next.js 14), фильтр передаётся на сервер как `?status=` в API-запросе. DRAFT variant: `"view"` (унификация с `/bookings/[id]`). Кнопка «Подтвердить» на DRAFT удалена (была частью легаси-bypass).
- `/bookings/[id]` — условные кнопки по роли и статусу:
  - WAREHOUSE + DRAFT → «Отправить на согласование»
  - SUPER_ADMIN + PENDING_APPROVAL → «Одобрить» + «Отклонить»
  - Баннеры: rose с причиной отклонения на DRAFT (если `rejectionReason` есть), amber info-баннер «Бронь на согласовании у руководителя» на PENDING_APPROVAL.
- `RejectBookingModal` — обязательная причина (min 3 trimmed символа), счётчик, Esc/backdrop-закрытие, auto-focus textarea, disabled во время отправки. `handleReject` только re-throw — модалка сама показывает ошибку через `toast.error`, чтобы не было дубликата.

### Аудит

Все три перехода пишут `AuditEntry` с `entityType: "Booking"`:

| Action | userId | before | after |
|--------|--------|--------|-------|
| `BOOKING_SUBMITTED` | кто нажал submit | `{status: "DRAFT"}` | `{status: "PENDING_APPROVAL"}` |
| `BOOKING_APPROVED` | кто одобрил | `{status: "PENDING_APPROVAL"}` | `{status: confirmed.status, confirmedAt}` |
| `BOOKING_REJECTED` | кто отклонил | `{status: "PENDING_APPROVAL"}` | `{status: "DRAFT", rejectionReason}` |

Просмотр истории согласования — через существующий `/admin/audit` (фильтр `entityType=Booking`).

### Технические нюансы

- `approveBooking` делает pre-check через `prisma.booking.findUnique` (select: `id`, `status`) и валидирует `status === "PENDING_APPROVAL"` до делегации в `confirmBooking()`. Pre-check нужен, потому что `confirmBooking` не знает про approval-статус и не отличит `DRAFT→CONFIRMED` от `PENDING_APPROVAL→CONFIRMED`.
- `BOOKING_APPROVED` аудит пишется **вне** транзакции `confirmBooking` — осознанный trade-off: аудит это observability, не бизнес-инвариант. Консистентно с другими операциями в кодбейзе.
- `rejectBooking` использует `prisma.$transaction` для атомарности status+rejectionReason+audit.
- Интеграционные тесты (`approval.test.ts`, 22 шт.) следуют паттерну `dashboard.test.ts`: изолированная SQLite БД через `TEST_DB_PATH`, `prisma db push --force-reset`, `signSession()` токены для WAREHOUSE/SUPER_ADMIN/TECHNICIAN. Покрывают: все успешные переходы, rolesGuard-ошибки, пустой/пробельный reason → 400, невалидный статус брони → 409 `INVALID_BOOKING_STATE`, PATCH в PENDING_APPROVAL → 409, полный цикл reject→resubmit→approve с проверкой очистки `rejectionReason`, регрессию на легаси confirm-bypass (DRAFT + `/status {action:"confirm"}` → 409).

## Cosmetic Polish (Subproject D)

UI-only canon repaint + ApprovalTimeline + accessibility. Реализовано в PR #52. Ноль изменений в schema/API/бизнес-логике.

### Страницы рескина (доводка)

6 страниц перекрашены в IBM Plex canon с заменой оставшихся hex/slate/blue на семантические токены (`ink / surface / border / accent / rose / amber / emerald / teal / indigo / slate` с суффиксами `-soft / -border / -bright`):
- `/calendar` — semantic token colors для ячеек и шапки.
- `/bookings/new` — категорийная палитра расширена до 7 уникальных канон-оттенков (было 15 слотов, 6 уникальных тинтов, 9 коллизий). `getCategoryColorClass()` → `hash % 7` по массиву `CATEGORY_PASTEL_CLASSES`.
- `/bookings/[id]/edit` — form-field palette на токены.
- `/repair` — urgency badges + skeleton loaders.
- `/admin` — tabs, tables, modals, buttons.
- `/admin/scanner` — `LookupCard` мигрирован с ad-hoc `STATUS_COLORS` map + raw `<span>` на `<StatusPill>` с variant-маппингом: `AVAILABLE→ok`, `ISSUED→info`, `MAINTENANCE→warn`, `RETIRED→none`, `MISSING→alert`.

### ApprovalTimeline

`apps/web/src/components/bookings/ApprovalTimeline.tsx` — read-only хронология согласования на `/bookings/[id]`. Только для `SUPER_ADMIN`.

- Default-collapsed `<details>` с заголовком «История согласования».
- Потребляет существующий `GET /api/audit?entityType=Booking&entityId=<id>` (Sprint 2 endpoint, SUPER_ADMIN-only rolesGuard).
- Фильтрует поток аудита до `BOOKING_SUBMITTED` / `BOOKING_APPROVED` / `BOOKING_REJECTED`.
- Reverse-chronological sort через ISO-safe `a.createdAt.localeCompare(b.createdAt)`.
- Defensive 403 handling (для не-SUPER_ADMIN — тихий no-render без ошибки).
- `cancelled`-flag cleanup pattern для предотвращения post-unmount state updates.
- Тесты: `apps/web/src/components/bookings/__tests__/ApprovalTimeline.test.tsx` (4 теста: default-collapsed рендер, фильтрация non-approval записей, обработка 403, отображение причины отклонения). Runner: vitest 4.1.2 + jsdom 29 + @testing-library/react 16.

### Accessibility

`aria-label` добавлены на все icon-only кнопки по всем страницам и компонентам (модалки: close, inline actions: delete/sort/expand). Русскоязычные метки.

### Новый variant StatusPill

`alert` — `bg-rose-soft text-rose border-rose-border`. Для деструктивных/критических статусов (MISSING unit). Дополняет существующие 9 вариантов (full/edit/view/limited/own/none/ok/warn/info). Добавлен в Sprint D как 10-й variant.

### Web test harness

Добавлены devDependencies в `apps/web/package.json`: `vitest`, `jsdom`, `@testing-library/react`, `@testing-library/dom`, `@testing-library/jest-dom`, `@vitejs/plugin-react`. Конфигурация: `apps/web/vitest.config.ts`, setup: `apps/web/src/test-setup.ts`. Команда: `npm --workspace=apps/web run test`.

## Tasks Feature (Sprint 3)

Операционный список задач для команды из 3–5 человек: быстрый захват, группировка по сроку, виджет на «Мой день».

### Data model

Prisma model `Task` (новый):
- `status: TaskStatus` — enum `OPEN | DONE`
- `urgent: Boolean` — срочный флаг
- `dueDate: DateTime?` — date-only семантика; хранится как Москва-полночь UTC
- `createdBy / assignedTo / completedBy: String?` — `AdminUser.id` без FK (как в `Repair`)
- `completedAt: DateTime?`
- `AuditEntityType` расширен значением `"Task"`

### Маршруты

- `/tasks` — главный список (`TasksPage.tsx`)
- `/tasks/history` — история выполненных (`TaskHistoryPage.tsx`)
- `DayTasksWidget` смонтирован в `DaySuperAdmin`, `DayWarehouse`, `DayTechnician` в `apps/web/app/day/page.tsx` (выше роль-специфичных KPI, ниже `DayAlert`)

### API endpoints

| Маршрут | Метод | Описание |
|---------|-------|----------|
| `/api/tasks` | GET | Список задач; query: `filter` (my/all/created-by-me), `status`, `cursor`, `limit` |
| `/api/tasks` | POST | Создать задачу (все роли) |
| `/api/tasks/:id` | PATCH | Обновить (creator или SA — контент; assignee — только `urgent`) |
| `/api/tasks/:id` | DELETE | Удалить (creator или SA → 403 `TASK_DELETE_FORBIDDEN` иначе) |
| `/api/tasks/:id/complete` | POST | Выполнить (идемпотентно; любая роль) |
| `/api/tasks/:id/reopen` | POST | Вернуть в работу (идемпотентно) |
| `/api/dashboard/task-stats` | GET | `{myOpen, myOverdue, myToday, myUrgent}` для текущего пользователя |
| `/api/dashboard/today` | GET | Включает `myTasks: TaskSummary[]` (до 5, overdue∪today∪urgent-undated) |
| `/api/tasks/:id/comments` | POST | Добавить комментарий (все роли) |
| `/api/tasks/:id/comments/:commentId` | DELETE | Удалить комментарий (автор или SUPER_ADMIN) |
| `/api/tasks/:id/checklist` | POST | Добавить пункт чеклиста (creator/SA) |
| `/api/tasks/:id/checklist/:itemId` | PATCH | Тогл `done` (creator/assignee/SA) или правка `text` (creator/SA) |
| `/api/tasks/:id/checklist/:itemId` | DELETE | Удалить пункт (creator/SA) |

`GET /api/tasks/:id` теперь возвращает `comments[]` (author-enriched, createdAt asc) + `checklist[]` (position asc). `GET /api/tasks` список — каждый элемент включает `commentCount: number` и `checklistSummary: { done, total }` (через Prisma `_count` + lightweight include, без N+1). Имя `checklistSummary` намеренно отличается от detail-поля `checklist[]` во избежание конфликта формы.

### Conventions (дополнение)

- **`Task.dueDate` — date-only semantics.** Хранится как Москва-полночь UTC; сравнивается через `toMoscowDateString()` для TZ-стабильного bucket-ования. Никогда не сравнивать как Date object напрямую.
- **Optimistic mutation pattern.** Snapshot → optimistic apply → reconcile from server; per-id `useRef<Set<string>>` in-flight guard против дублей. `completeTask`: fire-immediately, toast с «Отменить» (6 с), undo → `reopenTask`.
- **Audit actions.** `TASK_CREATE / TASK_UPDATE / TASK_ASSIGN / TASK_COMPLETE / TASK_REOPEN / TASK_DELETE` — все пишутся в той же транзакции, что и мутация; `entityType: "Task"`. `TASK_ASSIGN` пишется отдельным action при изменении `assignedTo` (для поиска в аудите).
- **History fetch.** `TaskHistoryPage` использует локальный `useEffect + useState` с `cancelled`-flag паттерном (не `useTasksQuery` — у него своя filter/optimistic семантика для главной страницы). Пагинация через `cursor` query param, кнопка «Загрузить ещё».
- **DayTasksWidget.** Самостоятельно фетчит `/api/dashboard/today`, не получает данные через props. Graceful degradation: если `myTasks` отсутствует в ответе — показывает пустое состояние без ошибки.
- **Task collab realtime.** Умный polling: список (`useTasksQuery`) 12 s, открытая панель (`useTaskDetail`) 8 s; пауза при `document.hidden`; `pollBlocked` ref не даёт поллу затереть in-flight оптимистичную мутацию (snapshot→apply→reconcile→rollback). SSE — задокументированный v2-путь (spec §10).
- **Checklist toggles НЕ аудируются** (высокочастотны, прогресс самоочевиден). Аудируются только `TASK_COMMENT_ADD/DELETE` и `TASK_CHECKLIST_ADD/DELETE` — в той же транзакции, `entityType: "Task"`, `entityId: taskId`. PATCH чеклиста (`done`/`text`) аудит не пишет.
- **HttpError → `res.body.code`.** Централизованный error-handler в `app.ts` теперь дублирует строковый 3-й аргумент `HttpError` в поле `code` (сохраняя `details`) — обратносовместимо; новые task-collab тесты ассертят `res.body.code`.
- **Slide-over панель задач.** `?task=<id>` deep-link открывает `TaskDetailPanel` (router.replace, не push — закрытие через Esc/кнопку/backdrop, не засоряет историю); чипы `💬`/`☑` на карточке открывают панель кликом по телу (не по чекбоксу/inline-edit/⋯).


## Customer Portal `/lk` (Подпроект 1+2)

Отдельный клиентский портал для гафферов — rental clients. Magic-link auth по приглашению админа, 1:1 с `Client`.

### Auth и модели

- `ClientPortalAccount` (1:1 с `Client`) + `ClientPortalMagicLink` (HMAC-SHA256 tokenHash, single-use, INVITE TTL 24h / LOGIN TTL 15m).
- JWT cookie `lk_session`, secret `CLIENT_PORTAL_SESSION_SECRET`, отдельная цепочка `lkAuth` (НЕ `apiKeyAuth`).
- Token HMAC secret `CLIENT_PORTAL_TOKEN_SECRET`.
- Email через `nodemailer`; в dev — console-fallback при отсутствии `SMTP_HOST`.
- `req.clientPortal` объявлен в `apps/api/src/types/express.d.ts` (единая точка с adminUser/warehouseWorker).

### Маршруты (frontend)

- `/lk` — dashboard
- `/lk/bookings`, `/lk/bookings/[id]` — история заказов + детали (read-only)
- `/lk/estimates` — список MAIN-смет с кнопкой «Скачать PDF»
- `/lk/debt` — инвойсы клиента (ISSUED / PARTIAL_PAID / OVERDUE), просроченные строки тинтуются rose
- `/lk/stats` — top-20 оборудования + «Твой типовой набор» (≥40% в последних 10 бронях, пусто если выборка <3)
- `/lk/crew-calculator` — порт shared crew-calculator, stateless
- `/lk/tools` — ссылка на внешний https://calc.svetobazarent.ru/

Login flow (вне `LkShell`):
- `/lk/login` — форма email
- `/lk/login/sent` — экран подтверждения
- `/lk/verify?token=...` — приёмник magic-link, использует `silent401: true` в `lkApi`

Layout `apps/web/app/lk/layout.tsx` — client component с `usePathname`-bypass для auth-маршрутов (без route group).

### API (backend)

Все под `/api/lk/*`, НЕ `apiKeyAuth`, через `lkAuth` middleware:

| Маршрут | Метод | Действие |
|---|---|---|
| `/api/lk/auth/request-login` | POST | Magic-link email (always 200, no enumeration, rate limit 5/15min) |
| `/api/lk/auth/verify` | POST | Consume token (тонкий controller → `loginViaMagicLink` сервис) |
| `/api/lk/auth/logout` | POST | Clear cookie |
| `/api/lk/me` | GET | Account + client info |
| `/api/lk/bookings` | GET | List with compound cursor `(startDate, id)`, filter `?status=`, DRAFT исключён |
| `/api/lk/bookings/:id` | GET | Detail with MAIN-estimate snapshot |
| `/api/lk/bookings/:id/estimate.pdf` | GET | Reuse `buildBookingEstimatePdf` сервис |
| `/api/lk/bookings/:id/act.pdf` | GET | Reuse `buildBookingActPdf` сервис; gate `status === "RETURNED"` (без debt-блока — клиент видит акт даже при задолженности) |
| `/api/lk/estimates` | GET | List `kind: "MAIN"` only (no CONFIRMED — enum has only MAIN/ADDON) |
| `/api/lk/debt` | GET | Per-client invoices с outstanding > 0 |
| `/api/lk/stats?period=180d\|365d\|all` | GET | Top equipment + typical kit |

Admin (под обычным `apiKeyAuth + rolesGuard(["SUPER_ADMIN"])`):

| Маршрут | Метод | Действие |
|---|---|---|
| `/api/admin/clients/:id/portal-invite` | POST | Upsert account + INVITE token + email + audit |
| `/api/admin/clients/:id/portal-account` | GET | Read current account state |
| `/api/admin/clients/:id/portal-account/disable` | POST | Mark DISABLED + audit |
| `/api/admin/clients/:id/portal-account/reenable` | POST | Restore ACTIVE + audit |
| `/api/admin/clients/:id/portal-account/resend` | POST | Invalidate prior INVITE, issue new + email + audit |

### Сервисы

- `apps/api/src/services/clientPortal/session.ts` — `signLkSession` / `verifyLkSession`, lazy `getSecret()`
- `apps/api/src/services/clientPortal/magicLink.ts` — `issueMagicLink`, `consumeMagicLink` + `consumeMagicLinkInTx`, `invalidateUnusedInvites`. `hashToken` HMAC-SHA256.
- `apps/api/src/services/clientPortal/mailer.ts` — `sendInviteEmail`, `sendLoginEmail`. HTML body escapes `clientName` через `escHtml`.
- `apps/api/src/services/clientPortal/tenant.ts` — `lkClientId(req)`, `assertLkClientOwns(entity, req)`.
- `apps/api/src/services/clientPortal/portalAccountService.ts` — `loginViaMagicLink(rawToken, meta)`: atomic `$transaction` для consume + account state machine (PENDING → ACTIVE, lastLogin*, failedLoginAttempts=0). DISABLED → INVALID_TOKEN (no enumeration).
- `apps/api/src/services/clientPortal/statsService.ts` — `computeLkStats(prisma, clientId, period)`: top equipment + typical kit (последние 10 броней, threshold 0.4).
- `apps/api/src/services/documentExport/bookingPdf.ts` — `buildBookingEstimatePdf` / `buildBookingActPdf`, reused admin-route + lk-route.

### Конвенции

- `clientId` ВСЕГДА из `req.clientPortal.clientId` (JWT). Никогда из query/body.
- `assertLkClientOwns()` на каждом read-endpoint, либо инлайн-проверка `booking.clientId !== clientId → 404`.
- DRAFT-брони не возвращаются клиенту. Видимые статусы: `PENDING_APPROVAL | CONFIRMED | ISSUED | RETURNED | CANCELLED`.
- Estimate видны только `kind=MAIN` (исторически план говорил «CONFIRMED», но `EstimateKind` enum фактически `MAIN | ADDON`).
- `BookingItem` не несёт денежных полей — `unitPrice/lineSum/categorySnapshot/nameSnapshot` живут на `EstimateLine`. Detail-эндпоинт фолбэчится на MAIN estimate snapshot.
- Audit: admin-actions → обычный `AuditEntry` в `$transaction` с мутацией. Portal-side login события → `ClientPortalMagicLink.usedAt/ip/ua` + `ClientPortalAccount.failedLoginAttempts/lockedUntil` (НЕ AuditEntry, чтобы не расслаблять FK на `AdminUser`).
- Compound cursor pagination `{createdAt|startDate}_iso|id` — корректный keyset для compound order. Использован в `/lk/bookings` и `/lk/estimates`.
- Decimal-арифметика: для long-running агрегатов используется `Decimal.add` / `Decimal.sub` (`@prisma/client/runtime/library`). Для одноразовых сериализаций `.toString()` достаточно.
- `lkApi` 401-redirect skipping `/lk/login`; `verify` использует `silent401: true` для inline error при невалидном токене.

### Env vars (новые)

- `CLIENT_PORTAL_SESSION_SECRET` — ≥16 символов в production (lazy-throw в `session.ts`)
- `CLIENT_PORTAL_TOKEN_SECRET` — ≥16 символов в production (HMAC, lazy-throw в `magicLink.ts`)
- `SMTP_HOST`, `SMTP_PORT` (default 587), `SMTP_SECURE` (default false = STARTTLS), `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` — для отправки magic-link email. В dev: если `SMTP_HOST` не задан и NODE_ENV не production → fallback `console.log` ссылки. Production без SMTP_HOST падает в `mailer.ts:getTransport`.
- `PUBLIC_BASE_URL` — основа magic-link URL (default `http://localhost:3000`).

### Тесты

- `lkSession.test.ts` — JWT sign/verify roundtrip
- `lkMagicLink.test.ts` — hashToken determinism, race-safe consume, invalidateUnusedInvites
- `lkAuthRequestLogin.test.ts` — no-enumeration, ACTIVE/DISABLED branches, rate-limit
- `lkAuthVerify.test.ts` — PENDING→ACTIVE, lastLoginAt, replay 401, /me, /logout
- `clientPortalAdmin.test.ts` — 17 тестов: invite/disable/reenable/resend по всем ролям, audit, EMAIL_TAKEN, ACCOUNT_DISABLED guards
- `lkBookings.test.ts` — список, фильтр статуса, compound cursor, detail с MAIN estimate, PDF endpoints (estimate.pdf, act.pdf) с tenant + status gates
- `lkEstimates.test.ts` — MAIN-only фильтр, tenant isolation, pagination, pdfUrl
- `lkDebt.test.ts` — outstanding > 0, isOverdue, tenant isolation, Decimal math
- `lkStats.test.ts` — top sorting, sample<3 empty, threshold 0.4, period filter

### Out of scope (Подпроект 3, отдельная спека)

- Самозаказ: корзина, «Заказать набор», self-create Booking.
- Email-дайджесты, нотификации.
- Multi-tenant Client (1 аккаунт → много Client).
- Загрузка документов с портала.
- Передача параметров во внешний `calc.svetobazarent.ru` (только ссылка-кнопка).

### Key Files (новые)

| File | Purpose |
|------|---------|
| `apps/api/src/middleware/lkAuth.ts` | `req.clientPortal` populator |
| `apps/api/src/services/clientPortal/*` | session, magicLink, mailer, tenant, portalAccountService, statsService |
| `apps/api/src/services/documentExport/bookingPdf.ts` | Shared PDF assembly для admin + lk |
| `apps/api/src/routes/lk/*` | auth.ts, me.ts, bookings.ts, estimates.ts, debt.ts, stats.ts, index.ts |
| `apps/api/src/routes/clientPortalAdmin.ts` | Admin invite/disable/reenable/resend |
| `apps/web/app/lk/layout.tsx` | Conditional shell (auth routes bypass LkShell) |
| `apps/web/src/components/lk/*` | LkShell, LkNav, StatsTopTable, TypicalKitGrid |
| `apps/web/src/components/admin/ClientPortalAccessCard.tsx` | Inline админ-card в `/bookings/[id]` для SUPER_ADMIN |
| `apps/web/src/lib/lkApi.ts`, `lkTypes.ts` | Frontend data layer |
| `apps/web/src/hooks/useLkSession.ts` | `useLkSession` hook |

## Finance Phase 3 (Backend B1–B6)

### Новые API-маршруты

| Маршрут | Метод | Роли | Описание |
|---------|-------|------|----------|
| `/api/finance/forecast` | GET | SA | Стек-бар прогноза доходов на 1–12 месяцев |
| `/api/bookings/:id/finance-timeline` | GET | SA | Хронология финансовых событий по броне |
| `/api/bookings/:id/related-expenses` | GET | SA | Прямые + ремонтно-связанные расходы по броне |
| `/api/expenses/:id/document` | POST | SA | Загрузка документа расхода (JPEG/PNG/PDF ≤5 MB) |
| `/api/expenses/:id/document` | GET | SA, WH | Получение документа расхода |
| `/api/expenses/:id/document` | DELETE | SA | Удаление документа расхода |

### Изменения в существующих маршрутах

- `GET /api/finance/debts` — добавлены поля `clientPhone: string | null` и `clientEmail: string | null` в каждый элемент ответа `debts`.

### Новые сервисные функции (apps/api/src/services/finance.ts)

- `computeForecast(horizonMonths)` — прогноз по инвойсам (ISSUED/OVERDUE = confirmed, DRAFT = potential) и броням без инвойсов (= bookingsPipeline). Возвращает массив `ForecastMonth[]` + `totals`.
- `computeBookingTimeline(bookingId)` — хронология финансовых событий: INVOICE_ISSUED, INVOICE_VOIDED, PAYMENT_RECEIVED, PAYMENT_VOIDED, REFUND_ISSUED, EXPENSE_LOGGED, CREDIT_NOTE_APPLIED. Сортировка ascending.
- `computeRelatedExpenses(bookingId)` — прямые (Expense.bookingId) + REPAIR_LINKED (Expense.linkedRepairId на ремонт в рамках брони ± 14 дней). Возвращает `{ items, total }`.

### Cron-скрипт OVERDUE recompute (B3)

**Файл:** `apps/api/scripts/recompute-overdue-invoices.ts`

Находит инвойсы с `status IN (ISSUED, PARTIAL_PAID)` и `dueDate < now()` и переводит их в OVERDUE через `recomputeInvoiceStatus()`.

**Настройка в PM2** (добавить в `ecosystem.config.js`):
```js
{
  name: "overdue-recompute",
  script: "apps/api/scripts/pm2-cron-overdue.cjs",
  cron_restart: "0 2 * * *",   // каждый день в 02:00 UTC
  autorestart: false,
  env: { NODE_ENV: "production" },
}
```
Команды: `pm2 start ecosystem.config.js --only overdue-recompute`.

### Загрузка документов расходов (B6)

- Файлы хранятся в `apps/api/uploads/expenses/{expenseId}/{timestamp}_{filename}`.
- `Expense.documentUrl` хранит **относительный путь** от `apps/api/uploads/` (например, `expenses/{id}/{timestamp}_{filename}`). Полный путь строится через `path.resolve(UPLOAD_ROOT, rel)` с защитой от traversal (`startsWith(UPLOAD_ROOT + path.sep)`). Не абсолютный путь — скрипты и операторы не должны интерпретировать это поле как готовый абсолютный путь.
- `GET /api/expenses/:id/document` стримит файл напрямую с диском.
- Ограничения: 5 MB max, только JPEG/PNG/PDF.
- Директория `uploads/` создаётся автоматически при первой загрузке.

## Warehouse Scan Redesign (Adaptive UX + Потеряшки)

Полная переработка kiosk-сценария склада: адаптивный UX (mobile-tablet + desktop two-pane), быстрая 3-исходная приёмка, фото поломки прямо со сканера, реестр проблемных единиц «Потеряшки». Reference-мокапы и план — в `docs/superpowers/specs/2026-05-19-warehouse-scan-redesign-design.md` + `docs/superpowers/plans/2026-05-19-warehouse-scan-redesign.md`. Все экраны сверены с утверждёнными мокапами (`docs/mockups/warehouse-scan/FIDELITY-CHECK.md`).

### Новые модели Prisma

- **`ProblemItem`** — проблемная единица с приёмки (заявка на поиск/разбор). Поля: `equipmentUnitId`, `sourceBookingId?`, `reason` (`ProblemReason`), `comment`, `expectedBackDate?`, `status` (`ProblemStatus`, default `SEARCHING`), `createdBy`, `resolvedAt?`, `resolvedBy?`, `resolutionNote?`.
- **`RepairPhoto`** — фото поломки, привязанное к `Repair` (`onDelete: Cascade`). Поля: `repairId`, `filePath` (относительный от `apps/api/uploads/`), `createdBy`.
- Новые enum: **`ProblemReason`** = `LEFT_ON_SITE | LOST | DESTROYED | STOLEN`; **`ProblemStatus`** = `EXPECTED | SEARCHING | FOUND | NOT_FOUND | WROTE_OFF`.
- `AuditEntityType += "ProblemItem"`. Новые audit-actions: `PROBLEM_ITEM_CREATE`, `PROBLEM_ITEM_RESOLVE`, `BOOKING_ITEM_ADDED_WITH_CONFLICT` (вместо `BOOKING_ITEM_ADDED_ON_SITE` когда добавлен конфликтный артикул).

### Контракт `completeSession` (изменён)

- `lostUnits` **УДАЛЁН**. Заменён на `repairUnits: RepairUnit[]` + `problemUnits: ProblemUnit[]` в `options`.
- Удалены: `invoiceNeedsReissue`, compensation, invoice-resync (предыдущая лог-схема пересмотрена — приёмка не трогает финансы/инвойсы).
- `repairUnits` / `problemUnits` обрабатываются ПОСЛЕ основной транзакции возврата, каждая единица изолированно (сбой одной не валит остальные и не откатывает физический возврат). `urgency` дефолтит `NORMAL` (быстрый UI не собирает срочность).
- Post-tx `autoResolveOnReturn`: best-effort авто-закрытие открытой `ProblemItem` при повторной (поздней) приёмке. Фильтр: единицы, помеченные В ЭТОЙ ЖЕ сессии (problem/repair), исключаются — их новый статус (MISSING/RETIRED/MAINTENANCE) авторитетен.
- `ReconciliationSummary` расширен: `createdProblemItemIds`, `failedProblemUnits` (в дополнение к `createdRepairIds`, `failedBrokenUnits`).
- Соответствие reason → реакция (в `problemItemService.createProblemItem`): `LEFT_ON_SITE` → ProblemItem `EXPECTED`, unit `MISSING`; `LOST`/`STOLEN` → `SEARCHING`, unit `MISSING`; `DESTROYED` → `WROTE_OFF` (сразу закрыто), unit `RETIRED`.

### Новые API-маршруты

| Маршрут | Метод | Описание |
|---------|-------|----------|
| `/api/warehouse/sessions/:id/addon-search` | GET | Поиск артикулов для quick-add (`?q=`). Availability soft-warn: для `UNAVAILABLE` строк возвращает `conflict` (ближайшая бронь). Без barcode в выдаче. `warehouseAuth`. |
| `/api/warehouse/sessions/:id/items` | POST | Quick-add позиции. Если артикул занят на даты брони и `acknowledgedConflict !== true` → 409 `ADDON_CONFLICT` со структурными `details` (bookingNo/projectName/from/to/freeFrom). С `acknowledgedConflict: true` — добавляет + аудит `BOOKING_ITEM_ADDED_WITH_CONFLICT`. |
| `/api/warehouse/sessions/:id/units/:unitId/photos` | POST/GET/DELETE | Фото поломки, staged на сессию. multer-security как в `expenses.ts` (magic-bytes, JPEG/PNG, 5 MB). На `complete` для repair-единиц staged-фото переносятся в `uploads/repairs/{repairId}/` → `RepairPhoto`. |
| `/api/repairs/:id` | GET | Теперь возвращает `photos: [{ id, url }]` (url = `/api/repairs/:id/photos/:photoId`). |
| `/api/repairs/:id/photos/:photoId` | GET | Стрим фото поломки (traversal-guard через `resolveUploadPath`). SA/WAREHOUSE/TECHNICIAN. |
| `/api/problem-items` | GET | Список «Потеряшки», keyset-пагинация (createdAt desc), фильтр `?status=`. Без barcode. |
| `/api/problem-items/:id/resolve` | POST | Ручной разбор открытой карточки: `outcome` FOUND/NOT_FOUND + `note` (min 3). FOUND → unit `AVAILABLE`. FUTURE-хук в `resolveProblemItem`: NOT_FOUND → «долг гафера». |

`/api/problem-items` смонтирован с router-level `rolesGuard(["SUPER_ADMIN", "WAREHOUSE"])` (TECHNICIAN → 403). НЕ в botScope whitelist.

`HttpError` расширен 4-арг формой: `new HttpError(status, message, "CODE", { ...details })` — 3-й арг остаётся строковым кодом (обратносовместимо, `res.body.code` без изменений), 4-й несёт структурные `details` для UI-предупреждений (используется `ADDON_CONFLICT`).

### Frontend

- `apps/web/app/warehouse/scan/page.tsx` — step-машина этого редизайна (login/operation/booking/checklist/summary) с тех пор заменена «Рабочим столом кладовщика v2» на `WorkstationShell` (см. строку в Key Files). Из неё сохранены token-контракт (`warehouse_token` Bearer), PIN-login + SA/WAREHOUSE main-session bypass и сами чек-листы.
- Новые компоненты в `apps/web/src/components/warehouse/`: `LoginStep`, `BookingList` (без фильтров, группировка по дате), `UnitRow` (2-кн ISSUE / 3-кн RETURN), `IssueChecklist`, `AddonSearch` (bottom-sheet/inline + focus-trap + scroll-lock + slide-up; soft-warn на конфликт + ack-proceed), `RepairPanel` (нативная камера через `<input capture>`), `ProblemPanel` (4 причины), `ReturnChecklist`, `ReturnResultView`, `ProblemItemsPage`, `ResolveProblemModal`, `useScanSession`, `api.ts`, `types.ts` (shared `isScanApiError` рядом с типом).
- `apps/web/app/warehouse/problems/page.tsx` — manager-реестр «Потеряшки»: обычный AppShell + JWT (НЕ kiosk-сценарий).
- `apps/web/app/warehouse/layout.tsx` — сведён к прозрачному passthrough (`<>{children}</>`): kiosk-фрейм теперь в `WorkstationShell`, layout-обёртка давала двойную шапку. Не возвращать chrome.
- Навигация: пункт «Потеряшки» (`/warehouse/problems`, icon `alert`) добавлен в `roleMatrix.ts` для `SUPER_ADMIN` + `WAREHOUSE`.
- **`expectedBackDate` wire-format**: `ProblemPanel` отдаёт голый `YYYY-MM-DD` (raw `<input type="date">`). Backend Zod для `problemUnits[].expectedBackDate` — `z.string().datetime()` (требует ISO-8601). `ReturnChecklist` конвертирует `YYYY-MM-DD` → `new Date(`${d}T00:00:00.000Z`).toISOString()` ПЕРЕД POST (`toIsoDatetime` в `types.ts`).

### Технические нюансы / конвенции

- **Никаких barcode в UX-питающем API.** `addon-search` и `/api/problem-items` отдают только название/категорию оборудования, не barcode (`LR-XXX-NNN`).
- **Soft-warn семантика quick-add.** Конфликт по датам — не блокировка: 409 `ADDON_CONFLICT` → UI показывает предупреждение → пользователь подтверждает → повторный POST с `acknowledgedConflict: true` → добавлено + аудит `BOOKING_ITEM_ADDED_WITH_CONFLICT`.
- **Фото — staged на сессию, мигрируют на complete.** До `complete` фото лежат в `uploads/scan-sessions/{sessionId}/{unitId}/`. На `complete` (success-путь, после успешного `createRepair`) `moveStagedToRepair` переносит в `uploads/repairs/{repairId}/` и создаёт `RepairPhoto`. Отсутствие фото не блокирует завершение.
- **Аудит = observability, не бизнес-инвариант.** `autoResolveOnReturn` пишет аудит ВНЕ основной транзакции (в проде `createdBy` = имя кладовщика, не `AdminUser.id` → FK-инсерт упал бы и откатил физический возврат). Документированный trade-off, консистентно с остальным кодбейзом.
- **Тесты.** API: `addonAvailability`, `addonItems`, `problemItemService`, `problemItems.routes`, `repairPhotos`, `repairPhotosRoutes`, `repairs.routes`, `warehouseProblemUnit`, обновлён `warehouseScan.brokenUnits`; удалён `warehouseLostUnit` (контракт устарел). Web: компонентные тесты на все новые warehouse-компоненты + design-fidelity capture vs мокапы. `RepairPanel.tsx` имеет один намеренный `@next/next/no-img-element` warning (blob-thumbnail превью) — документированное отклонение, не новая ошибка.

<!-- updated-by-superflow:2026-04-25 -->
