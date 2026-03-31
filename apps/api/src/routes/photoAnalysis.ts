import express from "express";
import multer from "multer";

import { visionProvider } from "../services/vision";
import { matchEquipmentToInventory, type MatchedItem } from "../services/equipmentMatcher";
import { buildEstimate, type EstimateResult } from "../services/estimateCalculator";
import { completeAnalysis, failAnalysis } from "../services/analyses";
import { prisma } from "../prisma";

const router = express.Router();

/** multer хранит файл в памяти — для MVP достаточно (ограничение 10 МБ) */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Ожидается изображение"));
  },
});

export type PhotoAnalysisResponse = {
  description: string;
  matchedEquipment: MatchedItem[];
  /** Позиции из анализа, для которых не нашлось даже аналога */
  unmatchedNames: string[];
  /** Детализированная смета с разбивкой по строкам */
  estimate: EstimateResult;
  /** PNG диаграммы в base64; null если генерация недоступна */
  diagramBase64: string | null;
};

/**
 * POST /api/photo-analysis
 * Принимает multipart/form-data с полем "photo" и необязательным полем "analysisId".
 * Если analysisId передан — сохраняет результат в Analysis-запись.
 * Возвращает анализ освещения + сопоставление с каталогом + схему.
 */
router.post("/", upload.single("photo"), async (req, res, next) => {
  const analysisId = (req.body as Record<string, string>).analysisId ?? null;
  try {
    if (!req.file) {
      res.status(400).json({ message: "Поле photo обязательно" });
      return;
    }

    const { buffer, mimetype } = req.file;

    // Строим подсказку из каталога: имена оборудования по категориям
    const catalogRows = await prisma.equipment.findMany({
      where: { totalQuantity: { gt: 0 } },
      select: { name: true, category: true },
      orderBy: { sortOrder: "asc" },
    });
    const catalogHint = Object.entries(
      catalogRows.reduce<Record<string, string[]>>((acc, { category, name }) => {
        (acc[category] ??= []).push(name);
        return acc;
      }, {}),
    ).map(([category, names]) => ({ category, names }));

    const analysis = await visionProvider.analyzePhoto({
      imageBuffer: buffer,
      mimeType: mimetype,
      catalogHint,
    });

    const [diagramBuffer, matchResult] = await Promise.all([
      visionProvider.generateDiagram(analysis.description).catch(() => null),
      matchEquipmentToInventory(analysis.equipment),
    ]);

    const estimate = buildEstimate(matchResult.matched);

    // Сохраняем результат в БД если передан analysisId
    if (analysisId) {
      await completeAnalysis(analysisId, {
        description: analysis.description,
        equipmentJson: JSON.stringify({ matched: matchResult.matched, estimate }),
        estimatePerShift: Number(estimate.grandTotal),
      }).catch(() => {/* не блокируем ответ если DB недоступна */});
    }

    const response: PhotoAnalysisResponse = {
      description: analysis.description,
      matchedEquipment: matchResult.matched,
      unmatchedNames: matchResult.unmatched.map((u) => u.suggestedName),
      estimate,
      diagramBase64: diagramBuffer ? diagramBuffer.toString("base64") : null,
    };

    res.json(response);
  } catch (err) {
    // Помечаем анализ как FAILED если передан analysisId
    if (analysisId) {
      await failAnalysis(analysisId).catch(() => {});
    }
    next(err);
  }
});

export { router as photoAnalysisRouter };
