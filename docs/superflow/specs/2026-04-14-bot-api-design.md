# Technical Design: Bot API & Documentation

**Brief:** [2026-04-14-bot-api-brief.md](./2026-04-14-bot-api-brief.md)
**Charter:** [2026-04-14-bot-api-charter.md](./2026-04-14-bot-api-charter.md)

## Overview

Довести существующий REST API до состояния «готов к подключению внешнего Telegram-бота на OpenAI». Три функциональных добавления (scope guard для бот-ключей, GET /api/finance/debts, dryRun для бронирований) + полный пакет документации (docs/bot-api.md + JSON-схемы для function-calling).

Никаких изменений в Prisma-схеме. Никаких новых моделей. Всё — на существующих полях `Booking.amountOutstanding`, `Booking.expectedPaymentDate`, `Booking.paymentStatus`, `Booking.finalAmount`, `Booking.amountPaid`.

## 1. Data Model Changes

**Нет.** Все нужные поля уже есть в `Booking`:
- `finalAmount` — итоговая сумма
- `amountPaid` — сколько заплачено
- `amountOutstanding` — сколько должны (пересчитывается `recomputeBookingFinance()`)
- `expectedPaymentDate` — плановая дата платежа
- `paymentStatus` (enum: `NOT_PAID | PARTIALLY_PAID | PAID | OVERDUE`)
- `status` (enum: `DRAFT | CONFIRMED | ISSUED | RETURNED | CANCELLED`)

Агрегация выполняется на лету в сервисе.

## 2. API Changes

### 2.1 Middleware `botScopeGuard`

Новый файл: `apps/api/src/middleware/botScopeGuard.ts`

**Правило:** если ключ начинается с `openclaw-`, разрешены только роуты из whitelist. Всё остальное — 403.

```typescript
// Псевдокод контракта
export function botScopeGuard(req, res, next) {
  const key = extractApiKey(req);
  if (!key) return next();                   // апи-аутентификация уже проверена apiKeyAuth
  if (!key.startsWith("openclaw-")) return next(); // не бот-ключ — пропускаем

  const method = req.method.toUpperCase();
  const path = req.path; // e.g. "/api/bookings/abc"

  // DELETE глобально запрещён для бот-ключей
  if (method === "DELETE") {
    return res.status(403).json({
      message: "Bot keys are not allowed to delete",
      code: "BOT_SCOPE_FORBIDDEN",
    });
  }

  // Whitelist по методу+префиксу
  if (!isAllowedForBot(method, path)) {
    return res.status(403).json({
      message: "Bot key does not have access to this endpoint",
      code: "BOT_SCOPE_FORBIDDEN",
    });
  }

  next();
}
```

### 2.2 Whitelist для `openclaw-*` ключей

| Метод | Префикс | Цель |
|-------|---------|------|
| GET | `/api/equipment` | Каталог для подбора оборудования ботом |
| GET | `/api/availability` | Проверка доступности |
| GET | `/api/bookings` | Список броней + чтение конкретной |
| POST | `/api/bookings/draft` | Создание DRAFT-брони |
| POST | `/api/bookings/quote` | Предварительный расчёт сметы |
| PATCH | `/api/bookings/:id` | Редактирование брони |
| POST | `/api/bookings/:id/status` | Смена статуса (confirm/issue/return/cancel) |
| POST | `/api/bookings/:id/confirm` | Подтверждение брони |
| POST | `/api/bookings/match-equipment` | Поиск оборудования по описанию (уже используется ботом) |
| POST | `/api/bookings/parse-gaffer-review` | Парсинг текста от гаффера |
| GET | `/api/finance/debts` | Агрегация долгов (новый эндпоинт) |
| GET | `/api/finance/dashboard` | Финансовые метрики |
| GET | `/api/receivables` | Плоский список дебиторки |
| GET | `/api/payments` | Список платежей |

**Запрещено для `openclaw-*` (403):**
- Всё, что не в whitelist (по умолчанию deny)
- Все DELETE
- `/api/admin-users/*`, `/api/admin/slang-learning/*`, `/api/warehouse/*`, `/api/users/*`
- `/api/photo-analysis/*`, `/api/analyses/*`, `/api/import-sessions/*`, `/api/pricelist/*`
- `/api/equipment/import/*`

