# Technical Design: Infrastructure Hardening

Reference: [Product Brief](./2026-04-03-infra-hardening-brief.md)

## Overview

Четыре направления работ:
1. **API Key Auth** — middleware для Express API + подключение потребителей (web proxy, bot)
2. **Shared crewCalculator** — извлечение в `packages/shared` с dual CJS/ESM
3. **Bot booking tests** — извлечение чистых функций из booking.ts + unit-тесты
4. **API smoke tests** — supertest + SQLite in-memory для валидации auth и основных эндпоинтов

## 1. API Key Authentication

### Architecture

```
Request → express-rate-limit → apiKeyAuth middleware → router
                                    ↓ (fail)
                                  401 JSON
```

**Middleware** (`apps/api/src/middleware/apiKeyAuth.ts`):
- Читает `API_KEYS` из env (запятая-разделённый список) → `Set<string>`
- Проверяет заголовок `X-API-Key` (или `Authorization: Bearer <key>`)
- Публичные маршруты (allowlist): `GET /health`
- Режим работы: `AUTH_MODE=warn|enforce` (env). В warn логирует, но пропускает. Default: `warn` (безопасный деплой — не ломает прод при забытых env vars)
- **Если `API_KEYS` пуст/не задан и `AUTH_MODE=enforce`**: отклонять все запросы + логировать `CRITICAL: API_KEYS not configured, rejecting all requests` при старте. Не допускать тихий bypass.
- Ответ при отказе: `{ "message": "Неверный или отсутствующий API-ключ", "code": "UNAUTHORIZED" }` (401)
- Сравнение ключей через `crypto.timingSafeEqual()` (защита от timing attacks)

**Rate limiter** (`apps/api/src/middleware/rateLimiter.ts`):
- `express-rate-limit`, 100 req/min per IP
- Ответ: `{ "message": "Слишком много запросов, попробуйте позже", "code": "RATE_LIMITED" }` (429)

### Mounting order in app.ts

```typescript
// После helmet, cors, morgan, json parser:
app.use(rateLimiter);       // 1. Rate limit (до auth — блокирует brute-force)
app.get("/health", ...);    // 2. Health check (до auth)
app.use(apiKeyAuth);        // 3. Auth (до router)
app.use(router);            // 4. Router
```

### Consumer changes

**Web proxy** (`apps/web/app/api/[...path]/route.ts`):
- В `outHeaders` добавляем `X-API-Key` из `process.env.API_KEY` (серверная переменная, НЕ `NEXT_PUBLIC_`)

**Bot API client** (`apps/bot/src/services/api.ts`):
- В `apiFetch()` добавляем заголовок `X-API-Key` из `process.env.API_KEY`
- В функциях с прямым `fetch()` (`analyzePhoto`, `uploadAnalysisFile`, `fetchPricelistBuffer`) — тоже добавляем заголовок

### Env changes

| File | Variable | Value |
|------|----------|-------|
| `apps/api/.env` | `API_KEYS` | `key1,key2` (массив для ротации) |
| `apps/api/.env` | `AUTH_MODE` | `warn` или `enforce` |
| `apps/web/.env.local` | `API_KEY` | `key1` |
| `apps/bot/.env` | `API_KEY` | `key1` |
| `apps/api/.env.example` | `API_KEYS` | `your_api_key_here` |
| `apps/api/.env.example` | `AUTH_MODE` | `enforce` |
| `apps/web/.env.example` | `API_KEY` | `your_api_key_here` |
| `apps/bot/.env.example` | `API_KEY` | `your_api_key_here` |

### Deploy script update

`deploy.sh` строит приложения по отдельности (`cd apps/api && npm run build`), не через root scripts. Необходимо добавить сборку `packages/shared` **до** сборки потребителей:
```bash
# В начале build секции deploy.sh, перед сборкой api/web/bot:
cd "$ROOT/packages/shared" && npm run build
```

### New dependency

- `express-rate-limit` in `apps/api/package.json`

## 2. Shared crewCalculator Package

### Package structure

```
packages/
  shared/
    src/
      crewCalculator.ts   ← из apps/web/src/lib/crewCalculator.ts
      crewRates.ts         ← из apps/web/src/lib/crewRates.ts
      index.ts             ← barrel export
    package.json
    tsconfig.json
    tsup.config.ts
    vitest.config.ts
    __tests__/
      crewCalculator.test.ts ← из apps/web/src/lib/crewCalculator.test.ts
```

### package.json

```json
{
  "name": "@light-rental/shared",
  "version": "0.0.1",
  "private": true,
  "main": "./dist/index.cjs",
  "module": "./dist/index.mjs",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.mjs",
      "require": "./dist/index.cjs",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "test": "vitest run"
  }
}
```

### Build with tsup

```typescript
// tsup.config.ts
import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
});
```

### Consumer migration

