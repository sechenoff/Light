# Customer Portal `/lk` — design spec

**Date:** 2026-05-24
**Scope:** Подпроект 1+2 — новый клиентский портал `/lk`. Отдельная от `/admin` и `/gaffer` ветка интерфейса для гафферов-клиентов рентала: вход по magic-link, история заказов, история смет, долг перед ренталом, статистика «что чаще берёшь» и «твой типовой набор», калькулятор команды, ссылка на внешний калькулятор электрической нагрузки.
**Out of scope this sprint:** самозаказ из портала (создание брони, корзина, оформление) — это Подпроект 3, отдельная спека. Также вне scope: email-дайджесты/нотификации, загрузка документов с портала, multi-tenant Client (один аккаунт = много ЮЛ).

---

## 1. Access and routing

- **URL-префикс:** `/lk` (личный кабинет). Не пересекается с `/gaffer` (Gaffer CRM Sprint 2A) и `/admin`.
- **Публичные маршруты** (без сессии):
  - `/lk/login` — форма ввода email
  - `/lk/login/sent` — экран «Ссылка отправлена»
  - `/lk/verify?token=<raw>` — приёмник magic-link, серверная проверка → cookie → редирект на `/lk`
- **Гейтированные маршруты** (требуют `lk_session` cookie):
  - `/lk` — dashboard
  - `/lk/bookings` — список заказов
  - `/lk/bookings/[id]` — детали заказа
  - `/lk/estimates` — список смет
  - `/lk/stats` — статистика
  - `/lk/debt` — долг
  - `/lk/crew-calculator` — калькулятор команды
  - `/lk/tools` — ссылки на внешние инструменты (включая `calc.svetobazarent.ru`)
- **Без `lk_session`** на гейт-маршруте → редирект на `/lk/login` (server component `redirect()` в `apps/web/app/lk/layout.tsx`).
- **Layout-обёртка:** `apps/web/app/lk/layout.tsx` с тёмной шапкой, навигацией и mobile-first responsive. НЕ использует `AppShell` (он для admin).
- **Меню в шапке `/lk`:** Dashboard · Заказы · Сметы · Долг · Статистика · Команда · Инструменты · «Выйти».

---

## 2. Data model — новые Prisma-модели

```prisma
model ClientPortalAccount {
  id                    String    @id @default(cuid())
  clientId              String    @unique                // 1:1 с Client
  email                 String    @unique
  status                ClientPortalAccountStatus @default(PENDING)
  invitedAt             DateTime?
  acceptedAt            DateTime?                        // первый успешный вход
  lastLoginAt           DateTime?
  lastLoginIp           String?
  lastLoginUa           String?
  failedLoginAttempts   Int       @default(0)            // счётчик последовательных неудач verify
  lockedUntil           DateTime?                        // временный lockout после 3 неудач
  invitedBy             String?                          // AdminUser.id (без FK — как Task.createdBy)
  disabledAt            DateTime?
  disabledBy            String?                          // AdminUser.id (без FK)
  createdAt             DateTime  @default(now())
  updatedAt             DateTime  @updatedAt

  client       Client                  @relation(fields: [clientId], references: [id], onDelete: Cascade)
  magicLinks   ClientPortalMagicLink[]

  @@index([email])
  @@index([status])
}

enum ClientPortalAccountStatus {
  PENDING       // приглашение отправлено, ещё не активирован
  ACTIVE        // активирован хотя бы один раз
  DISABLED      // отключён админом
}

model ClientPortalMagicLink {
  id          String   @id @default(cuid())
  accountId   String
  tokenHash   String   @unique                   // HMAC-SHA256 от raw-токена; raw в БД не хранится
  purpose     ClientPortalMagicLinkPurpose
  expiresAt   DateTime
  usedAt      DateTime?                          // single-use; проставляется в той же tx, что и issue cookie
  ip          String?
  ua          String?
  createdAt   DateTime @default(now())

  account ClientPortalAccount @relation(fields: [accountId], references: [id], onDelete: Cascade)

  @@index([accountId, purpose])
  @@index([expiresAt])
}

enum ClientPortalMagicLinkPurpose {
  INVITE        // первое приглашение от админа, TTL 24h
  LOGIN         // повторный вход, TTL 15 минут
}
```

