/**
 * Хранилище фотографий поломки для карточек ремонта.
 *
 * Зеркалит проверенный паттерн безопасности из routes/expenses.ts:
 * - magic-byte валидация (защита от подмены MIME),
 * - санитизация имени файла,
 * - guard от path traversal при резолве.
 *
 * Отличие от expenses: разрешены только image/jpeg и image/png (без PDF).
 *
 * Жизненный цикл фото:
 *   1. Загрузка во время сессии возврата → staging-директория
 *      uploads/scan-sessions/{sessionId}/{unitId}/.
 *   2. На completeSession для единиц, помеченных в ремонт, staged-фото
 *      переносятся в uploads/repairs/{repairId}/ и создаются RepairPhoto.
 *
 * Все возвращаемые пути — ОТНОСИТЕЛЬНЫЕ от UPLOAD_ROOT (как Expense.documentUrl).
 */

import path from "path";
import fs from "fs";
import crypto from "crypto";

// ── upload root (относительные пути в БД) ─────────────────────────────────────

// UPLOAD_ROOT — абсолютная база для всего файлового хранилища.
// RepairPhoto.filePath хранится ОТНОСИТЕЛЬНО этого корня
// (например, "repairs/abc/xyz.png"). Резолв = join(UPLOAD_ROOT, rel) + проверка
// отсутствия traversal.
export const UPLOAD_ROOT = path.resolve(__dirname, "../../uploads");

// ── magic bytes (только JPEG + PNG, без PDF) ──────────────────────────────────

export const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png"]);
export const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

// Magic-byte сигнатуры для разрешённых типов (без application/pdf).
const MAGIC_BYTES: Array<{ mime: string; bytes: number[]; offset: number }> = [
  { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff],       offset: 0 }, // FF D8 FF
  { mime: "image/png",  bytes: [0x89, 0x50, 0x4e, 0x47], offset: 0 }, // 89 PNG
];

/**
 * Проверяет, что magic-байты буфера соответствуют объявленному MIME-типу.
 * Возвращает true если валидно, иначе false.
 */
export function validateMagicBytes(buffer: Buffer, mime: string): boolean {
  const sig = MAGIC_BYTES.find((m) => m.mime === mime);
  if (!sig) return false;
  for (let i = 0; i < sig.bytes.length; i++) {
    if (buffer[sig.offset + i] !== sig.bytes[i]) return false;
  }
  return true;
}

/**
 * Санитизирует имя файла: убирает разделители путей, оставляет ASCII +
 * кириллицу + безопасные символы. Сохраняет расширение.
 */
export function sanitizeFilename(name: string): string {
  // Заменяем разделители путей и null-байты
  const base = path.basename(name).replace(/[\x00/\\]/g, "_");
  // Сохраняем расширение, санитизируем остальное
  const ext = path.extname(base);
  const stem = path.basename(base, ext).replace(/[^\wЀ-ӿ.-]/g, "_").slice(0, 100);
  return stem + ext;
}

/**
 * Резолвит относительный путь в абсолютный, защищая от path traversal.
 * Возвращает null если результат выходит за пределы UPLOAD_ROOT.
 */
export function resolveUploadPath(relativeUrl: string): string | null {
  // Убираем ведущий слеш если есть
  const rel = relativeUrl.replace(/^\//, "");
  const resolved = path.resolve(UPLOAD_ROOT, rel);
  // Guard: resolved путь должен начинаться с UPLOAD_ROOT + sep
  if (!resolved.startsWith(UPLOAD_ROOT + path.sep) && resolved !== UPLOAD_ROOT) {
    return null;
  }
  return resolved;
}

// ── staging API ──────────────────────────────────────────────────────────────

export function stageDir(sessionId: string, unitId: string) {
  return path.join("scan-sessions", sessionId, unitId);
}

export function writeStagedPhoto(sessionId: string, unitId: string, buf: Buffer, original: string) {
  const rel = path.join(
    stageDir(sessionId, unitId),
    `${crypto.randomBytes(4).toString("hex")}_${sanitizeFilename(original)}`,
  );
  const abs = path.join(UPLOAD_ROOT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
  return rel;
}

export function listStaged(sessionId: string, unitId: string): string[] {
  const abs = path.join(UPLOAD_ROOT, stageDir(sessionId, unitId));
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs).map((f) => path.join(stageDir(sessionId, unitId), f));
}

/** Перенести стейдж-фото юнита в uploads/repairs/{repairId}/ и вернуть rel-пути. */
export function moveStagedToRepair(sessionId: string, unitId: string, repairId: string): string[] {
  const out: string[] = [];
  for (const rel of listStaged(sessionId, unitId)) {
    const destRel = path.join("repairs", repairId, path.basename(rel));
    const destAbs = path.join(UPLOAD_ROOT, destRel);
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    fs.renameSync(path.join(UPLOAD_ROOT, rel), destAbs);
    out.push(destRel);
  }
  return out;
}
