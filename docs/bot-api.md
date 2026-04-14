# Bot API — Контракт для OpenAI-бота

Документация REST API системы управления рентал-оборудованием для подключения Telegram-бота на базе OpenAI. Все эндпоинты работают на базе существующего Express-сервера.

---

## 1. Общее

**Base URL:** `https://<your-api-host>/api`

**Формат ответов:** JSON. Все денежные значения — строки в формате `"1234.56"` (Decimal, не float).

**Аутентификация:** заголовок `X-API-Key` (обязательно). Подробнее — раздел 2.

**Пример ответа с ошибкой:**
```json
{ "message": "Описание ошибки", "code": "ERROR_CODE" }
```

---

## 2. Аутентификация

Все запросы (кроме `/health`) требуют заголовок:

```
X-API-Key: openclaw-<32-hex-символа>
```

### Формат бот-ключа

Ключи для бота должны начинаться с префикса `openclaw-`:

```
openclaw-a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4
```

### Генерация ключа (macOS/Linux)

```bash
echo "openclaw-$(openssl rand -hex 16)"
```

### Установка ключа на сервере

Добавить в `apps/api/.env`:

```env
API_KEYS=openclaw-<ваш-ключ>,...другие ключи...
AUTH_MODE=enforce
```

После изменения — перезапустить API (`pm2 restart api` или `./deploy.sh --api`).

### Ротация ключа

1. Добавить новый ключ в `API_KEYS` (через запятую рядом со старым).
2. Перезапустить API.
3. Убедиться, что бот работает с новым ключом.
4. Удалить старый ключ и снова перезапустить.

---

## 3. Scope-ограничения для бот-ключей

Ключи с префиксом `openclaw-` имеют ограниченный доступ (whitelist). Все остальные запросы вернут `403 BOT_SCOPE_FORBIDDEN`.

### Разрешённые роуты

| Метод  | Путь                                       | Назначение                        |
|--------|--------------------------------------------|-----------------------------------|
| GET    | `/api/equipment`                           | Каталог оборудования              |
| GET    | `/api/equipment/:id`                       | Карточка оборудования             |
| GET    | `/api/availability`                        | Проверка доступности              |
| GET    | `/api/bookings`                            | Список броней                     |
| GET    | `/api/bookings/:id`                        | Детали брони                      |
| POST   | `/api/bookings/draft`                      | Создать черновик (+ dryRun)       |
| POST   | `/api/bookings/quote`                      | Предварительный расчёт сметы      |
| POST   | `/api/bookings/match-equipment`            | Подбор оборудования по описанию   |
| POST   | `/api/bookings/parse-gaffer-review`        | Парсинг текста от гаффера         |
| PATCH  | `/api/bookings/:id`                        | Редактирование брони (+ dryRun)   |
| POST   | `/api/bookings/:id/status`                 | Смена статуса брони               |
| POST   | `/api/bookings/:id/confirm`                | Подтверждение брони               |
| GET    | `/api/finance/debts`                       | Агрегация долгов по клиентам      |
| GET    | `/api/finance/dashboard`                   | Финансовые метрики                |
| GET    | `/api/receivables`                         | Плоский список дебиторки          |
| GET    | `/api/payments`                            | Список платежей                   |

### Пример запрещённого действия

```bash
curl -X DELETE https://api.example.com/api/bookings/abc \
  -H "X-API-Key: openclaw-xxx"
# → 403
```

```json
{ "message": "Bot keys are not allowed to delete", "code": "BOT_SCOPE_FORBIDDEN" }
```

---

## 4. Эндпоинты

### 4.1 GET /api/equipment — Каталог оборудования

**Query params:**
- `search` (string) — поиск по названию
- `category` (string) — фильтр по категории
- `limit` (number, default: 100) — лимит записей

**Пример:**
```bash
curl "https://api.example.com/api/equipment?search=fresnel&limit=10" \
  -H "X-API-Key: openclaw-xxx"
```

**Ответ:**
```json
{
  "equipment": [
    {
      "id": "eq_abc123",
      "name": "Arri Fresnel 2kW",
      "category": "Свет",
      "rentalRatePerShift": "2000.00",
      "totalQuantity": 3
    }
  ]
}
```

