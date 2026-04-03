# Implementation Plan: Infrastructure Hardening

Reference: [Spec](../specs/2026-04-03-infra-hardening-design.md) | [Brief](../specs/2026-04-03-infra-hardening-brief.md)

## Sprint 1: API Key Auth Middleware + Rate Limiter [complexity: medium]
files: apps/api/src/middleware/apiKeyAuth.ts, apps/api/src/middleware/rateLimiter.ts, apps/api/src/app.ts, apps/api/package.json, apps/api/.env.example
depends_on: []

1. `npm install express-rate-limit -w apps/api`
2. Create `apps/api/src/middleware/rateLimiter.ts`:
   - Import `rateLimit` from `express-rate-limit`
   - 100 req/min per IP, message in Russian, code `RATE_LIMITED`
   - Skip if `process.env.RATE_LIMIT_DISABLED === 'true'` (for tests)
3. Create `apps/api/src/middleware/apiKeyAuth.ts`:
   - Read `API_KEYS` from env → comma-split → `Set<string>`
   - Read `AUTH_MODE` from env (default: `warn` — безопасный деплой)
   - If `API_KEYS` empty + enforce → log CRITICAL at import time, reject all
   - If `API_KEYS` empty + warn → log WARNING, пропускать все запросы
   - Check `X-API-Key` header (or `Authorization: Bearer <key>`)
   - Use `crypto.timingSafeEqual()` for comparison (iterate Set, compare each)
   - If warn mode → log unauthorized but pass through
   - If enforce → 401 JSON response
4. Update `apps/api/src/app.ts`:
   - Import rateLimiter and apiKeyAuth
   - Mount: rateLimiter → health check → apiKeyAuth → router
5. Update `apps/api/.env.example`: add `API_KEYS`, `AUTH_MODE=warn` (default warn для безопасного деплоя)
6. Commit: `feat(api): add API key auth middleware and rate limiter`

## Sprint 2: Wire Auth to Web Proxy + Bot Client [complexity: simple]
files: apps/web/app/api/[...path]/route.ts, apps/bot/src/services/api.ts, apps/web/.env.local, apps/bot/.env
depends_on: [1]

1. Update `apps/web/app/api/[...path]/route.ts`:
   - In `proxy()`, after building `outHeaders`, add: `outHeaders.set('X-API-Key', process.env.API_KEY ?? '')`
   - Variable name `API_KEY` (no `NEXT_PUBLIC_` prefix)
2. Update `apps/bot/src/services/api.ts`:
   - In `apiFetch()`: add `'X-API-Key': process.env.API_KEY ?? ''` to headers
   - In `fetchPricelistBuffer()`: add `X-API-Key` header to fetch call
   - In `uploadAnalysisFile()`: add `X-API-Key` header to fetch call
   - In `analyzePhoto()`: add `X-API-Key` header to fetch call
3. Add/update `.env.example` files for web and bot with `API_KEY` placeholder
4. **Заметка оператору**: после деплоя Sprint 2 проверить логи API на отсутствие warn-сообщений, затем переключить `AUTH_MODE=enforce` в production `.env`
5. Commit: `feat(web,bot): inject API key in proxy and bot API client`

## Sprint 3: Shared crewCalculator Package [complexity: medium]
files: packages/shared/src/index.ts, packages/shared/src/crewCalculator.ts, packages/shared/src/crewRates.ts, packages/shared/package.json, packages/shared/tsconfig.json, packages/shared/tsup.config.ts, packages/shared/vitest.config.ts, packages/shared/__tests__/crewCalculator.test.ts, apps/web/src/lib/crewCalculator.ts, apps/web/src/lib/crewRates.ts, apps/web/src/lib/crewCalculator.test.ts, apps/bot/src/lib/crewCalculator.ts, apps/bot/src/lib/crewRates.ts, apps/bot/src/scenes/crewCalc.ts, apps/web/app/crew-calculator/page.tsx, apps/web/next.config.mjs, apps/web/package.json, apps/bot/package.json, package.json, deploy.sh
depends_on: []

1. Create `packages/shared/` directory structure
2. Copy `apps/web/src/lib/crewRates.ts` → `packages/shared/src/crewRates.ts`
3. Copy `apps/web/src/lib/crewCalculator.ts` → `packages/shared/src/crewCalculator.ts`
4. Create `packages/shared/src/index.ts` — barrel export: re-export ALL symbols from both files (including `ROLES_BY_ID`, types)
5. Create `packages/shared/package.json` (name: `@light-rental/shared`, dual CJS/ESM exports)
6. Create `packages/shared/tsconfig.json` (extends root tsconfig.base.json)
7. Create `packages/shared/tsup.config.ts` (entry: src/index.ts, format: cjs+esm, dts: true)
8. `npm install tsup vitest -D -w packages/shared`
9. Create `packages/shared/vitest.config.ts`
10. Copy `apps/web/src/lib/crewCalculator.test.ts` → `packages/shared/__tests__/crewCalculator.test.ts`, update imports
11. Run `npm run build -w packages/shared` — verify dual output
12. Run `npm run test -w packages/shared` — verify 33 tests pass
13. Add `@light-rental/shared` dependency to `apps/web/package.json` and `apps/bot/package.json`
14. Update `apps/web/next.config.mjs`: add `transpilePackages: ['@light-rental/shared']`
15. Update `apps/web/app/crew-calculator/page.tsx`: change imports to `@light-rental/shared`
16. Update `apps/bot/src/scenes/crewCalc.ts`: change imports to `@light-rental/shared`
17. Delete: `apps/web/src/lib/crewCalculator.ts`, `apps/web/src/lib/crewRates.ts`, `apps/web/src/lib/crewCalculator.test.ts`
18. Delete: `apps/bot/src/lib/crewCalculator.ts`, `apps/bot/src/lib/crewRates.ts`
19. Update `apps/web/package.json`: remove or update test script (test moved to shared)
20. Update root `package.json`: build script adds `packages/shared` first. НЕ трогать test script — он будет обновлён в Sprint 5 (единая точка для всех тестов)
21. Update `deploy.sh`: add `cd "$ROOT/packages/shared" && npm run build` before consumer builds
22. Run `npm run build` from root — verify all apps compile
23. Commit: `refactor: extract crewCalculator into @light-rental/shared package`

