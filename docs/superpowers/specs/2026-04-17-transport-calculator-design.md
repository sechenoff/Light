# Транспорт в брони — калькулятор + админ CRUD

**Дата:** 2026-04-17  
**Статус:** Approved by user — ready to implement

## Цель

Добавить в бронь (`/bookings/new`) выбор транспорта с автоматическим расчётом стоимости по формуле. Ставки редактируются в админке `/admin/vehicles`. Сейчас реализуем **только вариант «с водителем»**, без водителя — в следующем PR.

## Три машины (начальный сид)

| Машина | `slug` | Смена в Москве | Опция «+ генератор» |
|---|---|---|---|
| Ford | `ford` | 20 000 ₽ | — |
| Фотон | `foton` | 25 000 ₽ | — |
| Ивеко | `iveco` | 24 000 ₽ | +25 000 ₽ |

Стандартная смена = **12 часов**. Переработка = **10% × ставка × часы свыше 12**.

## Пользовательский флоу

1. Клиент → Проект (как сейчас)
2. Даты (как сейчас)
3. Оборудование (как сейчас)
4. **Транспорт (новое, опционально)**
   - Radio: без транспорта / Ford / Фотон / Ивеко
   - Для Ивеко — чекбокс «+ генератор» (+25 000 ₽)
   - Поле «Часы смены» (auto из дат, редактируется)
   - Чекбокс «Без переработки» (отключает OT даже если часы > 12)
   - Чекбокс «Выезд за МКАД» → появляется поле «Км до площадки», цена 120 ₽/км (60 × туда-обратно)
   - Чекбокс «Заезд в ТТК» (+500 ₽)
5. Комментарий (как сейчас)

В `SummaryPanel` справа:
```
Оборудование:       X ₽
Скидка Y%:         −Z ₽
──────────────────
Оборудование итого: A ₽      ← скидка применяется ТОЛЬКО сюда

Транспорт (Ford):   B ₽      ← без скидки, отдельная строка

Итого:            A+B ₽
```

## Формула расчёта транспорта

```ts
function computeTransportPrice(input: {
  vehicle: Vehicle;           // shiftPriceRub, generatorPriceRub?
  withGenerator: boolean;     // применимо только если vehicle.hasGeneratorOption
  shiftHours: number;         // часы одной смены
  skipOvertime: boolean;      // чекбокс «Без переработки»
  kmOutsideMkad: number;      // одно число «до площадки», умножается на 120
  ttkEntry: boolean;          // +500 ₽
}) {
  const baseShift = Number(input.vehicle.shiftPriceRub);
  const generator = input.withGenerator && input.vehicle.hasGeneratorOption
    ? Number(input.vehicle.generatorPriceRub ?? 0)
    : 0;
  const shiftRate = baseShift + generator;

  const overtimeHours = input.skipOvertime ? 0 : Math.max(0, input.shiftHours - 12);
  const overtime = shiftRate * 0.10 * overtimeHours;

  const km = input.kmOutsideMkad * 120;  // 60 ₽/км × туда-обратно

  const ttk = input.ttkEntry ? 500 : 0;

  const total = shiftRate + overtime + km + ttk;

  return {
    shiftRate,
    overtime,
    overtimeHours,
    km,
    ttk,
    total,
  };
}
```

Функция **pure** — только арифметика, никаких побочных эффектов. Легко юнит-тестируется.

## Изоляция скидки

Ключевое правило: `discountPercent` на брони применяется **только к `items[]`**, а не к транспорту.

Старый расчёт в `quoteEstimate()`:
```
subtotal = items.sum()
discount = subtotal * discountPercent / 100
total    = subtotal - discount
```

Новый:
```
equipmentSubtotal = items.sum()
discount          = equipmentSubtotal * discountPercent / 100
equipmentTotal    = equipmentSubtotal - discount

transportTotal    = computeTransportPrice(...)?.total ?? 0

grandTotal        = equipmentTotal + transportTotal
```

## Схема БД

### Новая таблица `Vehicle`

```prisma
model Vehicle {
  id                 String   @id @default(cuid())
  name               String                    // "Ford", "Фотон", "Ивеко"
  slug               String   @unique          // "ford", "foton", "iveco"
  shiftPriceRub      Decimal  @db.Decimal(10, 2)
  hasGeneratorOption Boolean  @default(false)
  generatorPriceRub  Decimal? @db.Decimal(10, 2)
  shiftHours         Int      @default(12)
  overtimePercent    Decimal  @db.Decimal(5, 2) @default(10)
  displayOrder       Int      @default(0)
  active             Boolean  @default(true)
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt
}
```

### Расширение `Booking`

