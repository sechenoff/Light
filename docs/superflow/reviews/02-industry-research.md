# Финансы: industry research (Agent 2)

Независимый отчёт по best-in-class финансовой UX для CRM/rental/equipment-management/accounting систем. Цель — извлечь паттерны, которые стоит перенести в Light Rental System (B2B аренда киносвета, 3–5 пользователей, RUB, русский UI).

## TL;DR — 5 главных принципов из индустрии

1. **Деньги — это таймлайн состояний на сделке, а не отдельный модуль.** Лучшие тулзы (Rentman, Booqable, Current RMS) показывают финансовый статус **внутри карточки заказа**: «выставлено → депозит получен → выдано → закрыто → оплачено полностью». Отдельная страница «Финансы» — это агрегатор и фильтры; жизнь денег происходит на карточке брони.

2. **Invoice moments — гибкие точки выставления, привязанные к этапам жизненного цикла.** Rentman формализует то, что у нас уже происходит вручную: «30% после подтверждения, 70% после возврата». Это именно та модель, которая нужна арендной B2B-индустрии.

3. **Один экран AR (accounts receivable) с aging-buckets закрывает 80% работы с долгами.** QuickBooks, Xero, NetSuite, МойСклад — все используют разбиение «1–30 / 31–60 / 61–90 / 90+» дней с цветным светофором и drill-down в контрагента.

4. **Glanceable-zone сверху, drill-down снизу.** Stripe, Linear и QuickBooks ставят 3–5 KPI в верхнюю «зону взгляда» (revenue / pending / outstanding / overdue), под ними — **списки операций с inline-actions**, не отдельные страницы.

5. **Каждое денежное событие — иммутабельная запись с действующим лицом.** Stripe и Xero никогда не редактируют платёж — они делают refund/correction-запись. Это даёт audit trail и предсказуемость reconciliation; в SME это часто игнорируют, а потом разбираются «кто и когда поменял сумму».

---

## Money primitives — общая модель

Лучшие тулзы делают эту модель прозрачной через **разделение «обещание заплатить» и «факт денег»**. Документ — это обещание; платёж — факт; reconcile — связь между ними.

### Estimate / Quote (КП, смета)
- **Что это**: расчёт до согласования. Можно править свободно. Не двигает деньги.
- **Booqable / Rentman**: при изменении состава заказа quote пересчитывается автоматически и показывает «было → стало».
- **QuickBooks**: estimate можно «convert to invoice» одной кнопкой — переход из «обещали посчитать» в «требуем оплату».

### Invoice (счёт)
- **Что это**: фиксированное обязательство клиента заплатить сумму X к дате Y. **Иммутабельный** после отправки.
- **Rentman**: «invoice moments» — разные счета на одну бронь (депозит / финал). Каждый — отдельный документ со своим статусом.
- **Xero / QuickBooks**: статусы Sent / Viewed / Partially paid / Paid / Overdue — и каждый виден на dashboard.

### Payment (приход)
- **Что это**: факт получения денег. Привязан к invoice, но физически отдельная сущность.
- **Stripe / Xero**: payment всегда имеет `method` (cash/card/bank), `receivedAt`, `amount`. Никогда не редактируется — только refund/void.

### Receipt / Acknowledgement (квитанция, чек)
- **Что это**: документ для клиента, подтверждающий, что деньги получены. PDF/email.
- **QuickBooks**: автоматически генерится при пометке invoice paid.

### Expense / Cost (расход)
- **Что это**: исходящий платёж. Может быть привязан к проекту (как у нас — `linkedRepairId`) или к категории.
- **Wave / QuickBooks**: расходы сразу с приложенным фото чека — paper trail встроен в UX.

### Refund (возврат)
- **Что это**: отрицательный платёж. Никогда не «удаление» исходного платежа.
- **Stripe**: refund — это новая запись с reference на оригинальный payment. На карточке клиента видно «paid 50 000 → refunded 10 000 → net 40 000».

### Reconciliation (сверка)
- **Что это**: процесс сопоставления выписки банка с invoice/payment в системе.
- **Xero**: bank feed → side-by-side список банковской строки и подходящего invoice → кнопка «match». Если суммы не совпадают — split & match. Это **отдельный экран reconcile**, а не закопано в платежи.

**Урок для нас:** вместо плоского `Payment[]` стоит зафиксировать пять примитивов: `Invoice`, `Payment`, `Refund`, `Expense`, `Reconciliation`. Сейчас у нас Booking хранит финальную сумму как поле, и платежи — отдельным списком; модель Invoice как промежуточного слоя между Booking и Payment пока отсутствует.

---

## 12 паттернов worth borrowing

