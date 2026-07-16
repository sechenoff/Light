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
import { renderInvoicePdf, coalesceWithEnv, type InvoiceLine } from "../services/documentExport/invoice/renderInvoicePdf";
import { buildAttachmentContentDisposition } from "../utils/contentDisposition";
import { getSettings } from "../services/organizationService";

const router = express.Router();

const invoiceKindEnum = z.enum(["FULL", "DEPOSIT", "BALANCE", "CORRECTION"]);
const invoiceStatusEnum = z.enum(["DRAFT", "ISSUED", "PARTIAL_PAID", "PAID", "OVERDUE", "VOID"]);

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

/** Хранимые статусы, которые на чтении могут отображаться как OVERDUE (см. H6). */
const OVERDUE_CAPABLE_STATUSES = ["ISSUED", "PARTIAL_PAID"] as const;

/**
 * MC1: where-фрагмент для одного значения ?status= в displayStatus-семантике.
 * «Просрочены» включает ISSUED/PARTIAL_PAID с истёкшим dueDate (так их видит
 * список через displayStatus), а «Выставлено»/«Частично» их исключают —
 * иначе счётчики вкладок не сходятся с содержимым вкладки.
 */
function statusFilterClause(status: string, now: Date): Record<string, unknown> {
  if (status === "OVERDUE") {
    return {
      OR: [
        { status: "OVERDUE" },
        { status: { in: [...OVERDUE_CAPABLE_STATUSES] }, dueDate: { lt: now } },
      ],
    };
  }
  if (status === "ISSUED" || status === "PARTIAL_PAID") {
    return { status, OR: [{ dueDate: null }, { dueDate: { gte: now } }] };
  }
  return { status };
}

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
    const { status, bookingId, limit, offset, createdAfter, createdBefore, search } = req.query;

    const nowDate = new Date();

    // M1: Zod validation for ?status= (comma-separated InvoiceStatus values)
    const where: Record<string, unknown> = {};
    if (status) {
      const rawStatuses = (status as string).split(",").map((s) => s.trim());
      // Validate each status value
      for (const s of rawStatuses) {
        const parsed = invoiceStatusEnum.safeParse(s);
        if (!parsed.success) {
          throw new HttpError(400, `Недопустимый статус счёта: "${s}"`, "INVALID_STATUS_FILTER");
        }
      }
      // MC1: фильтруем по displayStatus-семантике (см. statusFilterClause)
      where.OR = rawStatuses.map((s) => statusFilterClause(s, nowDate));
    }
    if (bookingId) where.bookingId = bookingId as string;

    // Поиск по № счёта / клиенту / проекту — раньше UI слал ?search=, а сервер
    // его игнорировал (инпут был no-op). SQLite LIKE регистронезависим только
    // для ASCII, поэтому для кириллицы добавляем вариант с заглавной буквы.
    if (search && String(search).trim()) {
      const q = String(search).trim();
      const qCap = q.charAt(0).toLocaleUpperCase("ru-RU") + q.slice(1);
      const variants = [...new Set([q, qCap])];
      where.AND = [
        {
          OR: variants.flatMap((v) => [
            { number: { contains: v } },
            { booking: { projectName: { contains: v } } },
            { booking: { client: { name: { contains: v } } } },
          ]),
        },
      ];
    }

    // D9: Period filtering by createdAt
    if (createdAfter || createdBefore) {
      const createdAtFilter: Record<string, Date> = {};
      if (createdAfter) createdAtFilter.gte = new Date(createdAfter as string);
      if (createdBefore) createdAtFilter.lte = new Date(createdBefore as string);
      where.createdAt = createdAtFilter;
    }

    const take = Math.min(parseInt(limit as string, 10) || 50, 200); // L2: explicit radix 10
    const skip = parseInt(offset as string, 10) || 0;

    // MC1: счётчики вкладок считаются по ВСЕЙ выборке без фильтра статуса,
    // но с учётом остальных фильтров (bookingId, createdAt) — иначе на вкладке
    // «Оплачены» все прочие счётчики обнуляются.
    const countsWhere: Record<string, unknown> = { ...where };
    delete countsWhere.OR;

    const [items, total, statusGroups, derivedOverdueGroups] = await Promise.all([
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
      prisma.invoice.groupBy({
        by: ["status"],
        where: countsWhere,
        _count: { _all: true },
      }),
      // ISSUED/PARTIAL_PAID с истёкшим dueDate — на чтении показываются как
      // OVERDUE (displayStatus, см. H6 ниже), поэтому в счётчиках переносим
      // их из хранимого статуса в OVERDUE.
      prisma.invoice.groupBy({
        by: ["status"],
        where: {
          ...countsWhere,
          status: { in: [...OVERDUE_CAPABLE_STATUSES] },
          dueDate: { lt: nowDate },
        },
        _count: { _all: true },
      }),
    ]);

    const counts: Record<string, number> = {
      ALL: 0,
      DRAFT: 0,
      ISSUED: 0,
      PARTIAL_PAID: 0,
      PAID: 0,
      OVERDUE: 0,
      VOID: 0,
    };
    for (const g of statusGroups) {
      counts[g.status] = (counts[g.status] ?? 0) + g._count._all;
      counts.ALL += g._count._all;
    }
    for (const g of derivedOverdueGroups) {
      counts[g.status] -= g._count._all;
      counts.OVERDUE += g._count._all;
    }

    // H6: Derive displayStatus on read — non-terminal invoices with dueDate < now → OVERDUE.
    // No DB write; cron-based recomputation deferred to Phase 3.
    // TODO Phase 3: Заменить на cron-job, который периодически вызывает recomputeInvoiceStatus
    // для всех просроченных счетов и обновляет статус в БД.
    const now = nowDate.getTime();
    const itemsWithDisplayStatus = items.map((inv) => {
      let displayStatus = inv.status;
      if (
        (inv.status === "ISSUED" || inv.status === "PARTIAL_PAID") &&
        inv.dueDate &&
        inv.dueDate.getTime() < now
      ) {
        // MF-5: частично оплаченный просроченный счёт тоже показываем OVERDUE.
        displayStatus = "OVERDUE";
      }
      return { ...inv, displayStatus };
    });

    res.json({ items: itemsWithDisplayStatus, total, counts });
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
            estimates: { include: { lines: true } },
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
    const orgSettings = await getSettings();
    const org = coalesceWithEnv(orgSettings);

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

    const mainEstimate = booking.estimates?.find((e) => e.kind === "MAIN");
    if (mainEstimate) {
      lines = mainEstimate.lines.map((l, i) => ({
        index: i + 1,
        name: l.nameSnapshot,
        quantity: l.quantity,
        unitPrice: l.unitPrice.toString(),
        lineSum: l.lineSum.toString(),
      }));
      subtotal = mainEstimate.subtotal.toString();
      if (mainEstimate.discountPercent && new Decimal(mainEstimate.discountPercent.toString()).greaterThan(0)) {
        discountPercent = mainEstimate.discountPercent.toString();
        discountAmount = mainEstimate.discountAmount.toString();
      }
      totalAfterDiscount = mainEstimate.totalAfterDiscount.toString();
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
