# Финансы — спецификация редизайна (Agent 3)

Синтез отчётов Agent 1 (friction walkthrough, F1–F18) и Agent 2 (industry research, P1–P12, A1–A7). Все ссылки на friction'ы — `F#`, на pattern'ы — `P#`, на anti-pattern'ы — `A#`.

## TL;DR

1. Вводим модель **Счёт (Invoice)** как промежуточный слой между бронью и платежом — это закрывает депозит/финал (F3, P1) и даёт чистый aging (F4, P2).
2. **Карточка брони становится главным финансовым экраном** — `/finance/*` это агрегация и фильтры, а не вторая система (закрывает корневую проблему F1, F2, дублирование UI и terminology drift).
3. Сливаем два «Платежей» в один экран `/finance/payments` с per-method chips и единой модалкой «Записать оплату» — устраняет F1, F11, F5.
4. **WAREHOUSE получает узкий доступ к финансам**: одна кнопка «Записать оплату» при выдаче на сканере и на карточке брони (только cash + bank на свою бронь) — закрывает F2 и применяет P10.
5. **Платёж иммутабелен**, корректировка = void+create, частичный возврат = `Refund`-запись (P12, A2). Удаление платежа исчезает из UI (F9).

## Принципы редизайна

1. **Money first, document second.** UI показывает «сколько, чьих, где». Документы (PDF счёта, акта) — это output поверх данных, не суть. Закрывает F6 («заработал» vs «выручка»), цит. cross-cutting lesson 1.
2. **Один экран — один контракт о термине.** «Долг», «выручка», «получено» определяются один раз и используются всюду одинаково. Закрывает F6, F7, terminology table из F1-walkthrough.
3. **Booking — единственный источник истины о деньгах конкретной сделки.** `/finance/*` — это фильтры и агрегации поверх. Никаких финансовых экранов с собственным «состоянием правды» (закрывает A3 + двойственность F1).
4. **Деньги — таймлайн на брони (P4).** На `/bookings/[id]` — `MoneyTimeline` секция: счёт #1 → депозит → счёт #2 → финал. Заменяет плоский payment-list.
5. **Иммутабельные мутации (P12, A2).** Платёж нельзя редактировать; ошибочный платёж — `void` (audit) + новая запись. Возврат денег — `Refund`. Удаление платежа из UI убирается (F9).
6. **Glanceable + drill-down (P3, P7).** Сверху каждого экрана 3–4 KPI с sparklines, под ними — actionable list. Каждая цифра кликабельна и ведёт в отфильтрованный список.
7. **Mobile-first для записи и пометки оплаты.** Кладовщик отмечает наличку с телефона при выдаче. Все ключевые actions (record-payment, mark-paid) usable на 390px.

## Money model — что меняется

### Текущая модель (HEAD)

```
Booking (finalAmount, amountOutstanding, paymentStatus, expectedPaymentDate?)
  ├── BookingItem[]
  ├── Payment[] (amount, method?, receivedAt?, status: PENDING|RECEIVED, createdBy)
  └── (finance events на AuditEntry)

Expense (amount, category, approved, linkedRepairId?, createdBy)
```

Проблемы: депозит и финал неразличимы; `expectedPaymentDate` — одно поле на всю бронь, не на конкретный счёт; нет refund-первого-класса; редактирование платежа возможно через PATCH без контроля.

### Предлагаемая модель

Добавляем три новые модели.

```prisma
model Invoice {
  id            String        @id @default(cuid())
  bookingId     String
  booking       Booking       @relation(...)
  number        String        @unique  // напр. "СЧ-2026-0042"
  kind          InvoiceKind                // DEPOSIT | FINAL | FULL | CORRECTION
  amount        Decimal
  paidAmount    Decimal       @default(0)
  status        InvoiceStatus              // DRAFT | ISSUED | PARTIALLY_PAID | PAID | OVERDUE | VOIDED
  dueDate       DateTime
  issuedAt      DateTime?
  voidedAt      DateTime?
  voidReason    String?
  createdBy     String
  createdAt     DateTime      @default(now())

  payments      Payment[]                  // Payment.invoiceId связь
  refunds       Refund[]
}

enum InvoiceKind { DEPOSIT FINAL FULL CORRECTION }
enum InvoiceStatus { DRAFT ISSUED PARTIALLY_PAID PAID OVERDUE VOIDED }
```

```prisma
model Payment {
  // существующие поля + ...
  invoiceId  String?     // nullable для совместимости со старыми платежами
  invoice    Invoice?    @relation(...)
  voidedAt   DateTime?   // soft-void вместо delete (A2, P12)
  voidedBy   String?
  voidReason String?
}
```

