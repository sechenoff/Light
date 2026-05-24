/**
 * Хранилище фотографий для заявок обратной связи.
 *
 * Зеркалит проверенный паттерн безопасности из repairPhotoStorage:
 *   - magic-byte валидация (защита от подмены MIME),
 *   - санитизация имени файла,
 *   - guard от path traversal.
 *
 * Файлы лежат в uploads/feedback/{feedbackId}/. В БД хранится относительный
 * путь от UPLOAD_ROOT (как Expense.documentUrl и RepairPhoto.filePath).
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";

// UPLOAD_ROOT — абсолютная база для всего файлового хранилища.
// FeedbackPhoto.filePath хранится ОТНОСИТЕЛЬНО этого корня.
export const FEEDBACK_UPLOAD_ROOT = path.resolve(__dirname, "../../uploads");

export const FEEDBACK_ALLOWED_MIME = new Set(["image/jpeg", "image/png"]);
export const FEEDBACK_MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

const MAGIC_BYTES: Array<{ mime: string; bytes: number[]; offset: number }> = [
  { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff],       offset: 0 }, // FF D8 FF
  { mime: "image/png",  bytes: [0x89, 0x50, 0x4e, 0x47], offset: 0 }, // 89 PNG
];

export function validateFeedbackMagicBytes(buffer: Buffer, mime: string): boolean {
  const sig = MAGIC_BYTES.find((m) => m.mime === mime);
  if (!sig) return false;
  for (let i = 0; i < sig.bytes.length; i++) {
    if (buffer[sig.offset + i] !== sig.bytes[i]) return false;
  }
  return true;
}

export function sanitizeFeedbackFilename(name: string): string {
  const base = path.basename(name).replace(/[\x00/\\]/g, "_");
  const ext = path.extname(base);
  const stem = path
    .basename(base, ext)
    .replace(/[^\wЀ-ӿ.-]/g, "_")
    .slice(0, 100);
  return stem + ext;
}

/** Резолвит относительный путь в абсолютный, защищая от path traversal. */
export function resolveFeedbackUploadPath(relativeUrl: string): string | null {
  const rel = relativeUrl.replace(/^\//, "");
  const resolved = path.resolve(FEEDBACK_UPLOAD_ROOT, rel);
  if (!resolved.startsWith(FEEDBACK_UPLOAD_ROOT + path.sep) && resolved !== FEEDBACK_UPLOAD_ROOT) {
    return null;
  }
  return resolved;
}

/** Записывает файл в uploads/feedback/{feedbackId}/ и возвращает относительный путь. */
export function writeFeedbackPhoto(feedbackId: string, buf: Buffer, original: string): string {
  const rel = path.join(
    "feedback",
    feedbackId,
    `${crypto.randomBytes(4).toString("hex")}_${sanitizeFeedbackFilename(original)}`,
  );
  const abs = path.join(FEEDBACK_UPLOAD_ROOT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
  return rel;
}
