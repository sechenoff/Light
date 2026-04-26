import { Router } from "express";
import { z } from "zod";
import type { UserRole } from "@prisma/client";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";

import { prisma } from "../prisma";
import { rolesGuard } from "../middleware/rolesGuard";
import * as expenseService from "../services/expenseService";
import { HttpError } from "../utils/errors";

// ── B6: upload root (T1: relative paths) ─────────────────────────────────────

// UPLOAD_ROOT is the absolute base for all expense document storage.
// documentUrl values in DB are stored RELATIVE to this root (e.g. "expenses/abc/xyz.pdf").
// GET/DELETE resolve by joining UPLOAD_ROOT + relative path and verifying no traversal.
const UPLOAD_ROOT = path.resolve(__dirname, "../../uploads");

// ── B6: multer setup for expense document upload ──────────────────────────────

const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "application/pdf"]);
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

// M1: Magic-byte signatures for allowed types
const MAGIC_BYTES: Array<{ mime: string; bytes: number[]; offset: number }> = [
  { mime: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46], offset: 0 }, // %PDF
  { mime: "image/jpeg",     bytes: [0xff, 0xd8, 0xff],         offset: 0 }, // FF D8 FF
  { mime: "image/png",      bytes: [0x89, 0x50, 0x4e, 0x47],   offset: 0 }, // 89 PNG
];

/**
 * Validate file buffer magic bytes match the declared MIME type.
 * Returns true if valid, false otherwise.
 */
function validateMagicBytes(buffer: Buffer, mime: string): boolean {
  const sig = MAGIC_BYTES.find((m) => m.mime === mime);
  if (!sig) return false;
  for (let i = 0; i < sig.bytes.length; i++) {
    if (buffer[sig.offset + i] !== sig.bytes[i]) return false;
  }
  return true;
}

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

/**
 * Resolve a relative documentUrl to an absolute path, guarding against path traversal.
 * Returns null if the resolved path escapes UPLOAD_ROOT.
 */
function resolveDocumentPath(relativeUrl: string): string | null {
  // Strip leading slash if present
  const rel = relativeUrl.replace(/^\//, "");
  const resolved = path.resolve(UPLOAD_ROOT, rel);
  // Guard: resolved path must start with UPLOAD_ROOT + sep
  if (!resolved.startsWith(UPLOAD_ROOT + path.sep) && resolved !== UPLOAD_ROOT) {
    return null;
  }
  return resolved;
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
  // documentUrl intentionally excluded: document operations only via /document endpoints (T2)
  linkedBookingId: z.string().optional(),
  linkedRepairId: z.string().optional(),
});

// T2: patchSchema also excludes documentUrl — document ops via /document endpoints only
const patchSchema = z.object({
  date: z.string().datetime().optional(),
  category: z.enum(EXPENSE_CATEGORIES).optional(),
  amount: z.coerce.number().positive().optional(),
  description: z.string().min(1).optional(),
  linkedBookingId: z.string().optional(),
  linkedRepairId: z.string().optional(),
});

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
      // documentUrl intentionally not accepted here (T2) — use /document endpoint
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
    // documentUrl intentionally excluded from PATCH (T2) — use /document endpoint
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

      // M1: Validate magic bytes to prevent MIME-type spoofing
      if (!validateMagicBytes(req.file.buffer, req.file.mimetype)) {
        throw new HttpError(400, "Содержимое файла не соответствует указанному типу", "INVALID_FILE_FORMAT");
      }

      const expense = await prisma.expense.findUnique({ where: { id: req.params.id } });
      if (!expense) throw new HttpError(404, "Расход не найден", "EXPENSE_NOT_FOUND");

      // Delete previous file if exists (T1: resolve relative path safely)
      if (expense.documentUrl) {
        const existingAbsolute = resolveDocumentPath(expense.documentUrl);
        if (existingAbsolute && fs.existsSync(existingAbsolute)) {
          try { fs.unlinkSync(existingAbsolute); } catch { /* ignore */ }
        }
      }

      // Write new file
      // M3: Use crypto.randomBytes instead of Date.now() to avoid collision
      const randomSuffix = crypto.randomBytes(4).toString("hex");
      const filename = `${randomSuffix}_${sanitizeFilename(req.file.originalname)}`;

      // T1: Store relative path in DB (relative to UPLOAD_ROOT)
      const relativeDir = path.join("expenses", req.params.id);
      const uploadDir = path.join(UPLOAD_ROOT, relativeDir);
      fs.mkdirSync(uploadDir, { recursive: true });

      const relativeDocPath = path.join(relativeDir, filename);
      const absoluteFilepath = path.join(UPLOAD_ROOT, relativeDocPath);
      fs.writeFileSync(absoluteFilepath, req.file.buffer);

      // Store relative path in DB (not absolute filesystem path)
      await prisma.expense.update({
        where: { id: req.params.id },
        data: { documentUrl: relativeDocPath },
      });

      const documentUrl = `/api/expenses/${req.params.id}/document`;
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

      // T1: Resolve relative path to absolute, guard against traversal
      const filepath = resolveDocumentPath(expense.documentUrl);
      if (!filepath) throw new HttpError(404, "Файл не найден на диске", "FILE_NOT_FOUND");
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

      // T1: Resolve relative path safely
      const filepath = resolveDocumentPath(expense.documentUrl);
      if (filepath && fs.existsSync(filepath)) {
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