---

### 4.2 GET /api/availability — Проверка доступности

**Query params:**
- `from` (ISO datetime, обязательно)
- `to` (ISO datetime, обязательно)
- `equipmentId` (string) — фильтр по ID оборудования

**Пример:**
```bash
curl "https://api.example.com/api/availability?from=2026-04-20T10:00:00Z&to=2026-04-22T10:00:00Z" \
  -H "X-API-Key: openclaw-xxx"
```

---

### 4.3 POST /api/bookings/quote — Предварительный расчёт сметы

Рассчитывает смету без создания брони. Дата-парсинг и Zod-валидация как у `/draft`.

**Тело запроса:** аналогично POST `/api/bookings/draft` (без `dryRun`).

**Ответ:**
```json
{
  "shifts": 2,
  "subtotal": "6000.00",
  "discountPercent": "0",
  "discountAmount": "0.00",
  "totalAfterDiscount": "6000.00",
  "lines": [
    {
      "equipmentId": "eq_abc123",
      "nameSnapshot": "Arri Fresnel 2kW",
      "quantity": 1,
      "unitPrice": "3000.00",
      "lineSum": "3000.00"
    }
  ]
}
```

---

### 4.4 POST /api/bookings/draft — Создать черновик брони

**Тело запроса:**
```json
{
  "client": {
    "name": "Ромашка Продакшн",
    "phone": "+79001234567",
    "email": "romashka@example.com"
  },
  "projectName": "Клип «Лето»",
  "startDate": "2026-04-20T10:00:00.000Z",
  "endDate": "2026-04-22T10:00:00.000Z",
  "items": [
    { "equipmentId": "eq_abc123", "quantity": 2 }
  ],
  "discountPercent": 10,
  "dryRun": false
}
```

**Поля:**
- `client.name` — обязательно
- `projectName` — обязательно
- `startDate`, `endDate` — обязательно, ISO datetime или YYYY-MM-DD
- `items` — обязательно, минимум 1 позиция
- `discountPercent` — опционально, 0–100
- `dryRun` — опционально (default: false)

#### dryRun: true — Превью без записи

При `dryRun: true` бронь **не создаётся** в БД. Возвращается превью с расчётом сметы:

```json
{
  "dryRun": true,
  "booking": {
    "id": null,
    "status": "DRAFT_PREVIEW",
    "client": { "name": "Ромашка Продакшн", "phone": "+79001234567", "email": null },
    "projectName": "Клип «Лето»",
    "startDate": "2026-04-20T10:00:00.000Z",
    "endDate": "2026-04-22T10:00:00.000Z",
    "items": [{ "equipmentId": "eq_abc123", "quantity": 2 }],
    "estimate": {
      "shifts": 2,
      "subtotal": "8000.00",
      "discountPercent": "10",
      "discountAmount": "800.00",
      "totalAfterDiscount": "7200.00",
      "lines": [...]
    }
  }
}
```

**Типичный сценарий бота:**
1. Бот вызывает `POST /draft` с `dryRun: true`
2. Показывает превью пользователю
3. Пользователь подтверждает
4. Бот вызывает `POST /draft` без `dryRun` (создаёт реальную бронь)

---

### 4.5 PATCH /api/bookings/:id — Редактировать бронь

Изменяет параметры существующей брони (DRAFT или CONFIRMED).

**Тело запроса (все поля опциональны):**
```json
{
  "projectName": "Новое название",
  "startDate": "2026-04-21T10:00:00.000Z",
  "endDate": "2026-04-23T10:00:00.000Z",
  "items": [{ "equipmentId": "eq_abc123", "quantity": 3 }],
  "discountPercent": 15,
  "dryRun": false
}
```

#### dryRun: true — Превью изменений

При `dryRun: true` бронь **не изменяется**. Возвращается превью брони после применения изменений:

