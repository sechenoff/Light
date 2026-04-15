# `/admin/roles` Matrix Page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read-only страница `/admin/roles` — воспроизводит мокап `docs/mockups/roles-matrix.html`: матрица прав (8 секций × 3 роли), легенда, блок «Спорные места», техническая реализация. Видна только SUPER_ADMIN.

**Architecture:** Чистый frontend-спринт. Данные матрицы — статическая константа в TS (не из БД; это доктрина, а не конфиг). Страница рендерит константу через существующие компоненты `StatusPill` и `RoleBadge`. Новых API, БД, middleware — ноль.

**Tech Stack:** Next.js 14 App Router (client component), Tailwind CSS 3 с токенами IBM Plex Canon, TypeScript strict.

**Governance:** light mode — 1 sprint, 1 PR, 1 technical reviewer. 

**Reference:** `docs/mockups/roles-matrix.html` — source of truth для содержания и layout.

---

## Scope Check

Подпроект **C** из 4-подпроектной roadmap (C → A → B → D). Автономный — не зависит и не блокирует A/B/D.

---

## File Structure

| Файл | Ответственность |
|---|---|
| `apps/web/src/lib/rolesMatrix.ts` | **Новый.** Data-only: типы `PermissionCell`, `MatrixRow`, `MatrixSection`; константы `ROLE_DESCRIPTIONS`, `LEGEND_ITEMS`, `MATRIX_SECTIONS`, `EDGE_CASES`, `TECH_NOTES`. Без JSX. |
| `apps/web/app/admin/roles/page.tsx` | **Новый.** Client page. Guard через `useRequireRole(["SUPER_ADMIN"])`. Рендерит 6 блоков: intro, role-headers, legend, matrix table, edge cases, tech notes. |
| `apps/web/app/admin/page.tsx` | **Модифицирован.** Добавить ссылку на `/admin/roles` в существующий layout (в шапке или карточкой наверху). |

**Не трогаем:** `StatusPill.tsx`, `RoleBadge.tsx`, `rolesGuard.ts`, схему Prisma, бэкенд-роуты.

---

## Reused Components (уже в кодовой базе)

- **`StatusPill`** (`src/components/StatusPill.tsx`) — ровно 6 вариантов `full/edit/view/limited/own/none` с правильными token-цветами (emerald/teal/slate/amber/indigo/border). Используется как ячейка матрицы.
- **`RoleBadge`** (`src/components/RoleBadge.tsx`) — бейдж роли: SUPER_ADMIN → indigo «Руководитель», WAREHOUSE → teal «Кладовщик», TECHNICIAN → amber «Техник». Используется в шапке колонки ролей.
- **`useRequireRole`** (`src/hooks/useRequireRole.ts`) — guard-хук.
- **`.eyebrow`** CSS-класс — надстрочники.

---

## Task 1: Data file — `rolesMatrix.ts`

**Files:**
- Create: `apps/web/src/lib/rolesMatrix.ts`

- [ ] **Step 1: Создать типы и экспортировать данные матрицы**

