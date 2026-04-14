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
import { bookingRequestParserRouter } from "./bookingRequestParser";
import { slangLearningRouter } from "./slangLearning";
import { warehouseRouter } from "./warehouse";
import { equipmentUnitsRouter } from "./equipmentUnits";
import { equipmentUnitsGlobalRouter } from "./equipmentUnitsGlobal";
import { importSessionsRouter } from "./importSessions";
import { dashboardRouter } from "./dashboard";
import { calendarRouter } from "./calendar";
import { adminUsersRouter } from "./adminUsers";

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
router.use("/api/equipment-units", equipmentUnitsGlobalRouter);
router.use("/api/equipment/import", equipmentImportRouter);
router.use("/api/equipment/:equipmentId/units", equipmentUnitsRouter);
router.use("/api/equipment", equipmentRouter);
router.use("/api/availability", availabilityRouter);
router.use("/api/bookings", bookingsRouter);
router.use("/api/import-sessions", importSessionsRouter);
router.use("/api/estimates", estimatesRouter);
router.use("/api/pricelist", pricelistRouter);
router.use("/api", financeRouter);
router.use("/api/photo-analysis", photoAnalysisRouter);
router.use("/api/users", usersRouter);
router.use("/api/analyses", analysesRouter);
router.use("/api/bookings", bookingRequestParserRouter);
router.use("/api/admin/slang-learning", slangLearningRouter);
router.use("/api/warehouse", warehouseRouter);
router.use("/api/dashboard", dashboardRouter);
router.use("/api/calendar", calendarRouter);
router.use("/api/admin-users", adminUsersRouter);

export { router };

