import { Router } from "express";
import { z } from "zod";
import { Decimal } from "decimal.js";

import { prisma } from "../prisma";
import { rolesGuard } from "../middleware/rolesGuard";
import * as paymentService from "../services/paymentService";

const router = Router();

// POST /api/payments — SUPER_ADMIN и WAREHOUSE (WAREHOUSE с ограничениями — см. validateWhLimits в paymentService)
// GET/PATCH/DELETE — только SUPER_ADMIN (применяется per-route ниже)
router.use(rolesGuard(["SUPER_ADMIN", "WAREHOUSE"]));

const createSchema = z.object({
  bookingId: z.string().min(1),
  amount: z.coerce.number().positive(),
  method: z.enum(["CASH", "BANK_TRANSFER", "CARD", "OTHER"]),
  receivedAt: z.string().datetime(),
  note: z.string().optional(),
  /** Привязать платёж к конкретному счёту Invoice. Счёт не должен быть аннулирован. */
  invoiceId: z.string().optional(),
});

const patchSchema = createSchema.partial().omit({ bookingId: true });

const listQuerySchema = z.object({
  bookingId: z.string().optional(),
  clientId: z.string().optional(),
  method: z.enum(["CASH", "BANK_TRANSFER", "CARD", "OTHER"]).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  offset: z.coerce.number().min(0).optional(),
});

// Чтение и список — только SUPER_ADMIN
router.get("/", rolesGuard(["SUPER_ADMIN"]), async (req, res, next) => {
  try {
    const query = listQuerySchema.parse(req.query);
    const result = await paymentService.listPayments({
      ...query,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
    });
    res.json({
      items: result.items.map((p) => ({ ...p, amount: p.amount.toString() })),
      total: result.total,
    });
  } catch (err) {
    next(err);
  }
});

// Создание платежа — SUPER_ADMIN и WAREHOUSE (ограничения проверяются в paymentService.validateWhLimits)
router.post("/", async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body);
    const userId = req.adminUser!.userId;
    const role = req.adminUser!.role;
    const payment = await paymentService.createPayment({
      bookingId: body.bookingId,
      amount: new Decimal(body.amount),
      method: body.method,
      receivedAt: new Date(body.receivedAt),
      note: body.note,
      createdBy: userId,
      creatorRole: role,
      invoiceId: body.invoiceId,
    });
    res.status(201).json({ payment: { ...payment, amount: payment.amount.toString() } });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", rolesGuard(["SUPER_ADMIN"]), async (req, res, next) => {
  try {
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { id: req.params.id },
      include: { booking: { select: { id: true, projectName: true, client: { select: { id: true, name: true } } } } },
    });
    res.json({ payment: { ...payment, amount: payment.amount.toString() } });
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", rolesGuard(["SUPER_ADMIN"]), async (req, res, next) => {
  try {
    const body = patchSchema.parse(req.body);
    const userId = req.adminUser!.userId;
    const patch: Partial<paymentService.CreatePaymentArgs> = {};
    if (body.amount !== undefined) patch.amount = body.amount;
    if (body.method !== undefined) patch.method = body.method;
    if (body.receivedAt !== undefined) patch.receivedAt = new Date(body.receivedAt);
    if (body.note !== undefined) patch.note = body.note;
    const payment = await paymentService.updatePayment(req.params.id, patch, userId);
    res.json({ payment: { ...payment, amount: payment.amount.toString() } });
  } catch (err) {
    next(err);
  }
});

const voidSchema = z.object({
  reason: z.string().trim().min(3),
});

/**
 * POST /api/payments/:id/void — SA only
 * Soft-void платежа с обязательной причиной.
 * Finance Phase 2 — новый паттерн. DELETE ниже — deprecated.
 */
router.post("/:id/void", rolesGuard(["SUPER_ADMIN"]), async (req, res, next) => {
  try {
    const userId = req.adminUser!.userId;
    const body = voidSchema.safeParse(req.body);
    const reason = body.success ? body.data.reason : "Аннулирован через POST /void";
    await paymentService.voidPayment(req.params.id, userId, reason);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/payments/:id — DEPRECATED
 * Перенаправляет на voidPayment. В Phase 3 будет удалён.
 */
router.delete("/:id", rolesGuard(["SUPER_ADMIN"]), async (req, res, next) => {
  try {
    console.warn("[DEPRECATED] DELETE /api/payments/:id вызван — используйте POST /api/payments/:id/void");
    const userId = req.adminUser!.userId;
    const body = voidSchema.safeParse(req.body);
    const reason = body.success ? body.data.reason : "Удалено через legacy DELETE endpoint";
    await paymentService.voidPayment(req.params.id, userId, reason);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export { router as paymentsRouter };