**Расширение существующей `Client`** — добавляется обратная связь `portalAccount ClientPortalAccount?`. Никакие существующие поля Client не меняются.

**`AuditEntityType` расширяется** значением `"ClientPortalAccount"` для записей `CLIENT_PORTAL_INVITE_SENT`, `CLIENT_PORTAL_LOGIN`, `CLIENT_PORTAL_LOGIN_FAILED`, `CLIENT_PORTAL_DISABLED`, `CLIENT_PORTAL_REENABLED`.

---

## 3. Auth flow

### 3.1 Magic-link issue (admin-invited)

1. Админ в `/admin` (или будущей `/clients`) на карточке клиента жмёт «Дать доступ в кабинет».
2. UI просит подтвердить email (preset из `Client.email` если есть, иначе ввод).
3. `POST /api/admin/clients/:id/portal-invite { email }` (SUPER_ADMIN only).
4. Сервер:
   - В `prisma.$transaction`: создаёт/обновляет `ClientPortalAccount` (status=PENDING, invitedAt=now, invitedBy=req.adminUser.id, email).
   - Генерирует raw token (32 случайных байта, base64url, ~43 символа).
   - Создаёт `ClientPortalMagicLink` с `tokenHash = hmacSha256(rawToken, secret)`, `purpose=INVITE`, `expiresAt = now + 24h`.
   - Пишет `AuditEntry { action: "CLIENT_PORTAL_INVITE_SENT", entityType: "ClientPortalAccount", entityId: account.id }`.
   - Отправляет email со ссылкой `https://<host>/lk/verify?token=<rawToken>` (см. §3.4 про email-транспорт).
5. Возвращает 200 `{ accountId, email, expiresAt }`. Сам токен **не возвращается** в API-ответе.

### 3.2 Login flow (повторный)

1. Клиент на `/lk/login` вводит email → `POST /api/lk/auth/request-login { email }`.
2. Сервер:
   - Rate-limit: 5 запросов / 15 мин / IP + per-email lockout 15 мин после 3 неудачных запросов подряд.
   - Если `ClientPortalAccount(email=...)` существует и `status=ACTIVE` → создаёт magic-link `purpose=LOGIN, expiresAt=now+15m`, шлёт email.
   - Если не существует или DISABLED — **молча игнорирует** (no enumeration).
   - **Всегда возвращает 200** `{ ok: true }`.
3. UI делает редирект на `/lk/login/sent` (универсальный экран «Если email есть в системе, ссылка отправлена»).

### 3.3 Verify flow

1. Клиент кликает ссылку → `/lk/verify?token=<raw>` (Next.js server component).
2. Server делает `POST /api/lk/auth/verify { token }` от лица браузера (внутренний proxy), либо валидирует напрямую в server component.
3. Сервер в `prisma.$transaction`:
   - `tokenHash = hmacSha256(raw, secret)`.
   - Находит `ClientPortalMagicLink(tokenHash)`. Если нет → 401.
   - Проверяет `usedAt IS NULL`, `expiresAt > now`. Иначе → 401.
   - Атомарно: `update magicLink set usedAt=now`. Race-condition защита: `WHERE usedAt IS NULL` (если затёрто 0 строк — token уже использован).
   - Если `purpose=INVITE` и `account.status=PENDING`: переводит в ACTIVE, `acceptedAt=now`.
   - Обновляет `account.lastLoginAt=now`.
   - Пишет `AuditEntry { action: "CLIENT_PORTAL_LOGIN", entityType: "ClientPortalAccount", entityId, after: { ip, ua } }`.
4. Возвращает JWT cookie `lk_session` (httpOnly, secure в prod, sameSite=lax, TTL 30 дней, path=/).
5. Server-side redirect на `/lk`.

Невалидный/просроченный токен → редирект на `/lk/login` с toast «Ссылка недействительна или истекла».

### 3.4 Email transport