```prisma
model Refund {
  id           String   @id @default(cuid())
  paymentId    String
  payment      Payment  @relation(...)
  invoiceId    String?
  amount       Decimal
  reason       String                       // Zod min(3) trimmed
  refundedAt   DateTime
  refundedBy   String
  method       PaymentMethod                // как вернули
  createdAt    DateTime @default(now())
}
```

### Связь Invoice ↔ Booking ↔ Payment

```
Booking 1───* Invoice 1───* Payment *───1 Refund (опционально)
```

- `Booking.amountOutstanding` = `sum(invoices.amount) − sum(invoices.paidAmount)` (вычисляемое, не хранимое поле в новом коде; миграция оставляет столбец до v2).
- `Invoice.paidAmount` = `sum(payments.amount where !voidedAt) − sum(refunds.amount)`.
- `Invoice.status` пересчитывается сервисом на каждый payment/refund/void (как `recomputeBookingFinance`).
- `Booking.expectedPaymentDate` **deprecated** — заменяется `Invoice.dueDate` (P1, F4).

### Шаблоны выставления (settings)

`SUPER_ADMIN` на `/settings/finance` (новая страница, минимальная) задаёт дефолт:
- «Один счёт на полную сумму» (full upfront / on completion);
- «30% депозит после подтверждения + 70% после возврата» (P1).

При `approveBooking` бэкенд по шаблону создаёт `Invoice[]` со статусом DRAFT и предполагаемыми `dueDate`. SUPER_ADMIN на брони может «Выставить» (DRAFT → ISSUED) — это закрепляет сумму и dueDate (A7: можно `void+reissue`, нельзя silent-edit).

### Какие старые сущности уходят

- `Booking.expectedPaymentDate` — удаляется из UI, в схеме помечается deprecated (миграция: backfill в `Invoice.dueDate` для существующих неоплаченных).
- `Booking.paymentStatus` остаётся как **derived** статус брони (для list-views и `/bookings`-фильтра), вычисляется из совокупности invoices.
- `Payment.status` enum (`PENDING`/`RECEIVED`) — упрощается до факта: платёж в БД = факт получения. Нет «пендинга платежа» — есть «не оплачено по счёту» (это invoice-уровень). Если нужен «обещание заплатить» — это invoice со статусом ISSUED, не Payment.PENDING.
- `quickAddPayment` через `prompt()` — удаляется (F1).
- `/finance/payments` (legacy) и `/finance/payments-overview` — мерджатся в один `/finance/payments` (F11).

## Навигация и информационная архитектура

### Меню — финал

| Пункт меню | URL | SUPER_ADMIN | WAREHOUSE | TECHNICIAN |
|---|---|---|---|---|
| Финансы (раздел) | — | да | да | нет |
| Дашборд | `/finance` | да | нет | — |
| Счета | `/finance/invoices` | да | нет | — |
| Долги | `/finance/debts` | да | нет | — |
| Платежи | `/finance/payments` | да | нет | — |
| Расходы | `/finance/expenses` | да | да (только связанные с ремонтом — но через `/repair`, не в этом меню) | нет |
| Прогноз | `/finance/forecast` | да | нет | — |

**Изменения:** убираем `/finance/payments-overview` как отдельный URL (мерджится в `/finance/payments`). `FinanceTabNav` синхронизируется с этим меню — ровно те же 5 пунктов.

WAREHOUSE финансового меню не получает (как сейчас), но получает **точечный доступ** к одной операции: «Записать оплату» на карточке брони и на сканере (см. ниже). Это закрывает F2 без расширения роли.

### «Записать оплату» — точки входа

Один и тот же диалог `RecordPaymentModal`, три точки входа:

1. **`/bookings/[id]` финансовая секция** — кнопка «Записать оплату» рядом с invoice. Видна SUPER_ADMIN всегда; WAREHOUSE видит только когда `booking.status ∈ {ISSUED, RETURNED}` и `outstanding > 0`. Закрывает F2.
2. **`/warehouse/scan` итог выдачи** — после успешной выдачи показывается сумма и кнопка «Принять оплату при выдаче (₽)». Применяет P10 (multi-method) и закрывает gap из step 4 e2e-сценария F1-walkthrough.
3. **`/finance/invoices` per-row inline action** — иконка «₽» в строке счёта (P9 action-oriented).

Модалка одна и та же. Поля: сумма (preset = invoice outstanding), метод (cash/card/bank/online), дата получения (default today, можно backdate в пределах 30 дней — больше требует SUPER_ADMIN), примечание. Связка с invoice автоматическая (по броне → ISSUED-invoice с outstanding > 0; если несколько — выбор). Закрывает F1.

### «Создать счёт» — где

- **На карточке брони** (`/bookings/[id]`) — кнопка «Выставить счёт» (SUPER_ADMIN). Открывает форму с предзаполненной суммой (по шаблону или остаток).
- **На `/finance/invoices`, вкладка «К выставлению»** — bulk action «Выставить выбранные» (для DRAFT-инвойсов из шаблона) (P9).