```ts
// apps/web/src/lib/rolesMatrix.ts
import type { StatusPillVariant } from "../components/StatusPill";
import type { UserRole } from "./auth";

// ── Типы ─────────────────────────────────────────────────────────────────────

/** Уровни разрешений из мокапа: 6 вариантов + их визуальная таблетка. */
export type Permission = Extract<StatusPillVariant, "full" | "edit" | "view" | "limited" | "own" | "none">;

export interface PermissionCell {
  level: Permission;
  /** Короткий русский лейбл на таблетке — «да», «любой», «частично», «нет» и т.п. */
  label: string;
}

export interface MatrixRow {
  /** Название возможности. */
  capability: string;
  /** Короткое уточнение под названием. */
  hint?: string;
  super: PermissionCell;
  warehouse: PermissionCell;
  technician: PermissionCell;
}

export interface MatrixSection {
  title: string;
  hint?: string;
  rows: MatrixRow[];
}

export interface RoleDescription {
  tag: string;              // "Super-admin" / "Warehouse" / "Technician"
  title: string;            // "Руководитель" / "Кладовщик" / "Техник"
  subtitle: string;         // "Владелец / CEO", "Operator / старший смены", "Repair specialist"
  desc: string;             // Описание в 1-2 предложения
  count: string;            // "обычно 1 человек", "1–3 человека"
}

export interface EdgeCase {
  scenario: string;         // "Сценарий 1"
  title: string;            // Вопрос
  body: string;             // Ответ (plain text — без HTML; для инлайн-code используется ` `` ` синтаксис)
}

export interface TechNote {
  /** Короткий абзац с bullet point'ом. Может содержать `inline code` в Markdown-синтаксисе. */
  text: string;
}

// ── Данные ────────────────────────────────────────────────────────────────────

/** Описание трёх ролей (для шапки колонок). */
export const ROLE_DESCRIPTIONS: Record<UserRole, RoleDescription> = {
  SUPER_ADMIN: {
    tag: "Super-admin",
    title: "Руководитель",
    subtitle: "Владелец / CEO",
    desc: "Видит всё. Отвечает за деньги, стратегию, договоры. Единственная роль с доступом к финансам, настройкам и удалениям.",
    count: "обычно 1 человек",
  },
  WAREHOUSE: {
    tag: "Warehouse",
    title: "Кладовщик",
    subtitle: "Operator / старший смены",
    desc: "Работает с бронями и складом каждый день. Создаёт и редактирует заявки, выдаёт и принимает оборудование, сопровождает проект от запроса до возврата.",
    count: "1–3 человека",
  },
  TECHNICIAN: {
    tag: "Technician",
    title: "Техник",
    subtitle: "Repair specialist",
    desc: "Чинит оборудование. Видит только «Мой день» и «Мастерскую». Никаких денег, договоров, клиентов — только единицы техники и их состояние.",
    count: "1–2 человека",
  },
};

/** Легенда — 6 типов разрешений. */
export const LEGEND_ITEMS: Array<{ level: Permission; label: string; hint: string }> = [
  { level: "full",    label: "полный",      hint: "создание, редактирование, удаление" },
  { level: "edit",    label: "редактирует", hint: "создаёт и меняет, но не удаляет" },
  { level: "own",     label: "свои",        hint: "только свои записи" },
  { level: "view",    label: "читает",      hint: "видит, но не меняет" },
  { level: "limited", label: "частично",    hint: "ограниченный набор" },
  { level: "none",    label: "нет",         hint: "доступа нет (пункт меню скрыт)" },
];

/** Полная матрица — 8 секций. Порядок и содержание ровно как в мокапе. */
export const MATRIX_SECTIONS: MatrixSection[] = [
  {
    title: "Меню и навигация",
    hint: "что видно в боковой панели",
    rows: [
      {
        capability: "«Мой день» (главная)",
        hint: "дневник задач, зависит от роли",
        super:      { level: "full", label: "своя" },
        warehouse:  { level: "full", label: "своя" },
        technician: { level: "full", label: "своя" },
      },
      {
        capability: "Брони",
        hint: "список, календарь, аналитика",
        super:      { level: "full", label: "полный" },
        warehouse:  { level: "edit", label: "работает" },
        technician: { level: "none", label: "нет" },
      },
      {
        capability: "Оборудование",
        hint: "каталог, единицы, категории",
        super:      { level: "full", label: "полный" },
        warehouse:  { level: "edit", label: "редактирует" },
        technician: { level: "view", label: "читает" },
      },
      {
        capability: "Мастерская",
        hint: "очередь ремонта, история",
        super:      { level: "view",    label: "читает" },
        warehouse:  { level: "limited", label: "создаёт" },
        technician: { level: "full",    label: "работает" },
      },
      {
        capability: "Клиенты",
        hint: "карточки, история, задолженности",
        super:      { level: "full", label: "полный" },
        warehouse:  { level: "edit", label: "редактирует" },
        technician: { level: "none", label: "нет" },
      },
      {
        capability: "Финансы",
        hint: "сводка, долги, поступления, расходы",
        super:      { level: "full", label: "полный" },
        warehouse:  { level: "none", label: "нет" },
        technician: { level: "none", label: "нет" },
      },
      {
        capability: "Админка",
        hint: "пользователи, сленг, импорт, настройки",
        super:      { level: "full", label: "полный" },
        warehouse:  { level: "none", label: "нет" },
        technician: { level: "none", label: "нет" },
      },
    ],
  },
  {
    title: "Бронирование",
    hint: "жизненный цикл заявки",
    rows: [
      { capability: "Создать черновик",
        super: { level: "full", label: "да" }, warehouse: { level: "full", label: "да" }, technician: { level: "none", label: "нет" } },
      { capability: "Редактировать черновик",
        super: { level: "full", label: "любой" }, warehouse: { level: "edit", label: "любой" }, technician: { level: "none", label: "нет" } },
      { capability: "Отправить на согласование",
        super: { level: "full", label: "да" }, warehouse: { level: "full", label: "да" }, technician: { level: "none", label: "нет" } },
      { capability: "Одобрить / отклонить",
        hint: "выход из статуса «На согласовании»",
        super: { level: "full", label: "да" }, warehouse: { level: "none", label: "нет" }, technician: { level: "none", label: "нет" } },
      { capability: "Выдача и возврат оборудования",
        super: { level: "full", label: "да" }, warehouse: { level: "full", label: "да" }, technician: { level: "none", label: "нет" } },
      { capability: "Отменить бронь",
        hint: "после статуса «Одобрено»",
        super: { level: "full", label: "любую" }, warehouse: { level: "limited", label: "до выдачи" }, technician: { level: "none", label: "нет" } },
      { capability: "Редактировать задним числом",
        hint: "после закрытия брони",
        super: { level: "full", label: "да" }, warehouse: { level: "none", label: "нет" }, technician: { level: "none", label: "нет" } },
      { capability: "Удалить бронь",
        super: { level: "full", label: "да" }, warehouse: { level: "none", label: "нет" }, technician: { level: "none", label: "нет" } },
    ],
  },
  {
    title: "Оборудование",
    hint: "каталог и единицы",
    rows: [
      { capability: "Добавить позицию в каталог",
        hint: "новая модель — SkyPanel S60 и т. п.",
        super: { level: "full", label: "да" }, warehouse: { level: "edit", label: "да" }, technician: { level: "none", label: "нет" } },
      { capability: "Менять цены и правила сборов",
        super: { level: "full", label: "да" }, warehouse: { level: "none", label: "нет" }, technician: { level: "none", label: "нет" } },
      { capability: "Добавить единицу (инвентарь)",
        super: { level: "full", label: "да" }, warehouse: { level: "edit", label: "да" }, technician: { level: "none", label: "нет" } },
      { capability: "Списать единицу",
        hint: "перевод в «Списано»",
        super: { level: "full", label: "да" }, warehouse: { level: "none", label: "нет" }, technician: { level: "limited", label: "предлагает" } },
      { capability: "Удалить позицию из каталога",
        super: { level: "full", label: "да" }, warehouse: { level: "none", label: "нет" }, technician: { level: "none", label: "нет" } },
    ],
  },
  {
    title: "Мастерская",
    hint: "ремонт и обслуживание",
    rows: [
      { capability: "Завести карточку ремонта",
        hint: "автоматически при возврате со статусом «Ждёт ремонта»",
        super: { level: "edit", label: "да" }, warehouse: { level: "full", label: "да" }, technician: { level: "edit", label: "да" } },
      { capability: "Взять в работу / менять статус ремонта",
        super: { level: "view", label: "читает" }, warehouse: { level: "none", label: "нет" }, technician: { level: "full", label: "полный" } },
      { capability: "Добавить запись работ / запчасти / время",
        hint: "журнал с таймкодами",
        super: { level: "view", label: "читает" }, warehouse: { level: "none", label: "нет" }, technician: { level: "full", label: "полный" } },
      { capability: "Закрыть ремонт → единица снова «Свободна»",
        super: { level: "edit", label: "да" }, warehouse: { level: "none", label: "нет" }, technician: { level: "full", label: "да" } },
      { capability: "Создать расход категории «Ремонт»",
        hint: "автопредложение при закрытии платного ремонта",
        super: { level: "full", label: "да" }, warehouse: { level: "none", label: "нет" }, technician: { level: "limited", label: "предлагает" } },
    ],
  },
  {
    title: "Клиенты",
    hint: "CRM-карточки",
    rows: [
      { capability: "Создать клиента",
        super: { level: "full", label: "да" }, warehouse: { level: "full", label: "да" }, technician: { level: "none", label: "нет" } },
      { capability: "Редактировать карточку клиента",
        super: { level: "full", label: "любого" }, warehouse: { level: "edit", label: "любого" }, technician: { level: "none", label: "нет" } },
      { capability: "Видеть задолженность клиента",
        super: { level: "full", label: "да" }, warehouse: { level: "limited", label: "сумма и статус" }, technician: { level: "none", label: "нет" } },
      { capability: "Удалить клиента",
        super: { level: "full", label: "да" }, warehouse: { level: "none", label: "нет" }, technician: { level: "none", label: "нет" } },
    ],
  },
  {
    title: "Финансы",
    hint: "секция доступна только руководителю",
    rows: [
      { capability: "Открыть любую финансовую страницу",
        super: { level: "full", label: "да" }, warehouse: { level: "none", label: "нет" }, technician: { level: "none", label: "нет" } },
      { capability: "Отмечать оплату, редактировать платежи",
        super: { level: "full", label: "да" }, warehouse: { level: "none", label: "нет" }, technician: { level: "none", label: "нет" } },
      { capability: "Добавить расход",
        super: { level: "full", label: "да" }, warehouse: { level: "none", label: "нет" }, technician: { level: "none", label: "нет" } },
      { capability: "Скачать отчёт / экспорт",
        super: { level: "full", label: "да" }, warehouse: { level: "none", label: "нет" }, technician: { level: "none", label: "нет" } },
    ],
  },
  {
    title: "Админка",
    hint: "настройки системы",
    rows: [
      { capability: "Пользователи — создание, роли, блокировка",
        super: { level: "full", label: "да" }, warehouse: { level: "none", label: "нет" }, technician: { level: "none", label: "нет" } },
      { capability: "Сленг — принять / отклонить / исправить",
        super: { level: "full", label: "да" }, warehouse: { level: "none", label: "нет" }, technician: { level: "none", label: "нет" } },
      { capability: "Импорт прайсов и сравнение с конкурентами",
        super: { level: "full", label: "да" }, warehouse: { level: "none", label: "нет" }, technician: { level: "none", label: "нет" } },
      { capability: "Настройки — организация, AI, Telegram, правила",
        super: { level: "full", label: "да" }, warehouse: { level: "none", label: "нет" }, technician: { level: "none", label: "нет" } },
    ],
  },
  {
    title: "Разрушающие действия",
    hint: "только руководитель, везде и всегда",
    rows: [
      { capability: "Удаление чего-либо (кроме собственных черновиков)",
        super: { level: "full", label: "да" }, warehouse: { level: "none", label: "нет" }, technician: { level: "none", label: "нет" } },
      { capability: "Массовые операции (импорт с overwrite, bulk delete)",
        super: { level: "full", label: "да" }, warehouse: { level: "none", label: "нет" }, technician: { level: "none", label: "нет" } },
      { capability: "Изменения задним числом (аудит-важные поля)",
        super: { level: "full", label: "да, с логом" }, warehouse: { level: "none", label: "нет" }, technician: { level: "none", label: "нет" } },
    ],
  },
];

/** Спорные места — 8 карточек-сценариев. */
export const EDGE_CASES: EdgeCase[] = [
  {
    scenario: "Сценарий 1",
    title: "Кладовщик может отменить бронь после «Одобрено»?",
    body: "**Только до выдачи.** Если оборудование ещё на складе и клиент звонит с отменой — кладовщик может сам вернуть бронь в «Отменено» (убирает из слотов доступности). После выдачи отмена = возврат с пересчётом → нужна резолюция руководителя.",
  },
  {
    scenario: "Сценарий 2",
    title: "Кто заводит карточку ремонта?",
    body: "**Кладовщик — автоматически,** когда на возврате нажимает «поломка». Система создаёт `Repair`-карточку со статусом «Ждёт ремонта», единицу переводит из «Выдано» в «Ждёт ремонта». Техник потом берёт в работу. Техник тоже может создать карточку вручную (плановая профилактика).",
  },
  {
    scenario: "Сценарий 3",
    title: "Техник видит, от какой брони пришла единица?",
    body: "**Видит номер и даты брони** (чтобы понять контекст использования), но **не видит клиента, цену, суммы**. На карточке ремонта: «Arri Fresnel 2kW №4 · из брони `№ МФ-2026-03-15`, даты 5–12 марта · причина: треснул рефлектор».",
  },
  {
    scenario: "Сценарий 4",
    title: "Кладовщик видит финансовые цифры?",
    body: "**Внутри брони — да** (сумма аренды, залог, статус оплаты — нужно для разговора с клиентом). **В карточке клиента — видит «общий долг»** (чтобы не выдать оборудование должнику). **Раздел /finance не видит вообще** — ни в меню, ни по прямой ссылке.",
  },
  {
    scenario: "Сценарий 5",
    title: "Редактирование задним числом",
    body: "Закрытая бронь (статус «Возвращено» или «Отменено») — только руководитель. Любое изменение **пишется в аудит-лог** (кто, когда, что было, что стало). Кладовщик — только через руководителя.",
  },
  {
    scenario: "Сценарий 6",
    title: "Прямая ссылка, если роль не видит страницу",
    body: "**HTTP 403 на уровне API** (`apiKeyAuth` + `rolesGuard` middleware) + **редирект на /day на фронте**. В меню пункт вообще скрыт. Попытка прямого перехода = сразу «нет доступа, вернуться на главную».",
  },
  {
    scenario: "Сценарий 7",
    title: "Один человек совмещает роли?",
    body: "**У одного пользователя одна роль.** Если руководитель хочет «побыть кладовщиком» — работает через Super-admin (у него все права кладовщика и сверху). Мультироли в этой итерации не делаем — усложняет матрицу и тестирование.",
  },
  {
    scenario: "Сценарий 8",
    title: "Что видно на «Моём дне»?",
    body: "Все три роли видят /day, но **содержимое зависит от роли.** Руководитель: согласования + долги + аномалии расходов. Кладовщик: выдачи / возвраты / конфликты сегодняшнего дня. Техник: очередь ремонта + просроченные по SLA.",
  },
];

/** Технические заметки — bullet points в футере. */
export const TECH_NOTES: TechNote[] = [
  { text: "**Prisma-схема.** В модели `User` поле `role: UserRole` имеет 3 значения: `SUPER_ADMIN`, `WAREHOUSE`, `TECHNICIAN`." },
  { text: "**Middleware `rolesGuard`** в `apps/api/src/middleware/rolesGuard.ts`. Принимает массив разрешённых ролей, читает `req.adminUser.role`, возвращает `403 { code: \"FORBIDDEN_BY_ROLE\" }`. Навешивается на роуты в `routes/index.ts`." },
  { text: "**Фронт — сокрытие меню.** В `apps/web/src/lib/roleMatrix.ts` объявлен `menuByRole: Record<UserRole, MenuItem[]>`. `AppShell` фильтрует по `currentUser.role`. При попытке прямого URL — `useRequireRole` редиректит на `/day`." },
  { text: "**Аудит-лог.** Таблица `AuditEntry` (`userId, action, entityType, entityId, before, after, createdAt`). Пишется через `writeAuditEntry()` внутри `prisma.$transaction` на деструктивных операциях (delete booking, admin-users CRUD и т.п.)." },
  { text: "**Тесты.** `apps/api/src/__tests__/rolesGuardHolistic.test.ts` — 21 интеграционный тест: TECHNICIAN→403 / WAREHOUSE→2xx / SUPER_ADMIN→2xx на guarded-маршрутах + аудит-проверки." },
  { text: "**`botScopeGuard`** (ограничивает ключи `openclaw-*`) остаётся слоем над `rolesGuard`. Бот-ключ пропускается через `req.botAccess === true`, роль не проверяется." },
];
```

- [ ] **Step 2: Проверить TS-компиляцию**

Run: `cd apps/web && npx tsc --noEmit`
Expected: exit 0, ошибок нет.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/rolesMatrix.ts
git commit -m "feat(web): data model for /admin/roles matrix page"
```