- **Библиотека:** `nodemailer` (новая зависимость в `apps/api`).
- **Env vars:** `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` (например `"Светобаза" <noreply@svetobazarent.ru>`).
- **Dev fallback:** если `SMTP_HOST` отсутствует и `NODE_ENV !== "production"` — логировать ссылку в консоль API (для локального тестирования). В prod без SMTP — `throw` на старте сервера (fail-loud).
- **Шаблон email:** простой HTML/text, на русском. Тема: «Доступ в личный кабинет — Светобаза» (для INVITE) или «Вход в личный кабинет — Светобаза» (для LOGIN). Тело: имя клиента (если есть), кнопка-ссылка, срок действия (24ч или 15м).
- **Файл:** `apps/api/src/services/clientPortal/mailer.ts`. Функции: `sendInviteEmail(account, rawToken)`, `sendLoginEmail(account, rawToken)`. Без HTML-templating-движка — inline-строки.

### 3.5 Session model

- **JWT secret:** `CLIENT_PORTAL_SESSION_SECRET` (≥16 символов, обязателен в prod).
- **Cookie name:** `lk_session`. Отдельный namespace от `lr_session` (admin) и `gaffer_session` (CRM).
- **JWT payload:** `{ accountId: string, clientId: string, email: string }`.
- **TTL:** 30 дней (как gaffer_session).
- **Файл:** `apps/api/src/services/clientPortal/session.ts`. Функции: `signLkSession`, `verifyLkSession`, `lkCookieOptions`. Зеркалит структуру `gaffer/session.ts`.
- **Middleware:** `apps/api/src/middleware/lkAuth.ts` — извлекает токен из cookie `lk_session` или `Authorization: Bearer`, валидирует, кладёт `req.clientPortal = { accountId, clientId, email }`.

### 3.6 Tenant helper

- `apps/api/src/services/clientPortal/tenant.ts`:
  - `lkClientId(req): string` — возвращает `clientId` из `req.clientPortal`, бросает 401 если нет.
  - `assertLkClientOwns<T>(entity: { clientId: string } | null, req): T` — 404 если null или `clientId` не совпадает.
- **Все `/api/lk/*` сервисы используют этот helper.** Никакого `?clientId=` в query — clientId всегда из сессии.

---

## 4. API contracts

Префикс `/api/lk/*` монтируется в `apps/api/src/routes/index.ts`. **НЕ применяется** `apiKeyAuth` к этому неймспейсу — у портала своя auth-цепочка (`lkAuth`).

### 4.1 Auth endpoints

| Route | Method | Auth | Body / Query | Response |
|-------|--------|------|--------------|----------|
| `/api/lk/auth/request-login` | POST | public | `{ email: string }` | `{ ok: true }` (always 200) |
| `/api/lk/auth/verify` | POST | public | `{ token: string }` | 200 `{ ok: true }` + sets `lk_session` cookie / 401 `{ code: "INVALID_TOKEN" }` |
| `/api/lk/auth/logout` | POST | lkAuth | — | 200 `{ ok: true }` + clears cookie |
| `/api/lk/me` | GET | lkAuth | — | `{ account: { email, lastLoginAt }, client: { id, name, phone, email } }` |

### 4.2 Read endpoints

```
GET /api/lk/bookings?cursor=<id>&limit=20
```

Возвращает брони текущего клиента, отсортированные `startDate DESC`. **Видны только** `status IN (PENDING_APPROVAL, CONFIRMED, ISSUED, RETURNED, CANCELLED)`. DRAFT исключён (черновики не должны утекать клиенту).

```ts
type LkBookingListItem = {
  id: string;
  bookingNo: string;             // если есть, иначе null
  projectName: string | null;
  startDate: string;             // ISO
  endDate: string;               // ISO
  status: "PENDING_APPROVAL" | "CONFIRMED" | "ISSUED" | "RETURNED" | "CANCELLED";
  finalAmount: string;           // Decimal as string
  itemCount: number;
  amountOutstanding: string;     // остаток к оплате
};

type LkBookingListResponse = {
  items: LkBookingListItem[];
  nextCursor: string | null;
};
```

```
GET /api/lk/bookings/:id
```

Детали заказа. 404 если `booking.clientId !== req.clientPortal.clientId`.

```ts
type LkBookingDetail = {
  id: string;
  bookingNo: string | null;
  projectName: string | null;
  startDate: string;
  endDate: string;
  status: LkBookingStatus;
  shifts: number;
  items: {
    categorySnapshot: string;
    nameSnapshot: string;
    quantity: number;
    unitPrice: string;
    lineSum: string;
  }[];
  subtotal: string;
  discountAmount: string;
  totalAfterDiscount: string;
  finalAmount: string;
  amountPaid: string;
  amountOutstanding: string;
  comment: string | null;
  optionalNote: string | null;
  hasConfirmedEstimate: boolean;   // показывать ли кнопку «Скачать смету PDF»
  hasAct: boolean;                  // показывать ли «Скачать акт PDF»
};
```

