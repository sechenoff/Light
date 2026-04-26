import express from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import Decimal from "decimal.js";

import { prisma } from "../prisma";
import { createBookingDraft, confirmBooking, quoteEstimate, rebuildBookingEstimate, CUSTOM_LINE_CATEGORY } from "../services/bookings";
import { submitForApproval, approveBooking, rejectBooking } from "../services/bookingApproval";
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
import { calcBookingPaymentStatus, computeBookingTimeline, computeRelatedExpenses, createFinanceEvent, recomputeBookingFinance } from "../services/finance";
import { buildAttachmentContentDisposition } from "../utils/contentDisposition";
import { rolesGuard } from "../middleware/rolesGuard";
import { writeAuditEntry, diffFields } from "../services/audit";
import { renderInvoicePdf, coalesceWithEnv, type InvoiceLine } from "../services/documentExport/invoice/renderInvoicePdf";
import { renderActPdf, type ActLine } from "../services/documentExport/act/renderActPdf";
import { getSettings } from "../services/organizationService";

const router = express.Router();

/** YYYY-MM-DD или ISO с временем (как от datetime-local → toISOString()). */
const bookingRangeStringSchema = z.string().min(10, "Укажите дату/время начала и окончания аренды");

const bookingItemSchema = z
  .object({
    equipmentId: z.string().min(1).optional(),
    customName: z.string().min(1).max(200).optional(),
    customUnitPrice: z.number().positive().max(100_000_000).optional(),
    quantity: z.number().int().positive(),
  })
  .refine(
    (v) =>
      (v.equipmentId && !v.customName && v.customUnitPrice === undefined) ||
      (!v.equipmentId && v.customName && v.customUnitPrice !== undefined),
    { message: "Укажите либо equipmentId, либо customName + customUnitPrice" },
  );

const transportSchema = z.object({
  vehicleId: z.string().min(1),
  withGenerator: z.boolean().default(false),
  shiftHours: z.number().int().min(0).default(12),
  skipOvertime: z.boolean().default(false),
  kmOutsideMkad: z.number().int().min(0).default(0),
  ttkEntry: z.boolean().default(false),
}).optional().nullable();

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
  /** Если true — возвращает превью брони без записи в БД */
  dryRun: z.boolean().optional().default(false),
  /** Транспорт (опционально) */
  transport: transportSchema,
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
  items: z.array(bookingItemSchema).min(1).optional(),
  /** Если true — возвращает превью изменений брони без записи в БД */
  dryRun: z.boolean().optional().default(false),
  /** Транспорт (опционально) */
  transport: transportSchema,
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

const bookingStatusEnum = z.enum([
  "DRAFT",
  "PENDING_APPROVAL",
  "CONFIRMED",
  "ISSUED",
  "RETURNED",
  "CANCELLED",
]);

