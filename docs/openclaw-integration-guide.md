# OpenClaw Bot — Руководство по интеграции с Light Rental System API

> **Для кого этот документ:** для разработчика (или AI-ассистента вроде Claude Code) на стороне бота OpenClaw. Прочитав этот файл целиком, вы должны понимать — что за система на той стороне, что от бота требуется, какие есть ограничения, и как именно писать код, который с этим API общается.
>
> **Обычный язык + технический.** Каждый раздел сначала объясняет *что происходит и зачем*, потом даёт *точные технические детали*.

---

## 0. TL;DR для нетерпеливых

1. Есть REST API на Express (Node.js/TypeScript), оно живёт на VPS. Адрес вида `https://<host>/api`.
2. Бот = отдельное приложение (OpenClaw). Он ходит в API по HTTPS с заголовком `X-API-Key: openclaw-<32hex>`.
3. Ключи с префиксом `openclaw-` имеют **ограниченный scope** — whitelist из 16 роутов. Всё остальное → 403. DELETE заблокирован глобально.
4. Бот умеет: искать оборудование, проверять доступность, **создавать и редактировать брони** (но не удалять), видеть **кто должен и сколько**.
5. Для LLM-части (function-calling) уже подготовлены 12 готовых JSON-схем — лежат в `docs/bot-api-tools.json`. Их просто `import`-ят в Chat Completions как `tools`.
6. Деньги везде — **строки**, не числа (`"1234.56"`). Это Decimal, не float.
7. Перед созданием/редактированием брони — делать вызов с `"dryRun": true` и показывать пользователю превью. После подтверждения — повторить без `dryRun`.
8. Основной контракт эндпоинтов лежит в `docs/bot-api.md` (короткий справочник). Этот файл — объяснение *как этим пользоваться*.

---

## 1. Контекст: что это за система

### 1.1 Своими словами

Light Rental System — это внутренняя админка небольшого рентал-хаба, который сдаёт в аренду **киносъёмочный свет** (Arri, HMI, Kinoflo, рефлекторы, стойки, кабели и т.д.). Клиенты — продакшены и гафферы, которые делают рекламу, клипы, кино.

Внутри системы три приложения:
- **API** (Express + Prisma + SQLite) — сердце. Хранит каталог оборудования, брони, клиентов, платежи.
- **Web-админка** (Next.js) — где менеджер кликает и делает брони вручную.
- **Свой Telegram-бот** (Telegraf) — уже есть, но он ходит напрямую в ту же БД через API. Он про другой сценарий (подбор света по описанию фильма).

**Ваш OpenClaw — это четвёртое приложение.** Отдельный Telegram-бот на OpenAI (GPT-4o + function-calling). Он должен через этот же REST API уметь:
- Быстро глянуть "кто мне должен и сколько"
- Создать новую бронь по описанию от клиента
- Подвинуть даты брони, если клиент попросил
- Подтвердить бронь
- Проверить свободно ли оборудование

**Чего OpenClaw делать НЕ должен:**
- Удалять брони (запрещено на уровне API)
- Работать с финансовыми операциями напрямую (платежи создаёт менеджер руками)
- Лезть в склад/штрихкоды/сканы

### 1.2 Технический стек той стороны

| Слой | Технология |
|------|------------|
| Сервер | Express 4 + TypeScript (ES2022, CommonJS) |
| ORM | Prisma 6 + SQLite |
| Валидация | Zod |
| Деньги | Decimal.js (сериализуются строкой) |
| Auth | `X-API-Key` header, middleware `apiKeyAuth` |
| Rate limit | 100 req/min per IP |
| Deploy | PM2 на Ubuntu VPS, GitHub Actions SSH |

**Важно для вас:** сервер стоит за обычным HTTPS. Никаких хитрых прокси, mTLS, OAuth. Просто REST + API-key. Это удобно, но значит — **ключ надо беречь**.

### 1.3 Язык

Вся система — **русскоязычная**. Названия оборудования, проектов, клиентов, статусы (в полях типа `nameSnapshot`, `projectName`) — на русском. Коды статусов (`DRAFT`, `CONFIRMED`, `ISSUED`) — на английском, это перечисления.

Бот общается с пользователем тоже по-русски. Это ваше дело, но учтите — вся контекстная инфа для LLM будет на русском.

---

## 2. Что именно бот должен уметь

Это функциональный минимум, под который разработан API. Вы можете расширять, но это — baseline.

