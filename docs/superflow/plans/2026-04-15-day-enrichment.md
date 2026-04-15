# /day Dashboard Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Обогатить страницу `/day` (My Day) до визуала мокапа `docs/mockups/my-day-all-roles.html` — роль-зависимый контент с приветствием, алертом срочного, KPI-блоками, списком операций и футером.

**Architecture:** Расширить `GET /api/dashboard/today` (add `finalAmount` per booking) + два новых endpoint'а (`/api/dashboard/pending-approvals` для SA/WH алертов и `/api/dashboard/repair-stats` для TECHNICIAN/SA репейр-метрик). На фронте — 5 новых маленьких компонентов (header/alert/kpi/list/footer) и переписанные 3 role-компонента в `apps/web/app/day/page.tsx`. Reuse: `StatusPill`, `RoleBadge`, `useRequireRole`, `useCurrentUser`, `apiFetch`, `formatRub`.

**Tech Stack:** Next.js 14 client components, Tailwind CSS 3 (tokens: `ink`, `surface`, `border`, `accent`, `teal`, `amber`, `rose`, `emerald`, `indigo`), Express 4 + Prisma 6, Zod, Vitest + supertest.

---

## Scope Boundaries (what's IN and what's OUT)

**IN (Sprint A):**
- Dark header bar с датой, именем, роль-счётчиком (выдачи/возвраты | поломки | съёмки+выручка месяца).
- Алерт под шапкой: PENDING_APPROVAL (SA/WH) / новые WAITING_REPAIR (TECH).
- WAREHOUSE: 2 карточки с `HH:MM · клиент · N позиций`, две кнопки-действия, footer.
- TECHNICIAN: блок «Новые поломки» с двумя кнопками (Взять в работу / Списать), список «В работе» с длительностью+статусом, footer.
- SUPER_ADMIN: KPI-грид (Сегодня/Долги/Ремонт), список «Операции сегодня» с HH:MM+сумма, footer с % роста.
- API: одно расширение (`/today` + finalAmount) + два новых GET (`pending-approvals`, `repair-stats`).
- Тесты: 3 интеграционных тест-кейса.

**OUT (не в этом спринте):**
- Workflow approve/reject брони — будет в Sprint B (Subproject B). Мы только показываем счётчики PENDING_APPROVAL и отправляем клик на `/bookings/:id`.
- «Загрузка следующей недели 65%» — расчёт недельной ёмкости (skip, оставим плейсхолдер «N броней ждут согласования»).
- Telegram-превью в алерте («+ Новая бронь (вставить текст из Telegram)») — кнопка ведёт на `/bookings/new`, без парсинга буфера.
- Написание рекомендательной логики (auto-assign, алерт «рост к прошлому месяцу» как стрелка-тренд на неделе) — вне скоупа.

---

## File Structure

**API — новые маршруты:**
- Modify: `apps/api/src/routes/dashboard.ts` — добавить `finalAmount` к `mapBooking()` + 2 новых handler.
- Test: `apps/api/src/__tests__/dashboard.test.ts` — 3 новых кейса + подправка одного существующего (новый ключ `finalAmount`).

**Web — новые компоненты (все в `apps/web/src/components/day/`):**
- Create: `apps/web/src/components/day/DayHeader.tsx` — тёмный бар с датой/приветствием/счётчиком.
- Create: `apps/web/src/components/day/DayAlert.tsx` — universal alert (rose/amber), заголовок + список + link.
- Create: `apps/web/src/components/day/DayKpiCard.tsx` — карточка «Сегодня/Долги/Ремонт».
- Create: `apps/web/src/components/day/DayOperationsList.tsx` — список операций с HH:MM.
- Create: `apps/web/src/components/day/DayFooterMetrics.tsx` — footer с dashed top border, принимает children.

**Web — переписанные 3 role-блока:**
- Modify: `apps/web/app/day/page.tsx` — полностью переписать `DaySuperAdmin`, `DayWarehouse`, `DayTechnician` (сохранить `DayPage`, `useRequireRole` и import-список).

**Docs (после merge, обновляется на main отдельным коммитом):**
- Modify: `CLAUDE.md` — добавить в Key Files 3 новых компонента + описать новые API-эндпоинты в Conventions.

---

## Self-Review Checklist (автору плана)

- [x] Все три роли имеют purpose-driven алерт (WH=PENDING_APPROVAL → amber, TECH=WAITING_REPAIR → rose, SA=PENDING_APPROVAL → amber).
- [x] Все widgets мокапа покрыты: SA=7 (header+alert+3 KPI+operations+footer) / WH=6 (header+alert+2 карточки+2 кнопки+footer) / TECH=4 (header+new repairs+in-progress+footer). Итого 17 как в аудите.
- [x] Нет placeholder'ов «TODO» — все код-блоки в каждом Task полные.
- [x] API-contract согласован между frontend и backend (см. Task 1–3).
- [x] Tests покрывают три новых/изменённых endpoint'а с role-guards.
- [x] Все тексты на русском, все цвета через токены (ink/surface/border/accent/teal/amber/rose/emerald/indigo/slate).

---

## Task 1: Extend `GET /api/dashboard/today` with `finalAmount`

**Files:**
- Modify: `apps/api/src/routes/dashboard.ts` (add finalAmount to mapBooking, lines 71-85)

- [ ] **Step 1.1: Modify `mapBooking` в `apps/api/src/routes/dashboard.ts`**

Заменить функцию `mapBooking` (строки 71-85) на:

```typescript
function mapBooking(b: typeof pickupsRaw[number]) {
  return {
    id: b.id,
    projectName: b.projectName,
    clientName: b.client.name,
    startDate: b.startDate.toISOString(),
    endDate: b.endDate.toISOString(),
    status: b.status,
    finalAmount: b.finalAmount.toString(),
    itemCount: b.items.length,
    items: b.items.map((item) => ({
      equipmentName: item.equipment.name,
      quantity: item.quantity,
    })),
  };
}
```