```
GET /api/lk/bookings/:id/estimate.pdf
GET /api/lk/bookings/:id/act.pdf
```

Стримит PDF. **Reuse** существующих рендереров `apps/api/src/services/smetaExport/renderPdf.ts` + соответствующих helpers из `apps/api/src/routes/bookings.ts`. Wrapper-роут в `apps/api/src/routes/lk/bookings.ts` проверяет ownership через `assertLkClientOwns`, затем зовёт рендерер.

```
GET /api/lk/estimates?cursor=<id>&limit=20
```

Плоский список смет (kind=CONFIRMED) по броням клиента. Не дублирует `/bookings` — отдельный взгляд «история смет», полезен когда клиент ищет конкретную смету не помня бронь.

```ts
type LkEstimateListItem = {
  bookingId: string;
  bookingNo: string | null;
  projectName: string | null;
  issuedAt: string;              // estimate.createdAt
  totalAfterDiscount: string;
  pdfUrl: string;                // "/api/lk/bookings/<id>/estimate.pdf"
};
```

```
GET /api/lk/debt
```

Долг текущего клиента. Reuse `computeDebts()` из `apps/api/src/services/finance.ts`, фильтр `clientId = req.clientPortal.clientId`.

```ts
type LkDebtResponse = {
  totalOutstanding: string;
  overdueCount: number;
  invoices: {
    bookingId: string;
    bookingNo: string | null;
    invoiceNumber: string | null;
    issuedAt: string;
    dueDate: string | null;
    finalAmount: string;
    amountPaid: string;
    amountOutstanding: string;
    ageDays: number;             // дней с dueDate (отрицательное если не просрочено)
    isOverdue: boolean;
  }[];
};
```

```
GET /api/lk/stats?period=180|365|all
```

Статистика. Период по умолчанию `365` (12 мес).

```ts
type LkStatsResponse = {
  period: "180d" | "365d" | "all";
  rangeFrom: string | null;       // null если "all"
  rangeTo: string;
  topEquipment: {
    equipmentId: string;
    name: string;
    category: string;
    bookingsCount: number;        // в скольких подтверждённых бронях встречалось
    totalQuantityRented: number;  // Σ BookingItem.quantity
    totalSpentRub: string;        // Σ EstimateLine.lineSum (CONFIRMED estimates)
  }[];                            // top 20, sort by bookingsCount desc, totalSpentRub desc tiebreak
  typicalKit: {
    equipmentId: string;
    name: string;
    category: string;
    frequency: number;            // доля от 0 до 1: в какой части последних N броней встречалось
  }[];                            // позиции с frequency >= 0.4, sort by frequency desc, name asc
  typicalKitSampleSize: number;   // сколько броней в выборке (≤10)
};
```

**Алгоритм topEquipment** (SQL aggregation):
- Бронь в выборку, если `status IN (CONFIRMED, ISSUED, RETURNED)` и `startDate >= rangeFrom` (или без фильтра для `all`).
- Группировка по `BookingItem.equipmentId` (исключая `equipmentId IS NULL` — кастомные позиции).
- `bookingsCount = COUNT(DISTINCT bookingId)`, `totalQuantityRented = SUM(BookingItem.quantity)`, `totalSpentRub = SUM(EstimateLine.lineSum WHERE estimate.kind = CONFIRMED AND line.equipmentId = item.equipmentId AND estimate.bookingId = item.bookingId)`.

**Алгоритм typicalKit:**
- Берём последние 10 броней клиента со `status IN (CONFIRMED, ISSUED, RETURNED)`.
- `sampleSize = min(actualCount, 10)`.
- Для каждой `equipmentId`: `frequency = countOfBookingsWithThisEquipment / sampleSize`.
- Фильтр `frequency >= 0.4` (т.е. позиция встречалась минимум в 4 из 10 последних броней).
- Сортировка по frequency desc.
- Если у клиента <3 броней — возвращаем пустой массив `typicalKit` (мало данных, нет смысла).

### 4.3 Admin endpoints (доступ к управлению порталом)