| Сценарий пользователя в Telegram | Какие вызовы API нужны |
|----------------------------------|------------------------|
| "Что у меня с доступностью 2кВт на следующие выходные?" | `list_equipment` → `check_availability` |
| "Сделай бронь для Ромашки на 20–22 апреля, Arri 2кВт × 2" | `list_equipment` → `draft(dryRun)` → показать → `draft()` |
| "Подтверди эту бронь" | `confirm_booking` или `update_booking_status(action=confirm)` |
| "Перенеси бронь `book_xyz` на 3 дня вперёд" | `get_booking` → `update_booking(dryRun)` → показать → `update_booking()` |
| "Кто мне должен денег?" | `list_debts(overdueOnly=false)` |
| "Кто просрочил оплату?" | `list_debts(overdueOnly=true)` |
| "Сколько я заработал за месяц?" | `finance_dashboard` |
| "У клиента «Мосфильм» какие брони?" | `list_bookings` + фильтрация на стороне бота |

---

## 3. Аутентификация и setup

### 3.1 Своими словами

Владелец API даст вам один ключ вида `openclaw-<32 символа>`. Этот ключ надо вставить **в заголовок каждого запроса**:

```
X-API-Key: openclaw-a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4
```

Ключ лежит у бота в `.env`, никогда не отправляется пользователю, никогда не пишется в логи в открытом виде.

### 3.2 Технические детали

- Заголовок: `X-API-Key` (именно этот регистр; экспресс нормализует, но для явности — как указано).
- Middleware на стороне API: `apps/api/src/middleware/apiKeyAuth.ts`. Два режима: `AUTH_MODE=warn` (логирует, но пропускает) и `enforce` (возвращает 401).
- Exempt: только `/health`.
- При 401 — ответ:
  ```json
  { "message": "Unauthorized", "code": "UNAUTHORIZED" }
  ```
- Если ключ валидный, но роут не в whitelist — **403**, не 401:
  ```json
  { "message": "Bot key does not have access to this endpoint", "code": "BOT_SCOPE_FORBIDDEN" }
  ```

### 3.3 Где хранить ключ в OpenClaw

```env
# .env на стороне бота
LIGHT_RENTAL_API_URL=https://api.your-domain.ru/api
LIGHT_RENTAL_API_KEY=openclaw-a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4
```

В коде:

```ts
// api-client.ts
const API_URL = process.env.LIGHT_RENTAL_API_URL!;
const API_KEY = process.env.LIGHT_RENTAL_API_KEY!;

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "X-API-Key": API_KEY,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}
```

---

## 4. Scope — что разрешено, что нет

### 4.1 Своими словами

Сервер смотрит: "ключ начинается с `openclaw-`? Значит это бот. Бот может трогать только то, что в белом списке". Всё остальное — 403 без исключений. Удаление (`DELETE`) заблокировано тотально, даже на whitelist-роутах.

Это не каприз. Это защита на случай, если LLM "выдумает" несуществующий вызов или попытается сделать что-то деструктивное.

### 4.2 Точный whitelist

Whitelist живёт в `apps/api/src/middleware/botScopeGuard.ts`. На момент написания — **16 роутов**:

| # | Метод | Путь | Назначение |
|---|-------|------|------------|
| 1 | GET | `/api/equipment` | Каталог |
| 2 | GET | `/api/equipment/:id` | Карточка |
| 3 | GET | `/api/availability` | Доступность на период |
| 4 | GET | `/api/bookings` | Список |
| 5 | GET | `/api/bookings/:id` | Детали |
| 6 | POST | `/api/bookings/draft` | Создать черновик |
| 7 | POST | `/api/bookings/quote` | Предварительная смета |
| 8 | POST | `/api/bookings/match-equipment` | Подбор по названиям |
| 9 | POST | `/api/bookings/parse-gaffer-review` | Парсинг текста от гаффера |
| 10 | PATCH | `/api/bookings/:id` | Редактирование |
| 11 | POST | `/api/bookings/:id/status` | Смена статуса |
| 12 | POST | `/api/bookings/:id/confirm` | Быстрое подтверждение |
| 13 | GET | `/api/finance/debts` | Долги по клиентам |
| 14 | GET | `/api/finance/dashboard` | Метрики |
| 15 | GET | `/api/receivables` | Плоская дебиторка |
| 16 | GET | `/api/payments` | Список платежей |

