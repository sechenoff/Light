# Финансы v2 — редизайн структуры + аудит математики (2026-07-17)

## Диагноз

Финблок перестраивался 2026-04-26 по мокапам `finance-redesign-2026-04-25/`, но
информационная архитектура осталась **invoice-центричной** (модель QuickBooks:
счёт → оплата). Фактическое использование на проде (2026-07-17):

| Сущность | Кол-во | Вывод |
|---|---|---|
| Invoice | **0** | счёт-слой не используется вообще |
| CreditNote | **0** | кредит-ноты не используются |
| Payment | **257** (99% CASH) | ядро — платежи |
| Expense | 3 | почти не используется |
| Долги (брони c amountOutstanding>0) | **78 броней / 4 643 755 ₽** | ядро — дебиторка |

Бизнес живёт по модели **«бронь → долг → платёж»** (informal AR). Отсюда:
- Сводка на дефолтном периоде показывает нули (mёртвый экран), прогноз по
  счетам пуст всегда, «Топ-должники» дублирует /debts.
- Три разных формулы «получено за период» в одном ответе dashboard
  (computeFinanceDashboard / computeMonthlyTrend / legacy dashboardMetrics).

## Целевая структура (референсы: QuickBooks Cash Flow, Xero Bank Summary + Invoices Owed)

### Сводка `/finance` — «состояние денег за 10 секунд»
1. **KPI-ряд** (за период, дефолт «Месяц»): Получено (нетто, с Δ% к прошлому
   периоду) · Расходы (approved) · Чистыми · **Долг** (снимок, НЕ зависит от
   периода) + просрочено.
2. **Денежный поток** — бар-чарт 6 мес (получено/расходы/нетто) на реальных
   платежах. Заменяет всегда-пустой invoice-forecast.
3. **Дебиторка по возрасту (AR aging)** — 4 кликабельных бакета: не просрочен /
   1–30 / 31–60 / 60+ дн → /finance/debts с фильтром.
4. **Требует внимания** — топ просроченных + ожидаемые поступления 7 дн
   (пустые секции скрываются).

### Подстраницы
- **Долги** — главная рабочая страница (уже сильная), мелкая чистка: мёртвая
  карта «К напоминанию 0», клиент «—».
- **Платежи** — дефолт периода «Месяц» (не «Всё время»), убрать перегруз.
- **Счета** — остаётся (юрлица в будущем), но сводка от счетов не зависит.
- **Расходы** — фикс «−0 ₽», остаётся.

## Математика — фиксы (по результатам мульти-агентного аудита)

### Единая семантика «получено за период»
Каноническое определение: INCOME-платёж, не void; дата = `receivedAt ?? paymentDate`
(coalesce, БЕЗ OR-окон, дающих двойной учёт); учитывать refund (нетто).
Применить в: computeFinanceDashboard.earnedAgg, computeMonthlyTrend,
computePaymentsCalendar. Legacy dashboardMetrics — свести к минимально
потребляемому (см. «Удалить»).

### Единый критерий просрочки
`isBookingOverdue()` везде: overdueClientsCount (сейчас — сырая дата),
topDebtors.daysOverdue.

### Прочие
- CreditNoteApplyModal: `remainingAmount` → `remaining` (CRITICAL — поле не существует).
- computeForecast: bookingsPipeline не должен фолбэчить оплаченные брони на finalAmount.
- /finance/payments-by-client: Decimal вместо float-агрегации.
- Расходы в dashboardMetrics: фильтр approved.
- invoices/page: «Остаток» через Decimal-строки, «N дн. проср.» не для PAID.
- ?search= на /api/invoices: реализовать или убрать инпут.

## Удалить (мёртвое)
- `computeAging()` + импорт (не вызывается: /debts использует computeAgingPerClient).
- Спред legacy `dashboardMetrics()` в /finance/dashboard → оставить только
  `summary.overdueReceivables` (единственный потребитель — /day), убрав 9 запросов
  (включая findMany ВСЕХ payments/expenses в память).
- Мёртвые эндпоинты: GET /api/profit (float-математика!), /api/cashflow,
  /api/receivables, export/profit.xlsx|csv, export/payments.csv, export/expenses.xlsx
  (живой только export/payments.xlsx).
- Мёртвый код /finance/page.tsx: formatEventDate, ActivityEntry, Dashboard.summary
  поля, TopDebtor.projectName ветка, дубли isSA-проверок.
- periodUtils: мёртвый nextMonthStart.
- invoices/page: клиентский counts-фолбэк, disabled-чекбоксы VOID, мобильные
  дубль-пилюли, «Скачать все PDF» (качает DRAFT-uuid).
- Zod sort enum debtsQuerySchema: убрать нереализованные startDate/status.

## Ограничения
- Канон дизайна фиксирован: IBM Plex + business blue + семантические токены.
- Никаких изменений схемы БД.
- API-контракты, потребляемые /day и /lk, не ломать (только сужение
  dashboardMetrics до фактически потребляемого поля).
