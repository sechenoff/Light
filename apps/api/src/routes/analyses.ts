import express from "express";
import multer from "multer";
import { z } from "zod";
import crypto from "crypto";
import path from "path";

import { createPendingAnalysis, setStoragePath, failAnalysis } from "../services/analyses";
import { storageService, validateImageBuffer, ImageValidationError } from "../services/storage";
import { enqueueAnalysis } from "../queue/analysisQueue";
import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";

const router = express.Router();

/** multer хранит загружаемое фото в памяти до валидации */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const pendingSchema = z.object({
  userId: z.string().min(1),
  telegramFileId: z.string().min(1),
  telegramMimeType: z.string().default("image/jpeg"),
});

/**
 * POST /api/analyses/pending
 * Создаёт Analysis с status=PENDING и сохраняет метаданные Telegram-файла.
 */
router.post("/pending", async (req, res, next) => {
  try {
    const body = pendingSchema.parse(req.body);
    const analysis = await createPendingAnalysis(body);
    res.status(201).json({ analysis });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/analyses/:id/upload
 * Принимает мультипарт-файл "photo", валидирует по магическим байтам,
 * сохраняет через storage service, обновляет Analysis.storagePath.
 *
 * Ответ: { storagePath: string }
 */
router.post("/:id/upload", upload.single("photo"), async (req, res, next) => {
  const { id } = req.params;

  try {
    // 1. Проверяем что запись существует
    const analysis = await prisma.analysis.findUnique({ where: { id } });
    if (!analysis) throw new HttpError(404, "Analysis не найден");
    if (analysis.status === "DONE") throw new HttpError(409, "Файл уже загружен");

    // 2. Проверяем наличие файла в запросе
    if (!req.file || !req.file.buffer.length) {
      throw new HttpError(400, "Поле photo обязательно");
    }

    const { buffer, mimetype } = req.file;

    // 3. Валидация по магическим байтам — отклоняем невалидные изображения
    try {
      validateImageBuffer(buffer, mimetype);
    } catch (err) {
      if (err instanceof ImageValidationError) {
        await failAnalysis(id, err.message);
        throw new HttpError(422, err.message);
      }
      throw err;
    }

    // 4. Сохраняем файл через storage service
    const ext = mimeToExt(mimetype);
    const filename = `${id}-${crypto.randomBytes(4).toString("hex")}${ext}`;
    const storagePath = await storageService.save(filename, buffer);

    // 5. Обновляем запись Analysis
    await setStoragePath(id, storagePath);

    // 6. Ставим задачу AI-анализа в очередь
    const jobId = await enqueueAnalysis({
      analysisId: id,
      storagePath,
      mimeType: mimetype,
    });

    res.json({ storagePath, jobId });
  } catch (err) {
    next(err);
  }
});

function mimeToExt(mime: string): string {
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png":  ".png",
    "image/webp": ".webp",
    "image/gif":  ".gif",
  };
  return map[mime] ?? (path.extname(mime.split("/")[1] ?? "") || ".bin");
}

export { router as analysesRouter };