> Если в будущем добавят новый роут — реальный актуальный whitelist смотреть в `apps/api/src/middleware/botScopeGuard.ts`.

### 4.3 Что нельзя — и как бот должен на это реагировать

Бот **не должен сам пытаться**:
- `DELETE /api/bookings/:id` — архитектурно запрещено
- `POST /api/payments` — нет в whitelist
- `POST /api/expenses` — нет в whitelist
- Всё что про склад (`/api/warehouse/*`, `/api/equipment-units/*`, `/api/scan-sessions/*`) — нет в whitelist

Если пользователь в Telegram просит "удали бронь" — бот должен предложить **отменить** (`update_booking_status(action=cancel)`), это переводит бронь в `CANCELLED`, но запись остаётся для истории.

---

## 5. Как OpenAI function-calling цепляется к этому API

### 5.1 Идея простыми словами

У нас есть 12 готовых JSON-схем, описывающих, какие есть "функции" (эндпоинты) и какие у них параметры. Эти схемы передаются в GPT-4o при вызове модели. Модель сама решает, какую функцию позвать и с какими аргументами. Бот получает её решение, делает реальный HTTP-запрос, возвращает результат модели — и так по кругу, пока модель не напишет финальный ответ пользователю.

Это классический паттерн "tool-use" / "function-calling".

### 5.2 Где лежат схемы

`docs/bot-api-tools.json` в этом репозитории. 12 функций:

1. `list_equipment`
2. `get_equipment`
3. `check_availability`
4. `list_bookings`
5. `get_booking`
6. `create_booking_draft`
7. `quote_booking`
8. `match_equipment`
9. `update_booking`
10. `update_booking_status`
11. `confirm_booking`
12. `list_debts`

Скопируйте файл к себе в репозиторий бота (или фетчите его из раздающего хоста — как удобнее).

### 5.3 Минимальный пример loop

```ts
import OpenAI from "openai";
import tools from "./bot-api-tools.json"; // { tools: [...] }
import { api } from "./api-client";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Маппинг имя функции → реальный HTTP-вызов
const dispatch: Record<string, (args: any) => Promise<any>> = {
  list_equipment: (args) =>
    api(`/equipment?${new URLSearchParams(args).toString()}`),
  check_availability: (args) =>
    api(`/availability?${new URLSearchParams(args).toString()}`),
  create_booking_draft: (args) =>
    api(`/bookings/draft`, { method: "POST", body: JSON.stringify(args) }),
  update_booking: (args) => {
    const { id, ...body } = args;
    return api(`/bookings/${id}`, { method: "PATCH", body: JSON.stringify(body) });
  },
  update_booking_status: (args) => {
    const { id, ...body } = args;
    return api(`/bookings/${id}/status`, { method: "POST", body: JSON.stringify(body) });
  },
  confirm_booking: (args) =>
    api(`/bookings/${args.id}/confirm`, { method: "POST" }),
  list_debts: (args) =>
    api(`/finance/debts?${new URLSearchParams(args).toString()}`),
  // ... остальные 5
};

async function chat(userMessage: string) {
  const messages: any[] = [
    { role: "system", content: "Ты помощник рентал-хауса ..." },
    { role: "user", content: userMessage },
  ];

  while (true) {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages,
      tools: tools.tools,
      tool_choice: "auto",
    });
    const msg = response.choices[0].message;
    messages.push(msg);

    if (!msg.tool_calls?.length) return msg.content; // финальный ответ

    for (const call of msg.tool_calls) {
      const fn = dispatch[call.function.name];
      const args = JSON.parse(call.function.arguments);
      let result: any;
      try {
        result = await fn(args);
      } catch (e: any) {
        result = { error: e.message, code: e.code };
      }
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }
}
```

### 5.4 Ключевое для промпта системы (system prompt)

Обязательно впишите эти пункты в system prompt бота — иначе LLM будет творить:

1. **"Перед созданием/изменением брони всегда сначала вызывай с `dryRun: true`, показывай пользователю превью сметы, и только после явного подтверждения — делай реальный вызов."**
2. **"Для денежных значений — это строки типа `'1234.56'`, не числа. Не округляй сам, передавай пользователю как есть."**
3. **"Нельзя удалять брони. Если пользователь просит удалить — предложи отменить (`update_booking_status` с `action: 'cancel'`)."**
4. **"Даты — в формате ISO 8601 с UTC-смещением. Если пользователь говорит `"завтра в 10 утра"`, сначала спроси часовой пояс или используй московское время (UTC+3) по умолчанию."**
5. **"Если API вернул ошибку — не выдумывай, что всё получилось. Передай суть ошибки пользователю и предложи что делать."**