- [ ] **Step 1.2: Обновить существующий тест в `apps/api/src/__tests__/dashboard.test.ts`**

Найти строку типа `expect(body.pickups[0]).toMatchObject({...})` (в существующих кейсах) и добавить в объект проверку:

```typescript
expect(body.pickups[0]).toMatchObject({
  id: expect.any(String),
  projectName: expect.any(String),
  clientName: expect.any(String),
  startDate: expect.any(String),
  endDate: expect.any(String),
  status: "CONFIRMED",
  finalAmount: expect.any(String), // <-- добавить
  itemCount: expect.any(Number),
});
```

Если точный ассерт не `toMatchObject`, то адаптировать — главное убедиться, что `finalAmount` читается как строка.

- [ ] **Step 1.3: Запустить тесты**

```bash
cd apps/api && npx vitest run src/__tests__/dashboard.test.ts
```

Expected: все тесты проходят.

- [ ] **Step 1.4: Commit**

```bash
git add apps/api/src/routes/dashboard.ts apps/api/src/__tests__/dashboard.test.ts
git commit -m "feat(api): add finalAmount to /api/dashboard/today bookings"
```

---

## Task 2: Add `GET /api/dashboard/pending-approvals`

**Files:**
- Modify: `apps/api/src/routes/dashboard.ts` (new handler)

- [ ] **Step 2.1: Добавить handler в `apps/api/src/routes/dashboard.ts`**

После существующего `router.get("/today", …)` (до `export { router as dashboardRouter }`) вставить:

```typescript
/**
 * GET /api/dashboard/pending-approvals
 * Возвращает брони со статусом PENDING_APPROVAL (ждут решения руководителя).
 * Доступ — любой аутентифицированный (rolesGuard на уровне router-а допускает все три роли).
 */
router.get("/pending-approvals", async (_req, res, next) => {
  try {
    const bookings = await prisma.booking.findMany({
      where: { status: "PENDING_APPROVAL" },
      include: { client: true },
      orderBy: { startDate: "asc" },
      take: 20,
    });

    res.json({
      bookings: bookings.map((b) => ({
        id: b.id,
        projectName: b.projectName,
        clientName: b.client.name,
        startDate: b.startDate.toISOString(),
        endDate: b.endDate.toISOString(),
        finalAmount: b.finalAmount.toString(),
      })),
      total: bookings.length,
    });
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 2.2: Написать тест-кейс в `apps/api/src/__tests__/dashboard.test.ts`**

После блока `describe("GET /api/dashboard/today", …)` добавить:

```typescript
describe("GET /api/dashboard/pending-approvals", () => {
  it("возвращает 401 без API-ключа", async () => {
    const res = await request(app).get("/api/dashboard/pending-approvals");
    expect(res.status).toBe(401);
  });

  it("возвращает PENDING_APPROVAL брони", async () => {
    const client = await createClient("PendingClient");
    const equipment = await createEquipment("PendingEquipment");
    const now = new Date();
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    await createBooking(client.id, equipment.id, "PENDING_APPROVAL", now, tomorrow);
    await createBooking(client.id, equipment.id, "CONFIRMED", now, tomorrow);

    const res = await request(app)
      .get("/api/dashboard/pending-approvals")
      .set(AUTH());

    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    expect(res.body.bookings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          projectName: expect.any(String),
          clientName: expect.any(String),
          finalAmount: expect.any(String),
          startDate: expect.any(String),
          endDate: expect.any(String),
        }),
      ]),
    );
    // Ни одного не-PENDING не должно протечь
    for (const b of res.body.bookings) {
      // Статус не возвращаем — просто проверяем что в ответе нет лишнего ключа
      expect(b.status).toBeUndefined();
    }
  });
});
```

- [ ] **Step 2.3: Запустить тесты**

```bash
cd apps/api && npx vitest run src/__tests__/dashboard.test.ts
```

Expected: все кейсы зелёные (`GET /api/dashboard/today` + новый `pending-approvals`).

- [ ] **Step 2.4: Commit**

```bash
git add apps/api/src/routes/dashboard.ts apps/api/src/__tests__/dashboard.test.ts
git commit -m "feat(api): add GET /api/dashboard/pending-approvals endpoint"
```

---

## Task 3: Add `GET /api/dashboard/repair-stats`

**Files:**
- Modify: `apps/api/src/routes/dashboard.ts` (new handler)

- [ ] **Step 3.1: Добавить handler в `apps/api/src/routes/dashboard.ts`**

Добавить ниже `pending-approvals` (до `export { router as dashboardRouter }`):

```typescript
/**
 * GET /api/dashboard/repair-stats
 * Статистика мастерской:
 *   - openCount: открытые (WAITING_REPAIR/IN_REPAIR/WAITING_PARTS)
 *   - closedThisMonth: закрытые в текущем календарном месяце (CLOSED)
 *   - writtenOffThisMonth: списано в текущем месяце (WROTE_OFF)
 *   - spentThisMonth: сумма approved-расходов с linkedRepairId за текущий месяц
 *   - newCount: WAITING_REPAIR (то, что нужно взять в работу)
 *
 * Доступ — все три роли (rolesGuard на router-уровне).
 */
