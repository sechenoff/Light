import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { Decimal } from "decimal.js";
import { prisma } from "../../prisma";
import { lkAuth } from "../../middleware/lkAuth";
import { lkClientId } from "../../services/clientPortal/tenant";
import { HttpError } from "../../utils/errors";
import { buildBookingEstimatePdf, buildBookingActPdf } from "../../services/documentExport/bookingPdf";
import {
  renderInvoicePdf,
  coalesceWithEnv,
  type InvoiceLine,
} from "../../services/documentExport/invoice/renderInvoicePdf";
import { getSettings } from "../../services/organizationService";
import { buildAttachmentContentDisposition } from "../../utils/contentDisposition";

const router = Router();

const VISIBLE_STATUSES = [
  "CONFIRMED",
  "ISSUED",
  "RETURNED",
  "CANCELLED",
] as const;

const listQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(50).default(20),
  status: z.enum(VISIBLE_STATUSES).optional(),
});

// Compound cursor for (startDate DESC, id DESC) ordering.
// Encodes both fields to avoid gaps/duplicates when multiple bookings share the same startDate.
type CompoundCursor = { startDate: Date; id: string };

function encodeCursor(c: CompoundCursor): string {
  return `${c.startDate.toISOString()}|${c.id}`;
}

function decodeCursor(s: string | undefined): CompoundCursor | null {
  if (!s) return null;
  const [iso, id] = s.split("|");
  if (!iso || !id) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return { startDate: d, id };
}