router.get("/", async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const statusParam = req.query.status as string | undefined;
    let statusFilter: z.infer<typeof bookingStatusEnum> | undefined;
    if (statusParam) {
      const parsed = bookingStatusEnum.safeParse(statusParam);
      if (!parsed.success) {
        throw new HttpError(400, `Недопустимое значение status: ${statusParam}`, "INVALID_STATUS_FILTER");
      }
      statusFilter = parsed.data;
    }
    const where = statusFilter ? { status: statusFilter } : {};
    const bookings = await prisma.booking.findMany({
      where,
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
        updatedAt: true,
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
        vehicle: true,
        financeEvents: { orderBy: { createdAt: "desc" }, take: 100 },
        payments: {
          where: { direction: "INCOME", OR: [{ status: "RECEIVED" }, { receivedAt: { not: null } }] },
          orderBy: [{ receivedAt: "desc" }, { paymentDate: "desc" }],
          take: 100,
        },
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
    const { financeEvents, scanSessions, payments, ...bookingCore } = booking as any;
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
        payments: (payments ?? []).map((p: any) => ({
          id: p.id,
          amount: p.amount.toString(),
          method: p.method ?? p.paymentMethod,
          receivedAt: (p.receivedAt ?? p.paymentDate)?.toISOString() ?? null,
          direction: p.direction,
          note: p.note ?? p.comment ?? null,
        })),
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
      include: { client: true, items: { include: { equipment: true } }, estimate: { include: { lines: true } } },
    });
    if (!existing) throw new HttpError(404, "Booking not found");

    // ── dryRun: превью изменений без записи в БД ──────────────────────────────
    if (body.dryRun) {
      const start = body.startDate
        ? parseBookingRangeBound(body.startDate, "start")
        : existing.startDate;
      const end = body.endDate
        ? parseBookingRangeBound(body.endDate, "end")
        : existing.endDate;
      assertBookingRangeOrder(start, end);

      const itemsAfter = body.items
        ? body.items.map((it) => ({ equipmentId: it.equipmentId, customName: it.customName, customUnitPrice: it.customUnitPrice, quantity: it.quantity }))
        : existing.items.map((i) => ({ equipmentId: i.equipmentId ?? undefined, customName: (i as any).customName ?? undefined, customUnitPrice: (i as any).customUnitPrice != null ? Number((i as any).customUnitPrice.toString()) : undefined, quantity: i.quantity }));

      const estimate = await quoteEstimate({
        startDate: start,
        endDate: end,
        clientId: existing.clientId,
        discountPercent:
          body.discountPercent !== undefined
            ? body.discountPercent
            : existing.discountPercent
              ? Number(existing.discountPercent)
              : null,
        items: itemsAfter,
      });

      res.json({
        dryRun: true,
        booking: {
          id: existing.id,
          status: existing.status,
          projectName: body.projectName ?? existing.projectName,
          startDate: start,
          endDate: end,
          items: itemsAfter,
          estimate: {
            shifts: estimate.shifts,
            subtotal: estimate.subtotal.toDecimalPlaces(2).toString(),
            discountPercent: estimate.discountPercent.toString(),
            discountAmount: estimate.discountAmount.toDecimalPlaces(2).toString(),
            totalAfterDiscount: estimate.totalAfterDiscount.toDecimalPlaces(2).toString(),
            lines: estimate.lines.map((l) => ({
              equipmentId: l.equipmentId,
              nameSnapshot: l.nameSnapshot,
              quantity: l.quantity,
              unitPrice: l.unitPrice.toDecimalPlaces(2).toString(),
              lineSum: l.lineSum.toDecimalPlaces(2).toString(),
            })),
          },
        },
      });
      return;
    }

    const isSuperAdmin = req.adminUser?.role === "SUPER_ADMIN";
    const allowedStatusesForEdit = isSuperAdmin
      ? ["DRAFT", "CONFIRMED", "PENDING_APPROVAL"]
      : ["DRAFT", "CONFIRMED"];
    if (!allowedStatusesForEdit.includes(existing.status)) {
      const reason =
        existing.status === "PENDING_APPROVAL"
          ? "Бронь на согласовании — править может только руководитель"
          : "Редактирование доступно для черновиков и подтверждённых броней.";
      throw new HttpError(409, reason, "BOOKING_EDIT_FORBIDDEN");
    }

    // Захватываем исходные данные для аудит-записи (если бронь в статусе PENDING_APPROVAL)
    const wasInReview = existing.status === "PENDING_APPROVAL";
    const beforeFinalAmount = existing.finalAmount;
    const beforeItems = existing.items.map((i: any) => ({ equipmentId: i.equipmentId, quantity: i.quantity }));

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
            equipmentId: it.equipmentId ?? null,
            quantity: it.quantity,
            customName: it.customName ?? null,
            customUnitPrice: it.customUnitPrice != null ? new Decimal(it.customUnitPrice) : null,
            customCategory: !it.equipmentId && it.customName ? CUSTOM_LINE_CATEGORY : null,
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

    // Если бронь была в статусе PENDING_APPROVAL, пересчитываем суммы напрямую
    // (rebuildBookingEstimate не обновляет поля на брони, только estimate-snapshot).
    if (wasInReview) {
      try {
        const itemsAfter = body.items
          ? body.items.map((it: any) => ({ equipmentId: it.equipmentId, customName: it.customName, customUnitPrice: it.customUnitPrice, quantity: it.quantity }))
          : existing.items.map((i: any) => ({ equipmentId: i.equipmentId ?? undefined, customName: i.customName ?? undefined, customUnitPrice: i.customUnitPrice != null ? Number(i.customUnitPrice.toString()) : undefined, quantity: i.quantity }));
        const quote = await quoteEstimate({
          startDate: start,
          endDate: end,
          clientId: existing.clientId,
          discountPercent: body.discountPercent !== undefined
            ? body.discountPercent
            : existing.discountPercent
              ? Number(existing.discountPercent)
              : null,
          items: itemsAfter,
          transport: null,
        });
        // finalAmount = equipment-after-discount + transportSubtotal.
        // Transport is on the booking (vehicleId + transportSubtotalRub) —
        // use current value from `existing` since PATCH doesn't change transport in v1.
        const transportSubtotal = existing.transportSubtotalRub
          ? new Decimal(existing.transportSubtotalRub.toString())
          : new Decimal(0);
        const finalAmount = new Decimal(quote.totalAfterDiscount).add(transportSubtotal);
        await prisma.booking.update({
          where: { id },
          data: {
            totalEstimateAmount: quote.subtotal,
            discountAmount: quote.discountAmount,
            finalAmount: finalAmount.toDecimalPlaces(2).toString(),
          },
        });
      } catch {
        // Не блокируем редактирование, если пересчёт не удался
      }
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

    // Аудит редактирования брони на согласовании
    if (wasInReview && req.adminUser?.userId) {
      const afterFinalAmount = freshBooking?.finalAmount ?? null;
      const afterItems = freshBooking?.items?.map((i: any) => ({ equipmentId: i.equipmentId, quantity: i.quantity })) ?? [];
      try {
        await writeAuditEntry({
          userId: req.adminUser.userId,
          action: "BOOKING_EDITED_IN_REVIEW",
          entityType: "Booking",
          entityId: id,
          before: { items: beforeItems, finalAmount: beforeFinalAmount?.toString() ?? null },
          after: { items: afterItems, finalAmount: afterFinalAmount?.toString() ?? null },
        });
      } catch {
        // Аудит — observability, не блокируем ответ
      }
    }

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
      DRAFT: ["cancel"],
      PENDING_APPROVAL: ["cancel"],
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

router.delete("/:id", rolesGuard(["SUPER_ADMIN"]), async (req, res, next) => {
  try {
    const id = req.params.id;
    const userId = req.adminUser!.userId;
    const existing = await prisma.booking.findUnique({
      where: { id },
      select: { id: true, status: true, projectName: true, startDate: true, endDate: true },
    });
    if (!existing) throw new HttpError(404, "Booking not found");
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await writeAuditEntry({
        tx,
        userId,
        action: "delete",
        entityType: "Booking",
        entityId: id,
        before: diffFields(existing as Record<string, unknown>),
        after: null,
      });
      await tx.booking.delete({ where: { id } });
    });
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
        // Conditional spread: only write fields that were explicitly provided.
        // Prevents the booking form (which only collects `name`) from wiping
        // existing phone/email/comment on a Client when autocomplete is used.
        ...(body.client.phone !== undefined ? { phone: body.client.phone } : {}),
        ...(body.client.email !== undefined ? { email: body.client.email } : {}),
        ...(body.client.comment !== undefined ? { comment: body.client.comment } : {}),
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
      items: body.items.map((it) => ({ equipmentId: it.equipmentId, customName: it.customName, customUnitPrice: it.customUnitPrice, quantity: it.quantity })),
      transport: body.transport ?? null,
    });

    const duration = formatRentalDurationDetails(start, end);

    res.json({
      shifts: estimate.shifts,
      totalHours: duration.totalHours,
      durationLabel: duration.labelShort,
      // Equipment-only fields
      equipmentSubtotal: estimate.equipmentSubtotal.toFixed(2),
      equipmentDiscount: estimate.discountAmount.toFixed(2),
      equipmentTotal: estimate.equipmentTotal.toFixed(2),
      // Legacy aliases (backward compat)
      subtotal: estimate.subtotal.toFixed(2),
      discountPercent: estimate.discountPercent.toString(),
      discountAmount: estimate.discountAmount.toFixed(2),
      totalAfterDiscount: estimate.totalAfterDiscount.toFixed(2),
      // Transport
      transport: estimate.transport ?? null,
      // Grand total
      grandTotal: estimate.grandTotal.toFixed(2),
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
        // Conditional spread: only write fields that were explicitly provided.
        // Prevents the booking form (which only collects `name`) from wiping
        // existing phone/email/comment on a Client when autocomplete is used.
        ...(body.client.phone !== undefined ? { phone: body.client.phone } : {}),
        ...(body.client.email !== undefined ? { email: body.client.email } : {}),
        ...(body.client.comment !== undefined ? { comment: body.client.comment } : {}),
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
      items: body.items.map((it) => ({ equipmentId: it.equipmentId, customName: it.customName, customUnitPrice: it.customUnitPrice, quantity: it.quantity })),
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

    // ── dryRun: превью брони без записи в БД ─────────────────────────────────
    if (body.dryRun) {
      // Ищем существующего клиента по имени (не upsert-им)
      const existingClient = await prisma.client.findFirst({
        where: { name: body.client.name.trim() },
        select: { id: true },
      });
      const clientIdForQuote = existingClient?.id ?? "dry-run-placeholder";

      const estimate = await quoteEstimate({
        startDate: start,
        endDate: end,
        clientId: clientIdForQuote,
        discountPercent: body.discountPercent ?? null,
        items: body.items.map((it) => ({ equipmentId: it.equipmentId, customName: it.customName, customUnitPrice: it.customUnitPrice, quantity: it.quantity })),
      });

      res.json({
        dryRun: true,
        booking: {
          id: null,
          status: "DRAFT_PREVIEW",
          client: {
            name: body.client.name.trim(),
            phone: body.client.phone ?? null,
            email: body.client.email ?? null,
          },
          projectName: body.projectName,
          startDate: start,
          endDate: end,
          items: body.items,
          estimate: {
            shifts: estimate.shifts,
            subtotal: estimate.subtotal.toDecimalPlaces(2).toString(),
            discountPercent: estimate.discountPercent.toString(),
            discountAmount: estimate.discountAmount.toDecimalPlaces(2).toString(),
            totalAfterDiscount: estimate.totalAfterDiscount.toDecimalPlaces(2).toString(),
            lines: estimate.lines.map((l) => ({
              equipmentId: l.equipmentId,
              nameSnapshot: l.nameSnapshot,
              quantity: l.quantity,
              unitPrice: l.unitPrice.toDecimalPlaces(2).toString(),
              lineSum: l.lineSum.toDecimalPlaces(2).toString(),
            })),
          },
        },
      });
      return;
    }

    const client = await prisma.client.upsert({
      where: { name: body.client.name.trim() },
      update: {
        // Conditional spread: only write fields that were explicitly provided.
        // Prevents the booking form (which only collects `name`) from wiping
        // existing phone/email/comment on a Client when autocomplete is used.
        ...(body.client.phone !== undefined ? { phone: body.client.phone } : {}),
        ...(body.client.email !== undefined ? { email: body.client.email } : {}),
        ...(body.client.comment !== undefined ? { comment: body.client.comment } : {}),
      },
      create: {
        name: body.client.name.trim(),
        phone: body.client.phone ?? null,
        email: body.client.email ?? null,
        comment: body.client.comment ?? null,
      },
    });

    // Compute transport snapshot if provided
    let transportSnapshot = null;
    if (body.transport) {
      const vehicleForDraft = await prisma.vehicle.findUnique({ where: { id: body.transport.vehicleId } });
      if (!vehicleForDraft) throw new HttpError(400, `Vehicle not found: ${body.transport.vehicleId}`);
      const { computeTransportPrice: calcTransport } = await import("../services/transportCalculator");
      const breakdown = calcTransport({
        vehicle: {
          shiftPriceRub: vehicleForDraft.shiftPriceRub.toString(),
          hasGeneratorOption: vehicleForDraft.hasGeneratorOption,
          generatorPriceRub: vehicleForDraft.generatorPriceRub?.toString() ?? null,
          shiftHours: vehicleForDraft.shiftHours,
          overtimePercent: vehicleForDraft.overtimePercent.toString(),
        },
        withGenerator: body.transport.withGenerator,
        shiftHours: body.transport.shiftHours,
        skipOvertime: body.transport.skipOvertime,
        kmOutsideMkad: body.transport.kmOutsideMkad,
        ttkEntry: body.transport.ttkEntry,
      });
      transportSnapshot = {
        vehicleId: body.transport.vehicleId,
        withGenerator: body.transport.withGenerator,
        shiftHours: body.transport.shiftHours,
        skipOvertime: body.transport.skipOvertime,
        kmOutsideMkad: body.transport.kmOutsideMkad,
        ttkEntry: body.transport.ttkEntry,
        transportSubtotalRub: breakdown.total,
      };
    }

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
      items: body.items.map((it) => ({ equipmentId: it.equipmentId, customName: it.customName, customUnitPrice: it.customUnitPrice, quantity: it.quantity })),
      transport: transportSnapshot,
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

const backdateSchema = z.object({
  startDate: bookingRangeStringSchema.optional(),
  endDate: bookingRangeStringSchema.optional(),
  reason: z.string().min(1, "Укажите причину изменения дат"),
});

const financeCorrectionsSchema = z
  .object({
    clientId: z.string().min(1).optional(),
    projectName: z.string().min(1).optional(),
    finalAmount: z.coerce.number().nonnegative().optional(),
  })
  .refine((v) => v.clientId !== undefined || v.projectName !== undefined || v.finalAmount !== undefined, {
    message: "Укажите хотя бы одно поле для изменения",
  });

/**
 * PATCH /api/bookings/:id/finance-corrections
 * Быстрые финансовые корректировки на странице /finance/payments-overview.
 * Разрешает точечно менять клиента, проект и (для legacy-импортов) итоговую сумму брони.
 * Доступ: только SUPER_ADMIN. Пишет AuditEntry.
 */
router.patch("/:id/finance-corrections", rolesGuard(["SUPER_ADMIN"]), async (req, res, next) => {
  try {
    const id = req.params.id;
    const body = financeCorrectionsSchema.parse(req.body);

    if (!req.adminUser) {
      throw new HttpError(401, "Требуется авторизация", "UNAUTHENTICATED");
    }
    const { userId } = req.adminUser;

    const existing = await prisma.booking.findUnique({
      where: { id },
      include: { client: true },
    });
    if (!existing) throw new HttpError(404, "Бронь не найдена");

    if (body.finalAmount !== undefined && !existing.isLegacyImport) {
      throw new HttpError(
        409,
        "Ручное изменение итоговой суммы разрешено только для legacy-импортов. Откройте карточку брони и отредактируйте смету.",
        "FINANCE_OVERRIDE_FORBIDDEN",
      );
    }

    let nextClient = existing.client;
    if (body.clientId && body.clientId !== existing.clientId) {
      const candidate = await prisma.client.findUnique({ where: { id: body.clientId } });
      if (!candidate) throw new HttpError(404, "Клиент не найден", "CLIENT_NOT_FOUND");
      nextClient = candidate;
    }

    const updateData: Prisma.BookingUpdateInput = {};
    if (body.clientId && body.clientId !== existing.clientId) {
      updateData.client = { connect: { id: body.clientId } };
    }
    if (body.projectName !== undefined) {
      updateData.projectName = body.projectName.trim();
    }

    if (body.finalAmount !== undefined) {
      const finalDec = new Decimal(body.finalAmount).toDecimalPlaces(2);
      const amountPaidDec = new Decimal(existing.amountPaid.toString());
      const outstandingDec = Decimal.max(finalDec.sub(amountPaidDec), new Decimal(0));
      const paymentStatus = calcBookingPaymentStatus({
        finalAmount: finalDec,
        amountPaid: amountPaidDec,
        expectedPaymentDate: existing.expectedPaymentDate,
      });
      updateData.totalEstimateAmount = finalDec.toString();
      updateData.finalAmount = finalDec.toString();
      updateData.amountOutstanding = outstandingDec.toString();
      updateData.paymentStatus = paymentStatus;
      updateData.isFullyPaid = paymentStatus === "PAID";
    }

    const updated = await prisma.$transaction(async (tx) => {
      const booking = await tx.booking.update({
        where: { id },
        data: updateData,
        include: { client: true, items: { include: { equipment: true } }, estimate: { include: { lines: true } } },
      });

      await writeAuditEntry({
        tx,
        userId,
        action: "BOOKING_CORRECTED",
        entityType: "Booking",
        entityId: id,
        before: diffFields({
          clientId: existing.clientId,
          clientName: existing.client.name,
          projectName: existing.projectName,
          finalAmount: existing.finalAmount.toString(),
          amountOutstanding: existing.amountOutstanding.toString(),
          paymentStatus: existing.paymentStatus,
        }),
        after: diffFields({
          clientId: booking.clientId,
          clientName: nextClient.name,
          projectName: booking.projectName,
          finalAmount: booking.finalAmount.toString(),
          amountOutstanding: booking.amountOutstanding.toString(),
          paymentStatus: booking.paymentStatus,
        }),
      });

      return booking;
    });

    res.json({ booking: serializeBookingForApi(updated as any) });
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/bookings/:id/backdate — смена дат задним числом (только SUPER_ADMIN). Пишет AuditEntry. */
router.patch("/:id/backdate", rolesGuard(["SUPER_ADMIN"]), async (req, res, next) => {
  try {
    const id = req.params.id;
    const body = backdateSchema.parse(req.body);

    // После rolesGuard req.adminUser гарантированно есть, но защищаемся явно
    if (!req.adminUser) {
      throw new HttpError(401, "Требуется авторизация", "UNAUTHENTICATED");
    }
    const { userId } = req.adminUser;

    const existing = await prisma.booking.findUnique({
      where: { id },
      select: { id: true, startDate: true, endDate: true, status: true, projectName: true },
    });
    if (!existing) throw new HttpError(404, "Бронь не найдена");

    const updateData: Record<string, unknown> = {};
    if (body.startDate) updateData.startDate = new Date(body.startDate);
    if (body.endDate) updateData.endDate = new Date(body.endDate);

    // Обновление и запись аудита в одной транзакции — если audit упадёт, бронь не изменится
    const updated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const updatedBooking = await tx.booking.update({
        where: { id },
        data: updateData,
        include: { client: true, items: { include: { equipment: true } }, estimate: { include: { lines: true } } },
      });

      await writeAuditEntry({
        tx,
        userId,
        action: "BOOKING_BACKDATE_EDIT",
        entityType: "Booking",
        entityId: id,
        before: {
          startDate: existing.startDate.toISOString(),
          endDate: existing.endDate.toISOString(),
          status: existing.status,
          projectName: existing.projectName,
        },
        after: {
          startDate: updatedBooking.startDate.toISOString(),
          endDate: updatedBooking.endDate.toISOString(),
          status: updatedBooking.status,
          reason: body.reason,
        },
      });

      return updatedBooking;
    });

    res.json({ booking: serializeBookingForApi(updated as any) });
  } catch (err) {
    next(err);
  }
});

const rejectSchema = z.object({
  reason: z.string().min(1, "Укажите причину отклонения").max(2000),
});

/** POST /api/bookings/:id/submit-for-approval — DRAFT → PENDING_APPROVAL (SUPER_ADMIN + WAREHOUSE). */
router.post(
  "/:id/submit-for-approval",
  rolesGuard(["SUPER_ADMIN", "WAREHOUSE"]),
  async (req, res, next) => {
    try {
      if (!req.adminUser) throw new HttpError(401, "Требуется авторизация", "UNAUTHENTICATED");
      const updated = await submitForApproval(req.params.id, req.adminUser.userId);
      res.json({ booking: serializeBookingForApi(updated as any) });
    } catch (err) {
      next(err);
    }
  },
);

/** POST /api/bookings/:id/approve — PENDING_APPROVAL → CONFIRMED (только SUPER_ADMIN). */
router.post(
  "/:id/approve",
  rolesGuard(["SUPER_ADMIN"]),
  async (req, res, next) => {
    try {
      if (!req.adminUser) throw new HttpError(401, "Требуется авторизация", "UNAUTHENTICATED");
      const updated = await approveBooking(req.params.id, req.adminUser.userId);

      // Finance side-effects — same pattern as POST /:id/confirm
      let warning: string | null = null;
      try {
        await recomputeBookingFinance(req.params.id);
        await createFinanceEvent({
          bookingId: req.params.id,
          eventType: "BOOKING_CONFIRMED",
          payload: { status: updated.status, via: "approve" },
        });
      } catch (financeErr) {
        warning = financeWarningFromError(financeErr);
        // eslint-disable-next-line no-console
        console.error("Finance side-effects failed after approve:", financeErr);
      }

      res.json({ booking: serializeBookingForApi(updated as any), warning });
    } catch (err) {
      next(err);
    }
  },
);

/** POST /api/bookings/:id/reject — PENDING_APPROVAL → DRAFT + причина (только SUPER_ADMIN). */
router.post(
  "/:id/reject",
  rolesGuard(["SUPER_ADMIN"]),
  async (req, res, next) => {
    try {
      if (!req.adminUser) throw new HttpError(401, "Требуется авторизация", "UNAUTHENTICATED");
      const body = rejectSchema.parse(req.body);
      const updated = await rejectBooking(req.params.id, req.adminUser.userId, body.reason);
      res.json({ booking: serializeBookingForApi(updated as any) });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /api/bookings/:id/cancel-with-deposit ────────────────────────────────
// H5: Атомарная отмена брони + обработка депозита в одной транзакции.
// Три ветки: REFUND (создаёт Refund), CREDIT (создаёт CreditNote), FORFEIT (только аудит).

const cancelWithDepositSchema = z.object({
  disposition: z.enum(["REFUND", "CREDIT", "FORFEIT"]),
  refund: z
    .object({
      amount: z.number().positive(),
      method: z.enum(["CASH", "BANK_TRANSFER", "CARD", "OTHER"]),
      reason: z.string().trim().min(3),
    })
    .optional(),
  credit: z
    .object({
      contactClientId: z.string().min(1),
      amount: z.number().positive(),
      reason: z.string().trim().min(3),
      expiresAt: z.string().datetime().optional(),
    })
    .optional(),
});

router.post(
  "/:id/cancel-with-deposit",
  rolesGuard(["SUPER_ADMIN"]),
  async (req, res, next) => {
    try {
      const userId = req.adminUser!.userId;
      const body = cancelWithDepositSchema.parse(req.body);

      const booking = await prisma.booking.findUnique({
        where: { id: req.params.id },
        include: { payments: { where: { voidedAt: null, direction: "INCOME" } } },
      });
      if (!booking) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");

      const allowedStatuses = ["DRAFT", "PENDING_APPROVAL", "CONFIRMED"];
      if (!allowedStatuses.includes(booking.status)) {
        throw new HttpError(409, `Нельзя отменить бронь в статусе ${booking.status}`, "INVALID_BOOKING_STATE");
      }

      const depositTotal = booking.payments.reduce(
        (acc, p) => acc.add(new Decimal(p.amount.toString())),
        new Decimal(0),
      );
      if (depositTotal.lessThanOrEqualTo(0)) {
        throw new HttpError(409, "У брони нет открытых платежей для обработки депозита", "NO_DEPOSIT");
      }

      // Validate branch-specific fields
      if (body.disposition === "REFUND" && !body.refund) {
        throw new HttpError(400, "Для ветки REFUND необходимо поле refund", "REFUND_REQUIRED");
      }
      if (body.disposition === "CREDIT" && !body.credit) {
        throw new HttpError(400, "Для ветки CREDIT необходимо поле credit", "CREDIT_REQUIRED");
      }

      // D8: Валидация — сумма возврата не может превышать фактически полученный депозит
      if (body.disposition === "REFUND" && body.refund) {
        if (new Decimal(body.refund.amount).gt(depositTotal)) {
          throw new HttpError(400, "Сумма возврата превышает депозит", "REFUND_EXCEEDS_DEPOSIT");
        }
      }

      await prisma.$transaction(async (tx) => {
        type TxClientLocal = Omit<
          Prisma.TransactionClient,
          "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends" | "$use"
        >;

        // Выполняем ветку
        if (body.disposition === "REFUND" && body.refund) {
          await tx.refund.create({
            data: {
              bookingId: booking.id,
              amount: new Decimal(body.refund.amount).toDecimalPlaces(2).toString(),
              reason: body.refund.reason,
              method: body.refund.method,
              refundedAt: new Date(),
              createdBy: userId,
            },
          });
          await writeAuditEntry({
            tx: tx as TxClientLocal,
            userId,
            action: "REFUND_CREATE",
            entityType: "Payment",
            entityId: booking.id,
            before: null,
            after: diffFields({ disposition: "REFUND", amount: body.refund.amount, method: body.refund.method, reason: body.refund.reason } as Record<string, unknown>),
          });
        } else if (body.disposition === "CREDIT" && body.credit) {
          await tx.creditNote.create({
            data: {
              contactClientId: body.credit.contactClientId,
              bookingId: booking.id,
              amount: new Decimal(body.credit.amount).toDecimalPlaces(2).toString(),
              remaining: new Decimal(body.credit.amount).toDecimalPlaces(2).toString(),
              reason: body.credit.reason,
              expiresAt: body.credit.expiresAt ? new Date(body.credit.expiresAt) : null,
              createdBy: userId,
            },
          });
          await writeAuditEntry({
            tx: tx as TxClientLocal,
            userId,
            action: "CREDIT_NOTE_CREATE",
            entityType: "Payment",
            entityId: booking.id,
            before: null,
            after: diffFields({ disposition: "CREDIT", amount: body.credit.amount, reason: body.credit.reason } as Record<string, unknown>),
          });
        } else if (body.disposition === "FORFEIT") {
          // FORFEIT: только аудит, деньги остаются без движения
          await tx.booking.update({
            where: { id: booking.id },
            data: { forfeitedAt: new Date() },
          });
          await writeAuditEntry({
            tx: tx as TxClientLocal,
            userId,
            action: "BOOKING_DEPOSIT_FORFEITED",
            entityType: "Booking",
            entityId: booking.id,
            before: null,
            after: diffFields({ disposition: "FORFEIT", depositTotal: depositTotal.toString() } as Record<string, unknown>),
          });
        }

        // Отменяем бронь
        await tx.booking.update({
          where: { id: booking.id },
          data: { status: "CANCELLED" },
        });

        // D5: Пересчитываем финансовые агрегаты после отмены (amountPaid, amountOutstanding, paymentStatus)
        await recomputeBookingFinance(booking.id, tx as TxClientLocal);

        // Единая аудит-запись объединяющего события
        await writeAuditEntry({
          tx: tx as TxClientLocal,
          userId,
          action: "BOOKING_CANCEL_WITH_DEPOSIT",
          entityType: "Booking",
          entityId: booking.id,
          before: diffFields({ status: booking.status, depositTotal: depositTotal.toString() } as Record<string, unknown>),
          after: diffFields({ status: "CANCELLED", disposition: body.disposition } as Record<string, unknown>),
        });
      });

      // D1: Re-fetch с полными relation-ами после транзакции — tx.booking.update не включает items
      const result = await prisma.booking.findUnique({
        where: { id: req.params.id },
        include: {
          client: true,
          items: { include: { equipment: true } },
          estimate: { include: { lines: true } },
        },
      });
      if (!result) throw new HttpError(404, "Бронь не найдена после отмены", "BOOKING_NOT_FOUND");

      res.json({ booking: serializeBookingForApi(result as any) });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /api/bookings/:id/invoice.pdf ─────────────────────────────────────────

router.get(
  "/:id/invoice.pdf",
  rolesGuard(["SUPER_ADMIN", "WAREHOUSE"]),
  async (req, res, next) => {
    try {
      const booking = await prisma.booking.findUnique({
        where: { id: req.params.id },
        include: {
          client: true,
          estimate: { include: { lines: true } },
          items: { include: { equipment: true } },
        },
      });
      if (!booking) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");

      // Счёт недоступен для отменённых броней
      if (booking.status === "CANCELLED") {
        throw new HttpError(409, "Счёт недоступен: бронь отменена", {
          code: "INVOICE_NOT_AVAILABLE",
          reason: "BOOKING_CANCELLED",
        });
      }

      // Finance Phase 2: если бронь post-cutoff (legacyFinance=false) и есть Invoice — перенаправляем
      if (!booking.legacyFinance) {
        const existingInvoice = await prisma.invoice.findFirst({
          where: { bookingId: booking.id, status: { not: "VOID" } },
          orderBy: { createdAt: "desc" },
        });
        if (existingInvoice) {
          // Сообщаем клиенту использовать /api/invoices/:id/pdf
          throw new HttpError(409, "Используйте /api/invoices/:id/pdf для этой брони", {
            code: "USE_INVOICE_PDF",
            invoiceId: existingInvoice.id,
          });
        }
      }

      const orgSettings = await getSettings();
      const org = coalesceWithEnv(orgSettings);
      const invoiceNumber = `LR-DRAFT-${booking.id.slice(0, 8).toUpperCase()}`;
      const invoiceDate = new Date().toLocaleDateString("ru-RU");

      // Строки берём из estimate.lines если есть, иначе из booking.items
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
        subtotal = booking.finalAmount.toString();
        totalAfterDiscount = booking.finalAmount.toString();
      }

      const pdfBuf = await renderInvoicePdf(
        { invoiceNumber, invoiceDate, clientName: booking.client.name, lines, subtotal, discountPercent, discountAmount, totalAfterDiscount },
        org,
      );

      const dateStr = new Date().toISOString().slice(0, 10);
      const filename = `Счёт_${booking.id.slice(0, 8)}_${dateStr}.pdf`;
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", buildAttachmentContentDisposition(filename, "invoice.pdf"));
      res.end(pdfBuf);
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /api/bookings/:id/act.pdf ─────────────────────────────────────────────

router.get(
  "/:id/act.pdf",
  rolesGuard(["SUPER_ADMIN", "WAREHOUSE"]),
  async (req, res, next) => {
    try {
      const booking = await prisma.booking.findUnique({
        where: { id: req.params.id },
        include: {
          client: true,
          estimate: { include: { lines: true } },
          items: { include: { equipment: true } },
        },
      });
      if (!booking) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");

      // Акт доступен только при RETURNED и нулевой задолженности
      if (booking.status !== "RETURNED") {
        throw new HttpError(409, "Акт недоступен: бронь не завершена", {
          code: "ACT_NOT_AVAILABLE",
          reason: "BOOKING_NOT_RETURNED",
          actual: booking.status,
        });
      }
      if (new Decimal(booking.amountOutstanding.toString()).greaterThan(0)) {
        throw new HttpError(409, "Акт недоступен: есть задолженность", {
          code: "ACT_NOT_AVAILABLE",
          reason: "OUTSTANDING_DEBT",
          amountOutstanding: booking.amountOutstanding.toString(),
        });
      }

      const orgSettings = await getSettings();
      const org = coalesceWithEnv(orgSettings);
      const actNumber = `LR-ACT-${booking.id.slice(0, 8).toUpperCase()}`;
      const actDate = new Date().toLocaleDateString("ru-RU");

      let actLines: ActLine[];
      let totalAmount: string;

      if (booking.estimate) {
        actLines = booking.estimate.lines.map((l, i) => ({
          index: i + 1,
          name: l.nameSnapshot,
          quantity: l.quantity,
          unitPrice: l.unitPrice.toString(),
          lineSum: l.lineSum.toString(),
        }));
        totalAmount = booking.estimate.totalAfterDiscount.toString();
      } else {
        actLines = booking.items.map((item, i) => {
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
        totalAmount = booking.finalAmount.toString();
      }

      const pdfBuf = await renderActPdf(
        { actNumber, actDate, clientName: booking.client.name, lines: actLines, totalAmount },
        org,
      );

      const dateStr = new Date().toISOString().slice(0, 10);
      const filename = `Акт_${booking.id.slice(0, 8)}_${dateStr}.pdf`;
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", buildAttachmentContentDisposition(filename, "act.pdf"));
      res.end(pdfBuf);
    } catch (err) {
      next(err);
    }
  },
);

// ── B5: GET /api/bookings/:id/related-expenses ───────────────────────────────

router.get(
  "/:id/related-expenses",
  rolesGuard(["SUPER_ADMIN", "WAREHOUSE"]),
  async (req, res, next) => {
    try {
      const booking = await prisma.booking.findUnique({ where: { id: req.params.id }, select: { id: true } });
      if (!booking) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");
      const result = await computeRelatedExpenses(req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

// ── B4: GET /api/bookings/:id/finance-timeline ───────────────────────────────

router.get(
  "/:id/finance-timeline",
  rolesGuard(["SUPER_ADMIN", "WAREHOUSE"]),
  async (req, res, next) => {
    try {
      const booking = await prisma.booking.findUnique({ where: { id: req.params.id }, select: { id: true } });
      if (!booking) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");
      const events = await computeBookingTimeline(req.params.id);
      res.json(events);
    } catch (err) {
      next(err);
    }
  },
);

export { router as bookingsRouter };

