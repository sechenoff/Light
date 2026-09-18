#!/usr/bin/env bash
# Пробный `prisma db push` новой схемы на КОПИИ боевой базы — до того, как деплой
# что-либо тронет на проде (запускается из deploy-rsync.yml до rsync).
#
# Зачем. Настоящий `db push` в деплое тоже отказывается удалять непустые таблицы
# и колонки, но срабатывает ПОСЛЕ rsync: исходники уже заменены, web остановлен,
# и отказ оставил бы прод наполовину обновлённым. Здесь та же проверка идёт
# раньше и на живых данных (копия базы). Сторож схемы в PR
# (scripts/schema-guard.mjs) ловит то же самое ещё раньше — по тексту схемы.
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
  echo "✗ Нет Prisma CLI в $PRISMA" >&2
  exit 1
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
  echo "✗ Боевая база не найдена: $DB_FILE" >&2
  exit 1
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
echo "" >&2
echo "✗ ДЕПЛОЙ ОСТАНОВЛЕН — прод не тронут." >&2
echo "  Новая schema.prisma удалила бы данные на проде (список выше) или не применяется." >&2
echo "  Если ветка просто отстала от main — поправьте схему в новом PR." >&2
echo "  Если удаление задумано владельцем — он делает его вручную, с бэкапом." >&2
exit 1
