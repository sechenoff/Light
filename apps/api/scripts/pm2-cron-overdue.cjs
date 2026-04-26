/**
 * PM2 cron wrapper for recompute-overdue-invoices.
 *
 * Добавить в ecosystem.config.js:
 *
 *   {
 *     name: "overdue-recompute",
 *     script: "apps/api/scripts/pm2-cron-overdue.cjs",
 *     cron_restart: "0 2 * * *",   // каждый день в 02:00 UTC
 *     autorestart: false,
 *     env: { NODE_ENV: "production" },
 *   }
 *
 * После деплоя: pm2 start ecosystem.config.js --only overdue-recompute
 */

const { execSync } = require("child_process");
const path = require("path");

const scriptPath = path.join(__dirname, "recompute-overdue-invoices.js");

try {
  execSync(`node ${scriptPath}`, { stdio: "inherit" });
} catch (err) {
  console.error("recompute-overdue-invoices failed:", err.message);
  process.exit(1);
}
