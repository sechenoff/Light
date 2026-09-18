#!/usr/bin/env bash
# Пробный `prisma db push` новой схемы на КОПИИ боевой базы — до того, как деплой
# что-либо тронет на проде (запускается из deploy-rsync.yml до rsync).
#
# Зачем. Настоящий `db push` в деплое тоже отказывается удалять непустые таблицы
# и колонки и применять то, что не ложится на заполненную базу, но срабатывает
# ПОСЛЕ rsync: исходники уже заменены, web остановлен, и отказ оставил бы прод
# наполовину обновлённым. Здесь та же проверка идёт раньше и на живых данных
# (копия базы). Сторож схемы в PR (scripts/schema-guard.mjs) ловит большую часть
# того же ещё раньше — по тексту схемы.
#
# Останавливает деплой ТОЛЬКО явный отказ Prisma (потеря данных или изменение,
# которое нельзя выполнить). Всё остальное — нет CLI после прерванного npm ci,
# сбой движка, расхождение версий Prisma — предупреждение и пропуск: иначе
# сломанный прод нельзя было бы починить следующим деплоем, а настоящий db push
# ниже (без --accept-data-loss) всё равно откажется удалять данные.
#
# Итог: 0 — схема применяется без потери данных, 1 — деплой остановлен, прод не
# тронут. Разрешения «удалить всё равно» у конвейера нет: намеренное удаление
# данных владелец делает вручную, с бэкапом, отдельной операцией.
#
# Запуск с раннера: ssh … 'bash -s' < scripts/deploy/schema-preflight.sh
# Схема заранее кладётся в $LR_PREFLIGHT_DIR/schema.prisma.
#
# Без `case` — по той же причине, что и в deploy-rsync.yml (единый стиль скриптов деплоя).

set -euo pipefail

APP_DIR="${LR_APP_DIR:-/opt/light-rental-system}"
WORK_DIR="${LR_PREFLIGHT_DIR:-/tmp/lr-preflight}"
SCHEMA="$WORK_DIR/schema.prisma"
COPY="$WORK_DIR/check.db"
PRISMA="$APP_DIR/node_modules/.bin/prisma"

cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

echo "▶ Пробное применение схемы на копии боевой базы"

if [ ! -f "$SCHEMA" ]; then
  echo "✗ Нет $SCHEMA — раннер не передал схему" >&2
  exit 1
fi
if [ ! -x "$PRISMA" ]; then
  echo "  ⚠ Нет Prisma CLI в $PRISMA (прошлый деплой прервался на npm ci?) — пробу пропускаю."
  echo "    Настоящий db push в деплое всё равно откажется удалять данные."
  exit 0
fi

# Путь к базе — из DATABASE_URL, та же логика, что в шаге деплоя: относительный
# путь SQLite Prisma резолвит от папки со схемой (apps/api/prisma).
DB_LINE=$(grep -E '^DATABASE_URL=' "$APP_DIR/apps/api/.env" 2>/dev/null | head -1 || true)
DB_FILE=${DB_LINE#DATABASE_URL=}
DB_FILE=${DB_FILE%\"}
DB_FILE=${DB_FILE#\"}
DB_FILE=${DB_FILE#file:}
DB_FILE="${DB_FILE#./}"
if [ -z "$DB_FILE" ]; then
  DB_FILE=prisma/prod.db
elif [ "${DB_FILE#/}" = "$DB_FILE" ] && [ "${DB_FILE#prisma/}" = "$DB_FILE" ]; then
  DB_FILE="prisma/$DB_FILE"
fi
if [ "${DB_FILE#/}" = "$DB_FILE" ]; then
  DB_FILE="$APP_DIR/apps/api/$DB_FILE"
fi
if [ ! -f "$DB_FILE" ]; then
  # Шаг деплоя сам остановится на бэкапе без базы — здесь не дублируем.
  echo "  ⚠ Боевая база не найдена ($DB_FILE) — пробу пропускаю."
  exit 0
fi

# База в WAL: .backup снимает консистентный снимок вместе с хвостом WAL.
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DB_FILE" ".backup '$COPY'"
else
  cp "$DB_FILE" "$COPY"
fi

# Запуск из $WORK_DIR, а не из apps/api: там лежит .env с боевым DATABASE_URL,
# и Prisma могла бы подхватить его вместо копии.
set +e
OUT=$(cd "$WORK_DIR" && CHECKPOINT_DISABLE=1 DATABASE_URL="file:$COPY" \
  "$PRISMA" db push --schema "$SCHEMA" --skip-generate 2>&1)
CODE=$?
set -e

if [ "$CODE" -eq 0 ]; then
  echo "$OUT" | grep -vE '^\s*$' | tail -3
  echo "✓ Схема применяется без потери данных — продолжаю деплой"
  exit 0
fi

echo "$OUT"

# Явный отказ Prisma: потеря данных или шаг, который нельзя выполнить на этих данных.
if printf '%s' "$OUT" | grep -qE 'accept-data-loss|data loss|cannot be executed'; then
  echo "" >&2
  echo "✗ ДЕПЛОЙ ОСТАНОВЛЕН — прод не тронут." >&2
  echo "  Новая schema.prisma не ложится на боевую базу (причина выше):" >&2
  echo "  удаляет данные или добавляет то, что нельзя накатить на заполненную таблицу." >&2
  echo "  Ветка отстала от main — поправьте схему новым PR. Новое поле — сделайте его" >&2
  echo "  необязательным или со значением по умолчанию в базе. Задуманное удаление —" >&2
  echo "  владелец готовит базу вручную, с бэкапом, и перезапускает деплой." >&2
  exit 1
fi

echo "  ⚠ Проба не удалась не из-за данных (код $CODE, вывод выше) — пропускаю."
echo "    Настоящий db push в деплое проверит схему ещё раз."
exit 0