---

## Task 2: Page `/admin/roles`

**Files:**
- Create: `apps/web/app/admin/roles/page.tsx`

- [ ] **Step 1: Реализовать страницу целиком**

```tsx
"use client";

import Link from "next/link";
import { useRequireRole } from "../../../src/hooks/useRequireRole";
import { StatusPill } from "../../../src/components/StatusPill";
import {
  ROLE_DESCRIPTIONS,
  LEGEND_ITEMS,
  MATRIX_SECTIONS,
  EDGE_CASES,
  TECH_NOTES,
  type MatrixRow,
} from "../../../src/lib/rolesMatrix";

const ROLE_KEYS = ["SUPER_ADMIN", "WAREHOUSE", "TECHNICIAN"] as const;

/** Цвет-акцент сверху колонки роли — индиго/тил/эмбер по токенам. */
const ROLE_STRIPE: Record<(typeof ROLE_KEYS)[number], string> = {
  SUPER_ADMIN: "bg-indigo",
  WAREHOUSE:   "bg-teal",
  TECHNICIAN:  "bg-amber",
};

const ROLE_TAG_CLS: Record<(typeof ROLE_KEYS)[number], string> = {
  SUPER_ADMIN: "bg-indigo-soft text-indigo border-indigo-border",
  WAREHOUSE:   "bg-teal-soft text-teal border-teal-border",
  TECHNICIAN:  "bg-amber-soft text-amber border-amber-border",
};

/** Почти-прозрачная заливка ячейки по роли (вместо `color-mix` из мокапа). */
const ROLE_CELL_BG: Record<(typeof ROLE_KEYS)[number], string> = {
  SUPER_ADMIN: "bg-indigo-soft/40",
  WAREHOUSE:   "bg-teal-soft/40",
  TECHNICIAN:  "bg-amber-soft/40",
};

/**
 * Минимальный inline-рендер markdown-подобной разметки из edge-case body / tech-note text.
 * Поддерживает только `**bold**` и `` `code` `` — без ссылок, без вложенности.
 */
function renderInline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  // Разбиваем по токенам **...** и `...`
  const regex = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let lastIndex = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > lastIndex) {
      parts.push(text.slice(lastIndex, m.index));
    }
    const token = m[0];
    if (token.startsWith("**")) {
      parts.push(<strong key={key++} className="font-semibold text-ink">{token.slice(2, -2)}</strong>);
    } else {
      parts.push(
        <code key={key++} className="font-mono text-xs bg-surface border border-border rounded px-1 py-0.5 text-ink">
          {token.slice(1, -1)}
        </code>
      );
    }
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

export default function AdminRolesPage() {
  const { authorized, loading } = useRequireRole(["SUPER_ADMIN"]);
  if (loading || !authorized) return null;

  return (
    <div className="p-6 max-w-[1280px] mx-auto space-y-6 pb-16">
      {/* Хлебные крошки + заголовок */}
      <div>
        <Link href="/admin" className="eyebrow hover:text-accent transition-colors">
          ← Админка
        </Link>
        <h1 className="text-2xl font-semibold text-ink mt-2">Матрица прав</h1>
      </div>

      {/* Intro-блок */}
      <div className="bg-indigo-soft border border-indigo-border rounded-lg p-5">
        <p className="text-sm text-ink mb-2">
          Три роли: <strong className="font-semibold">Руководитель</strong>, <strong className="font-semibold">Кладовщик</strong>, <strong className="font-semibold">Техник</strong>. Логика — каждый видит ровно столько, сколько нужно для его ежедневной работы. Минимум опций в боковом меню → меньше когнитивной нагрузки + проще обучать новых сотрудников.
        </p>
        <p className="text-sm text-ink-2">
          Ниже полная матрица по разделам + легенда + обсуждение спорных мест.
        </p>
      </div>

      {/* Шапка трёх ролей */}
      <div className="grid grid-cols-[260px_1fr_1fr_1fr] bg-surface border border-border rounded-lg shadow-xs overflow-hidden">
        <div className="p-5 bg-slate-soft border-r border-border flex items-end eyebrow">
          Раздел / Роль
        </div>
        {ROLE_KEYS.map((key) => {
          const d = ROLE_DESCRIPTIONS[key];
          return (
            <div key={key} className="relative p-5 border-r border-border last:border-r-0">
              <div className={`absolute top-0 left-0 right-0 h-[3px] ${ROLE_STRIPE[key]}`} />
              <span className={`inline-block text-[10.5px] font-cond font-semibold uppercase tracking-wider px-2 py-0.5 rounded border ${ROLE_TAG_CLS[key]} mb-2.5`}>
                {d.tag}
              </span>
              <div className="text-lg font-semibold text-ink leading-tight">{d.title}</div>
              <div className="text-[11px] font-cond font-semibold uppercase tracking-wide text-ink-3 mt-0.5 mb-2">
                {d.subtitle}
              </div>
              <p className="text-[12.5px] text-ink-2 leading-relaxed">{d.desc}</p>
              <p className="mono-num text-[11px] text-ink-3 mt-2.5">{d.count}</p>
            </div>
          );
        })}
      </div>

      {/* Легенда */}
      <div className="bg-surface border border-border rounded-lg shadow-xs px-5 py-3.5 flex flex-wrap gap-5 items-center">
        <span className="eyebrow mr-3">Обозначения</span>
        {LEGEND_ITEMS.map((item) => (
          <span key={item.level} className="inline-flex items-center gap-2 text-xs text-ink-2">
            <StatusPill variant={item.level} label={item.label} />
            {item.hint}
          </span>
        ))}
      </div>

      {/* Матрица */}
      <div className="bg-surface border border-border rounded-lg shadow-xs overflow-hidden">
        <table className="w-full text-sm">
          <colgroup>
            <col style={{ width: "260px" }} />
            <col />
            <col />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th className="px-5 py-3 text-left bg-slate-soft border-b border-border eyebrow">Функция</th>
              {ROLE_KEYS.map((key) => {
                const d = ROLE_DESCRIPTIONS[key];
                const colCls =
                  key === "SUPER_ADMIN" ? "text-indigo"
                : key === "WAREHOUSE"   ? "text-teal"
                                        : "text-amber";
                return (
                  <th key={key} className={`px-5 py-3 text-center bg-slate-soft border-b border-border eyebrow ${colCls} border-r border-border last:border-r-0`}>
                    {d.title}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {MATRIX_SECTIONS.map((section) => (
              <SectionRows key={section.title} section={section} />
            ))}
          </tbody>
        </table>
      </div>

      {/* Спорные места */}
      <div className="bg-surface border border-border rounded-lg shadow-xs p-6">
        <h2 className="text-base font-semibold text-ink mb-4">Спорные места — где важно договориться на берегу</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {EDGE_CASES.map((c) => (
            <div key={c.scenario} className="border border-border rounded p-4 bg-surface">
              <div className="eyebrow text-accent mb-1.5">{c.scenario}</div>
              <div className="text-sm font-semibold text-ink mb-1">{c.title}</div>
              <div className="text-[12.5px] text-ink-2 leading-relaxed">{renderInline(c.body)}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Тех-заметки */}
      <div className="bg-slate-soft border border-border rounded-lg p-5 text-[12.5px] text-ink-2 leading-relaxed">
        <h3 className="text-sm font-semibold text-ink mb-2.5">Техническая реализация</h3>
        <ul className="list-disc ml-5 space-y-1.5">
          {TECH_NOTES.map((note, i) => (
            <li key={i}>{renderInline(note.text)}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Одна секция: заголовок + строки. Вынесено ради удобства. */
function SectionRows({ section }: { section: typeof MATRIX_SECTIONS[number] }) {
  return (
    <>
      <tr>
        <td colSpan={4} className="bg-slate-soft/60 border-y border-border px-5 py-2.5 eyebrow text-ink">
          {section.title}
          {section.hint && (
            <span className="font-sans font-normal normal-case tracking-normal text-[11.5px] text-ink-2 ml-3">
              {section.hint}
            </span>
          )}
        </td>
      </tr>
      {section.rows.map((row, i) => (
        <MatrixTableRow key={`${section.title}-${i}`} row={row} />
      ))}
    </>
  );
}

function MatrixTableRow({ row }: { row: MatrixRow }) {
  return (
    <tr className="border-b border-border last:border-b-0">
      <td className="px-5 py-3 align-middle">
        <div className="text-sm font-medium text-ink">{row.capability}</div>
        {row.hint && <div className="text-[11.5px] text-ink-3 mt-0.5">{row.hint}</div>}
      </td>
      {ROLE_KEYS.map((key) => {
        const roleKey = key === "SUPER_ADMIN" ? "super" : key === "WAREHOUSE" ? "warehouse" : "technician";
        const cell = row[roleKey];
        return (
          <td key={key} className={`px-5 py-3 text-center align-middle border-l border-border last:border-r-0 ${ROLE_CELL_BG[key]}`}>
            <StatusPill variant={cell.level} label={cell.label} />
          </td>
        );
      })}
    </tr>
  );
}
```

