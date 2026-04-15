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
      src/components/ AppShell, StatusBadge, BarcodeScanner, MiniCalendar, DashboardOpsCard, QuickAvailabilityCheck, CalendarTooltip
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
| `apps/api/src/services/smetaExport/renderPdf.ts` | PDF estimate export via pdfkit |
| `apps/api/src/services/smetaExport/renderXlsx.ts` | XLSX estimate export via exceljs |
| `apps/api/src/routes/bookingRequestParser.ts` | Gemini AI gaffer text -> equipment list parsing (used by web); match-equipment endpoint (used by bot, no LLM) |
| `apps/bot/src/scenes/booking.ts` | Hub-and-spoke booking scene (~1000 LOC): hub step is central cart screen, spokes: catalog, inline needsReview confirmations |
| `apps/bot/src/services/api.ts` | Bot API client: gaffer review types (GafferReviewItem, GafferMatchCandidate), parseGafferReview() |
| `apps/bot/src/services/llm.ts` | Equipment matching via parseGafferReview API (3-tier: resolved/needsReview/unmatched), date parsing |
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
| `apps/web/app/warehouse/scan/page.tsx` | Mobile-first 5-step scan wizard: login → booking → scan → summary → confirm |
| `apps/web/app/equipment/[id]/units/page.tsx` | Unit management: status badges, generate/edit/delete, label printing |
| `packages/shared/src/crewCalculator.ts` | Shared crew cost calculator (imported by web + bot) |
| `apps/bot/src/scenes/booking-helpers.ts` | Extracted pure functions from booking scene |
| `apps/web/app/page.tsx` | Operations dashboard home page (was redirect) |
| `apps/web/src/components/MiniCalendar.tsx` | Month heatmap using react-day-picker v9, click→calendar |
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
| `apps/web/src/components/day/DayHeader.tsx` | Тёмная шапка `/day`: приветствие + русская дата + role-specific summary справа |
| `apps/web/src/components/day/DayAlert.tsx` | Алерт с вариантами rose/amber, опциональным счётчиком и Link-кнопкой «Все →» |
| `apps/web/src/components/day/DayKpiCard.tsx` | KPI-карточка: eyebrow / value (ReactNode) / sub с `subTone: "muted" \| "rose"` |
| `apps/web/src/components/day/DayOperationsList.tsx` | Список операций: HH:MM · выдача/возврат · клиент · (сумма)? · N позиций. Использует shared `pluralize()` |
| `apps/web/src/components/day/DayFooterMetrics.tsx` | Обёртка для нижней строки-сводки с dashed-top-border |
| `apps/web/src/lib/format.ts` | formatRub + formatMoneyRub + `pluralize(n, one, few, many)` + `MONTHS_LOCATIVE` (в январе, в феврале, …) |
| `apps/api/src/routes/calendar.ts` | GET /api/calendar (resources + events), GET /api/calendar/occupancy (per-day heatmap) |
| `apps/web/app/calendar/page.tsx` | Full calendar page: desktop availability grid (equipment rows × day columns, collapsible categories) + mobile day-by-day card view; URL params: date, period, category |
| `apps/web/src/components/CalendarTooltip.tsx` | Floating tooltip for calendar cells (via @floating-ui/react): shows booking details on hover |
| `apps/web/src/lib/calendarUtils.ts` | Pure utility: `buildOccupancyMap()` builds Map<`resourceId-date`, OccupancyEntry>; DRAFT bookings excluded from occupied counts |
| `apps/api/src/middleware/botScopeGuard.ts` | Bot scope enforcement: keys with `openclaw-` prefix are restricted to whitelist routes; DELETE globally blocked → 403 BOT_SCOPE_FORBIDDEN |
| `apps/api/src/__tests__/rolesGuardHolistic.test.ts` | 21 интеграционный тест: TECHNICIAN→403 / WAREHOUSE→2xx / SUPER_ADMIN→2xx на `/api/warehouse/workers/*` и `/api/equipment-units/*` + аудит-проверки на AdminUser CRUD |
| `docs/bot-api.md` | Bot API documentation (Russian): auth, scope, all endpoints, curl examples, error codes, 3 typical scenarios |
| `docs/bot-api-tools.json` | OpenAI function-calling schemas (12 tools): ready to paste into `client.chat.completions.create({ tools: [...] })` |
| `apps/api/src/services/bookingApproval.ts` | Booking approval workflow: `submitForApproval` (DRAFT → PENDING_APPROVAL, clears rejectionReason), `approveBooking` (delegates to `confirmBooking` + audit), `rejectBooking` (required reason, PENDING_APPROVAL → DRAFT + rejectionReason + audit) |
| `apps/api/src/__tests__/approval.test.ts` | 22 интеграционных теста approval workflow: submit/approve/reject по всем ролям + full reject-resubmit-approve cycle + legacy confirm-bypass регрессия + ?status= Zod-валидация |
| `apps/web/src/components/bookings/RejectBookingModal.tsx` | Модалка обязательной причины отклонения (min 3 trimmed chars, счётчик, Esc-close, backdrop dismissal, auto-focus textarea) |

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
npm test                          # run all (shared + bot + api) — 451 tests
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
- **Dashboard is home page** — `/` shows operations dashboard (pickups/returns/active + MiniCalendar + availability check), not equipment list.
- **Calendar BLOCKING_STATUSES** — `["CONFIRMED", "ISSUED"]` used by both `calendar.ts` and `availability.ts`. DRAFT bookings excluded from occupancy calculations.
- **Hourly precision** — Equipment page and QuickAvailabilityCheck use `datetime-local` inputs. Bookings resolved to exact hour, not just date.
- **New web dependencies**: `react-day-picker` v9, `@floating-ui/react`, `date-fns` (web only).
- **Bot scope guard** — `botScopeGuard` middleware (mounted in `app.ts` after `apiKeyAuth`) enforces whitelist for API keys with prefix `openclaw-`. DELETE is globally blocked. Non-whitelisted routes return 403 `{ code: "BOT_SCOPE_FORBIDDEN" }`. Keys without this prefix pass through without restriction.
- **Finance debts endpoint** — `GET /api/finance/debts` aggregates `amountOutstanding > 0` bookings (excluding CANCELLED) by client. Supports `?overdueOnly=true` and `?minAmount=N` filters. Service function: `computeDebts()` in `apps/api/src/services/finance.ts`.
- **dryRun option** — `POST /api/bookings/draft` and `PATCH /api/bookings/:id` accept `dryRun: true` in the request body. When true, validates input, computes estimate via `quoteEstimate()`, and returns a preview without writing to DB. POST returns `{ id: null, status: "DRAFT_PREVIEW", ... }`. PATCH returns the existing booking's projected state.

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

