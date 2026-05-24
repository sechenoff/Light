import express from "express";
import { z } from "zod";

import { prisma } from "../prisma";
import { computeEquipmentStats, type PeriodDays } from "../services/equipmentStats";

const router = express.Router();

const querySchema = z.object({
  period: z.enum(["30", "90", "365"]).optional(),
});

/**
 * GET /api/equipment-stats?period=30|90|365
 * Returns KPI hero + four ranked sections + master-table dataset.
 * Default period: 90 days. SUPER_ADMIN only (gated at router mount).
 */
router.get("/", async (req, res, next) => {
  try {
    const q = querySchema.parse(req.query);
    const periodDays: PeriodDays = q.period ? (Number(q.period) as PeriodDays) : 90;
    const payload = await computeEquipmentStats(periodDays, prisma);
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

export { router as equipmentStatsRouter };