```prisma
model Booking {
  // ... existing fields ...

  // Transport snapshot — захватывается в момент создания/апдейта
  vehicleId             String?
  vehicle               Vehicle?  @relation(fields: [vehicleId], references: [id])
  vehicleWithGenerator  Boolean   @default(false)
  vehicleShiftHours     Decimal?  @db.Decimal(5, 2)
  vehicleSkipOvertime   Boolean   @default(false)
  vehicleKmOutsideMkad  Int?
  vehicleTtkEntry       Boolean   @default(false)
  transportSubtotalRub  Decimal?  @db.Decimal(10, 2)
}
```

Только **один** транспорт на бронь в v1. Если понадобится несколько — расширим моделью `BookingTransport` через pivot.

### Сид
В `prisma/seed.ts`: `upsert` 3 машин по slug с ценами из таблицы выше.

## API

### `GET /api/vehicles`
Список активных машин. Доступен всем с валидной сессией (нужен для формы брони).

Response:
```json
{
  "vehicles": [
    { "id": "…", "slug": "ford", "name": "Ford", "shiftPriceRub": "20000.00",
      "hasGeneratorOption": false, "generatorPriceRub": null, "displayOrder": 1 },
    { "id": "…", "slug": "foton", "name": "Фотон", "shiftPriceRub": "25000.00", ... },
    { "id": "…", "slug": "iveco", "name": "Ивеко", "shiftPriceRub": "24000.00",
      "hasGeneratorOption": true, "generatorPriceRub": "25000.00", ... }
  ]
}
```

### `GET /api/admin/vehicles`
То же + неактивные. `rolesGuard(["SUPER_ADMIN"])`.

### `PATCH /api/admin/vehicles/:id`
SUPER_ADMIN only. Редактирует: `shiftPriceRub`, `generatorPriceRub`, `shiftHours`, `overtimePercent`, `active`, `displayOrder`.  
Не даёт поменять `slug` (immutable identifier) и `hasGeneratorOption` (определяется природой машины).  
Пишет `AuditEntry { entityType: "Vehicle", action: "VEHICLE_UPDATED", before, after }`.

### Расширение существующих endpoints

**`POST /api/bookings/quote`** и **`POST /api/bookings/draft`** принимают опциональное поле:
```json
{
  "items": [...],
  "transport": {
    "vehicleId": "…",
    "withGenerator": false,
    "shiftHours": 12,
    "skipOvertime": false,
    "kmOutsideMkad": 0,
    "ttkEntry": false
  }
}
```

`PATCH /api/bookings/:id` — то же расширение.

Response `quote`:
```json
{
  "equipmentSubtotal": "67500.00",
  "discountPercent": 10,
  "equipmentDiscount": "6750.00",
  "equipmentTotal": "60750.00",
  "transport": {
    "shiftRate": "20000.00",
    "overtime": "0.00",
    "overtimeHours": 0,
    "km": "0.00",
    "ttk": "0.00",
    "total": "20000.00"
  },
  "grandTotal": "80750.00"
}
```

Обратная совместимость: если `transport` не передан, `transport: null` в ответе, `grandTotal === equipmentTotal`. Все существующие тесты должны продолжать зелёно работать.

## UI компоненты

### Новая секция `TransportCard` в `/bookings/new`

Файл: `apps/web/src/components/bookings/create/TransportCard.tsx`.

Props (controlled):
- `vehicles: VehicleRow[]` (загружены из `/api/vehicles`)
- `selectedVehicleId: string | null`
- `onChangeVehicle: (id: string | null) => void`
- `withGenerator: boolean`, `onChangeGenerator: (v: boolean) => void`
- `shiftHours: number`, `onChangeShiftHours: (h: number) => void`
- `skipOvertime: boolean`, `onChangeSkipOvertime: (v: boolean) => void`
- `kmOutsideMkad: number`, `onChangeKm: (n: number) => void`
- `ttkEntry: boolean`, `onChangeTtk: (v: boolean) => void`
- `breakdown: TransportBreakdown | null` (из `/quote` или локально-вычисленный)

Стиль — тот же канон (IBM Plex, semantic tokens). Эстетически выдержан с существующими карточками `ClientProjectCard`, `DatesCard`, `EquipmentCard`.

### Изменения в `SummaryPanel`

Разделить рендер на:
- Строка «Оборудование» (сумма)
- Строка «Скидка X%» (если >0)
- Строка «Оборудование итого» (после скидки) — показывать только если есть скидка, иначе сливается с «Оборудование»
- Строка «Транспорт (N машина)» (если выбрана) — без участия скидки
- Итого

### Админ-страница `/admin/vehicles`

Файл: `apps/web/app/admin/vehicles/page.tsx`.