- [ ] **Step 2: Проверить TS-компиляцию**

Run: `cd apps/web && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Проверить Next.js сборку**

Run: `npm run build -w apps/web 2>&1 | tail -30`
Expected: `Compiled successfully`, маршрут `/admin/roles` появляется в таблице routes.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/admin/roles/page.tsx
git commit -m "feat(web): /admin/roles — read-only permissions matrix for SUPER_ADMIN"
```

---

## Task 3: Ссылка из `/admin`

**Files:**
- Modify: `apps/web/app/admin/page.tsx`

Цель — дать SUPER_ADMIN видимую точку входа на `/admin/roles`. Не ломаю существующие вкладки, добавляю компактный блок-ссылку под заголовком страницы.

- [ ] **Step 1: Прочитать `apps/web/app/admin/page.tsx` и найти место под заголовком**

Run: `head -150 apps/web/app/admin/page.tsx`

Ожидаемо: файл начинается с `"use client"`, импортов, типов, хелперов; где-то ~строка 200+ идёт `export default function AdminPage()` с рендером вкладок.

- [ ] **Step 2: Добавить ссылку-карточку на `/admin/roles` сразу после заголовка страницы**

Локализовать заголовок «Админка» или его eyebrow в JSX `AdminPage` и вставить сразу после него (перед блоком вкладок):

