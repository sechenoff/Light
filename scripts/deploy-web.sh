#!/usr/bin/env bash
# scripts/deploy-web.sh — надёжный деплой web-фронтенда на продакшен.
#
# Почему отдельный скрипт, а не `bash deploy.sh --web` на сервере?
# → Next.js падает с SIGBUS при `next build` на VPS (Node 22 + SWC + 2GB RAM).
#   Workaround: собираем локально, rsync-им `.next/` на сервер.
#
# Что делает этот скрипт:
#   1. Проверяет, что локальная main совпадает с origin/main
#   2. Локально собирает web (`npm run build -w apps/web`)
#   3. На сервере: git pull + npm ci + prisma generate + страховка .bin/next
#   4. rsync .next/ и public/ на сервер
#   5. pm2 restart web
#   6. Health check с retry
#
# Запуск: ./scripts/deploy-web.sh

set -euo pipefail

SERVER="root@194.60.134.177"
SERVER_PATH="/opt/light-rental-system"
HEALTH_URL="https://svetobazarent.ru/login"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

blue()   { printf "\033[1;34m%s\033[0m\n" "$*"; }
green()  { printf "\033[1;32m%s\033[0m\n" "$*"; }
red()    { printf "\033[1;31m%s\033[0m\n" "$*"; }
yellow() { printf "\033[1;33m%s\033[0m\n" "$*"; }

cd "$ROOT"

# ── Pre-flight ────────────────────────────────────────────────────────────────
blue "▶ Pre-flight checks"

current_branch="$(git branch --show-current)"
if [ "$current_branch" != "main" ]; then
  red "ERROR: you are on branch '$current_branch', expected 'main'"
  exit 1
fi

git fetch origin --quiet
local_sha="$(git rev-parse HEAD)"
remote_sha="$(git rev-parse origin/main)"
if [ "$local_sha" != "$remote_sha" ]; then
  red "ERROR: local main ($local_sha) differs from origin/main ($remote_sha)"
  red "Run: git pull --ff-only origin main"
  exit 1
fi

green "  ✓ on main, synced with origin"

# ── Local build ───────────────────────────────────────────────────────────────
blue "▶ Building web locally (avoids VPS SIGBUS)"
rm -rf apps/web/.next
npm run build -w apps/web > /tmp/lr-web-build.log 2>&1 || {
  red "ERROR: local build failed. Last 30 lines of log:"
  tail -30 /tmp/lr-web-build.log
  exit 1
}

if [ ! -f apps/web/.next/BUILD_ID ]; then
  red "ERROR: build produced no .next/BUILD_ID — something went wrong"
  tail -30 /tmp/lr-web-build.log
  exit 1
fi
green "  ✓ build ok, BUILD_ID=$(cat apps/web/.next/BUILD_ID)"

# ── Server: pull + install + prisma + symlink safety ──────────────────────────
blue "▶ Updating server (git pull + npm ci + prisma generate + .bin/next safety)"

ssh "$SERVER" bash <<'REMOTE_SCRIPT'
set -euo pipefail
cd /opt/light-rental-system

echo "  ▸ git fetch + reset"
git fetch origin --quiet
git reset --hard origin/main --quiet

echo "  ▸ npm ci (clean install, fixes .bin symlinks)"
npm ci --no-audit --no-fund --silent 2>&1 | tail -5 || {
  # Some packages log deprecation warnings on stderr — if ci exit was 0, we're fine
  echo "  (some warnings from npm, check if fatal)"
}

# Safety net: npm ci should create .bin/next, but if something goes wrong,
# recreate it manually. This is cheap insurance against workspace quirks.
if [ ! -e node_modules/.bin/next ]; then
  echo "  ⚠ .bin/next missing after npm ci — recreating symlink"
  ln -sf ../next/dist/bin/next node_modules/.bin/next
  chmod +x node_modules/next/dist/bin/next
fi

if [ ! -e node_modules/.bin/next ]; then
  echo "  ERROR: cannot create .bin/next even manually. node_modules/next/ may be missing."
  ls node_modules/next/dist/bin/ 2>&1 | head -5
  exit 1
fi

echo "  ▸ prisma generate (safe even if API unchanged)"
cd apps/api
npx prisma generate > /dev/null 2>&1 || {
  echo "  WARN: prisma generate failed — API may have schema issues"
}
cd ../..

echo "  ✓ server ready"
REMOTE_SCRIPT

# ── Rsync build artifacts ─────────────────────────────────────────────────────
blue "▶ Syncing .next/ to server"
rsync -az --delete --info=stats1 apps/web/.next/ "$SERVER:$SERVER_PATH/apps/web/.next/" 2>&1 | tail -3

if [ -d apps/web/public ]; then
  blue "▶ Syncing public/"
  rsync -az --delete apps/web/public/ "$SERVER:$SERVER_PATH/apps/web/public/" 2>&1 | tail -1 || true
fi

# Verify .next/BUILD_ID on server
if ! ssh "$SERVER" "[ -f $SERVER_PATH/apps/web/.next/BUILD_ID ]"; then
  red "ERROR: .next/BUILD_ID missing on server after rsync"
  exit 1
fi

# ── Restart web ───────────────────────────────────────────────────────────────
blue "▶ Restarting web via PM2"
ssh "$SERVER" 'pm2 restart web --update-env > /dev/null 2>&1 || pm2 start npm --name web --cwd /opt/light-rental-system/apps/web -- start'

# ── Health check with retry ───────────────────────────────────────────────────
blue "▶ Health check (10× retries, 2s each)"

for i in $(seq 1 10); do
  sleep 2
  code=$(curl -sI "$HEALTH_URL" -o /dev/null -w "%{http_code}" || echo "000")
  if [ "$code" = "200" ]; then
    green "  ✓ site up ($code) after ${i}× retries"
    green ""
    green "✓ Deploy complete"
    exit 0
  fi
  yellow "  … try $i/10 got HTTP $code"
done

red ""
red "ERROR: health check failed after 20 seconds"
red "Last 30 lines of web logs:"
ssh "$SERVER" 'pm2 logs web --lines 30 --nostream --err 2>&1 | tail -40' || true
exit 1
