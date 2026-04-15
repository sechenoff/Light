import { Router } from "express";
import { z } from "zod";
import { Decimal } from "@prisma/client/runtime/library";

import { rolesGuard } from "../middleware/rolesGuard";
import * as paymentService from "../services/paymentService";

const router = Router();

// Все маршруты — только SUPER_ADMIN
router.use(rolesGuard(["SUPER_ADMIN"]));

const createSchema = z.object({
  bookingId: z.string().min(1),
  amount: z.coerce.number().positive(),
  method: z.enum(["CASH", "BANK_TRANSFER", "CARD", "OTHER"]),
  receivedAt: z.string().datetime(),
  note: z.string().optional(),
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

router.get("/", async (req, res, next) => {
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

router.post("/", async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body);
    const userId = req.adminUser!.userId;
    const payment = await paymentService.createPayment({
      bookingId: body.bookingId,
      amount: new Decimal(body.amount),
      method: body.method,
      receivedAt: new Date(body.receivedAt),
      note: body.note,
      createdBy: userId,
    });
    res.status(201).json({ payment: { ...payment, amount: payment.amount.toString() } });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const { prisma } = await import("../prisma");
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { id: req.params.id },
      include: { booking: { select: { id: true, projectName: true, client: { select: { id: true, name: true } } } } },
    });
    res.json({ payment: { ...payment, amount: payment.amount.toString() } });
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", async (req, res, next) => {
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

router.delete("/:id", async (req, res, next) => {
  try {
    const userId = req.adminUser!.userId;
    await paymentService.deletePayment(req.params.id, userId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export { router as paymentsRouter };
