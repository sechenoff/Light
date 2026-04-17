#!/usr/bin/env bash
# scripts/deploy-api.sh — reliable API-only deploy.
#
# When to use: API code (apps/api) or Prisma schema changed.
# If web also changed: run this first, then ./scripts/deploy-web.sh
#
# What it does:
#   1. Pre-flight: on main, synced with origin
#   2. Server: git pull + smart install (skip if lockfile unchanged)
#   3. Server: prisma generate + db push (safe — SQLite with accept-data-loss)
#   4. Server: api build (tsc in apps/api — fast, low memory)
#   5. Server: pm2 restart api
#   6. Health check: /health → {"ok":true}

set -euo pipefail

SERVER="root@194.60.134.177"
SERVER_PATH="/opt/light-rental-system"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

blue()   { printf "\033[1;34m%s\033[0m\n" "$*"; }
green()  { printf "\033[1;32m%s\033[0m\n" "$*"; }
red()    { printf "\033[1;31m%s\033[0m\n" "$*"; }
yellow() { printf "\033[1;33m%s\033[0m\n" "$*"; }

cd "$ROOT"

# ── Pre-flight ────────────────────────────────────────────────────────────────
blue "▶ Pre-flight checks"

if [ "$(git branch --show-current)" != "main" ]; then
  red "ERROR: not on main branch"
  exit 1
fi

git fetch origin --quiet
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  red "ERROR: local main differs from origin/main. Run: git pull --ff-only"
  exit 1
fi

green "  ✓ on main, synced with origin"

# ── Server-side: pull + conditional install + build + restart ─────────────────
blue "▶ Updating server (pull + install + prisma + build + restart)"

ssh "$SERVER" bash <<'REMOTE_SCRIPT'
set -euo pipefail
cd /opt/light-rental-system

echo "  ▸ git fetch + reset"
LOCK_BEFORE=$(sha256sum package-lock.json 2>/dev/null | cut -d' ' -f1 || echo "none")
git fetch origin --quiet
git reset --hard origin/main --quiet
LOCK_AFTER=$(sha256sum package-lock.json 2>/dev/null | cut -d' ' -f1 || echo "none")

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
  echo "  ▸ Cleaning npm tmp dirs first (prev OOM leftovers)"
  find . -path "*/node_modules/.*-[a-zA-Z0-9]*" -maxdepth 6 -type d -exec rm -rf {} + 2>/dev/null || true
  echo "  ▸ npm ci"
  if ! npm ci --no-audit --no-fund --silent 2>&1 | tail -3; then
    echo "  ⚠ npm ci failed (likely OOM). Cleaning + fallback..."
    find . -path "*/node_modules/.*-[a-zA-Z0-9]*" -maxdepth 6 -type d -exec rm -rf {} + 2>/dev/null || true
    npm install --no-audit --no-fund --prefer-offline --silent 2>&1 | tail -3 || true
  fi
fi

# Safety net: ensure critical bin symlinks exist. After OOM-killed npm ci
# previously, these get wiped; `tsc` is needed for api build below, `next`/
# `prisma` for other deploy scripts. Cheap to recreate unconditionally.
mkdir -p node_modules/.bin
cd node_modules/.bin
[ -e tsc ] || ln -sf ../typescript/bin/tsc tsc
[ -e next ] || ln -sf ../next/dist/bin/next next
[ -e prisma ] || ln -sf ../prisma/build/index.js prisma
cd /opt/light-rental-system

echo "  ▸ Prisma generate + db push"
cd apps/api
npx prisma@6.5.0 generate > /dev/null 2>&1 || echo "  ⚠ prisma generate warnings (proceeding)"
npx prisma@6.5.0 db push --accept-data-loss --skip-generate 2>&1 | tail -2

echo "  ▸ Building API (tsc)"
npm run build 2>&1 | tail -3

echo "  ▸ Restarting API via PM2"
pm2 restart api --update-env > /dev/null
cd ../..

echo "  ✓ server deploy done"
REMOTE_SCRIPT

# ── Health check with retry ───────────────────────────────────────────────────
blue "▶ Health check (10× retries, 2s each)"

for i in $(seq 1 10); do
  sleep 2
  resp=$(ssh "$SERVER" "curl -s http://localhost:4000/health" 2>/dev/null || echo "")
  if [ "$resp" = '{"ok":true}' ]; then
    green "  ✓ API healthy after ${i}× retries"
    green ""
    green "✓ API deploy complete"
    exit 0
  fi
  yellow "  … try $i/10 (got: ${resp:-connection refused})"
done

red ""
red "ERROR: API health check failed after 20 seconds"
red "Last 30 lines of API log:"
ssh "$SERVER" 'pm2 logs api --lines 30 --nostream 2>&1 | tail -40' || true
exit 1