**Реализация whitelist:**
```typescript
// Порядок имеет значение: сначала более специфичные (POST /api/bookings/draft) до /api/bookings
const BOT_WHITELIST: Array<{ method: string; pattern: RegExp }> = [
  { method: "GET",    pattern: /^\/api\/equipment(\/[^/]+)?$/ },
  { method: "GET",    pattern: /^\/api\/availability(\/.*)?$/ },
  { method: "GET",    pattern: /^\/api\/bookings(\/[^/]+)?$/ },
  { method: "POST",   pattern: /^\/api\/bookings\/draft$/ },
  { method: "POST",   pattern: /^\/api\/bookings\/quote$/ },
  { method: "POST",   pattern: /^\/api\/bookings\/match-equipment$/ },
  { method: "POST",   pattern: /^\/api\/bookings\/parse-gaffer-review$/ },
  { method: "PATCH",  pattern: /^\/api\/bookings\/[^/]+$/ },
  { method: "POST",   pattern: /^\/api\/bookings\/[^/]+\/status$/ },
  { method: "POST",   pattern: /^\/api\/bookings\/[^/]+\/confirm$/ },
  { method: "GET",    pattern: /^\/api\/finance\/debts$/ },
  { method: "GET",    pattern: /^\/api\/finance\/dashboard$/ },
  { method: "GET",    pattern: /^\/api\/receivables$/ },
  { method: "GET",    pattern: /^\/api\/payments(\/[^/]+)?$/ },
];
```

Middleware монтируется в `app.ts` **после** `apiKeyAuth`:
```typescript
app.use(apiKeyAuth);
app.use(sessionParser);
app.use(botScopeGuard);   // NEW
app.use(router);
```

### 2.3 Endpoint `GET /api/finance/debts`

Новый обработчик в существующем `apps/api/src/routes/finance.ts`.

**Логика (сервисная функция `computeDebts()` в `apps/api/src/services/finance.ts`):**

1. Выбрать все брони со статусом ≠ `CANCELLED` и `amountOutstanding > 0`:
   ```typescript
   const bookings = await prisma.booking.findMany({
     where: {
       status: { not: "CANCELLED" },
       amountOutstanding: { gt: 0 },
     },
     include: { client: true },
     orderBy: { expectedPaymentDate: "asc" },
   });
   ```
2. Сгруппировать по `clientId`:
   - `totalOutstanding` = сумма `amountOutstanding`
   - `maxDaysOverdue` = max(today − `expectedPaymentDate`) среди просроченных броней (по положительным дельтам)
   - `overdueAmount` = сумма `amountOutstanding` для броней, где `paymentStatus === "OVERDUE"` ИЛИ `expectedPaymentDate < today`
   - `projects`: массив { bookingId, projectName, amountOutstanding, daysOverdue, expectedPaymentDate, status }
3. Отсортировать клиентов по `totalOutstanding` desc.
4. Сериализовать все Decimal через `.toString()`.

**Response:**
```json
{
  "debts": [
    {
      "clientId": "c123",
      "clientName": "Ромашка Продакшн",
      "totalOutstanding": "48000.00",
      "overdueAmount": "15000.00",
      "maxDaysOverdue": 12,
      "bookingsCount": 3,
      "projects": [
        {
          "bookingId": "b001",
          "projectName": "Клип Иванов",
          "amountOutstanding": "15000.00",
          "expectedPaymentDate": "2026-04-02T00:00:00.000Z",
          "daysOverdue": 12,
          "paymentStatus": "OVERDUE",
          "bookingStatus": "RETURNED"
        }
      ]
    }
  ],
  "summary": {
    "totalClients": 5,
    "totalOutstanding": "187500.00",
    "totalOverdue": "54000.00",
    "asOf": "2026-04-14T11:00:00.000Z"
  }
}
```

**Query params (необязательные):**
- `?overdueOnly=true` — вернуть только клиентов с `overdueAmount > 0`
- `?minAmount=10000` — фильтр по `totalOutstanding`

