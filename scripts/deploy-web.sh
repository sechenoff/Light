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
# Clear BOTH .next AND node_modules/.cache — Next.js/webpack caches in .cache can
# produce an incomplete build (missing pages-manifest.json, etc.) when hitting
# a stale cache from a different app-router vs pages-router state.
rm -rf apps/web/.next apps/web/node_modules/.cache

# Force production-safe env vars for the build. Local `.env.local` usually has
# `NEXT_PUBLIC_API_BASE_URL=http://localhost:4000` for dev — if that leaks into
# the production bundle, every client-side fetch in production points at the
# user's own localhost and fails with ERR_CONNECTION_REFUSED. Override to empty
# so the baked-in URLs are relative (same-origin via nginx).
export NEXT_PUBLIC_API_BASE_URL=
export NODE_ENV=production

npm run build -w apps/web > /tmp/lr-web-build.log 2>&1 || {
  red "ERROR: local build failed. Last 30 lines of log:"
  tail -30 /tmp/lr-web-build.log
  exit 1
}

# Sanity check: verify build DID NOT bake in localhost:4000 anywhere
if grep -rq "http://localhost:4000\|http://127.0.0.1:4000" apps/web/.next/static/chunks/ 2>/dev/null; then
  red "ERROR: build contains localhost:4000 in client chunks."
  red "This means NEXT_PUBLIC_API_BASE_URL leaked from .env.local into the production bundle."
  red "Check apps/web/.env.local and remove/clear NEXT_PUBLIC_API_BASE_URL."
  exit 1
fi

if [ ! -f apps/web/.next/BUILD_ID ]; then
  red "ERROR: build produced no .next/BUILD_ID — something went wrong"
  tail -30 /tmp/lr-web-build.log
  exit 1
fi

# Sanity check: Next.js build MUST include these manifests; missing any of them
# means the runtime will crash on startup with ENOENT.
REQUIRED_FILES=(
  "apps/web/.next/server/pages-manifest.json"
  "apps/web/.next/server/next-font-manifest.json"
  "apps/web/.next/server/middleware-manifest.json"
  "apps/web/.next/server/app-paths-manifest.json"
  "apps/web/.next/routes-manifest.json"
)
for f in "${REQUIRED_FILES[@]}"; do
  if [ ! -f "$f" ]; then
    red "ERROR: build incomplete — missing $f"
    red "This usually means a bad build cache. Clearing and retrying..."
    rm -rf apps/web/.next apps/web/node_modules/.cache
    exit 1
  fi
done

green "  ✓ build ok, BUILD_ID=$(cat apps/web/.next/BUILD_ID)"

# ── Server: pull + smart install + prisma + symlink safety ────────────────────
# Why "smart" install?
#   Full `npm ci` is ~45s AND peaks at ~1GB RAM which OOMs our 2GB VPS
#   mid-install, leaving node_modules/ in a broken state. We avoid it when
#   possible by checking whether package-lock.json changed. Full install only
#   when the lockfile genuinely moved.
blue "▶ Updating server (git pull + conditional install + prisma + symlink safety)"

ssh "$SERVER" bash <<'REMOTE_SCRIPT'
set -euo pipefail
cd /opt/light-rental-system

echo "  ▸ git fetch + reset"
# Capture lockfile hash BEFORE pull so we can detect changes
LOCK_BEFORE=$(sha256sum package-lock.json 2>/dev/null | cut -d' ' -f1 || echo "none")
git fetch origin --quiet
git reset --hard origin/main --quiet
LOCK_AFTER=$(sha256sum package-lock.json 2>/dev/null | cut -d' ' -f1 || echo "none")

# Decide: do we need to install?
# Yes if: lockfile changed OR node_modules missing OR next binary missing
NEED_INSTALL=false
if [ "$LOCK_BEFORE" != "$LOCK_AFTER" ]; then
  echo "  ▸ package-lock.json changed — full install needed"
  NEED_INSTALL=true
elif [ ! -d node_modules ] || [ ! -e node_modules/.bin/next ] || [ ! -d node_modules/next ]; then
  echo "  ▸ node_modules incomplete — install needed"
  NEED_INSTALL=true
else
  echo "  ▸ lockfile unchanged, node_modules intact — skipping install"
fi

if $NEED_INSTALL; then
  echo "  ▸ npm ci (may take ~45s, monitor memory)"
  # Use --silent to reduce log noise; --no-audit/--no-fund to skip non-essentials
  if ! npm ci --no-audit --no-fund --silent 2>&1 | tail -3; then
    echo "  ⚠ npm ci failed or was killed. Attempting recovery."
    # Most common failure: OOM kill mid-install. Recover by:
    # 1. Using npm install (slightly less memory-hungry) as fallback
    npm install --no-audit --no-fund --prefer-offline --silent 2>&1 | tail -3 || {
      echo "  ⚠ npm install also failed — will try manual symlink repair"
    }
  fi
fi

# Safety net: critical binaries must exist. If npm failed partway, manually
# repair the symlinks we need. This is faster and more reliable than retrying
# a failing install loop.
if [ ! -e node_modules/.bin/next ]; then
  if [ -f node_modules/next/dist/bin/next ]; then
    echo "  ⚠ .bin/next missing — recreating symlink"
    mkdir -p node_modules/.bin
    ln -sf ../next/dist/bin/next node_modules/.bin/next
    chmod +x node_modules/next/dist/bin/next
  else
    echo "  ERROR: node_modules/next/ is missing. Cannot recover without network install."
    echo "  Retry: ssh $SERVER 'cd /opt/light-rental-system && npm ci'"
    exit 1
  fi
fi

if [ ! -e node_modules/.bin/next ]; then
  echo "  ERROR: .bin/next still missing after repair attempts"
  exit 1
fi
echo "  ✓ next binary ready: $(ls -la node_modules/.bin/next)"

echo "  ▸ prisma generate (safe even if API unchanged)"
cd apps/api
npx prisma generate > /dev/null 2>&1 || {
  echo "  WARN: prisma generate failed — API may have schema issues"
}
cd ../..

echo "  ✓ server ready"
REMOTE_SCRIPT

# ── Rsync build artifacts ─────────────────────────────────────────────────────
# Note: macOS openrsync doesn't support --info=stats1; keep flags portable.
blue "▶ Syncing .next/ to server"
rsync -az --delete apps/web/.next/ "$SERVER:$SERVER_PATH/apps/web/.next/"
green "  ✓ .next synced"

if [ -d apps/web/public ]; then
  blue "▶ Syncing public/"
  rsync -az --delete apps/web/public/ "$SERVER:$SERVER_PATH/apps/web/public/" || true
  green "  ✓ public synced"
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