```tsx
{/* Ссылка на матрицу прав — только для SUPER_ADMIN.
    Показывается всегда, т.к. вся страница /admin и так закрыта за SUPER_ADMIN guard'ом. */}
<Link
  href="/admin/roles"
  className="block mb-4 bg-indigo-soft border border-indigo-border rounded-lg px-4 py-3 hover:border-indigo transition-colors"
>
  <div className="flex items-center justify-between gap-4">
    <div>
      <div className="eyebrow text-indigo">Справочник</div>
      <div className="text-sm font-semibold text-ink mt-0.5">Матрица прав по ролям</div>
      <div className="text-xs text-ink-2 mt-0.5">Кто что видит и делает — полная таблица для онбординга</div>
    </div>
    <span className="text-indigo text-lg">→</span>
  </div>
</Link>
```

**Если `Link` ещё не импортирован:** добавить `import Link from "next/link";` в раздел импортов.

- [ ] **Step 3: Build + tsc**

Run:
```
cd apps/web && npx tsc --noEmit && cd - && npm run build -w apps/web 2>&1 | tail -15
```
Expected: tsc exit 0, Next.js build success, `/admin/roles` в routes.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/admin/page.tsx
git commit -m "feat(web): link to /admin/roles from admin panel"
```

---

## Task 4: Smoke-verify в dev

**Files:** —

- [ ] **Step 1: Убедиться что `/admin/roles` существует как маршрут**

Run: `cd apps/web && npx next build 2>&1 | grep -E "roles|admin" | head`
Expected: видим `/admin/roles` в списке Static / Dynamic routes.

- [ ] **Step 2: Проверить что импорты разрешаются**

Run: `cd apps/web && npx tsc --noEmit 2>&1 | head -20`
Expected: пусто (exit 0).

- [ ] **Step 3: Проверить, что полный test suite не сломался**

Run: `cd /Users/sechenov/Documents/light-rental-system/.worktrees/admin-roles && timeout 120 npm test 2>&1 | tail -20`
Expected: `Tests: 451 passed` (или столько же, сколько было на main).

Если вдруг хоть один тест упал — читай лог, чини. Не продолжай, пока не зелено.

---

## Task 5: Unified Review (light mode — 1 reviewer)

**Files:** —

- [ ] **Step 1: Убедиться, что всё закоммичено**

Run: `git status && git log --oneline origin/main..HEAD`
Expected: 3 коммита на ветке `feat/admin-roles-matrix`:
1. `feat(web): data model for /admin/roles matrix page`
2. `feat(web): /admin/roles — read-only permissions matrix for SUPER_ADMIN`
3. `feat(web): link to /admin/roles from admin panel`

Working tree — clean.

- [ ] **Step 2: Dispatch standard-code-reviewer**

Одного технического ревьюера достаточно (light governance mode, читалка без новых API, без безопасности, без миграций).

Использовать `Agent({ subagent_type: "standard-code-reviewer", model: "opus", ... })` с полным контекстом:
- ветка: `feat/admin-roles-matrix`
- 3 коммита в diff
- эталон: `docs/mockups/roles-matrix.html`
- план: этот файл

Прочитать ответ. Если `APPROVE` — идём к Task 6. Если `REQUEST_CHANGES` — чинить, коммитить, re-review.

- [ ] **Step 3: Записать PAR evidence**

При APPROVE:

```bash
cat > .par-evidence.json <<'EOF'
{
  "sprint": 1,
  "project": "admin-roles-matrix",
  "governance": "light",
  "technical_review": "APPROVE",
  "provider": "claude-standard-code-reviewer",
  "tests": "451/451 passing",
  "tsc": "exit 0",
  "ts": "<ISO timestamp>"
}
EOF
git add .par-evidence.json
git commit -m "chore: add PAR evidence for admin-roles-matrix"
```

---

## Task 6: PR + Merge

- [ ] **Step 1: Push ветку**

```bash
git push -u origin feat/admin-roles-matrix
```

- [ ] **Step 2: Открыть PR**

```bash
gh pr create --title "feat(web): /admin/roles — permissions matrix page (subproject C)" --body "$(cat <<'EOF'
## Summary