### Pattern 1: Invoice moments — split-выставление по этапам брони
**Origin:** Rentman ([invoice moments docs](https://support.rentman.io/hc/en-us/articles/360017647300-What-are-invoice-moments)), Booqable.
**What it solves:** В нашей индустрии депозит до съёмки + финал после возврата — норма. Сейчас мы храним один `finalAmount`, что усложняет reconciliation (заказчик заплатил 30% месяц назад — где это видно, кроме списка `Payment`?).
**Mechanics:** На уровне настроек шаблоны: «After agreement: 30%» / «Afterward: 70%». Когда бронь подтверждается — генерится invoice #1 на 30%. Когда бронь закрыта — invoice #2 на 70%. Каждый имеет свой `dueDate`, `status`, `paidAmount`. Список «к выставлению» (`To be invoiced`) — отдельный экран.
**Why it works:** Чёткая модель «обещание → факт» вместо размазывания депозита по полям брони. Aging report считается тривиально (по invoice.dueDate, не по booking.endDate).
**Apply to Light Rental:** Добавить модель `Invoice { bookingId, kind: DEPOSIT|FINAL|FULL, amount, dueDate, status }`. На карточке брони — секция «Счета» с двумя строками; на главной финансовой странице — фильтр «К выставлению / Просрочено / Оплачено». Шаблоны процентов в settings (`SUPER_ADMIN`).
**Caveats:** Не делать обязательным. Многие бронирования small-ticket — один invoice на полную сумму. Шаблон — opt-in per client или per booking.

### Pattern 2: AR aging buckets с цветным светофором
**Origin:** QuickBooks, Xero, NetSuite ([AR dashboard guide](https://www.netsuite.com/portal/resource/articles/accounting/accounts-receivable-ar-dashboard.shtml)), МойСклад «Дебиторка».
**What it solves:** «Сколько нам должны и насколько просрочено» — главный вопрос руководителя SME. Без bucket'ов — это длинный список бронирований без приоритизации.
**Mechanics:** Таблица контрагентов с 5 колонками: `Текущее (не просрочено) | 1–30 дней | 31–60 | 61–90 | 90+`. Каждая ячейка — сумма; цвет фона: серый → жёлтый → оранжевый → красный. Внизу — итог по столбцам. Клик по ячейке — drill-down в список конкретных invoice от этого клиента в этом bucket.
**Why it works:** Один экран отвечает на «кому позвонить сегодня» и «насколько плохо». Aging — это де-факто стандарт бухгалтерии любой страны.
**Apply to Light Rental:** На странице `/finance` (или `/finance/debts`) сверху — таблица aging. У нас уже есть `computeDebts()` — нужно добавить bucket-разбиение по `dueDate` (если invoice появится — по нему; пока — по `booking.endDate + grace_period`). Русские лейблы: «Текущая / Просрочено до 30 дней / 30–60 / 60–90 / Безнадёжная (90+)».
**Caveats:** Bucket-границы должны быть настраиваемыми (settings). У некоторых клиентов 60-дневный net — норма.

### Pattern 3: KPI cards в glanceable-zone + sparklines
**Origin:** Stripe Dashboard ([illustration.app/blog](https://www.illustration.app/blog/stripe-payment-ux-gold-standard)), Linear Insights, QuickBooks home.
**What it solves:** Руководитель за 3 секунды видит «всё ли ок». Без этого — каждый раз приходится открывать отдельные страницы.
**Mechanics:** Сверху страницы 4 карточки: **Выручка месяца** (с Δ% к прошлому), **Ожидается к получению** (PENDING invoices), **Просрочено** (overdue, красный), **Расходы месяца**. Под каждой цифрой — sparkline за 30 дней (тонкая линия, без осей).
**Why it works:** Sparkline передаёт тренд без cognitive load: «выручка растёт» / «долги растут» видно мгновенно. Stripe измерил +11.9% revenue после внедрения такого Payment Element.
**Apply to Light Rental:** На `/finance` сверху — 4 KPI карточки в существующем стиле `DayKpiCard`. Sparkline — лёгкий SVG-компонент (≤100 LOC, без библиотеки) с агрегацией по дням за 30/90 дней. Цвета — semantic tokens: `accent` для нейтральных, `rose` для overdue, `emerald` для расходов под бюджетом.
**Caveats:** Не больше 4 карточек. Stripe ограничивается 3–5 — это не случайность, это cognitive limit.

### Pattern 4: Booking finance timeline — состояние денег как timeline на карточке
**Origin:** Stripe payment object timeline, Pipedrive deal activity.
**What it solves:** На карточке брони сейчас сложно понять «как двигались деньги». Список Payment'ов плоский, без контекста relative к статусу брони.
**Mechanics:** На `/bookings/[id]` секция «Хронология денег» (collapsible): вертикальный таймлайн с иконками: 📄 счёт #1 выставлен на 30 000 ₽ (10 апр) → 💰 депозит получен 30 000 ₽ наличными (12 апр) → 📄 счёт #2 выставлен на 70 000 ₽ (25 апр) → 💰 финальный платёж 70 000 ₽ переводом (28 апр). Каждое событие — кто сделал, когда, сколько.
**Why it works:** Заменяет вопросы клиенту «вы оплатили?» на «вижу, депозит получили 12 апреля Иваном». Audit trail для SUPER_ADMIN. Согласуется с уже существующим `ApprovalTimeline` паттерном.
**Apply to Light Rental:** Использовать существующий `AuditEntry`-stream + `Payment[]` + (будущий) `Invoice[]`. Default-collapsed `<details>` блок. Для WAREHOUSE — read-only; для SUPER_ADMIN — клик → drill-down. Реверс-хронология (новые сверху).
**Caveats:** Не тащить в timeline всю историю изменений брони — только money events. Иначе шум.

### Pattern 5: Reconciliation как отдельный экран с side-by-side match
**Origin:** Xero bank reconciliation ([central.xero.com](https://central.xero.com/s/article/Record-a-part-payment-during-reconciliation)).
**What it solves:** «Пришла выписка из банка — как привязать переводы к бронированиям?» Сейчас это ручное «открыть бронь → добавить платёж → проверить сумму».
**Mechanics:** Экран `/finance/reconcile`: слева список банковских строк (импорт из CSV/выписки или ручной ввод), справа предлагаемые матчи (по сумме, по контрагенту, по дате). Кнопка «Match». Split & match — если один платёж покрывает несколько invoice. Зелёная подсветка авто-матча.
**Why it works:** Снимает 80% ручной работы. Xero — gold standard в этом.
**Apply to Light Rental:** Версия 0 — простая: ручная форма «получили перевод X ₽ от Y клиента» с авто-предложением списка его открытых invoice. Версия 1 — импорт CSV из Тинькофф Бизнес (Тинькофф даёт OFX/CSV экспорт). Не делать сразу полный bank feed — слишком много работы для 50–200 броней/мес.
**Caveats:** Не нужно заменять бухгалтерию (1С/Контур). Это операционный reconcile «получили ли деньги», не налоговый учёт.

### Pattern 6: Single source of truth для статуса оплаты — четыре состояния
**Origin:** Booqable ([payment statuses](https://booqable.com/payments/)), Stripe.
**What it solves:** Запутанные пересечения «частично оплачено», «оплачено, но депозит не возвращён», «возврат частичный».
**Mechanics:** Booqable использует чистые 4 статуса invoice: `Payment due` (ничего не пришло) / `Partially paid` (часть) / `Paid` (всё) / `Deposit` (нужно вернуть/удержать). Цветной pill — единственный визуальный индикатор. Никаких пересекающихся флагов.
**Why it works:** Дисциплинирует data model. Если оплачено частично — нет соблазна писать `paid: true` где-то.
**Apply to Light Rental:** Завести `Invoice.status: enum { DRAFT, ISSUED, PARTIALLY_PAID, PAID, OVERDUE, VOIDED }`. На уровне UI — `StatusPill` с variant per status. Использовать существующий design canon (variants `view/info/ok/warn/alert`).
**Caveats:** Нужно решить, что значит OVERDUE для частичных платежей — скорее всего «есть остаток + dueDate < today».

### Pattern 7: Drill-down от агрегата к транзакции одним кликом
**Origin:** Stripe (revenue → payments list → payment detail), QuickBooks (P&L → category → transaction).
**What it solves:** «Выручка за апрель — 1.2M ₽» вызывает вопрос «откуда?». Без drill-down ответ требует SQL или Excel.
**Mechanics:** Любая агрегатная цифра — кликабельная. Клик ведёт на отфильтрованный список с тем же фильтром (period, client, category). На каждой строке — клик на бронь.
**Why it works:** Сохраняет контекст. Не нужно вручную копировать «период = апрель, клиент = Иванов» из одного экрана в другой.
**Apply to Light Rental:** Каждый KPI и каждая ячейка aging-таблицы — `<Link>` с query params. На `/bookings` уже есть фильтр по статусу — добавить фильтры по `dueDate`, `client`, `paymentStatus`.
**Caveats:** Не плодить пять разных «отфильтрованных» страниц — один список с гибкими фильтрами.

### Pattern 8: Per-booking unit economics (margin)
**Origin:** Pipedrive deal value ([forecast view](https://support.pipedrive.com/en/article/the-forecast-view-revenue-projection)), Rentman cost-margin tracking.
**What it solves:** «Эта бронь была прибыльной?» — сейчас нет ответа. Бронь приносит revenue, но связанные расходы (ремонт повреждённой техники после возврата, такси курьеру) разбросаны.
**Mechanics:** На карточке брони — блок «Экономика»: Доход X ₽ / Прямые расходы Y ₽ (linkedExpenses) / Маржа Z ₽ (Δ%). На странице finance — топ-10 убыточных и топ-10 прибыльных броней за период.
**Why it works:** Pipedrive показывает: видение per-deal маржи меняет поведение продажников. Для арендной — то же: помогает решить «брать ли клиента на условиях X».
**Apply to Light Rental:** У нас уже есть `Expense.linkedRepairId`. Добавить `Expense.linkedBookingId` (опционально). На странице брони — секция «Связанные расходы» с возможностью прикрепить (репаро после возврата, такси). Маржа = `finalAmount - sum(linkedExpenses.where(approved))`.
**Caveats:** Не считать косвенные расходы (зарплата, аренда офиса) на бронь. Это direct margin, не net.

### Pattern 9: Action-oriented dashboard — «что делать сегодня»
**Origin:** Wave ([accounting dashboard](https://www.waveapps.com/)), Pipedrive activity dashboard.
**What it solves:** Финансовый dashboard часто = много цифр и ноль действий. Wave встроила **task list of outstanding items** прямо в home — это меняет фрейминг с «отчёт» на «инструмент».
**Mechanics:** На `/finance` секция «Сегодня сделать»:
- 3 счёта просрочены — позвонить клиентам (список с кнопкой «отправить напоминание»)
- 5 счетов готовы к выставлению (список + bulk-action «выставить все»)
- 2 платежа не reconcil'ены (список + «привязать»)
**Why it works:** Финансовый отдел SME живёт от чек-листа, а не от P&L. Wave-подход — самый человечный.
**Apply to Light Rental:** У нас уже есть `DayAlert` и `DayTasksWidget` — расширить на `/finance` page. Action items — list with inline buttons (как в текущем `DayOperationsList`). Не плодить отдельные модальные окна — inline confirm.
**Caveats:** Не дублировать с `/day` (там уже есть pending-approvals alert). На `/finance` — финансовые actions: выставить, напомнить, reconcile.

### Pattern 10: Multi-method payments с per-method тоталами
**Origin:** Тинькофф Бизнес (operations grouped by method), QuickBooks payment method breakdown.
**What it solves:** В нашей индустрии cash + card + bank transfer = норма. Без разбивки невозможно сверять кассу в конце дня.
**Mechanics:** На странице `/finance/payments` — таблица с колонкой `method`. Сверху — chips с per-method тоталами за выбранный период: «Наличные: 340 000 ₽ · Карта: 120 000 ₽ · Перевод: 880 000 ₽». Клик на chip — фильтрует список.
**Why it works:** Нал в конце дня всегда нужно сверять с физической кассой. Это не nice-to-have.
**Apply to Light Rental:** У нас уже есть `Payment.method` (Sprint 1). Добавить группировку chips на странице `/finance` или `/finance/cash` (отдельная sub-страница для cash reconciliation). Можно добавить «закрытие смены» — snapshot тоталов на момент клика, пишется в audit.
**Caveats:** Не превращать в полноценную POS-кассу с фискальным регистратором. Это про сверку, не про эмиссию чеков.

### Pattern 11: Forecast view — сколько денег ожидается
**Origin:** Pipedrive forecast view ([forecast docs](https://support.pipedrive.com/en/article/the-forecast-view-revenue-projection)), Stripe MRR forecast.
**What it solves:** «Сколько денег придёт в мае?» — сейчас никак не отвечается. Подтверждённые брони на будущее — это by definition forecast.
**Mechanics:** Простой stacked bar по неделям/месяцам: уже получено (зелёный) + ожидается из подтверждённых броней (синий) + tentative из DRAFT/PENDING (серый, опционально). Отдельная цифра «Гарантированный pipeline = sum(confirmed.future.unpaid)».
**Why it works:** Дает руководителю видение «есть ли cash для крупной закупки в июне». В нашем случае — для покупки нового света / погашения кредита.
**Apply to Light Rental:** Простая версия — список confirmed bookings с `endDate` в будущем, сгруппированных по неделям. Может быть extension существующего `/calendar` или отдельный блок на `/finance`. Не нужно ML — наша воронка детерминирована (бронь подтверждена → деньги придут).
**Caveats:** Forecast = expected, не committed. UI должен давать понять.

### Pattern 12: Rejection-friendly документы и refund-as-record
**Origin:** Stripe refund object, Booqable refund flow ([Booqable refunds blog](https://booqable.com/blog/refunds-and-revisions/)).
**What it solves:** Когда клиент отменяет бронь после депозита — что с деньгами? Сейчас в системе нет первого-класса refund. Это решается «удалением платежа», что ломает audit.
**Mechanics:** Refund — отдельная запись `Refund { paymentId, amount, reason, refundedAt, refundedBy }`. На карточке брони видно: «Получено 30 000 → Возвращено 25 000 (5 000 удержание комиссии) → Чистый приход 5 000».
**Why it works:** Clean audit, никаких «исчезнувших» платежей. Stripe — золотой стандарт в этом подходе.
**Apply to Light Rental:** Добавить модель `Refund` со связью на `Payment`. Отдельная кнопка «Оформить возврат» на платеже (только SUPER_ADMIN). Reason обязателен (Zod min 3, как у `rejectBooking`). Audit запись `PAYMENT_REFUNDED` с before/after.
**Caveats:** Не трогать бухгалтерский cash flow Тинькофф/банка — это операционная запись «вернули клиенту X ₽», физический возврат делается отдельно.

---

## Russian-specific notes

### Терминология (что устоялось)

| Английский термин | Принятый в РФ финансовый UI |
|---|---|
| Account receivable | **Дебиторка** / **дебиторская задолженность** (МойСклад, 1С) |
| Account payable | **Кредиторка** / **кредиторская задолженность** |
| Counterparty / Customer | **Контрагент** (B2B), **клиент** (B2C) |
| Income / Revenue | **Приход**, **выручка**, **поступление** |
| Expense | **Расход**, **списание** |
| Invoice | **Счёт** (на оплату). Не «инвойс». |
| Payment | **Платёж**, **оплата**, **поступление** |
| Receipt | **Квитанция**, **чек** (если фискальный) |
| Refund | **Возврат** (денег) |
| Reconciliation | **Сверка** (с банком, с контрагентом) |
| Aging | **Старение задолженности** или просто «просрочка» |
| Outstanding | **Остаток к оплате**, **долг** |
| Deposit | **Залог**, **аванс**, **предоплата** (важно: «депозит» в РФ часто = банковский вклад, лучше использовать «залог» или «предоплата») |
| Final payment | **Окончательный расчёт**, **финальный платёж** |
| Discount | **Скидка** |
| Surcharge | **Надбавка**, **наценка** |

**Cross-check с документацией МойСклад / Тинькофф:** все эти термины используются. Не использовать кальки «инвойс», «эстимейт», «реконсил».

### Формат денег

- Символ ₽ **после** числа: `1 234 567 ₽`. Пробел перед ₽.
- Разделитель тысяч — **тонкий пробел** (NBSP, U+00A0) или просто пробел: `1 234 567`. Не запятая (US), не точка (EU).
- Дробная часть — запятая: `1 234,50 ₽`. В нашей индустрии копейки часто опускают — `1 235 ₽` тоже норма (но в счёте лучше с копейками).
- Минусы для расходов: `−12 000 ₽` (с настоящим минусом U+2212, не дефисом).
- Скобки для отрицательных в таблицах (бухгалтерский стиль): `(12 000) ₽` — допустимо, но менее популярно в SME софте.

В коде у нас уже есть `formatRub`, `formatMoneyRub` в `apps/web/src/lib/format.ts` — нужно проверить, что они выводят NBSP-разделитель и `₽` postfix.

### Документооборот в РФ

| Документ | Когда | Юр. сила | UX |
|---|---|---|---|
| **Счёт на оплату** | До оплаты, после согласования | Не основание для НДС, но используется как «обещание» | Самый частый документ. PDF с реквизитами. |
| **Договор** | Один раз с клиентом | Основной документ B2B | Может быть рамочный + спецификация на каждую бронь |
| **Акт оказанных услуг** | После завершения брони | Основание для признания выручки | Обязателен для B2B. Подписывается обеими сторонами. |
| **Кассовый чек** | При наличной оплате | Фискальный документ | По 54-ФЗ нужен онлайн-кассовый аппарат. У нас сейчас не реализовано — это отдельный проект. |
| **УПД** (универсальный передаточный документ) | Альтернатива акт+счёт-фактура | Заменяет два документа | Удобно, но настройка сложная — оставить на потом. |
| **Квитанция** | Подтверждение получения наличных | Внутренний документ | Можно генерить из системы PDF. |

**Применимо к нам:** в первую очередь — **Счёт на оплату** + **Акт**. У нас уже есть PDF-export сметы (`smetaExport/renderPdf.ts`) — расширить до этих двух документов. УПД и фискальный чек — отдельный спринт когда придёт необходимость.

**Прагматичный подход:** для аренды на ИП на УСН (что часто у небольших rental house) фискальный чек обязателен только при наличных от физлиц. B2B-переводы между юрлицами фискала не требуют. Это снимает 80% боли.

---

## Anti-patterns — что встречается, но НЕ работает в SME

### A1. «Полная бухгалтерия в одном тулзе»
1С / NetSuite / SAP пытаются дать налоговый учёт + операционный + управленческий. В SME это превращается в монстра, в котором 90% полей не нужны. **Урок:** наша задача — операционный финансовый учёт. Налоговый учёт — это 1С-Бухгалтерия / Эльба / Контур, мы туда не лезем.

### A2. «Mutable payments» (платёж как редактируемая запись)
Вижу это в Битрикс24 и в части малых CRM. Платёж можно отредактировать «вчера ввели 30k, на самом деле было 25k — поправили». Это убивает audit и делает reconciliation невозможным. **Урок:** Payment — иммутабельный, изменения через void+create или refund.

### A3. Несколько источников истины («сумма брони» vs «сумма счёта» vs «сумма по платежам»)
EZRentOut и часть rental-софта позволяют изменить сумму брони после оплаты — в результате `booking.total != sum(payments)`. Что является правдой? **Урок:** invoice фиксирует сумму. Изменение брони после issue invoice — это credit note + new invoice, не silent edit.

### A4. Перегруженный финансовый dashboard (20+ виджетов)
Битрикс24, NetSuite — соблазн показать всё сразу. Linear / Stripe явно ограничивают: максимум 4–6 виджетов в glanceable-zone. **Урок:** на `/finance` — 4 KPI cards + 1 main table + 1 sidebar. Всё остальное — drill-down.

### A5. «Магические» автоматические правила без транспарентности
Wave и Booqable иногда автоматически меняют статусы (e.g., «invoice paid → booking confirmed»). Если правило неявное — пользователь не понимает, кто это сделал. **Урок:** автоматизация = да, но в audit с пометкой `system` как actor.

### A6. Одноимённые статусы для разных сущностей
QuickBooks путает «invoice paid» и «booking complete» — у обоих может быть статус «closed». **Урок:** не reuse `Booking.status` для финансового состояния. Финансовый pill — отдельный визуально (e.g., "Оплачено / Частично / Просрочено") поверх или рядом со статусом брони.

### A7. Блокировка редактирования слишком рано
Если invoice issued — нельзя править ничего. Это бесит operations: иногда позиция сложилась обратно, и нужно скорректировать. **Урок:** разрешать `void + reissue` (как Stripe) — отменить старый invoice (audit-trail), выпустить новый. Не silent edit.

---

## Cross-cutting lessons — что общего у всех хороших financial UI

### Что отличает great от good

1. **Money first, document second.** Хороший UX показывает «сколько денег, где, чьих». Документы (PDF, акты) — это output, не суть. Plохой UX — наоборот: тебя сразу заваливают шаблонами документов.

2. **Default to action.** На каждом экране — что-то можно сделать прямо здесь. Stripe: refund прямо из списка платежей. Xero: reconcile прямо из bank feed. Плохой UX: «откройте отчёт и подумайте».

3. **Latency matters.** Stripe/Linear: обновление мгновенное (optimistic UI). У нас уже есть этот паттерн в Tasks — расширить на финансы.

4. **Audit-by-default, не add-on.** Каждое действие — иммутабельная запись. У нас уже есть `AuditEntry` — нужно покрыть ВСЕ финансовые мутации.

5. **Money colors are reserved.** Красный = просрочка / расход. Зелёный = приход / оплачено. Жёлтый = pending. Никогда не использовать эти цвета для других сущностей. Stripe и QuickBooks особенно строги — у них даже бренд не использует красный.

6. **Numerals are a typeface concern.** `mono-num` (tabular-nums) — везде, где числа в таблицах. У нас в design canon уже есть `.mono-num` утилита.

7. **Dates are localized, never assumed.** Stripe и Tinkoff: Today / Yesterday / 12 апр / 12 апр 2024. Не показывать год для текущего, всегда показывать для прошлых.

### Что общего у Stripe / Linear / Xero / Wave / Pipedrive / МойСклад

- Glanceable-zone сверху (3–5 KPI)
- Действие-ориентированный список под KPI
- Drill-down по каждой цифре
- Sparklines для тренда
- Цветной светофор для срочности
- Audit-первый подход
- Чистая модель документов (Invoice ≠ Payment ≠ Refund)
- Поиск по контрагенту как primary navigation
- Экспорт в Excel/CSV — кнопка в углу каждого списка

---

## Specific recommendations для cinematography rental house

### Размер и контекст
- 50–200 броней/мес = ~5–10 в день средний.
- 3–5 пользователей = SUPER_ADMIN (1, founder), WAREHOUSE (1–2), TECHNICIAN (1).
- ~3–5k contacts в DB = большая часть holdбэк, активных клиентов 50–150.
- Cycle 1–30 дней = редко краткие, часто 3–7 дней.

### Минимально жизнеспособная финансовая UI

1. **`/finance` (главная)** — для SUPER_ADMIN:
   - 4 KPI cards: Выручка месяца / Ожидается / Просрочено / Расходы месяца. Sparklines.
   - Aging bucket таблица по контрагентам.
   - «Сегодня сделать» action list (Pattern 9).
   - Фильтр period (Сегодня / Неделя / Месяц / Квартал / Кастом).

2. **`/finance/invoices`** — список счетов (Pattern 1).
   - Tabs: К выставлению / Выставлено / Частично / Оплачено / Просрочено.
   - Bulk actions: выставить, отправить напоминание, экспорт.
   - Per-row inline action: «Записать платёж».

3. **`/finance/payments`** — список платежей (Pattern 10).
   - Per-method chips (наличные / карта / перевод).
   - Фильтр date / method / client.
   - Inline refund (Pattern 12, SUPER_ADMIN only).

4. **`/finance/expenses`** — список расходов.
   - Уже частично есть (`Expense.linkedRepairId`).
   - Расширить — `linkedBookingId`, категории.
   - Approval workflow можем оставить как сейчас.

5. **`/finance/debts`** — уже есть. Расширить до Aging buckets (Pattern 2).

6. **`/finance/forecast`** — Pattern 11. Может быть просто widget на `/finance`, не отдельная страница, если форма простая.

### Что НЕ делать в первой итерации

- Полноценный bank reconciliation (Pattern 5, версия 1). Версия 0 — ручной ввод.
- Фискальные чеки (отдельный проект под 54-ФЗ).
- Multi-currency.
- Автоматические напоминания клиентам по email/SMS.
- УПД, дополнительные документы кроме счёта/акта.
- ML-forecast.

### Роли и финансы

- **SUPER_ADMIN**: всё. Read+write. Refund, void, edit invoice.
- **WAREHOUSE**: read invoices/payments по своим бронированиям. Записать платёж (`POST /payment`) — да, чтобы при выдаче можно было быстро отметить нал. **Не** видит aggregate dashboard, **не** видит расходы. **Не** делает refund.
- **TECHNICIAN**: видит только связанные с ремонтом расходы (свои `linkedRepairId`). Никакого dashboard, никаких чужих данных.

Это совпадает с существующей матрицей `/api/finance/*` = SUPER_ADMIN only, но WAREHOUSE нужно дать **минимальное** окошко в финансы — только «отметить, что за бронь X получили Y ₽ наличными при выдаче».

### Дизайн-каноны (соответствие IBM Plex)

- Все KPI cards — токены `surface / border / accent / rose / amber / emerald`. Никакого hex.
- Sparklines — `accent` или `rose` (для просрочки), strokeWidth=1.5.
- Status pills — существующие variants `ok/warn/info/alert/none`. Для invoice добавить mapping: ISSUED→info, PARTIALLY_PAID→warn, PAID→ok, OVERDUE→alert, VOIDED→none.
- Numbers — `.mono-num` везде в таблицах.
- Иконки — те же что в `DayKpiCard` (eyebrow + value + sub).

---

## Заключение

Best-in-class финансовая UX в SME строится на **5 принципах**:
1. Деньги — это таймлайн, а не отдельный модуль (`/bookings/[id]` показывает финансовую историю).
2. Invoice как промежуточный слой между Booking и Payment даёт чистую семантику и поддерживает сценарий «depposit + final».
3. Aging buckets — must-have для управления долгами.
4. KPI + sparklines в glanceable-zone закрывают «всё ли ок».
5. Все мутации иммутабельны, refund — отдельная запись.

Для Light Rental эта модель ложится естественно на существующие сущности (Booking, Payment, Expense, AuditEntry). Главное недостающее звено — **модель Invoice** как промежуточный слой. Без него split-payments, aging и forecast делаются костылями.

Терминология русская, культура B2B-аренды киноотрасли — депозит + финал, B2B-переводы преобладают, кассовые чеки только для редких физлиц. Дизайн полностью укладывается в существующий IBM Plex canon без новых токенов.

Главные отличия от текущего состояния (judging by CLAUDE.md):
- Нет модели Invoice — все деньги через `Payment` flat list.
- Нет Aging UI (только `computeDebts()`, без bucket-разбиения).
- Нет финансового KPI dashboard (есть `DayKpiCard` в `/day`, но не специализирован).
- Нет Refund первого класса.
- Нет Forecast view.

Все эти gaps закрываются 5–8 спринтами в духе уже сделанных (Tasks, Approval workflow). Архитектура и design canon — готовы.

### Источники

**Rental-specific:**
- [Rentman — Set Up Your Invoicing Process](https://support.rentman.io/hc/en-us/articles/360013628279-Set-Up-your-Invoicing-Process-and-Get-Paid)
- [Rentman — What are invoice moments](https://support.rentman.io/hc/en-us/articles/360017647300-What-are-invoice-moments)
- [Rentman — Marking an Invoice as Paid](https://support.rentman.io/hc/en-us/articles/18560784878610-Marking-an-Invoice-as-Paid)
- [Booqable — Payments](https://booqable.com/payments/)
- [Booqable — Refunds and Revisions](https://booqable.com/blog/refunds-and-revisions/)
- [Booqable — Documents](https://booqable.com/documents/)
- [Current RMS — Record Payments and Refunds](https://www.current-rms.com/latest-features/record-payments-and-refunds)
- [Current RMS — Take payments](https://help.current-rms.com/en/articles/457962-take-payments-or-mark-an-invoice-as-paid)
- [EZRentOut — Security Deposits](https://blog.ezrentout.com/default-line-items-security-deposits/)
- [EZRentOut — Features](https://ezo.io/ezrentout/features/)

**Accounting:**
- [QuickBooks — Money Management](https://quickbooks.intuit.com/payments/overview/)
- [Intuit — QuickBooks Online Student Guide Ch.2](https://www.intuit.com/oidam/intuit/ic/en_ca/content/Intuit-education-program-ca-qbo-ch2-getting-around-quickbooks-online.pdf)
- [Xero — Reconcile a part payment](https://central.xero.com/s/article/Record-a-part-payment-during-reconciliation)
- [Wave — Small Business Software](https://www.waveapps.com/)
- [Wave — Invoicing](https://www.waveapps.com/invoicing)

**Modern SaaS dashboards:**
- [Stripe Payment UX: Why It's the Gold Standard](https://www.illustration.app/blog/stripe-payment-ux-gold-standard)
- [Stripe Web Dashboard Docs](https://docs.stripe.com/dashboard/basics)
- [Pipedrive — Forecast view](https://support.pipedrive.com/en/article/the-forecast-view-revenue-projection)
- [Pipedrive — Insights revenue forecast](https://support.pipedrive.com/en/article/insights-reports-revenue-forecast)
- [Linear — Dashboards](https://linear.app/docs/dashboards)
- [Linear — Best practices for dashboards](https://linear.app/now/dashboards-best-practices)

**Russian-language:**
- [МойСклад — Движение денежных средств](https://support.moysklad.ru/hc/ru/articles/360000199328)
- [МойСклад — Дебиторка](https://am4u.ru/debitorka)
- [МойСклад — Взаиморасчёты с контрагентами](https://www.moysklad.ru/news/125-2008-09-01-11-36-09/)
- [Тинькофф Бизнес — Выставить счет контрагенту](https://www.tbank.ru/business/help/account/currency-ruble/counterparties/invoice/)
- [Тинькофф Бизнес — Оплата счетов контрагентам](https://www.tbank.ru/business/help/account/currency-ruble/counterparties/pay/)
- [UX-патруль: Тинькофф Бизнес (счета и платежи)](https://dsgners.ru/artem-konakov/2854-ux-patrul-vyipusk-chetvertyiy-tinkoff-biznes-scheta-i-plateji)
- [Битрикс24 — Возможности счетов в CRM](https://helpdesk.bitrix24.ru/open/17614982/)
- [Битрикс24 — Новые счета в CRM](https://helpdesk.bitrix24.ru/open/14795982/)
- [amoCRM — Описание приложения](https://express-pay.by/docs/opisanie-prilozheniya-amocrm)

**AR / Aging:**
- [NetSuite — Accounts Receivable Dashboard](https://www.netsuite.com/portal/resource/articles/accounting/accounts-receivable-ar-dashboard.shtml)
- [Versapay — AR Aging Reports](https://www.versapay.com/resources/ar-aging-reports-how-to-create)

**Industry-specific:**
- [StudioBinder — Film Budget Template Guide](https://www.studiobinder.com/blog/the-essential-guide-for-crafting-film-budgets-with-free-film-budget-template/)

STATUS: DONE