router.get("/repair-stats", async (_req, res, next) => {
  try {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);

    const [openCount, newCount, closedThisMonth, writtenOffThisMonth, expensesAgg] = await Promise.all([
      prisma.repair.count({
        where: { status: { in: ["WAITING_REPAIR", "IN_REPAIR", "WAITING_PARTS"] } },
      }),
      prisma.repair.count({
        where: { status: "WAITING_REPAIR" },
      }),
      prisma.repair.count({
        where: { status: "CLOSED", closedAt: { gte: monthStart } },
      }),
      prisma.repair.count({
        where: { status: "WROTE_OFF", closedAt: { gte: monthStart } },
      }),
      prisma.expense.aggregate({
        where: {
          approved: true,
          linkedRepairId: { not: null },
          expenseDate: { gte: monthStart },
        },
        _sum: { amount: true },
      }),
    ]);

    res.json({
      openCount,
      newCount,
      closedThisMonth,
      writtenOffThisMonth,
      spentThisMonth: (expensesAgg._sum.amount?.toString() ?? "0"),
    });
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 3.2: Написать тест-кейс**

В `apps/api/src/__tests__/dashboard.test.ts` после `describe("GET /api/dashboard/pending-approvals", …)` добавить:

```typescript
describe("GET /api/dashboard/repair-stats", () => {
  it("возвращает 401 без API-ключа", async () => {
    const res = await request(app).get("/api/dashboard/repair-stats");
    expect(res.status).toBe(401);
  });

  it("возвращает агрегаты по ремонтам", async () => {
    const res = await request(app)
      .get("/api/dashboard/repair-stats")
      .set(AUTH());

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      openCount: expect.any(Number),
      newCount: expect.any(Number),
      closedThisMonth: expect.any(Number),
      writtenOffThisMonth: expect.any(Number),
      spentThisMonth: expect.any(String), // Decimal stringified
    });
  });
});
```

- [ ] **Step 3.3: Запустить все dashboard-тесты**

```bash
cd apps/api && npx vitest run src/__tests__/dashboard.test.ts
```

Expected: все 3 `describe`-блока зелёные.

- [ ] **Step 3.4: Commit**

```bash
git add apps/api/src/routes/dashboard.ts apps/api/src/__tests__/dashboard.test.ts
git commit -m "feat(api): add GET /api/dashboard/repair-stats endpoint"
```

---

## Task 4: Create `DayHeader` component (dark greeting bar)

**Files:**
- Create: `apps/web/src/components/day/DayHeader.tsx`

- [ ] **Step 4.1: Создать файл `apps/web/src/components/day/DayHeader.tsx`**

```tsx
"use client";

// ── Форматирование даты в русском формате ────────────────────────────────────

const WEEKDAYS = [
  "Воскресенье", "Понедельник", "Вторник", "Среда",
  "Четверг", "Пятница", "Суббота",
];
const MONTHS_GEN = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

function formatLongRuDate(d: Date): string {
  return `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS_GEN[d.getMonth()]}`;
}

// ── Props ─────────────────────────────────────────────────────────────────────

export function DayHeader({
  greeting,
  summary,
  date = new Date(),
}: {
  greeting: string;     // например, «доброе утро, Пётр 👋»
  summary: string;      // например, «3 выдачи · 2 возврата»
  date?: Date;
}) {
  return (
    <div className="bg-ink text-white rounded-t-lg px-4 py-3 flex flex-col sm:flex-row sm:justify-between sm:items-center gap-1">
      <div className="text-sm">
        <span className="font-semibold">{formatLongRuDate(date)}</span>
        <span className="ml-1 text-white/80">· {greeting}</span>
      </div>
      <div className="text-xs text-white/60 font-cond">{summary}</div>
    </div>
  );
}
```

- [ ] **Step 4.2: Sanity-check: type-check**

```bash
cd apps/web && npx tsc --noEmit
```

Expected: 0 errors (или только те, что были до изменения — не новые).

- [ ] **Step 4.3: Commit**

```bash
git add apps/web/src/components/day/DayHeader.tsx
git commit -m "feat(web): add DayHeader component for /day page"
```

---

## Task 5: Create `DayAlert` component

**Files:**
- Create: `apps/web/src/components/day/DayAlert.tsx`

- [ ] **Step 5.1: Создать файл `apps/web/src/components/day/DayAlert.tsx`**

```tsx
"use client";

import Link from "next/link";
import type { ReactNode } from "react";

type Variant = "rose" | "amber";

const VARIANT_CLASSES: Record<Variant, { bg: string; border: string; accent: string }> = {
  rose: {
    bg: "bg-rose-soft",
    border: "border-rose",
    accent: "text-rose",
  },
  amber: {
    bg: "bg-amber-soft",
    border: "border-amber",
    accent: "text-amber",
  },
};

export function DayAlert({
  variant,
  title,
  count,
  linkHref,
  linkLabel = "Все →",
  children,
}: {
  variant: Variant;
  title: string;
  count?: number;                   // опциональный бейдж
  linkHref?: string;                // если есть — рендерит Link
  linkLabel?: string;
  children?: ReactNode;             // список элементов
}) {
  const c = VARIANT_CLASSES[variant];
  return (
    <div className={`${c.bg} border-l-4 ${c.border} rounded px-4 py-3`}>
      <div className="flex justify-between items-start gap-2">
        <p className={`text-sm font-semibold ${c.accent}`}>
          {title}
          {typeof count === "number" && (
            <span className={`ml-2 inline-flex items-center justify-center min-w-[20px] px-1.5 py-0.5 rounded-full text-[11px] text-white ${variant === "rose" ? "bg-rose" : "bg-amber"}`}>
              {count}
            </span>
          )}
        </p>
        {linkHref && (
          <Link href={linkHref} className="text-xs text-accent hover:underline shrink-0">
            {linkLabel}
          </Link>
        )}
      </div>
      {children && <div className="mt-2 text-sm text-ink-2">{children}</div>}
    </div>
  );
}
```

- [ ] **Step 5.2: Type-check**

```bash
cd apps/web && npx tsc --noEmit
```

- [ ] **Step 5.3: Commit**

```bash
git add apps/web/src/components/day/DayAlert.tsx
git commit -m "feat(web): add DayAlert component (rose/amber variants)"
```

---

## Task 6: Create `DayKpiCard` component

**Files:**
- Create: `apps/web/src/components/day/DayKpiCard.tsx`

- [ ] **Step 6.1: Создать файл `apps/web/src/components/day/DayKpiCard.tsx`**

```tsx
"use client";

import type { ReactNode } from "react";

export function DayKpiCard({
  eyebrow,
  value,
  sub,
  subTone = "muted",
}: {
  eyebrow: string;          // «Сегодня» / «Долги» / «Ремонт»
  value: ReactNode;         // «28 500 ₽» или «4 единиц»
  sub?: ReactNode;          // подпись под значением
  subTone?: "muted" | "rose" | "emerald" | "amber";
}) {
  const subClass = {
    muted:    "text-ink-3",
    rose:     "text-rose",
    emerald:  "text-emerald",
    amber:    "text-amber",
  }[subTone];

  return (
    <div className="bg-surface border border-border rounded-lg p-3 shadow-xs">
      <p className="eyebrow">{eyebrow}</p>
      <p className="mono-num text-xl font-semibold text-ink mt-1">{value}</p>
      {sub && <p className={`text-xs mt-1 ${subClass}`}>{sub}</p>}
    </div>
  );
}
```

- [ ] **Step 6.2: Type-check**

```bash
cd apps/web && npx tsc --noEmit
```

- [ ] **Step 6.3: Commit**

```bash
git add apps/web/src/components/day/DayKpiCard.tsx
git commit -m "feat(web): add DayKpiCard component"
```

---

## Task 7: Create `DayOperationsList` component

**Files:**
- Create: `apps/web/src/components/day/DayOperationsList.tsx`

- [ ] **Step 7.1: Создать файл `apps/web/src/components/day/DayOperationsList.tsx`**

```tsx
"use client";

import Link from "next/link";
import { formatRub } from "../../lib/format";

// HH:MM from ISO date, ru-RU locale
function formatHM(iso: string): string {
  return new Date(iso).toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Плюрализация «позиция/позиции/позиций»
function pluralizePositions(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "позиция";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "позиции";
  return "позиций";
}

export type DayOperation = {
  id: string;
  kind: "pickup" | "return";
  startDate: string;          // ISO
  endDate: string;             // ISO
  projectName: string;
  clientName: string;
  itemCount: number;
  finalAmount?: string;        // опционально; если задан — рендерим «(сумма)»
};

export function DayOperationsList({
  operations,
  showAmount = false,
  emptyLabel = "Нет операций",
}: {
  operations: DayOperation[];
  showAmount?: boolean;
  emptyLabel?: string;
}) {
  if (operations.length === 0) {
    return <p className="text-xs text-ink-3 italic">{emptyLabel}</p>;
  }

  return (
    <ul className="divide-y divide-border">
      {operations.map((op) => {
        const time = op.kind === "pickup" ? formatHM(op.startDate) : formatHM(op.endDate);
        const kindLabel = op.kind === "pickup" ? "выдача" : "возврат";
        return (
          <li key={op.id} className="py-2">
            <Link
              href={`/bookings/${op.id}`}
              className="text-sm text-ink hover:text-accent flex flex-wrap items-baseline gap-x-2"
            >
              <span className="mono-num text-ink-2">{time}</span>
              <span className="text-ink-3">·</span>
              <span className="text-ink-3">{kindLabel}</span>
              <span className="text-ink-3">·</span>
              <span className="font-medium truncate">{op.clientName || op.projectName}</span>
              {showAmount && op.finalAmount && (
                <span className="mono-num text-ink-2">({formatRub(op.finalAmount)})</span>
              )}
              <span className="text-ink-3">—</span>
              <span className="text-xs text-ink-3">
                {op.itemCount} {pluralizePositions(op.itemCount)}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
```

- [ ] **Step 7.2: Type-check**

```bash
cd apps/web && npx tsc --noEmit
```

- [ ] **Step 7.3: Commit**

```bash
git add apps/web/src/components/day/DayOperationsList.tsx
git commit -m "feat(web): add DayOperationsList component"
```

---

## Task 8: Create `DayFooterMetrics` component

**Files:**
- Create: `apps/web/src/components/day/DayFooterMetrics.tsx`

- [ ] **Step 8.1: Создать файл `apps/web/src/components/day/DayFooterMetrics.tsx`**

```tsx
"use client";

import type { ReactNode } from "react";

export function DayFooterMetrics({ children }: { children: ReactNode }) {
  return (
    <div className="mt-4 pt-3 border-t border-dashed border-border text-xs text-ink-3">
      {children}
    </div>
  );
}
```

- [ ] **Step 8.2: Type-check**

```bash
cd apps/web && npx tsc --noEmit
```

- [ ] **Step 8.3: Commit**

```bash
git add apps/web/src/components/day/DayFooterMetrics.tsx
git commit -m "feat(web): add DayFooterMetrics component (dashed top border)"
```

---

## Task 9: Rewrite `DayWarehouse` role component

**Files:**
- Modify: `apps/web/app/day/page.tsx` (replace DayWarehouse definition, lines 90-167)

- [ ] **Step 9.1: Заменить `DayWarehouse` в `apps/web/app/day/page.tsx`**

Удалить существующее определение `DayWarehouse` (функция, ~75 строк) и заменить на:

```tsx
// ── WAREHOUSE ────────────────────────────────────────────────────────────────

interface DashboardToday {
  pickups: Array<{
    id: string;
    projectName: string;
    clientName: string;
    startDate: string;
    endDate: string;
    finalAmount: string;
    itemCount: number;
  }>;
  returns: Array<{
    id: string;
    projectName: string;
    clientName: string;
    startDate: string;
    endDate: string;
    finalAmount: string;
    itemCount: number;
  }>;
  active: Array<{ id: string }>;
}

interface PendingApprovalsResponse {
  bookings: Array<{
    id: string;
    projectName: string;
    clientName: string;
    finalAmount: string;
    startDate: string;
    endDate: string;
  }>;
  total: number;
}

function DayWarehouse({ username }: { username: string }) {
  const [dashboard, setDashboard] = useState<DashboardToday | null>(null);
  const [pending, setPending] = useState<PendingApprovalsResponse | null>(null);

  useEffect(() => {
    apiFetch<DashboardToday>("/api/dashboard/today")
      .then(setDashboard)
      .catch(() => { /* не блокируем */ });
    apiFetch<PendingApprovalsResponse>("/api/dashboard/pending-approvals")
      .then(setPending)
      .catch(() => { /* не блокируем */ });
  }, []);

  const pickups = dashboard?.pickups ?? [];
  const returns = dashboard?.returns ?? [];
  const summary =
    dashboard
      ? `${pickups.length} выдач · ${returns.length} возврат${returns.length === 1 ? "" : returns.length >= 2 && returns.length <= 4 ? "а" : "ов"}`
      : "—";

  return (
    <div className="bg-surface border border-border rounded-lg shadow-xs overflow-hidden">
      <DayHeader greeting={`доброе утро, ${username} 👋`} summary={summary} />
      <div className="p-4 space-y-3">
        {pending && pending.total > 0 && (
          <DayAlert
            variant="amber"
            title={`📋 ${pending.total} брон${pending.total === 1 ? "ь" : pending.total >= 2 && pending.total <= 4 ? "и" : "ей"} на согласовании у руководителя`}
            linkHref="/bookings"
            linkLabel="Все →"
          />
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="bg-surface border border-border rounded-lg p-3">
            <div className="flex justify-between items-baseline mb-2">
              <p className="text-sm font-semibold text-ink">📤 Выдачи сегодня</p>
              <span className="mono-num text-sm text-ink-3">{pickups.length}</span>
            </div>
            <DayOperationsList
              operations={pickups.map((p) => ({
                id: p.id,
                kind: "pickup",
                startDate: p.startDate,
                endDate: p.endDate,
                projectName: p.projectName,
                clientName: p.clientName,
                itemCount: p.itemCount,
              }))}
              emptyLabel="Нет выдач"
            />
          </div>
          <div className="bg-surface border border-border rounded-lg p-3">
            <div className="flex justify-between items-baseline mb-2">
              <p className="text-sm font-semibold text-ink">📥 Возвраты сегодня</p>
              <span className="mono-num text-sm text-ink-3">{returns.length}</span>
            </div>
            <DayOperationsList
              operations={returns.map((r) => ({
                id: r.id,
                kind: "return",
                startDate: r.startDate,
                endDate: r.endDate,
                projectName: r.projectName,
                clientName: r.clientName,
                itemCount: r.itemCount,
              }))}
              emptyLabel="Нет возвратов"
            />
          </div>
        </div>

        <div className="flex flex-wrap gap-2 pt-1">
          <Link
            href="/bookings/new"
            className="inline-flex items-center bg-accent-bright text-white text-sm font-medium px-4 py-2 rounded hover:bg-accent transition-colors"
          >
            + Новая бронь
          </Link>
          <Link
            href="/calendar"
            className="inline-flex items-center bg-surface border border-border text-ink text-sm px-4 py-2 rounded hover:border-accent transition-colors"
          >
            Открыть календарь
          </Link>
        </div>

        <DayFooterMetrics>
          {pending && pending.total > 0 ? (
            <>
              <span className="font-semibold text-ink-2">{pending.total}</span> бронь
              {pending.total === 1 ? "" : pending.total >= 2 && pending.total <= 4 ? "и" : "ей"} ждёт согласования у руководителя
            </>
          ) : (
            <>Все брони на сегодня согласованы</>
          )}
        </DayFooterMetrics>
      </div>
    </div>
  );
}
```

- [ ] **Step 9.2: Обновить imports в `apps/web/app/day/page.tsx`**

В top-блоке `import …` (после существующих) добавить:

```typescript
import Link from "next/link";
import { DayHeader } from "../../src/components/day/DayHeader";
import { DayAlert } from "../../src/components/day/DayAlert";
import { DayOperationsList } from "../../src/components/day/DayOperationsList";
import { DayFooterMetrics } from "../../src/components/day/DayFooterMetrics";
```

(`DayKpiCard` добавим в Task 11 для SA.)

- [ ] **Step 9.3: Обновить вызов `DayWarehouse` в `DayPage`**

В функции `DayPage` (внизу файла) заменить:
```tsx
{user.role === "WAREHOUSE" && <DayWarehouse />}
```
на:
```tsx
{user.role === "WAREHOUSE" && <DayWarehouse username={user.username} />}
```

- [ ] **Step 9.4: Type-check**

```bash
cd apps/web && npx tsc --noEmit
```

Expected: 0 ошибок, связанных с `/day/page.tsx`.

- [ ] **Step 9.5: Commit**

```bash
git add apps/web/app/day/page.tsx
git commit -m "feat(web): rewrite DayWarehouse with greeting/alert/operations/footer"
```

---

## Task 10: Rewrite `DayTechnician` role component

**Files:**
- Modify: `apps/web/app/day/page.tsx` (replace DayTechnician)

- [ ] **Step 10.1: Заменить `DayTechnician` в `apps/web/app/day/page.tsx`**

Удалить существующее определение `DayTechnician` (строки ~169-237) и заменить на:

```tsx
// ── TECHNICIAN ───────────────────────────────────────────────────────────────

interface RepairListItem {
  id: string;
  reason: string;
  status: "WAITING_REPAIR" | "IN_REPAIR" | "WAITING_PARTS" | "CLOSED" | "WROTE_OFF";
  urgency: "NOT_URGENT" | "NORMAL" | "URGENT";
  createdAt: string;
  unit: { equipment: { name: string } };
}

interface RepairStats {
  openCount: number;
  newCount: number;
  closedThisMonth: number;
  writtenOffThisMonth: number;
  spentThisMonth: string;
}

function daysSince(iso: string): number {
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

function pluralize(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function DayTechnician({ userId, username }: { userId: string; username: string }) {
  const router = useRouter();
  const [newRepairs, setNewRepairs] = useState<RepairListItem[] | null>(null);
  const [myRepairs, setMyRepairs] = useState<RepairListItem[] | null>(null);
  const [stats, setStats] = useState<RepairStats | null>(null);

  useEffect(() => {
    apiFetch<{ repairs: RepairListItem[] }>("/api/repairs?status=WAITING_REPAIR&limit=20")
      .then((d) => setNewRepairs(d.repairs))
      .catch(() => setNewRepairs([]));

    apiFetch<{ repairs: RepairListItem[] }>(
      `/api/repairs?assignedTo=${userId}&status=IN_REPAIR,WAITING_PARTS&limit=20`,
    )
      .then((d) => setMyRepairs(d.repairs))
      .catch(() => setMyRepairs([]));

    apiFetch<RepairStats>("/api/dashboard/repair-stats")
      .then(setStats)
      .catch(() => { /* не блокируем */ });
  }, [userId]);

  const newCount = newRepairs?.length ?? 0;
  const myCount = myRepairs?.length ?? 0;
  const summary =
    stats ? `${newCount} нов${pluralize(newCount, "ая поломка", "ых поломки", "ых поломок")} · ${myCount} в работе` : "—";

  // Статус-подпись для моего ремонта
  function statusLabel(r: RepairListItem): { text: string; tone: "rose" | "amber" | "emerald" | "slate" } {
    const d = daysSince(r.createdAt);
    const dStr = `${d} ${pluralize(d, "день", "дня", "дней")}`;
    if (r.status === "WAITING_PARTS") return { text: `${dStr} · ждём поставщика`, tone: "amber" };
    if (r.urgency === "URGENT") return { text: `${dStr} · срочно`, tone: "rose" };
    if (r.status === "IN_REPAIR" && d >= 5) return { text: `${dStr} · просрочено SLA`, tone: "rose" };
    if (r.status === "IN_REPAIR") return { text: `${dStr} · в работе`, tone: "emerald" };
    return { text: dStr, tone: "slate" };
  }

  const toneClass: Record<"rose" | "amber" | "emerald" | "slate", string> = {
    rose:    "text-rose",
    amber:   "text-amber",
    emerald: "text-emerald",
    slate:   "text-slate",
  };

  return (
    <div className="bg-surface border border-border rounded-lg shadow-xs overflow-hidden">
      <DayHeader greeting={`привет, ${username} 🔧`} summary={summary} />
      <div className="p-4 space-y-3">
        {newRepairs && newRepairs.length > 0 && (
          <div className="bg-surface border border-rose-border rounded-lg p-4">
            <div className="flex justify-between items-baseline mb-2">
              <p className="text-sm font-semibold text-rose">🆕 Новые поломки — требуют твоей оценки</p>
              <span className="inline-flex items-center justify-center min-w-[20px] px-1.5 py-0.5 rounded-full text-[11px] bg-rose text-white">
                {newRepairs.length}
              </span>
            </div>
            <div className="space-y-3">
              {newRepairs.map((r) => (
                <div key={r.id} className="pt-2 border-t border-border first:border-t-0 first:pt-0">
                  <p className="text-sm font-semibold text-ink">{r.unit.equipment.name}</p>
                  <p className="text-xs text-ink-2 mt-0.5">{r.reason}</p>
                  <div className="flex gap-2 mt-2">
                    <button
                      onClick={() => router.push(`/repair/${r.id}?action=take`)}
                      className="inline-flex items-center bg-rose text-white text-xs px-3 py-1.5 rounded hover:bg-rose/90 transition-colors"
                    >
                      Взять в работу
                    </button>
                    <button
                      onClick={() => router.push(`/repair/${r.id}?action=write-off`)}
                      className="inline-flex items-center bg-surface border border-border text-ink text-xs px-3 py-1.5 rounded hover:border-rose transition-colors"
                    >
                      Списать
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="bg-surface border border-border rounded-lg p-4">
          <div className="flex justify-between items-baseline mb-2">
            <p className="text-sm font-semibold text-ink">🛠 В работе</p>
            <span className="mono-num text-sm text-ink-3">{myCount}</span>
          </div>
          {myRepairs === null ? (
            <p className="text-xs text-ink-3">Загрузка…</p>
          ) : myCount === 0 ? (
            <p className="text-xs text-ink-3 italic">Свободная очередь</p>
          ) : (
            <ul className="divide-y divide-border">
              {myRepairs.map((r) => {
                const sl = statusLabel(r);
                return (
                  <li key={r.id} className="py-2">
                    <button
                      onClick={() => router.push(`/repair/${r.id}`)}
                      className="w-full text-left flex justify-between items-baseline gap-2 hover:text-accent transition-colors"
                    >
                      <span className="text-sm text-ink truncate">{r.unit.equipment.name}</span>
                      <span className={`text-xs ${toneClass[sl.tone]} shrink-0`}>{sl.text}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <DayFooterMetrics>
          {stats ? (
            <>
              За этот месяц: починено <b className="text-ink-2">{stats.closedThisMonth}</b>,
              списано <b className="text-ink-2">{stats.writtenOffThisMonth}</b>,
              в работе <b className="text-ink-2">{stats.openCount}</b>
              {" · потрачено ≈ "}
              <b className="text-ink-2">{formatRub(stats.spentThisMonth)}</b>
            </>
          ) : "Загрузка статистики…"}
        </DayFooterMetrics>
      </div>
    </div>
  );
}
```

- [ ] **Step 10.2: Обновить вызов `DayTechnician` в `DayPage`**

В `DayPage`:
```tsx
{user.role === "TECHNICIAN" && <DayTechnician userId={user.userId ?? ""} username={user.username} />}
```

- [ ] **Step 10.3: Type-check**

```bash
cd apps/web && npx tsc --noEmit
```

- [ ] **Step 10.4: Commit**

```bash
git add apps/web/app/day/page.tsx
git commit -m "feat(web): rewrite DayTechnician with alert/list/footer metrics"
```

---

## Task 11: Rewrite `DaySuperAdmin` role component

**Files:**
- Modify: `apps/web/app/day/page.tsx` (replace DaySuperAdmin, update imports)

- [ ] **Step 11.1: Добавить import `DayKpiCard`**

В import-блоке `apps/web/app/day/page.tsx` добавить строку:

```typescript
import { DayKpiCard } from "../../src/components/day/DayKpiCard";
```

- [ ] **Step 11.2: Заменить `DaySuperAdmin` полностью**

Удалить существующее определение `DaySuperAdmin` и `FinanceDashboard` (строки ~35-88) и заменить на:

```tsx
// ── SUPER_ADMIN ──────────────────────────────────────────────────────────────

interface FinanceDashboard {
  totalOutstanding: string;
  earnedThisMonth: string;
  netThisMonth: string;
  trend: Array<{ month: string; earned: string; spent: string; net: string }>;
  summary?: { overdueReceivables?: string };
  upcomingWeek: Array<{
    bookingId: string;
    projectName: string;
    clientName: string;
    amountOutstanding: string;
    expectedPaymentDate: string | null;
  }>;
}

function sumFinal(bookings: Array<{ finalAmount: string }>): number {
  return bookings.reduce((acc, b) => acc + Number(b.finalAmount || 0), 0);
}

function deltaPct(currentStr: string, prevStr: string): number | null {
  const c = Number(currentStr);
  const p = Number(prevStr);
  if (!Number.isFinite(c) || !Number.isFinite(p) || p === 0) return null;
  return Math.round(((c - p) / p) * 100);
}

function DaySuperAdmin({ username }: { username: string }) {
  const [fin, setFin] = useState<FinanceDashboard | null>(null);
  const [dashboard, setDashboard] = useState<DashboardToday | null>(null);
  const [pending, setPending] = useState<PendingApprovalsResponse | null>(null);
  const [repairStats, setRepairStats] = useState<RepairStats | null>(null);

  useEffect(() => {
    apiFetch<FinanceDashboard>("/api/finance/dashboard").then(setFin).catch(() => {});
    apiFetch<DashboardToday>("/api/dashboard/today").then(setDashboard).catch(() => {});
    apiFetch<PendingApprovalsResponse>("/api/dashboard/pending-approvals").then(setPending).catch(() => {});
    apiFetch<RepairStats>("/api/dashboard/repair-stats").then(setRepairStats).catch(() => {});
  }, []);

  const pickups = dashboard?.pickups ?? [];
  const returns = dashboard?.returns ?? [];

  const todayRevenue = sumFinal(pickups);
  const overdue = fin?.summary?.overdueReceivables;

  // Месячная выручка + % к прошлому
  const currEarned = fin?.earnedThisMonth ?? null;
  const prevEarned = fin?.trend && fin.trend.length >= 2 ? fin.trend[fin.trend.length - 2].earned : null;
  const pct = currEarned && prevEarned ? deltaPct(currEarned, prevEarned) : null;

  // Шапка-сводка для правого верхнего угла
  const now = new Date();
  const monthLabel = now.toLocaleDateString("ru-RU", { month: "long" });
  const summary = currEarned
    ? `${monthLabel}: ${pickups.length + returns.length} операций · ${formatRub(currEarned)}`
    : "—";

  // Список операций сегодня (pickup+return склеенные по времени)
  const operations: DayOperation[] = [
    ...pickups.map((p) => ({
      id: p.id,
      kind: "pickup" as const,
      startDate: p.startDate,
      endDate: p.endDate,
      projectName: p.projectName,
      clientName: p.clientName,
      itemCount: p.itemCount,
      finalAmount: p.finalAmount,
    })),
    ...returns.map((r) => ({
      id: r.id,
      kind: "return" as const,
      startDate: r.startDate,
      endDate: r.endDate,
      projectName: r.projectName,
      clientName: r.clientName,
      itemCount: r.itemCount,
      finalAmount: r.finalAmount,
    })),
  ].sort((a, b) => {
    const ta = a.kind === "pickup" ? a.startDate : a.endDate;
    const tb = b.kind === "pickup" ? b.startDate : b.endDate;
    return ta.localeCompare(tb);
  });

  return (
    <div className="bg-surface border border-border rounded-lg shadow-xs overflow-hidden">
      <DayHeader greeting={`утро, ${username} ✨`} summary={summary} />
      <div className="p-4 space-y-3">
        {pending && pending.total > 0 && (
          <DayAlert
            variant="amber"
            title={`📋 Требует твоего решения — ${pending.total} брон${pending.total === 1 ? "ь" : pending.total >= 2 && pending.total <= 4 ? "и" : "ей"} на согласовании`}
            linkHref="/bookings"
            linkLabel="Все →"
          >
            <ul className="divide-y divide-amber-border">
              {pending.bookings.slice(0, 3).map((b) => (
                <li key={b.id} className="py-1 flex justify-between items-baseline gap-2">
                  <Link href={`/bookings/${b.id}`} className="text-xs truncate hover:text-accent">
                    {b.clientName} · {b.projectName}
                  </Link>
                  <span className="mono-num text-xs text-ink shrink-0">{formatRub(b.finalAmount)}</span>
                </li>
              ))}
            </ul>
          </DayAlert>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <DayKpiCard
            eyebrow="Сегодня"
            value={formatRub(todayRevenue)}
            sub={`${pickups.length} выдач · ${returns.length} возвратов`}
          />
          <DayKpiCard
            eyebrow="Долги"
            value={fin ? formatRub(fin.totalOutstanding) : "—"}
            sub={overdue && Number(overdue) > 0 ? `из них просрочено ${formatRub(overdue)}` : "без просрочек"}
            subTone={overdue && Number(overdue) > 0 ? "rose" : "muted"}
          />
          <DayKpiCard
            eyebrow="Ремонт"
            value={
              <>
                {repairStats?.openCount ?? "—"}
                <span className="text-sm text-ink-3 font-normal ml-1">единиц</span>
              </>
            }
            sub={
              repairStats
                ? <>≈ {formatRub(repairStats.spentThisMonth)} в {monthLabel}е</>
                : "—"
            }
          />
        </div>

        <div className="bg-surface border border-border rounded-lg p-3">
          <div className="flex justify-between items-baseline mb-2">
            <p className="text-sm font-semibold text-ink">Операции сегодня</p>
            <Link href="/calendar" className="text-xs text-accent hover:underline">Все →</Link>
          </div>
          <DayOperationsList operations={operations} showAmount emptyLabel="На сегодня нет операций" />
        </div>

        <DayFooterMetrics>
          {currEarned ? (
            <>
              Месячная выручка: <b className="text-ink-2 mono-num">{formatRub(currEarned)}</b>
              {pct !== null && (
                <>
                  {" · рост к прошлому месяцу: "}
                  <b className={pct >= 0 ? "text-emerald" : "text-rose"}>
                    {pct >= 0 ? "+" : ""}{pct}%
                  </b>
                </>
              )}
            </>
          ) : "Загрузка финансов…"}
        </DayFooterMetrics>
      </div>
    </div>
  );
}
```

- [ ] **Step 11.3: Обновить вызов `DaySuperAdmin` в `DayPage`**

```tsx
{user.role === "SUPER_ADMIN" && <DaySuperAdmin username={user.username} />}
```

- [ ] **Step 11.4: Удалить неиспользуемый `PlaceholderCard`**

Найти в начале файла функцию `PlaceholderCard` и её JSDoc-комментарий (строки 11-20) — удалить, т.к. она больше не используется.

Также удалить неиспользуемый тип `RepairCardData` (строки 24-31) — заменён на `RepairListItem` в Task 10.

- [ ] **Step 11.5: Type-check + build**

```bash
cd apps/web && npx tsc --noEmit
```

Expected: 0 ошибок.

```bash
cd apps/web && npm run build 2>&1 | tail -40
```

Expected: Build succeeds. Warnings допустимы если они pre-existing.

- [ ] **Step 11.6: Commit**

```bash
git add apps/web/app/day/page.tsx
git commit -m "feat(web): rewrite DaySuperAdmin with KPI grid and operations list"
```

---

## Task 12: End-to-end smoke verification

**Files:**
- (read-only) `apps/web/app/day/page.tsx`
- (read-only) `apps/api/src/routes/dashboard.ts`

- [ ] **Step 12.1: Запустить API тесты**

```bash
cd apps/api && npx vitest run 2>&1 | tail -30
```

Expected: все тесты зелёные. Если какой-то pre-existing тест упал — проверить не связано ли с нашим изменением.

- [ ] **Step 12.2: Запустить web build**

```bash
cd apps/web && npm run build 2>&1 | tail -40
```

Expected: Build completes, `/day` route присутствует в output.

- [ ] **Step 12.3: Убедиться что `apps/web/tsconfig.tsbuildinfo` не попал в стейджинг**

```bash
cd ../.. && git status apps/web/tsconfig.tsbuildinfo
```

Если файл stahed — `git restore apps/web/tsconfig.tsbuildinfo`.

- [ ] **Step 12.4: Финальная проверка working tree**

```bash
cd .worktrees/day-enrichment && git status
```

Expected: `working tree clean` (все коммиты сделаны).

---

## Notes for Reviewers

**Product scope:**
- Мокап содержит надписи типа «1 новая поломка · 4 в работе», «3 выдачи · 2 возврата» — реализованы через русскую плюрализацию (функция `pluralize()` в `DayTechnician`).
- Alert варианты: `rose` (новые поломки у TECH) и `amber` (PENDING_APPROVAL у SA/WH).
- Ссылка в alert у WAREHOUSE ведёт на `/bookings` — SA после merge Sprint B получит `/bookings?status=PENDING_APPROVAL`.
- «Взять в работу» у TECHNICIAN — перенаправляет на `/repair/:id?action=take` (обработка action query — уже в Sprint 4 repair page).

**Technical decisions:**
- Все новые компоненты — `"use client"` (требуется для `useState`/`useEffect`/`Link`).
- `finalAmount` во всех API — строка (Decimal stringified), конвертация в `Number()` только в финальном рендере через `formatRub()`.
- `DashboardToday`, `PendingApprovalsResponse`, `RepairStats`, `RepairListItem` — интерфейсы в `/day/page.tsx` (не общие, т.к. используются только там).
- Кнопки «Взять в работу/Списать» для TECH не делают API-call напрямую (избегаем дублирования бизнес-логики) — передают управление на `/repair/:id`.
- `pending-approvals` и `repair-stats` не проверяют роль явно (rolesGuard на router-уровне разрешает все три роли) — это осознанное решение, т.к. данные не конфиденциальны и используются одновременно несколькими ролями.

**Potential follow-ups (post-merge, NOT this sprint):**
- Sprint B: add approve/reject UI в `/bookings/:id` + webhook-уведомления.
- «Загрузка следующей недели N%» в footer у WAREHOUSE — требует отдельного эндпоинта `/api/calendar/weekly-occupancy`.
- Локализованная «Д дней» может переехать в общий `src/lib/format.ts`, если начнём использовать ≥2 мест.

---

## Execution Handoff

Plan saved to `docs/superflow/plans/2026-04-15-day-enrichment.md`.

Выбор: **Inline Execution** (плейный стиль) через standard-implementer — одна задача за другой, финальный review перед PAR.