- Новая read-only страница `/admin/roles` — воспроизводит мокап `docs/mockups/roles-matrix.html`. Матрица прав 8 секций × 3 роли, легенда, 8 edge-case карточек, тех-заметки.
- Защищена `useRequireRole(["SUPER_ADMIN"])`.
- Ссылка-карточка на страницу добавлена в `/admin` над вкладками.
- Переиспользует существующие компоненты `StatusPill`, `RoleBadge` и токены IBM Plex Canon — новых компонентов и цветов нет.
- Зависимостей от API, БД, middleware — нет. Данные статические в `apps/web/src/lib/rolesMatrix.ts`.

Первый из 4 подпроектов roadmap'а «догнать мокапы» (C → A → B → D).

## Test plan

- [x] `npm test` — 451 pass (не регрессировал)
- [x] `cd apps/web && npx tsc --noEmit` — exit 0
- [x] `npm run build -w apps/web` — `Compiled successfully`, `/admin/roles` в routes
- [ ] Смоук: открыть `https://svetobazarent.ru/admin/roles` под SUPER_ADMIN, сверить с `docs/mockups/roles-matrix.html`
- [ ] Смоук: попытка открыть под WAREHOUSE / TECHNICIAN → редирект на `/day`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Смёрджить при зелёном CI**

