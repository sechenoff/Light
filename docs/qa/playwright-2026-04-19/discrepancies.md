# QA: Gaffer CRM vs mockup — discrepancies (2026-04-19)

Источник истины: `docs/mockups/gaffer-crm.html` (11 фреймов).
Прод: `https://svetobazarent.ru/gaffer/*`.
Инструмент: Playwright MCP (Chromium). Брейкпоинты: 390×844 (mobile), 768×1024 (tablet), 1280×900 (desktop).

## Сводная таблица

| # | Экран | Дискрепанс | Приоритет | Файл / Правка |
|---|-------|-----------|-----------|----------------|
| 1 | Desktop shell | `GafferTabbar` с `md:order-first` ставит таббар НАД шапкой — два горизонтальных бара вместо сайдбара слева | **CRITICAL** | `apps/web/app/gaffer/layout.tsx:111-112` → сделать сайдбар слева от `<main>` на `md:`, убрать `md:order-first` |
| 2 | Desktop shell | `<main className="max-w-[480px]">` — на десктопе основное содержимое зажато в колонку 480px, справа пусто | **CRITICAL** | `apps/web/app/gaffer/layout.tsx:89` → расширить до `md:max-w-[960px]` с двумя колонками (или убрать ограничение на ≥768px) |
| 3 | Login | На живом `/gaffer/login` одно поле Email (passwordless MVP). В мокапе — password + OAuth. Бэкенд `gafferLogin` comment: `TODO(sprint-5): заменить на password + Google OAuth + Telegram Login`. **Не баг, отложенная фича** | ⏭ defer (sprint-5) | — |
| 4 | Project detail | Статус-пилл зелёный «Активный» в лайве vs амбер «ОТКРЫТ» (variant=warn) в мокапе — сигнализирует противоположно (зелёный читается как «закрыт/успех») | **MAJOR** | `apps/web/app/gaffer/projects/[id]/page.tsx` — переключить variant на `warn` и label «открыт» |
| 5 | Project detail | Breadcrumb «← Назад» вместо мокапного «← ПРОЕКТЫ» (caps, монограммой) | **MINOR** | та же страница — использовать `.eyebrow`-стилизацию и текст «ПРОЕКТЫ» |
| 6 | Project detail | В секции «Команда» у участников нет прогресс-бара «план/выплачено» (в мокапе — mini-progress) | **MINOR** | добавить `<div className="h-1 bg-border rounded"><div style={{width: pct%}} className="bg-emerald rounded" /></div>` |
| 7 | Projects list | Две точки входа на создание: кнопка `+ Создать` в шапке + FAB `+` снизу. В мокапе — только FAB на мобиле, кнопка в шапке на десктопе | **MINOR** | `apps/web/app/gaffer/projects/page.tsx:244-249` — скрыть top-button на мобиле или FAB на десктопе (уже `md:hidden`, но top-кнопка всегда visible → скрыть её на `<md`) |
| 8 | Dashboard | В хедере мокапа есть аватар/инициалы пользователя, в лайве — только email | **MINOR** | `apps/web/app/gaffer/layout.tsx:76-78` — добавить аватар-кружок с инициалами перед email |
| 9 | Contact card (CLIENT) | Нет подстрочника под KPI («N проектов · последний платёж N ₽»), в мокапе — есть | **MINOR** | `apps/web/app/gaffer/contacts/[id]/page.tsx` — добавить `sub` со счётчиком проектов и датой последнего платежа |
| 10 | Contact card (TEAM) | Тот же missing subtitle под KPI | **MINOR** | та же страница (branch TEAM) |
| 11 | Contacts list | «+ Добавить» в шапке vs «+ НОВЫЙ» в мокапе (uppercase mono) | **MINOR** | `apps/web/app/gaffer/contacts/page.tsx` — изменить label + `.eyebrow` стили |
| 12 | Contacts list | Пилы ролей в нижнем регистре («клиент», «команда») — в мокапе UPPER-case eyebrow-style | **MINOR** | `StatusPill` на странице — добавить `.uppercase tracking-wide text-[10px]` |
| 13 | Contacts list | Нет чипса-фильтра «Архив» рядом с «Все / Клиенты / Команда» | **MINOR** | добавить 4-й фильтр-chip |
| 14 | Project card | В разных карточках непоследовательно показан клиент (иногда имя, иногда нет) — мокап всегда показывает клиента вторым субтитром | **MINOR** | `apps/web/app/gaffer/projects/page.tsx:71-79` — всегда рендерить `project.client?.name` (fallback «— без клиента»)  |
| 15 | Dashboard | Чипс месяца (`апрель`) в хедере показывается только на `/gaffer` — ок, соответствует мокапу | ✅ ок | — |
| 16 | Dashboard | KPI-пара 🟢 Мне должны / 🔴 Я должен — совпадает с мокапом | ✅ ок | — |

## Приоритеты

- **CRITICAL (3):** сломан десктоп-shell (#1, #2), сломан login (#3). Это блокеры для прод-использования.
- **MAJOR (1):** неверный цвет статуса проекта (#4). Пользователь читает зелёный как «всё хорошо» и пропускает активные долги.
- **MINOR (12):** косметика — casing, subtitles, breadcrumbs, прогресс-бары, FAB-дубликат.

## План исправлений

1. Восстановить Login (поле Пароль + links) — 15 мин.
2. Перестроить `GafferShell` на десктопе: левый сайдбар вместо top-таббара, снять `max-w-[480px]` — 25 мин.
3. Fix статус-пилл проекта на амбер «открыт» — 5 мин.
4. Добавить KPI subtitle в `/gaffer/contacts/[id]` — 10 мин.
5. Нормализовать casing на contacts list + добавить Архив-фильтр — 10 мин.
6. Убрать дубликат top-button на projects (оставить только FAB на мобиле, кнопку на десктопе) — 5 мин.
7. Мини-прогресс-бары в секции Команда — 10 мин.
8. Деплой + re-verify через Playwright.
