# Импорт прошедших съёмок в раздел «Долги»

**Дата:** 2026-04-17  
**Статус:** Approved by user — ready to implement

## Цель

На `/finance/debts` добавить кнопку «+ Импортировать смету», которая открывает модалку с drop-зоной для `.xlsx`/`.xls` файлов. Парсер извлекает дату, клиента и сумму из имени файла (и дополняет данными из содержимого, если в имени нет суммы). Создаёт Booking-записи со статусом `RETURNED`, без items, с флагом `isLegacyImport=true`, чтобы долг появился в списке.

## Использование

Пример имён файлов, которые нужно импортировать:
- `04.04 Романов 22137.xlsx` → дата 04.04.2026, клиент «Романов», сумма 22 137 ₽
- `06.03 Гена 120030.xlsx` → 06.03.2026, Гена, 120 030 ₽
- `10.04 хокаге 52600 (2).xlsx` → 10.04.2026, хокаге, 52 600 ₽ (маркер `(2)` — дубль, игнорируем)
- `06_04_26 Бильярд (2).xls` → 06.04.2026, Бильярд, (сумма из содержимого)
- `8-16 марта Геннадий.xlsx` → 08.03.2026 (первая дата), Геннадий, (сумма из содержимого)

## Решения (утверждены пользователем)

1. **Дубли не автоматически дедуплицируем** — пользователь сам удалит лишнее через UI списка броней. Файл с маркером `(2)` импортируется как отдельная строка.
2. **Клиент lookup** — case-insensitive + trim. «хокаге» и «Хокаге» = один клиент. Имя сохраняется как было в первом встреченном файле.
3. **Год по умолчанию** — текущий календарный год (2026). Пользователь может поправить в preview.

## Архитектура

### Пункт 1: Схема БД

Новое поле на Booking:
```prisma
model Booking {
  // ... existing fields ...
  isLegacyImport Boolean @default(false)
}
```

Миграция: `npx prisma db push --accept-data-loss` применит.

### Пункт 2: Парсер имени файла (shared утилита)

Файл: `apps/web/src/lib/legacyBookingParser.ts` (client-side; можно также положить в `packages/shared` если понадобится серверу, но пока не нужно).

```ts
export type ParsedFilename = {
  date: Date | null;      // null если не распознана
  clientName: string;     // может быть пустая, надо будет в UI подтвердить
  amount: number | null;  // null если в имени нет
  isDuplicate: boolean;   // true если есть (N) маркер
};

export function parseLegacyFilename(filename: string, year: number): ParsedFilename;
```

Стратегия (по приоритету паттернов):

1. **`DD.MM ClientName Amount.xlsx`** (самый частый)
   - Regex: `^(\d{1,2})\.(\d{1,2})\s+(.+?)\s+(\d+)(?:\s*\(\d+\))?\.[xl]+$`
   - год = параметр (по умолчанию 2026)
   - `(N)` в конце → `isDuplicate=true`

2. **`DD_MM_YY ClientName (N).xls`**
   - Regex: `^(\d{1,2})_(\d{1,2})_(\d{2})\s+(.+?)(?:\s*\(\d+\))?\.[xl]+$`
   - год: `20XX` (если YY < 50) или `19XX`
   - Сумма = null (нет в имени — парсить excel)

3. **`D-DD месяц ClientName.xlsx`** (range даты)
   - Regex: `^(\d{1,2})[-–](\d{1,2})\s+(янв|фев|мар|апр|май|июн|июл|авг|сен|окт|ноя|дек)[а-я]*\s+(.+?)(?:\s*\(\d+\))?\.[xl]+$`
   - Берём первую дату из диапазона
   - Маппинг месяца: янв=1, фев=2, ... дек=12
   - Сумма = null

4. **Fallback** — ни один паттерн не подошёл: всё null/пусто, пользователь заполнит вручную в preview.

Unit-тесты для каждого паттерна с файлами из выборки пользователя — обязательны.

### Пункт 3: Парсер содержимого Excel (client-side)

Файл: `apps/web/src/lib/legacyBookingExcel.ts`.

Зависимость: `xlsx` (SheetJS, уже в `node_modules` через `apps/api`, нужно добавить и в `apps/web`, потому что это `apps/web` клиентский).