Таблица:
| Порядок | Машина | Ставка | Генератор | Активна | … |
|---|---|---|---|---|---|
| 1 | Ford | 20 000 ₽ | — | ✓ | [Редактировать] |
| 2 | Фотон | 25 000 ₽ | — | ✓ | [Редактировать] |
| 3 | Ивеко | 24 000 ₽ | +25 000 ₽ | ✓ | [Редактировать] |

Кнопка «Редактировать» → модалка `VehicleEditModal`:
- Ставка смены (number input, ₽)
- Стоимость генератора (показывается только если `hasGeneratorOption`)
- Часы смены (по умолчанию 12)
- % переработки (по умолчанию 10)
- Активна / Скрыта (switch)

Новая вкладка в `AdminTabNav`: `{ href: "/admin/vehicles", label: "Транспорт" }`.

## Что отложено на следующие PR

- **Без водителя** — потребует отдельных ставок и, возможно, другой формулы
- **Суточные для водителя в командировке** (1000 ₽/день, 500 ₽/meal если нет 3-разового питания)
- **Дни простоя** (1/2 смены если занято <6 дней в неделю, кроме 1 выходного)
- **Трансферные дни в экспедиции** (50%/100% от смены, раздел 7.1 правил)
- **Погрузка/разгрузка в командировку** = 1/2 смены (раздел 7.2)
- **Штрафы за отмену** (−24ч: 50%, −12ч: 100%)
- **Несколько машин на одну бронь**
- **Проверка доступности машины на даты** (нет ли конфликта с другой бронью)

Эти темы описаны в правилах, но каждая тянет UI + расчёт + тесты → лучше отдельным PR после v1.

## Тесты

### Backend: `apps/api/src/__tests__/transportCalculator.test.ts`
- Чисто сменная ставка в Москве
- С генератором
- С переработкой 2 часа (Ford: 20000 + 2×2000 = 24000)
- С `skipOvertime=true` (overtime=0 даже при 14 часах)
- С километражем 100 км → 12 000 ₽
- С ТТК → +500 ₽
- Комбинация: Ивеко + генератор + 14 часов + 50 км + ТТК
- Граничные: `shiftHours=0`, `kmOutsideMkad` отрицательный → 0

### Backend: `apps/api/src/__tests__/bookingsQuote.test.ts` (или расширение smoke-тестов)
- `/quote` без транспорта — равно старому поведению
- `/quote` с транспортом — `grandTotal === equipmentTotal + transport.total`
- `/quote` со скидкой + транспорт — проверка **изоляции скидки**
- `/bookings/draft` сохраняет `vehicleId` + `transportSubtotalRub`

### Backend: `apps/api/src/__tests__/vehiclesApi.test.ts`
- `GET /api/vehicles` — только активные, сессия требуется
- `GET /api/admin/vehicles` — 403 для WAREHOUSE/TECHNICIAN
- `PATCH /api/admin/vehicles/:id` — 200 для SUPER_ADMIN, пишет аудит
- `PATCH` с попыткой изменить `slug` / `hasGeneratorOption` → игнорируется (не в allowed fields)

### Web: `apps/web/src/components/bookings/create/__tests__/TransportCard.test.tsx`
- Рендер radio-кнопок машин
- Клик выбирает машину + показывает breakdown
- Чекбокс «+ генератор» виден только для Ивеко
- «Без переработки» зануляет OT в breakdown
- Ввод км обновляет строку расчёта

### Web: `apps/web/app/admin/vehicles/__tests__/page.test.tsx` (минимальный)
- Рендер таблицы с загруженными машинами
- Клик «Редактировать» → открывает модалку

## Критерии приёмки

- [ ] `npm --workspace=apps/api run test` — все API-тесты зелёные (существующие + новые)
- [ ] `npm --workspace=apps/web run test` — все web-тесты зелёные
- [ ] `npx tsc --noEmit -p apps/api` — чисто
- [ ] `npx tsc --noEmit -p apps/web` — чисто (кроме известного `formatWaitingTime.test.ts` warning)
- [ ] `npm run build -w apps/web` — без ошибок
- [ ] Миграция применена на test DB, сид создал 3 машины
- [ ] На `/bookings/new` в secured-режиме (WAREHOUSE session) виден раздел «4. Транспорт»
- [ ] На `/admin/vehicles` (SUPER_ADMIN only) можно открыть модалку и отредактировать цену
- [ ] `/admin/audit` показывает запись `VEHICLE_UPDATED` после редактирования
- [ ] `POST /bookings/draft` с `transport` возвращает корректный `transportSubtotalRub` в ответе и сохраняет в БД
- [ ] Скидка не применяется к транспорту — проверено тестом и визуально в SummaryPanel