## Per-page спецификация

### 1. `/finance` — финансовый дашборд

**Назначение:** «Всё ли ок с деньгами прямо сейчас» за 3 секунды + что делать сегодня.

**Что показывается:**
- Заголовок секции + period-selector **рабочий** (Сегодня / Неделя / Месяц / Квартал / Год / Кастом). Активный таб в URL `?period=`. Закрывает F5.
- **4 KPI-карточки** (P3) с sparkline 30 дней, кликабельные:
  - «Получено» (Σ Payment.amount без voidedAt за period, со sparkline) → drill `/finance/payments?period=…`. Это и есть единая «выручка cash basis». Лейбл — «Получено», не «Заработал», не «Сегодня выручка». Закрывает F6, F7.
  - «Ожидается к получению» (Σ Invoice ISSUED+PARTIALLY_PAID outstanding) → drill `/finance/invoices?status=outstanding`.
  - «Просрочено» (Σ Invoice OVERDUE), цвет `rose` → drill `/finance/debts`.
  - «Расходы» (Σ Expense.amount approved за period) → drill `/finance/expenses?period=…`.
- **Aging-bucket таблица** (P2) — компактная (5 колонок: Текущая / 1–30 / 31–60 / 61–90 / 90+), сверху агрегаты, ниже первые 10 контрагентов с сумками. Клик на ячейку → drill в `/finance/debts` с фильтром по bucket. Закрывает F4 (теперь bucket'ы заполнены — `Invoice.dueDate`).
- **«Сегодня сделать» action list** (P9):
  - N счетов готовы к выставлению (DRAFT) → bulk «Выставить»
  - M счетов просрочены ≥ 7 дней → «Связаться» (на старте — открывает контакт клиента; в Phase 3 — реальная отправка)
  - K платежей не привязаны к счёту → «Привязать» (Phase 2+, reconcile lite)

**Что юзер делает:**
- Меняет period (фильтр).
- Кликает KPI → drill.
- Кликает aging-cell → drill.
- Делает bulk-действие из «Сегодня сделать».

**Edge cases / empty states (F12):**
- Нет долгов → `Долгов нет. Все счета оплачены в срок.` + ссылка на `/finance/invoices`.
- Нет действий → `Сегодня всё под контролем 👌` (без CTA).
- Нет данных за period (например, future) → серый «—», не «0 ₽».

**Friction'ы закрываются:** F4, F5, F6, F7, F8, F11, F12, F18 (sparkline теперь информативен), F14 (один источник aggregate).

**Patterns применяются:** P3, P7, P9, P11 (через KPI «Ожидается»).

---

### 2. `/finance/invoices` — счета

**Назначение:** Список всех счетов с фильтрами и bulk-actions. Один из ключевых рабочих экранов SUPER_ADMIN.

**Что показывается:**
- Tabs: `К выставлению (DRAFT) | Выставлено | Частично | Оплачено | Просрочено | Аннулированные`. Счётчики на табах.
- Поиск по номеру счёта / клиенту / проекту.
- Period-selector (по `dueDate` или `issuedAt`).
- Таблица: `№ счёта · Клиент · Бронь · Тип (Депозит/Финал/Полный) · Сумма · Оплачено · Остаток · Срок · Статус (StatusPill)`.
- Per-row inline actions: иконка «₽» (записать оплату, P9), «✉» (отправить — Phase 3, пока скрыто), «PDF», «⋯» (меню: void, edit due date).

**Что юзер делает:**
- Bulk-выставление (выбор checkbox + «Выставить выбранные»). Применяется к DRAFT.
- Per-row record-payment.
- Drill в `/bookings/[id]` по клику на бронь.
- Экспорт XLSX (рабочий — закрывает родственника F6 на debts).

**Edge cases:**
- Нет счетов в табе → дружелюбный empty с CTA «+ Создать счёт» (только SA).
- DRAFT с прошедшим dueDate → амбер-предупреждение «Просрочка дедлайна выставления».

**Friction'ы:** закрывает F3 (депозит как явный invoice kind), F4 (dueDate явное), F11 (одна страница для всего что связано со счетами/платежами в табах).

**Patterns:** P1, P6, P7, P9.

---

### 3. `/finance/debts` — дебиторка (aging)

**Назначение:** Кому позвонить сегодня. Цветной светофор по просрочке (P2).

**Что показывается:**
- Заголовок «Дебиторка» (терминология РФ; F1-table «Долги/Кто должен/Задолженность» сводится к одному термину **«Дебиторка»**, в KPI на дашборде остаётся «Просрочено» как conversational variant; см. cross-page section).
- **Aging-bucket таблица** (P2) full-screen: контрагенты × bucket-ы, цветной фон ячейки, итог снизу.
- Поиск по контрагенту.
- Toggle «Только просроченные» / «Все с остатком».
- На раскрытии контрагента — список его открытых счетов (number, due, amount outstanding, статус). Каждый — drill в бронь / счёт.

**Что юзер делает:**
- Кликает ячейку bucket → раскрывается список открытых счетов в этом бакете.
- Открывает контакт клиента (если есть в системе) — линк на профиль (Phase 1: открывает контакт-модалку с phone/email; Phase 3: «Отправить напоминание»).
- Экспорт «Дебиторка.xlsx» — реализован, не пустышка (закрывает F6).

**Edge cases:**
- Нет дебиторки → «Долгов нет. Можно выпить кофе ☕».
- Bucket пуст → серая ячейка с «—», не 0.

**Friction'ы:** F4 (теперь bucket'ы наполнены), F6 (XLSX рабочий, кнопка «Связаться» либо реальная либо убрана), F13 (импорт legacy-смет переезжает в `/finance/invoices` → tab «К выставлению» с CTA «Импортировать из старой системы» — где это семантически уместно).

