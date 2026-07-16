# Chat Reconciliation — design

**Дата:** 2026-05-24
**Подсистема:** Сабпроект #1 из шести (см. секцию «Декомпозиция исходного запроса»)
**Связанные спеки:** `2026-04-17-legacy-booking-import-design.md` (прошлый импорт легаси-броней — переиспользуем подходы)
**Статус:** черновик, ждёт user review

## 1. Что делаем и зачем

Восстанавливаем 11 месяцев истории заявок гафферов и смет Андрея/Виталия из чата `Svetobaza × Kirillin` (Telegram-экспорт `ChatExport_2026-05-24`) в продакшен-БД, **не перетирая** руками заведённые оплаченные брони. Параллельно обогащаем `SlangAlias`-словарь реальным жаргоном гафферов, чтобы бот (сабпроект #2) и `/bookings/new` парсер давали правдоподобные сметы.

Это разовая офлайн-операция. Артефакт — CLI-скрипт `apps/api/scripts/reconcile-chat.ts` + набор отчётов на диске. После завершения скрипт хранится в репозитории как историческая утилита (запускать повторно не предполагается).

## 2. Декомпозиция исходного запроса

Запрос пользователя касался 6 подсистем; здесь только **первая**. Остальные — отдельные спеки.

| # | Подпроект | Статус |
|---|---|---|
| **1** | **Chat Reconciliation** — анализ чата, обогащение словаря, импорт броней с защитой оплаченных | **этот док** |
| 2 | Production-бот в группе `Svetobaza × Kirillin` (live-сценарий заявка→смета→ответ) | будущая спека |
| 3 | Кабинет гаффера-как-клиента (`Client` cabinet — гаффер видит свои долги перед Svetobaza) | будущая спека |
| 4 | Расширение Gaffer-CRM (свои заказчики, выплаты бригаде — уже частично есть как `GafferUser` тенант) | независимо |
| 5 | UX-выбор «куда бот отвечает» (in-group reply vs separate channel vs DM) | внутри #2 |
| 6 | Live-обогащение словаря из новых заявок | внутри #2, частично есть |

## 3. Источник данных

### 3.1. Telegram-чат

- Путь: `/Users/sechenov/Documents/Telegram/Kateyak/ChatExport_2026-05-24/`
- Тип: `private_supergroup` («Svetobaza x Kirillin»)
- Период: 2025-06-25 → 2026-05-24 (≈ 11 месяцев)
- Сообщений: 4 455
- Активных авторов: Vitaly Sechenov (1 211), Андрей Свет Водитель (775), Петя Куб (743), Старость (600), Гена Белых (540), Вова Митрофанов Светик (148), Артёмка Иуда (128), Захар Радомский Гаффер (116), Джони Свет (113), Владимир (15)
- Прикреплённых файлов: 117 xlsx, 5 pdf, 5 jpg, 2 xls, 1 png, 1 numbers
- Конвенция имени xlsx-сметы: `DD.MM <гаффер> <итог в ₽>.xlsx` (например, `01.04 Хокаге 13925.xlsx`)

### 3.2. Прод-БД

- Путь на сервере: `/opt/light-rental-system/apps/api/prisma/prod.db` (важно: **не** `apps/api/dev.db` — тот пустой)
- `DATABASE_URL="file:./prod.db"` (относительный путь от `apps/api/`)
- Размер на 2026-05-24 ≈ 2 МБ
- 68 `Booking` всего:
  - **15 `PAID`** на 1 944 887 ₽ (`amountPaid = finalAmount`, по 1 `Payment` на каждую)
  - **50 `OVERDUE`** на 2 948 974 ₽ (живые долги, `amountPaid = 0`)
  - 3 `NOT_PAID` на 288 400 ₽
- Топ-клиенты: Петя Куб (23), Гена Белых (13), Хакаги (8), Романов Вова (7), Виталий Сеченов (5), Руслан (4), Хокаге (3)
- **Известный конфликт имён:** `Хакаги` и `Хокаге` — почти точно один гаффер, разъехались на два `Client`
- `startDate` хранится как Unix-millis в TEXT-колонке (особенность Prisma-SQLite); запросы — через `date(startDate/1000, 'unixepoch')`
- `SlangAlias`: ~14 авто-выученных строк с багом — фразы пишутся вместе с qty-маркером (`«Пена (1)»`, `«1200х (2)»`)

### 3.3. Состояние прод-инфраструктуры (вне scope, но к сведению)

PM2 на проде: `api` online (с 10 рестартами/мин), `web`, `rental-bot`, `gaffer-crm`, `overdue-recompute` — stopped. Это **не блокер** для реконсилиации (мы пишем напрямую в `prod.db`), но как только начнём пользоваться бронями через UI — потребуется отдельная задача поднять процессы.

## 4. Решения, зафиксированные в брейншторме

| # | Вопрос | Выбор |
|---|---|---|
| 1 | Стартовый подпроект | #1 Chat Reconciliation |
| 2 | Каналы | Один чат `Svetobaza × Kirillin` (хватит — все 118 смет здесь) |
| 3 | Целевая БД | **Pull-prod-local → import → push-back**: snapshot прода, работа на локальной копии, scp обратно после ок |
| 4 | Стартовое состояние | Я не знаю — проверил сам: 68 броней в проде, 15 PAID, 50 OVERDUE, ~50 чат-смет ещё не занесены |
| 5 | Стратегия матчинга | **(A) жёсткий тройной ключ** — `(date ± 2д, client_name fuzzy ≥ 0.7, amount ± 5 %)`. Плюс умный дедуп клиентов (`Damerau-Levenshtein ≤ 2` на коротких одно-токенных именах) |
| 6 | Что защищено | **(P2)** только `paymentStatus = PAID` — не трогаем. OVERDUE можно апдейтить из xlsx, но **во 2-м проходе** после твоего ревью отчёта |
| 7 | Что становится Booking | **(M2)** всё, что выглядит как заказ, включая request-only заявки → `DRAFT`. Жёсткий dedup против существующих броней по `(date, client)` |
| 8 | Статус импортируемых | **(S2)** всё как `RETURNED` (история, оборудование вернули) |
| 9 | Масштаб словаря | **(G2)** починить баг + полностью обогатить из 80 PAIR-кейсов |
| 10 | Состояние PM2 на проде | Отложено, отдельный сабпроект |

## 5. Архитектура: 5-фазный CLI

`apps/api/scripts/reconcile-chat.ts` — один файл, прямой Prisma-доступ, без HTTP. Запускается на ноуте против `backups/working-copy-*.db`. Идемпотентность по `--phase`.

```
prepare → parse → match → dry-run → apply
   │        │       │        │         │
   v        v       v        v         v
snapshot  parsed  match-   report.md  $tx → push
prod-db  -chat   plan      (главный    обратно scp
local    .jsonl  .jsonl    артефакт)
```

### Фаза 1 — `prepare`

Действия:
1. `mkdir -p backups tmp/reconcile`
2. `ssh prod "cp apps/api/prisma/prod.db /tmp/snapshot.db" && scp ... → backups/prod-snapshot-<ISO>.db` (**immutable, никогда не трогаем**)
3. `cp backups/prod-snapshot-<ISO>.db backups/working-copy-<ISO>.db` (всё пишем сюда)
4. Создать (INSERT OR IGNORE) seed-юзера `AdminUser { id: "system-reconcile", username: "system-reconcile", role: "SUPER_ADMIN", passwordHash: <random_disabled>, createdAt, updatedAt }` в working-copy — нужен для FK на `AuditEntry.userId`
5. Применить inline-миграцию к `working-copy.db`: чистим существующие `SlangAlias` от qty-маркеров `«Пена (1)»` → `«Пена»` (см. §6.5)
6. Установить `DATABASE_URL` env-var на `file:../../backups/working-copy-<ISO>.db` для последующих фаз

Read/Write: RO на прод (один `cp` локально), W на локальные backups+tmp.

### Фаза 2 — `parse`

Входы: `ChatExport_2026-05-24/result.json`, `ChatExport_2026-05-24/files/*.xlsx`, `working-copy.db` (для каталога Equipment).

Шаги:
1. Прочитать `result.json`, отфильтровать сообщения от 9 known senders (gaffers + Andrey + Vitaly) с непустым текстом или xlsx-вложением.
2. Сгруппировать по «окнам» 24 часа: каждый xlsx ищет ближайший предшествующий многострочный паст того же гаффера в окне ≤ 24h. Это даёт PAIR-кейсы.
3. xlsx без паста = XLSX-ONLY. Многострочный паст без xlsx в 24h = REQUEST-ONLY.
4. Файлы с явными ключевыми словами в имени (`инвентар`, `комплект`, `база`) — отдельный класс `NON-ESTIMATE`, в импорт не идут.
5. Каждый xlsx парсится **напрямую через npm-пакет `xlsx`** (тот же, что в `importSession.ts`) — извлекаем `[{name, qty, unitPrice, lineSum}]` из листа. Не используем `importSession`-сервис, так как он создаёт записи `ImportSession`/`ImportSessionRow` в БД как побочный эффект — для офлайн-CLI это шум. Парсинг чистый, ~30 строк кода в самом скрипте.
6. После парсинга xlsx — матчим каждую `EstimateLine.name` к `Equipment` каталогу: сначала по `importKey` exact, затем по `SlangAlias.phraseNormalized`, затем через `stringSimilarity` (тот же `string-similarity` npm пакет, что используется в `importSession.ts`) с порогом 0.7. Где не сматчилось — `equipmentId: null`, в `BookingItem.customName/customCategory/customUnitPrice` пойдут как произвольные позиции.
7. **Группировка внутри чата перед матчингом с прод:** все entries по ключу `(gaffer_name_normalized, shoot_date)`. Если на ключ найдено [PAIR + REQUEST-ONLY] → REQUEST-ONLY выбрасываем (xlsx — авторитет). [PAIR + PAIR] остаются оба (погруз + добор). [REQUEST + REQUEST] схлопываются в один.

Выходы:
- `tmp/reconcile/parsed-chat.jsonl` — по одной chat entry на строку, каждая с полями: `kind: PAIR|XLSX_ONLY|REQUEST_ONLY`, `gaffer_name`, `shoot_date_iso`, `total_rub` (для xlsx), `items: [{phrase, qty, parsed_equipment_id_or_null}]`, `source_msg_id`, `source_xlsx_path`
- `tmp/reconcile/parsed-chat-stats.md` — сводка: распределение по типам, по месяцам, по гафферу, список xlsx что не распарсились (если есть)

Read/Write: RO везде.

### Фаза 3 — `match`

Входы: `parsed-chat.jsonl`, `working-copy.db`.

Шаги:
1. **Сначала дедуп клиентов в `working-copy.db`:**
   - Используем `js-levenshtein` (новая dev-deps, ~1 KB, нет транзитивных) — для коротких имён char-level расстояние точнее, чем Sørensen-Dice из `string-similarity`.
   - Найти пары `(client_a, client_b)` с одинаковым нормализованным префиксом + Levenshtein ≤ 2 + оба ≤ 8 символов + нет фамилии (одно слово, без пробелов).
   - Авто-merge: канонический клиент = с большим `count(Booking)`, при равенстве — длиннее имя.
   - `UPDATE Booking SET clientId = canonical_id WHERE clientId = other_id; DELETE Client WHERE id = other_id` (одна `$tx` на пару).
   - Все остальные подозрительные пары (расстояние 3, или с фамилиями, или разной длины) → в `tmp/reconcile/client-merges.csv` для ручной разборки.
   - Запись `AuditEntry` на каждый авто-merge: `action: CLIENT_MERGE, entityType: "Client", entityId: canonical_id, metadata: { mergedFromId, mergedName, bookingsReassigned }`.

2. **Матчинг chat entries против БД:**
   - Для каждой entry искать кандидатов: `Booking WHERE startDate BETWEEN shoot_date ± 2 days AND client_name stringSimilarity(canonicalised, ≥ 0.7)` — используем уже подключённый `string-similarity` (Sørensen-Dice), как в `importSession.ts`.
   - PAIR/XLSX_ONLY: дополнительный фильтр `ABS(finalAmount - total_rub) / total_rub ≤ 0.05`.
   - REQUEST_ONLY: без фильтра по сумме.
   - 0 кандидатов → `action: INSERT`.
   - 1 кандидат, `paymentStatus = PAID` → `action: SKIP_PROTECTED`.
   - 1 кандидат, `paymentStatus != PAID`, kind = PAIR|XLSX_ONLY → `action: SKIP_NEEDS_UPDATE_REVIEW` (положим в `report-update-candidates.csv`).
   - 1 кандидат, kind = REQUEST_ONLY → `action: SKIP_DUP` (предполагаем что прод-бронь = реализация заявки).
   - 2+ кандидатов → `action: CONFLICT_NEEDS_REVIEW`.

3. **Сначала же — извлечение слэнг-кандидатов из PAIR-кейсов** (см. §6).

Выходы:
- `tmp/reconcile/match-plan.jsonl` — по строке на entry с `{entry_id, action, candidates: [{bookingId, score}], canonical_client_id}`
- `tmp/reconcile/client-merges.csv` — авто-merges + suggested-merges
- `tmp/reconcile/slang-candidates.csv` (см. §6)

Read/Write: W на `working-copy.db` (дедуп клиентов), W на tmp/.

### Фаза 4 — `dry-run`

Входы: `match-plan.jsonl`, `slang-candidates.csv`, `client-merges.csv`.

Выход: `tmp/reconcile/report.md` — human-readable Markdown:

```markdown
# Reconcile Report 2026-05-24T17:00

## Summary
- INSERT: 48 (40 PAIR, 6 XLSX_ONLY, 2 REQUEST_ONLY)
- SKIP_PROTECTED: 12 (matched to PAID)
- SKIP_DUP: 28 (REQUEST_ONLY collided with existing)
- SKIP_NEEDS_UPDATE_REVIEW: 22 (OVERDUE, see report-update-candidates.csv)
- CONFLICT_NEEDS_REVIEW: 8 (see conflicts table)

## Client merges (auto-applied)
| from → to | bookings reassigned |
| Хакаги → Хокаге | 8 |
| ... | ... |

## Client merges (need your review)
| candidate A | candidate B | confidence | reason |

## INSERT preview (48 rows)
| date | gaffer | total | items count | source |

## CONFLICT_NEEDS_REVIEW (8 rows)
[per-row details: chat entry vs each prod candidate]

## Slang dictionary changes
- AUTO_LEARNED additions (confidence ≥ 0.85): 187 phrases
- Existing alias bug-fixes: 14
- REVIEW pile (< 0.85): 92 phrases — see slang-review-pile.csv
```

Read/Write: RO.

### Фаза 5 — `apply`

Запуск: `tsx reconcile-chat.ts --phase apply --confirm --batch-id 2026-05-24T17:00`.

Шаги:
1. Создать `Booking + BookingItem[] + Estimate + EstimateLine[]` по `match-plan.jsonl` для всех `action: INSERT`. По одной `prisma.$transaction` на бронь. Каждая → `AuditEntry: BOOKING_RECONCILE_INSERT` в той же транзакции с `metadata: { batchId, sourceMsgId, xlsxFile, entryId }`.
2. Booking-поля: `status: RETURNED`, `clientId: canonical_client_id`, `projectName`: первая строка паста или `«<гаффер> <дата>»` если нет, `startDate/endDate`: из имени xlsx (1 день, если не указано иное в пасте), `finalAmount`: total из xlsx, `discountAmount: 0`, `paymentStatus: NOT_PAID`, `amountPaid: 0`. Для REQUEST_ONLY-DRAFT: `status: DRAFT`, `finalAmount: 0`, `Estimate` не создаём.
3. `Estimate.kind: MAIN`, `currency: "RUB"`, `shifts: 1`, `subtotal = total`, `commentSnapshot: «reconciled from chat msg <id>»`. `EstimateLine[]` — из распарсенного xlsx с `equipmentId` где сматчилось, `customName` где нет.
4. Слэнг-кандидаты с `decision = AUTO` (confidence ≥ 0.85) → `INSERT INTO SlangAlias`. На UNIQUE-конфликт `(phraseNormalized, equipmentId)` — `UPDATE usageCount += supportCount, lastUsedAt = now()`. Каждый → `AuditEntry: SLANG_RECONCILE_INSERT`.
5. Слэнг-кандидаты с `decision = REVIEW` — **не** вставляются, только в `slang-review-pile.csv`.
6. Push на прод: `pm2 stop api && cp prod.db prod-pre-reconcile-<ts>.db && cat > prod.db` ← `working-copy.db` через ssh-pipe. Затем `pm2 start api`.
7. Финальная проверка: `sqlite3 prod.db "SELECT count(*) FROM Booking, SlangAlias"` через ssh — числа совпадают с локальной working-copy.

Read/Write: W на working-copy → W на прод.

### Опциональная Фаза 6 — `apply-slang-manual`

После того как ты ручками просмотришь `slang-review-pile.csv` и сохранишь одобренное как `slang-approved-manual.csv`:

```bash
tsx reconcile-chat.ts --phase apply-slang-manual --confirm --batch-id <X>
```

Вставит одобренные с `source: MANUAL_ADMIN, confidence: 1.0` через ту же push-pipeline.

### Опциональная Фаза 7 — `apply-update-overdue`

После того как ты ручками просмотришь `report-update-candidates.csv` и помечаешь `accept|reject` напротив каждой OVERDUE-брони:

```bash
tsx reconcile-chat.ts --phase apply-update-overdue --confirm --batch-id <X>
```

Для одобренных — `UPDATE Booking SET finalAmount, discountAmount, ... ` + замена `Estimate` снэпшота. `paymentStatus`, `amountPaid`, `Payment[]` — не трогаются. `AuditEntry: BOOKING_RECONCILE_UPDATE`.

### Опциональная Фаза 8 — `rollback`

`tsx reconcile-chat.ts --phase rollback --batch-id <X>` — пройти `AuditEntry WHERE metadata.batchId = X`, для каждого `BOOKING_RECONCILE_INSERT` сделать `DELETE Booking WHERE id = entityId` (каскадно убьёт BookingItem, Estimate, EstimateLine). **`CLIENT_MERGE` не откатывается** — только из бэкапа.

## 6. Обогащение словаря (G2) — детали

### 6.1. Источник ground-truth

PAIR-кейсы: ~80 пар из чата (паст гаффера + xlsx-ответ в ≤ 24h).

### 6.2. Алгоритм

Позиционный матчинг через существующий `matchGafferRequestOrdered()` (`apps/api/src/services/equipmentMatcher.ts`):
1. Из паста взять строки кроме первой (там дата+проект); для каждой строки распарсить регуляркой `^\s*(?<phrase>[^()]+?)\s*(?:\(\s*(?<qty>\d+)\s*\))?\s*$` → `[{phrase, qty}]`.
2. Из xlsx через `importSession`-парсер взять `[{name, qty, equipmentId}]` в порядке листа.
3. Если `len(paste_lines) == len(xlsx_lines)` И `qty[i]` совпадают — высокая уверенность позиционного совпадения. Иначе — для каждой пары `(paste_phrase, xlsx_equipment)` проверять отдельно через fuzzy.
4. Для каждой доверенной пары `(phrase, equipmentId)` — кандидат с базовой confidence 0.5.

### 6.3. Confidence-формула

```
confidence = 0.50
  + 0.10 * log(usage_count)               # сколько PAIR-кейсов поддержали
  + 0.20 if same_equipment_in_≥_80%_of_phrase_appearances
  + 0.20 if phrase substring-matches Equipment.name (normalized)
  + 0.10 if SEED alias on same equipmentId with similar phrase
clamp(confidence, 0.0, 1.0)
auto_threshold = 0.85
```

### 6.4. Маршруты

- `confidence ≥ 0.85` → `decision: AUTO` → `INSERT INTO SlangAlias` с source `AUTO_LEARNED`, confidence-as-computed.
- `confidence < 0.85` → `decision: REVIEW` → только в `slang-review-pile.csv`, не вставляется. После твоей разборки — фаза 6 (`apply-slang-manual`).
- При UNIQUE-конфликте `(phraseNormalized, equipmentId)` — UPDATE существующей с `usageCount += supportCount`, `lastUsedAt = now()`, `confidence = MAX(old, new)`.

### 6.5. Фикс существующего бага «(N)»

В prepare-фазе:
1. Селект всех `SlangAlias WHERE phraseOriginal REGEXP '\(\d+\)\s*$'` (или `LIKE '%(%)%'` + проверка в коде, так как в SQLite нет REGEXP по умолчанию).
2. Для каждой — извлечь чистую фразу, перевычислить normalized.
3. UPSERT в `SlangAlias` чистой строкой. На UNIQUE-конфликт — merge: `usageCount = a.usage + b.usage, confidence = MAX, lastUsedAt = MAX`. Старая (грязная) — `DELETE`.
4. Логировать каждое — в `tmp/reconcile/slang-bugfix.log`.

Это ~14 строк, делается до начала остальной работы, риск нулевой.

### 6.6. Что не делаем в обогащении

- Не парсим 4255 не-PAIR сообщений (это G3 — отвергнут).
- Не расщепляем строки типа `Систенды/минибум/мегабум` на 3 фразы — это слэш-полисмыслы, идут в REVIEW целиком.
- Не трогаем `Client.name` как алиасы.
- Не строим модель `SlangCandidate` (схема её определила enum, но таблицы нет — scope creep).

## 7. Безопасность

### 7.1. Двойной снапшот

```
prod:apps/api/prisma/prod.db
  └── scp ──► backups/prod-snapshot-<ts>.db   ← immutable, никогда не трогаем
                └── cp ──► backups/working-copy-<ts>.db   ← все правки
                              └── (после ок) scp обратно на прод
```

Откат до push: `cp backups/prod-snapshot-<ts>.db backups/working-copy-<ts>.db` и сначала.

### 7.2. Push на прод

```bash
ssh prod "pm2 stop api"
ssh prod "cp apps/api/prisma/prod.db apps/api/prisma/prod-pre-reconcile-<ts>.db"
ssh prod "cat > apps/api/prisma/prod.db" < backups/working-copy-<ts>.db
ssh prod "pm2 start api"
# проверка row-counts
ssh prod "sqlite3 apps/api/prisma/prod.db 'SELECT (SELECT count(*) FROM Booking), (SELECT count(*) FROM SlangAlias)'"
```

Откат на прод-стороне: `ssh prod "cp prod-pre-reconcile-<ts>.db prod.db && pm2 restart api"`.

### 7.3. AuditEntry (для встроенного `/admin/audit`)

Новые `action` значения:

| Action | entityType | metadata |
|---|---|---|
| `BOOKING_RECONCILE_INSERT` | `Booking` | `{ batchId, sourceMsgId, xlsxFile, entryId }` |
| `CLIENT_MERGE` | `Client` | `{ mergedFromId, mergedName, bookingsReassigned }` |
| `SLANG_RECONCILE_INSERT` | `SlangAlias` | `{ confidence, supportCount, sourceMsgIds }` |
| `BOOKING_RECONCILE_UPDATE` (фаза 7) | `Booking` | `{ batchId, fields: { ...before/after } }` |

`userId` указывает на **специально созданного seed-юзера** `AdminUser { id: "system-reconcile", username: "system-reconcile", role: "SUPER_ADMIN", passwordHash: random_disabled_value }` — потому что `AuditEntry.userId` имеет FK на `AdminUser.id` (`@relation`). Создание этого юзера — первое действие фазы prepare, через `INSERT OR IGNORE`. Удалить его потом будет нельзя (FK Restrict от историй аудита) — это by design, он остаётся как маркер «эти записи сгенерированы реконсилиацией». Логин под ним невозможен (passwordHash случайный).

Расширение `AuditEntityType` union в `services/audit.ts`: добавить `"SlangAlias"`. `"Client"` уже есть (используется для `CLIENT_MERGE`).

## 8. Артефакты на диске

Всё в `tmp/reconcile/` (gitignored):

| Файл | Фаза | Назначение |
|---|---|---|
| `parsed-chat.jsonl` | parse | Все 118 chat entries в структурированном виде |
| `parsed-chat-stats.md` | parse | Сводка для сверки с реальностью |
| `match-plan.jsonl` | match | План действий по каждой entry |
| `client-merges.csv` | match | Авто + suggested merges клиентов |
| `slang-candidates.csv` | match | Все кандидаты слэнга + decision |
| `slang-bugfix.log` | prepare | Что починили в существующих SlangAlias |
| `report.md` | dry-run | **Главный артефакт для глаз** |
| `slang-review-pile.csv` | apply | < 0.85 confidence, ждут ручной разборки |
| `report-update-candidates.csv` | apply | OVERDUE-брони для опц. 2-го прохода |
| `audit-trail.jsonl` | apply | Для отката: bookingId/clientId + AuditEntry.id |

## 9. Out of scope

- **PM2-recovery** (web/bot/gaffer-crm/overdue-recompute stopped) — отдельная задача, делается после либо параллельно.
- **Импорт `Payment`** — никакие новые платежи не вводятся, это твоя ручная зона.
- **Telegram-кабинет гаффера** (#3) — отдельная спека.
- **Live-бот в чате** (#2) — отдельная спека.
- **Создание `GafferUser` записей** для гафферов в новой Gaffer-CRM — отдельная спека, не путать с `Client` в legacy-системе.
- **Изменения в Prisma-схеме** — не делаем, scope = только данные.
- **Использование `prisma migrate`** — не используем, scope = только данные.
- **Использование HTTP-роутов** — не используем, прямой Prisma в CLI.

## 10. Открытые вопросы / риски

| Риск | Митигация |
|---|---|
| Запросы к live-проду через `ssh` падают по сети во время push | Перед `cat > prod.db` обязательно `pm2 stop api`. Если pipe прервался — `cp prod-pre-reconcile-<ts>.db prod.db` |
| Дедуп клиентов авто-сольёт двух **реально разных** людей с похожими именами | Эвристика «≤ 8 символов и одно слово» специально для этого — двух **полных** имён с фамилией не сольёт. Те, что попадают под критерий (Хакаги/Хокаге) — заведомо chat-shorthands |
| xlsx-парсер `importSession` не справится с нестандартным форматом ранних xlsx (есть `куб 27,02 9200.xlsx`) | Для не распарсенных файлов — XLSX-ONLY становится REQUEST-ONLY-эквивалент: имя файла → дата+гаффер+total, items пустые, статус DRAFT |
| OVERDUE-обновление во фазе 7 трогает не ту бронь (false-positive match) | Между apply и apply-update-overdue ты глазами проходишь `report-update-candidates.csv` |
| Live-prod гафферы между моментом snapshot и push добавят что-то новое | Окно очень короткое (минуты). Проверка перед push: row-count `Booking` на проде = тот, который был на snapshot. Если разъехался — abort, повторный snapshot |
| Скрипт `reconcile-chat.ts` оставит после себя tmp-файлы в репозитории | На фазе prepare добавляем `tmp/` и `backups/` в корневой `.gitignore` (сейчас их там нет — проверено). Отчёт `report.md` сохраняем рядом с этим спеком как `docs/superpowers/reports/2026-05-24-chat-reconciliation-report.md` для истории |

## 11. Acceptance criteria

После завершения всех фаз:

- [ ] `backups/prod-snapshot-<ts>.db` существует, нетронут, его row-count = тому что был на проде на момент start
- [ ] `Booking` count на проде = `<snapshot-count> + N`, где N = число `action:INSERT` из `report.md`
- [ ] 0 PAID-броней изменено (`amountPaid`, `finalAmount`, `paymentStatus`)
- [ ] Все авто-merge клиентов имеют `AuditEntry: CLIENT_MERGE`
- [ ] Все новые брони имеют `AuditEntry: BOOKING_RECONCILE_INSERT` с тем же `batchId`
- [ ] `SlangAlias` не содержит ни одной строки с `phraseOriginal LIKE '%(%)%'` (qty-маркер «(N)»)
- [ ] `AdminUser id=system-reconcile` существует в проде, `passwordHash` не угадывается, через UI залогиниться невозможно
- [ ] Все стопнутые pre-prod процессы (`pm2 list`) — в том же состоянии, что и до запуска (мы трогаем только `api`)
- [ ] Сайт `svetobazarent.ru/bookings` открывается, видит новые брони

## 12. Связанные документы

- `CLAUDE.md` §«Sprint 2: Navigation, Design Canon & Audit UI», §«AuditEntry» — формат аудит-записей
- `apps/api/src/services/equipmentMatcher.ts` — существующий ordered-matcher для PAIR-кейсов
- `apps/api/src/services/importSession.ts` — существующий xlsx-парсер
- `docs/superpowers/specs/2026-04-17-legacy-booking-import-design.md` — прошлая инкарнация импорта (предшественник)

---

**Статус:** ждёт user review. После approve → `/writing-plans` для генерации детального плана реализации.
