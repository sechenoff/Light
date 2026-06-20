import express from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import Decimal from "decimal.js";

import { prisma } from "../prisma";
import { createBookingDraft, confirmBooking, quoteEstimate, rebuildBookingEstimate, releaseBookingUnits, CUSTOM_LINE_CATEGORY } from "../services/bookings";
import { submitForApproval, approveBooking, rejectBooking } from "../services/bookingApproval";
import { HttpError } from "../utils/errors";
import {
  assertBookingRangeOrder,
  formatRentalDurationDetails,
  parseBookingRangeBound,
} from "../utils/dates";
import { serializeBookingForApi } from "../utils/serializeDecimal";
import { buildQuoteXml } from "../services/quoteExport";
import {
  buildSmetaExportDocument,
  writeSmetaPdf,
  writeSmetaXlsx,
  buildFullSmeta,
  writeFullSmetaPdf,
  writeFullSmetaXlsx,
} from "../services/smetaExport";
import { formatExportHourCalculationLine } from "../utils/dates";
import { buildBookingHumanName, safeFileName } from "../utils/bookingName";
import { calcBookingPaymentStatus, computeBookingTimeline, computeRelatedExpenses, createFinanceEvent, recomputeBookingFinance } from "../services/finance";
import { buildAttachmentContentDisposition } from "../utils/contentDisposition";
import { rolesGuard } from "../middleware/rolesGuard";
import { writeAuditEntry, diffFields } from "../services/audit";
import { buildBookingEstimatePdf, buildBookingActPdf } from "../services/documentExport/bookingPdf";
import { toMoscowDateString, fromMoscowDateString, addDays } from "../utils/moscowDate";

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

const transportVehicleSchema = z.object({
  vehicleId: z.string().min(1),
  withGenerator: z.boolean().default(false),
  shiftHours: z.number().int().min(0).default(12),
  skipOvertime: z.boolean().default(false),
  kmOutsideMkad: z.number().int().min(0).default(0),
  ttkEntry: z.boolean().default(false),
});

/**
 * Schema для inline-обновления водителя на конкретной BookingVehicle.
 * Заполняется при погрузке (выдаче) — ведём учёт, кто ездил за рулём.
 * Передавайте `null` чтобы очистить поле; `undefined` (не передано) — не трогать.
 */
const driverUpdateSchema = z
  .object({
    driverName: z.string().trim().max(120).nullable().optional(),
    driverPhone: z.string().trim().max(40).nullable().optional(),
  })
  .refine(
    (b) => b.driverName !== undefined || b.driverPhone !== undefined,
    { message: "Передайте driverName и/или driverPhone" },
  );

/**
 * Транспорт брони: массив машин, у каждой свои параметры (per-row).
 * Машины должны быть DISTINCT (одна и та же машина не дважды).
 */
