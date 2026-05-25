#!/usr/bin/env bash
# deploy.sh — сборка и перезапуск всех сервисов
#
# Использование:
#   chmod +x deploy.sh
#   ./deploy.sh            # полный деплой (api + rental-bot + web)
#   ./deploy.sh --api      # только API
#   ./deploy.sh --rental-bot # только rental-bot
#   ./deploy.sh --web      # только фронтенд
#
# Требования на сервере:
#   Node.js >= 20, npm >= 10, pm2 (npm i -g pm2)
#
# Стабильность (см. почему этот скрипт такой):
#   1. ОСТАНАВЛИВАЕМ web перед `npm ci`. `npm ci` стирает node_modules; если в
#      это время живой PM2 web падает на исчезнувшие модули — он входит в
#      crash loop (видели в проде, 35+ рестартов на битых .next/). Stop ДО
#      install + start ТОЛЬКО после успешного билда = атомарность.
#   2. Удаляем `apps/web/.next` перед билдом — если прошлый билд упал по OOM
#      на половине, остаются битые chunk-файлы, которые рантайм-Next пытается
#      грузить и валится на `Cannot read properties of undefined (reading
#      'clientModules')`.
#   3. NODE_OPTIONS=--max-old-space-size=1536 — кап на heap билда. На VPS с
#      3.3 ГБ RAM это страхует от OOM, у нас 6 ГБ swap покрывает overflow.
#   4. Healthcheck в конце — curl /api/health (внутри VPS) и /api/auth/me
#      через прокси. Если 2xx-401 не пришёл — exit 1, чтобы автоматизация
#      (CI, cron, ручной запуск) узнала о провале сразу, а не через жалобу.

set -euo pipefail

DEPLOY_ALL=true
DEPLOY_API=false
DEPLOY_RENTAL_BOT=false
DEPLOY_WEB=false

for arg in "$@"; do
  case $arg in
    --api)        DEPLOY_ALL=false; DEPLOY_API=true ;;
    --rental-bot) DEPLOY_ALL=false; DEPLOY_RENTAL_BOT=true ;;
    --web)        DEPLOY_ALL=false; DEPLOY_WEB=true ;;
  esac
done

if $DEPLOY_ALL; then
  DEPLOY_API=true
  DEPLOY_RENTAL_BOT=true
  DEPLOY_WEB=true
fi

ROOT="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "╔══════════════════════════════════════╗"
echo "║   Light Rental System  · Deploy      ║"
echo "╚══════════════════════════════════════╝"
echo ""

# ── (1) Атомарность: останавливаем web перед npm ci ──────────────────────────
# Web — самый чувствительный к битым node_modules: рантайм next start активно
# подгружает chunks; пропавшие модули → crash loop. API/bot переживают потерю
# node_modules лучше (только при reload).
if $DEPLOY_WEB; then
  echo "▶ stop: pm2 stop web (атомарность билда)"
  pm2 stop web > /dev/null 2>&1 || true
  echo "  ✓ web остановлен (поднимем после успешной сборки)"
fi

# Где-то на проде живёт скрытый NODE_ENV=production (источник не нашли — ни
# /etc/environment, ни .npmrc, ни ~/.bashrc). Без явного NODE_ENV=development
# npm ci пропускает devDeps → tsc/next/prisma CLI отсутствуют → tools падают
# с «tsc not found» / «prisma not found». Этот случай уже валил несколько
# деплоев подряд. Билд сейчас требует tsc и tsx, поэтому dev-deps нужны.
export NODE_ENV=development

# logs/ нужна PM2 для записи stdout/stderr. Если её снесли (например, прошлым
# rsync --delete без proper exclude'а) — PM2-процессы падают и не могут даже
# залогировать причину. Гарантируем существование.
mkdir -p "$ROOT/logs"

