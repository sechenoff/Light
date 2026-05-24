import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../prisma";
import { lkAuth } from "../../middleware/lkAuth";
import { lkClientId } from "../../services/clientPortal/tenant";
import { HttpError } from "../../utils/errors";

const router = Router();

const VISIBLE_STATUSES = [
  "PENDING_APPROVAL",
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

router.get("/", lkAuth, async (req, res, next) => {
  try {
    const q = listQuery.parse(req.query);
    const clientId = lkClientId(req);

    const where = {
      clientId,
      status: q.status ? q.status : { in: [...VISIBLE_STATUSES] as any },
      ...(q.cursor ? { id: { lt: q.cursor } } : {}),
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
        amountPaid: true,
        _count: { select: { items: true } },
      },
    });

    const hasMore = items.length > q.limit;
    const slice = hasMore ? items.slice(0, q.limit) : items;
    const nextCursor = hasMore ? slice[slice.length - 1].id : null;

    res.json({
      items: slice.map((b) => ({
        id: b.id,
        bookingNo: `#${b.id.slice(-6).toUpperCase()}`,
        projectName: b.projectName,
        startDate: b.startDate.toISOString(),
        endDate: b.endDate.toISOString(),
        status: b.status,
        finalAmount: b.finalAmount.toString(),
        amountOutstanding: (
          Number(b.finalAmount) - Number(b.amountPaid)
        ).toString(),
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
        status: true,
        startDate: true,
        endDate: true,
        finalAmount: true,
        amountPaid: true,
        comment: true,
        estimateOptionalNote: true,
        projectName: true,
        items: {
          select: {
            quantity: true,
          },
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

    if (!booking || booking.clientId !== clientId) {
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
      finalAmount: booking.finalAmount.toString(),
      amountPaid: booking.amountPaid.toString(),
      amountOutstanding: (
        Number(booking.finalAmount) - Number(booking.amountPaid)
      ).toString(),
      comment: booking.comment ?? null,
      optionalNote: booking.estimateOptionalNote ?? null,
      hasConfirmedEstimate,
      hasAct: booking.status === "RETURNED",
    });
  } catch (err) {
    next(err);
  }
});

export default router;
