/**
 * Роутер /api/gaffer/payments — CRUD платежей Gaffer CRM.
 *
 * GET    /       — список с фильтрами
 * POST   /       — создать
 * PATCH  /:id    — обновить
 * DELETE /:id    — удалить
 */

import express from "express";
import { z } from "zod";
import {
  listPayments,
  createPayment,
  updatePayment,
  deletePayment,
} from "../../services/gaffer/gafferPaymentService";

const router = express.Router();

// ─── Zod-схемы ───────────────────────────────────────────────────────────────

const listQuerySchema = z.object({
  projectId: z.string().optional(),
  memberContactId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

const createPaymentSchema = z.object({
  projectId: z.string().min(1, "Проект обязателен"),
  direction: z.enum(["IN", "OUT"]),
  amount: z.union([z.string(), z.number()]),
  paidAt: z.string().min(1, "Дата платежа обязательна"),
  paymentMethodId: z.string().optional(),
  memberId: z.string().optional(),
  comment: z.string().trim().max(500).optional(),
});

const updatePaymentSchema = z.object({
  amount: z.union([z.string(), z.number()]).optional(),
  paidAt: z.string().optional(),
  paymentMethodId: z.string().nullable().optional(),
  comment: z.string().trim().max(500).nullable().optional(),
});

// ─── Маршруты ─────────────────────────────────────────────────────────────────

/**
 * GET /api/gaffer/payments
 */
router.get("/", async (req, res, next) => {
  try {
    const query = listQuerySchema.parse(req.query);
    const items = await listPayments(req, query);
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/gaffer/payments
 */
router.post("/", async (req, res, next) => {
  try {
    const body = createPaymentSchema.parse(req.body);
    const payment = await createPayment(req, body);
    res.json({ payment });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/gaffer/payments/:id
 */
router.patch("/:id", async (req, res, next) => {
  try {
    const body = updatePaymentSchema.parse(req.body);
    const payment = await updatePayment(req, req.params.id, body);
    res.json({ payment });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/gaffer/payments/:id
 */
router.delete("/:id", async (req, res, next) => {
  try {
    await deletePayment(req, req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export { router as paymentsRouter };
