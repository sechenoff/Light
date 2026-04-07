import express from "express";
import { z } from "zod";

import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";
import { generateBarcodeId, generateBarcodePayload, renderLabelPng, renderLabelsPdf } from "../services/barcode";

const router = express.Router({ mergeParams: true });

// ──────────────────────────────────────────────
// Схемы валидации
// ──────────────────────────────────────────────

const generateSchema = z.object({
  count: z.number().int().min(1).max(100),
  serialNumbers: z.array(z.string()).optional(),
});

const patchSchema = z.object({
  serialNumber: z.string().optional().nullable(),
  status: z.enum(["AVAILABLE", "ISSUED", "MAINTENANCE", "RETIRED", "MISSING"]).optional(),
  comment: z.string().optional().nullable(),
});

// ──────────────────────────────────────────────
// GET / — список единиц оборудования
// ──────────────────────────────────────────────

router.get("/", async (req, res, next) => {
  try {
    const { equipmentId } = req.params;
    const units = await prisma.equipmentUnit.findMany({
      where: { equipmentId },
      select: {
        id: true,
        status: true,
        serialNumber: true,
        barcode: true,
        barcodePayload: true,
        comment: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    });
    res.json({ units });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────
// POST /generate — массовая генерация единиц со штрихкодами
// ──────────────────────────────────────────────

router.post("/generate", async (req, res, next) => {
  try {
    const { equipmentId } = req.params;
    const body = generateSchema.parse(req.body);

    // Получаем информацию об оборудовании для генерации штрихкода
    const equipment = await prisma.equipment.findUnique({
      where: { id: equipmentId },
      select: { name: true, category: true },
    });
    if (!equipment) {
      throw new HttpError(404, "Оборудование не найдено");
    }

    // Определяем следующий порядковый номер в последовательности штрихкодов
    // Берём максимальный существующий номер (из barcode вида LR-XXX-NNN)
    const existingUnits = await prisma.equipmentUnit.findMany({
      where: { equipmentId, barcode: { not: null } },
      select: { barcode: true },
    });

    let maxSeq = 0;
    for (const u of existingUnits) {
      if (!u.barcode) continue;
      // Формат: LR-ABBREV-NNN (последний сегмент — порядковый номер)
      const parts = u.barcode.split("-");
      const seqStr = parts[parts.length - 1];
      const seq = parseInt(seqStr, 10);
      if (!isNaN(seq) && seq > maxSeq) {
        maxSeq = seq;
      }
    }

    // Создаём единицы в транзакции
    const createdUnits = await prisma.$transaction(async (tx) => {
      const units = [];
      for (let i = 0; i < body.count; i++) {
        const seqNum = maxSeq + i + 1;
        const barcode = generateBarcodeId(equipment.name, equipment.category, seqNum);

        // Создаём запись без barcodePayload, чтобы получить id
        const unit = await tx.equipmentUnit.create({
          data: {
            equipmentId,
            serialNumber: body.serialNumbers?.[i] ?? null,
            barcode,
          },
        });

        // Генерируем HMAC-подписанный payload с реальным id
        const barcodePayload = generateBarcodePayload(unit.id);
        const updatedUnit = await tx.equipmentUnit.update({
          where: { id: unit.id },
          data: { barcodePayload },
          select: {
            id: true,
            status: true,
            serialNumber: true,
            barcode: true,
            barcodePayload: true,
            comment: true,
            createdAt: true,
          },
        });
        units.push(updatedUnit);
      }
      return units;
    });

    res.status(201).json({ units: createdUnits });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────
// GET /labels — PDF с этикетками для всех единиц
// ──────────────────────────────────────────────

router.get("/labels", async (req, res, next) => {
  try {
    const { equipmentId } = req.params;

    const equipment = await prisma.equipment.findUnique({
      where: { id: equipmentId },
      select: { name: true, category: true },
    });
    if (!equipment) {
      throw new HttpError(404, "Оборудование не найдено");
    }

    const units = await prisma.equipmentUnit.findMany({
      where: { equipmentId, barcode: { not: null } },
      select: { barcode: true, barcodePayload: true },
      orderBy: { createdAt: "asc" },
    });

    if (units.length === 0) {
      throw new HttpError(404, "Нет единиц со штрихкодами для данного оборудования");
    }

    const labelUnits = units
      .filter((u): u is { barcode: string; barcodePayload: string | null } => u.barcode !== null)
      .filter((u): u is { barcode: string; barcodePayload: string } => u.barcodePayload !== null)
      .map((u) => ({
        barcode: u.barcode,
        barcodePayload: u.barcodePayload,
        equipment: { name: equipment.name, category: equipment.category },
      }));

    const pdfBuffer = await renderLabelsPdf(labelUnits);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="labels-${equipmentId}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────
// PATCH /:unitId — обновление единицы
// ──────────────────────────────────────────────

router.patch("/:unitId", async (req, res, next) => {
  try {
    const { equipmentId, unitId } = req.params;
    const body = patchSchema.parse(req.body);

    const existing = await prisma.equipmentUnit.findFirst({
      where: { id: unitId, equipmentId },
    });
    if (!existing) {
      throw new HttpError(404, "Единица оборудования не найдена");
    }

    const updated = await prisma.equipmentUnit.update({
      where: { id: unitId },
      data: {
        serialNumber: body.serialNumber === undefined ? undefined : body.serialNumber,
        status: body.status,
        comment: body.comment === undefined ? undefined : body.comment,
      },
      select: {
        id: true,
        status: true,
        serialNumber: true,
        barcode: true,
        barcodePayload: true,
        comment: true,
        createdAt: true,
      },
    });

    res.json({ unit: updated });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────
// DELETE /:unitId — удаление единицы (только AVAILABLE)
// ──────────────────────────────────────────────

router.delete("/:unitId", async (req, res, next) => {
  try {
    const { equipmentId, unitId } = req.params;

    const unit = await prisma.equipmentUnit.findFirst({
      where: { id: unitId, equipmentId },
      select: { id: true, status: true },
    });
    if (!unit) {
      throw new HttpError(404, "Единица оборудования не найдена");
    }
    if (unit.status !== "AVAILABLE") {
      return res.status(409).json({
        message: "Нельзя удалить единицу со статусом отличным от AVAILABLE",
      });
    }

    await prisma.equipmentUnit.delete({ where: { id: unitId } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────
// GET /:unitId/label — PNG-этикетка для одной единицы
// ──────────────────────────────────────────────

router.get("/:unitId/label", async (req, res, next) => {
  try {
    const { equipmentId, unitId } = req.params;

    const unit = await prisma.equipmentUnit.findFirst({
      where: { id: unitId, equipmentId },
      select: {
        barcode: true,
        barcodePayload: true,
        equipment: { select: { name: true, category: true } },
      },
    });
    if (!unit) {
      throw new HttpError(404, "Единица оборудования не найдена");
    }
    if (!unit.barcode) {
      throw new HttpError(404, "У единицы отсутствует штрихкод");
    }
    if (!unit.barcodePayload) {
      throw new HttpError(404, "У единицы отсутствует payload штрихкода");
    }

    const pngBuffer = await renderLabelPng({
      barcode: unit.barcode,
      barcodePayload: unit.barcodePayload,
      equipment: { name: unit.equipment.name, category: unit.equipment.category },
    });

    res.setHeader("Content-Type", "image/png");
    res.send(pngBuffer);
  } catch (err) {
    next(err);
  }
});

export { router as equipmentUnitsRouter };