**Patterns:** P2, P7.

---

### 4. `/finance/payments` — журнал платежей (объединяет legacy + overview)

**Назначение:** Что уже пришло, по каким способам, от кого. Сверка кассы.

**Что показывается:**
- Period-selector + per-method chips (P10): «Все · Наличные · Карта · Перевод · Онлайн». Каждый chip с тоталом за period: `Наличные: 340 000 ₽`. Клик фильтрует.
- Таблица: `Дата · Метод · Сумма · Клиент · Счёт № · Кто принял · Действия`.
- Действия в строке: «Оформить возврат» (P12, SA only, открывает RefundModal с reason), «Аннулировать» (void, SA only, требует reason).
- Кнопка «Записать оплату» сверху (та же модалка).

**Что юзер делает:**
- Сверка кассы: фильтр «Наличные» + period «Сегодня» → сумма chip = физическая касса. Применяет P10.
- Refund: per-row, открывает модалку (amount ≤ payment.amount, reason min 3).
- Экспорт XLSX.

**Edge cases:**
- Нет платежей за period → empty с подсказкой про метод/период.
- Платёж voided — отображается серым, со штриховкой, в отдельном tab или фильтре «Включая аннулированные».

**Friction'ы:** F1 (одна модалка), F11 (одна страница), F9 (delete заменён на void+refund с предупреждением через required reason).

**Patterns:** P10, P12, P7.

---

### 5. `/finance/expenses` — расходы

**Назначение:** Учёт исходящих платежей с привязкой к ремонтам и (новое) броням.

**Что показывается:**
- Period + category-filter (рабочие).
- Таблица: `Дата · Категория · Сумма · Описание · Привязка (Ремонт #N → линк / Бронь #N → линк / —) · Документ · Кто создал`.
- Donut-chart (как сейчас) с категорийной разбивкой.
- Inline actions: approve (если pending), edit (только SA, only сумма + описание + категория, не документ), удалить (только SA + только если не approved).

**Что юзер делает:**
- Создаёт расход с привязкой к ремонту/брони (расширение сегодняшнего `linkedRepairId`).
- Прикрепляет документ — пока что URL (как сейчас) + добавляем «загрузить файл (.jpg/.pdf, ≤ 5 МБ)» в Phase 2 (закрывает F16).
- Approve flow остаётся как есть.

**Edge cases:**
- Расход без привязки в категории `REPAIR` → амбер-знак «Не привязан к ремонту».
- Approved + linked to closed repair — read-only, чтобы не ломать историю.

**Friction'ы:** F10 (теперь привязка кликабельна), F16 (file-upload в Phase 2), F17 (категории extension — Phase 3, не критично).

**Patterns:** P8 (margin per booking), P9.

---

### 6. `/finance/forecast` — прогноз поступлений

**Назначение:** «Сколько денег придёт в мае/июне» (P11).

**Что показывается:**
- Stacked bar по неделям/месяцам:
  - Зелёный — уже получено (Payment в этом периоде).
  - Синий — ожидается (Invoice ISSUED+PARTIALLY_PAID с dueDate в периоде).
  - Серый — tentative (Booking PENDING_APPROVAL с прогнозной суммой).
- Цифра «Гарантированный pipeline» = sum confirmed.unpaid invoices.
- Список ожидаемых счетов на ближайшие 4 недели.

**Что юзер делает:**
- Меняет горизонт (4/8/12 недель).
- Кликает на bar → drill в `/finance/invoices?dueDate=…`.

**Edge cases:**
- Меньше 5 будущих счетов → одна строка вместо bar-chart.

**Friction'ы:** F4 (теперь dueDate наполняет данными), implicit gap «forecast не существовал».

**Patterns:** P11, P7.