**Производительность:** типичный объём базы < 500 активных броней → один `findMany` + in-memory группировка укладывается в < 500 мс. Индекс `Booking.expectedPaymentDate` уже есть (из прошлых итераций финансов). Дополнительных индексов не требуется.

### 2.4 `dryRun` для `POST /api/bookings/draft`

Расширяем `bookingCreateSchema`:
```typescript
const bookingCreateSchema = z.object({
  // ...existing fields...
  dryRun: z.boolean().optional().default(false),
});
```

**Поведение при `dryRun: true`:**
- Все Zod-валидации выполняются как обычно (ранний выход → 422 при невалиде).
- `parseBookingRangeBound` + `assertBookingRangeOrder` выполняются.
- Вызывается существующий `quoteEstimate()` для расчёта сметы.
- Возвращается объект той же формы, что и успешный POST /bookings/draft, **но**:
  - `id`, `createdAt`, `confirmedAt`, `updatedAt` = `null`
  - `status: "DRAFT_PREVIEW"` (маркер — не настоящий статус)
  - Клиент НЕ upsert-ится (возвращается только предполагаемое `client.name/phone/...`)
  - Новый ключ в ответе: `"dryRun": true`
- Ноль записей в БД. Идеально подходит для шага «покажи что собираешься записать» в боте.

**Response:**
```json
{
  "dryRun": true,
  "booking": {
    "id": null,
    "status": "DRAFT_PREVIEW",
    "client": { "name": "Ромашка", "phone": "+7..." },
    "projectName": "Клип",
    "startDate": "2026-04-20T00:00:00.000Z",
    "endDate": "2026-04-22T00:00:00.000Z",
    "items": [...],
    "estimate": {
      "totalAfterDiscount": "45000.00",
      "shifts": 3,
      "lines": [...]
    }
  }
}
```

### 2.5 `dryRun` для `PATCH /api/bookings/:id`

Расширяем `bookingUpdateSchema` тем же `dryRun: z.boolean().optional().default(false)`.

**Поведение при `dryRun: true`:**
- Фетч существующей брони.
- Валидация дат (`assertBookingRangeOrder`) в applied-виде (с учётом patch).
- `rebuildBookingEstimate` НЕ вызывается — вместо этого используется `quoteEstimate()` на объединённых данных (существующие items + patch).
- Возвращается превью брони как если бы patch применился, без записи в БД.

**Response:** та же форма, что у обычного PATCH, но с `"dryRun": true` и без фактических изменений.

### 2.6 Whitelist против существующей аутентификации

`apiKeyAuth` в `warn`-режиме пропускает запросы без ключа. Это означает: на dev без `API_KEYS` бот-scope никогда не активируется (ключа нет → префикс не `openclaw-` → `botScopeGuard` пропускает). **Это правильное поведение для разработки.**

На продакшене (`AUTH_MODE=enforce`) каждый запрос обязан предъявить ключ. Если ключ начинается с `openclaw-`, bot scope активируется. Если с любого другого префикса (например, `web-admin-`), пропускается без ограничений.

## 3. Documentation Artifacts

### 3.1 `docs/bot-api.md` (основная дока)

Структура:
1. **Общее** — назначение, base URL, формат ответов
2. **Аутентификация** — `X-API-Key` header, формат ключа `openclaw-<random>`, как получить ключ (админ добавляет в `.env`)
3. **Scope-ограничения** — таблица whitelist, примеры 403
4. **Эндпоинты** (с примерами curl + пример ответа):
   - GET /api/equipment
   - GET /api/availability
   - POST /api/bookings/quote
   - POST /api/bookings/draft (+ dryRun)
   - PATCH /api/bookings/:id (+ dryRun)
   - POST /api/bookings/:id/status
   - POST /api/bookings/:id/confirm
   - GET /api/bookings/:id
   - GET /api/finance/debts (+ параметры)
   - GET /api/finance/dashboard
5. **Ошибки** — все коды (400, 401, 403 BOT_SCOPE_FORBIDDEN, 404, 409, 422, 500) с примерами JSON
6. **Примеры типовых сценариев**:
   - Создать бронь через dryRun → показать пользователю → подтвердить
   - Получить список долгов и отфильтровать просроченные
   - Перенести бронь на другие даты

