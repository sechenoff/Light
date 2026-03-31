import express from "express";
import { z } from "zod";

import { equipmentRouter } from "./equipment";
import { availabilityRouter } from "./availability";
import { bookingsRouter } from "./bookings";
import { equipmentImportRouter } from "./equipmentImport";
import { estimatesRouter } from "./estimates";
import { financeRouter } from "./finance";
import { pricelistRouter } from "./pricelist";
import { setCategoryOrder } from "../services/categoryOrder";
import { photoAnalysisRouter } from "./photoAnalysis";
import { usersRouter } from "./users";
import { analysesRouter } from "./analyses";

const router = express.Router();

/**
 * Явный маршрут на корневом router (до router.use("/api/equipment")) — на некоторых связках
 * вложенный equipmentRouter не получал POST …/reorder/categories и отдавал 404.
 */
router.post("/api/equipment/reorder/categories", async (req, res, next) => {
  try {
    const body = z.object({ categories: z.array(z.string()) }).parse(req.body);
    const categories = await setCategoryOrder(body.categories);
    res.json({ categories });
  } catch (err) {
    next(err);
  }
});

// Более длинный префикс раньше короткого /api/equipment, иначе import уезжает в equipmentRouter.
router.use("/api/equipment/import", equipmentImportRouter);
router.use("/api/equipment", equipmentRouter);
router.use("/api/availability", availabilityRouter);
router.use("/api/bookings", bookingsRouter);
router.use("/api/estimates", estimatesRouter);
router.use("/api/pricelist", pricelistRouter);
router.use("/api", financeRouter);
router.use("/api/photo-analysis", photoAnalysisRouter);
router.use("/api/users", usersRouter);
router.use("/api/analyses", analysesRouter);

export { router };