---

### `/finance/expenses` vs дополнительная страница cash-reconciliation

Версия 0 reconciliation (P5) живёт **на `/finance/payments`** через per-method chips и фильтр period+method+status — отдельную страницу `/finance/reconcile` НЕ вводим в Phase 1–2. В Phase 3 при необходимости — отдельный модуль с импортом банковской выписки.

## Кросс-страничные изменения

### Терминология (canonical glossary)

| Старое (в коде/UI) | Новое (canonical) | Обоснование |
|---|---|---|
| «Выручка» (на /day) | «План выдач сегодня» | На /day мы показываем `Σ finalAmount` сегодняшних выдач — это план, не факт денег. F6, F7. |
| «Сколько заработал» | «Получено» | Cash basis, термин РФ (Тинькофф, МойСклад). F6. |
| «Долги» / «Кто должен» / «Задолженность» | «Дебиторка» (в финансах) / «Просрочено» (в KPI как conversational) | Один термин для одного домена. F (terminology table). |
| «Поступления» / «Платежи» / «Оплаты» | «Платежи» | Один термин. F (terminology). |
| «Принят» / «Зафиксирован» / «Оплачено» / «Оплачен» | «Оплачен» (мужской — согласован с «счёт»; на бронях — «оплачена» женский) | Договариваемся: статус относится к **счёту**, поэтому мужской. F (terminology). |
| «Не оплачен» / «Не оплачено» | «Не оплачен» / «Частично оплачен» / «Просрочен» (по invoice) | P6. |
| «Просрочено» / «Просрочка» | «Просрочен» (status) / «Просрочка» (sub-label) | OK, сводим формы. |
| «Сумма сметы» / «Итог» / «Final amount» / «Билинговано» | «Сумма счёта» (на инвойсе) / «Сумма брони» (на брони) | Разделение слоёв. |
| «Плановая дата платежа» / «expectedPaymentDate» / «срок» | **«Срок оплаты»** (на инвойсе, то есть `Invoice.dueDate`) | Один термин. F4. |
| «Депозит» / «Аванс» / «Залог» | **«Предоплата»** для invoice.kind=DEPOSIT (нейтрально, без коллизии с «банковский депозит»). В UI бренд-копия может говорить «Аванс 30%» — это синонимично. | Agent 2 «Russian-specific» note. F3. |
| «Возвращена» / «CLOSED» (отсутствует) | Сохраняем `RETURNED` как статус брони, **отдельно** от финансового статуса. P6 / A6. | См. lifecycle ниже. |
| «Удалить платёж» | **Аннулировать платёж (void)** + опционально «Оформить возврат». | F9, P12, A2. |

### StatusPill — finance variants

Используем существующие варианты, mapping:

| Сущность | Состояние | StatusPill variant | Лейбл |
|---|---|---|---|
| Invoice | DRAFT | `view` | Черновик |
| Invoice | ISSUED | `info` | Выставлен |
| Invoice | PARTIALLY_PAID | `warn` | Частично оплачен |
| Invoice | PAID | `ok` | Оплачен |
| Invoice | OVERDUE | `alert` | Просрочен |
| Invoice | VOIDED | `none` | Аннулирован |
| Payment | (active) | `ok` | Получен |
| Payment | voided | `none` | Аннулирован |
| Refund | — | `warn` | Возврат |

Booking уже имеет свой StatusPill (DRAFT/PENDING_APPROVAL/CONFIRMED/ISSUED/RETURNED/CANCELLED) — **отделяем визуально** от invoice-pill (A6). На карточке брони рядом — два pill: «Бронь: Возвращена» + «Деньги: Частично оплачен».

### «Записать оплату» — единое поведение

Modal `RecordPaymentModal`:
- Сумма (preset = invoice outstanding или 0 если нет invoice)
- Метод (cash/card/bank/online) — обязательно
- Дата получения (default today)
- Примечание (optional)
- Submit → POST `/api/payments` → success → toast «Оплата записана: X ₽ · метод» + audit `PAYMENT_RECORDED`.

После успешной записи — invoice статус пересчитывается, на брони `MoneyTimeline` обновляется optimistically.

### Тосты и фидбэк

- Запись оплаты → toast.success с суммой и текущим остатком: `«Оплачено 30 000 ₽. Остаток: 70 000 ₽.»`
- Аннулирование → toast.warn `«Платёж аннулирован. Статус счёта пересчитан.»`
- Refund → toast.success `«Возврат оформлен. Чистый приход: X ₽.»`
- Failed (403, 409) → toast.error с осмысленным текстом, не silent fail (закрывает F2).

## Изменения в `/bookings/[id]`

Финансовый блок становится главным экраном денег конкретной сделки.

**Структура (сверху вниз):**

