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
| `apps/web/app/admin/page.tsx` | Admin panel -- slang learning review + warehouse worker management + cross-catalog barcode management + price import (PricesTab: upload, column mapping, review with filters, bulk actions, apply, XLSX export) |
| `apps/api/src/routes/equipmentUnitsGlobal.ts` | Cross-catalog equipment units API: list, lookup, batch labels (mounted at `/api/equipment-units`) |
| `apps/web/app/admin/scanner/page.tsx` | Mobile-first barcode scanner page: lookup, assign, batch-assign modes |
| `apps/web/src/components/BarcodeScanner.tsx` | Shared barcode scanner component (html5-qrcode, Wake Lock, flash animation) |
| `ecosystem.config.js` | PM2 process definitions for api (:4000) + rental-bot |
| `deploy.sh` | Build + deploy script (builds shared first; supports --api, --web, --rental-bot flags) |
| `apps/api/src/routes/dashboard.ts` | GET /api/dashboard/today — daily operations summary: pickups, returns, active bookings |
| `apps/api/src/routes/calendar.ts` | GET /api/calendar (resources + events), GET /api/calendar/occupancy (per-day heatmap) |
| `apps/web/app/calendar/page.tsx` | Full calendar page: desktop availability grid (equipment rows × day columns, collapsible categories) + mobile day-by-day card view; URL params: date, period, category |
| `apps/web/src/components/CalendarTooltip.tsx` | Floating tooltip for calendar cells (via @floating-ui/react): shows booking details on hover |
| `apps/web/src/lib/calendarUtils.ts` | Pure utility: `buildOccupancyMap()` builds Map<`resourceId-date`, OccupancyEntry>; DRAFT bookings excluded from occupied counts |
| `apps/api/src/middleware/botScopeGuard.ts` | Bot scope enforcement: keys with `openclaw-` prefix are restricted to whitelist routes; DELETE globally blocked → 403 BOT_SCOPE_FORBIDDEN |
| `docs/bot-api.md` | Bot API documentation (Russian): auth, scope, all endpoints, curl examples, error codes, 3 typical scenarios |
| `docs/bot-api-tools.json` | OpenAI function-calling schemas (12 tools): ready to paste into `client.chat.completions.create({ tools: [...] })` |

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
npm test                          # run all (shared + bot + api) — 227 tests
npm run test -w apps/api          # API tests (smoke + barcode integration)
npm run test -w apps/bot          # bot booking-helpers tests only (27 tests)
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

### Аудит-сервис

`apps/api/src/services/audit.ts`:
- `writeAuditEntry(args)` — записывает событие в `AuditEntry`. Принимает `tx?` для транзакций.
- `diffFields(obj, maxBytes)` — очищает объект от вложенных relations (объекты с `id`), массивов. При > 10 KB усекает до примитивов.

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
3. **~~Minimal test coverage~~** — RESOLVED: 227 tests across shared, bot (booking-helpers), API smoke, barcode integration, importSession, competitorMatcher, importSession routes, dashboard, calendar, and calendarUtils tests.
4. **~~Hardcoded aliases~~** — RESOLVED: TYPE_SYNONYMS migrated to SlangAlias DB table, auto-learning enabled.
5. **Production `web` PM2 process unstable** — investigate 8646+ restarts, likely needs `npm run build` in deploy.

<!-- updated-by-superflow:2026-04-08 -->

