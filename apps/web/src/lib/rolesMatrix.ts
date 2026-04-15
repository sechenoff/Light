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