const transportSchema = z
  .array(transportVehicleSchema)
  .refine(
    (rows) => {
      const ids = rows.map((r) => r.vehicleId);
      return new Set(ids).size === ids.length;
    },
    { message: "Одна машина не может быть выбрана дважды" },
  )
  .optional()
  .nullable();

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
  expectedPaymentDate: z.string().refine((s) => !isNaN(Date.parse(s)), "Invalid date").optional().nullable(),
  /** Доп. текст в экспорте (PDF/XLSX), опционально */
  estimateOptionalNote: z.string().optional().nullable(),
  estimateIncludeOptionalInExport: z.boolean().optional(),
  /** «Не считать вторые сутки»: прощать хвост ≤ 4 ч сверх целых суток */
  skipPartialDay: z.boolean().optional().default(false),
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
  expectedPaymentDate: z.string().refine((s) => !isNaN(Date.parse(s)), "Invalid date").optional().nullable(),
  items: z.array(bookingItemSchema).min(1).optional(),
  /** «Не считать вторые сутки»: прощать хвост ≤ 4 ч сверх целых суток */
  skipPartialDay: z.boolean().optional(),
  /** Если true — возвращает превью изменений брони без записи в БД */
  dryRun: z.boolean().optional().default(false),
  /**
   * Ретро-редактирование закрытой брони (RETURNED). Доступно ТОЛЬКО SUPER_ADMIN.
   * Без этого флага PATCH на RETURNED → 409 BOOKING_EDIT_FORBIDDEN.
   * При сохранении пишется отдельная audit-запись BOOKING_RETROACTIVE_EDIT в
   * дополнение к обычной BOOKING_EDITED — для финансового аудита.
   */
  retroactive: z.boolean().optional().default(false),
  /**
   * Ручной override итоговой суммы брони. Доступно только в retroactive-режиме.
   * - `null` → очистить override, вернуть автоматический расчёт.
   * - число → перетирает finalAmount; amountOutstanding / paymentStatus
   *   пересчитываются от этой суммы.
   * Используется когда фактическая сумма по итогам переговоров отличается от
   * сметы (например, скидка «на месте», или возврат с допуслугами без
   * добавления позиций).
   */
  manualFinalAmount: z.number().finite().min(0).max(1_000_000_000).optional().nullable(),
  /**
   * In-place правки транспорта в retro-mode: водитель, телефон, итоговый
   * пробег по каждой машине брони. Это НЕ полная замена транспорта (как
   * body.transport ниже) — точечные изменения по bookingVehicleId.
   *
   * - driverName / driverPhone — простой update BookingVehicle.
   * - endMileage — записывает VehicleMileageLog (source=MANUAL, recordedBy =
   *   AdminUser.username), обновляет Vehicle.currentMileage; 409
   *   MILEAGE_DECREASE если меньше текущего.
   *
   * Игнорируется когда retroactive !== true.
   */
  vehicleEdits: z.array(
    z.object({
      bookingVehicleId: z.string().min(1),
      driverName: z.string().nullable().optional(),
      driverPhone: z.string().nullable().optional(),
      endMileage: z.number().int().min(0).nullable().optional(),
    }),
  ).optional(),
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
    const cursor = typeof req.query.cursor === "string" && req.query.cursor.length > 0 ? req.query.cursor : null;
    const statusParam = req.query.status as string | undefined;
    let statusFilter: z.infer<typeof bookingStatusEnum> | undefined;
    if (statusParam) {
      const parsed = bookingStatusEnum.safeParse(statusParam);
      if (!parsed.success) {
        throw new HttpError(400, `Недопустимое значение status: ${statusParam}`, "INVALID_STATUS_FILTER");
      }
      statusFilter = parsed.data;
    }
    // ?archived=true → только архивированные (для страницы /bookings/archive).
    // По умолчанию (без флага) — только живые брони (deletedAt: null).
    // Принимаем "true"/"1" как truthy, остальное — false.
    const archivedParam = typeof req.query.archived === "string" ? req.query.archived : "";
    const archivedFilter = archivedParam === "true" || archivedParam === "1";

    // Серверный фильтр оплаты. Бинарный (как UI): PAID | UNPAID(всё кроме PAID).
    const paidParam = typeof req.query.paid === "string" ? req.query.paid : "";
    const paidWhere: Prisma.BookingWhereInput =
      paidParam === "PAID"
        ? { paymentStatus: "PAID" }
        : paidParam === "UNPAID"
          ? { paymentStatus: { not: "PAID" } }
          : {};

    // Серверный фильтр по ДАТЕ СМЕНЫ (startDate). from/to — YYYY-MM-DD в МСК,
    // включительно по обе границы (to = до начала следующего дня).
    const fromParam = typeof req.query.from === "string" ? req.query.from : "";
    const toParam = typeof req.query.to === "string" ? req.query.to : "";
    const startDateRange: Prisma.DateTimeFilter = {};
    if (/^\d{4}-\d{2}-\d{2}$/.test(fromParam)) startDateRange.gte = fromMoscowDateString(fromParam);
    if (/^\d{4}-\d{2}-\d{2}$/.test(toParam)) startDateRange.lt = addDays(fromMoscowDateString(toParam), 1);
    const dateWhere: Prisma.BookingWhereInput =
      Object.keys(startDateRange).length > 0 ? { startDate: startDateRange } : {};

    // BL-2: текстовый поиск по названию проекта или имени клиента. SQLite Prisma
    // `contains` регистрозависим — для кириллицы это приемлемо; ищем по обоим полям.
    const qParam = (typeof req.query.q === "string" ? req.query.q : "").trim();
    const searchWhere: Prisma.BookingWhereInput =
      qParam.length > 0
        ? {
            OR: [
              { projectName: { contains: qParam } },
              { client: { is: { name: { contains: qParam } } } },
            ],
          }
        : {};

    const where: Prisma.BookingWhereInput = {
      ...(statusFilter ? { status: statusFilter } : {}),
      ...(archivedFilter ? { deletedAt: { not: null } } : { deletedAt: null }),
      ...paidWhere,
      ...dateWhere,
      ...searchWhere,
    };
    // Сортировка по ДАТЕ СМЕНЫ (startDate desc), а не по createdAt — иначе
    // импортированные задним числом старые брони (2023) с свежим createdAt
    // вылетают в начало списка перед свежими 2026-съёмками. Естественный
    // порядок для оператора: сначала ближайшие/свежие смены.
    // id desc для детерминизма при одинаковом startDate.
    // BL-4: помимо страницы возвращаем честный totalCount под тем же where,
    // чтобы UI показывал «Показано N из M», а не вводящее в заблуждение «N+».
    const totalCount = await prisma.booking.count({ where });
    const bookings = await prisma.booking.findMany({
      where,
      orderBy: [{ startDate: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
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
        deletedAt: true,
        deletedBy: true,
        _count: { select: { scanSessions: true } },
        scanSessions: {
          select: { operation: true, status: true },
          orderBy: { startedAt: "desc" },
          take: 1,
        },
      },
    });
    const hasMore = bookings.length > limit;
    const items = hasMore ? bookings.slice(0, limit) : bookings;
    const nextCursor = hasMore ? items[items.length - 1].id : null;
    res.json({
      bookings: items.map((b) => {
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
      nextCursor,
      totalCount,
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
        estimates: { include: { lines: true } },
        vehicle: true,
        vehicles: { include: { vehicle: true }, orderBy: { createdAt: "asc" } },
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
      totalAfterDiscount: booking.estimates?.find((e) => e.kind === "MAIN")?.totalAfterDiscount?.toString() ?? "0",
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

/**
 * Гард архивных броней. Soft-deleted бронь (deletedAt != null) скрыта из всех
 * списков и не должна меняться: ни статус, ни финансы, ни состав. Вызывается в
 * начале каждого state-changing роута. Восстановление/окончательное удаление
 * (/restore, /purge) специально НЕ используют этот гард — они оперируют именно
 * архивными бронями.
 */
async function assertBookingNotArchived(id: string): Promise<void> {
  const b = await prisma.booking.findUnique({
    where: { id },
    select: { id: true, deletedAt: true },
  });
  if (!b) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");
  if (b.deletedAt) {
    throw new HttpError(
      409,
      "Бронь в архиве — действие недоступно. Сначала восстановите её из архива.",
      "BOOKING_ARCHIVED",
    );
  }
}

router.patch("/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    await assertBookingNotArchived(id);
    const body = bookingUpdateSchema.parse(req.body);
    const existing = await prisma.booking.findUnique({
      where: { id },
      include: { client: true, items: { include: { equipment: true } }, estimates: { include: { lines: true } } },
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
        transport: body.transport ?? null,
        skipPartialDay: body.skipPartialDay !== undefined ? body.skipPartialDay : (existing.skipPartialDay ?? false),
      });

      // grandTotal mirrors the non-dryRun PATCH path: equipment total-after-discount
      // + transportSubtotal. When the dryRun body carries `transport`, use that;
      // otherwise fall back to the booking's persisted transportSubtotalRub
      // (PATCH v1 doesn't mutate transport — same source as the wasInReview recompute).
      const dryRunTransportSubtotal =
        body.transport != null
          ? estimate.transportSubtotal
          : existing.transportSubtotalRub
            ? new Decimal(existing.transportSubtotalRub.toString())
            : new Decimal(0);
      const dryRunGrandTotal = estimate.totalAfterDiscount.add(dryRunTransportSubtotal);

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
            // Transport — array of per-vehicle breakdowns (empty when none) + summed subtotal
            transport: estimate.transport,
            transportSubtotal: dryRunTransportSubtotal.toFixed(2),
            // Grand total = equipment-after-discount + transportSubtotal (same as persisted finalAmount)
            grandTotal: dryRunGrandTotal.toFixed(2),
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
    // SUPER_ADMIN с явным флагом `retroactive: true` может править RETURNED.
    // Это «правка задним числом» — фиксируется отдельным audit-action ниже.
    // Без флага RETURNED не редактируется никем (закрытая бронь, как и было).
    const retroactiveEdit = isSuperAdmin && body.retroactive === true;
    const allowedStatusesForEdit = retroactiveEdit
      ? ["DRAFT", "CONFIRMED", "PENDING_APPROVAL", "RETURNED"]
      : isSuperAdmin
        ? ["DRAFT", "CONFIRMED", "PENDING_APPROVAL"]
        : ["DRAFT", "CONFIRMED"];
    if (!allowedStatusesForEdit.includes(existing.status)) {
      const reason =
        existing.status === "PENDING_APPROVAL"
          ? "Бронь на согласовании — править может только руководитель"
          : existing.status === "RETURNED"
            ? "Бронь возвращена. Для правки задним числом передайте `retroactive: true` (только руководитель)."
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

    // F4+F5: compute resolved expectedPaymentDate for PATCH
    // null from client = re-default (F5, consistent with POST).
    // If endDate changed and existing date was auto-defaulted → recompute (F4).
    let resolvedExpectedPaymentDate: Date | null | undefined;
    if (body.expectedPaymentDate !== undefined && body.expectedPaymentDate !== null) {
      // Explicit user value
      resolvedExpectedPaymentDate = new Date(body.expectedPaymentDate);
    } else {
      // null or undefined from client
      const orgSettings = await prisma.organizationSettings.findUnique({ where: { id: "singleton" } });
      const days = orgSettings?.defaultPaymentTermsDays ?? 7;
      const oldEndMoscow = toMoscowDateString(existing.endDate);
      const oldEndMidnight = fromMoscowDateString(oldEndMoscow);
      const autoDefaultedDate = new Date(oldEndMidnight.getTime() + days * 24 * 60 * 60 * 1000);

      const endChanged = body.endDate !== undefined;
      const existingIsAutoDefault =
        existing.expectedPaymentDate !== null &&
        Math.abs(existing.expectedPaymentDate.getTime() - autoDefaultedDate.getTime()) < 1000;

      if (body.expectedPaymentDate === null || !existing.expectedPaymentDate || (endChanged && existingIsAutoDefault)) {
        // Re-default: compute from new end date
        const newEndMoscow = toMoscowDateString(end);
        const newEndMidnight = fromMoscowDateString(newEndMoscow);
        resolvedExpectedPaymentDate = new Date(newEndMidnight.getTime() + days * 24 * 60 * 60 * 1000);
      } else {
        // Not passed — leave unchanged
        resolvedExpectedPaymentDate = undefined;
      }
    }

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
      const updated = await tx.booking.update({
        where: { id },
        data: {
          projectName: body.projectName?.trim() || undefined,
          startDate: start,
          endDate: end,
          comment: body.comment === undefined ? undefined : body.comment ?? null,
          discountPercent: body.discountPercent === undefined ? undefined : body.discountPercent != null ? new Decimal(body.discountPercent) : null,
          expectedPaymentDate: resolvedExpectedPaymentDate,
          skipPartialDay: body.skipPartialDay === undefined ? undefined : body.skipPartialDay,
          // manualFinalAmount — override итоговой суммы. Доступно только
          // в retroactive-режиме (вне его поле в body игнорируется через
          // условие ниже). null очищает override, число — устанавливает.
          manualFinalAmount:
            retroactiveEdit && body.manualFinalAmount !== undefined
              ? body.manualFinalAmount === null
                ? null
                : new Decimal(body.manualFinalAmount)
              : undefined,
        },
        include: {
          client: true,
          items: { include: { equipment: true } },
          estimates: { include: { lines: true } },
        },
      });

      // ── vehicleEdits — точечные правки транспорта в retro-mode ───────────
      // Применяются ВНУТРИ той же транзакции что и update брони, чтобы
      // отказ MILEAGE_DECREASE откатывал ВСЁ редактирование (а не оставлял
      // booking обновлённым с битым транспортом).
      if (retroactiveEdit && body.vehicleEdits && body.vehicleEdits.length > 0) {
        for (const edit of body.vehicleEdits) {
          const bv = await tx.bookingVehicle.findUnique({
            where: { id: edit.bookingVehicleId },
            include: { vehicle: true },
          });
          if (!bv || bv.bookingId !== id) {
            throw new HttpError(
              404,
              `Машина брони ${edit.bookingVehicleId} не найдена`,
              "VEHICLE_NOT_IN_BOOKING",
            );
          }

          // 1. driverName / driverPhone (если переданы — null очищает, undefined не трогает)
          const driverPatch: { driverName?: string | null; driverPhone?: string | null } = {};
          if (edit.driverName !== undefined) driverPatch.driverName = edit.driverName;
          if (edit.driverPhone !== undefined) driverPatch.driverPhone = edit.driverPhone;
          if (Object.keys(driverPatch).length > 0) {
            await tx.bookingVehicle.update({
              where: { id: edit.bookingVehicleId },
              data: driverPatch,
            });
          }

          // 2. endMileage — записываем VehicleMileageLog (MANUAL) и
          //    обновляем Vehicle.currentMileage. Проверяем не-убывание.
          if (edit.endMileage !== undefined && edit.endMileage !== null) {
            const current = bv.vehicle.currentMileage;
            if (edit.endMileage < current) {
              throw new HttpError(
                409,
                `Пробег "${bv.vehicle.name}" (${edit.endMileage}) меньше текущего (${current}). Одометр не уменьшается.`,
                "MILEAGE_DECREASE",
                { vehicleId: bv.vehicleId, current, attempted: edit.endMileage },
              );
            }
            // Не дублируем запись если значение не изменилось.
            if (edit.endMileage !== current) {
              await tx.vehicleMileageLog.create({
                data: {
                  vehicleId: bv.vehicleId,
                  mileage: edit.endMileage,
                  source: "MANUAL",
                  bookingId: id,
                  recordedBy: req.adminUser?.username ?? "_system_",
                  note: "Ретро-правка пробега",
                },
              });
              await tx.vehicle.update({
                where: { id: bv.vehicleId },
                data: { currentMileage: edit.endMileage },
              });
            }
          }
        }
      }

      return updated;
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
          skipPartialDay: body.skipPartialDay !== undefined ? body.skipPartialDay : (existing.skipPartialDay ?? false),
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
    // Включаем vehicles[] для гидрации формы редактирования (PATCH не меняет
    // транспорт в v1, но клиенту нужны машины для отображения/правок).
    const freshBooking = await prisma.booking.findUnique({
      where: { id },
      include: {
        client: true,
        items: { include: { equipment: true } },
        estimates: { include: { lines: true } },
        vehicles: { include: { vehicle: true }, orderBy: { createdAt: "asc" } },
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

    // Аудит ретро-правки закрытой брони. Пишется ОТДЕЛЬНО от BOOKING_EDITED
    // (createFinanceEvent), потому что финансово-чувствительная операция —
    // меняет уже зафиксированную смету RETURNED-брони и видна в /admin/audit
    // как отдельная категория для финансового контроля.
    if (retroactiveEdit && req.adminUser?.userId) {
      const afterFinalAmount = freshBooking?.finalAmount ?? null;
      const afterItems = freshBooking?.items?.map((i: any) => ({
        equipmentId: i.equipmentId,
        quantity: i.quantity,
        customName: (i as any).customName ?? null,
        customUnitPrice: (i as any).customUnitPrice?.toString() ?? null,
      })) ?? [];
      try {
        await writeAuditEntry({
          userId: req.adminUser.userId,
          action: "BOOKING_RETROACTIVE_EDIT",
          entityType: "Booking",
          entityId: id,
          before: {
            status: existing.status,
            projectName: existing.projectName,
            discountPercent: existing.discountPercent?.toString() ?? null,
            finalAmount: beforeFinalAmount?.toString() ?? null,
            manualFinalAmount: (existing as any).manualFinalAmount?.toString() ?? null,
            items: beforeItems,
          },
          after: {
            status: freshBooking?.status ?? existing.status,
            projectName: freshBooking?.projectName ?? existing.projectName,
            discountPercent: freshBooking?.discountPercent?.toString() ?? null,
            finalAmount: afterFinalAmount?.toString() ?? null,
            manualFinalAmount: (freshBooking as any)?.manualFinalAmount?.toString() ?? null,
            items: afterItems,
          },
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
    await assertBookingNotArchived(id);
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

    // NB: ветка `body.action === "confirm"` намеренно удалена (C1).
    // Ни один статус в allowedActionsByStatus не содержит "confirm" — DRAFT
    // подтверждается только через approval workflow (submit-for-approval →
    // approve). Bot использует отдельный POST /:id/confirm. Старая ветка была
    // недостижима и служила легаси-bypass согласования.

    const nextStatus =
      body.action === "issue"
        ? "ISSUED"
        : body.action === "return"
          ? "RETURNED"
          : body.action === "cancel"
            ? "CANCELLED"
            : booking.status;

    const bookingUpdateData = {
      status: nextStatus,
      expectedPaymentDate:
        body.expectedPaymentDate !== undefined ? (body.expectedPaymentDate ? new Date(body.expectedPaymentDate) : null) : undefined,
      paymentComment: body.paymentComment === undefined ? undefined : body.paymentComment ?? null,
    };
    const bookingInclude = {
      client: true,
      items: { include: { equipment: true } },
      estimates: { include: { lines: true } },
    } as const;

    let updated;
    if (body.action === "cancel") {
      // C2: при отмене освобождаем UNIT-резервы в той же транзакции, что и
      // смена статуса + аудит. Без этого equipmentUnit.status застревал в
      // ISSUED, а BookingItemUnit-резервы не снимались.
      const auditUserId = req.adminUser?.userId ?? "system";
      updated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const u = await tx.booking.update({
          where: { id },
          data: bookingUpdateData,
          include: bookingInclude,
        });
        const released = await releaseBookingUnits(id, tx);
        await writeAuditEntry({
          tx,
          userId: auditUserId,
          action: "BOOKING_UNITS_RELEASED",
          entityType: "Booking",
          entityId: id,
          before: diffFields({ status: booking.status }),
          after: diffFields({
            status: "CANCELLED",
            via: "status:cancel",
            releasedReservations: released.releasedReservations,
            freedUnitIds: released.freedUnitIds.length,
          }),
        });
        return u;
      });
    } else {
      updated = await prisma.booking.update({
        where: { id },
        data: bookingUpdateData,
        include: bookingInclude,
      });
    }
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

/**
 * DELETE /api/bookings/:id — мягкое удаление (архивация).
 * Бронь не стирается из БД, а помечается `deletedAt = now()` и пропадает из
 * всех list-эндпоинтов. Восстановление — POST /:id/restore. Окончательное
 * удаление — DELETE /:id/purge (требует уже архивированную бронь).
 *
 * Только SUPER_ADMIN. Аудит-action BOOKING_ARCHIVED.
 */
router.delete("/:id", rolesGuard(["SUPER_ADMIN"]), async (req, res, next) => {
  try {
    const id = req.params.id;
    const userId = req.adminUser!.userId;
    const existing = await prisma.booking.findUnique({
      where: { id },
      select: { id: true, status: true, projectName: true, startDate: true, endDate: true, deletedAt: true },
    });
    if (!existing) throw new HttpError(404, "Booking not found");
    if (existing.deletedAt) {
      throw new HttpError(409, "Бронь уже в архиве", "BOOKING_ALREADY_ARCHIVED");
    }
    const released = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.booking.update({
        where: { id },
        data: { deletedAt: new Date(), deletedBy: userId },
      });
      // BD-2: архивация не-терминальной брони (CONFIRMED/ISSUED/PENDING_APPROVAL)
      // обязана освободить UNIT-резервы — иначе equipmentUnit застревает в ISSUED
      // и выпадает из учёта доступности (бронь-то скрыта и больше не сканируется).
      // releaseBookingUnits идемпотентен: для терминальных броней (нет резервов) → no-op.
      const rel = await releaseBookingUnits(id, tx);
      await writeAuditEntry({
        tx,
        userId,
        action: "BOOKING_ARCHIVED",
        entityType: "Booking",
        entityId: id,
        before: diffFields(existing as Record<string, unknown>),
        after: {
          deletedAt: new Date().toISOString(),
          deletedBy: userId,
          releasedReservations: rel.releasedReservations,
          freedUnits: rel.freedUnitIds.length,
        },
      });
      return rel;
    });
    res.json({ ok: true, archived: true, releasedReservations: released.releasedReservations, freedUnits: released.freedUnitIds.length });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/bookings/:id/restore — восстановить архивированную бронь.
 * Только SUPER_ADMIN. 409 если бронь не была архивирована.
 */
router.post("/:id/restore", rolesGuard(["SUPER_ADMIN"]), async (req, res, next) => {
  try {
    const id = req.params.id;
    const userId = req.adminUser!.userId;
    const existing = await prisma.booking.findUnique({
      where: { id },
      select: { id: true, deletedAt: true, deletedBy: true, projectName: true, status: true },
    });
    if (!existing) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");
    if (!existing.deletedAt) {
      throw new HttpError(409, "Бронь не в архиве — восстанавливать нечего", "BOOKING_NOT_ARCHIVED");
    }
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.booking.update({
        where: { id },
        data: { deletedAt: null, deletedBy: null },
      });
      await writeAuditEntry({
        tx,
        userId,
        action: "BOOKING_RESTORED",
        entityType: "Booking",
        entityId: id,
        before: { deletedAt: existing.deletedAt!.toISOString(), deletedBy: existing.deletedBy },
        after: null,
      });
    });
    res.json({ ok: true, restored: true });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/bookings/:id/purge — окончательное удаление из БД.
 * Доступно только для УЖЕ архивированных броней (защита от случайного
 * hard-delete живой брони). Cascade удалит зависимости (BookingItem,
 * BookingVehicle и т.д. с onDelete: Cascade в схеме).
 *
 * Только SUPER_ADMIN. Аудит-action BOOKING_PURGED.
 */
router.delete("/:id/purge", rolesGuard(["SUPER_ADMIN"]), async (req, res, next) => {
  try {
    const id = req.params.id;
    const userId = req.adminUser!.userId;
    const existing = await prisma.booking.findUnique({
      where: { id },
      select: { id: true, status: true, projectName: true, startDate: true, endDate: true, deletedAt: true },
    });
    if (!existing) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");
    if (!existing.deletedAt) {
      throw new HttpError(
        409,
        "Можно удалить навсегда только архивированную бронь. Сначала отправьте в архив.",
        "BOOKING_NOT_ARCHIVED",
      );
    }
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // Audit ПЕРЕД delete — иначе FK Restrict от AuditEntry на AdminUser
      // блокирует. Сам entityId записываем, ссылок на удалённую запись нет.
      await writeAuditEntry({
        tx,
        userId,
        action: "BOOKING_PURGED",
        entityType: "Booking",
        entityId: id,
        before: diffFields(existing as Record<string, unknown>),
        after: null,
      });
      try {
        await tx.booking.delete({ where: { id } });
      } catch (e: any) {
        // P2003 FK violation — например, остались AuditEntry-записи через
        // другие связанные сущности. Возвращаем 409 с подсказкой.
        if (e?.code === "P2003") {
          throw new HttpError(
            409,
            "Бронь связана с историей аудита/финансов. Полное удаление невозможно.",
            "BOOKING_HAS_RELATIONS",
          );
        }
        throw e;
      }
    });
    res.json({ ok: true, purged: true });
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
      skipPartialDay: body.skipPartialDay ?? false,
    });

    const duration = formatRentalDurationDetails(start, end, body.skipPartialDay ?? false);

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
      // Transport — array of per-vehicle breakdowns (empty when none) + summed subtotal
      transport: estimate.transport,
      transportSubtotal: estimate.transportSubtotal.toFixed(2),
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
      skipPartialDay: body.skipPartialDay ?? false,
    });

    const duration = formatRentalDurationDetails(start, end, body.skipPartialDay ?? false);
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
      body.hourCalculationOverride?.trim() || formatExportHourCalculationLine(start, end, body.skipPartialDay ?? false);
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
        transport: body.transport ?? null,
        skipPartialDay: body.skipPartialDay ?? false,
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
            // Transport — mirrors the non-dryRun /draft (finalAmount includes transport)
            // and the /quote response shape exactly.
            transport: estimate.transport,
            transportSubtotal: estimate.transportSubtotal.toFixed(2),
            // Grand total = equipment-after-discount + transportSubtotal (== persisted finalAmount)
            grandTotal: estimate.grandTotal.toFixed(2),
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

    // Compute per-vehicle transport snapshots if provided
    let transportSnapshots: Array<{
      vehicleId: string;
      withGenerator: boolean;
      shiftHours: number;
      skipOvertime: boolean;
      kmOutsideMkad: number;
      ttkEntry: boolean;
      subtotalRub: string;
    }> | null = null;
    if (body.transport && body.transport.length > 0) {
      const { computeTransportPrice: calcTransport } = await import("../services/transportCalculator");
      transportSnapshots = [];
      for (const entry of body.transport) {
        const vehicleForDraft = await prisma.vehicle.findUnique({ where: { id: entry.vehicleId } });
        if (!vehicleForDraft) throw new HttpError(400, `Vehicle not found: ${entry.vehicleId}`);
        const breakdown = calcTransport({
          vehicle: {
            shiftPriceRub: vehicleForDraft.shiftPriceRub.toString(),
            hasGeneratorOption: vehicleForDraft.hasGeneratorOption,
            generatorPriceRub: vehicleForDraft.generatorPriceRub?.toString() ?? null,
            shiftHours: vehicleForDraft.shiftHours,
            overtimePercent: vehicleForDraft.overtimePercent.toString(),
          },
          withGenerator: entry.withGenerator,
          shiftHours: entry.shiftHours,
          skipOvertime: entry.skipOvertime,
          kmOutsideMkad: entry.kmOutsideMkad,
          ttkEntry: entry.ttkEntry,
        });
        transportSnapshots.push({
          vehicleId: entry.vehicleId,
          withGenerator: entry.withGenerator,
          shiftHours: entry.shiftHours,
          skipOvertime: entry.skipOvertime,
          kmOutsideMkad: entry.kmOutsideMkad,
          ttkEntry: entry.ttkEntry,
          subtotalRub: breakdown.total,
        });
      }
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
      skipPartialDay: body.skipPartialDay ?? false,
      items: body.items.map((it) => ({ equipmentId: it.equipmentId, customName: it.customName, customUnitPrice: it.customUnitPrice, quantity: it.quantity })),
      transport: transportSnapshots,
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

// C1: легаси-bypass согласования закрыт.
//  - rolesGuard(["SUPER_ADMIN"]) — у WAREHOUSE (JWT-сессия) больше нет доступа
//    к прямому confirm; для них только submit-for-approval → approve.
//    Бот (openclaw-ключ, req.botAccess=true) проходит rolesGuard без проверки
//    роли (whitelisted в botScopeGuard) — его одношаговый draft→confirm flow
//    сохраняется намеренно (у бота нет UI согласования; это отдельный
//    доверенный автоматизированный канал).
//  - Для НЕ-бота DRAFT/PENDING_APPROVAL → 409: SUPER_ADMIN из веба обязан
//    идти через approval workflow, а не флипать статус напрямую.
router.post("/:id/confirm", rolesGuard(["SUPER_ADMIN"]), async (req, res, next) => {
  try {
    const id = req.params.id;
    await assertBookingNotArchived(id);
    const isBot = req.botAccess === true;
    const booking = await prisma.booking.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!booking) throw new HttpError(404, "Booking not found", "BOOKING_NOT_FOUND");
    if (!isBot && ["DRAFT", "PENDING_APPROVAL"].includes(booking.status)) {
      throw new HttpError(409, "Используйте процесс согласования", "USE_APPROVAL_FLOW");
    }
    const prevStatus = booking.status;
    // Body can be extended later (idempotency key, override discount, etc.).
    const confirmed = await confirmBooking(id);
    // C1 observability: бот-канал делает DRAFT→CONFIRMED в обход approval-флоу.
    // confirmBooking сам аудит НЕ пишет, поэтому фиксируем отдельной записью
    // (как BOOKING_APPROVED — вне транзакции confirmBooking, осознанный
    // trade-off: аудит это observability, не бизнес-инвариант).
    //
    // AuditEntry.userId — обязательный FK на AdminUser, синтетический
    // sentinel невозможен. Бот не имеет своей AdminUser-записи, поэтому
    // атрибутируем действие первому SUPER_ADMIN (бот-confirm функционально
    // эквивалентен SUPER_ADMIN-approve), а бот-происхождение фиксируем
    // именем экшена BOOKING_CONFIRMED_VIA_BOT + полем after.via="bot".
    // Если AdminUser нет вообще — тихо пропускаем (аудит не критичен).
    if (isBot) {
      try {
        const auditActor =
          req.adminUser?.userId ??
          (
            await prisma.adminUser.findFirst({
              where: { role: "SUPER_ADMIN" },
              orderBy: { createdAt: "asc" },
              select: { id: true },
            })
          )?.id;
        if (auditActor) {
          await writeAuditEntry({
            userId: auditActor,
            action: "BOOKING_CONFIRMED_VIA_BOT",
            entityType: "Booking",
            entityId: id,
            before: { status: prevStatus },
            after: { status: confirmed.status, via: "bot" },
          });
        }
      } catch (auditErr) {
        // Аудит не должен ронять confirm; логируем и продолжаем.
        // eslint-disable-next-line no-console
        console.error("Audit write failed in bot /confirm:", auditErr);
      }
    }
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
    await assertBookingNotArchived(id);

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
        include: { client: true, items: { include: { equipment: true } }, estimates: { include: { lines: true } } },
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

/**
 * PATCH /api/bookings/:id/vehicles/:bookingVehicleId/driver
 * Inline-обновление водителя на конкретной BookingVehicle.
 * Заполняется при погрузке (выдаче) — даёт учёт «кто ездил за рулём».
 *
 * Доступ: SUPER_ADMIN + WAREHOUSE (склад заполняет на выдаче).
 * Body: `{ driverName?: string | null, driverPhone?: string | null }`.
 *   - передать `null` → очистить поле
 *   - не передать (undefined) → не трогать
 * Пишет AuditEntry внутри той же транзакции.
 */
router.patch(
  "/:id/vehicles/:bookingVehicleId/driver",
  rolesGuard(["SUPER_ADMIN", "WAREHOUSE"]),
  async (req, res, next) => {
    try {
      const { id: bookingId, bookingVehicleId } = req.params;
      const body = driverUpdateSchema.parse(req.body);
      await assertBookingNotArchived(bookingId);

      if (!req.adminUser) {
        throw new HttpError(401, "Требуется авторизация", "UNAUTHENTICATED");
      }
      const { userId } = req.adminUser;

      const existing = await prisma.bookingVehicle.findUnique({
        where: { id: bookingVehicleId },
        include: { vehicle: { select: { name: true } } },
      });
      if (!existing) throw new HttpError(404, "Машина брони не найдена");
      if (existing.bookingId !== bookingId) {
        throw new HttpError(404, "Машина не относится к этой брони");
      }

      // Нормализация: пустая строка после trim → null
      const nextName =
        body.driverName === undefined
          ? existing.driverName
          : body.driverName?.trim()
            ? body.driverName.trim()
            : null;
      const nextPhone =
        body.driverPhone === undefined
          ? existing.driverPhone
          : body.driverPhone?.trim()
            ? body.driverPhone.trim()
            : null;

      // Если ничего не меняется — возвращаем как есть, без записи в БД и аудит.
      if (nextName === existing.driverName && nextPhone === existing.driverPhone) {
        res.json({
          vehicle: {
            id: existing.id,
            driverName: existing.driverName,
            driverPhone: existing.driverPhone,
          },
        });
        return;
      }

      const updated = await prisma.$transaction(async (tx) => {
        const v = await tx.bookingVehicle.update({
          where: { id: bookingVehicleId },
          data: { driverName: nextName, driverPhone: nextPhone },
        });
        await writeAuditEntry({
          tx,
          userId,
          action: "BOOKING_VEHICLE_DRIVER_SET",
          entityType: "Booking",
          entityId: bookingId,
          before: diffFields({
            vehicleName: existing.vehicle?.name ?? null,
            driverName: existing.driverName,
            driverPhone: existing.driverPhone,
          }),
          after: diffFields({
            vehicleName: existing.vehicle?.name ?? null,
            driverName: nextName,
            driverPhone: nextPhone,
          }),
        });
        return v;
      });

      res.json({
        vehicle: {
          id: updated.id,
          driverName: updated.driverName,
          driverPhone: updated.driverPhone,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

/** PATCH /api/bookings/:id/backdate — смена дат задним числом (только SUPER_ADMIN). Пишет AuditEntry. */
router.patch("/:id/backdate", rolesGuard(["SUPER_ADMIN"]), async (req, res, next) => {
  try {
    const id = req.params.id;
    const body = backdateSchema.parse(req.body);
    await assertBookingNotArchived(id);

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
        include: { client: true, items: { include: { equipment: true } }, estimates: { include: { lines: true } } },
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

const changeClientSchema = z.object({
  clientId: z.string().min(1, "Укажите идентификатор клиента"),
});

/**
 * POST /api/bookings/:id/change-client — переназначить клиента брони (только SUPER_ADMIN).
 * Пишет AuditEntry BOOKING_CLIENT_CHANGED в той же транзакции.
 */
router.post(
  "/:id/change-client",
  rolesGuard(["SUPER_ADMIN"]),
  async (req, res, next) => {
    try {
      if (!req.adminUser) throw new HttpError(401, "Требуется авторизация", "UNAUTHENTICATED");
      const { clientId: newClientId } = changeClientSchema.parse(req.body);
      await assertBookingNotArchived(req.params.id);

      // 1. Загружаем текущую бронь со старым клиентом
      const existing = await prisma.booking.findUnique({
        where: { id: req.params.id },
        include: { client: { select: { id: true, name: true } } },
      });
      if (!existing) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");

      // 2. Редактирование заблокировано в PENDING_APPROVAL
      if (existing.status === "PENDING_APPROVAL") {
        throw new HttpError(409, "Бронь на согласовании — редактирование недоступно", "BOOKING_EDIT_FORBIDDEN");
      }

      // 3. Проверяем, что ничего не меняется
      if (existing.clientId === newClientId) {
        throw new HttpError(400, "Бронь уже принадлежит этому клиенту", "NO_CHANGE");
      }

      // 4. Проверяем, что новый клиент существует
      const newClient = await prisma.client.findUnique({
        where: { id: newClientId },
        select: { id: true, name: true },
      });
      if (!newClient) throw new HttpError(400, "Клиент не найден", "INVALID_CLIENT_ID");

      // 5. Транзакция: обновить + аудит
      const updated = await prisma.$transaction(async (tx) => {
        const updatedBooking = await tx.booking.update({
          where: { id: existing.id },
          data: { clientId: newClientId },
          include: {
            client: true,
            items: { include: { equipment: true } },
          },
        });

        await writeAuditEntry({
          tx,
          userId: req.adminUser!.userId,
          action: "BOOKING_CLIENT_CHANGED",
          entityType: "Booking",
          entityId: existing.id,
          before: { clientId: existing.client.id, clientName: existing.client.name },
          after: { clientId: newClient.id, clientName: newClient.name },
        });

        return updatedBooking;
      });

      res.json({ booking: serializeBookingForApi(updated as any) });
    } catch (err) {
      next(err);
    }
  },
);

/** POST /api/bookings/:id/submit-for-approval — DRAFT → PENDING_APPROVAL (SUPER_ADMIN + WAREHOUSE). */
router.post(
  "/:id/submit-for-approval",
  rolesGuard(["SUPER_ADMIN", "WAREHOUSE"]),
  async (req, res, next) => {
    try {
      if (!req.adminUser) throw new HttpError(401, "Требуется авторизация", "UNAUTHENTICATED");
      await assertBookingNotArchived(req.params.id);
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
      await assertBookingNotArchived(req.params.id);
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
      await assertBookingNotArchived(req.params.id);
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
      await assertBookingNotArchived(req.params.id);

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

        // C2: освобождаем UNIT-резервы в той же транзакции (статус юнитов
        // обратно в AVAILABLE + снятие BookingItemUnit). Идемпотентно.
        const released = await releaseBookingUnits(booking.id, tx as TxClientLocal);
        await writeAuditEntry({
          tx: tx as TxClientLocal,
          userId,
          action: "BOOKING_UNITS_RELEASED",
          entityType: "Booking",
          entityId: booking.id,
          before: diffFields({ status: booking.status }),
          after: diffFields({
            status: "CANCELLED",
            via: "cancel-with-deposit",
            releasedReservations: released.releasedReservations,
            freedUnitIds: released.freedUnitIds.length,
          }),
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
          estimates: { include: { lines: true } },
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
        select: { id: true, status: true, legacyFinance: true },
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

      const pdfBuf = await buildBookingEstimatePdf(booking.id);

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
        select: { id: true, status: true, amountOutstanding: true },
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

      const pdfBuf = await buildBookingActPdf(booking.id);

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

// ── GET /api/bookings/:id/full-estimate/export/{pdf,xlsx} ────────────────────
// Combined main + (optional) addon estimate in a single file. If addon is
// absent, the output is identical to the existing main-only export. Used as
// the default download for sending to clients.

router.get("/:id/full-estimate/export/pdf", async (req, res, next) => {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      include: {
        client: true,
        estimates: { include: { lines: true } },
      },
    });
    if (!booking) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");

    const main = booking.estimates.find((e) => e.kind === "MAIN");
    if (!main) throw new HttpError(404, "Основная смета не создана", "MAIN_ESTIMATE_NOT_FOUND");
    const addon = booking.estimates.find((e) => e.kind === "ADDON") ?? null;

    const doc = buildFullSmeta({ booking, main, addon });
    const human = buildBookingHumanName({
      startDate: booking.startDate,
      clientName: booking.client.name,
      totalAfterDiscount: main.totalAfterDiscount.toString(),
    });
    writeFullSmetaPdf(res, doc, `${safeFileName(human)}-смета.pdf`);
  } catch (err) {
    next(err);
  }
});

router.get("/:id/full-estimate/export/xlsx", async (req, res, next) => {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      include: {
        client: true,
        estimates: { include: { lines: true } },
      },
    });
    if (!booking) throw new HttpError(404, "Бронь не найдена", "BOOKING_NOT_FOUND");

    const main = booking.estimates.find((e) => e.kind === "MAIN");
    if (!main) throw new HttpError(404, "Основная смета не создана", "MAIN_ESTIMATE_NOT_FOUND");
    const addon = booking.estimates.find((e) => e.kind === "ADDON") ?? null;

    const doc = buildFullSmeta({ booking, main, addon });
    const human = buildBookingHumanName({
      startDate: booking.startDate,
      clientName: booking.client.name,
      totalAfterDiscount: main.totalAfterDiscount.toString(),
    });
    await writeFullSmetaXlsx(res, doc, `${safeFileName(human)}-смета.xlsx`);
  } catch (err) {
    next(err);
  }
});

// ── B5: GET /api/bookings/:id/related-expenses ───────────────────────────────
// D3: SA-only — CLAUDE.md matrix: GET /api/finance/* SA-only; booking finance sub-routes follow same policy

router.get(
  "/:id/related-expenses",
  rolesGuard(["SUPER_ADMIN"]),
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
// D3: SA-only — CLAUDE.md matrix: GET /api/finance/* SA-only; booking finance sub-routes follow same policy

router.get(
  "/:id/finance-timeline",
  rolesGuard(["SUPER_ADMIN"]),
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

