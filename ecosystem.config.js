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
  ],
};