| Route | Method | Auth | Body | Response |
|-------|--------|------|------|----------|
| `/api/admin/clients/:id/portal-invite` | POST | SA only (rolesGuard) | `{ email: string }` | `{ accountId, email, expiresAt }` |
| `/api/admin/clients/:id/portal-account` | GET | SA only | — | `{ account: ClientPortalAccount \| null }` |
| `/api/admin/clients/:id/portal-account/disable` | POST | SA only | — | `{ ok: true }` (sets DISABLED) |
| `/api/admin/clients/:id/portal-account/reenable` | POST | SA only | — | `{ ok: true }` (sets ACTIVE если был DISABLED) |
| `/api/admin/clients/:id/portal-account/resend` | POST | SA only | — | `{ expiresAt }` (новая INVITE-ссылка) |

Все admin-эндпоинты — под обычным `apiKeyAuth + rolesGuard(["SUPER_ADMIN"])`, не под `lkAuth`. Файл: `apps/api/src/routes/clientPortalAdmin.ts`.

---

## 5. UI pages — что показываем

### 5.1 `/lk/login`

- Карточка по центру, `max-w-[360px]`, IBM Plex.
- Поле email, кнопка «Получить ссылку».
- После submit → редирект на `/lk/login/sent`.

### 5.2 `/lk/login/sent`

- Экран «Если email есть в системе, мы отправили ссылку. Проверь почту.»
- Кнопка «Отправить ещё раз» (с cooldown 60 сек).

### 5.3 `/lk` (dashboard)

Горизонтальная шапка с приветствием `Доброе утро, <Client.name> 👋` (по аналогии с `/day`).

KPI-сетка (3 карточки):
- **Долг** — total ₽ + «N просрочено» если есть; link → `/lk/debt`.
- **Активные брони** — count броней в `ISSUED`; link → `/lk/bookings?status=ISSUED`.
- **Следующая выдача** — ближайшая `CONFIRMED.startDate >= today`, отображается дата + бронь.

Список «Последние 5 заказов» — компактный, ссылки на `/lk/bookings/[id]`.

### 5.4 `/lk/bookings`

Таблица (mobile: карточки):
- Колонки: Дата начала · Проект · Статус (StatusPill) · Сумма · Остаток · `→`
- Filter pills: Все / Активные (ISSUED) / Подтверждённые (CONFIRMED) / Возвращённые (RETURNED) / Отменённые (CANCELLED). URL-state `?status=`.
- Cursor-пагинация «Загрузить ещё».

### 5.5 `/lk/bookings/[id]`

Read-only детали:
- Шапка: bookingNo, projectName, даты, статус, сумма.
- Секция «Позиции»: таблица из `items[]` (категория · название · кол-во · цена · сумма).
- Секция «Финансы»: subtotal, discount, total, paid, outstanding.
- Кнопки: «Скачать смету PDF» (если `hasConfirmedEstimate`), «Скачать акт PDF» (если `hasAct`).
- Без редактирования/отмены — это в Подпроект 3.

### 5.6 `/lk/estimates`

Плоский список смет (CONFIRMED only):
- Колонки: Дата выписки · Бронь · Проект · Сумма · «PDF».
- Cursor-пагинация.

### 5.7 `/lk/stats`

- **Hero**: «За последние 12 месяцев» + переключатель периода (180d / 365d / all).
- **Топ-оборудование** — таблица top-20: Название · Категория · Кол-во заказов · Кол-во раз арендовано · Сумма ₽. Sortable по любой колонке (client-side).
- **Твой типовой набор** — список позиций с `frequency ≥ 40%`, сгруппирован по категории. Показ как badge-grid: `[Aputure 600d × ~80%]`. Подпись: «Часто берёшь — пригодится при создании следующего заказа.» Если выборка <3 броней — placeholder «Появится после нескольких заказов».
- **Без графиков** — таблицы и теги, минималистично. Графики — будущая итерация.

### 5.8 `/lk/debt`

- **Hero KPI**: «Общий долг: X ₽» + «N просрочено».
- **Таблица**: Бронь · Дата сметы · Срок оплаты · Сумма · Оплачено · Остаток · Возраст. Просроченные подсвечены `text-rose` + `bg-rose-soft` строкой.
- **Без кнопки оплаты** — это в Подпроект 3.

