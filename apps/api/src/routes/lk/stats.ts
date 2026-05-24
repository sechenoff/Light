import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../prisma";
import { lkAuth } from "../../middleware/lkAuth";
import { lkClientId } from "../../services/clientPortal/tenant";
import { computeLkStats, StatsPeriod } from "../../services/clientPortal/statsService";

const router = Router();

const querySchema = z.object({
  period: z.enum(["180d", "365d", "all"]).default("365d"),
});

router.get("/", lkAuth, async (req, res, next) => {
  try {
    const q = querySchema.parse(req.query);
    const stats = await computeLkStats(prisma, lkClientId(req), q.period as StatsPeriod);
    res.json(stats);
  } catch (err) {
    next(err);
  }
});

export default router;
