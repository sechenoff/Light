import express from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import Decimal from "decimal.js";

import { prisma } from "../prisma";
import { createBookingDraft, confirmBooking, quoteEstimate, rebuildBookingEstimate } from "../services/bookings";
import { HttpError } from "../utils/errors";
import {
  assertBookingRangeOrder,
  formatRentalDurationDetails,
  parseBookingRangeBound,
} from "../utils/dates";
import { serializeBookingForApi } from "../utils/serializeDecimal";
import { buildQuoteXml } from "../services/quoteExport";
import { buildSmetaExportDocument, writeSmetaPdf, writeSmetaXlsx } from "../services/smetaExport";
import { formatExportHourCalculationLine } from "../utils/dates";
import { buildBookingHumanName, safeFileName } from "../utils/bookingName";
import { createFinanceEvent, recomputeBookingFinance } from "../services/finance";
import { buildAttachmentContentDisposition } from "../utils/contentDisposition";

const router = express.Router();

/** YYYY-MM-DD или ISO с временем (как от datetime-local → toISOString()). */
const bookingRangeStringSchema = z.string().min(10, "Укажите дату/время начала и окончания аренды");

const bookingItemSchema = z.object({
  equipmentId: z.string().min(1),
  quantity: z.number().int().positive(),
});

const bookingCreateSchema = z.object({
  client: z.object({
    name: z.string().min(1),
    phone: z.string().optional().nullable(),
    email: z.string().optional().nullable(),
    comment: z.string().optional().nullable(),
  }),
  projectName: z.string().min(1),
  startDate: bookingRangeStringSchema,
  endDate: bookingRangeStringSchema,
  comment: z.string().optional().nullable(),
  discountPercent: z.number().min(0).max(100).optional().nullable(),
  /** Плановая дата платежа (YYYY-MM-DD или ISO datetime) */
  expectedPaymentDate: z.string().optional().nullable(),
  /** Доп. текст в экспорте (PDF/XLSX), опционально */
  estimateOptionalNote: z.string().optional().nullable(),
  estimateIncludeOptionalInExport: z.boolean().optional(),
  /** Переопределить строку «Просчёт часов» (иначе считается по датам) */
  hourCalculationOverride: z.string().optional().nullable(),
  items: z.array(bookingItemSchema).min(1),
});

const quoteExportSchema = bookingCreateSchema.extend({
  format: z.enum(["pdf", "xlsx", "xml"]),
});

const bookingUpdateSchema = z.object({
  projectName: z.string().min(1).optional(),
  startDate: bookingRangeStringSchema.optional(),
  endDate: bookingRangeStringSchema.optional(),
  comment: z.string().optional().nullable(),
  discountPercent: z.number().min(0).max(100).optional().nullable(),
  expectedPaymentDate: z.string().optional().nullable(),
  items: z
    .array(
      z.object({
        equipmentId: z.string().min(1),
        quantity: z.number().int().positive(),
      }),
    )
    .min(1)
    .optional(),
});

const bookingStatusActionSchema = z.object({
  action: z.enum(["confirm", "issue", "return", "cancel"]),
  expectedPaymentDate: z.string().datetime().optional().nullable(),
  paymentComment: z.string().optional().nullable(),
});

function isSchemaOutOfSyncError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    // P2021: table does not exist, P2022: column does not exist
    if (err.code === "P2021" || err.code === "P2022") return true;
  }
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const m = raw.toLowerCase();
  return (
    m.includes("no such table") ||
    m.includes("no such column") ||
    m.includes("does not exist") ||
    m.includes("the column") ||
    m.includes("the table")
  );
}

function financeWarningFromError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const normalized = raw.toLowerCase();
  const likelyMigrationIssue =
    normalized.includes("no such table") ||
    normalized.includes("bookingfinanceevent") ||
    normalized.includes("payment") ||
    normalized.includes("expense");
  if (likelyMigrationIssue) {
    return "Бронь подтверждена, но финансовый модуль не синхронизирован (нужны миграции).";
  }
  return "Бронь подтверждена, но не удалось обновить финансовые данные.";
}