router.get("/", lkAuth, async (req, res, next) => {
  try {
    const q = listQuery.parse(req.query);
    const clientId = lkClientId(req);

    const cursor = decodeCursor(q.cursor);
    const where: Prisma.BookingWhereInput = {
      clientId,
      // LKG-4: архивные (soft-deleted) брони клиент видеть не должен.
      deletedAt: null,
      status: q.status ? q.status : { in: [...VISIBLE_STATUSES] as any },
      ...(cursor
        ? {
            OR: [
              { startDate: { lt: cursor.startDate } },
              { startDate: cursor.startDate, id: { lt: cursor.id } },
            ],
          }
        : {}),
    };

    const items = await prisma.booking.findMany({
      where,
      orderBy: [{ startDate: "desc" }, { id: "desc" }],
      take: q.limit + 1,
      select: {
        id: true,
        projectName: true,
        startDate: true,
        endDate: true,
        status: true,
        finalAmount: true,
        amountOutstanding: true,
        _count: { select: { items: true } },
      },
    });

    const hasMore = items.length > q.limit;
    const slice = hasMore ? items.slice(0, q.limit) : items;
    const last = slice[slice.length - 1];
    const nextCursor = hasMore
      ? encodeCursor({ startDate: last.startDate, id: last.id })
      : null;

    res.json({
      items: slice.map((b) => ({
        id: b.id,
        bookingNo: `#${b.id.slice(-6).toUpperCase()}`,
        projectName: b.projectName,
        startDate: b.startDate.toISOString(),
        endDate: b.endDate.toISOString(),
        status: b.status,
        finalAmount: b.finalAmount.toString(),
        amountOutstanding: b.amountOutstanding.toString(),
        itemCount: b._count.items,
      })),
      nextCursor,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", lkAuth, async (req, res, next) => {
  try {
    const clientId = lkClientId(req);
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        clientId: true,
        deletedAt: true,
        status: true,
        startDate: true,
        endDate: true,
        finalAmount: true,
        amountPaid: true,
        amountOutstanding: true,
        // Транспорт хранится на брони отдельно от сметы (finalAmount =
        // totalAfterDiscount сметы + transportSubtotalRub) — без него в ЛК
        // «Итого» не сходится с «Оплачено + Остаток».
        transportSubtotalRub: true,
        comment: true,
        estimateOptionalNote: true,
        projectName: true,
        // Последний невоидный счёт — для кнопки «Счёт PDF» в ЛК.
        invoices: {
          where: { status: { not: "VOID" } },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { number: true },
        },
        estimates: {
          select: {
            kind: true,
            shifts: true,
            subtotal: true,
            discountAmount: true,
            totalAfterDiscount: true,
            lines: {
              select: {
                categorySnapshot: true,
                nameSnapshot: true,
                quantity: true,
                unitPrice: true,
                lineSum: true,
              },
            },
          },
        },
      },
    });

    if (!booking || booking.clientId !== clientId || booking.deletedAt) {
      throw new HttpError(404, "Не найдено", "NOT_FOUND");
    }
    if (!VISIBLE_STATUSES.includes(booking.status as any)) {
      throw new HttpError(404, "Не найдено", "NOT_FOUND");
    }

    // The MAIN estimate is the authoritative financial snapshot (EstimateKind has MAIN and ADDON only)
    const snapshot = booking.estimates.find((e) => e.kind === "MAIN") ?? null;
    const hasConfirmedEstimate = Boolean(snapshot);

    const lines = snapshot?.lines ?? [];
    const shifts = snapshot?.shifts ?? null;

    res.json({
      id: booking.id,
      bookingNo: `#${booking.id.slice(-6).toUpperCase()}`,
      projectName: booking.projectName ?? null,
      startDate: booking.startDate.toISOString(),
      endDate: booking.endDate.toISOString(),
      status: booking.status,
      shifts,
      items: lines.map((l) => ({
        categorySnapshot: l.categorySnapshot,
        nameSnapshot: l.nameSnapshot,
        quantity: l.quantity,
        unitPrice: l.unitPrice.toString(),
        lineSum: l.lineSum.toString(),
      })),
      subtotal: snapshot?.subtotal.toString() ?? "0",
      discountAmount: snapshot?.discountAmount.toString() ?? "0",
      totalAfterDiscount:
        snapshot?.totalAfterDiscount.toString() ??
        booking.finalAmount.toString(),
      transportSubtotal: booking.transportSubtotalRub?.toString() ?? "0",
      finalAmount: booking.finalAmount.toString(),
      amountPaid: booking.amountPaid.toString(),
      amountOutstanding: booking.amountOutstanding.toString(),
      comment: booking.comment ?? null,
      optionalNote: booking.estimateOptionalNote ?? null,
      hasConfirmedEstimate,
      hasAct: booking.status === "RETURNED",
      hasInvoice: booking.invoices.length > 0,
      invoiceNumber: booking.invoices[0]?.number ?? null,
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/lk/bookings/:id/estimate.pdf ────────────────────────────────────

router.get("/:id/estimate.pdf", lkAuth, async (req, res, next) => {
  try {
    const clientId = lkClientId(req);
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      select: { clientId: true, status: true, deletedAt: true },
    });
    // LKG-4: архивную бронь клиент не открывает и её PDF не качает.
    if (!booking || booking.clientId !== clientId || booking.deletedAt) throw new HttpError(404, "Не найдено", "NOT_FOUND");
    if (!VISIBLE_STATUSES.includes(booking.status as any)) throw new HttpError(404, "Не найдено", "NOT_FOUND");

    const pdfBuf = await buildBookingEstimatePdf(req.params.id);
    res.setHeader("Content-Type", "application/pdf");
    res.end(pdfBuf);
  } catch (err) {
    next(err);
  }
});

// ── GET /api/lk/bookings/:id/act.pdf ─────────────────────────────────────────

router.get("/:id/act.pdf", lkAuth, async (req, res, next) => {
  try {
    const clientId = lkClientId(req);
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      select: { clientId: true, status: true, deletedAt: true },
    });
    // LKG-4: архивную бронь клиент не открывает и её PDF не качает.
    if (!booking || booking.clientId !== clientId || booking.deletedAt) throw new HttpError(404, "Не найдено", "NOT_FOUND");
    if (booking.status !== "RETURNED") throw new HttpError(404, "Не найдено", "NOT_FOUND");

    const pdfBuf = await buildBookingActPdf(req.params.id);
    res.setHeader("Content-Type", "application/pdf");
    res.end(pdfBuf);
  } catch (err) {
    next(err);
  }
});

// ── GET /api/lk/bookings/:id/invoice.pdf ─────────────────────────────────────
// Клиентская выгрузка последнего невоидного счёта по брони. Рендер повторяет
// admin-маршрут GET /api/invoices/:id/pdf (routes/invoices.ts) — осознанный
// дубль маппинга Invoice → renderInvoicePdf: общий сервис не выделен, чтобы
// не трогать admin-роут; tenant-гейты здесь свои (lkAuth + clientId).

router.get("/:id/invoice.pdf", lkAuth, async (req, res, next) => {
  try {
    const clientId = lkClientId(req);
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      include: {
        client: { select: { name: true } },
        estimates: { include: { lines: true } },
        items: { include: { equipment: true } },
        invoices: {
          where: { status: { not: "VOID" } },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });
    // LKG-4: архивную бронь клиент не открывает и её PDF не качает.
    if (!booking || booking.clientId !== clientId || booking.deletedAt) throw new HttpError(404, "Не найдено", "NOT_FOUND");
    if (!VISIBLE_STATUSES.includes(booking.status as any)) throw new HttpError(404, "Не найдено", "NOT_FOUND");

    const invoice = booking.invoices[0];
    if (!invoice) throw new HttpError(404, "Счёт не найден", "INVOICE_NOT_FOUND");

    const orgSettings = await getSettings();
    const org = coalesceWithEnv(orgSettings);

    const invoiceDate = invoice.issuedAt
      ? invoice.issuedAt.toLocaleDateString("ru-RU")
      : new Date().toLocaleDateString("ru-RU");

    let lines: InvoiceLine[];
    let subtotal: string;
    let discountPercent: string | null = null;
    let discountAmount: string | null = null;
    let totalAfterDiscount: string;

    const mainEstimate = booking.estimates.find((e) => e.kind === "MAIN");
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
      {
        invoiceNumber: invoice.number,
        invoiceDate,
        clientName: booking.client.name,
        lines,
        subtotal,
        discountPercent,
        discountAmount,
        totalAfterDiscount,
      },
      org,
    );

    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = `Счёт_${invoice.number}_${dateStr}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", buildAttachmentContentDisposition(filename, "invoice.pdf"));
    res.end(pdfBuf);
  } catch (err) {
    next(err);
  }
});

export default router;
