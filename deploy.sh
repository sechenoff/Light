#!/usr/bin/env bash
# deploy.sh — сборка и перезапуск всех сервисов
#
# Использование:
#   chmod +x deploy.sh
#   ./deploy.sh            # полный деплой
#   ./deploy.sh --api      # только API
#   ./deploy.sh --prod-bot # только prod-bot
#   ./deploy.sh --web      # только фронтенд
#
# Требования на сервере:
#   Node.js >= 20, npm >= 10, pm2 (npm i -g pm2)

set -euo pipefail

DEPLOY_ALL=true
DEPLOY_API=false
DEPLOY_PROD_BOT=false
DEPLOY_RENTAL_BOT=false
DEPLOY_WEB=false

for arg in "$@"; do
  case $arg in
    --api)        DEPLOY_ALL=false; DEPLOY_API=true ;;
    --prod-bot)   DEPLOY_ALL=false; DEPLOY_PROD_BOT=true ;;
    --rental-bot) DEPLOY_ALL=false; DEPLOY_RENTAL_BOT=true ;;
    --web)        DEPLOY_ALL=false; DEPLOY_WEB=true ;;
  esac
done

if $DEPLOY_ALL; then
  DEPLOY_API=true
  DEPLOY_PROD_BOT=true
  DEPLOY_RENTAL_BOT=true
  DEPLOY_WEB=true
fi

ROOT="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "╔══════════════════════════════════════╗"
echo "║   Light Rental System  · Deploy      ║"
echo "╚══════════════════════════════════════╝"
echo ""

# ── Root workspace install (hoists deps для всех приложений) ──────────────────
# Используем `npm ci`: clean install строго по package-lock.json. Это гарантирует
# воспроизводимый деплой и чинит случаи, когда обычный `npm install` оставляет
# частичное дерево зависимостей (например, при добавлении новых модулей).
cd "$ROOT"
echo "▶ root: npm ci (workspaces, clean install)"
npm ci --no-audit --no-fund
echo "  ✓ workspace deps установлены"

# `npm ci` стирает node_modules, в т.ч. сгенерированный @prisma/client.
# Регенерируем сразу — иначе любой процесс, который импортирует prisma
# (api, скрипты, cron), упадёт с "Prisma client did not initialize yet".
if [ -f "$ROOT/apps/api/.env" ]; then
  echo "▶ prisma: generate"
  cd "$ROOT/apps/api" && npx prisma generate > /dev/null 2>&1 \
    && echo "  ✓ Prisma Client сгенерирован" \
    || echo "  ⚠ prisma generate failed (это OK на dev-машине без apps/api/.env)"
  cd "$ROOT"
fi

# ── Shared package (нужен для web, bot) ───────────────────────────────────────
if $DEPLOY_WEB || $DEPLOY_RENTAL_BOT || $DEPLOY_ALL; then
  echo "▶ shared: build"
  cd "$ROOT/packages/shared"
  npm run build
  echo "  ✓ shared готов"
fi

# ── API ───────────────────────────────────────────────────────────────────────
if $DEPLOY_API; then
  echo "▶ API: migrate + build"
  cd "$ROOT/apps/api"

  [ ! -f .env ] && { echo "  ⚠ .env не найден. Скопируйте .env.production → .env"; exit 1; }

  npx prisma generate

  # ── Backup SQLite DB before schema changes ────────────────────────────────
  DB_FILE="$ROOT/apps/api/prisma/rental.db"
  BACKUP_DIR="$ROOT/backups"
  if [ -f "$DB_FILE" ]; then
    mkdir -p "$BACKUP_DIR"
    BACKUP_NAME="rental_$(date +%Y-%m-%d_%H-%M-%S).db"
    cp "$DB_FILE" "$BACKUP_DIR/$BACKUP_NAME"
    echo "  ✓ БД сохранена: backups/$BACKUP_NAME"
    # Удаляем старые бэкапы, оставляем последние 10
    ls -1t "$BACKUP_DIR"/rental_*.db 2>/dev/null | tail -n +11 | xargs -r rm --
  fi
  # ─────────────────────────────────────────────────────────────────────────

  npx prisma db push --accept-data-loss   # SQLite: синхронизируем схему
  npx tsx scripts/seed-admin-users.ts || true   # идемпотентный seed админ-пользователей
  npx tsx scripts/seed-system-user.ts || true   # идемпотентный seed _system_ user (нужен для cron аудита)
  npm run build

  pm2 describe api > /dev/null 2>&1 \
    && pm2 reload api \
    || pm2 start "$ROOT/ecosystem.config.js" --only api

  echo "  ✓ API готов"
