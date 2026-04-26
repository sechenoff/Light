/**
 * PM2 Ecosystem Config
 *
 * Полезные команды:
 *   pm2 logs api --lines 100
 *   pm2 logs rental-bot --lines 100
 *   pm2 monit
 *   pm2 status
 */

module.exports = {
  apps: [
    // ── Backend API ────────────────────────────────────────────────────────────
    {
      name: "api",
      cwd: "./apps/api",
      script: "dist/index.js",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      env: { NODE_ENV: "production", PORT: 4000 },
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "../../logs/api-error.log",
      out_file:   "../../logs/api-out.log",
    },

    // ── Light Rental Bot ──────────────────────────────────────────────────────
    {
      name: "rental-bot",
      cwd: "./apps/bot",
      script: "dist/index.js",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "256M",
      env: {
        NODE_ENV: "production",
        API_BASE_URL: "http://localhost:4000",
        WEBHOOK_DOMAIN: "",   // Set on production, empty = polling mode
        WEBHOOK_PORT: 3001,
        WEBHOOK_SECRET: "",   // Set on production for security
      },
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "../../logs/rental-bot-error.log",
      out_file:   "../../logs/rental-bot-out.log",
    },

    // ── Overdue invoice recompute cron ────────────────────────────────────────
    // P4: runs daily at 02:00 UTC via PM2 cron_restart.
    // Timezone: UTC (server must be UTC or adjust cron expression accordingly).
    // Prerequisite: run `npx tsx apps/api/scripts/seed-system-user.ts` once after deploy
    // to ensure the "_system_" AdminUser exists for audit entries (T3).
    {
      name: "overdue-recompute",
      script: "./apps/api/scripts/pm2-cron-overdue.cjs",
      cron_restart: "0 2 * * *",
      autorestart: false,
      watch: false,
      env: { NODE_ENV: "production" },
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "../../logs/overdue-cron-error.log",
      out_file:   "../../logs/overdue-cron-out.log",
    },
  ],
};