```json
{
  "dryRun": true,
  "booking": {
    "id": "book_xyz",
    "status": "CONFIRMED",
    "projectName": "Новое название",
    "startDate": "2026-04-21T10:00:00.000Z",
    "endDate": "2026-04-23T10:00:00.000Z",
    "items": [...],
    "estimate": { ... }
  }
}
```

---

### 4.6 POST /api/bookings/:id/status — Смена статуса

**Тело запроса:**
```json
{
  "action": "confirm",
  "expectedPaymentDate": "2026-05-01T00:00:00.000Z",
  "paymentComment": "Оплата по счёту"
}
```

**Допустимые действия:**
| action    | Из статуса | В статус  |
|-----------|------------|-----------|
| `confirm` | DRAFT      | CONFIRMED |
| `issue`   | CONFIRMED  | ISSUED    |
| `return`  | ISSUED     | RETURNED  |
| `cancel`  | DRAFT, CONFIRMED | CANCELLED |

---

### 4.7 POST /api/bookings/:id/confirm — Подтверждение черновика

Быстрый способ подтвердить бронь (DRAFT → CONFIRMED).

```bash
curl -X POST "https://api.example.com/api/bookings/book_xyz/confirm" \
  -H "X-API-Key: openclaw-xxx"
```

---

### 4.8 GET /api/bookings + GET /api/bookings/:id — Получение броней

**GET /api/bookings** — список броней (до 200).

**Query params:**
- `limit` (number, default: 50, max: 200)

**GET /api/bookings/:id** — детали брони (включает финансовые события, сканы).

---

### 4.9 GET /api/finance/debts — Агрегация долгов

Возвращает клиентов с `amountOutstanding > 0` по броням со статусом ≠ CANCELLED. Синхронизирует статусы оплаты перед агрегацией.

**Query params:**
- `overdueOnly=true` — только просроченные (overdueAmount > 0)
- `minAmount=10000` — фильтр по минимальной сумме долга (число)

**Пример:**
```bash
curl "https://api.example.com/api/finance/debts?overdueOnly=true" \
  -H "X-API-Key: openclaw-xxx"
```

**Ответ:**
```json
{
  "debts": [
    {
      "clientId": "cl_abc",
      "clientName": "Ромашка Продакшн",
      "totalOutstanding": "48000.00",
      "overdueAmount": "15000.00",
      "maxDaysOverdue": 12,
      "bookingsCount": 3,
      "projects": [
        {
          "bookingId": "book_001",
          "projectName": "Клип Иванов",
          "amountOutstanding": "15000.00",
          "expectedPaymentDate": "2026-04-02T00:00:00.000Z",
          "daysOverdue": 12,
          "paymentStatus": "OVERDUE",
          "bookingStatus": "RETURNED"
        }
      ]
    }
  ],
  "summary": {
    "totalClients": 5,
    "totalOutstanding": "187500.00",
    "totalOverdue": "54000.00",
    "asOf": "2026-04-14T11:00:00.000Z"
  }
}
```

**Поля:**
- `maxDaysOverdue` — максимальное количество дней просрочки среди проектов клиента
- `overdueAmount` — сумма по просроченным броням (дата платежа прошла ИЛИ `paymentStatus = OVERDUE`)
- `daysOverdue` в projects — `null` если бронь не просрочена

---

### 4.10 GET /api/finance/dashboard — Финансовые метрики

Возвращает сводку: доходы (день/неделя/месяц), ожидаемые платежи, просроченные брони.

```bash
curl "https://api.example.com/api/finance/dashboard" \
  -H "X-API-Key: openclaw-xxx"
```

---

### 4.11 POST /api/bookings/match-equipment — Подбор оборудования

Парсит список оборудования (текст/массив) и сопоставляет с каталогом по алиасам и синонимам.

**Тело запроса:**
```json
{
  "items": [
    { "name": "Arri 2kW", "quantity": 2 },
    { "name": "рефлектор 1х1", "quantity": 4 }
  ]
}
```

---

## 5. Коды ошибок

