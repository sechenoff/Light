import express from "express";
import { z } from "zod";
import { Decimal } from "decimal.js";
import { rolesGuard } from "../middleware/rolesGuard";
import {
  createInvoice,
  issueInvoice,
  voidInvoice,
  updateInvoice,
} from "../services/invoiceService";
import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";
import { renderInvoicePdf, readOrgFromEnv, type InvoiceLine } from "../services/documentExport/invoice/renderInvoicePdf";
import { buildAttachmentContentDisposition } from "../utils/contentDisposition";

const router = express.Router();

const invoiceKindEnum = z.enum(["FULL", "DEPOSIT", "BALANCE", "CORRECTION"]);

const createSchema = z.object({
  bookingId: z.string().min(1),
  kind: invoiceKindEnum,
  total: z.number().positive().optional(),
  dueDate: z.string().datetime().optional(),
  notes: z.string().optional(),
});

const updateSchema = z.object({
  dueDate: z.string().datetime().nullable().optional(),
  notes: z.string().nullable().optional(),
  total: z.number().positive().optional(),
});

const voidSchema = z.object({
  reason: z.string().min(3, "Причина обязательна (минимум 3 символа)"),
});

/**
 * POST /api/invoices — SA only
 * Создаёт счёт в статусе DRAFT.
 */
router.post("/", rolesGuard(["SUPER_ADMIN"]), async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body);
    const userId = req.adminUser!.userId;

    const invoice = await createInvoice(
      {
        bookingId: body.bookingId,
        kind: body.kind,
        total: body.total,
        dueDate: body.dueDate ? new Date(body.dueDate) : undefined,
        notes: body.notes,
      },
      userId,
    );

    res.status(201).json(invoice);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/invoices — SA + WH (read)
 * Список счетов с фильтрами.
 */
router.get("/", rolesGuard(["SUPER_ADMIN", "WAREHOUSE"]), async (req, res, next) => {
  try {
    const { status, bookingId, limit, offset } = req.query;

    const where: Record<string, unknown> = {};
    if (status) {
      const statuses = (status as string).split(",");
      where.status = { in: statuses };
    }
    if (bookingId) where.bookingId = bookingId as string;

    const take = Math.min(parseInt(limit as string) || 50, 200);
    const skip = parseInt(offset as string) || 0;

    const [items, total] = await Promise.all([
      prisma.invoice.findMany({
        where,
        include: {
          booking: {
            select: {
              id: true,
              projectName: true,
              client: { select: { id: true, name: true } },
            },
          },
        },
        orderBy: { createdAt: "desc" },
        take,
        skip,
      }),
      prisma.invoice.count({ where }),
    ]);

    res.json({ items, total });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/invoices/:id — SA + WH (read)
 * Получить один счёт.
 */
router.get("/:id", rolesGuard(["SUPER_ADMIN", "WAREHOUSE"]), async (req, res, next) => {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id: req.params.id },
      include: {
        booking: {
          select: {
            id: true,
            projectName: true,
            legacyFinance: true,
            client: { select: { id: true, name: true } },
          },
        },
        payments: { where: { voidedAt: null }, orderBy: { createdAt: "desc" } },
        refunds: { orderBy: { refundedAt: "desc" } },
      },
    });

    if (!invoice) throw new HttpError(404, "Счёт не найден", "INVOICE_NOT_FOUND");

    res.json(invoice);
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/invoices/:id — SA only
 * Редактирует счёт в статусе DRAFT.
 */
router.patch("/:id", rolesGuard(["SUPER_ADMIN"]), async (req, res, next) => {
  try {
    const body = updateSchema.parse(req.body);
    const userId = req.adminUser!.userId;

    const invoice = await updateInvoice(
      req.params.id,
      {
        dueDate: body.dueDate !== undefined ? (body.dueDate ? new Date(body.dueDate) : null) : undefined,
        notes: body.notes,
        total: body.total,
      },
      userId,
    );

    res.json(invoice);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/invoices/:id/issue — SA only
 * DRAFT → ISSUED. Генерирует номер.
 */
router.post("/:id/issue", rolesGuard(["SUPER_ADMIN"]), async (req, res, next) => {
  try {
    const userId = req.adminUser!.userId;
    const invoice = await issueInvoice(req.params.id, userId);
    res.json(invoice);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/invoices/:id/void — SA only
 * Аннулирует счёт с обязательной причиной.
 */
router.post("/:id/void", rolesGuard(["SUPER_ADMIN"]), async (req, res, next) => {
  try {
    const { reason } = voidSchema.parse(req.body);
    const userId = req.adminUser!.userId;
    const invoice = await voidInvoice(req.params.id, reason, userId);
    res.json(invoice);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/invoices/:id/pdf — SA + WH (read)
 * Генерирует PDF счёта из Invoice-сущности.
 * Finance Phase 2: использует реальный Invoice.number, даты, сумму.
 */
router.get("/:id/pdf", rolesGuard(["SUPER_ADMIN", "WAREHOUSE"]), async (req, res, next) => {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id: req.params.id },
      include: {
        booking: {
          include: {
            client: true,
            estimate: { include: { lines: true } },
            items: { include: { equipment: true } },
          },
        },
      },
    });

    if (!invoice) throw new HttpError(404, "Счёт не найден", "INVOICE_NOT_FOUND");
    if (invoice.status === "VOID") {
      throw new HttpError(409, "Аннулированный счёт не может быть скачан", "INVOICE_VOID");
    }

    const booking = invoice.booking;
    const org = readOrgFromEnv();

    const invoiceNumber = invoice.number;
    const invoiceDate = invoice.issuedAt
      ? invoice.issuedAt.toLocaleDateString("ru-RU")
      : new Date().toLocaleDateString("ru-RU");

    // Строки из estimate.lines или booking.items
    let lines: InvoiceLine[];
    let subtotal: string;
    let discountPercent: string | null = null;
    let discountAmount: string | null = null;
    let totalAfterDiscount: string;

    if (booking.estimate) {
      lines = booking.estimate.lines.map((l, i) => ({
        index: i + 1,
        name: l.nameSnapshot,
        quantity: l.quantity,
        unitPrice: l.unitPrice.toString(),
        lineSum: l.lineSum.toString(),
      }));
      subtotal = booking.estimate.subtotal.toString();
      if (booking.estimate.discountPercent && new Decimal(booking.estimate.discountPercent.toString()).greaterThan(0)) {
        discountPercent = booking.estimate.discountPercent.toString();
        discountAmount = booking.estimate.discountAmount.toString();
      }
      totalAfterDiscount = booking.estimate.totalAfterDiscount.toString();
    } else {
      lines = booking.items.map((item, i) => {
        const rate = item.equipment?.rentalRatePerShift ?? new Decimal(0);
        const lineSum = new Decimal(rate.toString()).mul(item.quantity);
        return {
          index: i + 1,
          name: item.equipment?.name ?? item.customName ?? "—",
          quantity: item.quantity,
          unitPrice: rate.toString(),
          lineSum: lineSum.toString(),
        };
      });
      subtotal = invoice.total.toString();
      totalAfterDiscount = invoice.total.toString();
    }

    const pdfBuf = await renderInvoicePdf(
      { invoiceNumber, invoiceDate, clientName: booking.client.name, lines, subtotal, discountPercent, discountAmount, totalAfterDiscount },
      org,
    );

    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = `Счёт_${invoiceNumber}_${dateStr}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", buildAttachmentContentDisposition(filename, "invoice.pdf"));
    res.end(pdfBuf);
  } catch (err) {
    next(err);
  }
});

export { router as invoicesRouter };