---

## 6. Формат данных — чему надо внимание уделить

### 6.1 Деньги — строки, не числа

```json
{ "totalAfterDiscount": "7200.00" }  // ← строка!
```

**Почему:** `Decimal.js` на сервере не приводится к JS number, чтобы не было потери точности. Если ваш код сделает `JSON.parse` и попытается `+` с числом — получите `"7200.001500.00"` (конкатенация строк).

**Как правильно:**

```ts
// для арифметики — явно в число
const total = Number(booking.totalAfterDiscount);

// для показа пользователю — оставить строку
await bot.reply(ctx, `Итого: ${booking.totalAfterDiscount} ₽`);
```

### 6.2 Даты — ISO 8601

- Сервер принимает и `"2026-04-20T10:00:00Z"`, и `"2026-04-20"` (без времени — будет 00:00 UTC).
- Возвращает всегда с миллисекундами: `"2026-04-20T10:00:00.000Z"`.
- Часовой пояс сервера — **UTC** в данных, фронтенд рендерит в локальном. Для бота лучше всегда слать `Z` (UTC).

**Гaucho-случай:** пользователь говорит "20 апреля". Это 20 апреля в какой TZ? Если принять московское (UTC+3), надо отправить `"2026-04-19T21:00:00.000Z"`. Лучше явно конвертировать через `date-fns-tz` или аналог, а не на глаз.

### 6.3 Статусы брони

```
DRAFT → CONFIRMED → ISSUED → RETURNED
   ↓         ↓
CANCELLED  CANCELLED
```

Сам бот может двигать:
- `DRAFT → CONFIRMED` (`confirm` или `confirm_booking`)
- `DRAFT/CONFIRMED → CANCELLED` (`cancel`)

Остальные переходы (`issue`, `return`) тоже есть в API, но обычно это делает менеджер со штрихкод-сканером на складе — боту по делу туда лезть не надо.

### 6.4 Оборудование: `equipmentId` — это что

Это UUID-подобная строка (cuid на самом деле). Бот её получает из `list_equipment` и передаёт обратно в `items[].equipmentId` при создании брони. Никогда не собирать ID вручную.

---

## 7. Обработка ошибок

### 7.1 Структура ответа при ошибке

```json
{ "message": "человеко-читаемое сообщение", "code": "MACHINE_CODE", "details": {...} }
```

`code` есть не всегда, `details` — опционально (обычно только при Zod 400).

### 7.2 Таблица кодов

| HTTP | code | Что делает бот |
|------|------|----------------|
| 400 | — | Zod-валидация. Показать `details.fieldErrors`, попросить уточнить у пользователя. |
| 401 | `UNAUTHORIZED` | **Не показывать юзеру.** Логировать как critical, уведомить админа (ключ не работает). |
| 403 | `BOT_SCOPE_FORBIDDEN` | Модель пыталась вызвать роут вне whitelist. Перепромптить модель, уточнив scope. |
| 404 | — | Бронь/оборудование не найдено. Сообщить юзеру. |
| 409 | — | Конфликт статусов (например, `action: "issue"` для DRAFT). Сообщить. |
| 422 | — | Семантика: даты вверх ногами, нулевой quantity. Сообщить. |
| 429 | — | Rate limit (100/min). Бэкофф 2s и повтор. |
| 500 | — | Падение сервера. Сообщить админу, юзеру — "попробуйте позже". |
| 503 | `DATABASE_UNAVAILABLE` | Сервер жив, БД мертва. То же что 500. |

### 7.3 Класс ошибки

```ts
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: { message?: string; code?: string; details?: any },
  ) {
    super(body.message ?? `HTTP ${status}`);
  }
}
```

Передавайте `body` в контекст LLM — модель лучше поймёт, что случилось, если видит `code`, а не просто текст.

---

## 8. Сценарии end-to-end

### 8.1 Создание брони с превью (самый частый)

