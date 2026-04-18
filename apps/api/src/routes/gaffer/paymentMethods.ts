/**
 * Роутер /api/gaffer/payment-methods — CRUD способов оплаты Gaffer CRM.
 *
 * GET    /          — список
 * POST   /          — создать
 * PATCH  /:id       — обновить
 * DELETE /:id       — удалить
 * POST   /reorder   — переупорядочить
 */

import express from "express";
import { z } from "zod";
import {
  listPaymentMethods,
  createPaymentMethod,
  updatePaymentMethod,
  deletePaymentMethod,
  reorderPaymentMethods,
} from "../../services/gaffer/paymentMethodService";

const router = express.Router();

// ─── Zod-схемы ───────────────────────────────────────────────────────────────

const createPaymentMethodSchema = z.object({
  name: z.string().trim().min(1, "Название обязательно").max(50),
  isDefault: z.boolean().optional(),
});

const updatePaymentMethodSchema = z.object({
  name: z.string().trim().min(1).max(50).optional(),
  isDefault: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
});

const reorderSchema = z.object({
  ids: z.array(z.string().min(1)),
});

// ─── Маршруты ─────────────────────────────────────────────────────────────────

/**
 * GET /api/gaffer/payment-methods
 */
router.get("/", async (req, res, next) => {
  try {
    const items = await listPaymentMethods(req);
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/gaffer/payment-methods/reorder
 * Должен быть до /:id чтобы "reorder" не интерпретировалось как id.
 */
router.post("/reorder", async (req, res, next) => {
  try {
    const { ids } = reorderSchema.parse(req.body);
    await reorderPaymentMethods(req, ids);
    const items = await listPaymentMethods(req);
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/gaffer/payment-methods
 */
router.post("/", async (req, res, next) => {
  try {
    const body = createPaymentMethodSchema.parse(req.body);
    const item = await createPaymentMethod(req, body);
    res.json({ item });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/gaffer/payment-methods/:id
 */
router.patch("/:id", async (req, res, next) => {
  try {
    const body = updatePaymentMethodSchema.parse(req.body);
    const item = await updatePaymentMethod(req, req.params.id, body);
    res.json({ item });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/gaffer/payment-methods/:id
 */
router.delete("/:id", async (req, res, next) => {
  try {
    await deletePaymentMethod(req, req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export { router as paymentMethodsRouter };
