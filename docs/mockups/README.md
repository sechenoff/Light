# Мокапы страниц

Визуальные референсы из Phase 1 брейнсторма проекта «Роли и навигация». Скопированы из `.superpowers/brainstorm/43898-1776192808/content/` — чтобы было удобно сравнивать с тем, что реально задеплоено на [svetobazarent.ru](https://svetobazarent.ru).

## Как сравнивать

```bash
# Открыть мокап локально
open docs/mockups/finance-pages.html

# Рядом открыть live-версию
open https://svetobazarent.ru/finance
```

Мокапы — это статические HTML-фрагменты (без <html>/<head> — подразумевается обёртка из брейнсторм-окружения). Для автономного просмотра можно добавить обёртку, но для сравнения хватает и так.

## Таблица соответствий

| # | Мокап | Живая страница | Статус |
|---|-------|----------------|--------|
| 1 | [`welcome.html`](welcome.html) | — | Заглушка Phase 1 брейнсторма, UI нет |
| 2 | [`menu-structure.html`](menu-structure.html) | — | Концепт: два подхода к меню (выбор A/B) |
| 3 | [`menu-tree.html`](menu-tree.html) | [левый сайдбар](https://svetobazarent.ru/day) (все страницы) | Реализовано в `AppShell` + `src/lib/roleMatrix.ts` |
| 4 | [`my-day-all-roles.html`](my-day-all-roles.html) | [`/day`](https://svetobazarent.ru/day) | Реализовано: `DaySuperAdmin` / `DayWarehouse` / `DayTechnician` |
| 5 | [`booking-create.html`](booking-create.html) | [`/bookings/new`](https://svetobazarent.ru/bookings/new) | Реализовано (частично — approval-флоу в мокапе включает `PENDING_APPROVAL`) |
| 6 | [`approval-workflow.html`](approval-workflow.html) | — | **Не реализовано.** Статус `PENDING_APPROVAL` заведён в Prisma (Sprint 1), но UI-флоу согласования — Sprint 3+ |
| 7 | [`repair-workflow.html`](repair-workflow.html) | [`/repair`](https://svetobazarent.ru/repair), [`/repair/[id]`](https://svetobazarent.ru/repair) | Реализовано (Sprint 4) |
| 8 | [`admin-pages.html`](admin-pages.html) | [`/admin`](https://svetobazarent.ru/admin) | Реализовано (вкладки: Слэнг, Пользователи, Штрихкоды, Прайсы) |
| 9 | [`finance-pages.html`](finance-pages.html) | [`/finance`](https://svetobazarent.ru/finance) | Реализовано (Sprint 5, канон IBM Plex) |
| 10 | [`finance-pages-coss-style.html`](finance-pages-coss-style.html) | — | **Отвергнутый дизайн** (coss.com-стиль, бирюза/фиолет). Оставлен для истории |
| 11 | [`finance-dashboard-coss-style.html`](finance-dashboard-coss-style.html) | — | **Отвергнутый дизайн** (coss.com-стиль). Оставлен для истории |
| 12 | [`roles-matrix.html`](roles-matrix.html) | — | **UI-страницы нет.** Матрица прав живёт как таблица в `CLAUDE.md` + код (`rolesGuard`, `roleMatrix.ts`). Если нужна живая страница — кандидат для Sprint 6 (`/admin/roles` read-only) |

## Что где живёт в коде

- **Меню по ролям**: `apps/web/src/lib/roleMatrix.ts` (`menuByRole: Record<UserRole, MenuItem[]>`)
- **Enforcement на бэке**: `apps/api/src/middleware/rolesGuard.ts`
- **Текстовая матрица прав**: `CLAUDE.md` — раздел «UserRole и rolesGuard (Sprint 1)»
- **Дизайн-канон**: `docs/design-system.md`

## Почему есть два финансовых мокапа

`finance-pages-coss-style.html` и `finance-dashboard-coss-style.html` — это эксперимент с бирюзово-фиолетовым стилем в духе coss.com. Отвергнут в пользу IBM Plex + business blue (см. `feedback_strict_design_canon.md` в memory). Оставлены на случай, если захочется посмотреть «как выглядело бы иначе».
