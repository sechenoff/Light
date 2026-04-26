import { Router } from "express";
import { z } from "zod";
import type { UserRole } from "@prisma/client";
import multer from "multer";
import path from "path";
import fs from "fs";

import { prisma } from "../prisma";
import { rolesGuard } from "../middleware/rolesGuard";
import * as expenseService from "../services/expenseService";
import { HttpError } from "../utils/errors";

// ── B6: multer setup for expense document upload ──────────────────────────────

const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "application/pdf"]);
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

/**
 * Sanitise filename: strip path separators, keep ASCII + Cyrillic alphanum + safe chars.
 */
function sanitizeFilename(name: string): string {
  // Replace path separators and null bytes
  const base = path.basename(name).replace(/[\x00/\\]/g, "_");
  // Keep extension, sanitise rest
  const ext = path.extname(base);
  const stem = path.basename(base, ext).replace(/[^\wЀ-ӿ.-]/g, "_").slice(0, 100);
  return stem + ext;
}

const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("INVALID_FILE_TYPE"));
    }
  },
});

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

// ── B6: POST /api/expenses/:id/document ──────────────────────────────────────

router.post(
  "/:id/document",
  rolesGuard(["SUPER_ADMIN"]),
  (req, res, next) => {
    // Run multer middleware, convert its errors to HttpError
    documentUpload.single("document")(req, res, (err) => {
      if (err) {
        if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
          return next(new HttpError(413, "Файл превышает 5 МБ", "FILE_TOO_LARGE"));
        }
        if (err instanceof Error && err.message === "INVALID_FILE_TYPE") {
          return next(new HttpError(400, "Недопустимый тип файла. Разрешены: JPEG, PNG, PDF", "INVALID_FILE_TYPE"));
        }
        return next(err);
      }
      next();
    });
  },
  async (req, res, next) => {
    try {
      if (!req.file) {
        throw new HttpError(400, "Файл не приложен", "NO_FILE");
      }

      const expense = await prisma.expense.findUnique({ where: { id: req.params.id } });
      if (!expense) throw new HttpError(404, "Расход не найден", "EXPENSE_NOT_FOUND");

      // Delete previous file if exists
      if (expense.documentUrl) {
        // documentUrl stored as relative path from api root: /uploads/expenses/:id/:filename
        const existing = path.join(
          __dirname,
          "../..",
          expense.documentUrl.replace(/^\//, ""),
        );
        if (fs.existsSync(existing)) {
          try { fs.unlinkSync(existing); } catch { /* ignore */ }
        }
      }

      // Write new file
      const uploadDir = path.join(__dirname, "../../uploads/expenses", req.params.id);
      fs.mkdirSync(uploadDir, { recursive: true });

      const filename = `${Date.now()}_${sanitizeFilename(req.file.originalname)}`;
      const filepath = path.join(uploadDir, filename);
      fs.writeFileSync(filepath, req.file.buffer);

      const documentUrl = `/api/expenses/${req.params.id}/document`;

      await prisma.expense.update({
        where: { id: req.params.id },
        data: { documentUrl: filepath },
      });

      res.json({ documentUrl });
    } catch (err) {
      next(err);
    }
  },
);

// ── B6: GET /api/expenses/:id/document ───────────────────────────────────────

router.get(
  "/:id/document",
  rolesGuard(["SUPER_ADMIN", "WAREHOUSE"]),
  async (req, res, next) => {
    try {
      const expense = await prisma.expense.findUnique({ where: { id: req.params.id }, select: { documentUrl: true } });
      if (!expense) throw new HttpError(404, "Расход не найден", "EXPENSE_NOT_FOUND");
      if (!expense.documentUrl) throw new HttpError(404, "Документ не загружен", "DOCUMENT_NOT_FOUND");

      // documentUrl is stored as absolute filepath
      const filepath = expense.documentUrl;
      if (!fs.existsSync(filepath)) throw new HttpError(404, "Файл не найден на диске", "FILE_NOT_FOUND");

      const ext = path.extname(filepath).toLowerCase();
      const contentType =
        ext === ".pdf" ? "application/pdf" :
        ext === ".png" ? "image/png" :
        "image/jpeg";

      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Disposition", `inline; filename="${path.basename(filepath)}"`);
      fs.createReadStream(filepath).pipe(res);
    } catch (err) {
      next(err);
    }
  },
);

// ── B6: DELETE /api/expenses/:id/document ────────────────────────────────────

router.delete(
  "/:id/document",
  rolesGuard(["SUPER_ADMIN"]),
  async (req, res, next) => {
    try {
      const expense = await prisma.expense.findUnique({ where: { id: req.params.id }, select: { documentUrl: true } });
      if (!expense) throw new HttpError(404, "Расход не найден", "EXPENSE_NOT_FOUND");
      if (!expense.documentUrl) throw new HttpError(404, "Документ не загружен", "DOCUMENT_NOT_FOUND");

      const filepath = expense.documentUrl;
      if (fs.existsSync(filepath)) {
        try { fs.unlinkSync(filepath); } catch { /* ignore */ }
      }

      await prisma.expense.update({
        where: { id: req.params.id },
        data: { documentUrl: null },
      });

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

export { router as expensesRouter };
