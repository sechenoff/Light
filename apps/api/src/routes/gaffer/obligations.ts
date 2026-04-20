/**
 * Router /api/gaffer/obligations
 *
 * GET / — list all IN + OUT obligations across OPEN projects with filters.
 */

import express from "express";
import { z } from "zod";
import { listObligations } from "../../services/gaffer/obligationsService";

const router = express.Router();

const querySchema = z.object({
  direction: z.enum(["IN", "OUT"]).optional(),
  category: z.enum(["client", "crew", "rental"]).optional(),
  status: z.enum(["open", "partial", "paid", "overdue", "active"]).optional(),
  sort: z.enum(["dueAt", "remaining", "overdueDays"]).optional(),
});

/**
 * GET /api/gaffer/obligations
 */
router.get("/", async (req, res, next) => {
  try {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ message: "Неверные параметры запроса", errors: parsed.error.errors });
      return;
    }
    const result = await listObligations(req, parsed.data);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export { router as obligationsRouter };