1. **Шапка с двумя StatusPill:** «Бронь: Возвращена» + «Деньги: Частично оплачен · остаток 30 000 ₽».
2. **Сумма-сводка:** `Сумма брони: 100 000 ₽ · Получено: 70 000 ₽ · Остаток: 30 000 ₽` (mono-num, без `style={{}}`, semantic tokens).
3. **Секция «Счета»** (P1):
   - Список Invoice строк: `№ · тип (Предоплата/Финал) · сумма · оплачено · остаток · срок · статус (StatusPill)`
   - Per-row actions: «Записать оплату», «PDF счёт», «Аннулировать» (SA only, требует reason)
   - CTA «+ Выставить счёт» (только SA, видно когда либо нет invoices, либо есть остаток без invoice).
4. **Секция «Хронология денег»** (P4) — collapsible details, default-collapsed:
   - Реверс-хронология events: `📄 Счёт #1 на 30 000 ₽ выставлен (10 апр, Анна)` → `💰 Депозит 30 000 ₽ наличными (12 апр, Анна)` → `📄 Счёт #2 на 70 000 ₽ (25 апр, Анна)` → `💰 Финал 70 000 ₽ переводом (28 апр, Игорь)`.
   - Источник данных — `Invoice[]` + `Payment[]` + `Refund[]` + relevant `AuditEntry` (PAYMENT_VOIDED, INVOICE_VOIDED).
5. **Секция «Связанные расходы»** (P8) — read-only список Expense.linkedBookingId. Маржа = `finalAmount - sum(approved expenses)`. SA видит, WAREHOUSE — нет.

**Поведение для WAREHOUSE:**
- Видит шапку, сумму-сводку, секцию «Счета» (read-only).
- Видит кнопку «Записать оплату» **только когда** `booking.status ∈ {ISSUED, RETURNED}` AND `outstanding > 0` (то есть момент, когда логично принять нал).
- Не видит «Хронология денег» в полном виде (видит только свои PAYMENT_RECORDED события).
- Не видит «Связанные расходы».

**Поведение для TECHNICIAN:**
- Финансовый блок скрыт целиком (как сейчас в меню).

**Связь с `/finance/*` вне брони:**
- Из строки invoice — линк «Открыть на странице счетов» (не нужно, но `/finance/invoices` имеет фильтр `?bookingId=…`).
- Из строки payment — то же.

Закрывает F1, F2, F10, и реализует основной принцип «Booking — единственный источник истины».

## Что НЕ меняется в этом редизайне (out of scope)

1. **Bot endpoints** (`/api/bookings`, `parseGafferReview`) — не трогаются. Бот не работает с финансами и не должен.
2. **Сметы** — `/api/estimates/*` PDF/XLSX export сметы остаётся как есть. Счёт = новый документ, не замена сметы.
3. **Фискальные чеки / 54-ФЗ / онлайн-касса** — отдельный проект (Agent 2, A2 anti-pattern для нашего масштаба).
4. **УПД / счёт-фактура / договор** — Phase 3+. Сейчас только Счёт + Акт.
5. **Bank feed (полноценный reconciliation P5)** — Phase 3+. Phase 1–2 — ручная запись и фильтры на `/finance/payments`.
6. **Multi-currency** — рублёвый rental house, не трогаем (Agent 2 explicit exclusion).
7. **Email/SMS-напоминания должникам** — Phase 3, на старте кнопка «Связаться» открывает контакт.
8. **Telegram-уведомления о платежах** — нет.
9. **ML-forecast** — нет (forecast = детерминированная сумма confirmed unpaid invoices, P11).
10. **Bookings: рефакторинг lifecycle (`CLOSED`-status, automatic close on full payment)** — рассматривается отдельно, в этом редизайне НЕ вводим. Достаточно того, что финансовый pill отделён от bookings.status (A6, F-walkthrough §7).

## План внедрения по фазам

### Phase 1 — Quick wins без schema-изменений (одна неделя)

Цель: устранить broken affordances, дублирование UI, terminology drift. Минимально trogаем модель данных.