- `apps/web`: `import { calculateCrewCost } from "@light-rental/shared"` — добавить `transpilePackages: ['@light-rental/shared']` в `next.config.mjs`
- `apps/bot`: `import { calculateCrewCost } from "@light-rental/shared"` — CJS resolve через `main`
- **Важно**: `apps/bot/src/scenes/crewCalc.ts` импортирует `ROLES_BY_ID` напрямую из `crewRates`. Barrel export (`index.ts`) должен экспортировать ВСЕ публичные символы из обоих файлов, включая `ROLES_BY_ID`, `ROLES`, типы `RoleId`, `RoleConfig`, `CrewInput`, `RoleBreakdown`, `CrewResult`
- Удалить: `apps/web/src/lib/crewCalculator.ts`, `apps/web/src/lib/crewRates.ts`, `apps/bot/src/lib/crewCalculator.ts`, `apps/bot/src/lib/crewRates.ts`
- Удалить: `apps/web/src/lib/crewCalculator.test.ts`
- Очистить: `apps/web/package.json` test script (тест переехал в shared)

**Примечание**: каталог `packages/` не существует на диске — его нужно создать. `packages/db` тоже не существует (несмотря на упоминание в CLAUDE.md) — удалять нечего.

### Build order update

Root `package.json` scripts:
```json
"build": "npm run build -w packages/shared && npm run build -w apps/api && npm run build -w apps/web && npm run build -w apps/bot"
```

Root test script:
```json
"test": "npm run test -w packages/shared && npm run test -w apps/web"
```

## 3. Bot Booking Helper Extraction + Tests

### Extraction

Из `apps/bot/src/scenes/booking.ts` извлечь в `apps/bot/src/scenes/booking-helpers.ts`:

| Function | Signature | Purpose |
|----------|-----------|---------|
| `fmtItem` | `(i: MatchedItem, idx?: number) => string` | Форматирование позиции |
| `fmtList` | `(items: MatchedItem[], numbered?: boolean) => string` | Форматирование списка |
| `totalCost` | `(items: MatchedItem[], start: string, end: string) => number` | Расчёт полной стоимости |
| `fmtPrice` | `(full: number) => string` | Строка цены со скидкой |
| `buildItems` | `(rawMatched, catalog) => MatchedItem[]` | Сборка MatchedItem из матча + каталога |
| `mergeItems` | `(existing: MatchedItem[], incoming: MatchedItem[]) => MatchedItem[]` | Слияние позиций корзины (дедупликация, суммирование qty, cap по availableQuantity) |
| `today` | `() => string` | Текущая дата ISO |
| `DISCOUNT` | constant `0.5` | Скидка |

`booking.ts` будет импортировать из `./booking-helpers` — никаких изменений поведения.

### Test file

`apps/bot/src/scenes/booking-helpers.test.ts` с vitest:

**Тест-кейсы:**
- `fmtItem`: одна позиция, с индексом и без
- `fmtList`: пустой список, несколько позиций, numbered vs bullet
- `totalCost`: 1 день, многодневный, пустые items, start === end (min 1 day)
- `fmtPrice`: целые числа, округление скидки
- `buildItems`: нормальный случай, quantity=0 фильтруется, equipmentId не в каталоге фильтруется, пустой вход
- `mergeItems`: слияние с дедупликацией, суммирование qty, cap по availableQuantity, пустой incoming, пустой existing

### Bot package changes

- Добавить `vitest` в `apps/bot/package.json` devDependencies
- Добавить `"test": "vitest run"` в scripts
- Обновить root `test` script: `"test": "npm run test -w packages/shared && npm run test -w apps/bot"`

## 4. API Smoke Tests

### Setup

`apps/api/src/__tests__/setup.ts`:
- Устанавливает `DATABASE_URL=file::memory:` перед импортом Prisma
- Запускает `prisma db push` программно (или через `execSync`)
- Экспортирует `app` из `../app`

### Test structure

`apps/api/src/__tests__/api.test.ts`:

| Test group | Tests |
|------------|-------|
| Auth | 401 без ключа, 200 с ключом, rate limit (mock) |
| Health | GET /health — 200 без ключа |
| Equipment | GET /api/equipment — 200, пустой список |
| Availability | GET /api/availability?start=...&end=... — 200 |
| Bookings | POST /api/bookings/draft + GET /api/bookings — round trip |
| Estimates | GET /api/estimates — 200 |
| Pricelist | GET /api/pricelist — 200 or 404 |
| Finance | GET /api/finance/dashboard — 200 |
| Equipment Import | POST /api/equipment/import — 400 (no file) |
| Booking Parser | POST /api/bookings/parse-gaffer-review — 400 (no body) |
| Users | POST /api/users/upsert — round trip |
| Analyses | POST /api/analyses/pending — round trip |
| Slang Learning | GET /api/admin/slang-learning/candidates — 200 |
| Photo Analysis | POST /api/photo-analysis — 400 (no file) |