## Sprint 4: Bot Booking Helper Extraction + Tests [complexity: medium]
files: apps/bot/src/scenes/booking-helpers.ts, apps/bot/src/scenes/booking-helpers.test.ts, apps/bot/src/scenes/booking.ts, apps/bot/package.json, apps/bot/vitest.config.ts
depends_on: []

1. Add `vitest` to `apps/bot/package.json` devDependencies (if not already from Sprint 3)
2. Add `"test": "vitest run"` to `apps/bot/package.json` scripts
2a. Create `apps/bot/vitest.config.ts` (CJS-compatible config)
3. Create `apps/bot/src/scenes/booking-helpers.ts`:
   - Extract: `DISCOUNT`, `today`, `fmtItem`, `fmtList`, `totalCost`, `fmtPrice`, `buildItems`, `mergeItems`
   - Export all functions and constant
4. Update `apps/bot/src/scenes/booking.ts`:
   - Replace inline definitions with imports from `./booking-helpers`
   - Verify no behavioral changes
5. Create `apps/bot/src/scenes/booking-helpers.test.ts`:
   - `fmtItem`: with/without index
   - `fmtList`: empty, multiple items, numbered vs bullet
   - `totalCost`: 1 day, multi-day, empty items, start===end
   - `fmtPrice`: integer, rounding
   - `buildItems`: normal, qty=0 filtered, unknown equipmentId filtered, empty
   - `mergeItems`: dedup+sum, cap at availableQuantity, empty incoming, empty existing
6. Run `npm run test -w apps/bot` — verify all pass
7. Commit: `feat(bot): extract booking helpers and add unit tests`

## Sprint 5: API Smoke Tests [complexity: medium]
files: apps/api/src/__tests__/setup.ts, apps/api/src/__tests__/api.test.ts, apps/api/vitest.config.ts, apps/api/package.json
depends_on: [1]

1. Verify `vitest`, `supertest`, `@types/supertest` in `apps/api/package.json` devDependencies — install if missing
2. Update `apps/api/vitest.config.ts`: add `setupFiles: ['./src/__tests__/setup.ts']`
3. Create `apps/api/src/__tests__/setup.ts`:
   - Set `process.env.DATABASE_URL = 'file:./test.db'` (temp file, NOT `:memory:` — in-memory DB не переживает process boundary с `execSync`)
   - Set `process.env.RATE_LIMIT_DISABLED = 'true'`
   - Set `process.env.API_KEYS = 'test-key-1,test-key-2'`
   - Set `process.env.AUTH_MODE = 'enforce'`
   - Run `execSync('npx prisma db push --skip-generate --force-reset', { cwd: 'путь к apps/api' })`
   - В `afterAll`: удалить `test.db` файл
   - Export app
4. Create `apps/api/src/__tests__/api.test.ts`:
   - Auth: 401 without key, 200 with key, wrong key → 401
   - Health: GET /health — 200 without key
   - Equipment: GET /api/equipment — 200
   - Availability: GET /api/availability?start=...&end=... — 200
   - Bookings: POST /api/bookings/draft + GET /api/bookings
   - Estimates: GET /api/estimates — 200
   - Pricelist: GET /api/pricelist — 200 or 404
   - Finance: GET /api/finance/dashboard — 200
   - Users: POST /api/users/upsert
   - Analyses: POST /api/analyses/pending
   - Equipment Import: POST /api/equipment/import — 400 (no file)
   - Booking Parser: POST /api/bookings/parse-gaffer-review — 400 (no body)
   - Slang Learning: GET /api/admin/slang-learning/candidates — 200
   - Photo Analysis: POST /api/photo-analysis — 400 (no file)
5. Run `npm run test -w apps/api` — verify all pass
6. Update root `package.json` test script — финальная версия: `npm run test -w packages/shared && npm run test -w apps/bot && npm run test -w apps/api`
7. Add `test.db` to `.gitignore` (если ещё нет)
8. Commit: `test(api): add smoke tests for all route groups with auth validation`

## Sprint Dependency Graph

```
Wave 1: [Sprint 1, Sprint 3, Sprint 4] — parallel (independent files)
Wave 2: [Sprint 2, Sprint 5] — parallel (Sprint 2 depends on 1, Sprint 5 depends on 1)
Estimated speedup: 5 sprints → 2 waves
```

## Summary

| Sprint | Description | Files | Complexity |
|--------|-------------|-------|------------|
| 1 | Auth middleware + rate limiter | 5 | medium |
| 2 | Wire auth to web/bot consumers | 4 | simple |
| 3 | Shared crewCalculator package | 20 | medium |
| 4 | Booking helper extraction + tests | 4 | medium |
| 5 | API smoke tests | 4 | medium |

Total: 5 sprints, 2 waves, 5 PRs.
