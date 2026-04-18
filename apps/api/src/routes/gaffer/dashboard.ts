/**
 * Роутер /api/gaffer/dashboard
 *
 * GET / — агрегированные KPI, долги заказчиков и команды, мета.
 */

import express from "express";
import { getDashboard } from "../../services/gaffer/dashboardService";

const router = express.Router();

/**
 * GET /api/gaffer/dashboard
 */
router.get("/", async (req, res, next) => {
  try {
    const data = await getDashboard(req);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

export { router as dashboardRouter };
