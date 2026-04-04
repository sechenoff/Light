# CLAUDE.md — Light Rental System

## Project Overview

Film lighting equipment rental platform for a Russian cinematography rental house. Three apps in an npm workspaces monorepo:
- **API** (`apps/api`): Express 4 REST server with Prisma 6 (SQLite), BullMQ photo analysis queue, Gemini AI vision
- **Web** (`apps/web`): Next.js 14 admin dashboard with Tailwind CSS 3, proxies API via catch-all route handler
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
        routes/       12 route files (equipment, bookings, estimates, finance, etc.)
        services/     Business logic (bookings, analyses, equipmentMatcher, gemini, smetaExport/, vision/)
        queue/        BullMQ connection, worker, queue definitions
        utils/        Helpers (dates, errors, decimal serialization)
      prisma/         schema.prisma (18 models), migrations, seed.ts
      scripts/        One-off import/sync scripts (SvetoBaza catalog)
      assets/fonts/   DejaVu fonts for PDF Cyrillic support
    web/          Next.js 14 + React 18 + Tailwind CSS 3
      app/            Pages: bookings, equipment, finance, admin, crew-calculator, settings
      app/api/        Catch-all proxy to Express backend
      src/lib/        Shared logic: api client, formatting
      src/components/ AppShell, StatusBadge
    bot/          Telegraf 4 + AI booking (API-backed matching)
      src/scenes/     booking (hub-and-spoke), crewCalc, photoAnalysis wizard scenes
      src/services/   llm (equipment matching via API), api client, logger
  packages/
    shared/       @light-rental/shared — crewCalculator + crewRates (dual CJS/ESM via tsup)
```

**Request flow:** Browser -> Next.js `/api/[...path]` proxy -> Express :4000 -> Prisma/SQLite
**Bot flow:** Telegram -> Telegraf scenes (hub-and-spoke booking) -> Express API (parseGafferReview) + inline confirmations
**AI analysis flow:** Photo -> BullMQ queue -> Gemini 2.5 Flash vision -> equipmentMatcher -> catalog estimate

## Key Files

| File | Purpose |
|------|---------|
| `apps/api/src/app.ts` | Express app: middleware stack + centralized error handler |
| `apps/api/src/index.ts` | Server start, conditional Redis/BullMQ worker bootstrap |
| `apps/api/prisma/schema.prisma` | 19 models (incl. SlangAliasSource enum) -- source of truth for data layer |
| `apps/api/src/services/gemini.ts` | Gemini 2.5 Flash: photo analysis + diagram generation |
| `apps/api/src/services/equipmentMatcher.ts` | AI output to catalog matching (~530 lines, DB-driven aliases via SlangAlias) |
| `apps/api/scripts/migrate-aliases-to-db.ts` | One-time migration: TYPE_SYNONYMS → SlangAlias DB records |
| `apps/api/src/services/smetaExport/renderPdf.ts` | PDF estimate export via pdfkit |
| `apps/api/src/services/smetaExport/renderXlsx.ts` | XLSX estimate export via exceljs |
| `apps/api/src/routes/bookingRequestParser.ts` | Gemini AI gaffer text -> equipment list parsing (used by web); match-equipment endpoint (used by bot, no LLM) |
| `apps/bot/src/scenes/booking.ts` | Hub-and-spoke booking scene (~1000 LOC): hub step is central cart screen, spokes: catalog, inline needsReview confirmations |
| `apps/bot/src/services/api.ts` | Bot API client: gaffer review types (GafferReviewItem, GafferMatchCandidate), parseGafferReview() |
| `apps/bot/src/services/llm.ts` | Equipment matching via parseGafferReview API (3-tier: resolved/needsReview/unmatched), date parsing |
| `apps/api/src/middleware/apiKeyAuth.ts` | API key auth middleware (warn/enforce modes, X-API-Key header) |
| `apps/api/src/middleware/rateLimiter.ts` | Rate limiter: 100 req/min per IP (express-rate-limit) |
| `packages/shared/src/crewCalculator.ts` | Shared crew cost calculator (imported by web + bot) |
| `apps/bot/src/scenes/booking-helpers.ts` | Extracted pure functions from booking scene |
| `apps/web/app/api/[...path]/route.ts` | Catch-all API proxy with connection error handling |
| `apps/web/app/admin/page.tsx` | Admin panel (1,024 lines) -- slang learning review |
| `ecosystem.config.js` | PM2 process definitions for api (:4000) + rental-bot |
| `deploy.sh` | Build + deploy script (builds shared first; supports --api, --web, --rental-bot flags) |

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
npm test                          # run all (shared + bot + api)
npm run test -w apps/api          # API smoke tests only (17 tests)
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

## Known Issues

1. **~~No authentication~~** — RESOLVED: `apiKeyAuth` middleware enforces `X-API-Key` header (`AUTH_MODE=warn|enforce`).
2. **~~Crew calculator duplication~~** — RESOLVED: extracted to `packages/shared` (`@light-rental/shared`).
3. **~~Minimal test coverage~~** — RESOLVED: 102 tests across shared, bot (booking-helpers), and API smoke tests.
4. **~~Hardcoded aliases~~** — RESOLVED: TYPE_SYNONYMS migrated to SlangAlias DB table, auto-learning enabled.
5. **Production `web` PM2 process unstable** — investigate 8646+ restarts, likely needs `npm run build` in deploy.

<!-- updated-by-superflow:2026-04-03 -->
