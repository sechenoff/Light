---
goal: "Защитить API аутентификацией, покрыть тестами booking scene и API эндпоинты, устранить дублирование crewCalculator"
non_negotiables:
  - "API key только через X-API-Key заголовок, НЕ через query params"
  - "API_KEY в web proxy — серверная переменная, НЕ NEXT_PUBLIC_"
  - "AUTH_MODE default = warn (безопасный деплой)"
  - "crypto.timingSafeEqual() для сравнения ключей"
  - "Shared package экспортирует ВСЕ публичные символы включая ROLES_BY_ID"
  - "Извлечение хелперов из booking.ts — чистый рефакторинг, нулевые изменения поведения"
  - "deploy.sh обновлён для сборки packages/shared"
  - "Тесты используют temp file SQLite, не :memory:"
governance_mode: "standard"
success_criteria:
  - "Все /api/* возвращают 401 без валидного API key (AUTH_MODE=enforce)"
  - "Rate limiter блокирует >100 req/min с одного IP"
  - "33 теста crewCalculator проходят из packages/shared"
  - "≥80% покрытие чистых функций booking scene (fmtItem, totalCost, buildItems, mergeItems и др.)"
  - "≥1 smoke test на каждую из 14 групп роутов API"
  - "npm run build проходит для всех приложений с shared package"
---

## Scope Boundaries

- НЕ добавлять JWT, сессии, управление пользователями
- НЕ создавать frontend login UI
- НЕ тестировать Telegraf scene transitions (mock context)
- НЕ разбивать booking.ts на подфайлы (только извлечение хелперов)
- НЕ трогать Redis-зависимый код (BullMQ worker)

## Risk Areas

- **Auth deploy coordination**: warn mode по умолчанию предотвращает outage
- **Shared package build order**: deploy.sh должен собирать packages/shared ДО consumer apps
- **Root package.json merge conflict**: test script обновляется ТОЛЬКО в Sprint 5
- **Bot vitest CJS**: может потребоваться vitest.config.ts с CJS-настройками

## Sprint Plan

Wave 1 (parallel): Sprint 1 (auth middleware), Sprint 3 (shared package), Sprint 4 (booking helpers)
Wave 2 (parallel): Sprint 2 (consumer wiring), Sprint 5 (API smoke tests)
