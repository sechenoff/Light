import express from "express";
import { z } from "zod";
import { prisma } from "../prisma";
import { resolveBarcode, renderLabelsPdf } from "../services/barcode";
import { HttpError } from "../utils/errors";

const router = express.Router();

// ──────────────────────────────────────────────
// GET / — кросс-каталожный список единиц с пагинацией и фильтрами
// ──────────────────────────────────────────────

router.get("/", async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string) || 50));
    const skip = (page - 1) * limit;

    const where: any = {};

    if (req.query.search) {
      const search = String(req.query.search);
      where.OR = [
        { barcode: { contains: search } },
        { serialNumber: { contains: search } },
        { equipment: { name: { contains: search } } },
      ];
    }
    if (req.query.status) {
      where.status = String(req.query.status);
    }
    if (req.query.category) {
      where.equipment = { ...where.equipment, category: String(req.query.category) };
    }
    if (req.query.hasBarcode === "true") {
      where.barcode = { not: null };
    } else if (req.query.hasBarcode === "false") {
      where.barcode = null;
    }

    const [units, total] = await Promise.all([
      prisma.equipmentUnit.findMany({
        where,
        include: {
          equipment: { select: { id: true, name: true, category: true, brand: true, model: true } },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.equipmentUnit.count({ where }),
    ]);

    res.json({
      units: units.map(u => ({
        id: u.id,
        barcode: u.barcode,
        barcodePayload: u.barcodePayload,
        status: u.status,
        serialNumber: u.serialNumber,
        comment: u.comment,
        createdAt: u.createdAt,
        equipment: u.equipment,
      })),
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────
// GET /lookup — поиск единицы по штрихкоду через resolveBarcode
// ──────────────────────────────────────────────

router.get("/lookup", async (req, res, next) => {
  try {
    const barcode = String(req.query.barcode || "");
    if (!barcode) {
      throw new HttpError(400, "Параметр barcode обязателен");
    }

    const resolved = await resolveBarcode(barcode);
    if (!resolved) {
      throw new HttpError(404, "Единица не найдена");
    }

    const unit = await prisma.equipmentUnit.findUnique({
      where: { id: resolved.unitId },
      include: {
        equipment: { select: { id: true, name: true, category: true, brand: true, model: true } },
      },
    });
    if (!unit) {
      throw new HttpError(404, "Единица не найдена");
    }

    res.json({
      unit: {
        id: unit.id,
        barcode: unit.barcode,
        barcodePayload: unit.barcodePayload,
        status: unit.status,
        serialNumber: unit.serialNumber,
        comment: unit.comment,
        createdAt: unit.createdAt,
      },
      equipment: unit.equipment,
      hmacVerified: resolved.hmacVerified,
    });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────
// POST /labels — пакетная генерация PDF-этикеток
// ──────────────────────────────────────────────

router.post("/labels", async (req, res, next) => {
  try {
    const body = z.object({ unitIds: z.array(z.string()).min(1).max(100) }).parse(req.body);

    const units = await prisma.equipmentUnit.findMany({
      where: { id: { in: body.unitIds } },
      include: {
        equipment: { select: { name: true, category: true } },
      },
    });

    // Отфильтровываем единицы без штрихкода или barcodePayload
    const labelUnits = units
      .filter(u => u.barcode && u.barcodePayload)
      .map(u => ({
        barcode: u.barcode!,
        barcodePayload: u.barcodePayload!,
        equipment: { name: u.equipment.name, category: u.equipment.category },
      }));

    if (labelUnits.length === 0) {
      throw new HttpError(404, "Нет единиц с штрихкодами для печати");
    }

    const pdfBuffer = await renderLabelsPdf(labelUnits);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="labels.pdf"');
    res.send(pdfBuffer);
  } catch (err) {
    next(err);
  }
});

export { router as equipmentUnitsGlobalRouter };