### 5.9 `/lk/crew-calculator`

- Порт UI из `apps/web/app/gaffer/crew-calculator/page.tsx`.
- Логика расчёта — `@light-rental/shared` (уже там, не трогать).
- **Без сохранения** — stateless. Сохранение калькуляций в БД портала — будущая итерация.
- URL-state для shareable links (как в `/crew-calculator`).

### 5.10 `/lk/tools`

Простая страница со ссылками:
- **«Калькулятор электрической нагрузки»** — `<a href="https://calc.svetobazarent.ru/" target="_blank" rel="noopener noreferrer">` + описание «Расчёт W/A по приборам, режимы 1ф/3ф».
- Будущие инструменты добавляются сюда.

---

## 6. Admin UI extensions

В `/admin` (вкладка «Клиенты» либо отдельная страница `/admin/clients`) на карточке/строке клиента:

- Если `ClientPortalAccount` нет → кнопка «Дать доступ в кабинет».
  - Модалка: подтверждение email + кнопка «Отправить приглашение».
  - Audit `CLIENT_PORTAL_INVITE_SENT`.
- Если есть и `status=PENDING` → badge «Приглашён, не активирован», кнопки «Переслать ссылку», «Отозвать».
- Если есть и `status=ACTIVE` → badge «Активен (последний вход: дата)», кнопки «Отключить доступ».
- Если есть и `status=DISABLED` → badge «Отключён», кнопка «Восстановить».

Все мутации — через admin-endpoints из §4.3. Все пишут аудит.

**Решение по расположению:** не добавляем новую страницу `/admin/clients` в этой спеке. Используем существующий путь к управлению клиентами через bookings, и добавляем плашку «Доступ в кабинет» либо в `/admin` (новая вкладка «Клиенты с порталом») либо inline в `/bookings/[id]` (клиент-карточка справа). Конкретное место выберется на этапе writing-plans с учётом текущей IA admin-панели.

---

## 7. Security checklist

- [x] Magic-link токены: 32 байта crypto-random (`crypto.randomBytes(32).toString("base64url")`).
- [x] В БД только HMAC-SHA256 hash (`tokenHash`), raw token никогда не персистится.
- [x] Single-use: `usedAt` обновляется в той же tx, что и выпуск cookie (`WHERE usedAt IS NULL` для race protection).
- [x] TTL: INVITE 24h, LOGIN 15m.
- [x] Rate-limit `/api/lk/auth/request-login`: 5/IP/15min + 3 неудачи на email → lockout 15min.
- [x] No enumeration: всегда 200 на request-login.
- [x] Cookie httpOnly + secure (prod) + sameSite=lax + path=/.
- [x] `lkAuth` middleware валидирует подпись и достаёт `clientId` ТОЛЬКО из JWT — никакого `?clientId=` в query.
- [x] `assertLkClientOwns()` на каждом read-эндпоинте: bookingId/estimateId должен принадлежать `req.clientPortal.clientId`.
- [x] Audit: `CLIENT_PORTAL_LOGIN` (успех), `CLIENT_PORTAL_LOGIN_FAILED` (неудачный verify), `CLIENT_PORTAL_INVITE_SENT`, `CLIENT_PORTAL_DISABLED`, `CLIENT_PORTAL_REENABLED`.
- [x] `apiKeyAuth` НЕ применяется к `/api/lk/*` — отдельная цепочка.
- [x] DRAFT-брони не возвращаются клиенту (фильтр в `/api/lk/bookings`).
- [x] PDF-эндпоинты проверяют ownership ДО рендера.
- [x] CSRF: `sameSite=lax` cookie + POST-эндпоинты без cross-site sources защищены де-факто. Если в будущем добавятся mutation-endpoints с cross-origin — добавить CSRF-токен.

---

## 8. Audit и login history

### 8.1 Admin-инициированные действия → существующий `AuditEntry`

Эти действия выполняет реальный `AdminUser` — пишутся в общий journal с `userId = req.adminUser.id`, не нарушая существующего FK `AuditEntry.userId → AdminUser`.