```ts
export type ExcelAmountResult = {
  amount: number | null;
  source: "Сумма сметы со скидкой" | "ИТОГО" | "unknown";
  rawLabel?: string;  // полная строка найденной метки для диагностики
};

export async function parseLegacyExcelAmount(file: File): Promise<ExcelAmountResult>;
```

Логика:
1. Прочитать первый лист (`Лист1` если есть, иначе первый).
2. Проитерировать строки снизу. Найти первую, где cell[0] матчится `/сумм.*скидк/i` — вернуть cell[1] как amount.
3. Если не нашли — поискать `/итого/i` в любой ячейке — вернуть соседнюю численную.
4. Если ничего — `amount=null, source="unknown"`.

### Пункт 4: Backend — API

Файл: `apps/api/src/routes/finance.ts` — добавить маршрут.

```ts
POST /api/finance/import-legacy-bookings
rolesGuard: [SUPER_ADMIN]
body: {
  rows: Array<{
    filename: string;        // для диагностики и projectName
    clientName: string;
    date: string;            // ISO
    amount: number;          // final, в ₽
  }>;
}
response: {
  created: number;
  clients: { created: number; matched: number };
  bookings: Array<{ id: string; clientName: string; finalAmount: string }>;
}
```

Сервис: `apps/api/src/services/legacyBookingImport.ts`.

```ts
export async function importLegacyBookings(rows: LegacyImportRow[], userId: string) {
  return prisma.$transaction(async (tx) => {
    const results = [];
    let clientsCreated = 0, clientsMatched = 0;

    for (const row of rows) {
      // Case-insensitive + trim client lookup
      const normalizedName = row.clientName.trim();
      if (!normalizedName) throw new HttpError(400, `Empty client name for ${row.filename}`);
      
      const existingClient = await tx.client.findFirst({
        where: { name: { equals: normalizedName, mode: "insensitive" } },
      });
      const client = existingClient ?? await tx.client.create({
        data: { name: normalizedName, phone: null, email: null, comment: "Создан импортом легаси-брони" },
      });
      if (existingClient) clientsMatched++; else clientsCreated++;

      // Create booking: status=RETURNED, isLegacyImport=true, no items
      const startDate = new Date(row.date);
      const endDate = new Date(row.date);
      endDate.setHours(23, 59, 59);
      
      const amountDec = new Decimal(row.amount).toDecimalPlaces(2).toString();
      const booking = await tx.booking.create({
        data: {
          clientId: client.id,
          projectName: `Импорт: ${row.filename}`,
          startDate,
          endDate,
          status: "RETURNED",
          isLegacyImport: true,
          comment: null,
          discountPercent: null,
          totalEstimateAmount: amountDec,
          discountAmount: "0",
          finalAmount: amountDec,
          paymentStatus: "NOT_PAID",
          amountPaid: "0",
          amountOutstanding: amountDec,
          isFullyPaid: false,
        },
      });

      await writeAuditEntry({
        tx,
        userId,
        action: "LEGACY_IMPORTED",
        entityType: "Booking",
        entityId: booking.id,
        before: null,
        after: { filename: row.filename, clientName: normalizedName, amount: row.amount },
      });

      results.push({ id: booking.id, clientName: normalizedName, finalAmount: amountDec });
    }

    return { created: results.length, clients: { created: clientsCreated, matched: clientsMatched }, bookings: results };
  });
}
```

**Важно:** валидация `items.length > 0` в `createBookingDraft` не затрагивается — мы не используем её, напрямую создаём через `tx.booking.create`.

Аудит: новый тип action `"LEGACY_IMPORTED"` — ничего не делаем, union типов уже включает произвольные строки.

### Пункт 5: Frontend — UI

#### Модалка импорта

Файл: `apps/web/src/components/finance/LegacyBookingImportModal.tsx`.

```tsx
export function LegacyBookingImportModal(props: {
  open: boolean;
  onClose: () => void;
  onImported: () => void;  // refresh debts after
}) {
  // steps: "files" -> "preview" -> "submitting" -> "done"
  // files: drop zone + file list
  // preview: table of parsed rows, editable inline
  // submitting: spinner
  // done: success summary, close button
}
```

