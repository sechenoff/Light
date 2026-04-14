---
goal: "Превратить существующий REST API в контракт, пригодный для подключения внешнего Telegram-бота на OpenAI: добавить агрегированный отчёт по долгам, режим dry-run для бронирований, scope-ограничение для бот-ключей и готовую документацию + JSON-схемы для function-calling"
non_negotiables:
  - "Bot-ключи с префиксом `openclaw-` не могут делать DELETE ни на одной сущности (scope guard возвращает 403)"
  - "Bot-ключи не имеют доступа к админским роутам (`/api/admin-users`, `/api/admin/slang-learning`, `/api/warehouse/*`)"
  - "dryRun: true никогда не пишет в БД — только валидирует и возвращает расчётный payload"
  - "GET /api/finance/debts — только чтение, агрегация через существующие поля Booking (`amountOutstanding`, `finalAmount`, `amountPaid`)"
  - "Вся документация и JSON-схемы — в одном PR с кодом; docs/bot-api.md должен давать полный контракт без необходимости читать исходники"
  - "Все новые роуты под `apiKeyAuth` + `botScopeGuard` (где применимо)"
  - "Decimal-значения сериализуются через `serializeDecimal.ts` (как во всём остальном API)"
success_criteria:
  - "Bot-ключ `openclaw-*` успешно создаёт бронь через POST /api/bookings/draft и получает 403 на DELETE /api/bookings/:id"
  - "GET /api/finance/debts возвращает агрегацию (клиент + сумма + дней просрочки + разбивка по проектам) за < 500 мс"
  - "POST /api/bookings/draft + dryRun:true возвращает полный payload брони без записи в БД (проверяется через повторный GET — записи нет)"
  - "docs/bot-api.md содержит: auth, список эндпоинтов, примеры curl, коды ошибок"
  - "docs/bot-api-tools.json содержит готовые function-calling схемы, которые копируются в код OpenAI-бота без правок"
  - "Тесты: ≥ 5 кейсов (scope guard allow/deny, debts агрегация, dryRun POST, dryRun PATCH, overdue flag)"
governance_mode: "light"
---

## Scope Boundaries

**In scope (Sprint 1, single PR):**
- Middleware `botScopeGuard` — ограничение прав для ключей с префиксом `openclaw-`
- Endpoint `GET /api/finance/debts` — агрегация долгов (клиент → сумма → просрочка → проекты)
- Параметр `dryRun: true` в `POST /api/bookings/draft` и `PATCH /api/bookings/:id`
- Документация `docs/bot-api.md` (auth, эндпоинты, примеры, ошибки)
- JSON-схемы для OpenAI function-calling в `docs/bot-api-tools.json`
- Тесты на новый функционал
- Генерация `openclaw-*` ключа и инструкция по добавлению в `API_KEYS`

**Out of scope:**
- Реализация самого OpenAI-бота (только контракт + доки)
- DELETE любых сущностей через бот-ключ
- Управление учётками админов (`/api/admin-users`) через API
- MCP-сервер, OpenAPI/Swagger UI
- Финансовые отчёты кроме долгов (прибыль, cashflow, топ-клиентов)
- Изменение существующей auth-модели (JWT, session cookies остаются как есть)
- Новые Prisma-модели или миграции (долги считаются на лету)

## Forbidden Approaches

- Не добавлять DELETE-роуты или обход scope guard «ради бота» — правило должно выполняться всегда.
- Не переписывать существующие роуты под отдельный `/bot/*` префикс — это тот же API, просто с scope-ограничениями на уровне ключа.
- Не денормализовать долги в отдельную таблицу — агрегация идёт по существующим полям брони, чтобы не держать две «истины».
- Не добавлять `write`/`read`-флаги на каждый ключ в `.env` — scope логика выводится из префикса имени ключа (`openclaw-*` = bot scope).
- Не пытаться валидировать бизнес-правила отдельно для dryRun — переиспользовать существующую валидацию (Zod + `quoteEstimate`), просто не коммитить транзакцию.

## Risk Areas

- **Scope guard как единая точка отказа.** Если регулярка префикса сломается, либо бот получит всё, либо ничего. Mitigation: тесты на allow/deny по каждому правилу whitelist.
- **Decimal precision в debts.** Prisma Decimal округляется по-разному в разных драйверах — полагаемся на уже существующий `amountOutstanding`, который считается сервисом `finance.ts` и гарантированно нормализован.
- **dryRun + rebuildBookingEstimate.** Существующий `createBookingDraft` делает multiple writes (client upsert + booking + items + estimate). Решение: выполнять всё в транзакции и `tx.rollback()` по выходу, либо вынести расчёт в чистую функцию `quoteEstimate()` (уже существует и используется на `/api/bookings/quote`).
- **Документация расходится с кодом.** Mitigation: в `bot-api.md` указываем версию API, example-ответы генерируем из реальных responses, в тестах проверяем контракт по схемам из `bot-api-tools.json` (хотя бы для debts и create booking).

## Sprint Plan

**1 спринт, 1 PR (light-mode governance):**

1. Schema-level: никаких изменений (долги — чистая агрегация)
2. Middleware `botScopeGuard` + unit-тесты
3. Service + route `GET /api/finance/debts` + тесты
4. `dryRun` на `POST /api/bookings/draft` + `PATCH /api/bookings/:id` + тесты
5. `docs/bot-api.md` + `docs/bot-api-tools.json`
6. Unified Review (1 технический ревьюер) → PAR evidence → PR → merge

Full plan: `docs/superflow/plans/2026-04-14-bot-api.md`
Full design: `docs/superflow/specs/2026-04-14-bot-api-design.md`