```
Юзер: "Забронируй Arri 2кВт в количестве 2 штук на 20-22 апреля для Ромашки"

Бот (модель вызывает):
  1. list_equipment({ search: "Arri 2" })
     → [{ id: "eq_abc", name: "Arri Fresnel 2kW", ... }]

  2. create_booking_draft({
       dryRun: true,
       client: { name: "Ромашка" },
       projectName: "—",
       startDate: "2026-04-20T00:00:00Z",
       endDate: "2026-04-22T00:00:00Z",
       items: [{ equipmentId: "eq_abc", quantity: 2 }]
     })
     → { dryRun: true, booking: { id: null, status: "DRAFT_PREVIEW", estimate: { totalAfterDiscount: "12000.00", ... } } }

Бот пишет юзеру: "Смета 12 000 ₽ за 2 смены. Подтверждаете?"

Юзер: "Да"

Бот (модель вызывает):
  3. create_booking_draft({...та же payload без dryRun})
     → { booking: { id: "book_real_xyz", status: "DRAFT", ... } }

Бот: "Черновик #book_real_xyz создан. Подтвердить сразу?"

Юзер: "Да"

Бот:
  4. confirm_booking({ id: "book_real_xyz" })
     → { booking: { id: "book_real_xyz", status: "CONFIRMED" } }

Бот: "Готово, бронь подтверждена"
```

### 8.2 "Кто мне должен?"

```
Юзер: "У меня есть должники?"

Бот:
  list_debts({ overdueOnly: false })
  → {
      debts: [
        { clientName: "Ромашка", totalOutstanding: "48000.00", overdueAmount: "15000.00", maxDaysOverdue: 12, bookingsCount: 3, projects: [...] },
        ...
      ],
      summary: { totalClients: 5, totalOutstanding: "187500.00", totalOverdue: "54000.00" }
    }

Бот: "5 клиентов должны всего 187 500 ₽, из них просрочено 54 000 ₽. Топ-3:
  1. Ромашка — 48 000 ₽ (просрочено 15 000 ₽, max 12 дней)
  2. ...
  "
```

### 8.3 Перенести бронь на 3 дня

```
Юзер: "Перенеси book_xyz на 3 дня позже"

Бот:
  1. get_booking({ id: "book_xyz" })
     → { booking: { startDate: "2026-04-20T10:00:00.000Z", endDate: "2026-04-22T10:00:00.000Z", ... } }

  2. Модель считает: +3 дня → 23 / 25 апреля

  3. update_booking({
       id: "book_xyz",
       dryRun: true,
       startDate: "2026-04-23T10:00:00Z",
       endDate: "2026-04-25T10:00:00Z"
     })
     → { dryRun: true, booking: { ..., estimate: {...} } }

  4. (После подтверждения) update_booking({...тот же payload без dryRun})
```

---

## 9. Тестирование со стороны бота

### 9.1 Локальный запуск этого API для интеграционных тестов

У владельца API или в dev:
```bash
# в корне light-rental-system
npm run dev:no-bot     # поднимет API на :4000 и Web на :3000 без встроенного Telegram-бота
# добавить в apps/api/.env: API_KEYS=openclaw-testkey1234567890abcdef1234567890ab AUTH_MODE=enforce
```

Потом бот в своих тестах:
```env
LIGHT_RENTAL_API_URL=http://localhost:4000/api
LIGHT_RENTAL_API_KEY=openclaw-testkey1234567890abcdef1234567890ab
```

### 9.2 Что обязательно покрыть

- Happy path: draft → dryRun → draft → confirm
- 403: бот случайно сгенерировал `DELETE /api/bookings/:id` (модель может попробовать) — проверьте что ваш dispatch корректно пробрасывает ошибку в LLM-цикл
- 401: невалидный ключ → алертинг
- 409: попытка `action: issue` для DRAFT-брони → понятное сообщение юзеру
- Decimal: не складывать строки как числа
- Retry при 429

### 9.3 Мок-сервер для unit-тестов

Простой `express` в `tests/mocks/` или `msw` для node — оба работают. API простое, целиком повторять не надо, мокайте только те роуты, которые ваш тест дёргает.

---

## 10. Частые ошибки и как их не делать