- **F1 fix:** удаляем `quickAddPayment` через `prompt()`. Кнопка на брони открывает существующий `QuickPaymentModal`. На `/bookings/[id]` для WAREHOUSE — gating на `status ∈ {ISSUED,RETURNED}` + `outstanding > 0`. F2.
- **F5 fix:** period-selector на `/finance` и `/finance/expenses` — рабочий, через query param.
- **F6 fix:** «Отправить напоминания» — пока скрыта (`Phase 3`). «Экспорт XLSX» на `/finance/debts` — рабочий (server-side render через exceljs, аналогично существующему smetaExport).
- **F7 fix:** terminology pass: «Получено» вместо «Заработал», «Дебиторка» — глобально по 6 файлам web. Глобальный поиск/замена + ручная проверка StatusCell vs StatusPill согласованности.
- **F8 fix:** `DayKpiCard` → `<Link>` wrapper, hover cursor:pointer.
- **F9 fix:** Удаление платежа в UI убирается. Вместо delete — кнопка «Аннулировать» (требует reason). Под капотом — `voidedAt` мягкий void; в Phase 2 миграция убирает hard delete на бэкенде.
- **F10 fix:** В `/finance/expenses` колонка «Привязка» — кликабельный линк на ремонт/бронь. На `/repair/[id]` добавляем секцию «Связанные расходы» (read-only).
- **F11 fix:** `/finance/payments` (legacy) удаляется как отдельный URL, `/finance/payments-overview` переименовывается в `/finance/payments` и подхватывает per-method chips и календарь как опциональный view-toggle. FinanceTabNav синхронизируется.
- **F12 fix:** Empty states — дружелюбные с CTA, как описано в per-page.
- **F13 fix:** «Импортировать смету» переезжает с `/finance/debts` на `/finance/invoices` → tab «К выставлению». Лейбл «Импортировать legacy-брони» (явный).
- **`MoneyTimeline` минимальная** на `/bookings/[id]` (используем уже существующие `Payment[]` + `AuditEntry`, без Invoice пока).

После Phase 1 система работает: терминология единая, UI без broken affordances, WAREHOUSE может писать платёж при выдаче, удаление платежа удалено из UI. Никаких миграций БД.

### Phase 2 — Invoice model + миграция (две-три недели)

Цель: ввести промежуточный слой счетов, разделить депозит и финал, заполнить aging реальными данными.

- **Schema:** новые модели `Invoice`, `Refund`. `Payment.invoiceId` (nullable), `Payment.voidedAt/voidedBy/voidReason`. Audit actions `INVOICE_CREATED/ISSUED/VOIDED`, `PAYMENT_VOIDED`, `PAYMENT_REFUNDED`.
- **Backfill миграция:** для каждой `Booking` с `finalAmount` и `paymentStatus != PAID` создаём один `Invoice { kind: FULL, amount: finalAmount, dueDate: booking.endDate + 7d, status: derived }`. Существующие `Payment[]` линкуются через `invoiceId` по `bookingId`.
- **Settings (`/settings/finance`)** для шаблона выставления (full / 30+70).
- **Сервис:** `recomputeInvoiceStatus`, `recomputeBookingFinanceFromInvoices`, `voidPayment`, `createRefund`. Все в `prisma.$transaction` + audit.
- **`/finance/invoices`** новая страница со всеми табами и actions (P1, P6, P9).
- **Aging on `/finance/debts`** — bucket по `Invoice.dueDate` (P2). Светофор.
- **`MoneyTimeline` v2** на брони — теперь с invoice events.
- **PDF Счёт** — расширение `smetaExport` под новый шаблон «Счёт на оплату» с реквизитами организации.
- **`RecordPaymentModal` v2** — выбор invoice (если несколько), preset suммы, метод обязателен, поле даты.
- **`RefundModal`** — оформление возврата, reason min 3.

После Phase 2 — депозиты и финалы реальны, aging заполнен, refund первый класс.

### Phase 3 — Polish (post-MVP, по требованию)

- **`/finance/forecast`** (P11) — stacked bar и pipeline number.
- **PDF Акт оказанных услуг** — генерация после `RETURNED` + `Invoice.PAID`.
- **Загрузка документа на расход** (F16) — multipart upload в `apps/api/src/routes/expenses.ts`, хранение в `/uploads/expenses/`.
- **Per-method «Закрытие смены»** — snapshot тоталов с записью в audit. Для cash reconciliation.
- **Email/SMS-напоминания должникам** — реальная интеграция, кнопка «Отправить напоминание» становится рабочей.
- **`/finance/reconcile` lite** — импорт CSV из Тинькофф Бизнес → side-by-side match. Только если бухгалтер просит.
- **Категории расходов через DB** (F17) — вместо enum.
- **Margin sparkline** на брони (P8) — мини-чарт прибыльности по аналогичным сделкам.

Каждая фаза autonomously shippable: Phase 1 решает broken UI без миграции; Phase 2 даёт invoice-первый класс с заполненным aging; Phase 3 polishing и интеграции.

## Вопросы и неоднозначности (для Agent 4)

### Q1. Делать ли Invoice обязательным для всех новых броней?

**Решение:** да, всегда хотя бы один Invoice (FULL по умолчанию). Без invoice не может быть payment.

**Pros:** чистая модель, всегда есть `dueDate` для aging, нет «свободных» платежей.
**Cons:** небольшой overhead создания на каждую бронь (но автоматический по шаблону при approve). Existing бронирования — backfill.

Альтернатива: invoice опциональный, payment может быть привязан напрямую к booking. Минус — гибридная модель (что есть сейчас на полпути), невозможно нормально посчитать aging.

