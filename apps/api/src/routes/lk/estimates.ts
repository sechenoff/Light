import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../prisma";
import { lkAuth } from "../../middleware/lkAuth";
import { lkClientId } from "../../services/clientPortal/tenant";

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
});

// Compound cursor for (createdAt DESC, id DESC) ordering.
type CompoundCursor = { createdAt: Date; id: string };

function encodeCursor(c: CompoundCursor): string {
  return `${c.createdAt.toISOString()}|${c.id}`;
}

function decodeCursor(s: string | undefined): CompoundCursor | null {
  if (!s) return null;
  const [iso, id] = s.split("|");
  if (!iso || !id) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return { createdAt: d, id };
}

router.get("/", lkAuth, async (req, res, next) => {
  try {
    const q = listQuery.parse(req.query);
    const clientId = lkClientId(req);
    const cursor = decodeCursor(q.cursor);

    const items = await prisma.estimate.findMany({
      where: {
        kind: "MAIN",
        booking: { clientId, status: { in: [...VISIBLE_STATUSES] as any } },
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: q.limit + 1,
      select: {
        id: true,
        bookingId: true,
        createdAt: true,
        totalAfterDiscount: true,
        booking: { select: { id: true, projectName: true } },
      },
    });

    const hasMore = items.length > q.limit;
    const slice = hasMore ? items.slice(0, q.limit) : items;
    const nextCursor = hasMore
      ? encodeCursor({
          createdAt: slice[slice.length - 1].createdAt,
          id: slice[slice.length - 1].id,
        })
      : null;

    res.json({
      items: slice.map((e) => ({
        bookingId: e.bookingId,
        bookingNo: `#${e.booking.id.slice(-6).toUpperCase()}`,
        projectName: e.booking.projectName,
        issuedAt: e.createdAt.toISOString(),
        totalAfterDiscount: e.totalAfterDiscount.toString(),
        pdfUrl: `/api/lk/bookings/${e.bookingId}/estimate.pdf`,
      })),
      nextCursor,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
