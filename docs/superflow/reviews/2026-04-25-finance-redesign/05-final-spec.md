# Финансы: финальная спецификация (Agent 5)

## TL;DR

1. **Phase 1 — это PDF Счёт + PDF Акт + терминология + объединённые «Платежи»**, а не aging. Aging переносится в Phase 2 целиком, потому что без `Invoice.dueDate` он остаётся декорацией. Reframe Agent 4 — главная боль founder'а — это документ, который клиент-бухгалтер требует на бумаге.
2. **Booking — единственный источник истины о деньгах сделки.** `/finance/*` — это агрегации и фильтры. Карточка брони `/bookings/[id]` — главный финансовый экран. На ней появляются явные CTA «Скачать счёт PDF» и «Скачать акт PDF» (в Phase 1, ещё до модели Invoice).
3. **Invoice — отдельная модель в Phase 2 с numbering `LR-YYYY-NNNN`, dual-mode легаси без backfill подделок.** Старые брони остаются на `Booking.amountOutstanding` (legacy=true), новые — на `Invoice`. Через 6 месяцев — cleanup. Бухгалтерия не получает ни одного фантомного «выставленного счёта».
4. **WAREHOUSE получает явное расширение прав** (cash-only до 100 000 ₽ на одну операцию, на свою или текущую брони в `ISSUED|RETURNED`). Это документируется в матрице ролей `CLAUDE.md`. Без лимита WH с iPhone из дома мог бы «принимать» наличку по чужим броням.
5. **Cancel-with-deposit имеет три явные ветки:** возврат / удержать как кредит на следующую бронь / удержать как штраф (forfeit). Каждая — отдельный аудит-action, отдельный UX-flow на отмене брони.

## Что изменилось vs Agent 3 после критики Agent 4

| Gap (Agent 4) | Severity | Решение в Agent 5 |
|---|---|---|
| **Phase 1 ≠ no-schema quick wins.** F4 без Invoice.dueDate физически не закрыть. | HIGH | Phase 1 переописан: aging уезжает в Phase 2 полностью. В Phase 1 на `/finance/debts` — текущая логика `computeDebts()` с UI-полировкой и работающим экспортом, без «пустых bucket'ов». В Phase 1 добавляются: PDF Счёт, PDF Акт, объединение `/finance/payments` × `/finance/payments-overview`, удаление `prompt()`, role-gate на кнопке «Записать оплату», единая модалка `RecordPaymentModal`, рабочие period-фильтры, terminology pass, redirect legacy URLs. Каждый пункт — реальный коммит. |
| **Backfill «один FULL invoice per Booking» — токсичная миграция.** Поддельные номера, фиктивные dueDate, ФНС-риск. | HIGH | **Никакого backfill**. Dual-mode: `Booking.legacyFinance: Boolean` (default `true` для всех существующих ≤ migration_cutoff). Pre-cutoff брони рендерят финансовую секцию по старой логике (только `Payment[]`, без Invoice). Post-cutoff — через Invoice. Aging-buckets считаются только по `Invoice.dueDate` post-cutoff. На первые 6 месяцев pre-cutoff брони продолжают работать без изменений; через год — cleanup-проект, где менеджер вручную закрывает старые «открытые остатки» либо помечает их как «архив». |
| **Invoice numbering не специфицирован.** Race conditions, void-дыры, ФНС. | HIGH | Формат: `LR-YYYY-NNNN`, year-reset (с 1 января — `NNNN` = 0001), monotonic per year. Реализация: PostgreSQL/SQLite sequence через `prisma.$transaction` + retry на P2002. Void **сохраняет номер** (видно в UI как `LR-2026-0042 — АННУЛИРОВАН`); никакого re-issue под тем же номером. Префикс `LR` настраивается в `/settings/organization` (например `СКМ` если другая аббревиатура). Нумерация Light Rental ≠ нумерация бухгалтерии в 1С — это явно зафиксировано в spec и в UI («Внутренний номер счёта»). |
| **WAREHOUSE — privilege expansion без признания.** Skin-deep «без меню, но с кнопкой» — это leaky abstraction. | HIGH | Признаётся явно как изменение матрицы ролей. WAREHOUSE получает `payment.write` с тремя гарантиями: (1) only `cash` или `card_terminal` — никаких bank wires (это деньги клиента уже в системе, нечего «принимать»); (2) `amount ≤ 100 000 ₽` — больше требует SUPER_ADMIN approval; (3) только на бронях со статусом `ISSUED` или `RETURNED` (когда логично взять нал). CLAUDE.md role table обновляется. Нарушение лимита → 403 + audit `PAYMENT_LIMIT_EXCEEDED`. |
| **Cancel-with-deposit lifecycle не описан.** Самый частый РФ-кейс. | HIGH | Отдельная секция (см. ниже) + отдельный мокап `cancel-with-deposit-flow.html`. Три ветки: refund / hold-as-credit / forfeit-as-fee. Каждая = audit-action + изменение в InvoiceStatus или CreditNote запись. UI — пошаговый wizard на cancel-модалке. |

Дополнительно интегрированы reframe-предложения Agent 4:

