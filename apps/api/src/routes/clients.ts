import express from "express";

import { rolesGuard } from "../middleware/rolesGuard";
import { getClientStats } from "../services/clientStats";

const router = express.Router();

/**
 * GET /api/clients/:id/stats
 * Статистика клиента для экрана согласования брони.
 * Доступ: SUPER_ADMIN, WAREHOUSE.
 */
router.get(
  "/:id/stats",
  rolesGuard(["SUPER_ADMIN", "WAREHOUSE"]),
  async (req, res, next) => {
    try {
      const stats = await getClientStats(req.params.id);
      res.json(stats);
    } catch (err) {
      next(err);
    }
  }
);

export { router as clientsRouter };
