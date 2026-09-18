# Инвентаризация — план реализации

Спека: `docs/superpowers/specs/2026-09-18-inventory-design.md`. Мокап:
`docs/mockups/problem-items-v2/final-inventory.html` (+ `concept-a-reestr.html`, врезка 1 — модалка
ручной потеряшки). Ветка `feat/inventory`, воркдерево вне iCloud.

## Этап A — бэкенд-фундамент (последовательно, один исполнитель)
1. Prisma: модели/enum/поля из §2 спеки. `prisma db push` в тестах, `prisma generate`.
2. `availability.ts`: `getLostCountByEquipmentMap` учитывает `ProblemItem.equipmentId` (§3).
3. `services/stockCount/expected.ts` — `computeExpectedOnShelf(ids, at, tx?)` → `Map<id, Breakdown & {calendarBookings}>`.
4. `services/stockCount/equipmentTrail.ts` — `getEquipmentTrail` (§5).
5. `services/stockCount/stockCountService.ts` — старт, деталь, строки, счёт, сброс, решение,
   завершение, отмена, список (§4).
6. `routes/stockCounts.ts` + монтирование; киоск-маршруты в `routes/warehouse.ts`.
7. Потеряшки с приёмки пишут `equipmentId` (`problemItemService.createProblemItem`,
   `warehouseScan.ts` COUNT-ветка).
8. Тесты: `stockCount.test.ts`, `stockCountKiosk.test.ts`, `equipmentTrail.test.ts`, регрессия
   доступности; весь `apps/api` зелёный, `tsc --noEmit` чистый.

## Этап B–E — параллельно, файлы не пересекаются. Схему НЕ трогать.

| Поток | Владеет файлами |
|---|---|
| B · десктоп | `apps/web/app/warehouse/inventory/**`, `apps/web/src/components/inventory/**`, `apps/web/src/lib/roleMatrix.ts` |
| C · киоск | `apps/web/app/warehouse/scan/page.tsx`, `apps/web/src/components/warehouse/{ShiftHome,WorkstationShell,api}.tsx?`, новые `StockCount*.tsx` там же, их тесты |
| D · акт | `apps/api/src/services/stockCount/act/**`, act-маршруты в `routes/stockCounts.ts`, тест акта |
| E · потеряшки | `routes/problemItems.ts`, `services/problemItemService.ts`, `services/warehouseWorkstation.ts` (имена), `services/equipmentStats.ts` (имена), `apps/web/src/components/warehouse/{ProblemItemsPage,types,AddProblemItemModal}.tsx`, `components/day/DayProblemAlert.tsx`, их тесты |

Общий компонент `apps/web/src/components/warehouse/WarehouseSubnav.tsx` создан заранее.

## Этап F — ревью и доводка
Параллельные ревьюеры (корректность данных, права/безопасность, соответствие мокапу, тесты) →
проверка находок → исправления → полный прогон API + web + `next build`.

## Этап G — визуальная сверка
Дев-стенд на сид-базе, скриншоты 1440/375: `/warehouse/inventory/[id]` (счёт, итог, «как
пропало»), киоск, модалка потеряшки, акт — против мокапа.

## Этап H — выпуск
PR → мерж → деплой (push в main, CI делает бэкап + `db push`) → проверка прода →
CLAUDE.md (раздел «Инвентаризация» + Key Files) → память.