- **Reframe 2 (PDF Счёт + Акт = real founder pain)** — главное в Phase 1. Все мокапы карточки брони и страницы счетов имеют видимые CTA «Скачать счёт PDF» / «Скачать акт PDF».
- **Reframe 1 (`expectedPaymentDate` UI как cheap wedge)** — отвергнут. Spec идёт по Phase 1 без `expectedPaymentDate`-input, потому что это полу-фикс без модели Invoice; вместо этого Phase 2 даёт полноценный `Invoice.dueDate`.
- **Reframe 3 (WH cash-on-issue = warehouse-feature)** — частично принят: кнопка «Записать оплату» появляется в `/warehouse/scan` после успешной выдачи как часть Phase 1 (используя единую `RecordPaymentModal`), но это не отдельный мини-PR — она встроена в общий редизайн как третья точка входа модалки.

## Money model

### Сущности (финал)

| Сущность | Phase | Назначение |
|---|---|---|
| `Booking` | exists | Источник правды о сделке. `legacyFinance` boolean флаг. `amountOutstanding`, `paymentStatus` остаются как computed для legacy + transitional UI. |
| `Invoice` | Phase 2 (new) | Документ-обязательство. Нумеруется. Иммутабельна сумма после ISSUED. |
| `Payment` | exists | Факт получения денег. Phase 2 добавляет `invoiceId?`, `voidedAt?`, `voidedBy?`, `voidReason?`. |
| `Refund` | Phase 2 (new) | Запись о возврате денег. Связан с Payment. |
| `CreditNote` | Phase 2 (new) | Удержанный депозит как кредит на будущую бронь. Создаётся в cancel-with-deposit flow при выборе ветки «hold». |
| `Expense` | exists | Исходящий платёж. Расширяется `linkedBookingId?` в Phase 2. |

### Invoice (минимальная)

```prisma
model Invoice {
  id            String        @id @default(cuid())
  bookingId     String
  number        String        @unique  // LR-YYYY-NNNN
  kind          InvoiceKind   // FULL | DEPOSIT | BALANCE | CORRECTION
  total         Decimal
  paidAmount    Decimal       @default(0)
  status        InvoiceStatus // DRAFT | ISSUED | PARTIALLY_PAID | PAID | OVERDUE | VOIDED
  dueDate       DateTime
  issuedAt      DateTime?
  voidedAt      DateTime?
  voidReason    String?
  legacy        Boolean       @default(false)  // не используется в Phase 2 — резерв
  createdBy     String
  createdAt     DateTime      @default(now())
  payments      Payment[]
  refunds       Refund[]
}
```

`kind=BALANCE` (вместо `FINAL` у Agent 3) — потому что в РФ-практике «финальный счёт» = итоговый, а здесь это «счёт на остаток» после депозита. `BALANCE` точнее.

### Numbering: format LR-YYYY-NNNN

- **Формат:** `LR-2026-0001`, ширина `NNNN` = 4 цифры, year-reset с 1 января.
- **Префикс `LR`** настраивается в `/settings/organization` (Phase 2). Изменение префикса не пересчитывает существующие номера.
- **Race protection:** все issue-операции в `prisma.$transaction`, селект `MAX(number_int) WHERE year=YYYY` + insert. На P2002 (unique violation) — retry до 3 раз с jitter.
- **Void semantics:** voided invoice сохраняет номер. UI показывает `LR-2026-0042 · АННУЛИРОВАН`. Гэпы в нумерации допустимы, потому что **Light Rental — операционная нумерация, не бухгалтерская**. В UI и PDF-шаблоне внизу мелким текстом: «Внутренний номер счёта Light Rental. Бухгалтерская нумерация ведётся в 1С отдельно.»
- **Out-of-scope:** синхронизация с 1С — Phase 4+. Сейчас явно говорим бухгалтеру, что эти номера — наши, не его.

### Связь Booking → Invoice → Payment

```
Booking ────1:N──── Invoice ────1:N──── Payment ────1:0..1──── Refund
   │
   │ legacyFinance=true → пропускает Invoice, использует Payment напрямую (старая модель)
   │
   └────1:N──── Expense (linkedBookingId опционально)
   └────1:0..1── CreditNote (cancel-with-deposit hold)
```

Computed fields (не stored):
- `Invoice.paidAmount` = `sum(payments.amount where !voidedAt) - sum(refunds.amount)`
- `Invoice.status` = computed из paidAmount/dueDate/voidedAt
- `Booking.amountOutstanding` (legacy=true) = старая логика. (legacy=false) = `sum(invoices.where(!voided).total) - sum(invoices.where(!voided).paidAmount)`

### Что меняется в Phase 1 без schema

В Phase 1 ничего из вышенаписанного **не вводится в БД**. В Phase 1 только:
- UI убирает `prompt()` quick-add, заменяет единой модалкой;
- Объединяются `/finance/payments` и `/finance/payments-overview`;
- Добавляется PDF Счёт + PDF Акт через новый сервис `documentExport/` (без модели Invoice — счёт генерится по `Booking.finalAmount` с реквизитами организации, номер формата `LR-YYYY-NNNN-DRAFT` помечен как «предварительный, до выставления в Phase 2»);
- Terminology, period-filters, role-gate на кнопке.

Это значит: PDF Счёт в Phase 1 — это **черновой счёт по броне**, без Invoice-сущности. Бухгалтер клиента получает PDF. С Phase 2 черновой счёт превращается в реальный Invoice с нумерацией.

## Навигация (финальная)

### Меню