### Q2. WAREHOUSE — может ли записывать платёж после `RETURNED`, или только в момент выдачи?

**Решение:** да, до тех пор пока есть `outstanding > 0`. Реальный сценарий: клиент платит финал на возврате или через 2 дня после.

**Pros:** соответствует реальному cashflow rental house. Закрывает 80% случаев F2.
**Cons:** теоретически WH может записать платёж по чужой выдаче. Защита — audit + no edit/delete (только void требует SA).

Альтернатива: WH может только в момент сканирования выдачи. Минус — не покрывает «клиент принёс нал на следующий день».

### Q3. Booking lifecycle: добавлять ли `CLOSED` статус (после full-paid + RETURNED)?

**Решение:** **нет в этом редизайне.** Финансовый статус (Invoice PAID / outstanding=0) отделяется от booking.status (P6/A6). Бронь остаётся `RETURNED` навсегда; «закрытость» — это computed view (RETURNED + outstanding=0).

**Pros:** не плодим статусы, не ломаем существующий approval workflow и тесты.
**Cons:** в UI на /bookings нужен filter «активные деньги» (RETURNED + outstanding>0) — добавляем как фильтр, не как статус.

Альтернатива: ввести `CLOSED`. Минус — каскадные изменения в approval.test, dashboard.test, calendar BLOCKING_STATUSES, и нет очевидной user-value сверх «деньги получены».

### Q4. Удаление vs аннулирование платежа — что показывать в Phase 1, до Invoice modёл?

**Решение:** в Phase 1 кнопка «Удалить» заменяется на «Аннулировать (void)» с обязательным reason. Под капотом в Phase 1 это всё ещё `paymentService.deletePayment`, но UI маскирует delete как void и пишет audit с reason. В Phase 2 — реальный `voidedAt` soft-void.

**Pros:** UX немедленно соответствует canonical модели (P12).
**Cons:** временное несоответствие UI ↔ DB (delete в БД, void в UI) на 2 недели. Audit запись с reason есть.

Альтернатива: оставить «Удалить» до Phase 2. Минус — F9 не закрыт.

### Q5. PDF счёт в Phase 2 — какие реквизиты обязательны?

**Решение:** минимум: ИНН, банк, БИК, р/с, юр.лицо/ИП, адрес. Хранится в `/settings/organization` (новая страница). Без этих полей кнопка «Выставить счёт» disabled.

**Pros:** счёт юридически валиден.
**Cons:** ещё одна страница settings. Но это однократная настройка для founder.

Альтернатива: реквизиты hardcode в env. Минус — дев-only, не product.

### Q6. `expectedPaymentDate` на Booking — удалять или deprecate?

**Решение:** soft-deprecate. В Phase 2 backfill в `Invoice.dueDate`, поле остаётся в схеме до Phase 3 (mark `@deprecated` в комментариях), API перестаёт читать/писать его. Удаление колонки — Phase 3+ если всё чисто.

**Pros:** нет breaking changes для возможных интеграций.
**Cons:** мёртвая колонка в БД на 1–2 спринта.

Альтернатива: удалить сразу. Минус — деструктивная миграция при наличии данных.

### Q7. Тип `Invoice.kind` = `CORRECTION` — нужен ли в Phase 2?

**Решение:** да, на всякий случай. Используется при `void + reissue` (A7) — старый счёт VOIDED, новый счёт CORRECTION с reference на старый. UI создание — Phase 3 (на старте void+create — два действия).

**Pros:** чистый audit при коррекциях суммы.
**Cons:** ещё один enum value, который пока редко используется.

Альтернатива: всегда новый `FINAL`/`FULL`, без специального типа. Минус — потеря семантики «это коррекция, а не новая сделка».

## Заключение

Главный архитектурный сдвиг — **Booking как источник правды о деньгах конкретной сделки, Invoice как промежуточный слой, `/finance/*` как агрегация**. Это решает 16 из 18 friction'ов из Agent 1 (кроме F17 — категории, и F18 — sparkline tooltip — оба cosmetic, Phase 3) и применяет 11 из 12 patterns из Agent 2 (кроме P5 reconciliation full version — Phase 3).

Phase 1 (Quick wins) даёт немедленный UX win без миграций. Phase 2 (Invoice model) даёт architectural win с одной аккуратной миграцией. Phase 3 — polish и нишевые фичи по запросу.

Дизайн полностью укладывается в IBM Plex canon: ноль hex, ноль новых токенов, существующие `StatusPill` variants покрывают все finance-статусы, `mono-num` уже есть, `formatRub` уже есть. Mobile-first для WAREHOUSE-flow «принять нал при выдаче» — сделано через тот же `RecordPaymentModal`, который доступен на `/warehouse/scan` и на брони.

STATUS: DONE
