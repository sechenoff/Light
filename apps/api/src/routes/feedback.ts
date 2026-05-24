/**
 * Роутер /api/feedback — внутренняя система обратной связи (баги/идеи/комменты).
 *
 * Доступ: SUPER_ADMIN, WAREHOUSE, TECHNICIAN (router-level rolesGuard в routes/index.ts).
 * Дополнительные per-action проверки внутри сервиса (status change → SA only,
 * delete → автор или SA, и т.д.).
 *
 * Endpoints:
 *   GET    /                       — список (фильтры status, category, createdBy, cursor)
 *   GET    /stats                  — { newCount, inProgressCount, openCount, total }
 *   POST   /                       — создать (multipart с photos[] ИЛИ json без фото)
 *   GET    /:id                    — детали + comments + photos
 *   PATCH  /:id                    — title/description/category (creator или SA)
 *   POST   /:id/status             — сменить статус (SA only)
 *   DELETE /:id                    — удалить (creator или SA)
 *   POST   /:id/comments           — добавить комментарий
 *   DELETE /:id/comments/:commentId
 *   POST   /:id/photos             — загрузить фото (multipart, 1+ file)
 *   GET    /:id/photos/:photoId    — стрим фото
 *   DELETE /:id/photos/:photoId
 */

import fs from "fs";
import { Router, type RequestHandler } from "express";
import multer from "multer";
import { z } from "zod";

import {
  addComment,
  attachPhoto,
  changeFeedbackStatus,
  createFeedback,
  deleteComment,
  deleteFeedback,
  deletePhoto,
  getFeedback,
  getFeedbackStats,
  getPhoto,
  listFeedback,
  updateFeedback,
} from "../services/feedbackService";
import {
  FEEDBACK_ALLOWED_MIME,
  FEEDBACK_MAX_FILE_SIZE,
  resolveFeedbackUploadPath,
  validateFeedbackMagicBytes,
  writeFeedbackPhoto,
} from "../services/feedbackPhotoStorage";
import { HttpError } from "../utils/errors";