| Пункт | URL | SUPER_ADMIN | WAREHOUSE | TECHNICIAN |
|---|---|:-:|:-:|:-:|
| Финансы (раздел) | — | да | нет | нет |
| Финансы / Дашборд | `/finance` | да | — | — |
| Финансы / Счета | `/finance/invoices` | да (Phase 2+) | — | — |
| Финансы / Дебиторка | `/finance/debts` | да | — | — |
| Финансы / Платежи | `/finance/payments` | да | — | — |
| Финансы / Расходы | `/finance/expenses` | да | (через `/repair`) | — |

WAREHOUSE финансового меню не получает. Доступ к одной операции — `RecordPaymentModal` — точечно: на `/bookings/[id]` (с лимитами) и на `/warehouse/scan` (после выдачи). Это явное изменение матрицы прав, см. секцию «Roles & permissions».

Удаляются:
- `/finance/payments-overview` — мерджится в `/finance/payments` (redirect legacy URL → 301).
- `/finance/payments` (legacy heatmap) — UI поглощается единой страницей; route остаётся, контент новый.
- `/finance/forecast` — out-of-scope в Phase 1–2; в Phase 3 возвращается как widget на `/finance`, не отдельный URL.

## Pages — per-page спека

### 1. `/finance` — финансовый дашборд

**Назначение:** Founder за 3 секунды видит «всё ок ли с деньгами и что делать сегодня».

**Структура (сверху вниз):**

1. **Header:** «Финансы» + period-selector (Сегодня / 7 дней / 30 дней / Квартал / Год / Кастом). Active в URL `?period=`. Все KPI пересчитываются.
2. **KPI strip — 4 карточки:**
   - **Получено** (Σ Payment.amount без voidedAt за period) — sparkline 30 дней. Drill → `/finance/payments?period=...`.
   - **Расходы** (Σ Expense.amount approved за period) — drill → `/finance/expenses?period=...`.
   - **Задолженность** (Σ outstanding) — цвет `rose` если > 0. Drill → `/finance/debts`.
   - **Прибыль** (Получено − Расходы за period) — emerald или rose в зависимости от знака.
3. **Action ribbon** — две primary CTA: «Записать платёж» (открывает `RecordPaymentModal`), «Создать счёт» (Phase 2+; в Phase 1 — «Скачать счёт PDF» по выбранной брони).
4. **Top-debtors widget** (5 строк): клиент / сумма / самый старый долг (дни). Каждая строка кликабельна → `/finance/debts?client=...`.
5. **Recent activity feed** — 8 последних финансовых событий: платёж получен / счёт скачан / расход добавлен / refund. Каждое событие — кто, когда, сумма. Из `AuditEntry`.

**Действия и CTA:** period-switch, drill в KPI/строки, primary CTA «Записать платёж».

**Mobile (390px):** KPI становятся 2×2 grid; action ribbon — full-width buttons stacked; debtors — карточный список; activity feed — список без иконок.

**Empty state:** «Долгов нет. Все счета оплачены 👌».

**Friction'ы:** F5 (period работает), F6 (термин «Получено»), F7 (одна правда о выручке), F8 (KPI кликабельны), F11 (один экран), F12 (empty с CTA), F14 (один источник aggregate).

### 2. `/finance/invoices` — счета (Phase 2+)

**Назначение:** Список всех счетов с tabs/filters/bulk-actions.

**В Phase 1 страница не существует.** В UI footer на `/bookings/[id]` есть кнопка «Скачать счёт PDF» — она и есть «invoice» Phase 1.

**Структура (Phase 2):**

1. **Header:** «Счета» + поиск + period-selector + «+ Создать счёт» (SUPER_ADMIN only).
2. **Tabs:** К выставлению (DRAFT) | Выставлено (ISSUED) | Частично (PARTIALLY_PAID) | Оплачено (PAID) | Просрочено (OVERDUE) | Аннулированные (VOIDED). Счётчики на табах.
3. **Таблица:** № счёта · Клиент · Бронь · Тип (Полный/Предоплата/Остаток) · Сумма · Оплачено · Остаток · Срок · Статус (StatusPill). Sortable. Inline-actions: ₽ (record payment), 📄 (download PDF), ⋯ (void with reason, edit due date).
4. **Bulk:** checkboxes + «Выставить выбранные» (DRAFT → ISSUED).
5. **Empty state:** «Счетов в этом табе нет. Брони, готовые к выставлению — на /finance».

**Mobile:** карточный список вместо таблицы; sticky filter chip strip.

**Friction'ы:** F3 (DEPOSIT/BALANCE как явный kind), F4 (dueDate реальный), F11 (всё что про invoice — здесь).

### 3. `/finance/debts` — дебиторка / aging

**Назначение:** Кому позвонить сегодня. В Phase 1 — без bucket'ов; в Phase 2 — с цветным светофором.

**Структура Phase 1:**
- Header «Дебиторка» + поиск + период.
- Таблица: Клиент · Сумма долга · Самый старый счёт · Статус контакта · Действия. Sortable.
- Inline-actions per-row: «₽ Записать платёж», «📞 Связаться» (`tel:` + `mailto:` стек ссылок, реальные).
- «Отправить напоминания» **убрана** (была пустышкой); вместо неё bulk-action не показывается до Phase 3.
- Экспорт XLSX — реальный.

