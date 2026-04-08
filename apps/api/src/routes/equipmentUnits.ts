import express from "express";
import { z } from "zod";

import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";
import { generateBarcodeId, generateBarcodePayload, renderLabelPng, renderLabelsPdf } from "../services/barcode";

type UnitParams = { equipmentId: string; unitId?: string };
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

const assignBarcodeSchema = z.object({
  barcode: z.string().min(1).max(100).transform(s => s.trim()).refine(s => !s.includes(':'), { message: "Штрихкод не должен содержать двоеточие" }),
  force: z.boolean().optional().default(false),
});

// ──────────────────────────────────────────────
// GET / — список единиц оборудования
// ──────────────────────────────────────────────

router.get("/", async (req, res, next) => {
  try {
    const { equipmentId } = req.params as UnitParams;
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
    const { equipmentId } = req.params as UnitParams;
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
    const { equipmentId } = req.params as UnitParams;

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
// POST /:unitId/assign-barcode — ручная привязка штрихкода к единице
// ──────────────────────────────────────────────

router.post("/:unitId/assign-barcode", async (req, res, next) => {
  try {
    const { equipmentId, unitId } = req.params as UnitParams;
    const body = assignBarcodeSchema.parse(req.body);

    // Check unit exists and belongs to equipment
    const unit = await prisma.equipmentUnit.findFirst({
      where: { id: unitId, equipmentId },
    });
    if (!unit) {
      throw new HttpError(404, "Единица оборудования не найдена");
    }

    // Check if unit already has barcode (unless force)
    if (unit.barcode && !body.force) {
      return res.status(409).json({ error: "У единицы уже есть штрихкод. Используйте force: true для перезаписи" });
    }

    // Check barcode uniqueness
    const existing = await prisma.equipmentUnit.findFirst({
      where: { barcode: body.barcode, id: { not: unitId } },
      include: { equipment: { select: { id: true, name: true } } },
    });
    if (existing) {
      return res.status(409).json({
        error: "Штрихкод уже присвоен другой единице",
        existingUnit: { id: existing.id, equipmentId: existing.equipment.id, equipmentName: existing.equipment.name },
      });
    }

    // Assign barcode + generate HMAC payload
    const barcodePayload = generateBarcodePayload(unitId);
    const updated = await prisma.equipmentUnit.update({
      where: { id: unitId },
      data: { barcode: body.barcode, barcodePayload },
      select: { id: true, barcode: true, barcodePayload: true, status: true, serialNumber: true, comment: true, createdAt: true },
    });

    res.json({ unit: updated });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────
// POST /batch-assign — создание единицы с штрихкодом (UNIT-режим)
// ──────────────────────────────────────────────

router.post("/batch-assign", async (req, res, next) => {
  try {
    const { equipmentId } = req.params as UnitParams;
    const body = assignBarcodeSchema.parse(req.body);

    // Check equipment exists and is UNIT mode
    const equipment = await prisma.equipment.findUnique({
      where: { id: equipmentId },
      select: { id: true, name: true, category: true, stockTrackingMode: true },
    });
    if (!equipment) {
      throw new HttpError(404, "Оборудование не найдено");
    }
    if (equipment.stockTrackingMode === "COUNT") {
      return res.status(400).json({ error: "Для привязки штрихкодов переведите оборудование в режим UNIT" });
    }

    // Check barcode uniqueness
    const existing = await prisma.equipmentUnit.findFirst({
      where: { barcode: body.barcode },
      include: { equipment: { select: { id: true, name: true } } },
    });
    if (existing) {
      return res.status(409).json({
        error: "Штрихкод уже присвоен другой единице",
        existingUnit: { id: existing.id, equipmentId: existing.equipment.id, equipmentName: existing.equipment.name },
      });
    }

    // Create unit + assign barcode + increment totalQuantity in transaction
    const result = await prisma.$transaction(async (tx: any) => {
      const unit = await tx.equipmentUnit.create({
        data: { equipmentId, barcode: body.barcode, status: "AVAILABLE" },
      });
      const barcodePayload = generateBarcodePayload(unit.id);
      const updated = await tx.equipmentUnit.update({
        where: { id: unit.id },
        data: { barcodePayload },
        select: { id: true, barcode: true, barcodePayload: true, status: true, serialNumber: true, comment: true, createdAt: true },
      });
      await tx.equipment.update({
        where: { id: equipmentId },
        data: { totalQuantity: { increment: 1 } },
      });
      return updated;
    });

    res.status(201).json({ unit: result });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────
// PATCH /:unitId — обновление единицы
// ──────────────────────────────────────────────

router.patch("/:unitId", async (req, res, next) => {
  try {
    const { equipmentId, unitId } = req.params as UnitParams;
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
    const { equipmentId, unitId } = req.params as UnitParams;

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
    const { equipmentId, unitId } = req.params as UnitParams;

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