fi

# ── prod-bot ──────────────────────────────────────────────────────────────────
if $DEPLOY_PROD_BOT; then
  echo "▶ prod-bot: install + build"
  cd "$ROOT/apps/prod-bot"

  [ ! -f .env ] && { echo "  ⚠ .env не найден. Скопируйте .env.production → .env"; exit 1; }

  # Deps уже установлены корневым `npm ci` в начале скрипта.
  npm run build

  pm2 describe prod-bot > /dev/null 2>&1 \
    && pm2 reload prod-bot \
    || pm2 start "$ROOT/ecosystem.config.js" --only prod-bot

  echo "  ✓ prod-bot готов"
fi

# ── rental-bot ────────────────────────────────────────────────────────────────
if $DEPLOY_RENTAL_BOT; then
  echo "▶ rental-bot: build"
  cd "$ROOT/apps/bot"

  [ ! -f .env ] && { echo "  ⚠ .env не найден. Скопируйте .env.example → .env и заполни"; exit 1; }

  npm run build

  pm2 describe rental-bot > /dev/null 2>&1 \
    && pm2 reload rental-bot \
    || pm2 start "$ROOT/ecosystem.config.js" --only rental-bot

  echo "  ✓ rental-bot готов"
fi

# ── web (Next.js) ─────────────────────────────────────────────────────────────
if $DEPLOY_WEB; then
  echo "▶ web: install + build"
  cd "$ROOT/apps/web"

  [ ! -f .env.local ] && [ ! -f .env ] && {
    echo "  ⚠ .env.local не найден. Создайте: echo 'NEXT_PUBLIC_API_BASE_URL=https://api.yourdomain.com' > .env.local"
    exit 1
  }

  # ── Sync API_KEY из apps/api/.env (single source of truth) ──────────────
  # Это страховка для процессов, которые могут читать .env.local напрямую
  # (build-time оптимизации, локальные npm start вне pm2 и т.д.).
  # PM2-процесс получает API_KEY из ecosystem.config.js (читается на каждый reload).
  if [ -f "$ROOT/apps/api/.env" ]; then
    API_KEY_FROM_API=$(grep -E '^API_KEYS=' "$ROOT/apps/api/.env" | head -1 \
      | sed -E 's/^API_KEYS=//' | cut -d',' -f1 | tr -d '"' | tr -d "'" | tr -d '[:space:]')
    if [ -n "${API_KEY_FROM_API:-}" ]; then
      touch "$ROOT/apps/web/.env.local"
      if grep -q '^API_KEY=' "$ROOT/apps/web/.env.local"; then
        sed -i.bak "s|^API_KEY=.*|API_KEY=$API_KEY_FROM_API|" "$ROOT/apps/web/.env.local"
        rm -f "$ROOT/apps/web/.env.local.bak"
      else
        echo "API_KEY=$API_KEY_FROM_API" >> "$ROOT/apps/web/.env.local"
      fi
      echo "  ✓ API_KEY синхронизирован из apps/api/.env"
    fi
  fi

  # Deps уже установлены корневым `npm ci` в начале скрипта (workspace hoisting).
  npm run build

  # ecosystem.config.js на каждом reload читает API_KEYS из apps/api/.env
  # и подставляет в env web-процесса как API_KEY. --update-env обязателен.
  pm2 describe web > /dev/null 2>&1 \
    && pm2 reload "$ROOT/ecosystem.config.js" --only web --update-env \
    || pm2 start "$ROOT/ecosystem.config.js" --only web

  echo "  ✓ web готов"
fi

echo ""
pm2 save --force > /dev/null
echo "✓ Деплой завершён"
echo ""
pm2 list