# ── Root workspace install (hoists deps для всех приложений) ──────────────────
# `npm ci` — clean install строго по package-lock.json. Гарантирует
# воспроизводимый деплой и чинит частичные деревья после прерванных install'ов.
cd "$ROOT"
echo "▶ root: npm ci (workspaces, clean install, NODE_ENV=development для devDeps)"
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

  # ── (2) Чистый билд: всегда удаляем .next, чтобы не унаследовать битые
  # артефакты от прошлого OOM-killed билда. На холодную сборка ~30-60s,
  # на горячую обычно дороже из-за кэша → разница в десятки секунд,
  # но мы получаем гарантированно консистентный билд.
  echo "▶ web: rm -rf .next (чистый билд)"
  rm -rf .next

  # ── (3) Heap-cap для билда: 1.5 ГБ. С 6 ГБ swap на VPS это ОК.
  # Без cap билд Next запросто берёт 2-3 ГБ и triggers OOM-kill на 3.3 ГБ RAM.
  #
  # NODE_ENV=production обязателен для самого `next build` (даже если выше
  # выставили development для npm ci). Без него Next грузит dev-runtime React,
  # который при prerender статических страниц ловит «Cannot read properties of
  # null (reading 'useContext')» на /_not-found, /_error и прочих авто-страницах
  # — билд падает в самом конце с npm error code 1.
  echo "▶ web: build (heap ≤ 1.5 ГБ, NODE_ENV=production)"
  NODE_ENV=production NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=1536" npm run build

  # ecosystem.config.js на каждом reload читает API_KEYS из apps/api/.env
  # и подставляет в env web-процесса как API_KEY. --update-env обязателен.
  # Используем start (а не reload), потому что мы остановили web в начале.
  pm2 describe web > /dev/null 2>&1 \
    && pm2 reload "$ROOT/ecosystem.config.js" --only web --update-env \
    || pm2 start "$ROOT/ecosystem.config.js" --only web

  echo "  ✓ web готов"
fi

pm2 save --force > /dev/null

# ── (4) Healthcheck после деплоя ─────────────────────────────────────────────
# Пингуем то, что задеплоили. Без этого скрипт говорил «✓ Деплой завершён»
# даже когда api/web в crash loop — узнавали через жалобу пользователя.
echo ""
echo "▶ healthcheck"

HEALTH_FAIL=false

# Ждём 5 секунд: PM2 reload не атомарен — старый процесс ещё дослуживает,
# новый поднимается. До этого порта curl может получить EOF.
sleep 5

if $DEPLOY_API; then
  if curl -fsS --max-time 5 http://127.0.0.1:4000/health > /dev/null 2>&1; then
    echo "  ✓ API: http://127.0.0.1:4000/health → 200"
  else
    echo "  ✗ API: http://127.0.0.1:4000/health НЕ отвечает"
    echo "    pm2 logs api --lines 50 — посмотрите ошибки"
    HEALTH_FAIL=true
  fi
fi

if $DEPLOY_WEB; then
  # /api/auth/me на проде → 401 (не залогинены). Проверяем не код, а сам факт
  # ответа: web-прокси → api → 401. Если что-то развалилось — 502/504/timeout.
  HTTP_CODE=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 http://127.0.0.1:3000/api/auth/me || echo "000")
  case "$HTTP_CODE" in
    401|200)
      echo "  ✓ Web: http://127.0.0.1:3000/api/auth/me → $HTTP_CODE (proxy жив)"
      ;;
    *)
      echo "  ✗ Web: http://127.0.0.1:3000/api/auth/me → $HTTP_CODE (ожидался 401)"
      echo "    pm2 logs web --lines 50 — посмотрите ошибки"
      HEALTH_FAIL=true
      ;;
  esac
fi

if $DEPLOY_RENTAL_BOT; then
  # У бота нет HTTP — проверяем только что PM2 показывает online.
  if pm2 describe rental-bot 2>/dev/null | grep -q "status.*online"; then
    echo "  ✓ rental-bot: pm2 status online"
  else
    echo "  ✗ rental-bot: pm2 status НЕ online"
    HEALTH_FAIL=true
  fi
fi

echo ""
if $HEALTH_FAIL; then
  echo "✗ Деплой завершён С ОШИБКАМИ. Проверьте pm2 logs выше."
  pm2 list
  exit 1
fi

echo "✓ Деплой завершён"
echo ""
pm2 list