router.get("/", async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const bookings = await prisma.booking.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        status: true,
        projectName: true,
        startDate: true,
        endDate: true,
        client: { select: { id: true, name: true } },
        paymentStatus: true,
        amountPaid: true,
        amountOutstanding: true,
        finalAmount: true,
        expectedPaymentDate: true,
        items: {
          select: {
            id: true,
            equipmentId: true,
            quantity: true,
            equipment: {
              select: {
                id: true,
                name: true,
                category: true,
              },
            },
          },
        },
        confirmedAt: true,
        createdAt: true,
        _count: { select: { scanSessions: true } },
        scanSessions: {
          select: { operation: true, status: true },
          orderBy: { startedAt: "desc" },
          take: 1,
        },
      },
    });
    res.json({
      bookings: bookings.map((b) => {
        const lastScan = b.scanSessions[0] ?? null;
        return {
          ...b,
          amountPaid: b.amountPaid.toString(),
          amountOutstanding: b.amountOutstanding.toString(),
          finalAmount: b.finalAmount.toString(),
          displayName: buildBookingHumanName({
            startDate: b.startDate,
            clientName: b.client.name,
            totalAfterDiscount: b.finalAmount.toString(),
          }),
          hasScanSessions: b._count.scanSessions > 0,
          lastScanOperation: lastScan?.operation ?? null,
          lastScanStatus: lastScan?.status ?? null,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    const booking = await prisma.booking.findUnique({
      where: { id },
      include: {
        client: true,
        items: { include: { equipment: true } },
        estimate: { include: { lines: true } },
        financeEvents: { orderBy: { createdAt: "desc" }, take: 100 },
        scanSessions: {
          select: {
            id: true,
            workerName: true,
            operation: true,
            status: true,
            startedAt: true,
            completedAt: true,
            _count: { select: { scans: true } },
          },
          orderBy: { startedAt: "desc" },
        },
      },
    });
    if (!booking) return res.status(404).json({ message: "Booking not found" });
    const { financeEvents, scanSessions, ...bookingCore } = booking as any;
    const serialized = serializeBookingForApi(bookingCore);
    const displayName = buildBookingHumanName({
      startDate: booking.startDate,
      clientName: booking.client.name,
      totalAfterDiscount: booking.estimate?.totalAfterDiscount?.toString() ?? "0",
    });
    res.json({
      booking: {
        ...serialized,
        displayName,
        financeEvents: financeEvents.map((ev: any) => ({
          ...ev,
          amountDelta: ev.amountDelta?.toString() ?? null,
        })),
        scanSessions: (scanSessions ?? []).map((ss: any) => ({
          id: ss.id,
          workerName: ss.workerName,
          operation: ss.operation,
          status: ss.status,
          createdAt: ss.startedAt,
          completedAt: ss.completedAt,
          _count: { scanRecords: ss._count.scans },
        })),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    const body = bookingUpdateSchema.parse(req.body);
    const existing = await prisma.booking.findUnique({
      where: { id },
      select: { id: true, status: true, startDate: true, endDate: true },
    });
    if (!existing) throw new HttpError(404, "Booking not found");
    if (!["DRAFT", "CONFIRMED"].includes(existing.status)) {
      throw new HttpError(409, "Редактирование доступно для черновиков и подтвержденных броней.");
    }

    let start = existing.startDate;
    let end = existing.endDate;
    if (body.startDate) start = parseBookingRangeBound(body.startDate, "start");
    if (body.endDate) end = parseBookingRangeBound(body.endDate, "end");
    assertBookingRangeOrder(start, end);

    const booking = await prisma.$transaction(async (tx) => {
      if (body.items) {
        await tx.bookingItem.deleteMany({ where: { bookingId: id } });
        await tx.bookingItem.createMany({
          data: body.items.map((it) => ({
            bookingId: id,
            equipmentId: it.equipmentId,
            quantity: it.quantity,
          })),
        });
      }
      return tx.booking.update({
        where: { id },
        data: {
          projectName: body.projectName?.trim() || undefined,
          startDate: start,
          endDate: end,
          comment: body.comment === undefined ? undefined : body.comment ?? null,
          discountPercent: body.discountPercent === undefined ? undefined : body.discountPercent != null ? new Decimal(body.discountPercent) : null,
          expectedPaymentDate: body.expectedPaymentDate === undefined ? undefined : body.expectedPaymentDate ? new Date(body.expectedPaymentDate) : null,
        },
        include: {
          client: true,
          items: { include: { equipment: true } },
          estimate: { include: { lines: true } },
        },
      });
    });

    // Пересчитываем смету и финансы — у CONFIRMED/ISSUED брони смета должна
    // отражать актуальный набор позиций, дат и скидки.
    let warning: string | null = null;
    try {
      await rebuildBookingEstimate(id);
      await recomputeBookingFinance(id);
      await createFinanceEvent({ bookingId: id, eventType: "BOOKING_EDITED" });
    } catch (financeErr) {
      warning = financeWarningFromError(financeErr);
      // eslint-disable-next-line no-console
      console.error("Finance side-effects failed after patch:", financeErr);
    }

    // Перечитываем бронь после пересчёта, чтобы вернуть актуальные суммы.
    const freshBooking = await prisma.booking.findUnique({
      where: { id },
      include: {
        client: true,
        items: { include: { equipment: true } },
        estimate: { include: { lines: true } },
      },
    });

    res.json({ booking: serializeBookingForApi(freshBooking as any), warning });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/status", async (req, res, next) => {
  try {
    const id = req.params.id;
    const body = bookingStatusActionSchema.parse(req.body);
    const booking = await prisma.booking.findUnique({ where: { id } });
    if (!booking) throw new HttpError(404, "Booking not found");

    const allowedActionsByStatus: Record<string, Array<"confirm" | "issue" | "return" | "cancel">> = {
      DRAFT: ["confirm", "cancel"],
      CONFIRMED: ["issue", "cancel"],
      ISSUED: ["return"],
      RETURNED: [],
      CANCELLED: [],
    };
    const allowed = allowedActionsByStatus[booking.status] ?? [];
    if (!allowed.includes(body.action)) {
      throw new HttpError(409, `Недопустимый переход: ${booking.status} -> ${body.action}`);
    }

    if (body.action === "confirm") {
      const confirmed = await confirmBooking(id);
      let warning: string | null = null;
      try {
        await recomputeBookingFinance(id);
        await createFinanceEvent({
          bookingId: id,
          eventType: "BOOKING_CONFIRMED",
          payload: { status: confirmed.status },
        });
      } catch (financeErr) {
        warning = financeWarningFromError(financeErr);
        // Не блокируем подтверждение брони, если финансовый модуль временно не готов (например, миграции).
        // eslint-disable-next-line no-console
        console.error("Finance side-effects failed after confirm:", financeErr);
      }
      res.json({ booking: serializeBookingForApi(confirmed as any), warning });
      return;
    }

    const nextStatus =
      body.action === "issue"
        ? "ISSUED"
        : body.action === "return"
          ? "RETURNED"
          : body.action === "cancel"
            ? "CANCELLED"
            : booking.status;
    const updated = await prisma.booking.update({
      where: { id },
      data: {
        status: nextStatus,
        expectedPaymentDate:
          body.expectedPaymentDate !== undefined ? (body.expectedPaymentDate ? new Date(body.expectedPaymentDate) : null) : undefined,
        paymentComment: body.paymentComment === undefined ? undefined : body.paymentComment ?? null,
      },
      include: {
        client: true,
        items: { include: { equipment: true } },
        estimate: { include: { lines: true } },
      },
    });
    let warning: string | null = null;
    try {
      await recomputeBookingFinance(id);
      await createFinanceEvent({
        bookingId: id,
        eventType: "BOOKING_STATUS_CHANGED",
        payload: { from: booking.status, to: nextStatus, action: body.action },
      });
    } catch (financeErr) {
      warning = financeWarningFromError(financeErr);
      // eslint-disable-next-line no-console
      console.error("Finance side-effects failed after status change:", financeErr);
    }
    res.json({ booking: serializeBookingForApi(updated as any), warning });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    const existing = await prisma.booking.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!existing) throw new HttpError(404, "Booking not found");
    await prisma.booking.delete({ where: { id } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post("/quote", async (req, res, next) => {
  try {
    const body = bookingCreateSchema.parse(req.body);
    let start: Date;
    let end: Date;
    try {
      start = parseBookingRangeBound(body.startDate, "start");
      end = parseBookingRangeBound(body.endDate, "end");
      assertBookingRangeOrder(start, end);
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : "Некорректный период аренды");
    }

    // clientId doesn't matter for the quote calc right now; use dummy created/found for snapshot later if desired.
    const client = await prisma.client.upsert({
      where: { name: body.client.name.trim() },
      update: {
        phone: body.client.phone ?? null,
        email: body.client.email ?? null,
        comment: body.client.comment ?? null,
      },
      create: {
        name: body.client.name.trim(),
        phone: body.client.phone ?? null,
        email: body.client.email ?? null,
        comment: body.client.comment ?? null,
      },
    });

    const estimate = await quoteEstimate({
      startDate: start,
      endDate: end,
      clientId: client.id,
      discountPercent: body.discountPercent ?? null,
      items: body.items.map((it) => ({ equipmentId: it.equipmentId, quantity: it.quantity })),
    });

    const duration = formatRentalDurationDetails(start, end);

    res.json({
      shifts: estimate.shifts,
      totalHours: duration.totalHours,
      durationLabel: duration.labelShort,
      subtotal: estimate.subtotal.toDecimalPlaces(2).toString(),
      discountPercent: estimate.discountPercent.toString(),
      discountAmount: estimate.discountAmount.toDecimalPlaces(2).toString(),
      totalAfterDiscount: estimate.totalAfterDiscount.toDecimalPlaces(2).toString(),
      lines: estimate.lines.map((l) => ({
        equipmentId: l.equipmentId,
        categorySnapshot: l.categorySnapshot,
        nameSnapshot: l.nameSnapshot,
        brandSnapshot: l.brandSnapshot,
        modelSnapshot: l.modelSnapshot,
        quantity: l.quantity,
        pricingMode: l.pricingMode,
        unitPrice: l.unitPrice.toDecimalPlaces(2).toString(),
        lineSum: l.lineSum.toDecimalPlaces(2).toString(),
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/quote/export", async (req, res, next) => {
  try {
    const body = quoteExportSchema.parse(req.body);
    let start: Date;
    let end: Date;
    try {
      start = parseBookingRangeBound(body.startDate, "start");
      end = parseBookingRangeBound(body.endDate, "end");
      assertBookingRangeOrder(start, end);
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : "Некорректный период аренды");
    }

    const client = await prisma.client.upsert({
      where: { name: body.client.name.trim() },
      update: {
        phone: body.client.phone ?? null,
        email: body.client.email ?? null,
        comment: body.client.comment ?? null,
      },
      create: {
        name: body.client.name.trim(),
        phone: body.client.phone ?? null,
        email: body.client.email ?? null,
        comment: body.client.comment ?? null,
      },
    });

    const estimate = await quoteEstimate({
      startDate: start,
      endDate: end,
      clientId: client.id,
      discountPercent: body.discountPercent ?? null,
      items: body.items.map((it) => ({ equipmentId: it.equipmentId, quantity: it.quantity })),
    });

    const duration = formatRentalDurationDetails(start, end);
    const payload = {
      clientName: body.client.name.trim(),
      projectName: body.projectName.trim(),
      startDate: start,
      endDate: end,
      discountPercent: estimate.discountPercent.toDecimalPlaces(2).toString(),
      shifts: estimate.shifts,
      durationLabel: duration.labelShort,
      subtotal: estimate.subtotal.toDecimalPlaces(2).toString(),
      discountAmount: estimate.discountAmount.toDecimalPlaces(2).toString(),
      totalAfterDiscount: estimate.totalAfterDiscount.toDecimalPlaces(2).toString(),
      comment: body.comment ?? null,
      lines: estimate.lines,
    };

    const human = buildBookingHumanName({
      startDate: start,
      clientName: body.client.name.trim(),
      totalAfterDiscount: estimate.totalAfterDiscount.toDecimalPlaces(2).toString(),
    });
    const fileBase = safeFileName(human);

    const hourText =
      body.hourCalculationOverride?.trim() || formatExportHourCalculationLine(start, end);
    const smetaDoc = buildSmetaExportDocument({
      startDate: start,
      endDate: end,
      clientName: body.client.name.trim(),
      projectName: body.projectName.trim(),
      comment: body.comment ?? null,
      optionalNote: body.estimateOptionalNote ?? null,
      includeOptionalInExport: body.estimateIncludeOptionalInExport ?? false,
      hourCalculationText: hourText,
      shifts: estimate.shifts,
      discountPercent: estimate.discountPercent.toDecimalPlaces(2).toString(),
      subtotal: estimate.subtotal.toDecimalPlaces(2).toString(),
      discountAmount: estimate.discountAmount.toDecimalPlaces(2).toString(),
      totalAfterDiscount: estimate.totalAfterDiscount.toDecimalPlaces(2).toString(),
      lines: estimate.lines,
    });

    if (body.format === "pdf") {
      writeSmetaPdf(res, smetaDoc, `${fileBase}.pdf`);
      return;
    }

    if (body.format === "xlsx") {
      await writeSmetaXlsx(res, smetaDoc, `${fileBase}.xlsx`);
      return;
    }

    const xml = buildQuoteXml(payload);
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.setHeader("Content-Disposition", buildAttachmentContentDisposition(`${fileBase}.xml`, "estimate.xml"));
    res.send(xml);
  } catch (err) {
    next(err);
  }
});

router.post("/draft", async (req, res, next) => {
  try {
    const body = bookingCreateSchema.parse(req.body);
    let start: Date;
    let end: Date;
    try {
      start = parseBookingRangeBound(body.startDate, "start");
      end = parseBookingRangeBound(body.endDate, "end");
      assertBookingRangeOrder(start, end);
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : "Некорректный период аренды");
    }

    const client = await prisma.client.upsert({
      where: { name: body.client.name.trim() },
      update: {
        phone: body.client.phone ?? null,
        email: body.client.email ?? null,
        comment: body.client.comment ?? null,
      },
      create: {
        name: body.client.name.trim(),
        phone: body.client.phone ?? null,
        email: body.client.email ?? null,
        comment: body.client.comment ?? null,
      },
    });

    const booking = await createBookingDraft({
      clientId: client.id,
      projectName: body.projectName,
      startDate: start,
      endDate: end,
      comment: body.comment ?? null,
      discountPercent: body.discountPercent ?? null,
      expectedPaymentDate: body.expectedPaymentDate ? new Date(body.expectedPaymentDate) : null,
      estimateOptionalNote: body.estimateOptionalNote ?? null,
      estimateIncludeOptionalInExport: body.estimateIncludeOptionalInExport ?? false,
      items: body.items.map((it) => ({ equipmentId: it.equipmentId, quantity: it.quantity })),
    });

    res.json({ booking: serializeBookingForApi(booking as any) });
  } catch (err) {
    if (isSchemaOutOfSyncError(err)) {
      next(
        new HttpError(
          500,
          "База данных не синхронизирована со схемой Prisma. Выполните: cd apps/api && npx prisma migrate dev && npx prisma generate",
          { cause: err instanceof Error ? err.message : String(err) },
        ),
      );
      return;
    }
    next(err);
  }
});

router.post("/:id/confirm", async (req, res, next) => {
  try {
    const id = req.params.id;
    // Body can be extended later (idempotency key, override discount, etc.).
    const confirmed = await confirmBooking(id);
    let warning: string | null = null;
    try {
      await recomputeBookingFinance(id);
      await createFinanceEvent({
        bookingId: id,
        eventType: "BOOKING_CONFIRMED",
        payload: { status: confirmed.status },
      });
    } catch (financeErr) {
      warning = financeWarningFromError(financeErr);
      // Не блокируем ответ, если финансы не обновились.
      // eslint-disable-next-line no-console
      console.error("Finance side-effects failed in /confirm:", financeErr);
    }
    res.json({ booking: serializeBookingForApi(confirmed as any), warning });
  } catch (err) {
    next(err);
  }
});

export { router as bookingsRouter };