| Action | entityType | entityId | Записывается при |
|--------|------------|----------|------------------|
| `CLIENT_PORTAL_INVITE_SENT` | `ClientPortalAccount` | accountId | админ выдал приглашение |
| `CLIENT_PORTAL_INVITE_RESENT` | `ClientPortalAccount` | accountId | админ переслал приглашение |
| `CLIENT_PORTAL_DISABLED` | `ClientPortalAccount` | accountId | админ отключил доступ |
| `CLIENT_PORTAL_REENABLED` | `ClientPortalAccount` | accountId | админ восстановил доступ |

### 8.2 Portal-side login события → НЕ в AuditEntry

Login события совершает клиент портала, не AdminUser. Чтобы не расслаблять FK на `AuditEntry.userId`, используем уже существующие таблицы:

- **Успешный login:** `ClientPortalMagicLink.usedAt + ip + ua` (single-use → каждая запись = одно успешное использование). Сводный `lastLoginAt/Ip/Ua` дублируется на `ClientPortalAccount` для быстрого чтения.
- **Неудачный verify:** счётчик `ClientPortalAccount.failedLoginAttempts` инкрементируется. После 3 подряд → `lockedUntil = now + 15min`, дальнейшие verify-попытки сразу 401. Успешный verify обнуляет счётчик и снимает lockedUntil. Лог детальных неудач не сохраняется (низкая ценность, GDPR-friendly).

Запрос «история входов для клиента X»: `SELECT * FROM ClientPortalMagicLink WHERE accountId = ? AND usedAt IS NOT NULL ORDER BY usedAt DESC` — даёт полный аудит.

---

## 9. Files (новые и затронутые)

**Новые backend файлы:**
- `apps/api/src/routes/lk/index.ts` — монтаж sub-routes
- `apps/api/src/routes/lk/auth.ts` — request-login, verify, logout, me
- `apps/api/src/routes/lk/bookings.ts` — list, detail, PDF wrappers
- `apps/api/src/routes/lk/estimates.ts` — list
- `apps/api/src/routes/lk/debt.ts` — debt summary
- `apps/api/src/routes/lk/stats.ts` — top equipment + typical kit
- `apps/api/src/routes/clientPortalAdmin.ts` — admin invite/disable/reenable/resend
- `apps/api/src/services/clientPortal/session.ts` — JWT helpers
- `apps/api/src/services/clientPortal/magicLink.ts` — issue/verify
- `apps/api/src/services/clientPortal/mailer.ts` — sendInviteEmail, sendLoginEmail
- `apps/api/src/services/clientPortal/tenant.ts` — lkClientId, assertLkClientOwns
- `apps/api/src/services/clientPortal/statsService.ts` — topEquipment, typicalKit
- `apps/api/src/middleware/lkAuth.ts` — extract & validate session

**Новые frontend файлы:**
- `apps/web/app/lk/layout.tsx` — shell + gate
- `apps/web/app/lk/login/page.tsx`
- `apps/web/app/lk/login/sent/page.tsx`
- `apps/web/app/lk/verify/page.tsx`
- `apps/web/app/lk/page.tsx` — dashboard
- `apps/web/app/lk/bookings/page.tsx`
- `apps/web/app/lk/bookings/[id]/page.tsx`
- `apps/web/app/lk/estimates/page.tsx`
- `apps/web/app/lk/stats/page.tsx`
- `apps/web/app/lk/debt/page.tsx`
- `apps/web/app/lk/crew-calculator/page.tsx`
- `apps/web/app/lk/tools/page.tsx`
- `apps/web/src/components/lk/LkShell.tsx`
- `apps/web/src/components/lk/LkNav.tsx`
- `apps/web/src/components/lk/StatsTopTable.tsx`
- `apps/web/src/components/lk/TypicalKitGrid.tsx`
- `apps/web/src/components/lk/DebtTable.tsx`
- `apps/web/src/lib/lkAuth.ts` — client-side helpers
- `apps/web/src/lib/lkApi.ts` — fetch wrappers
- `apps/web/src/hooks/useLkSession.ts`
- `apps/web/src/components/admin/ClientPortalAccessCard.tsx` (admin-side управление)