Не самомёрдж. Вернуть URL пользователю, дождаться его явного «мёрдж» — тогда:

```bash
gh pr merge <N> --rebase --delete-branch
```

---

## Post-merge

- [ ] Выйти из worktree: `cd /Users/sechenov/Documents/light-rental-system`
- [ ] Удалить worktree: `git worktree remove .worktrees/admin-roles`
- [ ] Обновить `CLAUDE.md` на main (строка «Key Files»): добавить `apps/web/app/admin/roles/page.tsx` и `apps/web/src/lib/rolesMatrix.ts`. Запустить `standard-doc-writer` если есть другие накопления, иначе — одним edit'ом.
- [ ] Deploy: GH Actions автоматически задеплоит на прод. Убедиться, что свежий build попал и `/admin/roles` доступна.

---

## Self-Review

**1. Spec coverage:** Мокап `roles-matrix.html` состоит из: intro-блок ✓, шапка 3 ролей ✓, легенда ✓, матрица 8 секций × 3 колонки ✓, секция «Спорные места» с 8 карточками ✓, футер «Техническая реализация» ✓. Всё покрыто Task 1 (data) + Task 2 (rendering).

**2. Placeholder scan:** В плане есть `<ISO timestamp>` в PAR evidence — это маркер, агент ставит реальный timestamp при исполнении. Больше TBD/TODO/placeholders не нашёл.

**3. Type consistency:** `Permission` использует `Extract<StatusPillVariant, ...>` — гарантирует, что варианты синхронизированы с `StatusPill`. `ROLE_KEYS` и ключи `ROLE_DESCRIPTIONS` оба используют `UserRole`. Ключи `row.super/warehouse/technician` в data совпадают с `MatrixRow` типом.

**4. Design canon:** Используются только существующие токены (`indigo/teal/amber/slate/emerald/rose/accent/ink`). Нет inline hex, нет bg-sky/bg-blue. CSS-утилиты `.eyebrow`, `.mono-num`, `font-cond` уже в проекте.