**Структура Phase 2 (добавляется):**
- **Aging-bucket таблица сверху:** 5 колонок (Текущая · 1–30 · 31–60 · 61–90 · 90+). Цвет фона ячеек: `slate-soft` → `amber-soft` → `amber-soft` (deeper) → `rose-soft` → `rose-soft` (deeper). Toggle «Только просроченные».
- Drill в ячейку → раскрывается список конкретных invoice в этом бакете.

**Mobile (390px) Phase 2:** aging-таблица скроллится по горизонтали; альтернатива — вертикальный аккордеон по бакетам (карточка на бакет).

**Empty state:** «Долгов нет. Можно выпить кофе ☕».

**Friction'ы:** F4 (Phase 2 — наполнение), F6 (XLSX работает, «связаться» — реальный `tel:`/`mailto:` в Phase 1, шаблонный email в Phase 3).

### 4. `/finance/payments` — журнал платежей (объединённый)

**Назначение:** Что пришло, по каким способам, сверка кассы.

**Структура:**
1. **Header:** «Платежи» + period + «Записать платёж» CTA.
2. **Per-method totals strip** (P10): «Все · Наличные · Карта · Перевод · Онлайн». Каждый chip с тоталом за period: `Наличные: 340 000 ₽`. Кликабельные — фильтруют таблицу.
3. **Filter bar:** период, клиент, метод, тип (приход/расход/refund), включить/исключить аннулированные.
4. **Таблица:** Дата · Клиент · Бронь (или —) · Метод · Сумма (зелёный) или Возврат (красный с минусом) · Кто принял · Статус · Действия. Sortable.
5. **Inline-actions per-row (SA only):** «Оформить возврат» (Phase 2 — RefundModal), «Аннулировать» (void, требует reason min 3).
6. **Bulk:** экспорт XLSX за выбранные.

**Mobile:** chips horizontally scrollable; таблица превращается в карточки.

**Empty state:** «Платежей за период нет. Записать вручную или импортировать из Тинькофф (Phase 3).»

**Friction'ы:** F1 (одна модалка), F11 (одна страница), F9 (delete → void).

### 5. `/finance/expenses` — расходы

**Назначение:** Исходящие платежи + связи с ремонтом/броней.