Поля строки превью:
```
┌──────────────────┬──────────────┬──────────┬──────────┬──────────┬─────────┐
│ Файл             │ Дата         │ Клиент   │ Сумма ₽  │ Статус   │ Действие│
├──────────────────┼──────────────┼──────────┼──────────┼──────────┼─────────┤
│ 04.04 Романов … │ 04.04.2026   │ Романов  │ 22 137   │ ✓ готов  │ ✕       │
│ 06_04_26 Бильярд │ 06.04.2026   │ Бильярд  │ 112 100  │ ✓ из Excel│ ✕      │
│ 8-16 марта Г…    │ 08.03.2026   │ Геннадий │ ? ₽      │ ⚠ нужна ₽ │ ✕      │
│ 17.04 Незрим 9…  │ 17.04.2026   │ Незрим   │ 99 600   │ ✓ готов   │ ✕      │
└──────────────────┴──────────────┴──────────┴──────────┴──────────┴─────────┘
```

Поля date/clientName/amount — редактируются inline (date picker / text input / number input).

Статус ячейки:
- **✓ готов** — зелёная, все поля валидны
- **✓ из Excel** — зелёная, сумма была распарсена из содержимого
- **⚠ нужна ₽** — жёлтая, сумма не найдена, пользователь должен ввести
- **✕ ошибка** — красная, нет клиента или нет даты

Ряды с статусом «ошибка» не будут отправлены (disabled).

Низ модалки:
- Счётчик: `N готово к импорту, M с ошибкой`
- Кнопки: `Отмена` | `Импортировать N броней` (disabled если N=0)

Кнопка отправляет POST `/api/finance/import-legacy-bookings`, при успехе:
- Показывает toast «N броней импортировано»
- Закрывает модалку
- Вызывает `onImported()` для refetch списка долгов

#### Кнопка на `/finance/debts`

Новый блок в шапке, рядом с существующими фильтрами:
```tsx
<button
  type="button"
  onClick={() => setImportOpen(true)}
  className="rounded border border-accent-border bg-accent-soft px-3 py-1.5 text-sm text-accent-bright hover:bg-accent-border"
>
  + Импортировать смету
</button>
```

Видна только для `SUPER_ADMIN` (через `useCurrentUser`).

## Тесты

### Unit: `apps/web/src/lib/__tests__/legacyBookingParser.test.ts`
- 8+ кейсов из выборки пользователя: парсинг всех 3 паттернов имени + `(2)` маркер + файлы без суммы + нераспознанный
- Граничные: год < 50 (→ 20xx), год >= 50 (→ 19xx), нет года (→ текущий)

### Unit: `apps/web/src/lib/__tests__/legacyBookingExcel.test.ts`
- Простой файл `Лист1` с `"Сумма сметы с 50% скидкой"` → парсится
- Файл без этой метки → `source: "unknown"`, `amount: null`
- Файл с `"ИТОГО"` в другом листе → парсится

(для этих тестов вложим тестовые xlsx в `apps/web/test-fixtures/`)

### Backend: `apps/api/src/__tests__/legacyBookingImport.test.ts`
- Один файл → создаёт клиента и бронь
- Два файла одного клиента → один клиент, две брони
- Case-insensitive client match: «хокаге» и «Хокаге» → один клиент (first-wins name)
- `amountOutstanding = finalAmount` сразу после импорта
- `AuditEntry { action: "LEGACY_IMPORTED" }` создана
- rolesGuard: WAREHOUSE/TECHNICIAN → 403

### Backend: `apps/api/src/__tests__/financeDebts.test.ts`
- Расширение: бронь с `isLegacyImport=true` и `amountOutstanding > 0` появляется в `/finance/debts`

## Критерии приёмки

- [ ] Миграция применена: `Booking.isLegacyImport` существует
- [ ] `/finance/debts` показывает кнопку «+ Импортировать смету» (SUPER_ADMIN)
- [ ] Модалка парсит 40 файлов пользователя корректно (проверить все 3 паттерна)
- [ ] Bulk import: 10 файлов разом → в БД 10 броней, клиенты дедуплицируются case-insensitive
- [ ] После импорта: `/finance/debts` показывает новые записи
- [ ] Аудит: `LEGACY_IMPORTED` entries видны в `/admin/audit`
- [ ] Все существующие тесты зелёные
- [ ] Новые тесты (unit + API) зелёные
