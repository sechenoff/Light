import express from "express";
import { z } from "zod";
import { rolesGuard } from "../middleware/rolesGuard";
import { createRefund, listRefunds } from "../services/refundService";

const router = express.Router();

const paymentMethodEnum = z.enum(["CASH", "BANK_TRANSFER", "CARD", "OTHER"]);

const createSchema = z.object({
  invoiceId: z.string().optional(),
  paymentId: z.string().optional(),
  bookingId: z.string().optional(),
  amount: z.number().positive(),
  reason: z.string().min(3, "Причина обязательна (минимум 3 символа)"),
  method: paymentMethodEnum,
  refundedAt: z.string().datetime().optional(),
});

/**
 * POST /api/refunds — SA only
 * Записать возврат денег клиенту.
 */
router.post("/", rolesGuard(["SUPER_ADMIN"]), async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body);
    const userId = req.adminUser!.userId;

    const refund = await createRefund(
      {
        invoiceId: body.invoiceId,
        paymentId: body.paymentId,
        bookingId: body.bookingId,
        amount: body.amount,
        reason: body.reason,
        method: body.method,
        refundedAt: body.refundedAt ? new Date(body.refundedAt) : undefined,
      },
      userId,
    );

    res.status(201).json(refund);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/refunds — SA + WH (read)
 * Список возвратов с опциональными фильтрами.
 */
router.get("/", rolesGuard(["SUPER_ADMIN", "WAREHOUSE"]), async (req, res, next) => {
  try {
    const { invoiceId, bookingId, limit, offset } = req.query;

    const result = await listRefunds({
      invoiceId: invoiceId as string | undefined,
      bookingId: bookingId as string | undefined,
      limit: parseInt(limit as string) || undefined,
      offset: parseInt(offset as string) || undefined,
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

export { router as refundsRouter };