### Rate limiter в тестах

Отключить rate limiter в тестовом окружении: в `setup.ts` установить `process.env.RATE_LIMIT_DISABLED=true`, middleware проверяет эту переменную и пропускает при `true`.

### API package changes

- `vitest`, `supertest`, `@types/supertest` уже есть в devDependencies — проверить наличие
- Проверить наличие `"test": "vitest run"` в scripts
- Обновить root `test` script

## File-Level Changes Summary

### New files
| File | Purpose |
|------|---------|
| `apps/api/src/middleware/apiKeyAuth.ts` | API key validation middleware |
| `apps/api/src/middleware/rateLimiter.ts` | express-rate-limit wrapper |
| `apps/api/src/__tests__/setup.ts` | Test setup (in-memory DB + app) |
| `apps/api/src/__tests__/api.test.ts` | API smoke tests |
| `apps/bot/src/scenes/booking-helpers.ts` | Extracted pure functions |
| `apps/bot/src/scenes/booking-helpers.test.ts` | Unit tests for helpers |
| `packages/shared/src/index.ts` | Barrel export |
| `packages/shared/src/crewCalculator.ts` | Shared calculator |
| `packages/shared/src/crewRates.ts` | Shared rates |
| `packages/shared/package.json` | Package config |
| `packages/shared/tsconfig.json` | TS config |
| `packages/shared/tsup.config.ts` | Build config |
| `packages/shared/vitest.config.ts` | Test config |
| `packages/shared/__tests__/crewCalculator.test.ts` | Moved tests |

### Modified files
| File | Change |
|------|--------|
| `apps/api/src/app.ts` | Mount rateLimiter + apiKeyAuth middleware |
| `apps/api/package.json` | Add express-rate-limit, vitest, supertest |
| `apps/api/.env.example` | Add API_KEYS, AUTH_MODE |
| `apps/web/app/api/[...path]/route.ts` | Inject X-API-Key header |
| `apps/web/src/lib/crewCalculator.ts` | DELETE (moved to shared) |
| `apps/web/src/lib/crewRates.ts` | DELETE (moved to shared) |
| `apps/web/src/lib/crewCalculator.test.ts` | DELETE (moved to shared) |
| `apps/web/app/crew-calculator/page.tsx` | Update import path |
| `apps/web/next.config.mjs` | Add transpilePackages |
| `apps/web/package.json` | Add @light-rental/shared dependency |
| `apps/bot/src/scenes/booking.ts` | Import helpers from ./booking-helpers |
| `apps/bot/src/services/api.ts` | Add X-API-Key header |
| `apps/bot/src/lib/crewCalculator.ts` | DELETE (moved to shared) |
| `apps/bot/src/lib/crewRates.ts` | DELETE (moved to shared) |
| `apps/bot/src/scenes/crewCalc.ts` | Update import path |
| `apps/bot/package.json` | Add vitest, @light-rental/shared |
| `package.json` | Update build/test scripts, verify workspaces |

### Deleted files
- `apps/web/src/lib/crewCalculator.ts`
- `apps/web/src/lib/crewRates.ts`
- `apps/web/src/lib/crewCalculator.test.ts`
- `apps/bot/src/lib/crewCalculator.ts`
- `apps/bot/src/lib/crewRates.ts`
- ~~`packages/db/`~~ — не существует на диске, удалять нечего. Убрать из Known Issues в CLAUDE.md.

## Edge Cases and Error Handling

1. **Auth deploy race**: AUTH_MODE=warn позволяет включить middleware до обновления потребителей
2. **Missing API_KEYS env + enforce**: middleware отклоняет ВСЕ запросы + CRITICAL лог при старте. В warn mode — пропускает с предупреждением.
3. **Key rotation**: API_KEYS принимает массив — добавляем новый ключ, обновляем потребителей, убираем старый
4. **NEXT_PUBLIC_ leak prevention**: переменная `API_KEY` без префикса — не попадает в клиентский бандл
5. **SQLite in-memory для тестов**: каждый test suite получает чистую БД, нет конфликтов
6. **Empty items в buildItems**: возвращает пустой массив, тест покрывает
7. **start === end date в totalCost**: Math.max(1, ...) гарантирует минимум 1 день

## Testing Strategy

| Scope | Tool | What validates |
|-------|------|----------------|
| packages/shared | vitest | crewCalculator math (33 existing tests) |
| apps/bot helpers | vitest | booking pure functions (fmtItem, totalCost, buildItems, etc.) |
| apps/api smoke | vitest + supertest | auth middleware, rate limiter, all route groups |
| Build | `npm run build` | shared package CJS/ESM output, consumer imports |

## Out of Scope

- JWT / session auth / user management
- Frontend login UI
- Telegraf scene transition tests (mock context)
- Booking scene modularization (splitting into sub-files)
- Redis-dependent tests (BullMQ worker)
- Migration safety (prisma db push vs migrate)
