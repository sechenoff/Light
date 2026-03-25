import express from "express";
import multer from "multer";

import { previewEquipmentImport, commitEquipmentImport, ImportMappingSchema } from "../services/equipmentImport";
import { HttpError } from "../utils/errors";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const router = express.Router();

router.post("/preview", upload.single("file"), async (req, res, next) => {
  try {
    const file = req.file;
    if (!file) throw new HttpError(400, "Missing file upload.");
    const preview = await previewEquipmentImport({ buffer: file.buffer });
    res.json(preview);
  } catch (err) {
    next(err);
  }
});

router.post("/commit", upload.single("file"), async (req, res, next) => {
  try {
    const file = req.file;
    if (!file) throw new HttpError(400, "Missing file upload.");
    const body = req.body;
    const parsed = ImportMappingSchema.safeParse(JSON.parse(body.mapping ?? "{}"));
    if (!parsed.success) throw new HttpError(400, "Invalid request body.", parsed.error.flatten());

    const result = await commitEquipmentImport({
      buffer: file.buffer,
      mapping: parsed.data,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

export { router as equipmentImportRouter };

