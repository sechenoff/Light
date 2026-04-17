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
import { slangLearningRouter, proposeAliasHandler } from "./slangLearning";
import { warehouseRouter } from "./warehouse";
import { equipmentUnitsRouter } from "./equipmentUnits";
import { equipmentUnitsGlobalRouter } from "./equipmentUnitsGlobal";
import { importSessionsRouter } from "./importSessions";
import { dashboardRouter } from "./dashboard";
import { calendarRouter } from "./calendar";
import { adminUsersRouter } from "./adminUsers";
import auditRouter from "./audit";
import { paymentsRouter } from "./payments";
import { expensesRouter } from "./expenses";
import { repairsRouter } from "./repairs";
import { clientsRouter } from "./clients";
import { rolesGuard } from "../middleware/rolesGuard";

const router = express.Router();

/**
 * Явный маршрут на корневом router (до router.use("/api/equipment")) — на некоторых связках
 * вложенный equipmentRouter не получал POST …/reorder/categories и отдавал 404.
 */
router.post("/api/equipment/reorder/categories", rolesGuard(["SUPER_ADMIN", "WAREHOUSE"]), async (req, res, next) => {
  try {
    const body = z.object({ categories: z.array(z.string()) }).parse(req.body);
    const categories = await setCategoryOrder(body.categories);
    res.json({ categories });
  } catch (err) {
    next(err);
  }
});

// Более длинный префикс раньше короткого /api/equipment, иначе import уезжает в equipmentRouter.
// /api/equipment-units — GET: все роли; PATCH: SUPER_ADMIN, WAREHOUSE
router.use("/api/equipment-units", equipmentUnitsGlobalRouter);

// /api/equipment/import — SUPER_ADMIN only
router.use("/api/equipment/import", rolesGuard(["SUPER_ADMIN"]), equipmentImportRouter);

// /api/equipment/:id/units — GET: все роли; POST/PATCH/DELETE: SUPER_ADMIN, WAREHOUSE (per-route guards в equipmentUnitsRouter)
router.use("/api/equipment/:equipmentId/units", equipmentUnitsRouter);

// /api/equipment — GET: все роли (SUPER_ADMIN, WAREHOUSE, TECHNICIAN); POST/PATCH/DELETE: per-route в equipmentRouter
router.use("/api/equipment", equipmentRouter);

// /api/availability — все роли
router.use("/api/availability", rolesGuard(["SUPER_ADMIN", "WAREHOUSE", "TECHNICIAN"]), availabilityRouter);

// /api/bookings — GET/POST: SUPER_ADMIN, WAREHOUSE; DELETE: SUPER_ADMIN (per-route в bookingsRouter)
router.use("/api/bookings", rolesGuard(["SUPER_ADMIN", "WAREHOUSE"]), bookingsRouter);

// /api/import-sessions — SUPER_ADMIN only
router.use("/api/import-sessions", rolesGuard(["SUPER_ADMIN"]), importSessionsRouter);

// /api/estimates — SUPER_ADMIN, WAREHOUSE
router.use("/api/estimates", rolesGuard(["SUPER_ADMIN", "WAREHOUSE"]), estimatesRouter);

// /api/pricelist — SUPER_ADMIN only
router.use("/api/pricelist", rolesGuard(["SUPER_ADMIN"]), pricelistRouter);

// /api/finance/... — SUPER_ADMIN only (guard внутри financeRouter)
router.use("/api", financeRouter);

// /api/photo-analysis — SUPER_ADMIN, WAREHOUSE
router.use("/api/photo-analysis", rolesGuard(["SUPER_ADMIN", "WAREHOUSE"]), photoAnalysisRouter);

// /api/users — только для web-auth (не adminUsers), доступ любой аутентифицированной сессии
router.use("/api/users", usersRouter);

// /api/analyses — SUPER_ADMIN, WAREHOUSE
router.use("/api/analyses", rolesGuard(["SUPER_ADMIN", "WAREHOUSE"]), analysesRouter);

// /api/bookings (parse-gaffer-review и match-equipment) — SUPER_ADMIN, WAREHOUSE
router.use("/api/bookings", rolesGuard(["SUPER_ADMIN", "WAREHOUSE"]), bookingRequestParserRouter);

// /api/admin/slang-learning/propose — SUPER_ADMIN + WAREHOUSE (warehouse users confirm AI matches)
// Must be mounted BEFORE the broader slangLearningRouter to take precedence
router.post(
  "/api/admin/slang-learning/propose",
  rolesGuard(["SUPER_ADMIN", "WAREHOUSE"]),
  proposeAliasHandler,
);
// /api/admin/slang-learning (rest) — SUPER_ADMIN only
router.use("/api/admin/slang-learning", rolesGuard(["SUPER_ADMIN"]), slangLearningRouter);

// /api/warehouse — обрабатывается отдельно в app.ts через warehousePublicRouter + warehouseScanRouter
router.use("/api/warehouse", warehouseRouter);

// /api/dashboard — SUPER_ADMIN, WAREHOUSE, TECHNICIAN
router.use("/api/dashboard", rolesGuard(["SUPER_ADMIN", "WAREHOUSE", "TECHNICIAN"]), dashboardRouter);

// /api/calendar — SUPER_ADMIN, WAREHOUSE
router.use("/api/calendar", rolesGuard(["SUPER_ADMIN", "WAREHOUSE"]), calendarRouter);

// /api/admin-users — SUPER_ADMIN only
router.use("/api/admin-users", rolesGuard(["SUPER_ADMIN"]), adminUsersRouter);

// /api/audit — SUPER_ADMIN only
router.use("/api/audit", auditRouter);

// /api/payments — SUPER_ADMIN only (роли проверяются внутри роутера)
router.use("/api/payments", paymentsRouter);

// /api/expenses — SUPER_ADMIN + TECHNICIAN POST; остальное — SUPER_ADMIN (роли проверяются внутри роутера)
router.use("/api/expenses", expensesRouter);

// /api/repairs — SUPER_ADMIN, WAREHOUSE, TECHNICIAN (роли проверяются внутри роутера per-route)
router.use("/api/repairs", repairsRouter);

// /api/clients — SUPER_ADMIN, WAREHOUSE (роль проверяется per-route)
router.use("/api/clients", clientsRouter);

export { router };
