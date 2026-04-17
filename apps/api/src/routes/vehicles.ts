import express from "express";
import { z } from "zod";
import Decimal from "decimal.js";

import { prisma } from "../prisma";
import { rolesGuard } from "../middleware/rolesGuard";
import { HttpError } from "../utils/errors";
import { writeAuditEntry } from "../services/audit";

const router = express.Router();

// ── GET /api/vehicles — публичный список активных машин (все аутентифицированные роли) ──
router.get("/", async (_req, res, next) => {
  try {
    const vehicles = await prisma.vehicle.findMany({
      where: { active: true },
      orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
      select: {
        id: true,
        slug: true,
        name: true,
        shiftPriceRub: true,
        hasGeneratorOption: true,
        generatorPriceRub: true,
        shiftHours: true,
        overtimePercent: true,
        displayOrder: true,
      },
    });

    res.json({
      vehicles: vehicles.map((v) => ({
        ...v,
        shiftPriceRub: new Decimal(v.shiftPriceRub.toString()).toFixed(2),
        generatorPriceRub: v.generatorPriceRub != null ? new Decimal(v.generatorPriceRub.toString()).toFixed(2) : null,
        overtimePercent: new Decimal(v.overtimePercent.toString()).toFixed(2),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/admin/vehicles — все машины включая неактивные (SUPER_ADMIN) ──
router.get("/admin", rolesGuard(["SUPER_ADMIN"]), async (_req, res, next) => {
  try {
    const vehicles = await prisma.vehicle.findMany({
      orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
    });

    res.json({
      vehicles: vehicles.map((v) => ({
        ...v,
        shiftPriceRub: new Decimal(v.shiftPriceRub.toString()).toFixed(2),
        generatorPriceRub: v.generatorPriceRub != null ? new Decimal(v.generatorPriceRub.toString()).toFixed(2) : null,
        overtimePercent: new Decimal(v.overtimePercent.toString()).toFixed(2),
      })),
    });
  } catch (err) {
    next(err);
  }
});

const vehiclePatchSchema = z.object({
  shiftPriceRub: z.number().positive().optional(),
  generatorPriceRub: z.number().positive().nullable().optional(),
  shiftHours: z.number().int().positive().optional(),
  overtimePercent: z.number().min(0).max(100).optional(),
  active: z.boolean().optional(),
  displayOrder: z.number().int().min(0).optional(),
  // slug and hasGeneratorOption are immutable — silently ignored if passed
});

// ── PATCH /api/admin/vehicles/:id — редактировать (SUPER_ADMIN) ──
router.patch("/admin/:id", rolesGuard(["SUPER_ADMIN"]), async (req, res, next) => {
  try {
    const id = req.params.id;
    const body = vehiclePatchSchema.parse(req.body);
    const userId = req.adminUser!.userId;

    const existing = await prisma.vehicle.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, "Vehicle not found");

    const updateData: Record<string, unknown> = {};
    if (body.shiftPriceRub !== undefined) updateData.shiftPriceRub = new Decimal(body.shiftPriceRub).toFixed(2);
    if (body.generatorPriceRub !== undefined) updateData.generatorPriceRub = body.generatorPriceRub != null ? new Decimal(body.generatorPriceRub).toFixed(2) : null;
    if (body.shiftHours !== undefined) updateData.shiftHours = body.shiftHours;
    if (body.overtimePercent !== undefined) updateData.overtimePercent = new Decimal(body.overtimePercent).toFixed(2);
    if (body.active !== undefined) updateData.active = body.active;
    if (body.displayOrder !== undefined) updateData.displayOrder = body.displayOrder;

    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.vehicle.update({
        where: { id },
        data: updateData,
      });

      await writeAuditEntry({
        tx,
        userId,
        action: "VEHICLE_UPDATED",
        entityType: "Vehicle",
        entityId: id,
        before: {
          shiftPriceRub: existing.shiftPriceRub.toString(),
          generatorPriceRub: existing.generatorPriceRub?.toString() ?? null,
          shiftHours: existing.shiftHours,
          overtimePercent: existing.overtimePercent.toString(),
          active: existing.active,
          displayOrder: existing.displayOrder,
        },
        after: {
          shiftPriceRub: result.shiftPriceRub.toString(),
          generatorPriceRub: result.generatorPriceRub?.toString() ?? null,
          shiftHours: result.shiftHours,
          overtimePercent: result.overtimePercent.toString(),
          active: result.active,
          displayOrder: result.displayOrder,
        },
      });

      return result;
    });

    res.json({
      vehicle: {
        ...updated,
        shiftPriceRub: new Decimal(updated.shiftPriceRub.toString()).toFixed(2),
        generatorPriceRub: updated.generatorPriceRub != null ? new Decimal(updated.generatorPriceRub.toString()).toFixed(2) : null,
        overtimePercent: new Decimal(updated.overtimePercent.toString()).toFixed(2),
      },
    });
  } catch (err) {
    next(err);
  }
});

export { router as vehiclesRouter };