export const feedbackRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: FEEDBACK_MAX_FILE_SIZE, files: 8 },
});

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const listQuerySchema = z.object({
  status: z.enum(["NEW", "IN_PROGRESS", "DONE", "REJECTED", "ALL"]).optional(),
  category: z.enum(["BUG", "IDEA", "COMMENT", "ALL"]).optional(),
  createdBy: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const createBodySchema = z.object({
  category: z.enum(["BUG", "IDEA", "COMMENT"]),
  title: z.string().min(3).max(200),
  description: z.string().min(3).max(4000),
  pageUrl: z.string().max(1000).optional().nullable(),
  viewport: z.string().max(32).optional().nullable(),
  userAgent: z.string().max(500).optional().nullable(),
});

const patchBodySchema = z.object({
  title: z.string().min(3).max(200).optional(),
  description: z.string().min(3).max(4000).optional(),
  category: z.enum(["BUG", "IDEA", "COMMENT"]).optional(),
});

const statusBodySchema = z.object({
  status: z.enum(["NEW", "IN_PROGRESS", "DONE", "REJECTED"]),
});

const commentBodySchema = z.object({
  body: z.string().min(1).max(4000),
});

// ─── helpers ─────────────────────────────────────────────────────────────────

function actorFromReq(req: Parameters<RequestHandler>[0]) {
  if (!req.adminUser) throw new HttpError(401, "Не авторизован", "UNAUTHENTICATED");
  return {
    userId: req.adminUser.userId,
    role: req.adminUser.role,
  };
}

// ─── GET /stats ──────────────────────────────────────────────────────────────

feedbackRouter.get("/stats", async (_req, res, next) => {
  try {
    const stats = await getFeedbackStats();
    res.json(stats);
  } catch (err) {
    next(err);
  }
});

// ─── GET / ───────────────────────────────────────────────────────────────────

feedbackRouter.get("/", async (req, res, next) => {
  try {
    const q = listQuerySchema.parse(req.query);
    const result = await listFeedback(q);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ─── POST / ──────────────────────────────────────────────────────────────────

feedbackRouter.post("/", async (req, res, next) => {
  try {
    const actor = actorFromReq(req);
    const body = createBodySchema.parse(req.body);
    const item = await createFeedback(body, actor);
    res.status(201).json(item);
  } catch (err) {
    next(err);
  }
});

// ─── GET /:id ────────────────────────────────────────────────────────────────

feedbackRouter.get("/:id", async (req, res, next) => {
  try {
    const detail = await getFeedback(req.params.id);
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /:id ──────────────────────────────────────────────────────────────

feedbackRouter.patch("/:id", async (req, res, next) => {
  try {
    const actor = actorFromReq(req);
    const body = patchBodySchema.parse(req.body);
    const item = await updateFeedback(req.params.id, body, actor);
    res.json(item);
  } catch (err) {
    next(err);
  }
});

// ─── POST /:id/status ────────────────────────────────────────────────────────

feedbackRouter.post("/:id/status", async (req, res, next) => {
  try {
    const actor = actorFromReq(req);
    const body = statusBodySchema.parse(req.body);
    const item = await changeFeedbackStatus(req.params.id, body.status, actor);
    res.json(item);
  } catch (err) {
    next(err);
  }
});

// ─── DELETE /:id ─────────────────────────────────────────────────────────────

feedbackRouter.delete("/:id", async (req, res, next) => {
  try {
    const actor = actorFromReq(req);
    const result = await deleteFeedback(req.params.id, actor);
    // Best-effort: убираем файлы фото с диска (если есть)
    for (const rel of result.photoFiles) {
      const abs = resolveFeedbackUploadPath(rel);
      if (abs) {
        try { fs.unlinkSync(abs); } catch { /* ignore — БД уже без записи */ }
      }
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ─── POST /:id/comments ──────────────────────────────────────────────────────

feedbackRouter.post("/:id/comments", async (req, res, next) => {
  try {
    const actor = actorFromReq(req);
    const body = commentBodySchema.parse(req.body);
    const comment = await addComment(req.params.id, body.body, actor);
    res.status(201).json(comment);
  } catch (err) {
    next(err);
  }
});

// ─── DELETE /:id/comments/:commentId ─────────────────────────────────────────

feedbackRouter.delete("/:id/comments/:commentId", async (req, res, next) => {
  try {
    const actor = actorFromReq(req);
    const result = await deleteComment(req.params.id, req.params.commentId, actor);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ─── POST /:id/photos ────────────────────────────────────────────────────────

feedbackRouter.post(
  "/:id/photos",
  upload.array("photos", 8),
  async (req, res, next) => {
    try {
      const actor = actorFromReq(req);
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      if (files.length === 0) {
        throw new HttpError(400, "Файлы не приложены", "NO_FILES");
      }
      const uploaded: Array<{ id: string; url: string }> = [];
      for (const f of files) {
        if (!FEEDBACK_ALLOWED_MIME.has(f.mimetype)) {
          throw new HttpError(415, "Неподдерживаемый тип файла (только JPEG/PNG)", "UNSUPPORTED_MIME");
        }
        if (!validateFeedbackMagicBytes(f.buffer, f.mimetype)) {
          throw new HttpError(400, "Файл не соответствует объявленному типу", "MAGIC_BYTES_MISMATCH");
        }
        const rel = writeFeedbackPhoto(req.params.id, f.buffer, f.originalname);
        const photo = await attachPhoto(req.params.id, rel, actor);
        uploaded.push({ id: photo.id, url: `/api/feedback/${req.params.id}/photos/${photo.id}` });
      }
      res.status(201).json({ photos: uploaded });
    } catch (err) {
      next(err);
    }
  },
);

// ─── GET /:id/photos/:photoId ────────────────────────────────────────────────

feedbackRouter.get("/:id/photos/:photoId", async (req, res, next) => {
  try {
    const photo = await getPhoto(req.params.id, req.params.photoId);
    const abs = resolveFeedbackUploadPath(photo.filePath);
    if (!abs || !fs.existsSync(abs)) {
      throw new HttpError(404, "Файл не найден на диске", "PHOTO_FILE_MISSING");
    }
    const mime = abs.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
    res.setHeader("Content-Type", mime);
    res.setHeader("Cache-Control", "private, max-age=300");
    fs.createReadStream(abs).pipe(res);
  } catch (err) {
    next(err);
  }
});

// ─── DELETE /:id/photos/:photoId ─────────────────────────────────────────────

feedbackRouter.delete("/:id/photos/:photoId", async (req, res, next) => {
  try {
    const actor = actorFromReq(req);
    const result = await deletePhoto(req.params.id, req.params.photoId, actor);
    if (result.filePath) {
      const abs = resolveFeedbackUploadPath(result.filePath);
      if (abs) {
        try { fs.unlinkSync(abs); } catch { /* ignore */ }
      }
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
