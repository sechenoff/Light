import express from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";

import { prisma } from "../prisma";
import { getMergedCategoryOrder } from "../services/categoryOrder";
import { compareEquipmentTransportLast } from "../utils/equipmentSort";
import { rolesGuard } from "../middleware/rolesGuard";

const querySchema = z.object({
  search: z.string().optional(),
  category: z.string().optional(),
});

const equipmentCreateSchema = z.object({
  category: z.string().min(1),
  name: z.string().min(1),
  brand: z.string().optional().nullable(),
  model: z.string().optional().nullable(),
  totalQuantity: z.number().int().min(0),
  stockTrackingMode: z.enum(["COUNT", "UNIT"]),
  rentalRatePerShift: z.number().min(0),
  rentalRateTwoShifts: z.number().min(0).optional().nullable(),
  rentalRatePerProject: z.number().min(0).optional().nullable(),
  comment: z.string().optional().nullable(),
});

const equipmentPatchSchema = equipmentCreateSchema.partial();

const router = express.Router();

router.get("/", async (req, res, next) => {
  try {
    const q = querySchema.parse(req.query);
    const categoryOrder = await getMergedCategoryOrder();

    const equipments = await prisma.equipment.findMany({
      where: {
        ...(q.category ? { category: q.category } : {}),
        ...(q.search
          ? {
              OR: [
                { name: { contains: q.search } },
                { brand: { contains: q.search } },
                { model: { contains: q.search } },
              ],
            }
          : {}),
      },
      orderBy: { id: "asc" },
      select: {
        id: true,
        sortOrder: true,
        category: true,
        name: true,
        brand: true,
        model: true,
        totalQuantity: true,
        stockTrackingMode: true,
        rentalRatePerShift: true,
        rentalRateTwoShifts: true,
        rentalRatePerProject: true,
        comment: true,
        units: { select: { status: true } },
      },
    });

    equipments.sort((a, b) => compareEquipmentTransportLast(a, b, categoryOrder));

    res.json({
      equipments: equipments.map((e) => {
        let unitStatusCounts: Record<string, number> | null = null;
        if (e.stockTrackingMode === "UNIT" && e.units.length > 0) {
          unitStatusCounts = {};
          for (const u of e.units) {
            unitStatusCounts[u.status] = (unitStatusCounts[u.status] ?? 0) + 1;
          }
        } else if (e.stockTrackingMode === "UNIT") {
          unitStatusCounts = {};
        }
        const { units: _units, ...rest } = e;
        return {
          ...rest,
          rentalRatePerShift: e.rentalRatePerShift.toString(),
          rentalRateTwoShifts: e.rentalRateTwoShifts?.toString() ?? null,
          rentalRatePerProject: e.rentalRatePerProject?.toString() ?? null,
          unitStatusCounts,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/categories", async (_req, res, next) => {
  try {
    const categories = await getMergedCategoryOrder();
    res.json({ categories });
  } catch (err) {
    next(err);
  }
});

router.post("/", rolesGuard(["SUPER_ADMIN", "WAREHOUSE"]), async (req, res, next) => {
  try {
    const body = equipmentCreateSchema.parse(req.body);
    const max = await prisma.equipment.aggregate({ _max: { sortOrder: true } });
    const nextSortOrder = (max._max.sortOrder ?? -1) + 1;
    const created = await prisma.equipment.create({
      data: {
        importKey: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        sortOrder: nextSortOrder,
        category: body.category.trim(),
        name: body.name.trim(),
        brand: body.brand?.trim() || null,
        model: body.model?.trim() || null,
        comment: body.comment?.trim() || null,
        totalQuantity: body.totalQuantity,
        stockTrackingMode: body.stockTrackingMode,
        rentalRatePerShift: body.rentalRatePerShift.toFixed(2),
        rentalRateTwoShifts: body.rentalRateTwoShifts == null ? null : body.rentalRateTwoShifts.toFixed(2),
        rentalRatePerProject: body.rentalRatePerProject == null ? null : body.rentalRatePerProject.toFixed(2),
      },
      select: {
        id: true,
        sortOrder: true,
        category: true,
        name: true,
        brand: true,
        model: true,
        totalQuantity: true,
        stockTrackingMode: true,
        rentalRatePerShift: true,
        rentalRateTwoShifts: true,
        rentalRatePerProject: true,
        comment: true,
      },
    });
    res.json({
      equipment: {
        ...created,
        rentalRatePerShift: created.rentalRatePerShift.toString(),
        rentalRateTwoShifts: created.rentalRateTwoShifts?.toString() ?? null,
        rentalRatePerProject: created.rentalRatePerProject?.toString() ?? null,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post("/reorder", async (req, res, next) => {
  try {
    const body = z.object({ ids: z.array(z.string()).min(1) }).parse(req.body);
    await prisma.$transaction(body.ids.map((id, index) => prisma.equipment.update({ where: { id }, data: { sortOrder: index } })));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** Сохранение порядка категорий (двухсегментный путь рядом с /reorder — надёжнее, чем POST …/categories/order на части окружений). */
router.patch("/:id", rolesGuard(["SUPER_ADMIN"]), async (req, res, next) => {
  try {
    const body = equipmentPatchSchema.parse(req.body);
    const updated = await prisma.equipment.update({
      where: { id: req.params.id },
      data: {
        category: body.category === undefined ? undefined : body.category.trim(),
        name: body.name === undefined ? undefined : body.name.trim(),
        brand: body.brand === undefined ? undefined : body.brand?.trim() || null,
        model: body.model === undefined ? undefined : body.model?.trim() || null,
        comment: body.comment === undefined ? undefined : body.comment?.trim() || null,
        totalQuantity: body.totalQuantity,
        stockTrackingMode: body.stockTrackingMode,
        rentalRatePerShift: body.rentalRatePerShift === undefined ? undefined : body.rentalRatePerShift.toFixed(2),
        rentalRateTwoShifts: body.rentalRateTwoShifts === undefined ? undefined : body.rentalRateTwoShifts == null ? null : body.rentalRateTwoShifts.toFixed(2),
        rentalRatePerProject:
          body.rentalRatePerProject === undefined ? undefined : body.rentalRatePerProject == null ? null : body.rentalRatePerProject.toFixed(2),
      },
      select: {
        id: true,
        sortOrder: true,
        category: true,
        name: true,
        brand: true,
        model: true,
        totalQuantity: true,
        stockTrackingMode: true,
        rentalRatePerShift: true,
        rentalRateTwoShifts: true,
        rentalRatePerProject: true,
        comment: true,
      },
    });
    res.json({
      equipment: {
        ...updated,
        rentalRatePerShift: updated.rentalRatePerShift.toString(),
        rentalRateTwoShifts: updated.rentalRateTwoShifts?.toString() ?? null,
        rentalRatePerProject: updated.rentalRatePerProject?.toString() ?? null,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", rolesGuard(["SUPER_ADMIN"]), async (req, res, next) => {
  try {
    const id = req.params.id;
    const bookingCount = await prisma.bookingItem.count({ where: { equipmentId: id } });
    if (bookingCount > 0) {
      return res.status(409).json({
        message: `Нельзя удалить: позиция используется в ${bookingCount} бронировани${bookingCount === 1 ? "и" : bookingCount < 5 ? "ях" : "ях"}. Сначала удалите её из броней.`,
      });
    }
    await prisma.equipment.delete({ where: { id } });
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") {
      return res.status(409).json({ message: "Нельзя удалить: позиция используется в бронированиях." });
    }
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    const equipment = await prisma.equipment.findUnique({
      where: { id },
      select: {
        id: true,
        sortOrder: true,
        category: true,
        name: true,
        brand: true,
        model: true,
        totalQuantity: true,
        stockTrackingMode: true,
        rentalRatePerShift: true,
        rentalRateTwoShifts: true,
        rentalRatePerProject: true,
        comment: true,
      },
    });
    if (!equipment) return res.status(404).json({ message: "Equipment not found" });
    res.json({
      equipment: {
        ...equipment,
        rentalRatePerShift: equipment.rentalRatePerShift.toString(),
        rentalRateTwoShifts: equipment.rentalRateTwoShifts?.toString() ?? null,
        rentalRatePerProject: equipment.rentalRatePerProject?.toString() ?? null,
      },
    });
  } catch (err) {
    next(err);
  }
});

export { router as equipmentRouter };