### 3.2 `docs/bot-api-tools.json` (OpenAI function-calling схемы)

JSON-файл со списком готовых tool-definitions для OpenAI Chat Completions:

```json
{
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "list_equipment",
        "description": "Список оборудования в каталоге с фильтрами",
        "parameters": {
          "type": "object",
          "properties": {
            "search": { "type": "string", "description": "поиск по названию" },
            "category": { "type": "string" }
          }
        }
      }
    },
    {
      "type": "function",
      "function": {
        "name": "create_booking_draft",
        "description": "Создать черновик брони. Используй dryRun=true чтобы показать превью перед записью.",
        "parameters": {
          "type": "object",
          "required": ["client", "projectName", "startDate", "endDate", "items"],
          "properties": {
            "dryRun": { "type": "boolean", "default": false },
            "client": { ... },
            "projectName": { "type": "string" },
            "startDate": { "type": "string", "format": "date-time" },
            "endDate": { "type": "string", "format": "date-time" },
            "items": {
              "type": "array",
              "items": {
                "type": "object",
                "required": ["equipmentId", "quantity"],
                "properties": { ... }
              }
            }
          }
        }
      }
    },
    { "type": "function", "function": { "name": "get_debts", "description": "...", "parameters": {...} } },
    { "type": "function", "function": { "name": "update_booking", ... } },
    { "type": "function", "function": { "name": "confirm_booking", ... } },
    { "type": "function", "function": { "name": "quote_booking", ... } },
    { "type": "function", "function": { "name": "match_equipment", ... } }
  ]
}
```

Минимум 7 tools. Каждая схема — валидный JSON Schema Draft-07, готовый к вставке в `client.chat.completions.create({ tools: [...] })`.

## 4. File-Level Changes

### New files
| File | Purpose |
|------|---------|
| `apps/api/src/middleware/botScopeGuard.ts` | Bot scope enforcement |
| `apps/api/src/routes/__tests__/botScopeGuard.test.ts` | Middleware unit tests |
| `apps/api/src/routes/__tests__/financeDebts.test.ts` | Debts endpoint tests |
| `apps/api/src/routes/__tests__/bookingsDryRun.test.ts` | dryRun tests |
| `docs/bot-api.md` | Bot API documentation |
| `docs/bot-api-tools.json` | OpenAI function-calling schemas |

### Modified files
| File | Change |
|------|--------|
| `apps/api/src/app.ts` | Mount `botScopeGuard` after `apiKeyAuth` |
| `apps/api/src/routes/finance.ts` | Add `GET /finance/debts` handler |
| `apps/api/src/services/finance.ts` | Add `computeDebts()` service function |
| `apps/api/src/routes/bookings.ts` | Add `dryRun` branch in `POST /draft` and `PATCH /:id` |
| `CLAUDE.md` | Note bot scope middleware + debts endpoint + dryRun convention |
| `README.md` (если есть раздел про API) | Ссылка на `docs/bot-api.md` |

**Не трогаем:** Prisma schema, существующие роуты кроме `bookings.ts` + `finance.ts`, миддлвары кроме `app.ts` (добавление строки).

## 5. Edge Cases and Error Handling

| Edge Case | Handling |
|-----------|----------|
| Бот-ключ пытается DELETE /api/bookings/:id | 403 `{ message: "Bot keys are not allowed to delete", code: "BOT_SCOPE_FORBIDDEN" }` |
| Бот-ключ пытается POST /api/users | 403 `{ code: "BOT_SCOPE_FORBIDDEN" }` |
| Бот-ключ с опечаткой префикса (`openclow-xxx`) | Пропускается как обычный ключ — `openclaw-` проверяется строго |
| Клиент с 0 броней | Не появляется в debts |
| Бронь CANCELLED | Не попадает в debts даже при `amountOutstanding > 0` (CANCELLED брони не должны иметь долга, но на случай legacy — фильтр `status: not CANCELLED` в запросе) |
| `paidAmount > finalAmount` (переплата) | `amountOutstanding = 0` (обрезается через `Decimal.max(..., 0)` в `recomputeBookingFinance`) → не попадает в debts |
| `expectedPaymentDate = null` | `daysOverdue = null`, `paymentStatus` считается по текущей логике (не overdue без даты). В ответе такая бронь есть, но без флага просрочки |
| dryRun + невалидные даты | Стандартный 400/422 из Zod/`assertBookingRangeOrder`. БД не трогается (валидация до транзакции) |
| dryRun + несуществующий equipmentId | 400 из `quoteEstimate()` (бросает `HttpError` при неизвестном equipmentId) |
| Concurrent dryRun + реальный POST (гонка) | Не актуально: dryRun вообще не пишет в БД |
| Bot ключ запрашивает GET /api/finance/debts?minAmount=abc | 400 из Zod-парсинга query |
| Очень много клиентов с долгами (> 1000) | Limit не ставим, но сервис выдаёт всё in-memory; при необходимости в будущем добавим курсорную пагинацию |