**Изменения существующих:**
- `apps/api/prisma/schema.prisma` — новые модели + enum + back-relation на Client + `AuditEntityType += "ClientPortalAccount"`
- `apps/api/src/routes/index.ts` — монтаж `/api/lk` и `/api/admin/clients/:id/portal-*`
- `apps/api/src/services/audit.ts` — расширение union `AuditEntityType`
- `apps/api/src/app.ts` — env-var validation для SMTP в prod
- `apps/api/package.json` — `nodemailer` + `@types/nodemailer`
- `apps/web/package.json` — никаких новых deps (используем существующие)
- `apps/web/app/layout.tsx` — никаких изменений (у `/lk` свой layout)
- `apps/web/src/components/AppShell.tsx` — никаких изменений (не используется в `/lk`)

---

## 10. Testing strategy

### API integration tests (apps/api/src/__tests__/)

- `lkAuth.test.ts` — happy path INVITE flow, повторное использование токена, истёкший токен, неверный hash, DISABLED account
- `lkBookings.test.ts` — tenant isolation (клиент A не видит брони клиента B), DRAFT исключён, PDF ownership
- `lkStats.test.ts` — topEquipment корректно фильтрует по статусам, typicalKit с малой выборкой возвращает []
- `lkDebt.test.ts` — debt-фильтр по clientId, reuse `computeDebts`
- `clientPortalAdminInvite.test.ts` — rolesGuard SUPER_ADMIN, magic-link создаётся, audit пишется
- `lkRateLimit.test.ts` — 6-й запрос за 15 мин → 429

Изолированная SQLite БД через `TEST_DB_PATH`, как в `dashboard.test.ts` / `approval.test.ts`.

### Frontend component tests (apps/web/src/components/lk/__tests__/)

- `LkShell.test.tsx` — редирект на login без cookie
- `StatsTopTable.test.tsx` — рендерит топ, сортируется по клику
- `TypicalKitGrid.test.tsx` — пустое состояние при <3 броней

### Manual / e2e (verify before merge)

- Реальный flow: создать `Client` в seed → invite → получить ссылку из консоли (dev mailer) → verify → увидеть свои брони.
- Mobile-вёрстка: 320 / 375 / 768 / 1440 на каждой странице портала.
- Дизайн-fidelity vs мокапы (когда мокапы будут сделаны на этапе writing-plans).

---

## 11. Open questions

1. **Расположение admin-управления порталом** — отдельная страница `/admin/clients` или плашка в `/bookings/[id]`? Решается на writing-plans с учётом текущей IA admin-панели.
2. **Логотип/брендинг в шапке `/lk`** — нужен ли отдельный логотип для клиентского портала? По умолчанию — текст «Светобаза».
3. **SMTP-провайдер** — Yandex.SMTP? Mailgun? Resend? Решается в инфра-секции writing-plans (нужны креды от user'а). Локально работаем через console-fallback.
4. **Resend invite поведение** — при `POST /portal-account/resend` устаревшие неактивные INVITE-токены того же account'а инвалидируются (`expiresAt = now`) в той же транзакции, что выпускается новый. Подтверждено как часть имплементации.

---

## 12. Future work (за пределами этой спеки)

- **Подпроект 3 — самозаказ:** корзина, «Заказать набор», создание Booking в `PENDING_APPROVAL` напрямую из портала.
- **Notifications:** дайджест-emails («Ваш заказ готов к выдаче», «Просроченный долг»), Telegram-бот.
- **Документы:** загрузка договоров/реквизитов клиентом в портал.
- **Графики статистики:** sparkline-история сезонности, чарт расходов по месяцам.
- **Сохранение калькуляций команды:** персистентность расчётов и привязка к проекту.
- **Передача данных в внешний калькулятор электрики:** если calc.svetobazarent.ru поддержит URL-params, пред-заполнять из текущей корзины.
- **Multi-tenant Client:** один аккаунт → несколько ЮЛ (production house с несколькими гафферами).

---

## 13. Design canon

- IBM Plex Sans / Condensed / Mono (как в admin).
- Tokens: `ink / surface / border / accent / rose / amber / emerald / teal / indigo / slate` (no hex).
- StatusPill для статусов броней (`view` для CONFIRMED/RETURNED, `info` для ISSUED, `warn` для PENDING_APPROVAL, `none` для CANCELLED).
- SectionHeader для разделов.
- Mobile-first: 375px design baseline, 1440px desktop expansion.
- Mockups: создаются на этапе writing-plans, ревьюются пользователем перед имплементацией. Сохраняются в `docs/mockups/lk-portal-<page>.html`.
