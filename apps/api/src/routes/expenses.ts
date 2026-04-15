import { Router } from "express";
import { z } from "zod";
import type { UserRole } from "@prisma/client";

import { rolesGuard } from "../middleware/rolesGuard";
import * as expenseService from "../services/expenseService";

const router = Router();

const EXPENSE_CATEGORIES = [
  "TRANSPORT", "EQUIPMENT", "CONTRACTORS", "STAFF",
  "RENT", "REPAIR", "PAYROLL", "PURCHASE", "OTHER",
] as const;

const createSchema = z.object({
  date: z.string().datetime(),
  category: z.enum(EXPENSE_CATEGORIES),
  amount: z.coerce.number().positive(),
  description: z.string().min(1),
  documentUrl: z.string().url().optional(),
  linkedBookingId: z.string().optional(),
  linkedRepairId: z.string().optional(),
});

const patchSchema = createSchema.partial();

const listQuerySchema = z.object({
  category: z.enum(EXPENSE_CATEGORIES).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  linkedBookingId: z.string().optional(),
  approvedOnly: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  offset: z.coerce.number().min(0).optional(),
});

// POST — SUPER_ADMIN + TECHNICIAN
router.post("/", rolesGuard(["SUPER_ADMIN", "TECHNICIAN"]), async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body);
    const userId = req.adminUser!.userId;
    const userRole = req.adminUser!.role as UserRole;
    const expense = await expenseService.createExpense({
      date: new Date(body.date),
      category: body.category,
      amount: body.amount,
      description: body.description,
      documentUrl: body.documentUrl,
      linkedBookingId: body.linkedBookingId,
      linkedRepairId: body.linkedRepairId,
      createdBy: userId,
      creatorRole: userRole,
    });
    res.status(201).json({ expense: { ...expense, amount: expense.amount.toString() } });
  } catch (err) {
    next(err);
  }
});

// GET, PATCH, DELETE — SUPER_ADMIN only
router.get("/", rolesGuard(["SUPER_ADMIN"]), async (req, res, next) => {
  try {
    const query = listQuerySchema.parse(req.query);
    const result = await expenseService.listExpenses({
      ...query,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      approvedOnly: query.approvedOnly === "true",
    });
    res.json({
      items: result.items.map((e) => ({ ...e, amount: e.amount.toString() })),
      total: result.total,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", rolesGuard(["SUPER_ADMIN"]), async (req, res, next) => {
  try {
    const { prisma } = await import("../prisma");
    const expense = await prisma.expense.findUniqueOrThrow({
      where: { id: req.params.id },
      include: {
        booking: { select: { id: true, projectName: true } },
        linkedRepair: { select: { id: true } },
      },
    });
    res.json({ expense: { ...expense, amount: expense.amount.toString() } });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/approve", rolesGuard(["SUPER_ADMIN"]), async (req, res, next) => {
  try {
    const userId = req.adminUser!.userId;
    const expense = await expenseService.approveExpense(req.params.id, userId);
    res.json({ expense: { ...expense, amount: expense.amount.toString() } });
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", rolesGuard(["SUPER_ADMIN"]), async (req, res, next) => {
  try {
    const body = patchSchema.parse(req.body);
    const userId = req.adminUser!.userId;
    const patch: Partial<expenseService.CreateExpenseArgs> = {};
    if (body.date !== undefined) patch.date = new Date(body.date);
    if (body.category !== undefined) patch.category = body.category;
    if (body.amount !== undefined) patch.amount = body.amount;
    if (body.description !== undefined) patch.description = body.description;
    if (body.documentUrl !== undefined) patch.documentUrl = body.documentUrl;
    const expense = await expenseService.updateExpense(req.params.id, patch, userId);
    res.json({ expense: { ...expense, amount: expense.amount.toString() } });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", rolesGuard(["SUPER_ADMIN"]), async (req, res, next) => {
  try {
    const userId = req.adminUser!.userId;
    await expenseService.deleteExpense(req.params.id, userId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export { router as expensesRouter };