## 6. Testing Strategy

Целевой файл: `apps/api/src/routes/__tests__/` (существует от предыдущих итераций).

| Test | Type | File |
|------|------|------|
| `botScopeGuard` пропускает неключи и web-ключи | Unit | `botScopeGuard.test.ts` |
| `botScopeGuard` отклоняет DELETE с openclaw-ключом → 403 | Unit | `botScopeGuard.test.ts` |
| `botScopeGuard` отклоняет POST /api/users с openclaw-ключом → 403 | Unit | `botScopeGuard.test.ts` |
| `botScopeGuard` пропускает GET /api/bookings с openclaw-ключом | Unit | `botScopeGuard.test.ts` |
| `GET /api/finance/debts` — агрегация по клиенту, сортировка по сумме | Integration | `financeDebts.test.ts` |
| `GET /api/finance/debts` — CANCELLED брони исключаются | Integration | `financeDebts.test.ts` |
| `GET /api/finance/debts?overdueOnly=true` — фильтр работает | Integration | `financeDebts.test.ts` |
| `GET /api/finance/debts` — `daysOverdue` корректно считается | Integration | `financeDebts.test.ts` |
| `POST /api/bookings/draft` с `dryRun:true` — не создаёт записи в БД | Integration | `bookingsDryRun.test.ts` |
| `POST /api/bookings/draft` с `dryRun:true` — возвращает корректный estimate | Integration | `bookingsDryRun.test.ts` |
| `PATCH /api/bookings/:id` с `dryRun:true` — не меняет бронь в БД | Integration | `bookingsDryRun.test.ts` |

**Итого ≥ 5 кейсов (спек требует минимум 5).** Существующий test runner: vitest (см. соседние `.test.ts`).

**Тестовая фикстура:** клиенты/брони создаются напрямую через prisma client в `beforeEach`, удаляются в `afterEach` (как в существующих API-тестах).

## 7. Security & Operational Considerations

- **Timing attack** на сравнение ключей: уже защищено `timingSafeCompare` в `apiKeyAuth`. `botScopeGuard` только читает префикс — не сравнивает секреты, timing leak не актуален.
- **Rate limit:** существующий `rateLimiter` (100 req/min per IP) применяется ко всем запросам, включая бот-ключи. Отдельного лимита по ключу не делаем в этом спринте.
- **Ротация ключа:** как и для любого API-ключа, админ меняет `API_KEYS` в `.env` и перезапускает API (ключи читаются при старте). Процесс документируется в `bot-api.md`.
- **Leak защита:** `docs/bot-api.md` НЕ содержит реальный ключ — только формат и инструкцию «сгенерируйте себе случайный `openclaw-<32 hex>`».

## 8. Out of Scope

- Реализация самого OpenAI-бота (только контракт + доки)
- Подписка на webhook-события (бронь создана, платеж пришёл) — future work
- Persistent rate limit по ключу (в Redis)
- Swagger UI / OpenAPI генератор (ручная `bot-api.md` достаточна для текущих целей)
- MCP-сервер (отдельный проект, другой протокол)
- Графики/визуализация долгов — потребляет клиент (бот или веб)
- Финансовые отчёты кроме долгов (прибыль, cashflow, топ-клиентов) — future spec