Примечание: `/api/warehouse/auth` и `/api/warehouse/workers/names` остаются публичными (без `rolesGuard`).

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

## Known Issues

1. **~~No authentication~~** — RESOLVED: `apiKeyAuth` middleware enforces `X-API-Key` header (`AUTH_MODE=warn|enforce`).
2. **~~Crew calculator duplication~~** — RESOLVED: extracted to `packages/shared` (`@light-rental/shared`).
3. **~~Minimal test coverage~~** — RESOLVED: 451 tests across shared, bot (booking-helpers), API smoke, barcode integration, importSession, competitorMatcher, importSession routes, dashboard, calendar, calendarUtils, rolesGuard holistic tests.
4. **~~Hardcoded aliases~~** — RESOLVED: TYPE_SYNONYMS migrated to SlangAlias DB table, auto-learning enabled.
5. **Production `web` PM2 process unstable** — investigate 8646+ restarts, likely needs `npm run build` in deploy.
6. **`npm run lint` fails on main** — ESLint v9 expects `eslint.config.(js|mjs|cjs)` but the repo has `.eslintrc.json`. Pre-existing, unrelated to feature work. Fix before any lint-gated CI.

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

`GET /api/audit` — SUPER_ADMIN only. Query: `entityType`, `userId`, `from` (ISO), `to` (ISO), `limit` (1–200, default 50), `cursor` (keyset). Response: `{ items: AuditEntry[], nextCursor: string | null }`. Файл: `apps/api/src/routes/audit.ts`.

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

`POST /api/warehouse/sessions/:id/complete` принимает опциональный `brokenUnits: Array<{ equipmentUnitId, reason, urgency }>`. После завершения транзакции возврата для каждой broken unit вызывается `createRepair({ ..., sourceBookingId: session.bookingId })`.

### Frontend

- `/repair` — `apps/web/app/repair/page.tsx`. Kanban-board: 4 колонки (WAITING_REPAIR/IN_REPAIR/WAITING_PARTS/CLOSED). Фильтры: "Моя очередь" / urgency pills.
- `/repair/[id]` — `apps/web/app/repair/[id]/page.tsx`. Детали + журнал работ + кнопки по роли (взять, добавить работы, закрыть, списать). Модалка расхода при закрытии.
- `/warehouse/scan` обновлён: на шаге итога возврата каждая единица имеет кнопку "🔧 Поломка" → модалка reason+urgency → `brokenUnits` в payload.
- `/day` → `DayTechnician`: подгружает ремонты (`assignedTo=currentUser`), SLA просрочки (IN_REPAIR > 5 дней). `DayWarehouse`: показывает счётчик открытых ремонтов.

### CurrentUser + userId

`src/lib/auth.ts` — `CurrentUser.userId` (опциональное поле) теперь синхронизируется из `/api/auth/me`. Используется для фильтрации ремонтов по назначенному технику.

## Sprint 5: Design Canon Repaint

Рескин существующих страниц до IBM Plex Canon. Миграция завершена.

Канонический reference: `docs/design-system.md`.

### Новые общие компоненты

- **`src/components/StatusPill.tsx`** — универсальный статусный бейдж. Props: `{ variant: "full" | "edit" | "view" | "limited" | "own" | "none" | "ok" | "warn" | "info", label: string, className?: string }`. Заменяет удалённый `StatusBadge.tsx`.
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
- `DashboardOpsCard`, `QuickAvailabilityCheck`, `CalendarTooltip`, `MiniCalendar` — токенизация.

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

<!-- updated-by-superflow:2026-04-15 -->
