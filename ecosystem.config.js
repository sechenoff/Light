/**
 * PM2 Ecosystem Config
 *
 * Полезные команды:
 *   pm2 logs api --lines 100
 *   pm2 logs rental-bot --lines 100
 *   pm2 monit
 *   pm2 status
 */

const fs = require("fs");
const path = require("path");

/**
 * Читает первый ключ из API_KEYS в apps/api/.env.
 * Используется как X-API-Key для прокси в Next.js (apps/web/app/api/[...path]/route.ts).
 * Это единый источник истины — рассинхрон между api и web невозможен.
 */
function readApiKeyFromApi() {
  try {
    const envFile = path.join(__dirname, "apps/api/.env");
    const content = fs.readFileSync(envFile, "utf8");
    const match = content.match(/^API_KEYS=(.+)$/m);
    if (match) {
      return match[1].split(",")[0].replace(/^['"]|['"]$/g, "").trim();
    }
  } catch (_e) {
    // .env может не существовать на dev-машинах — это OK, web просто не будет авторизован
  }
  return "";
}

// Абсолютные пути от расположения этого файла. PM2 разворачивает относительные
// cwd/script от ТЕКУЩЕГО шелла, а не от ecosystem.config.js, поэтому без __dirname
// `pm2 start ecosystem.config.js` из любого подкаталога ломал пути (см. bug
// "Script not found: apps/api/apps/api/dist/index.js" из deploy.sh, который
// делал `cd apps/api` перед запуском PM2).
const ROOT = __dirname;
const apiCwd = path.join(ROOT, "apps/api");
const webCwd = path.join(ROOT, "apps/web");
const botCwd = path.join(ROOT, "apps/bot");
const logsDir = path.join(ROOT, "logs");

/**
 * Crash-loop guard для всех долгоживущих процессов.
 *
 *  - `min_uptime: "30s"` — процесс должен прожить минимум 30 секунд, чтобы
 *    PM2 считал его «стабильным». Если упал раньше — это посчитается
 *    рестартом в crash-loop счётчике.
 *  - `max_restarts: 5` — после 5 подряд «нестабильных» рестартов PM2
 *    переводит процесс в `errored` и БОЛЬШЕ НЕ ПОДНИМАЕТ. Это критически
 *    важно: раньше PM2 безмолвно рестартил web 38 раз на битых `.next/`
 *    chunk-ах, выжирая CPU. Теперь через 2-3 минуты он остановится и
 *    `pm2 list` сразу покажет проблему.
 *  - `restart_delay: 5000` — пауза 5 сек между попытками. Не хаммерим
 *    рестартами; вместе с min_uptime это даёт реалистичное окно «либо
 *    процесс зашёл, либо точно сломан».
 *
 * Вернуть процесс после `errored`: `pm2 reload <name>` или `pm2 restart <name>`.
 */
const crashLoopGuard = {
  min_uptime: "30s",
  max_restarts: 5,
  restart_delay: 5000,
};

module.exports = {
  apps: [
    // ── Backend API ────────────────────────────────────────────────────────────
    {
      name: "api",
      cwd: apiCwd,
      script: "dist/index.js",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      ...crashLoopGuard,
      env: { NODE_ENV: "production", PORT: 4000 },
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: path.join(logsDir, "api-error.log"),
      out_file:   path.join(logsDir, "api-out.log"),
    },

    // ── Web (Next.js) ─────────────────────────────────────────────────────────
    // API_KEY автоматически читается из apps/api/.env при каждом pm2 reload
    // (см. readApiKeyFromApi() выше). Нет ручной синхронизации между .env-файлами.
    {
      name: "web",
      cwd: webCwd,
      script: "npm",
      args: "start",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      ...crashLoopGuard,
      env: {
        NODE_ENV: "production",
        PORT: 3000,
        API_KEY: readApiKeyFromApi(),
      },
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: path.join(logsDir, "web-error.log"),
      out_file:   path.join(logsDir, "web-out.log"),
    },

    // ── Light Rental Bot ──────────────────────────────────────────────────────
    {
      name: "rental-bot",
      cwd: botCwd,
      script: "dist/index.js",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "256M",
      ...crashLoopGuard,
      env: {
        NODE_ENV: "production",
        API_BASE_URL: "http://localhost:4000",
        WEBHOOK_DOMAIN: "",   // Set on production, empty = polling mode
        WEBHOOK_PORT: 3001,
        WEBHOOK_SECRET: "",   // Set on production for security
      },
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: path.join(logsDir, "rental-bot-error.log"),
      out_file:   path.join(logsDir, "rental-bot-out.log"),
    },

    // ── Overdue invoice recompute cron ────────────────────────────────────────
    // P4: runs daily at 02:00 UTC via PM2 cron_restart.
    // Timezone: UTC (server must be UTC or adjust cron expression accordingly).
    // Prerequisite: run `npx tsx apps/api/scripts/seed-system-user.ts` once after deploy
    // to ensure the "_system_" AdminUser exists for audit entries (T3).
    {
      name: "overdue-recompute",
      cwd: ROOT,
      script: path.join(ROOT, "apps/api/scripts/pm2-cron-overdue.cjs"),
      cron_restart: "0 2 * * *",
      autorestart: false,
      watch: false,
      env: { NODE_ENV: "production" },
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: path.join(logsDir, "overdue-cron-error.log"),
      out_file:   path.join(logsDir, "overdue-cron-out.log"),
    },
  ],
};