**Структура:**
1. **Header:** «Расходы» + period + category-filter + «+ Записать расход».
2. **Approved vs pending split** (P9) — две KPI: «Утверждено за период» / «Ожидает утверждения (N)». Pending клик → фильтр.
3. **Categories pills:** Запчасти / Транспорт / Зарплата / Закупка / Прочее. Активная — токен `accent-soft`.
4. **Donut chart** (как сейчас) — оставляем.
5. **Таблица:** Дата · Категория · Сумма (rose) · Описание · Привязка (Ремонт #N / Бронь #N — кликабельные!) · Документ · Статус (approved/pending). Inline-actions: approve, edit (только pending), void (только pending, SA).
6. **Linked-to-booking / linked-to-repair** — явный визуальный badge на строке.

**Mobile:** category pills horizontally scrollable; таблица → карточки с big amount sum.

**Empty state:** «Расходов за период нет. Запишите первый — кнопка справа.»

**Friction'ы:** F10 (привязка кликабельна).

### 6. `/bookings/[id]` — финансовый блок брони (главное!)

**Это самый важный экран.** Booking — источник правды; здесь живут деньги конкретной сделки.

**Структура финансового блока (внутри страницы брони):**

1. **Шапка финансовой секции** — eyebrow «Финансы» + два StatusPill отдельно:
   - «Бронь: Возвращена» (booking.status)
   - «Деньги: Частично оплачен · остаток 30 000 ₽» (computed money status)
2. **Сумма-сводка** (mono-num): `Сумма: 100 000 ₽ · Получено: 70 000 ₽ · Остаток: 30 000 ₽`. Если есть refund — `· Возвращено клиенту: 0 ₽`.
3. **CTA-row** — primary actions:
   - «Записать платёж» (роль-gated, см. permissions)
   - «Скачать счёт PDF» (всегда, генерит на лету; в Phase 1 — черновой; в Phase 2 — выпускной из Invoice)
   - «Скачать акт PDF» (при `booking.status == RETURNED && outstanding == 0`; иначе disabled с tooltip)
   - «Создать счёт» (Phase 2+, SA only) — превращает черновой PDF в issued Invoice
4. **Секция «Счета»** (Phase 2+) — список Invoice. В Phase 1 эта секция не показывается; на её месте — единая сумма и список платежей.
5. **Секция «Платежи»** — список Payment. Per-row: дата · метод · сумма · кто принял · действия (void для SA). Voided платежи серым со штриховкой.
6. **Секция «Хронология денег»** (P4, collapsible default-collapsed) — реверс-хронология events: счёт сгенерирован → депозит получен → выдано → возврат → финал получен. Источник: `Payment[]` + `AuditEntry`.
7. **Секция «Связанные расходы»** (P8, SA only) — read-only список Expense с linkedBookingId. Маржа = `finalAmount - sum(approved expenses)`. WH не видит.

**Mobile (390px) — критично:**
- Шапка + сумма-сводка — всегда visible.
- CTA-row — **sticky bottom** (3 кнопки в одну строку: «₽ Платёж», «PDF Счёт», «PDF Акт»). При scroll — остаётся внизу. Это закрывает Challenge 13 от Agent 4.
- Остальные секции — collapsible, default-collapsed (кроме «Платежи» — открыто).

**Empty states:**
- Нет платежей → «Платежей пока нет. Запишите первый — кнопка ниже.»
- Нет счетов (Phase 2) → «Счёт не выставлен. Кнопка “Скачать счёт PDF” сгенерит черновик.»

**Friction'ы:** закрывает F1, F2 (role-gate), F10, F18 (sparkline можно убрать на mobile).

## Cancel-with-deposit flow

### Сценарий

Клиент (например «Ромашка Продакшн») оформил бронь на 100 000 ₽, внёс депозит 30 000 ₽. За 3 дня до съёмки — отмена. Что с деньгами?

### Три ветки

#### Ветка A — Полный возврат
- **Когда:** клиент уведомил заранее (≥ 7 дней по policy организации); съёмка не сорвалась по нашей вине; клиент-VIP.
- **UX:**
  1. На `/bookings/[id]` SA нажимает «Отменить бронь».
  2. Если `Σ payments > 0` — открывается **CancelWithDepositModal** (3 шага).
  3. Шаг 1 — выбор ветки: радиокнопки «Полный возврат / Удержать как кредит / Удержать как штраф».
  4. Шаг 2 (для A) — заполнение `Refund`: amount (preset = total received), method (cash/card/bank — на какой method вернули; по умолчанию = тот же, что был у payment), reason (min 3).
  5. Шаг 3 — confirm. Запись `Refund`. `Booking.status` → `CANCELLED`. Audit `BOOKING_CANCELLED_REFUND_FULL` + `PAYMENT_REFUNDED`.
- **Финальное состояние:** Booking CANCELLED · `Σ payments - Σ refunds = 0`. На `/finance/payments` появляются обе записи (приход + возврат). KPI «Получено» за период не меняется (payment + refund = 0 net).

#### Ветка B — Удержать как кредит на следующую бронь
- **Когда:** клиент попросил перенести; перенос на конкретную дату/бронь; политика организации позволяет.
- **UX:**
  1. Шаги 1 повторяет.
  2. Шаг 2 (для B) — выбор: «Применить к существующей броне» (dropdown) или «Сохранить как открытый кредит».
  3. Шаг 3 — confirm. Запись `CreditNote { clientId, amount, status: OPEN | APPLIED, appliedToBookingId? }`. Booking → CANCELLED. Original `Payment` НЕ refund'ится — деньги физически у нас. Audit `BOOKING_CANCELLED_CREDIT_HOLD`.
- **Финальное состояние:** Payment остаётся. CreditNote=OPEN. На `/finance/debts` у клиента отображается «Кредит: 30 000 ₽ (доступен для следующей брони)». При создании новой брони — кнопка «Применить кредит клиента (30 000 ₽)» → автоматическая привязка `CreditNote.appliedToBookingId` + `Payment.creditNoteRef`.

#### Ветка C — Удержать как штраф (forfeit, non-refundable)
- **Когда:** клиент отменил поздно; политика — депозит не возвращается; spec'ы организации.
- **UX:**
  1. Шаг 1 повторяется.
  2. Шаг 2 (для C) — поле «Причина удержания» (min 3) + opt-in checkbox «Уведомить клиента email/телефон» (Phase 3+). Phase 1–2 — только запись.
  3. Шаг 3 — confirm. Booking → CANCELLED. Original `Payment` остаётся. Создаётся `Expense { category: FORFEITED_DEPOSIT_INCOME, amount: -30000, ... }` (отрицательный расход = доход) — это спорный момент, альтернатива см. ниже. Audit `BOOKING_CANCELLED_FORFEIT`.
- **Альтернатива technical:** не создавать Expense, а пометить Payment как `forfeitedAt` и в KPI «Получено» это включается отдельной категорией «Удержанные депозиты». Spec выбирает второй вариант — чище.
- **Финальное состояние:** Booking CANCELLED. Payment остался, помечен `forfeitedAt`. На `/finance` KPI «Получено» включает forfeit. На `/finance/payments` строка с badge «Удержан» (warn).

### UI вход — где появляется кнопка

- На `/bookings/[id]` если `status ∉ {CANCELLED, RETURNED} && Σ payments > 0`: кнопка «Отменить» открывает CancelWithDepositModal.
- Если `status ∈ {DRAFT, PENDING_APPROVAL} && Σ payments == 0`: обычная отмена без модалки.

### Audit

| Action | When | Detail |
|---|---|---|
| `BOOKING_CANCELLED_REFUND_FULL` | A | reason, refundAmount |
| `BOOKING_CANCELLED_REFUND_PARTIAL` | A с partial | reason, refundAmount, retainedAmount |
| `BOOKING_CANCELLED_CREDIT_HOLD` | B | creditNoteId, amount |
| `BOOKING_CREDIT_APPLIED` | при использовании на новой броне | sourceBookingId, targetBookingId, amount |
| `BOOKING_CANCELLED_FORFEIT` | C | reason, forfeitedAmount |

## Roles & permissions

### Финансовая матрица доступа (финал)

| Действие | SUPER_ADMIN | WAREHOUSE | TECHNICIAN |
|---|:-:|:-:|:-:|
| Видеть `/finance` (все экраны) | ✓ | ✗ | ✗ |
| Видеть финансовый блок на `/bookings/[id]` | ✓ | частично (без «Связанные расходы», без «Хронология денег» в полном виде) | ✗ |
| Записать платёж (`payment.create`) | ✓ без лимитов | ✓ с лимитами (см. ниже) | ✗ |
| Аннулировать платёж (`payment.void`) | ✓ | ✗ | ✗ |
| Оформить возврат (`refund.create`) | ✓ | ✗ | ✗ |
| Скачать счёт PDF | ✓ | ✓ (только для своих/текущих) | ✗ |
| Скачать акт PDF | ✓ | ✓ | ✗ |
| Создать счёт (`invoice.create`, Phase 2) | ✓ | ✗ | ✗ |
| Аннулировать счёт (`invoice.void`) | ✓ | ✗ | ✗ |
| Записать расход | ✓ | через `/repair` (только REPAIR-категория) | ✗ |
| Утвердить расход (`expense.approve`) | ✓ | ✗ | ✗ |
| Cancel-with-deposit modal | ✓ | ✗ | ✗ |
| Видеть `/finance/forecast` (Phase 3) | ✓ | ✗ | ✗ |

### WAREHOUSE limits (новое расширение прав)

WAREHOUSE может записывать платёж только при ВСЕХ выполнении условий:

1. `booking.status ∈ {ISSUED, RETURNED}` (логичный момент приёма налом).
2. `payment.method ∈ {cash, card_terminal}` — только физические метод; никаких bank wire.
3. `payment.amount ≤ 100 000 ₽` per operation. Если клиент даёт больше — две записи (audit покажет split).
4. Платёж пишется на ту бронь, по которой WH в данный момент работает (на сканере) или на которую открыта `/bookings/[id]`.

Нарушение → 403 `PAYMENT_LIMIT_EXCEEDED` + audit `PAYMENT_LIMIT_VIOLATED` для observability. UI заранее блокирует submit.

### Изменения в CLAUDE.md role table

Добавить в существующую таблицу `## UserRole и rolesGuard` секцию:

```
### Финансовые операции (новое)

| Маршрут | SUPER_ADMIN | WAREHOUSE | TECHNICIAN |
|---|---|---|---|
| POST /api/payments (cash/card_terminal, ≤100k ₽, ISSUED|RETURNED only) | ✓ | ✓ | ✗ |
| POST /api/payments (bank_transfer или > 100k ₽) | ✓ | ✗ (403 PAYMENT_LIMIT_EXCEEDED) | ✗ |
| POST /api/payments/:id/void | ✓ | ✗ | ✗ |
| POST /api/refunds | ✓ | ✗ | ✗ |
| POST /api/invoices | ✓ | ✗ | ✗ |
| GET /api/invoices/:id/pdf | ✓ | ✓ (only own bookings) | ✗ |
| GET /api/bookings/:id/act-pdf | ✓ | ✓ | ✗ |
| Cancel-with-deposit | ✓ | ✗ | ✗ |
```

## Phasing (исправленный)

### Phase 1 — реально шиппит без schema (один спринт ~ неделя)

Цель: устранить broken affordances + дать **PDF Счёт + PDF Акт** + объединить два Платежа + единая модалка + role-gate.

Каждый пункт = один atomic коммит в один PR.

| # | Коммит | Закрывает |
|---|---|---|
| 1 | feat(web): unified `/finance/payments` (мерж payments × payments-overview), redirect `/finance/payments-overview` → `/finance/payments` | F1, F11 |
| 2 | refactor(web): replace `quickAddPayment` prompt() with single `RecordPaymentModal` component, used on /bookings/[id], /finance/payments, /warehouse/scan post-issue | F1 |
| 3 | feat(web): role-gate «Записать платёж» button — show only when WH сatisfies limits or SA | F2 |
| 4 | feat(api): WH-limits middleware — POST /api/payments rejects WH violations with 403 PAYMENT_LIMIT_EXCEEDED + audit | F2 (proper) |
| 5 | feat(web): working period-selector on /finance, /finance/payments, /finance/expenses (URL `?period=` + Moscow TZ helpers) | F5 |
| 6 | feat(web): KPI cards on /day и /finance — wrapped in `<Link>` for click-through | F8 |
| 7 | feat(web): empty states with CTA на всех finance страницах | F12 |
| 8 | feat(api): new service `apps/api/src/services/documentExport/invoice/` — generates PDF Счёт от `Booking`. Реквизиты из ENV (Phase 1) или `/settings/organization` (Phase 2) | reframe 2, founder pain |
| 9 | feat(api): new service `apps/api/src/services/documentExport/act/` — generates PDF Акт оказанных услуг при booking RETURNED + outstanding == 0 | reframe 2 |
| 10 | feat(web): «Скачать счёт PDF» / «Скачать акт PDF» CTA on /bookings/[id] финансовый блок | reframe 2 |
| 11 | feat(web): remove «Удалить платёж» button from UI; replace with «Аннулировать (void)» — modal с required reason. Backend в Phase 1 ещё `paymentService.deletePayment` (UI маска) — но с audit-write reason. | F9 |
| 12 | refactor(web): terminology pass — глобальный поиск/замена в 6 файлах + `apps/web/src/lib/financeTerms.ts` glossary; AuditEntry strings не трогаются (исторические остаются) | F6, F7 |
| 13 | feat(web): «Связаться» на /finance/debts — `tel:`/`mailto:` стек ссылок, рабочий | F6 partial |
| 14 | refactor(web): «Отправить напоминания» — кнопка убрана; «Экспорт XLSX» — рабочий через server-side exceljs | F6 |
| 15 | feat(web): linked-to-repair / linked-to-booking badges на /finance/expenses, кликабельные | F10 |
| 16 | feat(web): impл «Импортировать legacy-брони» переезжает с /finance/debts на новый блок (или скрывается до Phase 2 с TODO-комментом) | F13 |

После Phase 1: founder может выдать клиенту PDF Счёт и PDF Акт (главная боль решена); WH может принять нал на сканере с лимитами; терминология единая; UI без broken affordances. Никаких миграций БД.

### Phase 2 — Invoice model + aging + cancel-with-deposit (две-три недели)

| # | Suб-task | Schema? |
|---|---|---|
| 1 | Schema migration: `Invoice`, `Refund`, `CreditNote` модели; `Booking.legacyFinance` Boolean default true (для всех существующих); `Payment.invoiceId?`, `Payment.voidedAt`, `Payment.voidedBy`, `Payment.voidReason` | yes (additive) |
| 2 | Service `apps/api/src/services/invoiceService.ts`: createInvoice, issueInvoice (DRAFT→ISSUED), voidInvoice, recomputeInvoiceStatus | — |
| 3 | Service `numberingService.ts`: generateInvoiceNumber('LR-YYYY-NNNN', year-reset, monotonic, retry on P2002) | — |
| 4 | Routes: `POST /api/invoices`, `POST /api/invoices/:id/issue`, `POST /api/invoices/:id/void`, `POST /api/refunds`, `POST /api/credit-notes`, all with rolesGuard SA | — |
| 5 | Settings page `/settings/organization` (новая): ИНН, банк, БИК, р/с, юр.лицо, адрес, префикс номера | yes (`OrganizationSettings` model) |
| 6 | Migration cutoff: `migrationCutoffAt` в OrganizationSettings, defaults to deploy date. Брони `createdAt < cutoff` → `legacyFinance=true`, остальные `false`. | — |
| 7 | UI `/finance/invoices` — список + tabs + filters + bulk-issue + per-row actions (void, edit dueDate) | — |
| 8 | UI `/finance/debts` — aging buckets с цветным светофором (только для post-cutoff bookings) | — |
| 9 | UI на /bookings/[id]: секция «Счета», кнопка «Создать счёт», обновлённый «Скачать счёт PDF» (теперь от Invoice если есть, иначе draft-by-booking) | — |
| 10 | UI: `RefundModal`, `CancelWithDepositModal` (3-step wizard), `CreditNoteApplyModal` | — |
| 11 | UI: aging-buckets / cancel-with-deposit / credit notes на mobile (390px) — sticky bottom CTA на /bookings/[id], horizontal scroll на aging | — |
| 12 | Backfill: `Payment` → расставить `invoiceId` для post-cutoff bookings, где платёж создан после Invoice. Pre-cutoff — не трогаем. | scripted, reversible |
| 13 | Migrate Phase 1 «Удалить (UI mask) → паттерн `voidedAt`» — теперь real soft-void. Hard delete API endpoint удалить. | — |

Гарантия: ни одна historical бронь не получает фантомный invoice. Бухгалтер не видит фейков.

### Phase 3 — Polish (post-MVP)

- `/finance/forecast` widget на `/finance` (P11) — stacked bar + «Подтверждённый pipeline» (не «Гарантированный»), `confirmed.unpaid` + historical conversion rate.
- Загрузка документа на расход (file upload, ≤ 5 МБ) — F16.
- Per-method cash reconciliation: snapshot тоталов «закрытие смены» с записью в audit.
- Email/SMS-напоминания должникам — реальная интеграция; кнопка «Отправить напоминание» становится живой; шаблоны.
- Категории расходов через DB (F17) вместо enum.
- Margin sparkline на брони (P8).
- Multi-method analytics (top methods by period, conversion rate).
- Refund tracking polish (refund reasons categorisation, refund-rate KPI).
- `/finance/reconcile` — импорт CSV из Тинькофф Бизнес → side-by-side match.

## Out-of-scope (явно)

1. Фискальные чеки / 54-ФЗ / онлайн-касса — отдельный проект.
2. УПД / счёт-фактура — Phase 4+ (просили в Phase 3, но это другой документ).
3. 1С интеграция / синхронизация нумерации — Phase 4+.
4. Multi-currency (USD/EUR продакшны) — out-of-scope; при попытке создать invoice в не-RUB → 400 `MULTI_CURRENCY_NOT_SUPPORTED`.
5. Bot endpoints для finance — не трогаются. Бот не работает с финансами.
6. Полноценный bank-feed (live API из Тинькофф) — даже Phase 3 ограничен импортом CSV.
7. Loyalty / подписки / абонементы — нет.
8. ML forecast — нет (Phase 3 forecast — детерминированный).
9. Подписи документов в системе (КЭП) — нет.
10. Approval flow для расходов > X тыс. ₽ — текущий approve остаётся как есть.

## Edge cases (закрыты)

| # (Agent 4) | Ситуация | Решение |
|---|---|---|
| 1 | Бронь CONFIRMED с депозитом → CANCELLED | Cancel-with-deposit flow, 3 ветки. См. секцию выше. |
| 2 | Платёж записан на неправильную бронь | Phase 2 SA: void + create на правильной броне. Audit показывает обе записи. |
| 3 | Два платежа в один день: 50k cash + 30k card | Per-method chips на `/finance/payments` показывают независимые тоталы. Если refund 20k наличными — выбор payment-source при оформлении refund (по умолчанию = последний с этой суммы method). |
| 4 | Refund: full vs partial vs different-method | RefundModal Phase 2: amount input (≤ payment.amount), method dropdown (default = original method), reason min 3. |
| 5 | Currency не RUB | Out-of-scope explicit; создание invoice в не-RUB → 400. |
| 6 | Late return → доп. аренда | Phase 2: новый Invoice с `kind=CORRECTION`, ссылка на оригинальный booking. |
| 7 | Discount после issue | Phase 2: void original + reissue с `kind=CORRECTION`. UI Phase 3 — wizard «Изменить счёт» (под капотом void+reissue). |
| 8 | Bank wire в пути | Не вводим Payment.PENDING. Если клиент сказал «отправил» — это invoice со status=ISSUED. Платёж пишется только при факте получения. |
| 9 | ФНС-выписка XLSX | Phase 1 export XLSX на `/finance/payments` (date · client · method · amount · purpose). Формат — простой; ФНС-специфика — Phase 4+. |
| 10 | Concurrent issue двух invoice | DB unique + `prisma.$transaction` + retry on P2002. См. Numbering section. |
| 11 | Два депозита подряд (30% + ещё 30%) | Phase 2: invoice.kind=DEPOSIT можно создать несколько раз. UI на /bookings/[id] — кнопка «+ Доп. предоплата». |
| 12 | Удаление AdminUser, создавшего Payment/Invoice | FK Restrict (как у `AuditEntry`). P2003 → 409 `ADMIN_HAS_FINANCE_HISTORY`. |

Edge case 11 — **новый**: что если клиент попросил третий деп. Решение: не ограничиваем количество DEPOSIT-invoice на бронь.

## Терминология (финальная таблица)

| Старое (в коде/UI) | Новое (canonical) | Где используется | Обоснование |
|---|---|---|---|
| «Выручка» (на /day) | «План выдач сегодня» | `/day` SA card | На /day показываем сумму будущих выдач — это план, не факт. F6, F7. |
| «Сколько заработал» | «Получено» | `/finance` KPI | Cash basis, термин РФ (Тинькофф, МойСклад). F6. |
| «Долги» / «Кто должен» / «Задолженность» | «Дебиторка» (canonical) / «Задолженность» (KPI как conversational) | `/finance/debts`, `/finance` KPI | Один термин для домена. |
| «Поступления» / «Платежи» / «Оплаты» | «Платежи» | URL, меню, заголовки | Один термин. |
| «Принят» / «Зафиксирован» / «Оплачено» | «Оплачен» (про счёт, мужской) | StatusPill для Invoice | По грамматическому роду счёта. |
| «Не оплачено» | «Не оплачен» / «Частично оплачен» / «Просрочен» | Invoice.status pills | P6. |
| «Сумма сметы» / «Итог» / «Final amount» | «Сумма счёта» (на инвойсе) / «Сумма брони» (на брони) | `/bookings/[id]`, `/finance/invoices` | Разделение слоёв. |
| «Плановая дата платежа» / «expectedPaymentDate» / «срок» | «Срок оплаты» (= `Invoice.dueDate`) | UI/API | Один термин. F4. |
| «Депозит» / «Аванс» / «Залог» | «Предоплата» (canonical для invoice.kind=DEPOSIT); UI может говорить «Аванс 30%» как синоним | UI labels | Нейтрально, без коллизии с банковским «депозитом». |
| «Удалить платёж» | «Аннулировать платёж (void)» | UI | F9, P12, A2. |
| «Гарантированный pipeline» (Agent 3) | «Подтверждённый pipeline» | `/finance/forecast` Phase 3 | Снимает обещание, которое не выполнится (Agent 4 Challenge 14). |

Для AuditEntry-строк: исторические записи остаются на старой терминологии. Новые записи пишутся на новой. См. CLAUDE.md `apps/web/src/lib/financeTerms.ts`.

## Заключение

Spec прошёл 5 NEEDS_FIXES от Agent 4. Phase 1 — реально шипит **PDF Счёт + PDF Акт** (главная боль founder'а), объединение страниц и единую модалку **без миграций**. Phase 2 — Invoice как полноценная модель с numbering и dual-mode legacy. Phase 3 — polish и интеграции.

Главный архитектурный сдвиг: Booking — источник правды; `/finance/*` — агрегации. WAREHOUSE расширяется явно с лимитами (cash-only, ≤100k, status-gated) — задокументировано в матрице ролей. Cancel-with-deposit имеет три ветки UI, каждая со своим audit. Backfill не делает фантомных invoice — dual-mode сохраняет историю чистой.

Дизайн-канон IBM Plex полностью соблюдён: ноль hex, существующие токены и StatusPill variants, mono-num и formatRub. Mobile (390px) — sticky-bottom CTA на `/bookings/[id]` для primary action.

STATUS: DONE

<!-- updated-by-superflow:2026-04-25 -->