| Статус | Код                  | Описание                                              |
|--------|----------------------|-------------------------------------------------------|
| 400    | —                    | Некорректные данные запроса (подробности в `details`) |
| 401    | `UNAUTHORIZED`       | Отсутствует или неверный API-ключ                     |
| 403    | `BOT_SCOPE_FORBIDDEN`| Бот-ключ не имеет доступа к этому эндпоинту           |
| 404    | —                    | Ресурс не найден                                      |
| 409    | —                    | Конфликт (напр. недопустимый переход статуса)         |
| 422    | —                    | Семантическая ошибка (напр. неверный диапазон дат)    |
| 500    | —                    | Внутренняя ошибка сервера                             |
| 503    | `DATABASE_UNAVAILABLE`| База данных недоступна                               |

**Пример 403:**
```json
{
  "message": "Bot key does not have access to this endpoint",
  "code": "BOT_SCOPE_FORBIDDEN"
}
```

**Пример 400 (Zod):**
```json
{
  "message": "Некорректные данные запроса",
  "details": {
    "fieldErrors": { "items": ["Required"] },
    "formErrors": []
  }
}
```

---

## 6. Типовые сценарии

### Сценарий 1: Создать бронь с превью → подтвердить

```bash
# Шаг 1: dryRun — показываем превью
curl -X POST "https://api.example.com/api/bookings/draft" \
  -H "X-API-Key: openclaw-xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "dryRun": true,
    "client": { "name": "Ромашка", "phone": "+79001234567" },
    "projectName": "Клип",
    "startDate": "2026-04-20T10:00:00Z",
    "endDate": "2026-04-22T10:00:00Z",
    "items": [{ "equipmentId": "eq_abc", "quantity": 1 }]
  }'
# → { "dryRun": true, "booking": { "id": null, "status": "DRAFT_PREVIEW", "estimate": {...} } }

# Шаг 2: пользователь одобряет — создаём реальную бронь
curl -X POST "https://api.example.com/api/bookings/draft" \
  -H "X-API-Key: openclaw-xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "client": { "name": "Ромашка", "phone": "+79001234567" },
    "projectName": "Клип",
    "startDate": "2026-04-20T10:00:00Z",
    "endDate": "2026-04-22T10:00:00Z",
    "items": [{ "equipmentId": "eq_abc", "quantity": 1 }]
  }'
# → { "booking": { "id": "book_xyz", "status": "DRAFT", ... } }

# Шаг 3: подтверждаем
curl -X POST "https://api.example.com/api/bookings/book_xyz/confirm" \
  -H "X-API-Key: openclaw-xxx"
# → { "booking": { "id": "book_xyz", "status": "CONFIRMED", ... } }
```

### Сценарий 2: Кто мне должен?

```bash
# Только просроченные долги
curl "https://api.example.com/api/finance/debts?overdueOnly=true" \
  -H "X-API-Key: openclaw-xxx"
# → { "debts": [...], "summary": { "totalClients": 3, "totalOverdue": "54000.00" } }
```

### Сценарий 3: Перенести бронь на три дня позже

```bash
# 1. Получаем текущие даты
curl "https://api.example.com/api/bookings/book_xyz" \
  -H "X-API-Key: openclaw-xxx"

# 2. dryRun: проверяем новые даты
curl -X PATCH "https://api.example.com/api/bookings/book_xyz" \
  -H "X-API-Key: openclaw-xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "dryRun": true,
    "startDate": "2026-04-23T10:00:00Z",
    "endDate": "2026-04-25T10:00:00Z"
  }'

# 3. Применяем изменения
curl -X PATCH "https://api.example.com/api/bookings/book_xyz" \
  -H "X-API-Key: openclaw-xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "startDate": "2026-04-23T10:00:00Z",
    "endDate": "2026-04-25T10:00:00Z"
  }'
```

---

## 7. OpenAI Function-Calling схемы

Готовые JSON-схемы для подключения к `client.chat.completions.create({ tools: [...] })` находятся в [`docs/bot-api-tools.json`](./bot-api-tools.json).

Минимальный пример использования:

```javascript
import tools from "./bot-api-tools.json";

const response = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Кто мне должен?" }],
  tools: tools.tools,
  tool_choice: "auto",
});
```
