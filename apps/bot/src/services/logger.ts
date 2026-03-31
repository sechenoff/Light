import fs from "fs";
import path from "path";

const LOG_DIR = path.resolve(process.env.LOG_DIR ?? "./logs");
const LOG_FILE = path.join(LOG_DIR, "bot-errors.log");
const MAX_BYTES = 5 * 1024 * 1024; // 5 МБ — ротация при превышении

function ensureDir() {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch { /* ignore */ }
}

function rotate() {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > MAX_BYTES) {
      fs.renameSync(LOG_FILE, LOG_FILE + ".old");
    }
  } catch { /* нет файла — ок */ }
}

function fmt(level: string, context: string, message: string, extra?: unknown): string {
  const ts = new Date().toISOString();
  const extraStr = extra !== undefined
    ? "\n  " + (extra instanceof Error
        ? `${extra.message}\n  ${extra.stack ?? ""}`
        : JSON.stringify(extra, null, 2).replace(/\n/g, "\n  "))
    : "";
  return `[${ts}] [${level}] [${context}] ${message}${extraStr}\n`;
}

export function logError(context: string, message: string, error?: unknown): void {
  try {
    ensureDir();
    rotate();
    const line = fmt("ERROR", context, message, error);
    fs.appendFileSync(LOG_FILE, line, "utf-8");
    // eslint-disable-next-line no-console
    console.error(`[Bot] ${context}: ${message}`, error instanceof Error ? error.message : error ?? "");
  } catch { /* логгер не должен падать */ }
}

export function logWarn(context: string, message: string, extra?: unknown): void {
  try {
    ensureDir();
    const line = fmt("WARN", context, message, extra);
    fs.appendFileSync(LOG_FILE, line, "utf-8");
    // eslint-disable-next-line no-console
    console.warn(`[Bot] ${context}: ${message}`);
  } catch { /* ignore */ }
}

export function logInfo(context: string, message: string): void {
  // Только в консоль — не засоряем файл рутинными событиями
  // eslint-disable-next-line no-console
  console.log(`[Bot] ${context}: ${message}`);
}

export { LOG_FILE };