| Ошибка | Почему плохо | Правильно |
|--------|--------------|-----------|
| Парсить `totalAfterDiscount` как `parseFloat` и складывать | Потеря копеек | Либо как строку для показа, либо через `Decimal.js`/`big.js` |
| Пропустить `dryRun` и сразу создать бронь | Юзер не видел сметы, сюрприз в счёте | Всегда двухшаговый flow |
| Хранить `openclaw-*` ключ в коде | Утечёт в git | `.env` + gitignore |
| Ловить 403 и не логировать | Молчаливо деградирует — пользователь думает что бот сломан | Log + сообщение + alert |
| Отправлять даты как `"20.04.2026"` | Сервер не распарсит | ISO 8601 всегда |
| Переиспользовать ответ `draft(dryRun)` как реальную бронь | Там `id: null`, база не знает про эту запись | После подтверждения — повторный вызов без dryRun |
| Забыть про `Content-Type: application/json` в POST/PATCH | Express парсер не сработает → 400 | Добавить в дефолтные заголовки api-клиента |
| Делать concurrent запросы без учёта rate-limit | 429 | Очередь или семафор (max 2–3 параллельно) |
| Трогать `/api/warehouse/*` "потому что есть в спеке" | 403 | Не в whitelist → не трогать |

---

## 11. Что мы явно НЕ покрываем (и не надо пытаться)

- Личные кабинеты клиентов — нет такого API
- Загрузка фото оборудования — есть в системе, но не в scope бота
- Анализ кадра через Gemini — есть, но это отдельный пайплайн встроенного бота, не ваша история
- Работа со штрихкодами / сканы на складе — отдельный flow с PIN-auth, не для OpenClaw
- Редактирование каталога оборудования — только через веб-админку
- Платежи и расходы — менеджер вручную

Если пользователь в Telegram просит что-то из этого — бот должен **честно сказать** "это пока не умею, зайди в веб-админку" (и не выдумывать).

---

## 12. Чек-лист перед первым запуском OpenClaw в продакшн

- [ ] У вас есть ключ `openclaw-<32hex>` от владельца API
- [ ] Ключ в `.env`, `.env` в `.gitignore`
- [ ] `LIGHT_RENTAL_API_URL` указывает на HTTPS-адрес (не localhost, не HTTP)
- [ ] `docs/bot-api-tools.json` скопирован в репозиторий бота (или загружается актуальной версией)
- [ ] В system prompt добавлены 5 правил из раздела 5.4
- [ ] Реализован loop tool-use с пробросом ошибок обратно в LLM
- [ ] Класс `ApiError` ловит body + code
- [ ] 401 → алерт админу (Sentry/Telegram-канал)
- [ ] 429 → retry с бэкоффом
- [ ] Деньги нигде не приводятся к `Number` для арифметики
- [ ] Даты отправляются как ISO 8601 с `Z`
- [ ] Покрыт E2E-тест: создание брони с dryRun → реальный create → confirm
- [ ] Владелец API выдал тестовый ключ для staging (если есть staging)
- [ ] В логах ключ маскируется (`openclaw-****...cdef`)

---

## 13. Справочные ссылки (в этом репозитории)

- [`docs/bot-api.md`](./bot-api.md) — короткий контракт API на русском, с curl-примерами
- [`docs/bot-api-tools.json`](./bot-api-tools.json) — 12 OpenAI function-calling схем
- `apps/api/src/middleware/botScopeGuard.ts` — whitelist (смотреть тут если сомневаетесь какой роут разрешён)
- `apps/api/src/routes/bookings.ts` — реализация POST /draft, PATCH /:id, dryRun-логика
- `apps/api/src/services/finance.ts` — реализация `computeDebts()`
- `apps/api/prisma/schema.prisma` — модель данных (Booking, Client, Equipment, Payment)

---

## 14. Когда что-то идёт не так

| Симптом | Первым делом проверить |
|---------|------------------------|
| 401 везде | Ключ протух? Опечатка в заголовке (`X-Api-Key` ≠ `X-API-Key` — экспресс нормализует, но вдруг)? |
| 403 на всех роутах | Ключ не начинается с `openclaw-`? Кто-то поменял whitelist? |
| 404 на `/api/finance/debts` | Владелец API не обновил до версии с bot-api спринтом (≥ commit `bd36a25` в main) |
| Модель уходит в цикл tool-use | В system prompt нет инструкции "если видишь ошибку — объясни юзеру, не повторяй" |
| Decimal показывается как `"7200.00"` вместо `7 200 ₽` | Формат для юзера делайте в боте, не ждите от API |
| 429 после активного использования | Больше 100 запросов в минуту — уменьшите concurrent или кешируйте `list_equipment` |

---

**Версия документа:** 1.0 (2026-04-14), под API commit `bd36a25` в `main` репозитория light-rental-system.

Если API изменится — обновите этот файл или попросите владельца сгенерировать новый.
