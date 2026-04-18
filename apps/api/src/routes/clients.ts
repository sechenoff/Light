import express from "express";
import { z } from "zod";

import { prisma } from "../prisma";
import { rolesGuard } from "../middleware/rolesGuard";
import { getClientStats } from "../services/clientStats";

const router = express.Router();

const listQuerySchema = z.object({
  search: z.string().trim().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/**
 * GET /api/clients
 * Список клиентов для селектов/автокомплита.
 * Доступ: SUPER_ADMIN, WAREHOUSE.
 */
router.get("/", rolesGuard(["SUPER_ADMIN", "WAREHOUSE"]), async (req, res, next) => {
  try {
    const q = listQuerySchema.parse(req.query);
    const where = q.search
      ? { name: { contains: q.search } }
      : {};
    const clients = await prisma.client.findMany({
      where,
      select: { id: true, name: true },
      orderBy: { name: "asc" },
      take: q.limit,
    });
    res.json({ clients });
  } catch (err) {
    next(err);
  }
});

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
